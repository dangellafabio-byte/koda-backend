// Voice recording helpers for web + native
import { Platform } from "react-native";
import { Audio } from "expo-av";

export type Recorder = {
  stop: () => Promise<{ uri?: string; blob?: Blob; mime: string; filename: string } | null>;
  cancel: () => Promise<void>;
  /** Optional: register a callback fired when the user has been silent for ~1.5s after speaking */
  onSilence?: (cb: () => void) => void;
  /** Optional: register a callback fired the first time the user actually speaks (barge-in interrupt) */
  onSpeechStart?: (cb: () => void) => void;
  /** Optional: live meter callback (raw dB value, typically -160..0). For debug visualization. */
  onMeter?: (cb: (dbValue: number, voicePresentDb?: number | null) => void) => void;
  /** Pause silence-end detection (still records, still fires onSpeechStart). Used during AI TTS. */
  pauseSilence?: () => void;
  /** Resume silence-end detection. */
  resumeSilence?: () => void;
  /** Reset everSpoke + lastVoiceAt → "now". Use after TTS ends so the user's turn starts fresh. */
  resetSilenceState?: () => void;
};

let _webPermissionAsked = false;
let _nativeReady = false;

/**
 * Pre-warm microphone permission so the first real tap goes straight to recording.
 * Call once after onboarding / app load.
 */
export async function prewarmMic(): Promise<boolean> {
  try {
    if (Platform.OS === "web") {
      // Touch the API to trigger permission prompt early, then immediately stop tracks
      if (_webPermissionAsked) return true;
      _webPermissionAsked = true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    }
    // Native
    if (_nativeReady) return true;
    const perm = await Audio.requestPermissionsAsync();
    if (perm.status !== "granted") return false;
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    _nativeReady = true;
    return true;
  } catch {
    return false;
  }
}

