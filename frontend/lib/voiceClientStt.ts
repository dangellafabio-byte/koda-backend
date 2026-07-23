/**
 * lib/voiceClientStt.ts
 *
 * === FASE B — STT on-device Apple (SFSpeechRecognizer) ===
 *
 * Sessione voice-stream ALTERNATIVA a VoiceStreamSession (che usa Deepgram
 * server-side). Questa classe usa il framework nativo iOS `SFSpeechRecognizer`
 * via il pacchetto `expo-speech-recognition@3.1.3`. La trascrizione avviene
 * ON-DEVICE (nessun audio grezzo lascia il telefono), sfruttando il pipeline
 * di noise cancellation Apple. Solo il testo trascritto viene inviato al
 * backend WSS Koda, che poi esegue la pipeline LLM (Claude) + TTS (ElevenLabs)
 * IDENTICA al percorso Deepgram.
 *
 * Interfaccia PUBBLICA equivalente a VoiceStreamSession (start/stop/abort +
 * VoiceStreamCallbacks), così che lo switch avvenga trasparente lato caller
 * (speech.ts) via feature flag EXPO_PUBLIC_USE_CLIENT_STT.
 *
 * Flusso:
 *   1. Apri WS al backend Koda
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
 *  - Diagnostica: log `[KODA_CLIENT_STT]` per differenziarlo dal Deepgram path.
 */

import { Platform } from "react-native";
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

const TAG = "KODA_CLIENT_STT";

