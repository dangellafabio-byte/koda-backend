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
const SPEECH_THRESHOLD_DB = -22;     // dBFS — must be reasonably loud / close to mic
const SILENCE_THRESHOLD_DB = -32;    // dBFS — silence below this (hysteresis)
const SILENCE_DURATION_MS = 800;     // 800ms silence after speech → end of utterance
const MIN_SPEECH_MS = 500;           // need at least 500ms of voice before silence can fire
const MIN_SPEECH_FRAMES = 3;         // 3 consecutive frames (~210ms) above threshold → real speech
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

  const vadInterval = setInterval(() => {
    if (vadStopped || vadPaused) return;
    try {
      const st = recorder.getStatus?.();
      if (!st || !st.isRecording) return;
      const db: number = typeof st.metering === "number" ? st.metering : -100;
      if (meterCb) {
        try { meterCb(db, SPEECH_THRESHOLD_DB); } catch {}
      }
      const now = Date.now();
      // Hard cap on recording length
      if (now - startedAt > HARD_CAP_MS) {
        vadStopped = true;
        if (silenceCb) try { silenceCb(); } catch {}
        return;
      }
      if (db > SPEECH_THRESHOLD_DB) {
        consecutiveVoiceFrames++;
        // Only mark "speech started" after enough consecutive voice frames.
        // This kills false positives from TV / brief background noises.
        if (consecutiveVoiceFrames >= MIN_SPEECH_FRAMES && !speechStartFired) {
          speechStartFired = true;
          firstSpeechAt = now - MIN_SPEECH_FRAMES * METER_POLL_MS;
          if (speechStartCb) try { speechStartCb(); } catch {}
        }
        if (speechStartFired) lastVoiceAt = now;
      } else if (db < SILENCE_THRESHOLD_DB) {
        // Reset the streak only if we're decisively below silence threshold.
        // This hysteresis prevents flickering around the threshold from
        // resetting the counter mid-word.
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
      // Between thresholds: hold state (hysteresis zone) — don't change anything.
    } catch (e) {
      // metering can briefly fail during state transitions — non-fatal
    }
  }, METER_POLL_MS);

  let stopped = false;
  let capturedUri: string | null = null;
  const safeStop = async () => {
    if (stopped) return;
    stopped = true;
    vadStopped = true;
    clearInterval(vadInterval);
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
