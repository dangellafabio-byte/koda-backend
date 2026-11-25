/**
 * lib/voiceClientStt.ts
 *
 * === FASE B — STT on-device Apple (SFSpeechRecognizer) ===
 *
 * ⚠️  REGOLA DI PRIVACY BLOCCANTE (Fabio 2026-07-23) ⚠️
 * ─────────────────────────────────────────────────────────────
 * Questo modulo APRE WebSocket verso il backend Ollenya e INVIA testo
 * trascritto tramite `{type:"transcript_from_client", text, ...}`.
 * Il testo LASCIA il device.
 *
 * ➤ Modalità **"Lascia andare"** (app/lascia-andare.tsx):
 *   Il contratto con l'utente è "zero trascrizione, zero rete".
 *   `lascia-andare.tsx` NON deve MAI importare questo modulo, NON deve
 *   MAI istanziare `VoiceClientSttSession`, NON deve MAI chiamare
 *   `speech.ts::voiceStreamConverse()` (che a sua volta usa questo modulo
 *   via feature flag). Verifica al 2026-07-23: `lascia-andare.tsx` NON
 *   importa nessuno di questi moduli, ha solo `expo-audio` metering-only
 *   con VAD locale. Se un giorno cambi lascia-andare, questa regola
 *   RESTA valida — mai importare voiceClientStt/voiceStream/speech/api
 *   in quella schermata.
 * ─────────────────────────────────────────────────────────────
 *
 * Sessione voice-stream ALTERNATIVA a VoiceStreamSession (che usa Deepgram
 * server-side). Questa classe usa il framework nativo iOS `SFSpeechRecognizer`
 * via il pacchetto `expo-speech-recognition@3.1.3`. La trascrizione avviene
 * ON-DEVICE (nessun audio grezzo lascia il telefono), sfruttando il pipeline
 * di noise cancellation Apple. Solo il testo trascritto viene inviato al
 * backend WSS Ollenya, che poi esegue la pipeline LLM (Claude) + TTS (ElevenLabs)
 * IDENTICA al percorso Deepgram.
 *
 * Interfaccia PUBBLICA equivalente a VoiceStreamSession (start/stop/abort +
 * VoiceStreamCallbacks), così che lo switch avvenga trasparente lato caller
 * (speech.ts) via feature flag EXPO_PUBLIC_USE_CLIENT_STT.
 *
 * Flusso:
 *   1. Apri WS al backend Ollenya
 *   2. Manda { type:"start", stt_source:"client_apple", ... } → backend sa che
 *      NON deve aspettare audio binario per Deepgram
 *   3. Avvia SFSpeechRecognizer on-device (lang="it-IT", ondevice=true)
 *   4. Alla ricezione di result.isFinal=true (Apple ha rilevato fine parlato):
 *        - Manda { type:"transcript_from_client", text, confidence, duration_ms,
 *          lang, route } → backend salta Deepgram e chiama pipeline direttamente
 *        - Aspetta sentence_header + binary TTS frames (identico al percorso DG)
 *   5. Alla ricezione di "done" dal backend → sessione chiusa correttamente
 *
 * Fallback automatico: se `supportsOnDeviceRecognition()` è false, o se la
 * permission viene negata, il caller in speech.ts deve fallback a
 * VoiceStreamSession (Deepgram). Questa classe fa THROW nel start() così il
 * caller può catchare e ripiegare.
 *
 * === REGOLE CRITICHE (NON RIMUOVERE) ===
 *  - NON toccare `voiceStream.ts` (percorso Deepgram) — deve restare intatto
 *    come fallback in caso di regressione.
 *  - NON modificare la firma di VoiceStreamCallbacks — è condivisa.
 *  - Diagnostica: log `[OLLENYA_CLIENT_STT]` per differenziarlo dal Deepgram path.
 */

import { Platform, AppState } from "react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";
import {
  detectAudioRouteDetailed,
  type VoiceStreamCallbacks,
  type SentenceMeta,
  type AudioRouteInfo,
} from "./voiceStream";
import { kodaBackendWsUrl } from "./backendUrl";
import { getAuthToken } from "./authToken";
import { AndroidUtterance } from "./androidUtterance";

/** Final-like segments on iOS 18+ are not the physical release of a PTT gesture. */
class IosPttTurn {
  private committed: string[] = [];
  private current = "";
  private final = false;
  result(raw: string, isFinal: boolean): string {
    const value = raw.trim();
    if (!value) return this.text;
    // expo-speech-recognition prefixes subsequent iOS segments with a space.
    if (this.final && raw.startsWith(" ") && value !== this.current) this.committed.push(this.current);
    this.current = value;
    this.final = isFinal;
    return this.text;
  }
  get text(): string { return [...this.committed, this.current].filter(Boolean).join(" "); }
  get hasPendingPartial(): boolean { return !!this.current && !this.final; }
}

const TAG = "KODA_CLIENT_STT";

// === FIX 2026-07-23 — Usa Railway hardcoded, NON il preview Emergent ===
// Il preview Emergent (`app-finder-408.emergent.host`) NON ha il backend voice
// deployato → restituisce 502 sul WS. Il backend Ollenya vive su Railway
// (koda-backend-production-4a34.up.railway.app). Usiamo lo stesso helper
// hardcoded di voiceStream.ts (kodaBackendWsUrl) per garantire coerenza.
function buildWsUrl(): string {
  let base = kodaBackendWsUrl("/api/voice/stream");
  // === FIX AUTH WS (Fabio 2026-08-25) — stessa logica di voiceStream.ts:
  // accoda ?token=<session_token> così il backend risolve l'uid autenticato
  // invece di fallback su "me" via fingerprint. Prima le conversazioni voce
  // finivano su profilo LEGACY, staccate dalla timeline utente.
  try {
    const tok = getAuthToken();
    if (tok) {
      const sep = base.includes("?") ? "&" : "?";
      base = `${base}${sep}token=${encodeURIComponent(tok)}`;
    }
  } catch {
    // no-op
  }
  return base;
}

/**
 * Rappresenta un evento result normalizzato (union tra il tipo del SDK e la
 * nostra ridenominazione interna per evitare accoppiamento stretto).
 */
type NormalizedResult = {
  isFinal: boolean;
  transcript: string;
  confidence: number | null;
};

/**
 * Sessione voice-stream con STT on-device Apple.
 * Interfaccia allineata a VoiceStreamSession (voiceStream.ts).
 */
export class VoiceClientSttSession {
  private ws: WebSocket | null = null;
  private callbacks: VoiceStreamCallbacks;
  private stopRequested = false;
  private warmupAbort: AbortController | null = null;
  private cancelWsOpen: (() => void) | null = null;
  private audioTasks = new Set<Promise<void>>();
  private trackAudioTask(task: Promise<void>): Promise<void> {
    this.audioTasks.add(task);
    task.then(() => this.audioTasks.delete(task), () => this.audioTasks.delete(task));
    return task;
  }
  private async drainAudioTasks(): Promise<void> {
    await Promise.all(Array.from(this.audioTasks, task => task.catch(() => {})));
  }
  private startedAt = 0;
  private sessionReady = false;
  private doneReceived = false;
  private notifiedUpperOnClose = false;

  // Buffer per il sentence_header che precede un binary frame TTS
  private pendingSentenceHeader: SentenceMeta | null = null;

  // Trascrizione corrente accumulata
  private currentTranscript = "";
  private currentConfidence: number | null = null;
  private speechStartMs = 0;
  // === FIX 2026-07-23 v2 — Idempotency guard dispatchFinalToBackend ===
  // iOS emette event "end" ANCHE dopo isFinal=true, spesso ripetuto decine
  // di volte fino alla chiusura completa della sessione. Il nostro handler
  // "end" era un safety net per casi in cui isFinal non arriva, ma senza
  // guard esplicito re-innescava dispatchFinalToBackend() a ogni "end"
  // → decine di transcript_from_client duplicati mandati al backend
  // (visibili nel log Fase B v1 come "sendJson skipped — ws not open"
  // dopo che il server aveva già risposto). Ora `dispatched=true` blocca
  // sia dispatch multipli sia il ramo safety net nell'end handler.
  private dispatched = false;

  // Handlers rimuovibili
  private subResult: { remove: () => void } | null = null;
  private subError: { remove: () => void } | null = null;
  private subEnd: { remove: () => void } | null = null;
  private subSpeechStart: { remove: () => void } | null = null;
  private subRecognitionStart: { remove: () => void } | null = null;
  private recognitionStarted = false;

