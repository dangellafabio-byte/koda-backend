/**
 * KODA — Voice Streaming Client (Fase 1, giugno 2026)
 * ====================================================
 *
 * Sostituisce il flusso "record-then-upload" con uno streaming continuo:
 * apre una WebSocket verso /api/voice/stream, registra in rolling chunks
 * da ~500ms e li invia mentre l'utente parla. Deepgram Live decide la
 * fine dell'utterance lato server (endpointing linguistico, non volume).
 *
 * Vantaggi rispetto al flusso file:
 *  - Niente VAD volumetrico → funziona anche su Xiaomi MIUI (metering=-100)
 *  - Niente upload finale → -1.5/3s di latenza per turno
 *  - Endpointing intelligente → niente "il VAD non chiude in furgone"
 *
 * Tradeoff Fase 1 (MVP):
 *  - Rolling chunks via stop/start di expo-audio (gap 30-100ms tra chunk).
 *    Tradeoff accettabile per il prototipo. Se sui device si vedono gap
 *    >100ms o "missing_chunks" nei log, in Fase 2 si passa a un native
 *    module PCM live (oboe iOS/AVAudioEngine).
 *
 * USO:
 *   const session = new VoiceStreamSession({
 *     onInterim: (text, isFinal) => updateUI(text),
 *     onFinal: (text, confidence) => log("user said:", text),
 *     onSentence: (meta, audioBytes) => playAudio(audioBytes),
 *     onMeta: (m) => storeMeta(m),
 *     onDone: () => cleanup(),
 *     onError: (msg) => showError(msg),
 *   });
 *   await session.start({ ephemeral: false, profileLang: "it" });
 *   // ... user parla ...
 *   await session.stop(); // o aspetta UtteranceEnd automatico
 */
import { Platform } from "react-native";
import {
  AudioRecorder,
  AudioModule,
  RecordingPresets,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

// =============================================================
// CONFIG
// =============================================================
// === FIX 2026-06-25 v7 (post-Build #5 latency analysis) ===
// Su iOS expo-audio v54, prepareToRecordAsync costa ~1.3-1.6s per chunk
// (cold-start AVAudioRecorder ogni volta). Se i chunk sono 500ms, l'audio
// coverage è solo 25% (500ms su 2s di ciclo). Aumentando i chunk a 1500ms,
// la coverage sale al ~50% e Deepgram riceve segmenti più sostanziali su
// cui può fare endpointing. Trade-off accettato: latenza first-token
// leggermente più alta, ma molto più affidabile.
// === FIX 2026-06-28 v31 (Android: mic open/close → flash + buchi audio) ===
// Durata chunk raddoppiata da 1500ms → 3000ms. Su Android ogni stop()
// rilascia veramente il microfono e prepareToRecordAsync() lo riapre:
// 1) HyperOS Privacy Indicator pulsa ogni 2s (flash visivo confermato
//    dal video utente del 28-06)
// 2) micro-buchi audio tra i chunk → Deepgram non riesce a fare
//    endpointing pulito → mai stt_final → Koda non risponde su Android
// Su iPhone non succede perché iOS mantiene la AudioSession warm tra
// prepare/stop. Raddoppiando i chunk:
//   • cicli mic da ogni 2s → ogni 3.5s (flash dimezzato)
//   • chunk più sostanziali per Deepgram (endpointing più affidabile)
//   • trade-off: latenza first-token +1.5s (accettabile vs flusso rotto)
const CHUNK_DURATION_MS = 3000; // durata di ogni recording chunk
// === FIX 2026-06-26 v18 (cap differenziato chat vs sfogo) ===
// L'utente ha richiesto due livelli di cap a seconda del contesto:
//   - Chat normale: 3 minuti — sufficiente per quasi tutti i turni
//   - Stanza dello Sfogo (ephemeral=true): 5 minuti — quando uno si
//     lascia andare, non guarda l'orologio. È giusto dargli più spazio
//     prima che il microfono si fermi.
// La logica del cap (al raggiungimento manda "end" controllato e
// aspetta la TTS) è identica per entrambi i casi.
const STREAM_HARD_CAP_MS_CHAT = 180_000; // 3 minuti — modalità normale
const STREAM_HARD_CAP_MS_SFOGO = 300_000; // 5 minuti — Stanza dello Sfogo
const WS_OPEN_TIMEOUT_MS = 6_000;

// === FIX 2026-06-25 v7 (post-Build #6 WS close diagnostic) ===
// Su rete cellulare instabile (furgone, 4G ballerino) la WS può venir
// chiusa dal sistema iOS/proxy con code=1000 pochi secondi dopo l'apertura
// se il primo frame audio tarda ad arrivare. Mitigazioni:
//   1. KEEPALIVE_INTERVAL_MS: ping ogni 500ms per tenere caldi i proxy
//   2. MAX_WS_RECONNECTS: in caso di chiusura prematura, riapertura
//      automatica con stessi parametri (nuovo session_id server-side,
//      ma trasparente per l'utente)
const KEEPALIVE_INTERVAL_MS = 500;
// === FIX 2026-07-02 (Fabio "WS opened in 2795ms" + "code=1006 -9820") ===
// Su rete cellulare instabile (furgone 4G ballerino, cell handover, ecc.)
// possono succedere due cose:
//   1) L'apertura della WS dura 2+ secondi vs 400-600ms tipici.
//   2) La WS si chiude spontaneamente con code=1006 (unclean close), spesso
//      con OSStatus -9820 (SSL/TLS handshake fallito su iOS).
// Prima queste situazioni notificavano subito onError all'upper layer →
// stato UI in idle, utente deve ri-tap. Ora:
//   - MAX_WS_RECONNECTS alzato 2 → 3 (una possibilità in più prima di
//     mollare, la rete cellulare va e viene rapidamente).
//   - RECONNECT_BACKOFF_MS ridotto 500 → 350 (rapidità di ripristino
//     quando la rete torna).
//   - onclose distingue tra "close atteso" (done/stop) e "close recuperabile"
//     (1006 mentre stiamo registrando) — vedi voiceStream onclose handler.
const MAX_WS_RECONNECTS = 3;
const RECONNECT_BACKOFF_MS = 350;

const BACKEND_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) || "";

