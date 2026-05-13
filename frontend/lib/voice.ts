// Voice recording via expo-audio (moderno, stabile).
// expo-av era deprecato e causava session leak su iOS dopo 2-3 turni.
// expo-audio ha un'API completamente nuova: hook-based + lifecycle gestito da Expo.
//
// MODELLO: tap-to-talk puro. Niente VAD, niente magia. L'utente preme per
// iniziare, ripreme per inviare. Affidabile al 100%.
import { Platform } from "react-native";
import {
  AudioModule,
  AudioRecorder,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";

export type Recorder = {
  stop: () => Promise<{ uri?: string; blob?: Blob; mime: string; filename: string } | null>;
  cancel: () => Promise<void>;
  /** Stub no-op per compat con index.tsx esistente */
  onSilence?: (cb: () => void) => void;
  onSpeechStart?: (cb: () => void) => void;
  onMeter?: (cb: (dbValue: number, voicePresentDb?: number | null) => void) => void;
  pauseSilence?: () => void;
  resumeSilence?: () => void;
  resetSilenceState?: () => void;
};

let _webPermissionAsked = false;
let _nativePermissionGranted = false;

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
    if (_nativePermissionGranted) return true;
    // FIX Expo Go: controlla prima lo stato CORRENTE prima di richiedere.
    // Expo Go a volte mostra "negato" anche se iOS l'ha già concesso.
    const existing = await AudioModule.getRecordingPermissionsAsync();
    if (existing.granted) {
      _nativePermissionGranted = true;
    } else {
      const requested = await AudioModule.requestRecordingPermissionsAsync();
      if (!requested.granted) return false;
      _nativePermissionGranted = true;
    }
    // Modalità audio iniziale: playback (per ascoltare TTS).
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
      shouldPlayInBackground: false,
    });
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

  // ============ NATIVE (iOS/Android) — expo-audio ============
  // FIX Expo Go: check del permesso CORRENTE prima di richiederlo.
  // Su Expo Go, requestRecordingPermissionsAsync a volte ritorna granted:false
  // anche se iOS ha già concesso il permesso a livello sistema.
  if (!_nativePermissionGranted) {
    const existing = await AudioModule.getRecordingPermissionsAsync();
    if (existing.granted) {
      _nativePermissionGranted = true;
    } else {
      const requested = await AudioModule.requestRecordingPermissionsAsync();
      if (!requested.granted) {
        throw new Error("Permesso microfono negato — controlla Impostazioni iOS > Expo Go > Microfono");
      }
      _nativePermissionGranted = true;
    }
  }

  // Modalità audio: passa a "recording mode". expo-audio gestisce internamente
  // la AVAudioSession iOS in modo MOLTO più affidabile di expo-av.
  await setAudioModeAsync({
    playsInSilentMode: true,
    allowsRecording: true,
    shouldRouteThroughEarpiece: false,
    shouldPlayInBackground: false,
  });

  // Crea il recorder con preset HIGH_QUALITY (16kHz mono = perfetto per STT)
  const recorder = new AudioRecorder(RecordingPresets.HIGH_QUALITY);
  await recorder.prepareToRecordAsync();
  recorder.record();
  const startedAt = Date.now();

  return {
    stop: async () => {
      try {
        await recorder.stop();
      } catch (e) {
        // Anche se stop fallisce, tentiamo di leggere l'URI comunque
      }
      // Torna a modalità playback per il TTS
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          shouldRouteThroughEarpiece: false,
          shouldPlayInBackground: false,
        });
      } catch {}
      const uri = recorder.uri || undefined;
      const totalMs = Date.now() - startedAt;
      if (totalMs < 500) {
        return null;
      }
      return { uri, mime: "audio/m4a", filename: "audio.m4a" };
    },
    cancel: async () => {
      try { await recorder.stop(); } catch {}
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
        });
      } catch {}
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
    // @ts-ignore
    fd.append("audio", {
      uri: result.uri,
      name: result.filename,
      type: result.mime,
    });
  }
  return fd;
}