  // === FIX 2026-07-26 v64.0 — Watchdog Android mic silent-fail ===
  // Su Google SpeechRecognizer (Android), specialmente al 2° turno,
  // ExpoSpeechRecognitionModule.start() può risolvere silenziosamente
  // senza mai attivare l'hardware mic: nessun evento speechstart, error
  // o end viene emesso. La sessione resta zombie: UI mostra "recording"
  // ma il microfono è morto. Il watchdog rileva questo caso e
  // propaga un errore all'upper layer così il HF backoff può reagire.
  private micWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartReceived = false;

  // === FIX 2026-07-26 v64.1 — no-speech tracking (utente silenzioso) ===
  // Google SpeechRecognizer emette `error no-speech` se l'utente non
  // parla dopo N secondi di silenzio (soglia configurata via
  // androidIntentOptions). Prima trattavamo l'errore come benigno con
  // return early → il gestore `end` non sapeva se la sessione era
  // finita per "utente ha finito di parlare" o "utente ha taciuto".
  // Ora traccciamo il flag così `end` può fare graceful close.
  private noSpeechReceived = false;
  private androidUtterance: AndroidUtterance | null = null;
  private autoEndpoint = true;
  private iosPttTurn: IosPttTurn | null = null;
  private iosPttStopTimer: ReturnType<typeof setTimeout> | null = null;
  private iosPttStopResolve: (() => void) | null = null;
  private iosPttStopPromise: Promise<void> | null = null;

  private subVolume: { remove: () => void } | null = null;

  // Route audio (rilevata prima di start)
  private audioRoute: "bluetooth" | "wired" | "builtin" | "unknown" = "unknown";

