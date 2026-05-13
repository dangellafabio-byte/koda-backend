// Voice recording — minimal & robust (TAP-TO-TALK MODEL)
//
// PHILOSOPHY: nessun VAD client-side, nessun "smart silence detection".
// L'utente preme per parlare e ripreme per inviare. Modello WhatsApp.
// Questo elimina TUTTA la categoria di bug di "metering undefined",
// "soglia ambient sbagliata", "stuck recording".
//
// Eventualmente, in futuro, l'hands-free vero arriverà tramite Deepgram
// streaming server-side. Ma per ora: semplicità = affidabilità.
import { Platform } from "react-native";
import { Audio } from "expo-av";

export type Recorder = {
  stop: () => Promise<{ uri?: string; blob?: Blob; mime: string; filename: string } | null>;
  cancel: () => Promise<void>;
  /** Deprecated stubs — mantenuti per compat con index.tsx, ma no-op. */
  onSilence?: (cb: () => void) => void;
  onSpeechStart?: (cb: () => void) => void;
  onMeter?: (cb: (dbValue: number, voicePresentDb?: number | null) => void) => void;
  pauseSilence?: () => void;
  resumeSilence?: () => void;
  resetSilenceState?: () => void;
};

let _webPermissionAsked = false;
let _nativeReady = false;

/** Pre-warm microphone permission (chiamato all'avvio app). */
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
            // Solo guardia: scartiamo registrazioni <500ms (tap accidentale).
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
      // No-op stubs per compat
      onSilence: () => {},
      onSpeechStart: () => {},
      onMeter: () => {},
      pauseSilence: () => {},
      resumeSilence: () => {},
      resetSilenceState: () => {},
    };
  }

  // ============ NATIVE (iOS/Android) ============
  try {
    await Audio.requestPermissionsAsync();
  } catch {}

  // DOPPIA commutazione audio session per forzare iOS a rilasciare
  // qualunque sessione playback wedged dal turno precedente.
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    await new Promise((r) => setTimeout(r, 80));
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    await new Promise((r) => setTimeout(r, 150));
  } catch {}
  _nativeReady = true;

  const rec = new Audio.Recording();
  await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
  await rec.startAsync();
  const startedAt = Date.now();

  return {
    stop: async () => {
      let unloaded = false;
      try {
        await rec.stopAndUnloadAsync();
        unloaded = true;
      } catch {}
      // Se l'unload fallisce, forziamo comunque la commutazione a playback.
      if (!unloaded) {
        try {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: false,
            playsInSilentModeIOS: true,
            staysActiveInBackground: false,
            shouldDuckAndroid: true,
            playThroughEarpieceAndroid: false,
          });
        } catch {}
      }
      const uri = rec.getURI() || undefined;
      const totalMs = Date.now() - startedAt;
      // Tap accidentale (<500ms) → scartiamo.
      if (totalMs < 500) {
        return null;
      }
      return { uri, mime: "audio/m4a", filename: "audio.m4a" };
    },
    cancel: async () => {
      try { await rec.stopAndUnloadAsync(); } catch {}
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });
      } catch {}
    },
    // No-op stubs per compatibilità con index.tsx esistente
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
    // @ts-ignore
    fd.append("audio", {
      uri: result.uri,
      name: result.filename,
      type: result.mime,
    });
  }
  return fd;
}