function buildWsUrl(): string {
  // BACKEND_URL è https://… → converti a wss://…
  // Se manca, fallback su origin corrente (web).
  if (BACKEND_URL) {
    const u = BACKEND_URL.replace(/^http/i, "ws");
    return `${u.replace(/\/$/, "")}/api/voice/stream`;
  }
  if (typeof window !== "undefined" && (window as any).location) {
    const loc = (window as any).location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${loc.host}/api/voice/stream`;
  }
  return "ws://localhost:8001/api/voice/stream";
}

// =============================================================
// EVENT TYPES
// =============================================================
export interface SentenceMeta {
  i: number;
  text: string;
  waveform?: number[];
  window_ms?: number;
  audio_bytes: number;
  mime: string;
}

export interface VoiceStreamCallbacks {
  onReady?: (sessionId: string) => void;
  onInterim?: (text: string, isFinal: boolean) => void;
  onFinal?: (text: string, confidence: number | null, audioDurationMs: number | null) => void;
  onSentence?: (meta: SentenceMeta, audioBytes: ArrayBuffer) => void;
  onMeta?: (meta: any) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

// =============================================================
// STREAMING PRESET
// =============================================================
function buildStreamingPreset() {
  const base = (RecordingPresets as any).HIGH_QUALITY || {};
  return {
    ...base,
    extension: ".m4a",
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    isMeteringEnabled: false, // non serve qui — Deepgram gestisce endpointing
    android: {
      ...(base.android || {}),
      extension: ".m4a",
      sampleRate: 16000,
      numberOfChannels: 1,
      // === FIX 2026-06-30 — Xiaomi STT garbled in furgone (Fabio) ===
      // Su Android il preset HIGH_QUALITY di expo-audio limita di default
      // il bitrate AAC a ~32 kbps. In ambiente rumoroso (furgone, vento,
      // strada) la compressione spinta toglie dettagli alle alte frequenze
      // → Deepgram fatica a distinguere consonanti simili (s/f, t/d, p/b)
      // → trascrizioni "garbled" / Koda fraintende. Su iPhone gli stessi
      // 32 kbps + processing hardware AVAudioSession bastano (Fabio
      // conferma: "iPhone mi sente bene"). Alziamo SOLO su Android a
      // 64 kbps: +12 KB/sec di banda (banale su 4G), qualità sensibilmente
      // migliore per Deepgram, nessun cambio iOS.
      // sample rate resta 16kHz (consigliato Deepgram per nova-2/3).
      bitRate: 64000,
      outputFormat: "mpeg4",
      audioEncoder: "aac",
      audioSource: "voice_communication", // AEC/NS/AGC hardware
      isMeteringEnabled: false,
    },
    ios: {
      ...(base.ios || {}),
      extension: ".m4a",
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 32000,
    },
  };
}

// =============================================================
// AUDIO ROUTE DETECTION (Fabio 2026-07-02 — furgone VAD dinamico)
// =============================================================
/**
 * Rileva la audio route corrente (bluetooth / wired / builtin) per
 * consentire al server di tunare i parametri Deepgram di endpointing.
 *
 * Approccio: crea un recorder temporaneo, chiama prepareToRecordAsync
 * per attivare la AudioSession, poi getCurrentInput() legge la porta
 * audio corrente da AVAudioSession (iOS) / MediaRecorder AudioSource
 * (Android). Se qualsiasi passo fallisce, ritorna "unknown" così il
 * server usa i parametri di default.
 *
 * NOTA: fatto una sola volta per sessione all'apertura della WS, non
 * per ogni chunk. Se durante la conversazione l'utente stacca il
 * Bluetooth (raro nel furgone) i parametri Deepgram restano quelli
 * iniziali — l'imprecisione è accettabile per l'MVP.
 *
 * @returns "bluetooth" | "wired" | "builtin" | "unknown"
 */
async function detectAudioRoute(): Promise<
  "bluetooth" | "wired" | "builtin" | "unknown"
> {
  const info = await detectAudioRouteDetailed();
  return info.route;
}

/**
 * Versione ESTESA di detectAudioRoute che ritorna anche il tipo di
 * dispositivo audio effettivo — utile per distinguere CarPlay (auto)
 * da auricolari personali (AirPods, cuffie cablate). Serve alla
 * Modalità Discreta che si attiva SOLO con auricolari personali.
 *
 * === FIX 2026-07-06 v46 (Fabio "Modalità telefono/discreta") ===
 */
export type AudioDeviceKind =
  | "airpods"          // AirPods / earbuds bluetooth personali
  | "headphones_wired" // cuffie/auricolari con cavo
  | "carplay"          // CarPlay (Bluetooth in auto)
  | "car_bluetooth"    // Bluetooth generico auto (non CarPlay)
  | "builtin"          // Microfono/speaker interno del telefono
  | "unknown";

export interface AudioRouteInfo {
  route: "bluetooth" | "wired" | "builtin" | "unknown";
  deviceKind: AudioDeviceKind;
  deviceType: string; // valore raw iOS/Android (es. "CarAudio", "BluetoothA2DP")
  deviceName: string; // nome UI del dispositivo (es. "AirPods di Fabio")
}

export async function detectAudioRouteDetailed(): Promise<AudioRouteInfo> {
  try {
    const probe = new (AudioModule as any).AudioRecorder({});
    const preset = buildStreamingPreset();
    try {
      await probe.prepareToRecordAsync(preset);
    } catch (e: any) {
      console.log(
        `[KODA_STREAM_CLIENT] detectAudioRoute: prepare failed: ${e?.message || e}`
      );
      return { route: "unknown", deviceKind: "unknown", deviceType: "", deviceName: "" };
    }
    let inputType = "";
    let inputName = "";
    try {
      const cur = await probe.getCurrentInput();
      inputType = String(cur?.type || "");
      inputName = String(cur?.name || "");
    } catch (e: any) {
      console.log(
        `[KODA_STREAM_CLIENT] detectAudioRoute: getCurrentInput failed: ${e?.message || e}`
      );
    }
    try { await probe.stop(); } catch {}

    const typeLC = inputType.toLowerCase();
    const nameLC = inputName.toLowerCase();
    const s = `${typeLC} ${nameLC}`;
    console.log(
      `[KODA_STREAM_CLIENT] detectAudioRoute: type="${inputType}" name="${inputName}"`
    );

    // Classificazione route (retrocompatibile)
    let route: "bluetooth" | "wired" | "builtin" | "unknown" = "unknown";
    if (/bluetooth|hfp|a2dp|\bble\b|car\s*audio/.test(s)) route = "bluetooth";
    else if (/headphone|headset|earbud|line[\s-]?in|usb\s*audio|wired/.test(s)) route = "wired";
    else if (/built[\s-]?in|internal|voice_communication|default|mic\b/.test(s)) route = "builtin";

    // Classificazione dispositivo (nuovo — per Modalità Discreta)
    let deviceKind: AudioDeviceKind = "unknown";
    if (/car\s*audio|carplay/.test(s)) {
      deviceKind = "carplay";
    } else if (/bluetooth|hfp|a2dp|\bble\b/.test(typeLC)) {
      // Bluetooth NON CarPlay: differenzia auricolari personali (AirPods/
      // Beats/nome utente) da sistemi car generici. Euristica:
      // - Se il nome contiene "airpods", "buds", "pods", "headphones",
      //   nome persona → auricolari personali
      // - Se contiene "car", "auto", "myford", "toyota", "bmw", "audi",
      //   "renault", "peugeot" ecc → car bluetooth (raro perché CarPlay
      //   copre la maggior parte dei casi moderni)
      if (/airpods|buds|pods|beats|headphone|headset|earbud/.test(nameLC)) {
        deviceKind = "airpods";
      } else if (/\bcar\b|auto|vehicle|ford|toyota|bmw|audi|renault|peugeot|fiat|volkswagen|volvo|mercedes|opel|kia|hyundai|honda|nissan|mazda|jeep/.test(nameLC)) {
        deviceKind = "car_bluetooth";
      } else {
        // Default per bluetooth generico: assumiamo auricolare personale
        // (più probabile per l'utente medio moderno)
        deviceKind = "airpods";
      }
    } else if (/headphone|headset|earbud|line[\s-]?in|usb\s*audio/.test(s)) {
      deviceKind = "headphones_wired";
    } else if (route === "builtin") {
      deviceKind = "builtin";
    }

    return { route, deviceKind, deviceType: inputType, deviceName: inputName };
  } catch (e: any) {
    console.log(
      `[KODA_STREAM_CLIENT] detectAudioRoute: crashed → unknown: ${e?.message || e}`
    );
    return { route: "unknown", deviceKind: "unknown", deviceType: "", deviceName: "" };
  }
}

// =============================================================
// SESSION
// =============================================================
export class VoiceStreamSession {
  private ws: WebSocket | null = null;
  private callbacks: VoiceStreamCallbacks;
  private recorder: AudioRecorder | null = null;
  private chunkLoopActive = false;
  private stopRequested = false;
  private sessionId: string | null = null;
  private startedAt = 0;
  private chunkIdx = 0;
  // Buffer per associare un binary frame al header sentence che lo precede
  private pendingSentenceHeader: SentenceMeta | null = null;
  // === FIX 2026-06-25 v7: keepalive + auto-reconnect (Build #6 WS close) ===
  private lastStartOpts: {
    ephemeral?: boolean;
    profileLang?: string;
    locationCity?: string;
    locationRegion?: string;
    locationCountry?: string;
  } = {};
  private reconnectAttempts = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Flag: si chiude la WS in modo "atteso" (es. arrivato 'done'/'stt_final'
  // o stop manuale). Quando true, NON tentiamo reconnect.
  private finalCloseRequested = false;
  // === FIX 2026-06-25 v8: traccia se "done" è stato ricevuto ===
  // Se la WS si chiude SENZA che "done" sia arrivato, voiceStreamConverse
  // resta in attesa eterna del pipelineDone. Bisogna notificare l'upper
  // layer via onError per farlo uscire. Questo bug bloccava la UI in
  // "recording" forever nel caso del tap-to-stop senza stt_final
  // (Build #7 Turno 2).
  private doneReceived = false;
  private notifiedUpperOnClose = false;
  // === FIX 2026-06-29 P1 — Anticipatory chunk stop ===
  // Quando arriva stt_final (Deepgram SpeechFinal), il chunkLoop sta
  // dentro un setTimeout(CHUNK_DURATION_MS) per registrare il chunk
  // corrente. Senza interrompere quel timer, il loop continua a girare
  // fino al completamento del chunk → fino a 3000ms di latenza
  // percepita dall'utente fra "smetto di parlare" e "Koda inizia a
  // pensare/parlare". Salviamo qui il canceller del wait corrente.
  private chunkWaitCancel: (() => void) | null = null;

  constructor(callbacks: VoiceStreamCallbacks) {
    this.callbacks = callbacks;
  }

  /** Interrompe il wait del chunk in corso (se attivo). Safe da chiamare
   *  anche se nessun wait è in corso (no-op). Idempotente. */
  private cancelChunkWait(reason: string): void {
    if (this.chunkWaitCancel) {
      const cancel = this.chunkWaitCancel;
      this.chunkWaitCancel = null;
      console.log(`[KODA_STREAM_CLIENT] chunk wait cancelled — ${reason}`);
      try { cancel(); } catch {}
    }
  }

  /** Apre WS + avvia recording loop. */
  async start(opts?: {
    ephemeral?: boolean;
    profileLang?: string;
    locationCity?: string;
    locationRegion?: string;
    locationCountry?: string;
  }): Promise<void> {
    if (Platform.OS === "web") {
      // Phase 1: solo nativo per ora (web ha MediaRecorder che richiede
      // un path diverso). Fallback all'esistente.
      throw new Error("voice streaming non supportato su web in Fase 1");
    }
    this.startedAt = Date.now();
    this.stopRequested = false;
    this.chunkIdx = 0;
    // Salva opts per eventuale reconnect
    this.lastStartOpts = {
      ephemeral: opts?.ephemeral,
      profileLang: opts?.profileLang,
      locationCity: opts?.locationCity,
      locationRegion: opts?.locationRegion,
      locationCountry: opts?.locationCountry,
    };
    this.reconnectAttempts = 0;
    this.finalCloseRequested = false;
    // === FIX v8: reset flag di tracciamento done/close ===
    this.doneReceived = false;
    this.notifiedUpperOnClose = false;

    // === FIX 2026-07-03 v38 — AudioSession mode PRIMA di detectAudioRoute ===
    // BUG RESIDUO da v37: dopo che Koda ha finito di parlare al turno N,
    // playElevenLabsNativeFromUrl (speech.ts) lascia AVAudioSession in
    // playback mode (allowsRecording:false, così TTS suona forte anche
    // in silenzioso). Al turno N+1, session.start() chiamava PRIMA
    // detectAudioRoute → probe.prepareToRecordAsync → iOS lanciava
    // RecordingDisabledException perché la session era ancora playback-only.
    // Poi la session iOS entrava in stato "danneggiato" → ogni successivo
    // prepareToRecordAsync in chunkLoop falliva con lo stesso errore →
    // loop infinito (regex isPrepareFail non matchava RecordingDisabledException,
    // quindi il cap di 5 retry non scattava).
    // FIX: mettiamo la session in record mode PRIMA di detectAudioRoute,
    // così detectAudioRoute non crasha e la pipeline procede pulita.
    // La chiamata duplicata in chunkLoop (riga ~761) resta come safety net
    // per il caso reconnect ed è idempotente.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setAudioModeAsync } = require("expo-audio");
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      console.log(
        `[KODA_STREAM_CLIENT] start(): setAudioModeAsync(record) OK before detectAudioRoute`
      );
    } catch (e: any) {
      console.log(
        `[KODA_STREAM_CLIENT] start(): setAudioModeAsync FAILED: ${e?.message || e}`
      );
    }

    // === FIX 2026-07-02 (Fabio "furgone non chiude") — Audio route detection ===
    // Rileva se siamo su Bluetooth (auto), auricolari cablati o mic
    // interno PRIMA di aprire la WS. Il server userà questo per
    // scegliere parametri Deepgram di endpointing più aggressivi in
    // furgone. Se detection fallisce → "unknown" → fallback default.
    // Timeboxato a 2s per non ritardare troppo il "tap to talk".
    let audioRoute: "bluetooth" | "wired" | "builtin" | "unknown" = "unknown";
    let audioDeviceKind: string = "unknown";
    try {
      const routeInfo = await Promise.race([
        detectAudioRouteDetailed(),
        new Promise<AudioRouteInfo>((resolve) =>
          setTimeout(
            () => resolve({ route: "unknown", deviceKind: "unknown", deviceType: "", deviceName: "" }),
            2000
          )
        ),
      ]);
      audioRoute = routeInfo.route;
      audioDeviceKind = routeInfo.deviceKind;
      console.log(
        `[KODA_STREAM_CLIENT] audio_route detected → ${audioRoute} | device kind → ${audioDeviceKind}`
      );
    } catch (e: any) {
      console.log(
        `[KODA_STREAM_CLIENT] audio_route detection crashed: ${e?.message || e}`
      );
    }
    // Salva per eventuale reconnect
    (this.lastStartOpts as any).audioRoute = audioRoute;
    (this.lastStartOpts as any).audioDeviceKind = audioDeviceKind;

    // 1) Apri WS
    const url = buildWsUrl();
    console.log(
      `[KODA_STREAM_CLIENT] opening WS → ${url} loc=${opts?.locationCity || "<none>"} route=${audioRoute}`
    );
    await this.openWs(url);

    // 2) Frame iniziale (include la città GPS e la audio route)
    this.sendJson({
      type: "start",
      ephemeral: !!opts?.ephemeral,
      profile_lang: opts?.profileLang || "it",
      container: "aac",
      audio_route: audioRoute,
      location_city: opts?.locationCity || undefined,
      location_region: opts?.locationRegion || undefined,
      location_country: opts?.locationCountry || undefined,
    });

    // 3) Aspetta "ready" (i frame in arrivo sono già instradati dal listener onmessage)

    // 4) Avvia keepalive (mantiene caldi proxy/ingress su rete cellulare instabile)
    this.startKeepalive();

    // 5) Avvia chunk loop in background
    this.chunkLoopActive = true;
    this.chunkLoop().catch((e) => {
      console.warn(`[KODA_STREAM_CLIENT] chunk loop crashed: ${e}`);
      this.callbacks.onError?.(String(e?.message || e));
    });
  }

  /** === FIX 2026-07-08 (Fabio "tap-to-stop chiude WS troppo presto") ===
   *  Graceful stop: ferma il microfono ma NON invia più "end" al server.
   *  Motivazione: il frame {type:"end"} costringe il server a chiudere
   *  la pipeline lato Deepgram prima che stt_final abbia margine di
   *  arrivare pulito, e in molti casi la WS si chiude prima che Koda
   *  possa streammare la risposta TTS. Nuovo comportamento:
   *   1) chunkLoop stop → niente più audio in entrata
   *   2) Deepgram VAD/endpointing chiude l'utterance sul silenzio
   *   3) server emette stt_final → parte pipeline LLM+TTS
   *   4) server invia sentence + audio + done, WS chiusa dal server
   *  Il long-press resta collegato a abort() per il kill-switch privacy. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.finalCloseRequested = true;
    this.chunkLoopActive = false;
    this.cancelChunkWait("stop() called");
    // Stop current recording se in corso
    await this.safeStopRecorder();
    // === FIX 2026-07-08: NON inviamo più {type:"end"} qui ===
    // Lasciamo che Deepgram VAD chiuda l'utterance naturalmente sul
    // silenzio. La WS resta aperta per ricevere sentence/audio/done.
    // Manteniamo il keepalive attivo così proxy cellulari non chiudono
    // la WS mentre aspettiamo la risposta TTS.
    // this.sendJson({ type: "end" });  ← rimosso intenzionalmente
    // this.stopKeepalive();            ← rimosso: keepalive utile fino a "done"

    // Timeout di sicurezza: se dopo 30s il server non manda "done",
    // chiudiamo comunque per evitare WS zombie.
    setTimeout(() => {
      if (!this.doneReceived) {
        console.log(
          `[KODA_STREAM_CLIENT] stop() safety timeout — no 'done' received in 30s, force closing WS`
        );
        this.stopKeepalive();
        this.forceCloseWs();
      }
    }, 30_000);
  }

  /** === HARD ABORT 2026-06-26 (richiesta utente "stop fisico") ===
   *  Diverso da stop(): NON manda il frame "end" al server, chiude la WS
   *  IMMEDIATAMENTE. Risultato: Deepgram non finalizza l'utterance →
   *  nessun stt_final → la pipeline LLM+TTS server-side NON parte →
   *  privacy garantita (l'audio già inviato resta a Deepgram come scarto,
   *  non viene mai elaborato da Claude né letto da ElevenLabs).
   *  Usato per "tap fisico per silenziare tutto quando entra qualcuno". */
  async abort(): Promise<void> {
    console.log(`[KODA_STREAM_CLIENT] abort() — user hard stop`);
    this.stopRequested = true;
    this.finalCloseRequested = true;
    this.chunkLoopActive = false;
    this.cancelChunkWait("abort() called");
    // Marca doneReceived=true così onclose non genera onError fasullo
    // (l'upper layer riceverà comunque il segnale di abort via signal).
    this.doneReceived = true;
    this.notifiedUpperOnClose = true;
    this.stopKeepalive();
    // Chiudi WS subito: niente frame "end", niente waiting per "done".
    this.forceCloseWs();
    // Stop recorder fire-and-forget (non blocchiamo il chiamante).
    this.safeStopRecorder().catch(() => {});
  }

  // === FIX 2026-06-25 v7: keepalive ping ===
  // Su iOS in cellular (es. furgone), proxy intermedi possono chiudere la
  // WS se passa più di 1-2 secondi senza traffico. Mandiamo un piccolo
  // ping JSON ogni 500ms per tenerla calda. Il backend riceve frame con
  // type sconosciuto e li ignora (continua nel suo loop).
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
        } catch {}
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // === FIX 2026-06-25 v7: WS auto-reconnect ===
  // Se la WS si chiude in modo inatteso (es. proxy cellular cattivo) e
  // l'utente sta ancora parlando, tentiamo di riaprire fino a MAX_WS_RECONNECTS
  // volte. Il server creerà una nuova sessione Deepgram — l'utente non
  // se ne accorgerà se il glitch è breve. Chunks fra le due connessioni
  // sono persi (best-effort), ma è meglio di una sessione completamente
  // morta.
  private async reconnectIfNeeded(): Promise<boolean> {
    if (this.stopRequested || this.finalCloseRequested) return false;
    if (this.reconnectAttempts >= MAX_WS_RECONNECTS) {
      console.log(
        `[KODA_STREAM_CLIENT] reconnect: max attempts (${MAX_WS_RECONNECTS}) raggiunti, abort`
      );
      return false;
    }
    this.reconnectAttempts++;
    console.log(
      `[KODA_STREAM_CLIENT] reconnecting WS (tentativo ${this.reconnectAttempts}/${MAX_WS_RECONNECTS}) dopo ${RECONNECT_BACKOFF_MS}ms...`
    );
    await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
    try {
      await this.openWs(buildWsUrl());
      this.sendJson({
        type: "start",
        ephemeral: !!this.lastStartOpts.ephemeral,
        profile_lang: this.lastStartOpts.profileLang || "it",
        container: "aac",
        audio_route: (this.lastStartOpts as any).audioRoute || "unknown",
        location_city: this.lastStartOpts.locationCity || undefined,
        location_region: this.lastStartOpts.locationRegion || undefined,
        location_country: this.lastStartOpts.locationCountry || undefined,
      });
      this.startKeepalive();
      console.log(`[KODA_STREAM_CLIENT] WS reconnesso con successo`);
      return true;
    } catch (e: any) {
      console.log(
        `[KODA_STREAM_CLIENT] reconnect fallito: ${e?.message || e}`
      );
      return false;
    }
  }

  // ============ INTERNALS ============

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("WS open timeout"));
      }, WS_OPEN_TIMEOUT_MS);

      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log(`[KODA_STREAM_CLIENT] WS opened in ${Date.now() - this.startedAt}ms`);
        resolve();
      };

      ws.onerror = (e: any) => {
        console.warn(`[KODA_STREAM_CLIENT] WS error: ${e?.message || e}`);
      };

      ws.onclose = (e) => {
        console.log(`[KODA_STREAM_CLIENT] WS closed code=${e.code} reason=${e.reason}`);
        this.stopKeepalive();

        // === FIX 2026-06-25 v8 (post-Build #7 Turno 2 UI bloccata) ===
        // Se la WS si chiude SENZA aver mai ricevuto "done", voiceStreamConverse
        // resterebbe in attesa eterna del pipelineDone. In quel caso dobbiamo
        // sbloccarlo notificandolo via onError (così la finally clause fa
        // setStatus("idle") e l'UI torna utilizzabile).
        if (!this.doneReceived && !this.notifiedUpperOnClose) {
          this.notifiedUpperOnClose = true;
          // Caso A: utente ha cliccato stop ma il server non ha emesso done.
          //         È un fallimento di pipeline (Deepgram non ha trovato
          //         transcript finale). Usciamo come errore controllato.
          // Caso B: WS chiusa per altri motivi senza che noi lo richiedessimo.
          //         Stesso trattamento — sbloccare l'upper layer.
          const reason = this.stopRequested
            ? "ws-closed-no-transcript-after-stop"
            : `ws-closed-unexpected-code-${e.code}`;
          console.log(`[KODA_STREAM_CLIENT] notifying upper layer of close: ${reason}`);
          this.callbacks.onError?.(reason);
        }

        if (this.finalCloseRequested || this.stopRequested) {
          this.chunkLoopActive = false;
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        this.onWsMessage(ev.data);
      };
    });
  }

  private onWsMessage(data: any) {
    if (typeof data === "string") {
      try {
        const evt = JSON.parse(data);
        this.handleJsonEvent(evt);
      } catch (e) {
        console.warn(`[KODA_STREAM_CLIENT] bad JSON: ${e}`);
      }
    } else {
      // binary frame: deve seguire un sentence header
      if (!this.pendingSentenceHeader) {
        // Frame binario senza header pendente: probabilmente un keepalive
        // o un frame fuori ordine. Logghiamo per visibilità ma non
        // facciamo nulla — il loop continua sulla prossima sentence.
        console.warn(
          `[KODA_STREAM_CLIENT] binary frame received without pending header — dropped ` +
            `(type=${typeof data} ctor=${(data as any)?.constructor?.name || "?"})`
        );
        return;
      }
      const header = this.pendingSentenceHeader;
      this.pendingSentenceHeader = null;

      // === FIX 2026-06-28 v28 — BUG ANDROID TTS NON RIPRODOTTA ===
      // Su Android React Native, `data instanceof ArrayBuffer` ritorna
      // FALSE anche se `data` È un ArrayBuffer (problema noto di realm
      // mismatch tra istanze ArrayBuffer del JS bridge e quelle di
      // V8/Hermes). Risultato: il frame audio veniva scartato silenziosamente
      // → niente onSentence → niente KODA_TTS_PLAY → niente voce di Koda.
      // Su iPhone funziona perché il bridge JS usa la stessa istanza
      // di ArrayBuffer.
      // FIX: invece di un singolo instanceof, proviamo IN CASCATA tutti
      // i tipi possibili che un frame binario WS può assumere su RN/web,
      // e logghiamo cosa abbiamo trovato per diagnostica futura.
      const ctorName = (data as any)?.constructor?.name || "?";
      console.log(
        `[KODA_STREAM_CLIENT] binary frame received ` +
          `ctor=${ctorName} byteLength=${(data as any)?.byteLength ?? (data as any)?.size ?? "?"} ` +
          `header_i=${header.i}`
      );

      const dispatch = (buf: ArrayBuffer) => {
        try {
          this.callbacks.onSentence?.(header, buf);
        } catch (e) {
          console.warn(`[KODA_STREAM_CLIENT] onSentence callback error: ${e}`);
        }
      };

      try {
        // Caso 1: ArrayBuffer "vero"
        if (data instanceof ArrayBuffer) {
          dispatch(data);
          return;
        }
        // Caso 2: ArrayBuffer-like (cross-realm: instanceof fallisce ma
        // l'oggetto È strutturalmente un ArrayBuffer — ha byteLength e
        // può essere passato a new Uint8Array)
        if (data && typeof (data as any).byteLength === "number" && !(data as any).buffer) {
          dispatch(data as ArrayBuffer);
          return;
        }
        // Caso 3: TypedArray (Uint8Array, Int8Array, ecc.) — usa .buffer
        if ((data as any)?.buffer instanceof ArrayBuffer) {
          dispatch((data as any).buffer);
          return;
        }
        // Caso 4: TypedArray cross-realm — .buffer esiste ma instanceof
        // fallisce. Stesso pattern del caso 2 per il buffer interno.
        if ((data as any)?.buffer && typeof (data as any).buffer.byteLength === "number") {
          dispatch((data as any).buffer);
          return;
        }
        // Caso 5: Blob (browser/web) — converti via .arrayBuffer()
        if (typeof (data as any)?.arrayBuffer === "function") {
          (data as any).arrayBuffer().then((buf: ArrayBuffer) => dispatch(buf))
            .catch((e: any) => console.warn(`[KODA_STREAM_CLIENT] Blob.arrayBuffer() failed: ${e}`));
          return;
        }
        // Caso 6: ultima istanza — array di numeri (vecchio bridge RN)
        if (Array.isArray(data)) {
          dispatch(new Uint8Array(data as number[]).buffer);
          return;
        }
        // Nessun caso: scartiamo MA logghiamo bene
        console.warn(
          `[KODA_STREAM_CLIENT] UNHANDLED binary frame type — dropped ` +
            `ctor=${ctorName} keys=${Object.keys(data || {}).slice(0, 5).join(",")}`
        );
      } catch (e) {
        console.warn(`[KODA_STREAM_CLIENT] binary dispatch error: ${e}`);
      }
    }
  }

  private handleJsonEvent(evt: any) {
    const type = evt?.type;
    if (type === "ready") {
      this.sessionId = evt.session_id || null;
      console.log(`[KODA_STREAM_CLIENT] ready sess=${this.sessionId?.slice(0, 8)}`);
      this.callbacks.onReady?.(this.sessionId || "");
    } else if (type === "stt_interim") {
      this.callbacks.onInterim?.(evt.text || "", !!evt.is_final);
    } else if (type === "stt_final") {
      console.log(
        `[KODA_STREAM_CLIENT] stt_final text=${(evt.text || "").slice(0, 60)}... ` +
          `conf=${evt.confidence} dur=${evt.audio_duration_ms}ms`
      );
      this.callbacks.onFinal?.(
        evt.text || "",
        evt.confidence ?? null,
        evt.audio_duration_ms ?? null
      );
      // Una volta che Deepgram ha detto "ho il testo finale", possiamo
      // smettere di registrare. Il server è già partito con la pipeline.
      // === FIX v7: marca finalCloseRequested per impedire reconnect ===
      this.finalCloseRequested = true;
      this.chunkLoopActive = false;
      // === FIX 2026-06-29 P1 — Anticipatory chunk stop ===
      // Interrompi il timer del chunk in corso (altrimenti il loop resta
      // dentro setTimeout(3000ms) fino al completamento → fino a 3s di
      // latenza percepita prima che Koda inizi a parlare).
      this.cancelChunkWait("stt_final received");
      this.stopKeepalive();
      this.safeStopRecorder().catch(() => {});
    } else if (type === "sentence") {
      // Salva header → il prossimo binary frame conterrà l'audio
      console.log(
        `[KODA_STREAM_CLIENT] sentence_header i=${evt.i} ` +
          `text="${(evt.text || "").slice(0, 40)}" bytes=${evt.audio_bytes}`
      );
      this.pendingSentenceHeader = {
        i: evt.i,
        text: evt.text,
        waveform: evt.waveform,
        window_ms: evt.window_ms,
        audio_bytes: evt.audio_bytes,
        mime: evt.mime || "audio/mpeg",
      };
    } else if (type === "meta") {
      this.callbacks.onMeta?.(evt);
    } else if (type === "done") {
      console.log(`[KODA_STREAM_CLIENT] done`);
      this.doneReceived = true;
      this.finalCloseRequested = true;
      this.notifiedUpperOnClose = true; // onDone notifica upper layer
      this.stopKeepalive();
      this.callbacks.onDone?.();
      this.forceCloseWs();
    } else if (type === "error") {
      console.warn(`[KODA_STREAM_CLIENT] server error: ${evt.message}`);
      this.callbacks.onError?.(evt.message || "server error");
    }
  }

  /** Loop principale: registra chunk da CHUNK_DURATION_MS, manda via WS, ripeti. */
  private async chunkLoop() {
    console.log(`[KODA_STREAM_CLIENT] chunkLoop ENTER`);
    // Permessi (idempotente)
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      console.log(
        `[KODA_STREAM_CLIENT] mic perm granted=${perm?.granted} status=${perm?.status}`
      );
    } catch (e: any) {
      console.warn(`[KODA_STREAM_CLIENT] perm request failed: ${e?.message || e}`);
    }

    // === FIX 2026-06-25 v9 (post-Build #8 Prova 2 disaster) ===
    // RIPRISTINATA la chiamata setAudioModeAsync({allowsRecording:true})
    // PRIMA di costruire il recorder. La rimozione in v8 era sbagliata:
    // dopo un TTS playback (es. risposta di Koda nel turno precedente),
    // playElevenLabsNativeFromUrl mette l'audio session in playback mode
    // (allowsRecording:false) e prewarmMic() da solo NON basta a forzare
    // iOS a tornare in record mode al turno successivo. Risultato:
    // RecordingDisabledException in loop infinito.
    //
    // In Build #7 questa chiamata funzionava (chunks catturati, stt_final
    // ricevuto). Il WS close che attribuii a questa chiamata era invece
    // dovuto ad altro (rete cellular).
    //
    // Lazy import per evitare ciclo voiceStream → speech → voiceStream.
    try {
      const { setAudioModeAsync } = require("expo-audio");
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      console.log(`[KODA_STREAM_CLIENT] setAudioModeAsync(allowsRecording=true) OK`);
    } catch (e: any) {
      console.log(`[KODA_STREAM_CLIENT] setAudioModeAsync FAILED: ${e?.message || e}`);
    }

    // === FIX 2026-06-24 v3 ===
    // UN SOLO recorder per tutta la sessione (come voice.ts).
    // Prima creavo new AudioRecorder per ogni chunk → su iOS l'AudioSession
    // non faceva in tempo a rilasciare il precedente → prepareToRecordAsync
    // si bloccava silenziosamente. Ora pattern voice.ts-compliant.
    //
    // FIX 2026-06-25 v4 (post-build #3 fallita): scopri che record() dopo
    // stop() lancia errore. Pattern corretto v54: prepareToRecordAsync
    // PRIMA DI OGNI record(). Il diagLogger ora cattura anche console.warn
    // quindi se questo pattern fallisce vediamo finalmente perché.
    let recorder: any = null;
    const preset = buildStreamingPreset();
    // === KODA_STT_BITRATE_CHECK (Fabio 2026-06-30) ===
    // Log diagnostico per confermare che il bundle nuovo è attivo sul
    // device. Su Android stampa il bitrate effettivamente applicato:
    //   v=32000 → bundle VECCHIO (fix non arrivato — killa l'app e riapri)
    //   v=64000 → bundle NUOVO attivo (fix applicato)
    // Su iPhone resta 32000 by design (Fabio conferma che funziona bene).
    try {
      const _bitrate =
        Platform.OS === "android"
          ? (preset as any).android?.bitRate
          : (preset as any).ios?.bitRate;
      console.log(
        `[KODA_STT_BITRATE_CHECK] platform=${Platform.OS} bitrate=${_bitrate} ` +
          `sampleRate=${(preset as any).android?.sampleRate ?? (preset as any).ios?.sampleRate} ` +
          `expected_android=64000 expected_ios=32000`
      );
    } catch {}
    try {
      console.log(`[KODA_STREAM_CLIENT] constructing single recorder...`);
      recorder = new (AudioModule as any).AudioRecorder({});
      this.recorder = recorder;
    } catch (e: any) {
      console.log(
        `[KODA_STREAM_CLIENT] recorder construct failed: ${e?.message || e}`
      );
      this.callbacks.onError?.(`mic-init-failed: ${e?.message || e}`);
      this.recorder = null;
      return;
    }

    let chunkStart = Date.now();
    let prevChunkEnd = chunkStart;
    // === FIX 2026-07-01 — iOS AudioSession 560557684 infinite-retry (Fabio da log) ===
    // Contatore fallimenti CONSECUTIVI di prepareToRecordAsync (in genere
    // OSStatus 560557684 = AVAudioSession is not active). Prima il catch
    // rifaceva setTimeout(200ms) e riprovava all'infinito → dopo un
    // app-background con audio session revocata l'app spammava il log
    // per 90+ secondi e restava in stato "recording" con WS morta,
    // impedendo tap sull'eclissi (streamingSessionRef non pulito).
    //
    // Fix:
    //  1) Cap MAX_CONSECUTIVE_PREPARE_FAILS retry (default 5, ~1.5s totali).
    //  2) Backoff progressivo 200→400→800→1200→1600ms per dare tempo
    //     alla session di stabilizzarsi.
    //  3) Reset AVAudioSession al secondo fallimento (deactivate+reactivate).
    //  4) Superato il cap → break del loop, chiamiamo notifyClose così
    //     lo speech.ts fa cleanup di streamingSessionRef → tap eclissi
    //     torna a funzionare, niente lock-up.
    let consecutivePrepareFailures = 0;
    const MAX_CONSECUTIVE_PREPARE_FAILURES = 5;

    while (this.chunkLoopActive && !this.stopRequested) {
      // === FIX 2026-06-26 v17/v18: hard-cap dinamico chat vs sfogo ===
      // Cap differenziato in base al contesto:
      //   - chat normale: 3 minuti (STREAM_HARD_CAP_MS_CHAT)
      //   - Stanza dello Sfogo (ephemeral=true): 5 minuti (STREAM_HARD_CAP_MS_SFOGO)
      // Raggiunto il limite, NON facciamo break secco (che lascerebbe
      // Deepgram in attesa di altri chunk all'infinito): inviamo "end"
      // al server in modo controllato, Deepgram chiude il suo stream,
      // emette stt_final, parte la pipeline LLM+TTS e l'utente riceve
      // normalmente la risposta vocale. La WS resta aperta finché il
      // server invia "done".
      const hardCapMs = this.lastStartOpts.ephemeral
        ? STREAM_HARD_CAP_MS_SFOGO
        : STREAM_HARD_CAP_MS_CHAT;
      if (Date.now() - this.startedAt > hardCapMs) {
        console.log(
          `[KODA_STREAM_CLIENT] hard-cap ${hardCapMs}ms raggiunto ` +
            `(mode=${this.lastStartOpts.ephemeral ? "sfogo" : "chat"}) — ` +
            `chiusura controllata input audio (mantengo WS aperta per TTS)`
        );
        this.stopRequested = true;
        this.finalCloseRequested = true;
        try { this.sendJson({ type: "end" }); } catch {}
        break;
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // === FIX 2026-06-25 v7: tenta reconnect invece di uscire ===
        console.log(
          `[KODA_STREAM_CLIENT] WS non più OPEN — tento reconnect...`
        );
        const reconnected = await this.reconnectIfNeeded();
        if (!reconnected) {
          console.log(`[KODA_STREAM_CLIENT] reconnect non disponibile — esco dal loop`);
          break;
        }
        // Continua il loop con la nuova WS
        continue;
      }

      const cIdx = this.chunkIdx + 1;
      try {
        const verbose = cIdx <= 3;
        // === FIX 2026-07-03 v40 — Fix D: guarantee AudioSession attiva ===
        // Bug documentato di expo-audio v54 con pattern "single recorder
        // riusato": dopo ~2 cicli prepare→record→stop→prepare→..., iOS
        // può de-attivare silenziosamente AVAudioSession (comportamento
        // default: "recording terminated"). Il successivo prepareToRecordAsync
        // fallisce con "Session activation failed" → loop di failure
        // fino al bail-out del cap (v38), con turno perso.
        //
        // Workaround documentato: prima di OGNI prepareToRecordAsync,
        // ri-attivare esplicitamente la session con setAudioModeAsync.
        // È idempotente (0-13ms misurati sui log Fabio), quindi il costo
        // è trascurabile (~15-35ms/turno = <1% latenza totale).
        //
        // Skip sul chunk #1 perché la chiamata è già stata fatta all'inizio
        // di chunkLoop (linea ~761): risparmiamo 1 chiamata inutile.
        if (cIdx > 1) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { setAudioModeAsync } = require("expo-audio");
            await setAudioModeAsync({
              allowsRecording: true,
              playsInSilentMode: true,
              interruptionMode: "duckOthers",
              shouldPlayInBackground: false,
              shouldRouteThroughEarpiece: false,
            });
            if (verbose) {
              console.log(
                `[KODA_STREAM_CLIENT] chunk #${cIdx} pre-prepare session refresh OK`
              );
            }
          } catch (e: any) {
            console.log(
              `[KODA_STREAM_CLIENT] chunk #${cIdx} pre-prepare refresh failed: ${e?.message || e}`
            );
          }
        }
        // FIX v4: PRE-PREPARE prima di ogni record (riusabilità v54)
        if (verbose) console.log(`[KODA_STREAM_CLIENT] chunk #${cIdx} prepare...`);
        const t_prep = Date.now();
        await recorder.prepareToRecordAsync(preset);
        // Prepare OK → reset contatore fallimenti consecutivi
        consecutivePrepareFailures = 0;
        if (verbose)
          console.log(
            `[KODA_STREAM_CLIENT] chunk #${cIdx} prepare OK in ${Date.now() - t_prep}ms`
          );

        if (verbose) console.log(`[KODA_STREAM_CLIENT] chunk #${cIdx} record()...`);
        const t_record_started = Date.now();
        recorder.record();

        if (verbose)
          console.log(
            `[KODA_STREAM_CLIENT] chunk #${cIdx} recording, wait ${CHUNK_DURATION_MS}ms...`
          );

        // === FIX 2026-06-29 P1 — Cancellable wait ===
        // Sostituiamo il setTimeout fisso con una Promise cancellabile,
        // così quando arriva stt_final (handleJsonEvent → cancelChunkWait)
        // possiamo uscire dal wait subito invece di aspettare fino a
        // CHUNK_DURATION_MS ms. Salva fino a ~3s di latenza percepita.
        let waitCancelled = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.chunkWaitCancel = null;
            resolve();
          }, CHUNK_DURATION_MS);
          this.chunkWaitCancel = () => {
            clearTimeout(timer);
            this.chunkWaitCancel = null;
            waitCancelled = true;
            resolve();
          };
        });

        // Early-exit: se il wait è stato cancellato (stt_final / stop /
        // abort), il recorder è già stato fermato esternamente via
        // safeStopRecorder(). NON tentiamo recorder.stop() di nuovo
        // (double-stop → eccezione), NON leggiamo URI e NON inviamo:
        // il server ha già la trascrizione e la pipeline LLM+TTS è
        // partita → inviare altri byte è solo spreco.
        if (waitCancelled || !this.chunkLoopActive || this.stopRequested) {
          const elapsed = Date.now() - t_record_started;
          const saved = CHUNK_DURATION_MS - elapsed;
          console.log(
            `[KODA_STREAM_CLIENT] chunk #${cIdx} anticipatory exit ` +
              `(elapsed=${elapsed}ms, saved=~${saved > 0 ? saved : 0}ms latency)`
          );
          break;
        }

        if (verbose) console.log(`[KODA_STREAM_CLIENT] chunk #${cIdx} stop...`);

        await recorder.stop();
        const t_stop = Date.now();

        // Leggi URI
        let uri: string | null = null;
        try {
          const statusUrl = (recorder.getStatus?.() as any)?.url || null;
          const directUri = recorder.uri || null;
          uri = statusUrl || directUri;
        } catch {}
        if (verbose) console.log(`[KODA_STREAM_CLIENT] chunk #${cIdx} uri=${uri ? "OK" : "NULL"}`);
        if (!uri) {
          // Uso console.log invece di console.warn — diagLogger ora cattura
          // entrambi ma per uniformità lasciamo log
          console.log(
            `[KODA_STREAM_CLIENT] chunk #${cIdx}: no URI — skipping`
          );
          continue;
        }

        // Leggi file
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const t_read = Date.now();
        const bytes = base64ToArrayBuffer(base64);

        // Invia
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(bytes);
        }
        const t_sent = Date.now();

        this.chunkIdx++;
        const gap = chunkStart - prevChunkEnd;
        const recDurMs = t_stop - t_record_started;
        // === FIX 2026-06-28 v33 — Anomaly detection ===
        // Se un chunk dura meno dell'80% del target, è un sintomo di
        // problemi: privacy indicator che interrompe, AudioSession
        // contesa, AppState change, ecc. Lo logghiamo con prefisso
        // ANOMALY così è grep-abile nel diag.
        if (recDurMs < CHUNK_DURATION_MS * 0.8) {
          console.log(
            `[KODA_STREAM_CLIENT_ANOMALY] chunk #${this.chunkIdx} ` +
              `duration_short=${recDurMs}ms target=${CHUNK_DURATION_MS}ms ` +
              `bytes=${bytes.byteLength} — possible mic interruption`
          );
        }
        console.log(
          `[KODA_STREAM_CLIENT_CHUNK] idx=${this.chunkIdx} ` +
            `size=${bytes.byteLength}B ` +
            `record_dur=${recDurMs}ms ` +
            `read=${t_read - t_stop}ms ` +
            `send=${t_sent - t_read}ms ` +
            `gap_prev=${gap > 0 ? gap : 0}ms`
        );

        // Cleanup file
        try {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        } catch {}

        prevChunkEnd = t_sent;
        chunkStart = Date.now();
      } catch (e: any) {
        // === FIX 2026-07-01 — iOS AudioSession 560557684 cap + backoff ===
        // Prima qui c'era solo setTimeout(200ms) e retry infinito. Se
        // l'utente andava in background+foreground iOS revocava la
        // session e lo stesso errore si ripeteva per 90+ secondi.
        // Ora: contatore fallimenti + backoff progressivo + tentativo
        // di reset AVAudioSession + bail-out dopo cap → notify upper.
        const errMsg = String(e?.message || e || "");
        const isPrepareFail =
          /prepareToRecordAsync/i.test(errMsg) ||
          /AudioSession/i.test(errMsg) ||
          /560557684/.test(errMsg) ||
          // === FIX 2026-07-03 v38 — RecordingDisabledException nel cap ===
          // Dopo che detectAudioRoute (o TTS playback) lascia iOS in
          // playback mode, prepareToRecordAsync lancia questo errore
          // testuale invece di quello OSStatus 560557684. Se non è
          // matchato dalla regex, il contatore consecutivePrepareFailures
          // non incrementa mai → il cap di 5 non scatta mai → loop
          // infinito. Aggiungiamo i due pattern noti iOS/RN.
          /RecordingDisabledException/i.test(errMsg) ||
          /Recording not allowed/i.test(errMsg);
        console.log(
          `[KODA_STREAM_CLIENT] chunk #${cIdx} ERROR: ${e?.message || e} | ` +
            `stack: ${String(e?.stack || "").split("\n").slice(0, 3).join(" | ")}`
        );

        if (isPrepareFail) {
          consecutivePrepareFailures += 1;
          console.log(
            `[KODA_STREAM_CLIENT] prepareToRecordAsync failure ` +
              `#${consecutivePrepareFailures}/${MAX_CONSECUTIVE_PREPARE_FAILURES}`
          );

          // Al 2° fallimento consecutivo, tenta reset AVAudioSession:
          // deactivate + riattiva. A volte iOS "sblocca" la session così.
          if (consecutivePrepareFailures === 2) {
            try {
              console.log(`[KODA_STREAM_CLIENT] attempting AVAudioSession reset (cycle)...`);
              // === FIX 2026-07-03 v38 — Reset con SET COMPLETO di parametri ===
              // Prima chiamava solo sma({allowsRecording:false}) e poi
              // sma({allowsRecording:true}) — troppo minimalista: iOS
              // resetta i parametri non specificati ai default (che
              // includono playsInSilentMode:false → audio silenzioso se
              // il telefono è in muto, e nessun ducking). Serve un reset
              // completo che ripristini tutti i parametri identici al
              // setup iniziale (linea ~761).
              // require locale come nel setup iniziale
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { setAudioModeAsync: sma } = require("expo-audio");
              await sma({
                allowsRecording: false,
                playsInSilentMode: true,
                interruptionMode: "duckOthers",
                shouldPlayInBackground: false,
                shouldRouteThroughEarpiece: false,
              } as any);
              await new Promise((r) => setTimeout(r, 150));
              await sma({
                allowsRecording: true,
                playsInSilentMode: true,
                interruptionMode: "duckOthers",
                shouldPlayInBackground: false,
                shouldRouteThroughEarpiece: false,
              } as any);
              console.log(`[KODA_STREAM_CLIENT] AVAudioSession reset done (full params)`);
            } catch (resetErr) {
              console.log(
                `[KODA_STREAM_CLIENT] AVAudioSession reset failed: ${String(resetErr)}`
              );
            }
          }

          // Cap raggiunto → bail-out: chiudi WS, notify upper layer
          // così speech.ts pulisce streamingSessionRef e l'utente può
          // ritappare l'eclissi senza restare bloccato.
          if (consecutivePrepareFailures >= MAX_CONSECUTIVE_PREPARE_FAILURES) {
            const reason = "prepare-failures-cap-560557684";
            console.log(
              `[KODA_STREAM_CLIENT] BAIL OUT — ${consecutivePrepareFailures} ` +
                `prepare failures consecutive: chiudo sessione e notifico upper (${reason})`
            );
            this.chunkLoopActive = false;
            this.stopRequested = true;
            this.finalCloseRequested = true;
            // Stessa notifica-pattern usata quando WS si chiude senza transcript
            // (linea 443-444): upper layer pulirà streamingSessionRef → tap eclissi
            // torna a funzionare.
            try { this.callbacks.onError?.(reason); } catch {}
            try { this.ws?.close(1000, "prepare-failures"); } catch {}
            break;
          }

          // Backoff progressivo: 200 → 400 → 800 → 1200 → 1600 ms
          const backoffMs = Math.min(200 * consecutivePrepareFailures * 2, 1600);
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          // Errore non prepare-related → backoff base 200ms come prima
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    // === CLEANUP FINALE ===
    console.log(
      `[KODA_STREAM_CLIENT] chunk loop ending — chunks=${this.chunkIdx} ` +
        `dur=${Date.now() - this.startedAt}ms ` +
        `(active=${this.chunkLoopActive} stopReq=${this.stopRequested})`
    );
    await new Promise((r) => setTimeout(r, 100));
    try { await recorder.stop(); } catch {}
    try { recorder.release?.(); } catch {}
    this.recorder = null;
    console.log(`[KODA_STREAM_CLIENT] chunk loop fully cleaned up`);
  }

  private async safeStopRecorder() {
    const rec = this.recorder;
    this.recorder = null;
    if (!rec) return;
    try { await rec.stop(); } catch {}
  }

  private sendJson(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private forceCloseWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
  }
}

// =============================================================
// Util
// =============================================================
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  // RN non ha atob nativo in tutti i runtime. Usa Buffer se disponibile,
  // altrimenti polyfill manuale.
  if (typeof atob !== "undefined") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  // Polyfill: decodifica manuale base64
  const lookup =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const map = new Map<string, number>();
  for (let i = 0; i < lookup.length; i++) map.set(lookup[i], i);
  let clean = b64.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = map.get(clean[i]) || 0;
    const b = map.get(clean[i + 1]) || 0;
    const c = map.get(clean[i + 2]) || 0;
    const d = map.get(clean[i + 3]) || 0;
    out[outIdx++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[outIdx++] = ((b & 0x0f) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[outIdx++] = ((c & 0x03) << 6) | d;
  }
  return out.buffer;
}