// === FIX 2026-07-23 — Usa Railway hardcoded, NON il preview Emergent ===
// Il preview Emergent (`app-finder-408.emergent.host`) NON ha il backend voice
// deployato → restituisce 502 sul WS. Il backend Koda vive su Railway
// (koda-backend-production-4a34.up.railway.app). Usiamo lo stesso helper
// hardcoded di voiceStream.ts (kodaBackendWsUrl) per garantire coerenza.
function buildWsUrl(): string {
  return kodaBackendWsUrl("/api/voice/stream");
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

  // Handlers rimuovibili
  private subResult: { remove: () => void } | null = null;
  private subError: { remove: () => void } | null = null;
  private subEnd: { remove: () => void } | null = null;
  private subSpeechStart: { remove: () => void } | null = null;

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
   */
  static async isSupported(): Promise<{
    supported: boolean;
    reason?: string;
  }> {
    if (Platform.OS !== "ios") {
      return { supported: false, reason: "platform_not_ios" };
    }
    try {
      const ondev = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
      if (!ondev) {
        return { supported: false, reason: "no_ondevice_it" };
      }
      const avail = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      if (!avail) {
        return { supported: false, reason: "recognition_unavailable" };
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
  }): Promise<void> {
    if (Platform.OS !== "ios") {
      throw new Error("client_stt_ios_only");
    }
    this.startedAt = Date.now();
    this.stopRequested = false;
    this.sessionReady = false;
    this.doneReceived = false;
    this.notifiedUpperOnClose = false;
    this.currentTranscript = "";
    this.currentConfidence = null;
    this.speechStartMs = 0;

    // 1) Permission check
    const perm = await VoiceClientSttSession.requestPermissions();
    if (!perm.granted) {
      throw new Error(`permission_denied${perm.canAskAgain ? "" : "_permanent"}`);
    }

    // 2) Audio session in record mode PRIMA di detectAudioRoute (stesso trick
    //    di voiceStream.ts riga ~416). Serve perché al turno N+1 la session
    //    può essere in playback-only e detectAudioRoute crasha.
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
      console.log(`[${TAG}] setAudioModeAsync(record) OK before detectAudioRoute`);
    } catch (e: any) {
      console.log(`[${TAG}] setAudioModeAsync FAILED: ${e?.message || e}`);
    }

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

    // 4) Apri WS
    const url = buildWsUrl();
    console.log(`[${TAG}] opening WS → ${url} route=${this.audioRoute}`);
    await this.openWs(url);

    // 5) Frame start → dice al backend: NON aspettare audio binario, aspettare
    //    invece un transcript_from_client. Nuovo campo: stt_source="client_apple".
    this.sendJson({
      type: "start",
      ephemeral: !!opts?.ephemeral,
      profile_lang: opts?.profileLang || "it",
      container: "text", // NON aac — backend sa che salta Deepgram
      stt_source: "client_apple",
      audio_route: this.audioRoute,
      location_city: opts?.locationCity || undefined,
      location_region: opts?.locationRegion || undefined,
      location_country: opts?.locationCountry || undefined,
    });

    if (this.stopRequested) {
      console.log(`[${TAG}] stopRequested=true after openWs → abort startup`);
      try {
        this.sendJson({ type: "end" });
      } catch {}
      return;
    }

    this.startKeepalive();

    // 6) Avvia SFSpeechRecognizer on-device (italiano)
    this.startRecognition(opts?.profileLang || "it");
  }

  private startRecognition(profileLang: string): void {
    const lang = profileLang === "it" ? "it-IT" : profileLang;
    console.log(`[${TAG}] startRecognition lang=${lang} ondevice=true`);

    // Registra listeners prima di start()
    this.subSpeechStart = ExpoSpeechRecognitionModule.addListener(
      "speechstart",
      () => {
        this.speechStartMs = Date.now();
        console.log(`[${TAG}] speechstart`);
      }
    );

    this.subResult = ExpoSpeechRecognitionModule.addListener(
      "result",
      (evt: ExpoSpeechRecognitionResultEvent) => {
        const norm = this.normalizeResult(evt);
        if (!norm) return;
        // Salva la trascrizione corrente (verrà usata sia per interim che final)
        this.currentTranscript = norm.transcript;
        this.currentConfidence = norm.confidence;

        // Notifica interim al caller (UI live transcript)
        try {
          this.callbacks.onInterim?.(norm.transcript, norm.isFinal);
        } catch {}

        if (norm.isFinal) {
          console.log(
            `[${TAG}] result FINAL text="${norm.transcript}" conf=${norm.confidence}`
          );
          this.dispatchFinalToBackend();
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
        console.log(
          `[${TAG}] error code=${evt.error} message="${evt.message || ""}"`
        );
        // "no-speech" e "aborted" sono benigni — no propagate
        if (evt.error === "no-speech" || evt.error === "aborted") return;
        try {
          this.callbacks.onError?.(`client_stt_${evt.error}`);
        } catch {}
      }
    );

    this.subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
      console.log(`[${TAG}] end event`);
      // Se non abbiamo ancora inviato final ma abbiamo un transcript accumulato,
      // consideriamolo final (safety net per casi in cui iOS chiude senza
      // isFinal=true).
      if (this.currentTranscript && !this.doneReceived) {
        console.log(
          `[${TAG}] end fired without isFinal → treating currentTranscript as final`
        );
        this.dispatchFinalToBackend();
      }
    });

    // Start SFSpeechRecognizer
    try {
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        requiresOnDeviceRecognition: true,
        addsPunctuation: true,
        // iOS: configuriamo la category audio session per non conflitto con
        // il plugin .voiceChat esistente. Usiamo .playAndRecord + mode
        // .measurement (best per STT su iOS senza toccare AEC/AGC).
        iosCategory: {
          category: "playAndRecord",
          categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
          mode: "measurement",
        },
      });
      console.log(`[${TAG}] ExpoSpeechRecognitionModule.start() OK`);
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
   * Idempotente: se doneReceived è già true, no-op.
   */
  private dispatchFinalToBackend(): void {
    if (this.doneReceived) return;
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

    // Manda il transcript al backend Koda
    try {
      this.sendJson({
        type: "transcript_from_client",
        text,
        confidence: conf,
        duration_ms: durMs,
        lang: "it-IT",
        route: this.audioRoute,
        stt_engine: "apple_sfspeechrecognizer",
      });
    } catch (e: any) {
      console.log(`[${TAG}] sendJson(transcript_from_client) FAILED: ${e?.message || e}`);
    }

    // Fermiamo il recognizer (già stopped su isFinal, ma safety)
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {}
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    console.log(`[${TAG}] stop() called`);
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {}
    // Se abbiamo trascritto qualcosa ma non lo abbiamo ancora inviato → invia
    if (this.currentTranscript && !this.doneReceived) {
      this.dispatchFinalToBackend();
    } else {
      // Nessuna trascrizione → manda solo type:end così il backend chiude
      try {
        this.sendJson({ type: "end" });
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
  }

  async abort(): Promise<void> {
    console.log(`[${TAG}] abort() — hard stop`);
    this.stopRequested = true;
    this.doneReceived = true;
    this.notifiedUpperOnClose = true;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
    this.removeListeners();
    this.stopKeepalive();
    this.forceCloseWs();
  }

  // === WS management (versione semplificata di voiceStream.ts) ===

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e: any) {
        return reject(e);
      }
      const opened = Date.now();
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        console.log(`[${TAG}] WS opened in ${Date.now() - opened}ms`);
        resolve();
      };
      ws.onerror = (e: any) => {
        console.log(`[${TAG}] WS error: ${JSON.stringify(e)}`);
        if (!settled) {
          settled = true;
          reject(new Error("ws_error"));
        }
      };
      ws.onclose = (ev) => {
        console.log(`[${TAG}] WS closed code=${ev.code} reason=${ev.reason}`);
        this.stopKeepalive();
        this.removeListeners();
        if (!this.doneReceived && !this.notifiedUpperOnClose) {
          this.notifiedUpperOnClose = true;
          try {
            this.callbacks.onError?.(`ws_closed_no_done:${ev.code}`);
          } catch {}
        }
      };
      ws.onmessage = (ev: MessageEvent) => this.handleWsMessage(ev);
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
      case "sentence_header":
        this.pendingSentenceHeader = {
          i: msg.i || 0,
          text: msg.text || "",
          waveform: msg.waveform,
          window_ms: msg.window_ms,
          audio_bytes: msg.audio_bytes || 0,
          mime: msg.mime || "audio/mpeg",
        };
        break;
      case "meta":
        try {
          this.callbacks.onMeta?.(msg);
        } catch {}
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
    this.subResult = null;
    this.subError = null;
    this.subEnd = null;
    this.subSpeechStart = null;
  }
}
