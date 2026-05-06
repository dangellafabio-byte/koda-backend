// Voice recording helpers for web + native
import { Platform } from "react-native";
import { Audio } from "expo-av";

export type Recorder = {
  stop: () => Promise<{ uri?: string; blob?: Blob; mime: string; filename: string } | null>;
  cancel: () => Promise<void>;
  /** Optional: register a callback fired when the user has been silent for ~1.2s */
  onSilence?: (cb: () => void) => void;
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    // RMS volume sampled every ~100ms; if below threshold for >1.4s after we heard speech, fire onSilence
    let silenceCb: (() => void) | null = null;
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const startedAt = Date.now();
    let lastVoiceAt = Date.now();
    let everSpoke = false;
    const SILENCE_DB_THRESHOLD = 0.025; // RMS in 0..1 — speech is usually >0.04
    const SILENCE_TIMEOUT_MS = 1400;
    const MIN_SPEECH_BEFORE_END_MS = 800;
    let silenceFired = false;

    const tickId = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      // compute RMS
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      if (rms > SILENCE_DB_THRESHOLD) {
        lastVoiceAt = Date.now();
        if (Date.now() - startedAt > 250) everSpoke = true;
      }
      if (
        !silenceFired &&
        everSpoke &&
        Date.now() - lastVoiceAt > SILENCE_TIMEOUT_MS &&
        Date.now() - startedAt > MIN_SPEECH_BEFORE_END_MS &&
        silenceCb
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
    };
  }

  // Native: use expo-av
  if (!_nativeReady) {
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    _nativeReady = true;
  }
  const rec = new Audio.Recording();
  // Enable metering for silence detection
  await rec.prepareToRecordAsync({
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  } as any);
  await rec.startAsync();

  let silenceCb: (() => void) | null = null;
  const startedAt = Date.now();
  let lastVoiceAt = Date.now();
  let everSpoke = false;
  let silenceFired = false;
  rec.setOnRecordingStatusUpdate((status) => {
    const meter = (status as any).metering;
    if (typeof meter === "number") {
      // metering values are in dB (typically -160..0). Speech > -35 dB-ish
      if (meter > -35) {
        lastVoiceAt = Date.now();
        if (Date.now() - startedAt > 250) everSpoke = true;
      }
      if (
        !silenceFired &&
        everSpoke &&
        Date.now() - lastVoiceAt > 1400 &&
        Date.now() - startedAt > 800 &&
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
