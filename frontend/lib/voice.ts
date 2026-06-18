// Voice recording — migrated to expo-audio (SDK 54).
//
// HANDS-FREE upgrade (June 2025):
//   - VAD (Voice Activity Detection) via metering polling (~70ms cadence)
//   - Custom low-bitrate preset (16kHz mono ~32kbps) → file ~4x smaller
//     → upload + STT roundtrip noticeably faster, perfect for STT
//   - onSpeechStart / onSilence / onMeter callbacks are NOW real (were stubs)
//   - Silence threshold + min-speech window tuned for natural pause (~800ms)
//
// Web path is unchanged (uses native MediaRecorder).
import { Platform } from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";

export type Recorder = {
  stop: () => Promise<{ uri?: string; blob?: Blob; mime: string; filename: string } | null>;
  cancel: () => Promise<void>;
  onSilence?: (cb: () => void) => void;
  onSpeechStart?: (cb: () => void) => void;
  onMeter?: (cb: (dbValue: number, voicePresentDb?: number | null) => void) => void;
  pauseSilence?: () => void;
  resumeSilence?: () => void;
  resetSilenceState?: () => void;
};

let _webPermissionAsked = false;
let _nativeReady = false;

// ============ VAD CONSTANTS ============
// Tuned to ignore background TV/music/chatter and react only to the user
// speaking near the phone:
//   - SPEECH_THRESHOLD_DB: above this dB → voice present (raised for noise tolerance)
//   - SILENCE_THRESHOLD_DB: below this dB → silence (hysteresis)
//   - SILENCE_DURATION_MS: how long silence must last before firing onSilence
//   - MIN_SPEECH_MS: voice must be detected for at least this long before we allow silence to fire
//   - MIN_SPEECH_FRAMES: number of CONSECUTIVE above-threshold frames required to
//     officially mark "speech started" — eliminates single pops/short TV bursts.
//   - METER_POLL_MS: how often we sample the microphone meter
//
// === FIX 2026-05-22 (root cause "Koda non sente") ===
// Prima la soglia era a -22 dBFS: TROPPO ALTA. Una persona che parla a
// distanza naturale dal telefono produce in media -28 / -32 dBFS. A -22
// l'audio veniva catturato ma classificato come "silenzio" → nessuna
// chiamata transcribe-deepgram → l'utente vedeva l'orb sempre verde
// (idle) e pensava che l'app fosse rotta. È IL BUG che giravamo da ore.
// Abbassata a -38 (livello standard nei VAD audio).
//
// === RAFFINAMENTO 2026-05-23 (caso "in macchina con musica") ===
// -38 si è rivelata TROPPO BASSA per ambienti rumorosi:
//   - Motore auto idle: -30/-25 dBFS → sempre sopra soglia → VAD non
//     vede mai silenzio → orb resta sempre tiffany, utente deve toccare.
//   - Ufficio con AC: simile.
// Compromesso: -28 dBFS. Funziona sia in macchina che a casa:
//   - Voce a 5-30 cm dal telefono: -15 / -5 dBFS → SOPRA -28 ✓
//   - Voce a 50 cm in stanza silenziosa: -25 / -20 dBFS → SOPRA -28 ✓
//   - Motore/AC/musica bassa: -30 / -25 dBFS → SOTTO -28 (la maggior
//     parte del tempo) → silenzio rilevato correttamente.
// Hysteresis di 8 dB tra silence e speech (era già nel codice).
// === RAFFINAMENTO 2026-06 (caso "Koda mi taglia mentre parlo in macchina") ===
// L'utente in auto si lamentava di TAGLI PREMATURI: dopo qualche
// secondo, durante una pausa naturale (quando rifletti, fai "ehm…",
// prendi fiato), il VAD dichiarava silenzio e tagliava la frase.
// Diagnosi:
//   - SILENCE_DURATION_MS=800 era troppo basso. Una pausa naturale
//     tra due frasi del parlato umano dura tipicamente 600-1200ms.
//     800ms → tagliava le pause di pensiero.
//   - SPEECH_THRESHOLD a -28 dBFS era già OK per la maggioranza, ma
//     un filo troppo restrittivo: se l'utente si spostava di 10cm
//     dal microfono, ogni tanto la voce scendeva a -29/-30 e il VAD
//     pensava "silenzio" pur non essendolo.
// Fix:
//   - SILENCE_DURATION_MS: 800 → 1500ms (tollera pause naturali)
//   - SPEECH_THRESHOLD: -28 → -30 dBFS (più permissivo)
//   - SILENCE_THRESHOLD: -36 → -38 dBFS (hysteresis più ampia)
//   - MIN_SPEECH_MS: 500 → 350ms (parte prima se inizi subito)
// === FIX VAD 2026-06-27: utente segnalava "registrazione troppo corta —
// Deepgram restituisce vuoto". Misurato dai log backend: registrazioni
// sotto ~35KB (=2s di audio) → transcript vuoto, perché Deepgram ha
// bisogno di almeno 2.5-3s di voce continuata per trascrivere bene.
// Aumentiamo le soglie per dare TEMPO all'utente di parlare:
//   - SILENCE_DURATION_MS: 900 → 1500 (più tolleranza alle pause naturali)
//   - MIN_SPEECH_MS: 350 → 700 (recording almeno 700ms PRIMA che possa
//     scattare silence — evita cut-off dopo 1 sola parola)
// === FIX VAD 2026-06-27 / SECONDO PASSAGGIO 2026-06-27 PM ===
// L'utente segnala: "se smetto di parlare il VAD non si accorge e
// la registrazione non si ferma — devo schiacciare manualmente".
//
// ROOT CAUSE: il rumore di fondo della stanza (TV, ventilatore,
// respiro vicino al mic) sta tipicamente a -30 / -28 dBFS. Con
// SPEECH_THRESHOLD a -32 dBFS, OGNI singolo frame anche dopo che
// l'utente ha smesso di parlare risulta "voce" → lastVoiceAt viene
// continuamente rinfrescato → il timer di silenzio non parte mai.
// In più, il check di silenzio era INNESTATO nell'else: se il rumore
// stava sopra -32 anche solo a sprazzi, il check non veniva mai
// eseguito.
//
// DOPPIO FIX:
//   1) SUSTAINED_VOICE_DB = -26 → solo voce CHIARAMENTE sopra
//      l'ambiente rinfresca lastVoiceAt. Il rumore di fondo non
//      tiene più viva la registrazione.
//   2) Il check di silenzio è spostato FUORI dall'if/else: gira
//      ad ogni frame, controlla solo lastVoiceAt. Anche se nel
//      frame corrente c'è un picco di rumore (es. tosse), il timer
//      di silenzio dal momento dell'ultima voce reale continua a
//      crescere correttamente.
// === SOGLIE VAD — PLATFORM-AWARE (giugno 2026 v9) ===
// Su iOS expo-audio riporta `metering` in dBFS già correttamente normalizzato
// (-160..0): rumore di stanza tipico -38/-42 dBFS, voce -10/-25 dBFS.
//
// Su Android la scala dB è derivata da MediaRecorder.getMaxAmplitude() e il
// FLOOR del rumore tende a essere più alto (-22/-18 dBFS in stanza normale).
// Le soglie iOS sono troppo basse → VAD scambia il rumore di fondo per voce
// → lastVoiceAt non scade mai → fine-turno mai.
//
// AURICOLARI/BT: livello voce significativamente più basso del mic interno.
// SPEECH_THRESHOLD iOS abbassata da -38 a -42 dBFS per catturare anche voci
// pacate/lontane dal mic. SUSTAINED da -34 a -36 per non perdere la voce
// durante pause brevi. Frame counter da 3 a 2 (~140ms) per essere più
// reattivi all'inizio del parlato.
const _IS_ANDROID = Platform.OS === "android";
const SPEECH_THRESHOLD_DB = _IS_ANDROID ? -26 : -42;     // sopra → voce presente
const SUSTAINED_VOICE_DB  = _IS_ANDROID ? -22 : -36;     // sopra → rinfresca lastVoiceAt
const SILENCE_THRESHOLD_DB = _IS_ANDROID ? -30 : -46;    // sotto → reset aggressivo frame counter
const SILENCE_DURATION_MS = 600;     // 0.6s silence after speech → end of utterance
const MIN_SPEECH_MS = 500;           // 500ms minimo di voce prima che silence possa scattare
// === FIX FALSI POSITIVI 2026-06-28 (post 20 test hands-free) ===
// I 20 test hanno dimostrato che il VAD ora chiude da solo (bug storico
// risolto). Ma è emerso un bug secondario: in stanza silenziosa, se
// l'utente NON parla subito, capita che un micro-rumore (click delle
// dita sul telefono, fruscio dei vestiti, vibrazione tavolo) duri 100-
// 150ms — sufficiente con MIN_SPEECH_FRAMES=2 (140ms) per scatenare un
// falso positivo di speech_start. Da lì il VAD aspetta SILENCE_DURATION_MS
// (600ms) e chiude → audio contiene solo il click → Deepgram vuoto →
// "Non ti ho sentito".
//
// Fix: 2 → 4 (280ms). Un click/fruscio NON dura 280ms continuativi.
// Una "Ciao" reale dura 300-500ms → la soglia resta comodamente
// raggiungibile per voce vera, ma filtra i rumori brevi.
const MIN_SPEECH_FRAMES = 4;         // 4 frame consecutivi (~280ms) → filtra click/fruscii brevi
const METER_POLL_MS = 70;            // ~14Hz sampling
const HARD_CAP_MS = 60_000;          // absolute max recording length

