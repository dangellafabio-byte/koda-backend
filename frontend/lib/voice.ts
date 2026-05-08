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
  onMeter?: (cb: (dbValue: number) => void) => void;
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
    // Lower threshold for better barge-in sensitivity, especially when AI
    // TTS is also playing (browser AEC reduces the playback signal coming
    // back through the mic — but we still need to detect quieter user speech).
    const SILENCE_DB_THRESHOLD = 0.008;   // very tolerant — picks up quieter speech
    const SILENCE_TIMEOUT_MS = 2200;      // tolerates natural mid-sentence pauses
    const MIN_SPEECH_BEFORE_END_MS = 500;
    const MAX_RECORDING_MS = 60000;       // safety: 60s per turn (long thoughts ok)
    const NO_SPEECH_FALLBACK_MS = 12000;  // if no speech detected at all in 12s,
                                          // force stop (analyser may be broken)
    let speechStartFired = false;
    let silenceFired = false;
    let maxRmsSeen = 0;
    let silencePaused = false;

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
      if (rms > SILENCE_DB_THRESHOLD) {
        lastVoiceAt = Date.now();
        if (Date.now() - startedAt > 150) {
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
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
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
  rec.setOnRecordingStatusUpdate((status) => {
    const meter = (status as any).metering;
    if (typeof meter === "number") {
      // Expose live meter value to caller for debug visualization
      if (meterCb) {
        try { meterCb(meter); } catch {}
      }
      // Two-tier thresholds — tuned for reliable hands-free conversation:
      // - SPEECH_START_DB (-55): very sensitive, detects first whisper to mark
      //   "the user is talking" (so we know to expect a silence-end later).
      // - VOICE_PRESENT_DB (-40): STRICT. Only clearly-audible voice updates
      //   `lastVoiceAt`. Ambient room hum, fan noise, distant TV — all below
      //   -40dB — do NOT keep the recording alive. This is the key to making
      //   silence fire reliably when the user actually stops speaking.
      const SPEECH_START_DB = -55;
      const VOICE_PRESENT_DB = -40;

      if (meter > SPEECH_START_DB && Date.now() - startedAt > 250) {
        if (!everSpoke) {
          everSpoke = true;
          if (!speechStartFired && speechStartCb) {
            speechStartFired = true;
            try { speechStartCb(); } catch {}
          }
        }
      }
      // Update lastVoiceAt only when the meter is loud enough to be REAL speech
      // (not just background noise), so the silence timer can elapse correctly.
      if (meter > VOICE_PRESENT_DB) {
        lastVoiceAt = Date.now();
      }
      // Don't fire silence-end while paused (used during AI TTS playback).
      if (silencePaused) return;
      if (
        !silenceFired &&
        ((everSpoke &&
          Date.now() - lastVoiceAt > 1200 &&
          Date.now() - startedAt > 600) ||
          // Fallback: if no speech ever detected after 10s, force-stop anyway
          (!everSpoke && Date.now() - startedAt > 10000) ||
          // Hard cap: 45s — generous but not infinite
          Date.now() - startedAt > 45000) &&
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
