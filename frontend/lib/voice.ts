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
const SPEECH_THRESHOLD_DB = -32;     // dBFS — bassa per INIZIARE detection voce
const SUSTAINED_VOICE_DB = -26;      // dBFS — alta per RINFRESCARE lastVoiceAt
const SILENCE_THRESHOLD_DB = -42;    // dBFS — hysteresis 10 dB
const SILENCE_DURATION_MS = 1500;    // 1.5s silence after speech → end of utterance
const MIN_SPEECH_MS = 700;           // need at least 700ms of voice before silence can fire
const MIN_SPEECH_FRAMES = 3;         // 3 consecutive frames (~210ms) above threshold → real speech
const METER_POLL_MS = 70;            // ~14Hz sampling
const HARD_CAP_MS = 60_000;          // absolute max recording length

// ============ CAPPED ADAPTIVE VAD (Fix #1 — 2026-06) ============
// Problema osservato in produzione (log utente, furgone):
//   - silenzio reale: -45 / -50 dBFS
//   - rumore furgone: -25 / -32 dBFS (PIÙ ALTO della SILENCE_THRESHOLD_DB statica)
//   - voce utente: -20 / -10 dBFS
// → Con soglie statiche, il VAD vede SEMPRE "non-silenzio" in furgone e
//   non chiude mai la registrazione (recording_ms 11+ secondi → fail).
//
// Soluzione (basata sui dati di log, NON intuitiva):
//   1) Per i primi CALIBRATION_MS della registrazione, raccogliamo il dB
//      ambientale (mediana, robusta a piccoli picchi).
//   2) Se mediana > ADAPTIVE_TRIGGER_DB (-38) → ambiente rumoroso →
//      attiviamo soglie adattive.
//      silenceThreshold = min(floor + 6dB, ADAPTIVE_CAP_SILENCE_DB).
//      Il cap garantisce che la soglia NON salga MAI sopra il livello
//      della voce umana media (-28 dBFS).
//   3) Se mediana ≤ -38 → ambiente silenzioso → soglie statiche (lo
//      stato attuale, verificato funzionante).
//   4) Safety: se mediana > -20 dBFS (probabilmente l'utente sta già
//      parlando durante la calibrazione) → fallback su statiche, non
//      ci fidiamo della misura.
const CALIBRATION_MS = 400;              // primi 400ms = solo misura noise floor
const ADAPTIVE_TRIGGER_DB = -38;         // floor > -38 → attiva adattivo
const ADAPTIVE_SAFETY_ABORT_DB = -20;    // floor > -20 → utente sta parlando, NON usare adattivo
const ADAPTIVE_OFFSET_DB = 6;            // silence = floor + 6dB
const ADAPTIVE_CAP_SILENCE_DB = -28;     // mai sopra -28 (voce umana media)
const ADAPTIVE_HYSTERESIS_DB = 4;        // speech = silence - 4dB
const ADAPTIVE_CAP_SUSTAINED_DB = -22;   // sustained mai sopra -22

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
      // === FIX 2026-06: bug Android metering "-100 dB sempre" ===
      // Su Android, `recorder.getStatus().metering` restituiva sempre -100
      // perché il flag isMeteringEnabled DEVE essere dentro il preset
      // `android: {}` (non basta a livello root). Senza questo, il VAD
      // hands-free era completamente rotto su Android.
      isMeteringEnabled: true,
      // === FIX 2026-06-21 v10 (Fabio escalation Voice Processing) ===
      // `audioSource: "voice_communication"` → MediaRecorder.AudioSource.
      // VOICE_COMMUNICATION (l'API che Google Meet/WhatsApp/Telegram usano
      // per le chiamate). Attiva i filtri DSP del dispositivo:
      //   - Acoustic Echo Cancellation (AEC)
      //   - Noise Suppression (NS) → motore furgone, vento, traffico
      //   - Automatic Gain Control (AGC) → sussurri amplificati
      // Questi filtri girano sul chip audio del telefono (~0 latenza, 0
      // costo CPU). Equivalente Android del Voice Processing iOS.
      // Doc expo-audio confirms: "It will take advantage of echo
      // cancellation or automatic gain control if available."
      audioSource: "voice_communication",
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

  // ===== CAPPED ADAPTIVE VAD state (Fix #1 — 2026-06) =====
  // Soglie effettive (verranno aggiornate dopo calibrazione se serve).
  let speechThresholdEff = SPEECH_THRESHOLD_DB;
  let silenceThresholdEff = SILENCE_THRESHOLD_DB;
  let sustainedThresholdEff = SUSTAINED_VOICE_DB;
  // Buffer di calibrazione: dB raccolti nei primi CALIBRATION_MS.
  const calibrationSamples: number[] = [];
  let calibrationDone = false;

  // === IMPORTANT: `stopped` deve essere dichiarata PRIMA del setInterval
  // perché il guard sotto la controlla (insieme a vadStopped/vadPaused).
  // Senza, una callback orfana già schedulata può eseguire dopo
  // recorder.release() e bloccare il JS thread sul bridge nativo iOS.
  // Vedi root cause analysis nel safeStop() più sotto. ===
  let stopped = false;

  const vadInterval = setInterval(() => {
    if (vadStopped || vadPaused || stopped) return;
    try {
      const st = recorder.getStatus?.();
      if (!st || !st.isRecording) return;
      const db: number = typeof st.metering === "number" ? st.metering : -100;
      if (meterCb) {
        try { meterCb(db, speechThresholdEff); } catch {}
      }
      const now = Date.now();
      // Hard cap on recording length
      if (now - startedAt > HARD_CAP_MS) {
        vadStopped = true;
        if (silenceCb) try { silenceCb(); } catch {}
        return;
      }

      // ============ CALIBRATION PHASE (Fix #1) ============
      // Per i primi CALIBRATION_MS misuriamo il livello ambientale.
      // Durante questa finestra il VAD NON considera ancora "speech start"
      // — vogliamo prima sapere quanto è rumoroso l'ambiente.
      if (!calibrationDone) {
        const elapsed = now - startedAt;
        // Filtro: scarta sample fuori range (metering glitch / saturazione voce)
        if (db > -90 && db < -5) {
          calibrationSamples.push(db);
        }
        if (elapsed >= CALIBRATION_MS) {
          calibrationDone = true;
          // Mediana = robusta a singoli picchi (es. tosse, click)
          let noiseFloor: number;
          if (calibrationSamples.length >= 3) {
            const sorted = [...calibrationSamples].sort((a, b) => a - b);
            noiseFloor = sorted[Math.floor(sorted.length / 2)];
          } else {
            noiseFloor = -50; // pochi sample → assume silenzio
          }
          if (noiseFloor > ADAPTIVE_SAFETY_ABORT_DB) {
            // Troppo rumoroso: probabilmente utente STA GIÀ parlando.
            // Non ci fidiamo della misura → usa statiche (baseline noto).
            adaptiveMode = false;
            console.log(`[VAD_CALIB] floor=${noiseFloor.toFixed(1)}dB n=${calibrationSamples.length} mode=static-safety-abort speech=${speechThresholdEff} silence=${silenceThresholdEff} sustained=${sustainedThresholdEff}`);
          } else if (noiseFloor > ADAPTIVE_TRIGGER_DB) {
            // Ambiente rumoroso (es. furgone, auto, traffico): attiva adattivo.
            adaptiveMode = true;
            silenceThresholdEff = Math.min(noiseFloor + ADAPTIVE_OFFSET_DB, ADAPTIVE_CAP_SILENCE_DB);
            speechThresholdEff = silenceThresholdEff - ADAPTIVE_HYSTERESIS_DB;
            sustainedThresholdEff = Math.min(silenceThresholdEff + ADAPTIVE_HYSTERESIS_DB, ADAPTIVE_CAP_SUSTAINED_DB);
            console.log(`[VAD_CALIB] floor=${noiseFloor.toFixed(1)}dB n=${calibrationSamples.length} mode=adaptive speech=${speechThresholdEff} silence=${silenceThresholdEff} sustained=${sustainedThresholdEff}`);
          } else {
            // Ambiente silenzioso (-38 dBFS o inferiore): le statiche funzionano.
            adaptiveMode = false;
            console.log(`[VAD_CALIB] floor=${noiseFloor.toFixed(1)}dB n=${calibrationSamples.length} mode=static-quiet speech=${speechThresholdEff} silence=${silenceThresholdEff} sustained=${sustainedThresholdEff}`);
          }
        }
        // Durante calibration, non avviare la macchina a stati voce/silenzio
        return;
      }

      // ============ NORMAL VAD (post-calibration) ============
      if (db > speechThresholdEff) {
        consecutiveVoiceFrames++;
        // Only mark "speech started" after enough consecutive voice frames.
        // This kills false positives from TV / brief background noises.
        if (consecutiveVoiceFrames >= MIN_SPEECH_FRAMES && !speechStartFired) {
          speechStartFired = true;
          firstSpeechAt = now - MIN_SPEECH_FRAMES * METER_POLL_MS;
          lastVoiceAt = now;  // init at speech start
          if (speechStartCb) try { speechStartCb(); } catch {}
        }
        // Rinfresca lastVoiceAt SOLO se la voce è chiaramente sopra
        // l'ambiente (db > sustainedThresholdEff). In adattivo questo è
        // calcolato dinamicamente; il rumore di fondo non tiene più
        // viva la registrazione → il timer di silenzio può partire.
        if (speechStartFired && db > sustainedThresholdEff) {
          lastVoiceAt = now;
        }
      } else {
        // === SILENCE/HYSTERESIS DETECTION ===
        // "non-voce" = sotto speechThresholdEff. Conta silenzio basandosi
        // su tempo trascorso da ultima voce, non su secondo threshold
        // artificiale. silenceThresholdEff resta solo per reset più
        // aggressivo del contatore frame.
        if (db < silenceThresholdEff) {
          consecutiveVoiceFrames = 0;
        }
      }
      // Il check del silenzio è FUORI dall'if/else. Gira ad ogni frame
      // e si basa solo su quanto è vecchio lastVoiceAt. Anche se nel
      // frame corrente c'è un picco di rumore (tosse, click, ronzio),
      // il tempo trascorso dall'ultima VOCE REALE continua a crescere
      // → il silenzio scatta correttamente.
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