/**
 * Pre-warm the microphone: request permission and pre-configure the audio
 * session so the first tap-to-talk feels instant (no permission dialog,
 * no AVAudioSession initialization delay).
 */
export async function prewarmMic(): Promise<boolean> {
  try {
    if (Platform.OS === "web") {
      if (_webPermissionAsked) return true;
      _webPermissionAsked = true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    }
    if (_nativeReady) return true;
    try {
      await requestRecordingPermissionsAsync();
    } catch {}
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
    } catch {}
    _nativeReady = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Hands-Free optimized recording preset:
 *   - 16kHz mono, ~32kbps AAC in .m4a
 *   - Metering ENABLED → required for VAD
 * Falls back to HIGH_QUALITY if anything goes wrong (RN never sees an error).
 */
function buildHandsFreePreset() {
  const base = (RecordingPresets as any).HIGH_QUALITY || {};
  return {
    ...base,
    extension: ".m4a",
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    isMeteringEnabled: true,
    android: {
      ...(base.android || {}),
      extension: ".m4a",
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 32000,
      outputFormat: "mpeg4",
      audioEncoder: "aac",
      // === FIX METERING ANDROID 2026-06-28 ===
      // Dai log del telefono Android della partner: db=-100.0 per tutti
      // gli 11.6 secondi di registrazione. La flag top-level
      // `isMeteringEnabled: true` non viene letta dal recorder Android
      // di expo-audio: va specificata DENTRO la sezione android. Senza
      // questa, recorder.getStatus().metering ritorna sempre -100 →
      // VAD inerte → hands-free inutilizzabile.
      isMeteringEnabled: true,
    },
    ios: {
      ...(base.ios || {}),
      extension: ".m4a",
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 32000,
      // Keep MEDIUM/HIGH audio quality — file size driven by bitRate above.
    },
    web: {
      ...(base.web || {}),
      mimeType: "audio/webm",
      bitsPerSecond: 32000,
    },
  };
}

export async function startRecording(): Promise<Recorder> {
  // ============ WEB ============
  if (Platform.OS === "web") {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    _webPermissionAsked = true;
    const mime = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/mp4";
    const mr = new MediaRecorder(stream, { mimeType: mime });
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mr.start();
    const startedAt = Date.now();

    // ===== WEB VAD via WebAudio analyser =====
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let vadInterval: any = null;
    let speechStartCb: (() => void) | null = null;
    let silenceCb: (() => void) | null = null;
    let meterCb: ((db: number, threshold?: number | null) => void) | null = null;
    let speechStartFired = false;
    let firstSpeechAt: number | null = null;
    let lastVoiceAt: number | null = null;
    let consecutiveVoiceFrames = 0;
    let vadPaused = false;
    let vadStopped = false;

    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) {
        audioCtx = new Ctx();
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        vadInterval = setInterval(() => {
          if (vadStopped || vadPaused || !analyser) return;
          analyser.getFloatTimeDomainData(buf);
          // RMS → dBFS
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
          const rms = Math.sqrt(sumSq / buf.length);
          const db = rms > 0 ? 20 * Math.log10(rms) : -100;
          if (meterCb) {
            try { meterCb(db, SPEECH_THRESHOLD_DB); } catch {}
          }
          const now = Date.now();
          if (db > SPEECH_THRESHOLD_DB) {
            consecutiveVoiceFrames++;
            if (consecutiveVoiceFrames >= MIN_SPEECH_FRAMES && !speechStartFired) {
              speechStartFired = true;
              firstSpeechAt = now - MIN_SPEECH_FRAMES * METER_POLL_MS;
              if (speechStartCb) try { speechStartCb(); } catch {}
            }
            if (speechStartFired) lastVoiceAt = now;
          } else if (db < SILENCE_THRESHOLD_DB) {
            consecutiveVoiceFrames = 0;
            if (speechStartFired && firstSpeechAt && lastVoiceAt) {
              const speechElapsed = now - firstSpeechAt;
              if (speechElapsed >= MIN_SPEECH_MS) {
                const silenceFor = now - lastVoiceAt;
                if (silenceFor >= SILENCE_DURATION_MS) {
                  vadStopped = true;
                  if (silenceCb) try { silenceCb(); } catch {}
                }
              }
            }
          }
          // Between thresholds: hysteresis hold zone
        }, METER_POLL_MS);
      }
    } catch (e) {
      console.warn("[voice/web] VAD setup failed:", e);
    }

    const cleanupVad = () => {
      vadStopped = true;
      if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
      try { audioCtx?.close(); } catch {}
      audioCtx = null;
      analyser = null;
    };

    return {
      stop: () =>
        new Promise((resolve) => {
          cleanupVad();
          mr.onstop = () => {
            const blob = new Blob(chunks, { type: mime });
            stream.getTracks().forEach((t) => t.stop());
            const totalMs = Date.now() - startedAt;
            if (totalMs < 500) {
              resolve(null);
              return;
            }
            resolve({
              blob,
              mime,
              filename: mime.includes("webm") ? "audio.webm" : "audio.mp4",
            });
          };
          if (mr.state !== "inactive") mr.stop();
          else {
            const blob = new Blob(chunks, { type: mime });
            stream.getTracks().forEach((t) => t.stop());
            resolve({
              blob,
              mime,
              filename: mime.includes("webm") ? "audio.webm" : "audio.mp4",
            });
          }
        }),
      cancel: async () => {
        cleanupVad();
        try { mr.stop(); } catch {}
        stream.getTracks().forEach((t) => t.stop());
      },
      onSilence: (cb) => { silenceCb = cb; },
      onSpeechStart: (cb) => { speechStartCb = cb; },
      onMeter: (cb) => { meterCb = cb; },
      pauseSilence: () => { vadPaused = true; },
      resumeSilence: () => { vadPaused = false; },
      resetSilenceState: () => {
        speechStartFired = false;
        firstSpeechAt = null;
        lastVoiceAt = null;
      },
    };
  }

  // ============ NATIVE — expo-audio with VAD ============
  try {
    await requestRecordingPermissionsAsync();
  } catch {}

  try {
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (e) {
    console.warn("[voice] setAudioModeAsync(recording) failed", e);
  }
  _nativeReady = true;

  const preset = buildHandsFreePreset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recorder: any;
  try {
    recorder = new (AudioModule as any).AudioRecorder({});
  } catch (e) {
    console.warn("[voice] AudioRecorder constructor threw:", e);
    throw e;
  }
  try {
    await recorder.prepareToRecordAsync(preset);
  } catch (e) {
    // Fallback to HIGH_QUALITY if our custom preset fails (e.g. emulator
    // quirks). VAD still works as long as metering is supported.
    console.warn("[voice] prepareToRecordAsync(custom) failed, falling back:", e);
    try {
      await recorder.prepareToRecordAsync({
        ...(RecordingPresets as any).HIGH_QUALITY,
        isMeteringEnabled: true,
      });
    } catch (e2) {
      console.warn("[voice] HIGH_QUALITY fallback also failed:", e2);
      throw e2;
    }
  }
  try {
    recorder.record();
  } catch (e) {
    console.warn("[voice] record() threw:", e);
    throw e;
  }
  const startedAt = Date.now();
  // === TIMING LOG (ChatGPT sprint giugno 2026) ===
  console.log(`[KODA_TIMING] VOICE_START 0ms`);

  // === VAD DEBUG TELEMETRIA (ChatGPT sprint giugno 2026) ===
  // Log opzionale di tutti gli step del VAD per capire perché alcune
  // registrazioni si chiudono in modo strano. Attivabile via env var
  // EXPO_PUBLIC_VAD_DEBUG=true (default ON per il debug, va spento
  // in release stabile). Log sample-throttled a 3 al secondo per non
  // saturare la console.
  const VAD_DEBUG = String(process.env.EXPO_PUBLIC_VAD_DEBUG ?? "true").toLowerCase() === "true";
  let lastDebugLogAt = 0;
  const vadLog = (label: string, extra: Record<string, any> = {}) => {
    if (!VAD_DEBUG) return;
    const now = Date.now();
    // Throttle dei `speech_refresh` (alta frequenza), gli eventi
    // discreti (speech_start / silence_detected / recording_stopped)
    // sempre.
    const isHF = label === "speech_refresh";
    if (isHF && now - lastDebugLogAt < 350) return;
    if (isHF) lastDebugLogAt = now;
    const pairs = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`[KODA_VAD] ${label} t=${now - startedAt}ms ${pairs}`);
  };

  // ===== VAD state =====
  let speechStartFired = false;
  let firstSpeechAt: number | null = null;
  let lastVoiceAt: number | null = null;
  let consecutiveVoiceFrames = 0; // anti-noise: voice must be continuous to count
  let vadStopped = false;
  let vadPaused = false;
  let speechStartCb: (() => void) | null = null;
  let silenceCb: (() => void) | null = null;
  let meterCb: ((db: number, threshold?: number | null) => void) | null = null;

  // === NOISE FLOOR ADAPTIVE (giugno 2026 v9) ===
  // Calibra il VAD sul rumore ambientale dei primi 350ms di registrazione.
  // Quando l'utente è in un ambiente rumoroso (furgone, ufficio aperto, bar),
  // il rumore continuo può superare SPEECH_THRESHOLD_DB e impedire al timer
  // di silenzio di scattare → la registrazione non finisce mai.
  //
  // Logica: nei primi N frames (≈350ms) prima che parta la voce, raccogliamo
  // i sample dB e calcoliamo il floor. Poi shiftiamo dinamicamente:
  //    speechThreshold  = max(STATIC_THRESHOLD, noise_floor + 6 dB)
  //    sustainedThreshold = max(STATIC_SUSTAINED, noise_floor + 10 dB)
  // così la voce deve essere SOPRA il rumore di fondo per contare.
  const CALIB_WINDOW_MS = 350;
  let noiseFloor: number | null = null;
  const calibSamples: number[] = [];
  let dynSpeechThreshold = SPEECH_THRESHOLD_DB;
  let dynSustainedThreshold = SUSTAINED_VOICE_DB;

  // === FAILSAFE SILENCE DETECTOR (sprint giugno 2026 v10) ===
  // ROOT CAUSE storico: in ambienti rumorosi (TV, ventilatore, riverbero
  // dello stesso speaker dell'iPhone che riproduce Koda), il db medio
  // resta sopra dynSustainedThreshold → lastVoiceAt rinfresca ad ogni
  // frame → silence_detected MAI scatta → utente deve premere bottone.
  //
  // FIX: oltre al rilevatore "tempo dall'ultima voce", introduciamo un
  // SECONDO rilevatore basato sulla DENSITÀ di voce: percentuale di frame
  // ad alta intensità (>= dynSustained) negli ultimi 2 secondi. Se sotto
  // il 30%, consideriamo che l'utente non sta più parlando "davvero" anche
  // se ci sono picchi sporadici di rumore.
  const VOICE_DENSITY_WINDOW_MS = 2000;
  const VOICE_DENSITY_MIN_PCT = 0.30;
  const FAILSAFE_AFTER_MIN_SPEECH_MS = 2500; // attivo solo dopo 2.5s di registrazione
  const recentFrames: { t: number; voice: boolean }[] = [];

  // === HEARTBEAT DIAGNOSTICO (sprint v10) ===
  // Ogni 500ms emettiamo una riga riassuntiva dello stato VAD per
  // capire ESATTAMENTE perché lastVoiceAt continua a rinfrescare in
  // ambienti dove l'hands-free non chiude.
  let lastHeartbeatAt = 0;

  // === IMPORTANT: `stopped` deve essere dichiarata PRIMA del setInterval ===
  let stopped = false;

  const vadInterval = setInterval(() => {
    if (vadStopped || vadPaused || stopped) return;
    try {
      const st = recorder.getStatus?.();
      if (!st || !st.isRecording) return;
      const db: number = typeof st.metering === "number" ? st.metering : -100;
      if (meterCb) {
        try { meterCb(db, dynSpeechThreshold); } catch {}
      }
      const now = Date.now();

      // Track recent frames for density-based failsafe.
      const isVoiceFrame = db > dynSustainedThreshold;
      recentFrames.push({ t: now, voice: isVoiceFrame });
      // Slide window: drop frames older than 2s.
      while (recentFrames.length > 0 && now - recentFrames[0].t > VOICE_DENSITY_WINDOW_MS) {
        recentFrames.shift();
      }

      // === CALIBRAZIONE NOISE FLOOR ROBUSTA (v10) ===
      // Step 1 (originale): nei primi 350ms PRIMA di speech_start.
      // Step 2 (NUOVO): se speech parte subito e non abbiamo abbastanza
      // sample, continuiamo a raccogliere fino a 1500ms — il p20 dei
      // sample include comunque le pause respiratorie e le code di parola
      // (sotto il livello di voce), che approssimano il floor.
      const CALIB_EXTENDED_MS = 1500;
      if (now - startedAt < CALIB_EXTENDED_MS) {
        if (db > -100 && db < 0) calibSamples.push(db);
      }
      // Calcola noise floor: appena disponibile (almeno 5 sample) e non
      // ancora calcolato. Funziona SIA prima che dopo speech_start.
      if (noiseFloor === null && calibSamples.length >= 5 &&
          (now - startedAt > CALIB_WINDOW_MS || (!speechStartFired && calibSamples.length >= 5))) {
        const sorted = [...calibSamples].sort((a, b) => a - b);
        // Usa il 20° percentile come stima del floor (più robusta della mediana
        // quando la finestra include già qualche frame di voce).
        const p20 = sorted[Math.max(0, Math.floor(sorted.length * 0.2))];
        noiseFloor = p20;
        dynSpeechThreshold = Math.max(SPEECH_THRESHOLD_DB, noiseFloor + 6);
        dynSustainedThreshold = Math.max(SUSTAINED_VOICE_DB, noiseFloor + 10);
        vadLog("noise_calibrated", {
          floor: noiseFloor.toFixed(1),
          speech_th: dynSpeechThreshold.toFixed(1),
          sustained_th: dynSustainedThreshold.toFixed(1),
          samples: calibSamples.length,
          phase: speechStartFired ? "post_speech" : "pre_speech",
        });
      }

      // === HEARTBEAT (ogni 500ms) — diagnostica completa ===
      if (VAD_DEBUG && now - lastHeartbeatAt >= 500) {
        lastHeartbeatAt = now;
        const voiceAge = lastVoiceAt ? (now - lastVoiceAt) : null;
        const voiceCount = recentFrames.filter(f => f.voice).length;
        const density = recentFrames.length > 0 ? voiceCount / recentFrames.length : 0;
        console.log(
          `[KODA_VAD] heartbeat t=${now - startedAt}ms db=${db.toFixed(1)} ` +
          `spk_th=${dynSpeechThreshold.toFixed(1)} sus_th=${dynSustainedThreshold.toFixed(1)} ` +
          `floor=${noiseFloor !== null ? noiseFloor.toFixed(1) : "null"} ` +
          `voice_age=${voiceAge !== null ? voiceAge + "ms" : "n/a"} ` +
          `density=${(density * 100).toFixed(0)}% ` +
          `speech_started=${speechStartFired}`
        );
      }

      // Hard cap on recording length
      if (now - startedAt > HARD_CAP_MS) {
        vadStopped = true;
        vadLog("recording_stopped", { reason: "HARD_CAP_MS", db });
        if (silenceCb) try { silenceCb(); } catch {}
        return;
      }
      if (db > dynSpeechThreshold) {
        consecutiveVoiceFrames++;
        if (consecutiveVoiceFrames >= MIN_SPEECH_FRAMES && !speechStartFired) {
          speechStartFired = true;
          firstSpeechAt = now - MIN_SPEECH_FRAMES * METER_POLL_MS;
          lastVoiceAt = now;
          vadLog("speech_start", { db, dyn_th: dynSpeechThreshold.toFixed(1) });
          if (speechStartCb) try { speechStartCb(); } catch {}
        }
        if (speechStartFired && db > dynSustainedThreshold) {
          lastVoiceAt = now;
          vadLog("speech_refresh", { db });
        }
      } else {
        if (db < SILENCE_THRESHOLD_DB) {
          // === DIAGNOSTICA FALSI POSITIVI (sprint v10) ===
          // Se avevamo accumulato qualche frame "voce" ma non abbiamo
          // raggiunto MIN_SPEECH_FRAMES → è probabilmente un click/fruscio
          // breve. Lo logghiamo per vedere quanti ne stiamo filtrando.
          if (consecutiveVoiceFrames > 0 && consecutiveVoiceFrames < MIN_SPEECH_FRAMES && !speechStartFired) {
            vadLog("false_speech_filtered", {
              frames: consecutiveVoiceFrames,
              needed: MIN_SPEECH_FRAMES,
              db,
            });
          }
          consecutiveVoiceFrames = 0;
        }
      }
      // === STOP CONDITION #1 (originale): tempo dall'ultima voce ===
      if (speechStartFired && firstSpeechAt && lastVoiceAt) {
        const speechElapsed = now - firstSpeechAt;
        if (speechElapsed >= MIN_SPEECH_MS) {
          const silenceFor = now - lastVoiceAt;
          if (silenceFor >= SILENCE_DURATION_MS) {
            vadStopped = true;
            vadLog("silence_detected", { db, silence_ms: silenceFor, reason: "last_voice_age" });
            vadLog("recording_stopped", { reason: "VAD_TIMEOUT", db });
            if (silenceCb) try { silenceCb(); } catch {}
            return;
          }
        }
      }
      // === STOP CONDITION #2 (NUOVO failsafe v10): densità voce bassa ===
      // Se l'utente ha già parlato per >2.5s E la densità di frame con
      // voce reale negli ultimi 2s è < 30%, consideriamo concluso il
      // turno anche se ci sono picchi sporadici di rumore (TV/eco/respiro
      // che impediscono al rilevatore #1 di scattare).
      if (speechStartFired && firstSpeechAt &&
          now - firstSpeechAt >= FAILSAFE_AFTER_MIN_SPEECH_MS &&
          recentFrames.length >= 20) {
        const voiceCount = recentFrames.filter(f => f.voice).length;
        const density = voiceCount / recentFrames.length;
        if (density < VOICE_DENSITY_MIN_PCT) {
          vadStopped = true;
          vadLog("silence_detected", {
            db,
            reason: "density_failsafe",
            density: (density * 100).toFixed(0) + "%",
          });
          vadLog("recording_stopped", { reason: "VAD_DENSITY_FAILSAFE", db });
          if (silenceCb) try { silenceCb(); } catch {}
          return;
        }
      }
    } catch (e) {
      // metering can briefly fail during state transitions — non-fatal
    }
  }, METER_POLL_MS);

  let capturedUri: string | null = null;
  const safeStop = async () => {
    if (stopped) return;
    stopped = true;
    vadStopped = true;
    clearInterval(vadInterval);
    // TIMING (ChatGPT sprint): la registrazione si è chiusa, qualunque
    // sia la causa (VAD, tap manuale, hard cap). VOICE_END è il
    // momento in cui smettiamo di catturare audio dal mic.
    console.log(`[KODA_TIMING] VOICE_END ${Date.now() - startedAt}ms (recording_ms=${Date.now() - startedAt})`);

    // === FIX RACE CONDITION 2026-05-25 ===
    // ROOT CAUSE: subito dopo clearInterval(), una callback già schedulata
    // nell'event loop poteva ancora eseguire — chiamando getStatus() o
    // metering() su un recorder che nel frattempo `recorder.release()`
    // aveva invalidato. Il bridge nativo iOS si appendeva indefinitamente
    // su questa chiamata orfana → JS thread bloccato → UI freezata
    // (qualsiasi tap nei modal, toggle, scroll, smetteva di rispondere).
    // L'iPhone "si ripristinava da solo" dopo 15-20 minuti perché iOS
    // media services hanno un timeout interno di esattamente quella
    // durata che libera il bridge appeso.
    //
    // FIX: aspettiamo 100ms PRIMA di toccare il recorder → l'event loop
    // ha tempo di processare clearInterval e nessuna callback orfana
    // partirà. Il flag `stopped` (controllato anche nell'interval guard
    // sopra) è la cintura di sicurezza in caso la callback fosse già
    // in-flight quando arriviamo qui.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    try {
      await recorder.stop();
    } catch (e) {
      console.warn("[voice] recorder.stop() error", e);
    }
    try {
      const statusUrl = recorder.getStatus?.()?.url || null;
      const directUri = recorder.uri || null;
      capturedUri = statusUrl || directUri;
    } catch (e) {
      console.warn("[voice] safeStop: reading uri threw:", e);
    }
    try {
      recorder.release?.();
    } catch {}
  };

  return {
    stop: async () => {
      await safeStop();
      const totalMs = Date.now() - startedAt;
      if (totalMs < 500 || !capturedUri) {
        return null;
      }
      return { uri: capturedUri, mime: "audio/m4a", filename: "audio.m4a" };
    },
    cancel: async () => {
      await safeStop();
    },
    onSilence: (cb) => { silenceCb = cb; },
    onSpeechStart: (cb) => { speechStartCb = cb; },
    onMeter: (cb) => { meterCb = cb; },
    pauseSilence: () => { vadPaused = true; },
    resumeSilence: () => { vadPaused = false; },
    resetSilenceState: () => {
      speechStartFired = false;
      firstSpeechAt = null;
      lastVoiceAt = null;
    },
  };
}

export function buildFormData(result: {
  uri?: string;
  blob?: Blob;
  mime: string;
  filename: string;
}): FormData {
  const fd = new FormData();
  fd.append("language", "it");
  if (result.blob) {
    fd.append("audio", result.blob, result.filename);
  } else if (result.uri) {
    // @ts-ignore — RN FormData accepts {uri,name,type}
    fd.append("audio", {
      uri: result.uri,
      name: result.filename,
      type: result.mime,
    });
  }
  return fd;
}

/**
 * Force-deactivate the audio session. Call this AFTER playback finishes if
 * you want iOS to release the audio focus (e.g. to let background music
 * resume). Most of the time you don't need this — setAudioModeAsync flips
 * the session automatically on the next call.
 */
export async function deactivateAudioSession(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await setIsAudioActiveAsync(false);
  } catch {}
}
