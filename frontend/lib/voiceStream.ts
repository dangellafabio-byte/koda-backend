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
const CHUNK_DURATION_MS = 1500; // durata di ogni recording chunk
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
const MAX_WS_RECONNECTS = 2;
const RECONNECT_BACKOFF_MS = 500;

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
      bitRate: 32000,
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
  private lastStartOpts: { ephemeral?: boolean; profileLang?: string } = {};
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

  constructor(callbacks: VoiceStreamCallbacks) {
    this.callbacks = callbacks;
  }

  /** Apre WS + avvia recording loop. */
  async start(opts?: { ephemeral?: boolean; profileLang?: string }): Promise<void> {
    if (Platform.OS === "web") {
      // Phase 1: solo nativo per ora (web ha MediaRecorder che richiede
      // un path diverso). Fallback all'esistente.
      throw new Error("voice streaming non supportato su web in Fase 1");
    }
    this.startedAt = Date.now();
    this.stopRequested = false;
    this.chunkIdx = 0;
    // Salva opts per eventuale reconnect
    this.lastStartOpts = { ephemeral: opts?.ephemeral, profileLang: opts?.profileLang };
    this.reconnectAttempts = 0;
    this.finalCloseRequested = false;
    // === FIX v8: reset flag di tracciamento done/close ===
    this.doneReceived = false;
    this.notifiedUpperOnClose = false;

    // 1) Apri WS
    const url = buildWsUrl();
    console.log(`[KODA_STREAM_CLIENT] opening WS → ${url}`);
    await this.openWs(url);

    // 2) Frame iniziale
    this.sendJson({
      type: "start",
      ephemeral: !!opts?.ephemeral,
      profile_lang: opts?.profileLang || "it",
      container: "aac",
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

  /** Forza la chiusura della sessione. Manda "end" al server. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.finalCloseRequested = true;
    this.chunkLoopActive = false;
    this.stopKeepalive();
    try {
      this.sendJson({ type: "end" });
    } catch {}
    // Stop current recording se in corso
    await this.safeStopRecorder();
    // NON chiudiamo subito il WS — aspettiamo "done" dal server con la
    // risposta TTS. Lo chiudiamo dentro onmessage quando arriva "done"
    // o dopo un timeout di sicurezza.
    setTimeout(() => this.forceCloseWs(), 25_000);
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
        // FIX v4: PRE-PREPARE prima di ogni record (riusabilità v54)
        if (verbose) console.log(`[KODA_STREAM_CLIENT] chunk #${cIdx} prepare...`);
        const t_prep = Date.now();
        await recorder.prepareToRecordAsync(preset);
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

        await new Promise((resolve) => setTimeout(resolve, CHUNK_DURATION_MS));

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
        console.log(
          `[KODA_STREAM_CLIENT_CHUNK] idx=${this.chunkIdx} ` +
            `size=${bytes.byteLength}B ` +
            `record_dur=${t_stop - t_record_started}ms ` +
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
        // Uso console.log (non warn) per essere catturato dal vecchio
        // diagLogger se la build attuale non è aggiornata.
        console.log(
          `[KODA_STREAM_CLIENT] chunk #${cIdx} ERROR: ${e?.message || e} | ` +
            `stack: ${String(e?.stack || "").split("\n").slice(0, 3).join(" | ")}`
        );
        await new Promise((r) => setTimeout(r, 200));
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
