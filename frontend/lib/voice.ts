// Voice recording helpers for web + native
import { Platform } from "react-native";
import { Audio } from "expo-av";

export type Recorder = {
  stop: () => Promise<{ uri?: string; blob?: Blob; mime: string; filename: string } | null>;
  cancel: () => Promise<void>;
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
    // Web: use MediaRecorder
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

    return {
      stop: () =>
        new Promise((resolve) => {
          mr.onstop = () => {
            const blob = new Blob(chunks, { type: mime });
            stream.getTracks().forEach((t) => t.stop());
            resolve({
              blob,
              mime,
              filename: mime.includes("webm") ? "audio.webm" : "audio.mp4",
            });
          };
          mr.stop();
        }),
      cancel: async () => {
        try {
          mr.stop();
        } catch {}
        stream.getTracks().forEach((t) => t.stop());
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
  await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
  await rec.startAsync();
  return {
    stop: async () => {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI() || undefined;
      return { uri, mime: "audio/m4a", filename: "audio.m4a" };
    },
    cancel: async () => {
      try {
        await rec.stopAndUnloadAsync();
      } catch {}
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
