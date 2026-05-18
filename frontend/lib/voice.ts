// Voice recording — migrated to expo-audio (SDK 54).
//
// Why: expo-av's audio session on iOS leaks across record/playback transitions,
// causing the microphone to get stuck after several turns. expo-audio uses the
// new SharedObject architecture and correctly tears down the AVAudioSession on
// stop(), eliminating the "mic frozen" bug we saw with expo-av.
//
// API surface (Recorder type, startRecording, prewarmMic, buildFormData) is
// IDENTICAL to the previous expo-av version, so no consumer needs to change.
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

    return {
      stop: () =>
        new Promise((resolve) => {
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
        try { mr.stop(); } catch {}
        stream.getTracks().forEach((t) => t.stop());
      },
      onSilence: () => {},
      onSpeechStart: () => {},
      onMeter: () => {},
      pauseSilence: () => {},
      resumeSilence: () => {},
      resetSilenceState: () => {},
    };
  }

  // ============ NATIVE — expo-audio ============
  // 1. Permission (non-blocking, may already be granted).
  try {
    await requestRecordingPermissionsAsync();
  } catch {}

  // 2. Switch AVAudioSession into RECORDING mode.
  //    With expo-audio we only need ONE call (no double-toggle hack like expo-av).
  //    The SharedObject system handles session teardown correctly when stop()
  //    is called, so the mic-stuck bug from expo-av is gone.
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

  // 3. Create recorder + prepare + start.
  //    expo-audio SDK 54: the canonical imperative pattern is
  //      (a) `new AudioRecorder({})` with EMPTY options, then
  //      (b) `await recorder.prepareToRecordAsync(RecordingPresets.X)` with
  //          the preset — the prototype shim in ExpoAudio.js intercepts this
  //          call and runs `createRecordingOptions()` to flatten the nested
  //          `ios:{...}`/`android:{...}` keys before passing to native.
  //    Passing the preset to the constructor (as we did initially) silently
  //    discarded the platform-specific keys and produced a recorder that
  //    looked "ready" but never wrote a file → `recorder.uri = null`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recorder: any;
  try {
    recorder = new (AudioModule as any).AudioRecorder({});
    console.log("[voice] AudioRecorder created, id=", recorder?.id);
  } catch (e) {
    console.warn("[voice] AudioRecorder constructor threw:", e);
    throw e;
  }
  try {
    await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
    console.log(
      "[voice] prepareToRecordAsync OK, canRecord=",
      recorder.getStatus?.()?.canRecord,
    );
  } catch (e) {
    console.warn("[voice] prepareToRecordAsync failed:", e);
    throw e;
  }
  try {
    recorder.record();
    console.log("[voice] record() called, isRecording=", recorder.isRecording);
  } catch (e) {
    console.warn("[voice] record() threw:", e);
    throw e;
  }
  const startedAt = Date.now();

  let stopped = false;
  const safeStop = async () => {
    if (stopped) return;
    stopped = true;
    console.log("[voice] safeStop: pre-recorder.stop(), isRecording=", recorder.isRecording, "uri pre=", recorder.uri);
    try {
      await recorder.stop();
      console.log("[voice] safeStop: post-recorder.stop() resolved");
    } catch (e) {
      console.warn("[voice] recorder.stop() error", e);
    }
    console.log("[voice] safeStop: final uri=", recorder.uri, "isRecording=", recorder.isRecording);
    // Release the SharedObject so the AVAudioSession is cleanly torn down.
    try {
      recorder.release?.();
    } catch {}
  };

  return {
    stop: async () => {
      console.log("[voice] stop() ENTER");
      await safeStop();
      // expo-audio SDK 54: il campo URI è esposto come `url` nello status,
      // non come `uri` sulla classe (typedef ambiguo). Cerchiamo in entrambi.
      const statusUrl = recorder.getStatus?.()?.url || null;
      const directUri = recorder.uri || null;
      const uri: string | null = statusUrl || directUri;
      const totalMs = Date.now() - startedAt;
      console.log(
        `[voice] stop() → uri=${uri ? "OK" : "NULL"} (status.url=${statusUrl ? "OK" : "NULL"}, recorder.uri=${directUri ? "OK" : "NULL"}) ms=${totalMs}`,
      );
      if (totalMs < 500 || !uri) {
        return null;
      }
      // RecordingPresets.HIGH_QUALITY → AAC in .m4a container on both platforms.
      return { uri, mime: "audio/m4a", filename: "audio.m4a" };
    },
    cancel: async () => {
      await safeStop();
    },
    onSilence: () => {},
    onSpeechStart: () => {},
    onMeter: () => {},
    pauseSilence: () => {},
    resumeSilence: () => {},
    resetSilenceState: () => {},
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
