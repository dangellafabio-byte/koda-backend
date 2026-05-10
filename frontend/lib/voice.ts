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

  // === ADAPTIVE NOISE CALIBRATION ===
  // For the first 800ms we sample ambient noise to set a DYNAMIC voice
  // threshold = noise_floor (90th percentile) + 18 dB margin.
  // The 18dB margin (was 12) means the user's voice (close to mic) MUST be
  // CLEARLY louder than ambient sources (TV, fan, distant chatter, breathing).
  // Plus we ENFORCE a hard floor at -28dB → even in a perfectly silent room
  // the threshold won't drop below -28dB, so whispers / breath / tiny pops
  // won't trigger recording.
  // - quiet box (-65dB ambient → threshold -28 forzato dal floor)
  //   normal room (-50dB ambient → threshold -32)
  //   TV at 1.5m (-40dB ambient → threshold -22)
  //   loud cafe (-30dB ambient → threshold -12)
  const CALIBRATION_MS = 800;
  const noiseSamples: number[] = [];
  let dynamicVoicePresentDb: number | null = null;
  // Per evitare di chiudere il turno per micro-tagli, conteggiamo solo lo
  // speech "consistente": almeno 500ms cumulativi di voce sopra soglia.
  let cumulativeVoiceMs = 0;
  let lastTickAt = Date.now();

  rec.setOnRecordingStatusUpdate((status) => {
    const meter = (status as any).metering;
    if (typeof meter === "number") {
      if (meterCb) {
        try { meterCb(meter, dynamicVoicePresentDb); } catch {}
      }
      const elapsed = Date.now() - startedAt;
      // Phase 1: collect ambient noise samples without triggering anything
      if (elapsed < CALIBRATION_MS) {
        noiseSamples.push(meter);
        return;
      }
      // Compute dynamic threshold once at end of calibration
      if (dynamicVoicePresentDb === null) {
        const sorted = [...noiseSamples].sort((a, b) => a - b);
        // 90th percentile of samples = ambient floor (catches most TV peaks)
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9)));
        const ambient = sorted[idx] ?? -45;
        // Threshold = ambient + 18 dB (was 12), but NEVER below -28 dB.
        // Il floor -28 garantisce che in stanze silenziose il sistema NON
        // si attivi su sussurri / respiri / clic. È più stringente, ma
        // l'utente vuole che parli normalmente, non sussurrando.
        // Clamped to safe range [-28, -10].
        dynamicVoicePresentDb = Math.max(-28, Math.min(-10, ambient + 18));
      }
      const VOICE_PRESENT_DB = dynamicVoicePresentDb;
      // SPEECH_START sopra VOICE_PRESENT (richiede voce CHIARA per iniziare
      // a registrare, non più "primo sussurro" che catturava breath / pop).
      const SPEECH_START_DB = VOICE_PRESENT_DB + 2;

      // Aggiorna tempo cumulativo di voce sopra soglia. Ci serve per non
      // accettare un singolo picco rumoroso come "ha parlato" — pretendiamo
      // almeno 500ms di voce continua (cumulativa) sopra threshold.
      const now = Date.now();
      const delta = Math.min(200, now - lastTickAt);
      lastTickAt = now;
      if (meter > VOICE_PRESENT_DB) {
        cumulativeVoiceMs += delta;
      }

      if (meter > SPEECH_START_DB && elapsed > 250 && cumulativeVoiceMs >= 500) {
        if (!everSpoke) {
          everSpoke = true;
          if (!speechStartFired && speechStartCb) {
            speechStartFired = true;
            try { speechStartCb(); } catch {}
          }
        }
      }
      if (meter > VOICE_PRESENT_DB) {
        lastVoiceAt = Date.now();
      }
      if (silencePaused) return;
      if (
        !silenceFired &&
        ((everSpoke &&
          Date.now() - lastVoiceAt > 900 &&
          elapsed > 800) ||
          (!everSpoke && elapsed > 8000) ||
          elapsed > 45000) &&
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
      // GUARDIA FINALE: se la registrazione è troppo corta o l'utente non ha
      // MAI superato la soglia di voce continua, NON inviamo audio fittizio
      // al server. Ritorniamo null così il chiamante mostra "non ho sentito".
      const totalMs = Date.now() - startedAt;
      if (totalMs < 700 || !everSpoke || cumulativeVoiceMs < 500) {
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