  // Keepalive WS (identico a voiceStream)
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: VoiceStreamCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Verifica se questa sessione è UTILIZZABILE su questo device.
   * Chiamato prima di start() dal caller (speech.ts) per decidere fallback.
   * Se ritorna false, il caller deve usare VoiceStreamSession (Deepgram).
   *
   * === OPZIONE B (2026-07-24): PORTING ANDROID NATIVE ===
   * Prima accettava solo iOS. Ora accetta anche Android via
   * Google SpeechRecognizer on-device (stesso pacchetto expo-speech-recognition).
   * Diagnosi log Huawei+Honor ha confermato che il path Deepgram AAC è
   * strutturalmente rotto su Android (probe=? / probe=aac ma trascrizione
   * vuota) — bypassare Deepgram è ormai l'unica strada realistica.
   * Vedi /app/memory/ANDROID_STT_DIAGNOSIS.md per la diagnosi completa.
   */
  static async isSupported(): Promise<{
    supported: boolean;
    reason?: string;
  }> {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      return { supported: false, reason: "platform_not_mobile" };
    }
    try {
      const avail = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      if (!avail) {
        return { supported: false, reason: "recognition_unavailable" };
      }
      // iOS: preferiamo on-device (offline, no latenza cloud, privacy).
      //   Se non c'è on-device disponibile per italiano, fallback a Deepgram.
      // Android: on-device NON è sempre disponibile prima di Android 12+
      //   (Google Assistant offline pack). Accettiamo comunque se
      //   isRecognitionAvailable=true, perché Google SpeechRecognizer online
      //   è già molto meglio del path Deepgram+AAC attuale (che è ROTTO).
      //   L'utente potrebbe consumare data mobile per lo STT online, ma è
      //   l'unica cosa che funziona finché non ci sono modelli offline.
      {
        const ondev = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
        if (!ondev) {
          return { supported: false, reason: "no_ondevice_it" };
        }
      }
      return { supported: true };
    } catch (e: any) {
      return { supported: false, reason: `probe_error:${e?.message || e}` };
    }
  }

  /**
   * Richiede le permission (Microphone + Speech Recognition). Idempotente.
   */
  static async requestPermissions(): Promise<{
    granted: boolean;
    canAskAgain: boolean;
  }> {
    try {
      const res = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      return {
        granted: !!res?.granted,
        canAskAgain: res?.canAskAgain !== false,
      };
    } catch (e: any) {
      console.log(`[${TAG}] requestPermissions error: ${e?.message || e}`);
      return { granted: false, canAskAgain: true };
    }
  }

  async start(opts?: {
    ephemeral?: boolean;
    profileLang?: string;
    locationCity?: string;
    locationRegion?: string;
    locationCountry?: string;
    // === FIX 2026-07-26 v64.4 — Voice ID esplicito nel WS start ===
    // Bypass definitivo del bug "voce non cambia in conversazione iPhone":
    // il client dichiara ESPLICITAMENTE quale voce vuole per questa
    // sessione. Il server usa questo valore direttamente invece di
    // leggerlo dal profilo (dove può essere out-of-sync per bug auth-
    // bridge o migration/reverse-sync). Client-side source of truth.
    voiceId?: string;
    autoEndpoint?: boolean;
  }): Promise<void> {
    // === OPZIONE B (2026-07-24): PORTING ANDROID NATIVE ===
    // Prima accettava solo iOS. Ora accetta Android tramite Google
    // SpeechRecognizer on-device (o cloud fallback). Vedi commento su
    // isSupported() e /app/memory/ANDROID_STT_DIAGNOSIS.md
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      throw new Error("client_stt_mobile_only");
    }
    if (this.stopRequested || this.doneReceived) throw new Error("voice_stream_start_cancelled");
    this.startedAt = Date.now();
    this.autoEndpoint = opts?.autoEndpoint !== false;
    this.stopRequested = false;
    this.sessionReady = false;
    this.doneReceived = false;
    this.notifiedUpperOnClose = false;
    this.currentTranscript = "";
    this.currentConfidence = null;
    this.speechStartMs = 0;
    this.dispatched = false;

    // 1) Permission check
    const perm = await VoiceClientSttSession.requestPermissions();
    if (this.stopRequested || this.doneReceived) throw new Error("voice_stream_start_cancelled");

    if (!perm.granted) {
      throw new Error(`permission_denied${perm.canAskAgain ? "" : "_permanent"}`);
    }

    // === FIX 2026-07-25 v63.9 — Fix C2: release AudioFocus PRIMA di STT ===
    //
    // PROBLEMA (log Fabio 25/07 06:34):
    //   Anche dopo il fix v63.7 (GPS cache-first), sessioni STT emettono
    //   `speechstart` seguito da `error no-speech` in ~2 secondi, in
    //   cascata. Utente parla ma Google SpeechRecognizer non trascrive.
    //
    // ROOT CAUSE:
    //   Il TTS di intro al login (playElevenLabsNativeFromUrl in
    //   speech.ts) usa expo-audio createAudioPlayer che, su Android,
    //   NON rilascia AudioFocus in modo affidabile su MIUI/EMUI dopo
    //   player.remove(). AudioFocus resta detenuto in ducking mode →
    //   quando successivamente parte Google SpeechRecognizer, il mic
    //   apre ma con gain ridotto → speechstart falso (rumore ambientale
    //   basso) → no-speech dopo 2s.
    //
    //   Fix C1 v63.8 rilascia AudioFocus DOPO la sessione STT. Ma la
    //   PRIMA sessione dopo il login eredita focus sporco dal TTS
    //   intro (mai pulito). Serve un release simmetrico ANCHE PRIMA.
    //
    // FIX C2 — Cycle simmetrico a Fix C1 all'INIZIO di start():
    //   1. setIsAudioActiveAsync(false) → libera focus da TTS precedente
    //   2. wait 100ms                    → Android release async
    //   3. (continua con setAudioModeAsync(record) qui sotto)
    //   4. setIsAudioActiveAsync(true)   → riacquisisce per record mode
    //
    //   +100ms al startup. Trascurabile rispetto ai 1.5s totali.
    //   Combinato con Fix C1: DOPPIA DIFESA (release prima E dopo).
    if (Platform.OS === "android") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Audio: any = require("expo-audio");
        const t0 = Date.now();

        // Step 1: deactivate — abandonAudioFocus() nativo
        try {
          if (typeof Audio.setIsAudioActiveAsync === "function") {
            await Audio.setIsAudioActiveAsync(false);
            console.log(`[${TAG}] pre-STT focus release step1 (deactivate) ok`);
          }
        } catch (e: any) {
          console.log(`[${TAG}] pre-STT focus release step1 FAILED: ${e?.message || e}`);
        }

        // Step 2: wait — Android AudioService rilascia async
        await new Promise((r) => setTimeout(r, 100));

        console.log(
          `[${TAG}] pre-STT focus pre-cycle done in ${Date.now() - t0}ms (Fix C2 v63.9)`
        );
      } catch (e: any) {
        console.log(
          `[${TAG}] pre-STT focus cycle FAILED (non-fatal): ${e?.message || e}`
        );
      }
    }

    if (this.stopRequested || this.doneReceived) throw new Error("voice_stream_start_cancelled");
    // 2) Audio session in record mode PRIMA di detectAudioRoute (stesso trick
    //    di voiceStream.ts riga ~416). Serve perché al turno N+1 la session
    //    può essere in playback-only e detectAudioRoute crasha.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAudioModeAsync, setIsAudioActiveAsync } = require("expo-audio");
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      console.log(`[${TAG}] setAudioModeAsync(record) OK before detectAudioRoute`);
    if (this.stopRequested || this.doneReceived) throw new Error("voice_stream_start_cancelled");


      // Fix C2 step 4: reactivate per record mode (Android only)
      if (Platform.OS === "android") {
        try {
          if (this.doneReceived || this.stopRequested) return;
          if (typeof setIsAudioActiveAsync === "function") {
            await setIsAudioActiveAsync(true);
            console.log(`[${TAG}] pre-STT focus reactivate (for record) ok (Fix C2 v63.9)`);
          }
        } catch (e: any) {
          console.log(`[${TAG}] pre-STT focus reactivate FAILED: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      console.log(`[${TAG}] setAudioModeAsync FAILED: ${e?.message || e}`);
    }

    if (this.stopRequested || this.doneReceived) throw new Error("voice_stream_start_cancelled");
    // 3) Detect audio route (per diagnostica backend)
    try {
      const routeInfo: AudioRouteInfo = await Promise.race([
        detectAudioRouteDetailed(),
        new Promise<AudioRouteInfo>((resolve) =>
          setTimeout(
            () =>
              resolve({
                route: "unknown",
                deviceKind: "unknown",
                deviceType: "",
                deviceName: "",
              }),
            2000
          )
        ),
      ]);
      this.audioRoute = routeInfo.route;
      console.log(`[${TAG}] audio_route=${this.audioRoute}`);
    } catch (e: any) {
      console.log(`[${TAG}] audio_route detection failed: ${e?.message || e}`);
    }

    if (this.stopRequested || this.doneReceived) throw new Error("voice_stream_start_cancelled");
    // Start local recognition before any network operation.
    this.connectionOptions = opts;
    await this.startRecognition(opts?.profileLang || "it");
  }

  private androidReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionOptions: Parameters<VoiceClientSttSession["start"]>[0];

  private async connectForFinal(): Promise<void> {
    const opts = this.connectionOptions;
    await this.openWs(buildWsUrl());
    if (this.doneReceived) throw new Error("voice_stream_start_cancelled");
    // 5) Frame start → dice al backend: NON aspettare audio binario, aspettare
    //    invece un transcript_from_client. Nuovo campo: stt_source dinamico
    //    per platform. Backend voice_stream.py accetta entrambe le varianti.
    const sttSource =
      Platform.OS === "ios" ? "client_apple" : "client_google";
    this.sendJson({
      type: "start",
      ephemeral: !!opts?.ephemeral,
      profile_lang: opts?.profileLang || "it",
      container: "text", // NON aac — backend sa che salta Deepgram
      stt_source: sttSource,
      audio_route: this.audioRoute,
      location_city: opts?.locationCity || undefined,
      location_region: opts?.locationRegion || undefined,
      location_country: opts?.locationCountry || undefined,
      // === FIX v64.4 — client-authoritative voice_id ===
      // Passiamo esplicitamente il voice_id scelto dall'utente. Il server
      // lo usa direttamente per la TTS di QUESTA sessione, bypassando la
      // lettura profilo (che può essere out-of-sync). Se non specificato,
      // il server fa il fallback storico su _resolve_voice_id(profile).
      voice_id: opts?.voiceId || undefined,
    });
    if (opts?.voiceId) {
      console.log(`[${TAG}] WS start sent voice_id=${opts.voiceId} (client-authoritative)`);
    }

    this.startKeepalive();
  }

  private async startRecognition(profileLang: string): Promise<void> {
    const lang = profileLang === "it" ? "it-IT" : profileLang;
    console.log(`[${TAG}] startRecognition lang=${lang} platform=${Platform.OS} requiresOnDevice=true`);

    // === FIX 2026-07-26 v64.0 — Pre-abort Android reset ===
    // Su Google SpeechRecognizer (Android), specialmente sui turni
    // successivi al 1°, chiamare start() troppo velocemente dopo il
    // precedente stop() dello stesso sessione può risultare in un
    // "silent-fail" dove start() ritorna OK ma l'hardware mic non
    // apre mai. Sintomo utente: UI="recording" ma microfono morto.
    //
    // Soluzione empirica: prima di ogni start(), chiamiamo abort()
    // per forzare un reset del recognizer service Google. abort()
    // su una sessione idle è idempotente (no-op). Su una sessione
    // in fase-di-chiusura, forza il release immediato dell'hw.
    // +50ms di attesa per lasciare a Android il tempo di consolidare
    // lo stato interno del SpeechRecognizer service.
    if (Platform.OS === "android") {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
    }
    if (this.stopRequested || this.doneReceived || this.dispatched) return;
    if (Platform.OS === "ios" && !this.autoEndpoint) this.iosPttTurn = new IosPttTurn();
    if (Platform.OS === "android") {
      try {
        const module: any = ExpoSpeechRecognitionModule;
        const service = module.getDefaultRecognitionService?.();
        const services = module.getSpeechRecognitionServices?.() || [];
        console.log(`[OLLENYA_ANDROID_INPUT] default_service=${service?.packageName || "unknown"} available=${services.join(",") || "unknown"}`);
      } catch {}
      this.androidUtterance = new AndroidUtterance((text) => {
        if (this.stopRequested || this.doneReceived || this.dispatched) return;
        this.currentTranscript = text;
        console.log("[OLLENYA_ANDROID_ENDPOINT] quiet interval complete → dispatch once");
        this.dispatchFinalToBackend().catch((e: any) =>
          console.log(`[${TAG}] dispatchFinal error: ${e?.message || e}`));
      }, 3000, {
        autoEndpoint: this.autoEndpoint,
        onStalled: () => this.failAndroidRecognition("android_transcript_stalled"),
      });
    }
    // Reset watchdog state
    this.speechStartReceived = false;
    // Reset no-speech flag (v64.1)
    this.noSpeechReceived = false;
    this.recognitionStarted = false;

    // Registra listeners prima di start()
    this.subRecognitionStart = ExpoSpeechRecognitionModule.addListener("start", () => {
      if (this.stopRequested || this.doneReceived || this.dispatched || this.recognitionStarted) return;
      this.recognitionStarted = true;
      if (this.micWatchdogTimer) clearTimeout(this.micWatchdogTimer);
      this.micWatchdogTimer = null;
      console.log("[OLLENYA_ANDROID_ENDPOINT] recognizer ready");
      this.callbacks.onRecognitionActive?.();
    });
    if (Platform.OS === "android") {
      let samples = 0, min = Infinity, max = -Infinity, windowStart = Date.now();
      this.subVolume = ExpoSpeechRecognitionModule.addListener("volumechange", (event) => {
        const value = Number(event.value);
        if (!Number.isFinite(value)) return;
        samples++; min = Math.min(min, value); max = Math.max(max, value);
        if (Date.now() - windowStart >= 2000) {
          console.log(`[OLLENYA_ANDROID_INPUT] samples=${samples} min=${min.toFixed(1)} max=${max.toFixed(1)}`);
          samples = 0; min = Infinity; max = -Infinity; windowStart = Date.now();
        }
      });
    }
    this.subSpeechStart = ExpoSpeechRecognitionModule.addListener(
      "speechstart",
      () => {
        if (this.doneReceived || this.dispatched || this.stopRequested) return;
        this.androidUtterance?.speechStarted();
        this.speechStartMs = Date.now();
        this.speechStartReceived = true;
        if (this.micWatchdogTimer) {
          clearTimeout(this.micWatchdogTimer);
          this.micWatchdogTimer = null;
        }
        console.log(`[${TAG}] speechstart`);
      }
    );

    this.subResult = ExpoSpeechRecognitionModule.addListener(
      "result",
      (evt: ExpoSpeechRecognitionResultEvent) => {
        if (this.doneReceived || this.dispatched) return;
        const norm = this.normalizeResult(evt);
        if (!norm) return;
        // Salva la trascrizione corrente (verrà usata sia per interim che final)
        this.currentTranscript = this.iosPttTurn
          ? this.iosPttTurn.result(norm.transcript, norm.isFinal)
          : this.androidUtterance
          ? this.androidUtterance.result(norm.transcript, norm.isFinal)
          : norm.transcript;
        this.currentConfidence = norm.confidence;

        // Notifica interim al caller (UI live transcript)
        try {
          this.callbacks.onInterim?.(this.currentTranscript, norm.isFinal);
        } catch {}

        if (norm.isFinal) {
          console.log(
            `[${TAG}] result FINAL text="${norm.transcript}" conf=${norm.confidence} ` +
            `ptt=${!this.autoEndpoint} hasSpeech=${this.speechStartReceived}`
          );
          if (this.iosPttTurn) {
            if (this.stopRequested && this.iosPttStopResolve) this.finalizeIosPttStop();
            return;
          }
          if (this.androidUtterance) {
            if (!this.autoEndpoint && this.stopRequested) void this.dispatchFinalToBackend();
            return;
          }
          // === v70.16 (Fabio 19/11/2026) — PTT: NO dispatch su isFinal =====
          // In PTT (autoEndpoint=false) il risultato finale va CONSERVATO e
          // inviato UNA SOLA volta al rilascio effettivo del dito (stop()).
          // Qui aggiorniamo solo currentTranscript e aspettiamo stop().
          // Se iOS continua in continuous mode non ci saranno altri isFinal
          // finché non arriva stop(); se invece il recognizer si ferma da
          // solo (fine stream), il safety-net nell'end handler + la logica
          // in stop() si occuperanno del dispatch singolo via dispatched flag.
          if (!this.autoEndpoint) {
            console.log(
              `[${TAG}] PTT mode → buffering final, awaiting stop() for dispatch`
            );
            return;
          }
          // HF ON: comportamento storico, dispatch immediato.
          this.dispatchFinalToBackend().catch((e: any) =>
            console.log(`[VoiceClientSttSession] dispatchFinal error: ${e?.message || e}`)
          );
        } else {
          // Log leggero per ridurre spam. Solo primi 40 char.
          const short = norm.transcript.slice(0, 40);
          console.log(`[${TAG}] result partial="${short}${norm.transcript.length > 40 ? "…" : ""}"`);
        }
      }
    );

    this.subError = ExpoSpeechRecognitionModule.addListener(
      "error",
      (evt: ExpoSpeechRecognitionErrorEvent) => {
        if (this.doneReceived || this.dispatched) return;
        console.log(
          `[${TAG}] error code=${evt.error} message="${evt.message || ""}"`
        );
        // === FIX 2026-07-26 v64.1 — no-speech tracking ===
        // "no-speech" e "aborted" restano benigni (no propagate crash),
        // MA per "no-speech" settiamo un flag così il gestore `end`
        // sa che la sessione si è chiusa per silenzio utente e deve
        // fare cleanup gracefully (dispatch `end` al backend → done →
        // idle) invece di lasciare il WS aperto e il UI in "recording"
        // per sempre (bug utente 26/07: "mic si chiude ma UI resta
        // bloccata su Recording").
        if (evt.error === "no-speech") {
          this.noSpeechReceived = true;
          return;
        }
        if (evt.error === "aborted") return;
        if (Platform.OS === "ios" && evt.error === "no-match") {
          if (!this.iosPttTurn || !this.stopRequested) {
            this.finishIosPttWithoutDispatch("speech_not_recognized");
          }
          return;
        }
        this.androidUtterance?.cancel();

        // === FIX 2026-07-23 v60.4 — AudioSession recovery cycle ============
        // Fabio (23/07 post-checkpoint): il bug 560557684 (`!act`) del vecchio
        // path Deepgram non dovrebbe più riprodursi qui (SFSpeechRecognizer
        // ha una sola sessione per turno, non il ciclo chunk N→N+1). MA:
        // se dovesse comunque succedere — route change, interruzione Siri,
        // background/foreground mid-turno — SFSpeechRecognizer emette
        // `error` con OSStatus 560557684 nel message. Se lasciamo la
        // AudioSession iOS in stato residuale "!act", il PROSSIMO tap-to-
        // speak potrebbe fallire silenziosamente.
        //
        // Fix profilattico: dopo un errore non-benigno eseguiamo un forced
        // cycle di AudioSession (deactivate → 300ms → reactivate) COSÌ IL
        // PROSSIMO turno parte da uno stato garantito pulito. Costo zero
        // percepito dall'utente (avviene DOPO che ha già visto l'errore).
        //
        // Log taggato `[OLLENYA_AUDIO_ZOMBIE_RECOVERY]` per telemetria: se in 2
        // settimane non compare mai in produzione, il bug è definitivamente
        // morto per cambio architetturale e possiamo rimuovere il fix.
        const msg = String(evt.message || "");
        const isZombieCandidate =
          /560557684|!act|not active|session/i.test(msg) ||
          /audio/i.test(String(evt.error || ""));
        // Fire-and-forget, non aspettiamo (l'utente ha già ricevuto errore)
        this.performAudioSessionRecoveryCycle(
          evt.error,
          msg,
          isZombieCandidate
        ).catch(() => {});

        try {
          this.callbacks.onError?.(`client_stt_${evt.error}`);
        } catch {}
      }
    );

    this.subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
      // iOS può emettere "end" più volte per sessione (specialmente dopo
      // isFinal). Il guard `dispatched` previene safety net multipli.
      if (this.dispatched) {
        // Log molto leggero per non spammare
        return;
      }
      console.log(`[${TAG}] end event (noSpeech=${this.noSpeechReceived} hasSpeech=${this.speechStartReceived} ptt=${!this.autoEndpoint})`);
      if (this.iosPttTurn) {
        if (!this.stopRequested) this.finishIosPttWithoutDispatch("ios_ptt_recognition_ended");
        return;
      }
      if (this.androidUtterance && !this.doneReceived && !this.stopRequested) {
        if (this.androidUtterance.serviceEnded()) return;
        // Native recognition really disconnected. Do not pretend an incomplete
        // utterance was final and do not trigger repeated HF retries.
        this.failAndroidRecognition("android_recognition_ended_early");
        return;
      }
      // === v70.16 (Fabio 19/11/2026) — PTT: NO dispatch su end spontaneo ====
      // In PTT (autoEndpoint=false) il dispatch deve avvenire SOLO al
      // rilascio del dito (stop()). Se iOS chiude il recognizer da solo
      // (es. 1-minute hard limit, interruzione), non dispatchare: aspetta
      // stop(). Il flag dispatched impedisce comunque doppi dispatch se
      // stop() arriva subito dopo.
      if (!this.autoEndpoint && !this.stopRequested) {
        console.log(
          `[${TAG}] end during PTT hold → NOT dispatching (awaiting release)`
        );
        return;
      }
      // Se non abbiamo ancora inviato final ma abbiamo un transcript accumulato,
      // consideriamolo final (safety net per casi in cui iOS chiude senza
      // isFinal=true).
      if (this.androidReleaseTimer !== null) return;
      if (this.currentTranscript && !this.doneReceived) {
        console.log(
          `[${TAG}] end fired without isFinal → treating currentTranscript as final`
        );
        this.dispatchFinalToBackend().catch((e: any) =>
          console.log(`[VoiceClientSttSession] dispatchFinal error: ${e?.message || e}`)
        );
        return;
      }
      // === FIX 2026-07-26 v64.1 — Graceful cleanup su no-speech ===
      //
      // Se end fira SENZA transcript e c'è stato un no-speech (utente
      // ha taciuto per > silence threshold), la sessione è morta ma:
      //   - WS resta aperta
      //   - Backend non ha ricevuto né transcript_from_client né end
      //   - Upper layer non riceve mai `done` → status resta "recording"
      //     per sempre → utente vede UI bloccata (bug 26/07)
      //
      // Fix: mandiamo `{type:"end"}` al backend che chiude gracefully
      // la sessione. Il backend risponderà con `done` (o WS.close) →
      // pipelineDone=true → status torna idle → HF_LOOP può ripartire
      // per il prossimo turno (comportamento simile a iPhone "retry").
      //
      // === v70.16 (Fabio 19/11/2026) — Distinguere "parlato non capito" ======
      // In HF ON, se end arriva con transcript VUOTO ma speechStartReceived=true
      // (il mic HA sentito parlare, ma SFSpeechRecognizer non è riuscito a
      // trascriverlo), è un caso diverso dal silenzio totale: Ollenya deve
      // CHIEDERE DI RIPETERE invece di contarlo come no_speech.
      // Emettiamo un codice distinto "speech_not_recognized" che speech.ts
      // propagherà come onError → index.tsx lo differenzierà dal no_speech.
      if (!this.currentTranscript && !this.doneReceived) {
        const hadSpeech = this.speechStartReceived && !this.noSpeechReceived;
        const errCode = hadSpeech ? "speech_not_recognized" : "no_speech";
        console.log(
          `[${TAG}] end fired with empty transcript → sending {type:end}, upper gets code="${errCode}"`
        );
        try {
          this.sendJson({ type: "end" });
        } catch {}
        // Notifica upper layer che la sessione va chiusa (turno vuoto,
        // niente TTS in arrivo). Codice differenziato:
        //  - "speech_not_recognized": mic ha sentito ma non capito → ripeti
        //  - "no_speech": silenzio totale → conta per il contatore HF stop
        this.dispatched = true;
        this.doneReceived = true;
        this.notifiedUpperOnClose = true;
        try {
          this.callbacks.onError?.(errCode);
        } catch {}
        this.removeListeners();
        this.stopKeepalive();
        this.forceCloseWs();
      }
    });

    // Start SpeechRecognizer (Apple SFSpeechRecognizer su iOS,
    // Google SpeechRecognizer su Android)
    try {
      // === OPZIONE B (2026-07-24) — config platform-specific ===
      // iOS: preferiamo on-device (offline, latenza minima, privacy).
      //   iosCategory: playAndRecord + defaultToSpeaker per garantire
      //   che il mic sia attivo senza spegnere il TTS che parte dopo.
      // Android: `requiresOnDeviceRecognition` è opzionale (funziona da
      //   Android 12+ con Google Assistant offline pack). Su device più
      //   vecchi cade automaticamente su cloud recognition (usa data).
      //   `iosCategory` viene ignorato ma lo omettiamo per pulizia.
      //   `androidRecognitionServicePackage` non lo forziamo: il default
      //   di sistema (Google) è quello che vogliamo.
      //
      // Android continuous mode produces multiple final SEGMENTS. The
      // AndroidUtterance controller above accumulates those segments and
      // owns the conversational endpoint; native end is not a turn boundary.
      //
      // === v70.16 (Fabio 19/11/2026) — iOS PTT continuous ===
      // In PTT (autoEndpoint=false) attiviamo continuous anche su iOS:
      // SFSpeechRecognizer con continuous=false auto-finalizza dopo
      // ~1.5-3s di silenzio, violando lo spec "tieni premuto = ascolta
      // anche durante le pause". Con continuous=true, il recognizer resta
      // in ascolto finché NON chiamiamo stop() esplicito al rilascio.
      // Gli isFinal intermedi vengono bufferizzati in currentTranscript
      // (vedi result handler) e dispatchati UNA SOLA VOLTA in stop().
      const ptMode = !this.autoEndpoint; // PTT = manual endpointing
      const continuousIOS = Platform.OS === "ios" && ptMode;
      const startOpts: any = {
        lang,
        interimResults: true,
        continuous: Platform.OS === "android" || continuousIOS,
        maxAlternatives: 1,
        addsPunctuation: true,
        // On-device: preferito su entrambe, ma richiesto SOLO su iOS
        // (dove abbiamo già verificato in isSupported()). Su Android
        // lasciamo che il sistema decida (potrebbe non essercelo).
        requiresOnDeviceRecognition: true,
      };
      if (Platform.OS === "ios") {
        startOpts.iosCategory = {
          category: "playAndRecord",
          categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
          mode: "measurement",
        };
      }
      if (Platform.OS === "android") {
        startOpts.volumeChangeEventOptions = { enabled: true, intervalMillis: 300 };
        // Silence timeouts più lunghi per tolleranza pause naturali
        // (vedi commento sopra Fix v64.1 PROBLEMA #2).
        startOpts.androidIntentOptions = {
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 500,
        };
      }
      ExpoSpeechRecognitionModule.start(startOpts);
      console.log(`[${TAG}] ExpoSpeechRecognitionModule.start() OK (v70.4 continuous=${startOpts.continuous} endpoint=${this.autoEndpoint ? "auto-3000ms" : "manual-release"})`);
      // Readiness is reported by the native `start` event above, not by
      // the synchronous start() invocation returning.

      // === FIX 2026-07-26 v64.0 — Android silent-fail watchdog ===
      // Su Android (Google SpeechRecognizer), al 2° turno la start()
      // può risolvere silenziosamente senza mai attivare il mic HW —
      // nessun evento viene emesso. Il watchdog rileva questo caso.
      //
      // Timeout scelto empiricamente:
      //   • 5000ms → sufficiente per hardware slow (Huawei Kirin ~2s)
      //   • ma abbastanza corto da non far aspettare un utente vivo
      //     (che di solito comincia a parlare entro 3s dal tap).
      //
      // Se `speechstart` non arriva entro 5s, la sessione è considerata
      // zombie. Emettiamo error e HF backoff mette in pausa il loop.
      if (Platform.OS === "android") {
        if (this.micWatchdogTimer) {
          clearTimeout(this.micWatchdogTimer);
        }
        this.micWatchdogTimer = setTimeout(() => {
          this.micWatchdogTimer = null;
          if (this.recognitionStarted || this.speechStartReceived) return;
          if (this.doneReceived || this.stopRequested || this.dispatched) return;
          console.log(
            `[${TAG}] MIC_WATCHDOG_TIMEOUT — speechstart never received (5s) — session zombie, propagating error`
          );
          // Force reset dell'hw recognizer
          try { ExpoSpeechRecognitionModule.abort(); } catch {}
          this.notifiedUpperOnClose = true;
          this.doneReceived = true;
          try {
            this.callbacks.onError?.("android_mic_silent_fail");
          } catch {}
          try {
            this.forceCloseWs();
          } catch {}
        }, 5_000);
      }
    } catch (e: any) {
      console.log(`[${TAG}] start() FAILED: ${e?.message || e}`);
      try {
        this.callbacks.onError?.(`client_stt_start_failed:${e?.message || e}`);
      } catch {}
    }
  }

  /**
   * Normalizza un result event Apple in una forma coerente (raccoglie il primo
   * alternative). Se non c'è nessun risultato, ritorna null.
   */
  private normalizeResult(
    evt: ExpoSpeechRecognitionResultEvent
  ): NormalizedResult | null {
    const first = Array.isArray(evt.results) ? evt.results[0] : null;
    if (!first) return null;
    return {
      isFinal: !!evt.isFinal,
      transcript: (first as any).transcript || "",
      confidence:
        typeof (first as any).confidence === "number"
          ? (first as any).confidence
          : null,
    };
  }

  /**
   * Invia il transcript finale al backend + notifica il caller (onFinal).
   * Idempotente: se già dispatchato o doneReceived, no-op.
   */
  private dispatchFinalToBackend(): Promise<void> {
    return this.trackAudioTask(this.dispatchFinalAndReleaseFocus());
  }
  private async dispatchFinalAndReleaseFocus(): Promise<void> {
    if (this.dispatched || this.doneReceived) return;
    // Set flag SUBITO — così ogni chiamata successiva (safety net di end
    // handler, timeout, ecc.) diventa no-op. Evita 30+ duplicati che iOS
    // può innescare emettendo "end" ripetutamente.
    this.dispatched = true;
    const finalAt = Date.now();
    const text = (this.currentTranscript || "").trim();
    const conf = this.currentConfidence;
    const durMs = this.speechStartMs
      ? Math.max(0, Date.now() - this.speechStartMs)
      : null;

    console.log(
      `[${TAG}] dispatch → backend text="${text.slice(0, 60)}${text.length > 60 ? "…" : ""}" ` +
        `conf=${conf} dur=${durMs}ms route=${this.audioRoute}`
    );

    // Notifica upper layer (speech.ts callback onFinal) — questo triggera
    // recording→thinking state change nella UI, stesso comportamento di DG
    try {
      this.callbacks.onFinal?.(text, conf, durMs);
    } catch {}

    // Rimuovi listeners SUBITO dopo dispatch. Impedisce che ulteriori "end"
    // events di iOS re-innescano handler (anche col guard `dispatched`
    // vogliamo cmq zero rumore log e zero side-effects).
    this.removeListeners();

    // Fermiamo il recognizer (già stopped su isFinal, ma safety)
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {}

    // === FIX 2026-07-25 v63.8 — TTS MUTO su Android/MIUI (Fix C1) ===
    //
    // PROBLEMA (screenshot Fabio 25/07 7:11):
    //   STT funziona (Google SpeechRecognizer trascrive), Ollenya risponde
    //   con TESTO corretto, ma la sua VOCE non esce dall'altoparlante.
    //   Modalità testo chat → voce audibile. Modalità voce → voce muta.
    //
    // ROOT CAUSE:
    //   Google SpeechRecognizer su Android, quando parte, richiede
    //   AudioFocus con priorità AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
    //   (ducking). Quando finisce (stop() o naturale), NON rilascia
    //   AudioFocus esplicitamente — resta detenuto lato app. Quando poi
    //   ElevenLabs TTS tenta di suonare (via expo-audio createAudioPlayer),
    //   Android AudioService vede che il nostro processo ha ancora
    //   AudioFocus in modalità "may_duck" e silenzia lo stream media
    //   (STREAM_MUSIC) fino a un vero release.
    //
    //   Il vecchio fix (v63.4 fire-and-forget setAudioModeAsync) cambiava
    //   solo la MODE della session ma non toccava AudioFocus. Su iOS il
    //   problema non si manifesta perché AVAudioSession gestisce
    //   automaticamente il release quando la category cambia da
    //   playAndRecord a playback.
    //
    // FIX C1 — Cycle esplicito deactivate → wait → reset mode → reactivate:
    //   1. setIsAudioActiveAsync(false) → chiama abandonAudioFocus() nativo
    //   2. Wait 150ms → Android AudioService rilascia effettivamente il focus
    //   3. setAudioModeAsync(playback config)  → mode pulita per media
    //   4. setIsAudioActiveAsync(true) → riacquisisce focus per STREAM_MUSIC
    //
    //   Il cycle aggiunge ~200ms di latenza a dispatchFinalToBackend, ma
    //   questa funzione è async e non blocca la UI. Il TTS arriverà
    //   comunque dopo 1-3s (backend deve fare LLM + primo TTS), quindi
    //   il cycle finisce ampiamente prima che il primo player parta.
    //
    // NOTE:
    //   - Solo Android. iOS lasciato al comportamento nativo che funziona.
    //   - Await sul cycle (non fire-and-forget) così se TTS parte molto
    //     veloce (edge case backend caldissimo) è comunque garantito
    //     avere focus pulito.
    //   - Ogni step in try/catch: se un passo fallisce, gli altri
    //     provano comunque. Peggior caso: comportamento come prima
    //     (TTS muto), mai peggio.
    if (Platform.OS === "android") {
      try {
        const Audio: any = await import("expo-audio");
        if (this.doneReceived) return;
        const t0 = Date.now();

        // 1) Deactivate audio session — rilascia AudioFocus nativo
        try {
          if (typeof Audio.setIsAudioActiveAsync === "function") {
            await Audio.setIsAudioActiveAsync(false);
            console.log(`[${TAG}] audio focus release step1 (deactivate) ok`);
          }
        } catch (e: any) {
          console.log(`[${TAG}] audio focus release step1 FAILED: ${e?.message || e}`);
        }

        // 2) Wait 250ms — Android AudioService rilascia il focus asincrono
        // v64.0: aumentato da 150ms a 250ms per EMUI/HarmonyOS (Huawei/Honor)
        // dove il release del focus è più lento e il ciclo troppo veloce
        // lasciava lo stato inconsistente, contribuendo al mic-block al 2° turno.
        await new Promise((r) => setTimeout(r, 250));
        if (this.doneReceived) return;

        // 3) Set playback mode (non più record) — matches TTS_PLAY setup
        try {
          if (typeof Audio.setAudioModeAsync === "function") {
            await Audio.setAudioModeAsync({
              allowsRecording: false,
              playsInSilentMode: true,
              interruptionMode: "doNotMix",
              shouldRouteThroughEarpiece: false,
              shouldPlayInBackground: false,
            } as any);
            console.log(`[${TAG}] audio focus release step3 (mode=playback) ok`);
          }
        } catch (e: any) {
          console.log(`[${TAG}] audio focus release step3 FAILED: ${e?.message || e}`);
        }

        if (this.doneReceived) return;
        // 4) Reactivate audio session — riacquisisce focus per media
        try {
          if (typeof Audio.setIsAudioActiveAsync === "function") {
            await Audio.setIsAudioActiveAsync(true);
            console.log(`[${TAG}] audio focus release step4 (reactivate) ok`);
          }
        } catch (e: any) {
          console.log(`[${TAG}] audio focus release step4 FAILED: ${e?.message || e}`);
        }

        console.log(
          `[${TAG}] android audio focus cycle done in ${Date.now() - t0}ms (Fix C1 v63.8)`
        );
      } catch (e: any) {
        console.log(
          `[${TAG}] android audio focus cycle FAILED (non-fatal, TTS may be muted): ${e?.message || e}`
        );
      }
    }
    if (this.doneReceived) return;
    if (!/[\p{L}\p{N}]/u.test(text)) {
      this.doneReceived = true;
      this.callbacks.onError?.("no_speech");
      return;
    }
    try {
      await this.connectForFinal();
      if (this.doneReceived) return;
      if (this.ws?.readyState !== 1) throw new Error("ws_not_open");
      this.ws.send(JSON.stringify({type: "transcript_from_client", text,
        confidence: conf, duration_ms: durMs, lang: "it-IT", route: this.audioRoute,
        stt_engine: Platform.OS === "ios" ? "apple_sfspeechrecognizer" : "google_speechrecognizer"}));
      console.log(`[OLLENYA_LOCAL_STT] final_to_send_ms=${Date.now() - finalAt}`);
    } catch {
      if (!this.doneReceived && !this.notifiedUpperOnClose) {
        this.notifiedUpperOnClose = true;
        this.doneReceived = true;
        this.callbacks.onError?.("local_transcript_send_failed");
      }
      this.forceCloseWs();
    }

  }

  async stop(): Promise<void> {
    if (Platform.OS === "ios" && (this.doneReceived || this.dispatched)) {
      await this.drainAudioTasks();
      return;
    }

    // === v70.16 (Fabio 19/11/2026) — PTT: dispatch UNA SOLA VOLTA al rilascio
    // In PTT (autoEndpoint=false) stop() è l'UNICO punto in cui il transcript
    // viene inviato al backend. Il guard `dispatched` garantisce idempotenza
    // (chiamate multiple a stop() o safety net dell'end handler diventano
    // no-op). In HF (autoEndpoint=true) il dispatch può essere già avvenuto
    // su isFinal; questo stop è solo cleanup WS/recognizer.
    console.log(
      `[OLLENYA_STT_STOP] requested_before=${this.stopRequested} ` +
      `dispatched=${this.dispatched} done=${this.doneReceived} ` +
      `ptt=${!this.autoEndpoint} buffered_chars=${(this.currentTranscript || "").length} ` +
      `caller=${(new Error().stack || "").split("\n").slice(1, 4).join(" <- ")}`
    );
    if (this.dispatched) return;
    this.stopRequested = true;
    this.warmupAbort?.abort();
    this.cancelWsOpen?.();
    console.log(`[${TAG}] stop() called`);
    if (this.iosPttTurn) {
      if (!this.iosPttStopPromise) {
        this.iosPttStopPromise = new Promise<void>((resolve) => {
          this.iosPttStopResolve = resolve;
          this.iosPttStopTimer = setTimeout(() => this.finalizeIosPttStop(), 1500);
        });
        try { ExpoSpeechRecognitionModule.stop(); } catch {}
      }
      await this.iosPttStopPromise;
      await this.drainAudioTasks();
      return;
    }
    if (Platform.OS === "android" && !this.autoEndpoint && this.androidUtterance) {
      if (this.androidReleaseTimer !== null) return;
      this.androidReleaseTimer = setTimeout(() => {
        if (!this.dispatched && !this.doneReceived) this.finishIosPttWithoutDispatch("speech_not_recognized");
      }, 1500);
      try { ExpoSpeechRecognitionModule.stop(); } catch {}
      return;
    }
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {}
    // Se abbiamo trascritto qualcosa ma non lo abbiamo ancora inviato → invia
    // UNA SOLA VOLTA (dispatchFinalToBackend è idempotente via `dispatched`).
    if (this.currentTranscript && !this.dispatched && !this.doneReceived) {
      console.log(`[${TAG}] stop() → dispatch buffered final (${this.currentTranscript.length} chars)`);
      this.dispatchFinalToBackend().catch((e: any) =>
        console.log(`[VoiceClientSttSession] dispatchFinal error: ${e?.message || e}`)
      );
    } else if (!this.dispatched && !this.doneReceived) {
      // Nessuna trascrizione → manda solo type:end così il backend chiude.
      // In PTT questo è il caso "rilascio prima di parlare" → upper layer
      // va in idle senza mostrare errore (voice_stream_start_cancelled è
      // già gestito dallo strato superiore).
      console.log(`[${TAG}] stop() → no transcript, sending {type:end}`);
      try {
        this.callbacks.onError?.("no_speech");
        this.doneReceived = true;
        this.removeListeners();
      } catch {}
    }
    // Safety timeout — se dopo 40s il server non manda done, chiudi WS
    setTimeout(() => {
      if (!this.doneReceived) {
        console.log(`[${TAG}] stop() safety timeout — force closing WS`);
        this.stopKeepalive();
        this.forceCloseWs();
      }
    }, 40_000);
    await this.drainAudioTasks();
  }

  async abort(): Promise<void> {
    console.log(`[${TAG}] abort() — hard stop`);
    this.stopRequested = true;
    this.doneReceived = true;
    this.warmupAbort?.abort();
    this.cancelWsOpen?.();
    this.notifiedUpperOnClose = true;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
    this.removeListeners();
    this.stopKeepalive();
    this.forceCloseWs();
    await this.drainAudioTasks();
  }

  /**
   * === FIX 2026-07-23 v60.4 — AudioSession forced recovery cycle ===
   * Chiamato in fire-and-forget dopo un `error` non-benigno di
   * SFSpeechRecognizer. Fa deactivate → 300ms wait → reactivate della
   * AudioSession iOS in modo che il PROSSIMO turno parta da uno stato
   * pulito, anche se l'errore ha lasciato la session in stato residuale
   * "!act" (OSStatus 560557684).
   *
   * Log tag `[OLLENYA_AUDIO_ZOMBIE_RECOVERY]` è cercabile grep-per-grep dai log
   * TestFlight/producdion. Se in 2 settimane non compare = bug morto per
   * cambio architetturale (Fase B), fix rimovibile. Se compare = telemetria
   * di quante volte scatta e con quali codici — decisione informata sul
   * prossimo giro.
   *
   * NB: NON tocca la WS o il transcript in volo — quelli sono già gestiti
   * dal listener error che ha già propagato onError all'upper layer. Qui
   * facciamo solo housekeeping della AudioSession per il turno successivo.
   */
  private performAudioSessionRecoveryCycle(
    errorCode: string | undefined, errorMsg: string, isZombieCandidate: boolean
  ): Promise<void> {
    return this.trackAudioTask(this.runAudioSessionRecoveryCycle(errorCode, errorMsg, isZombieCandidate));
  }
  private async runAudioSessionRecoveryCycle(
    errorCode: string | undefined,
    errorMsg: string,
    isZombieCandidate: boolean
  ): Promise<void> {
    // Log SEMPRE (anche se non riteniamo sia zombie) — la telemetria vale
    // più della latenza di una console.log.
    console.log(
      `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] triggered code=${errorCode || "?"} ` +
        `msg="${(errorMsg || "").slice(0, 120)}" ` +
        `zombie_candidate=${isZombieCandidate ? "yes" : "no"}`
    );
    // === FIX v65.23 — Foreground gate =======================================
    // `setAudioModeAsync` / `setIsAudioActiveAsync` FALLISCONO se l'app è in
    // background: iOS rifiuta l'attivazione di audio session e restituisce
    // OSStatus 561015905 (`!pri`) o 560557684 (`!act`). Se siamo in background
    // saltiamo il recovery: verrà rieseguito al ritorno in foreground alla
    // prossima chiamata di start(). Vale sia iOS che Android.
    const currentAppState = AppState.currentState;
    if (currentAppState !== "active") {
      console.log(
        `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] SKIP — app not active (state=${currentAppState}), ` +
          `defer recovery to next foreground start()`
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AudioMod = require("expo-audio");
      const setAudioModeAsync = AudioMod.setAudioModeAsync;
      const setIsAudioActiveAsync = AudioMod.setIsAudioActiveAsync;
      // === FIX v65.23 — Explicit setIsAudioActiveAsync(false) =============
      // Il vecchio ciclo si limitava a setAudioModeAsync(allowsRecording:false).
      // Su iOS questo cambia la config della session ma NON chiama
      // AVAudioSession.setActive(false) — il flag "audio active" resta acceso
      // e alla riattivazione iOS può rifiutare con `!act` (OSStatus 560557684).
      // La sequenza corretta è: deactivate flag → cambio mode → reattivate flag.
      try {
        if (typeof setIsAudioActiveAsync === "function") {
          await setIsAudioActiveAsync(false);
          console.log(`[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step0 setActive(false) OK`);
        }
      } catch (e: any) {
        console.log(
          `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step0 setActive(false) FAILED: ${e?.message || e}`
        );
      }
      if (this.doneReceived || this.stopRequested) return;
      // Step 1: deactivate mode — dice a iOS "rilascia la session, non serve"
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: "mixWithOthers",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        });
        console.log(`[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step1 deactivate OK`);
      } catch (e: any) {
        console.log(
          `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step1 deactivate FAILED: ${e?.message || e}`
        );
      }
      // Step 2: attendi che iOS rilasci davvero l'hardware audio.
      // 300ms è il valore empirico dal doc audio-robustness: sotto rischi
      // race condition, sopra è overkill.
      await new Promise((r) => setTimeout(r, 300));
      if (this.doneReceived || this.stopRequested) return;
      // === FIX v65.23 — Reactivate con retry backoff (max 3 tentativi) =====
      // Se il primo reactivate fallisce con `!pri` (categoria audio non
      // ancora liberata da un'altra app / route in transizione), riproviamo
      // con backoff: 300ms → 800ms → 1500ms. In pratica basta quasi sempre
      // il primo tentativo; il retry copre i casi di route switch (bluetooth
      // dis/connect, silent switch flip, chiamata inbound conclusa da poco).
      const backoffMs = [0, 500, 1200];
      let reactivateOk = false;
      let lastError: string = "";
      for (let attempt = 0; attempt < backoffMs.length; attempt++) {
        if (backoffMs[attempt] > 0) {
          await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        }
        if (this.doneReceived || this.stopRequested) return;
        try {
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
            interruptionMode: "duckOthers",
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          });
          // Riacquisisce esplicitamente il flag "audio active" — necessario
          // perché step0 lo ha spento e il solo setAudioModeAsync non lo
          // riaccende. Senza questa chiamata il TTS successivo non ha
          // hardware focus e la voce esce muta (Android duck bug noto).
          if (typeof setIsAudioActiveAsync === "function") {
            await setIsAudioActiveAsync(true);
          }
          reactivateOk = true;
          console.log(
            `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step3 reactivate OK (attempt=${attempt + 1})`
          );
          break;
        } catch (e: any) {
          lastError = e?.message || String(e);
          console.log(
            `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step3 reactivate FAILED attempt=${attempt + 1}: ${lastError}`
          );
        }
      }
      if (!reactivateOk) {
        console.log(
          `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] step3 EXHAUSTED after ${backoffMs.length} attempts — last="${lastError}"`
        );
      }
      console.log(
        `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] cycle complete reactivate=${reactivateOk ? "ok" : "failed"} — next turn ${reactivateOk ? "should start clean" : "will retry from start()"}`
      );
    } catch (outer: any) {
      // expo-audio require() failed o altro crash: non blocchiamo mai.
      console.log(
        `[OLLENYA_AUDIO_ZOMBIE_RECOVERY] outer exception: ${outer?.message || outer}`
      );
    }
  }

  // === WS management (versione semplificata di voiceStream.ts) ===

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (error) { reject(error); return; }
      this.ws = ws;
      const opened = Date.now();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelWsOpen === cancel) this.cancelWsOpen = null;
        if (error) reject(error); else resolve();
      };
      const cancel = () => {
        finish(new Error("voice_stream_start_cancelled"));
        try { ws.close(1000); } catch {}
      };
      const timer = setTimeout(() => {
        finish(new Error("ws_open_timeout"));
        try { ws.close(1000); } catch {}
      }, 10000);
      this.cancelWsOpen = cancel;
      ws.onopen = () => {
        if (settled || this.doneReceived) { cancel(); return; }
        console.log(`[${TAG}] WS opened in ${Date.now() - opened}ms`);
        finish();
      };
      ws.onerror = () => {
        finish(new Error("ws_error"));
        this.forceCloseWs();
      };
      ws.onclose = ev => {
        finish(new Error(`ws_closed_before_open:${ev.code}`));
        if (this.ws === ws) this.ws = null;
        this.stopKeepalive();
        this.removeListeners();
        if (!this.doneReceived && !this.notifiedUpperOnClose) {
          this.notifiedUpperOnClose = true;
          this.callbacks.onError?.(`ws_closed_no_done:${ev.code}`);
        }
      };
      ws.onmessage = ev => this.handleWsMessage(ev);
    });
  }

  private handleWsMessage(ev: MessageEvent): void {
    const data = ev.data;
    if (typeof data !== "string") {
      // Binary frame: audio TTS della sentence corrente. Il header è
      // arrivato prima (sentence_header) → l'associamo.
      const buf =
        data instanceof ArrayBuffer
          ? data
          : (data as any)?.buffer instanceof ArrayBuffer
          ? (data as any).buffer
          : null;
      if (!buf) return;
      console.log(
        `[${TAG}] binary frame received bytes=${(buf as ArrayBuffer).byteLength}`
      );
      if (this.pendingSentenceHeader) {
        try {
          this.callbacks.onSentence?.(this.pendingSentenceHeader, buf as ArrayBuffer);
        } catch {}
        this.pendingSentenceHeader = null;
      }
      return;
    }
    // JSON message
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg?.type) {
      case "ready":
        this.sessionReady = true;
        console.log(`[${TAG}] ready sess=${(msg.session_id || "").slice(0, 8)}`);
        try {
          this.callbacks.onReady?.(msg.session_id || "");
        } catch {}
        break;
      case "stt_interim":
        // === Safety net 2026-07-23 v3 ===
        // In Fase B (client_apple), gli interim vengono già emessi
        // localmente da SFSpeechRecognizer via il callback onInterim
        // dentro startRecognition(). Il server NON dovrebbe mandare
        // stt_interim in questo branch. Se lo facesse (es. futuro
        // cambio), lo passiamo comunque all'upper layer per non
        // perderlo — è idempotente rispetto al partial locale.
        try {
          this.callbacks.onInterim?.(msg.text || "", !!msg.is_final);
        } catch {}
        break;
      case "stt_final":
        // === Safety net 2026-07-23 v3 ===
        // In Fase B (client_apple), il client ha GIÀ chiamato
        // onFinal() dentro dispatchFinalToBackend() PRIMA di mandare
        // transcript_from_client al server. Il backend in
        // voice_stream.py branch client_apple emette anche stt_final
        // come conferma (per allinearsi al percorso Deepgram), ma
        // ri-innescare onFinal qui causerebbe doppio recording→thinking
        // e possibili glitch UI. Quindi LOG-ONLY, no callback.
        console.log(
          `[${TAG}] stt_final echo (server confirm) text="${(msg.text || "").slice(0, 40)}" — ignoring (already dispatched client-side)`
        );
        break;
      case "sentence":
        // === FIX 2026-07-23 v3 — Nome messaggio corretto ===
        // Il backend Ollenya emette `{"type":"sentence", i, text, waveform, ...}`
        // seguito dal binary frame MP3. Nella prima versione avevo usato
        // erroneamente `"sentence_header"` che NON è il vero nome → il
        // messaggio veniva silenziosamente ignorato → pendingSentenceHeader
        // restava null → binary frame arrivava senza header pending → onSentence
        // NON veniva mai chiamato → nessuna coda TTS → thinking→idle direttamente
        // senza mai passare da "speaking". Verificato in
        // /app/backend/voice_stream.py:1260 e /app/frontend/lib/voiceStream.ts:836.
        this.pendingSentenceHeader = {
          i: msg.i || 0,
          text: msg.text || "",
          waveform: msg.waveform,
          window_ms: msg.window_ms,
          audio_bytes: msg.audio_bytes || 0,
          mime: msg.mime || "audio/mpeg",
        };
        console.log(
          `[${TAG}] sentence i=${msg.i || 0} text="${(msg.text || "").slice(0, 40)}${(msg.text || "").length > 40 ? "…" : ""}" bytes=${msg.audio_bytes || 0}`
        );
        break;
      case "meta":
        try {
          this.callbacks.onMeta?.(msg);
        } catch {}
        break;
      case "speech_timeline":
        // === ORB SILENCE SYNC (Task 2, Fix Bug #2 — Fabio 2026-08-13) ===
        // Copia esatta del case in voiceStream.ts. Il server manda
        // gli intervalli di silenzio della sentence per lo sync orb.
        try {
          const silences = Array.isArray(msg.silences) ? msg.silences : [];
          this.callbacks.onSpeechTimeline?.({
            i: typeof msg.i === "number" ? msg.i : 0,
            silences,
            duration_ms: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
            window_ms: typeof msg.window_ms === "number" ? msg.window_ms : undefined,
          });
        } catch (e) {
          console.log(`[${TAG}] onSpeechTimeline callback error: ${e}`);
        }
        break;
      case "done":
        this.doneReceived = true;
        console.log(`[${TAG}] done`);
        try {
          this.callbacks.onDone?.();
        } catch {}
        this.stopKeepalive();
        // Chiudi WS dopo done
        try {
          this.ws?.close(1000);
        } catch {}
        break;
      case "error":
        console.log(`[${TAG}] server error: ${msg.message}`);
        try {
          this.callbacks.onError?.(msg.message || "unknown_server_error");
        } catch {}
        break;
      default:
        break;
    }
  }

  private sendJson(obj: any): void {
    if (!this.ws || this.ws.readyState !== 1) {
      console.log(`[${TAG}] sendJson skipped — ws not open (state=${this.ws?.readyState})`);
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (e: any) {
      console.log(`[${TAG}] sendJson error: ${e?.message || e}`);
    }
  }

  private forceCloseWs(): void {
    try {
      this.ws?.close(1000);
    } catch {}
    this.ws = null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }
    }, 5000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private removeListeners(): void {
    if (this.androidReleaseTimer !== null) clearTimeout(this.androidReleaseTimer);
    this.androidReleaseTimer = null;
    if (this.iosPttStopTimer !== null) clearTimeout(this.iosPttStopTimer);
    this.iosPttStopTimer = null;
    const resolveIosStop = this.iosPttStopResolve;
    this.iosPttStopResolve = null;
    resolveIosStop?.();
    this.androidUtterance?.cancel();
    this.androidUtterance = null;
    // === FIX 2026-07-26 v64.0 — Clear mic watchdog on teardown ===
    if (this.micWatchdogTimer) {
      clearTimeout(this.micWatchdogTimer);
      this.micWatchdogTimer = null;
    }
    try {
      this.subResult?.remove();
    } catch {}
    try {
      this.subError?.remove();
    } catch {}
    try {
      this.subEnd?.remove();
    } catch {}
    try {
      this.subSpeechStart?.remove();
    } catch {}
    try { this.subRecognitionStart?.remove(); } catch {}
    try { this.subVolume?.remove(); } catch {}
    this.subResult = null;
    this.subError = null;
    this.subEnd = null;
    this.subSpeechStart = null;
    this.subRecognitionStart = null;
    this.subVolume = null;
  }

  private finalizeIosPttStop(): void {
    if (this.doneReceived || this.dispatched || !this.stopRequested || !this.iosPttTurn) return;
    if (this.iosPttTurn.hasPendingPartial) this.finishIosPttWithoutDispatch("speech_not_recognized");
    else if (this.iosPttTurn.text) {
      this.currentTranscript = this.iosPttTurn.text;
      this.dispatchFinalToBackend().catch(() => this.finishIosPttWithoutDispatch("client_stt_dispatch_failed"));
    } else this.finishIosPttWithoutDispatch("no_speech");
  }

  private finishIosPttWithoutDispatch(reason: string): void {
    if (this.doneReceived || this.dispatched) return;
    this.dispatched = true;
    this.doneReceived = true;
    this.notifiedUpperOnClose = true;
    this.removeListeners();
    this.stopKeepalive();
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
    try { this.callbacks.onError?.(reason); } catch {}
    this.forceCloseWs();
  }

  private failAndroidRecognition(reason: string): void {
    if (this.dispatched || this.doneReceived || this.stopRequested) return;
    this.doneReceived = true;
    this.notifiedUpperOnClose = true;
    this.removeListeners();
    this.stopKeepalive();
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
    try { this.callbacks.onError?.(reason); } catch {}
    this.forceCloseWs();
  }
}