export async function startRecording(): Promise<Recorder> {
  if (Platform.OS === "web") {
    // Web: use MediaRecorder + AnalyserNode for silence detection
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

    // ===== Silence detection =====
    // RMS volume sampled every ~90ms; if below threshold for >1.6s after we heard speech, fire onSilence
    let silenceCb: (() => void) | null = null;
    let speechStartCb: (() => void) | null = null;
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // CRITICAL: AudioContext may be 'suspended' if the page is creating it
    // outside a fresh user gesture (common when starting recording while AI
    // TTS is playing — the AudioContext.state is 'suspended' and the analyser
    // gives no readings, which silently kills barge-in detection).
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const startedAt = Date.now();
    let lastVoiceAt = Date.now();
    let everSpoke = false;
    // Higher threshold = meno falsi positivi su respiri/sussurri/rumore di
    // tastiera. L'utente deve parlare con voce CHIARA (non sussurrata).
    const SILENCE_DB_THRESHOLD = 0.025;   // alza la soglia: era 0.008 (troppo sensibile)
    const SILENCE_TIMEOUT_MS = 1600;      // chiusura turno più rapida
    const MIN_SPEECH_BEFORE_END_MS = 500;
    const MAX_RECORDING_MS = 60000;       // safety: 60s per turn (long thoughts ok)
    const NO_SPEECH_FALLBACK_MS = 8000;   // se nessuna voce in 8s, chiudi
    const MIN_CUMULATIVE_VOICE_MS = 500;  // serve almeno 500ms cumulativi di voce
    let speechStartFired = false;
    let silenceFired = false;
    let maxRmsSeen = 0;
    let silencePaused = false;
    let cumulativeVoiceMs = 0;
    let lastTickAt = Date.now();

    const tickId = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      // compute RMS
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      if (rms > maxRmsSeen) maxRmsSeen = rms;
      const nowT = Date.now();
      const delta = Math.min(200, nowT - lastTickAt);
      lastTickAt = nowT;
      if (rms > SILENCE_DB_THRESHOLD) {
        cumulativeVoiceMs += delta;
        lastVoiceAt = nowT;
        if (nowT - startedAt > 200 && cumulativeVoiceMs >= MIN_CUMULATIVE_VOICE_MS) {
          everSpoke = true;
          if (!speechStartFired && speechStartCb) {
            speechStartFired = true;
            try { speechStartCb(); } catch {}
          }
        }
      }
      // Don't fire silence-end while paused (used during AI TTS playback).
      if (silencePaused) return;
      const elapsed = Date.now() - startedAt;
      // Auto-stop conditions:
      // 1. Heard speech AND silence for SILENCE_TIMEOUT_MS → normal end of turn
      // 2. NO speech detected at all after NO_SPEECH_FALLBACK_MS → analyser
      //    likely broken (Safari AudioContext issues), force stop with whatever
      //    audio we captured so the user doesn't hang forever
      // 3. Hard cap MAX_RECORDING_MS → safety
      if (
        !silenceFired &&
        silenceCb &&
        ((everSpoke &&
          Date.now() - lastVoiceAt > SILENCE_TIMEOUT_MS &&
          elapsed > MIN_SPEECH_BEFORE_END_MS) ||
          (!everSpoke && elapsed > NO_SPEECH_FALLBACK_MS) ||
          elapsed > MAX_RECORDING_MS)
      ) {
        silenceFired = true;
        try { silenceCb(); } catch {}
      }
    }, 90);

    return {
      stop: () =>
        new Promise((resolve) => {
          mr.onstop = () => {
            const blob = new Blob(chunks, { type: mime });
            stream.getTracks().forEach((t) => t.stop());
            try { clearInterval(tickId); audioCtx.close().catch(() => {}); } catch {}
            // GUARDIA: se l'utente non ha mai parlato chiaramente, non
            // inviamo audio al server (eviterà allucinazioni Whisper su
            // breath/clic/silenzio).
            const totalMs = Date.now() - startedAt;
            if (totalMs < 700 || !everSpoke || cumulativeVoiceMs < MIN_CUMULATIVE_VOICE_MS) {
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
            try { clearInterval(tickId); audioCtx.close().catch(() => {}); } catch {}
            resolve({
              blob,
              mime,
              filename: mime.includes("webm") ? "audio.webm" : "audio.mp4",
            });
          }
        }),
      cancel: async () => {
        try { mr.stop(); } catch {}
        stream.getTracks().forEach((t) => t.stop());
        try { clearInterval(tickId); audioCtx.close().catch(() => {}); } catch {}
      },
      onSilence: (cb) => {
        silenceCb = cb;
      },
      onSpeechStart: (cb) => {
        speechStartCb = cb;
      },
      pauseSilence: () => {
        silencePaused = true;
      },
      resumeSilence: () => {
        silencePaused = false;
      },
      resetSilenceState: () => {
        lastVoiceAt = Date.now();
        everSpoke = false;
        silenceFired = false;
        speechStartFired = false;
      },
    };
  }

  // Native: use expo-av
  // CRITICAL: always re-apply the recording-friendly audio mode here.
  // After playing TTS (ElevenLabs preview / AI reply), the audio mode is
  // switched to `playback` (allowsRecordingIOS: false). If we didn't reset
  // it here, the next mic tap would fail with "Microfono non disponibile".
  try {
    await Audio.requestPermissionsAsync();
  } catch {}
  try {
    // CRITICAL CLEANUP: stop and unload any leftover Audio.Sound from a
    // previous TTS playback. Without this, on iOS the audio session can
    // remain in playAndRecord mode with a stale Sound object holding it,
    // causing the next `new Audio.Recording()` to silently fail or hang.
    // We can't directly access the speech module's currentSound from here
    // (circular import), but Audio.setAudioModeAsync with allowsRecordingIOS
    // forces the session category switch which implicitly invalidates
    // any non-mixing playback.
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    // Small delay so iOS' AVAudioSession can apply the new category before
    // we instantiate the Recording. Empirically 80ms is enough; 120ms is safe.
    await new Promise((r) => setTimeout(r, 120));
  } catch {}
  _nativeReady = true;
  const rec = new Audio.Recording();
  // Enable metering for silence detection
  await rec.prepareToRecordAsync({
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  } as any);
  await rec.startAsync();

  let silenceCb: (() => void) | null = null;
  let speechStartCb: (() => void) | null = null;
  let meterCb: ((dbValue: number) => void) | null = null;
  const startedAt = Date.now();
  let lastVoiceAt = Date.now();
  let everSpoke = false;
  let silenceFired = false;
  let speechStartFired = false;
  let silencePaused = false;

  // === APPROCCIO PERMISSIVO (v3): facciamo decidere Whisper ===
  //
  // ABBANDONATO il VAD aggressivo (mediana + burst + cumulative) che escludeva
  // troppa voce reale in ambienti rumorosi. Whisper è MOLTO più robusto al
  // rumore di qualsiasi nostra euristica a soglia. Quindi:
  //
  //  1. Calibriamo l'ambient nei primi 600ms (più rapido)
  //  2. Soglia ULTRA-PERMISSIVA: ambient + 5 dB (era +10), floor -42 (era -32)
  //  3. Niente burst detection (causava troppi falsi positivi su click/tap)
  //  4. Niente cumulative voice requirement (50ms di voce = "ha parlato")
  //  5. Manteniamo il silence detector ma con timeout più lunghi (1500ms)
  //  6. **Mandiamo SEMPRE l'audio a Whisper** se la registrazione è ≥1s
  //     → Whisper decide se c'è speech reale; se non c'è, ritorna stringa vuota
  //     o allucinazione → il classifier client la cattura comunque
  //
  // Questo elimina i "non ti ho sentito" quando in realtà avevi parlato ma
  // sotto la soglia per via del rumore di fondo.
  const CALIBRATION_MS = 600;
  const noiseSamples: number[] = [];
  let dynamicVoicePresentDb: number | null = null;

  rec.setOnRecordingStatusUpdate((status) => {
    const meter = (status as any).metering;
    if (typeof meter === "number") {
      if (meterCb) {
        try { meterCb(meter, dynamicVoicePresentDb); } catch {}
      }
      const elapsed = Date.now() - startedAt;
      // Phase 1: collect ambient noise samples
      if (elapsed < CALIBRATION_MS) {
        noiseSamples.push(meter);
        return;
      }
      // Compute dynamic threshold once at end of calibration
      if (dynamicVoicePresentDb === null) {
        const sorted = [...noiseSamples].sort((a, b) => a - b);
        const m = Math.floor(sorted.length / 2);
        const ambient = sorted.length ? (sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : -50;
        // Threshold ULTRA-PERMISSIVO: ambient + 5 dB. Floor -42, cap -15.
        dynamicVoicePresentDb = Math.max(-42, Math.min(-15, ambient + 5));
      }
      const VOICE_PRESENT_DB = dynamicVoicePresentDb;

      if (meter > VOICE_PRESENT_DB) {
        lastVoiceAt = Date.now();
        if (elapsed > 200) {
          if (!everSpoke) {
            everSpoke = true;
            if (!speechStartFired && speechStartCb) {
              speechStartFired = true;
              try { speechStartCb(); } catch {}
            }
          }
        }
      }
      if (silencePaused) return;
      // Silence timeouts più TOLLERANTI: 1500ms dopo voce (era 900),
      // 12s prima del primo speech (era 8s), 60s massimo (era 45s).
      if (
        !silenceFired &&
        ((everSpoke &&
          Date.now() - lastVoiceAt > 1500 &&
          elapsed > 1000) ||
          (!everSpoke && elapsed > 12000) ||
          elapsed > 60000) &&
        silenceCb
      ) {
        silenceFired = true;
        try { silenceCb(); } catch {}
      }
    }
  });
  return {
    stop: async () => {
      try { await rec.stopAndUnloadAsync(); } catch {}
      const uri = rec.getURI() || undefined;
      // GUARDIA MINIMALE: scartiamo SOLO se la registrazione è troppo
      // breve (<800ms). Tutto il resto passa a Whisper — che decide
      // molto meglio di noi se c'è davvero voce.
      const totalMs = Date.now() - startedAt;
      if (totalMs < 800) {
        return null;
      }
      return { uri, mime: "audio/m4a", filename: "audio.m4a" };
    },
    cancel: async () => {
      try { await rec.stopAndUnloadAsync(); } catch {}
    },
    onSilence: (cb) => {
      silenceCb = cb;
    },
    onSpeechStart: (cb) => {
      speechStartCb = cb;
    },
    onMeter: (cb) => {
      meterCb = cb;
    },
    pauseSilence: () => {
      silencePaused = true;
    },
    resumeSilence: () => {
      silencePaused = false;
    },
    resetSilenceState: () => {
      lastVoiceAt = Date.now();
      everSpoke = false;
      silenceFired = false;
      speechStartFired = false;
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
    // React Native file upload
    // @ts-ignore
    fd.append("audio", {
      uri: result.uri,
      name: result.filename,
      type: result.mime,
    });
  }
  return fd;
}
