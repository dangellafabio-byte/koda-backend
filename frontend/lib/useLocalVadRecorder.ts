/**
 * useLocalVadRecorder — STUB (2026-09-11)
 * ======================================
 *
 * DISABILITATO temporaneamente. Motivo: la libreria `@siteed/audio-studio@3.2.1`
 * usata come backend PCM raw è INCOMPATIBILE con la versione corrente di
 * `expo-modules-core` (Expo SDK 54) — la sua firma nativa `Promise.reject(code, msg)`
 * non esiste più nella API, generando ~40 errori Kotlin al compile Android:
 *
 *   e: AudioRecorderManager.kt:230:40
 *      Class '<anonymous>' is not abstract and does not implement abstract member:
 *      fun reject(code: String, message: String?, cause: Throwable?): Unit
 *
 * Il pacchetto è stato rimosso da `package.json` e `app.json` per sbloccare
 * il build EAS Android. Questo file resta come stub no-op per non rompere
 * gli import esistenti (`app/vad-test.tsx`).
 *
 * PIANO FUTURO (Issue P1 — VAD Android metering -100dB su MIUI):
 *   Opzione A) attendere fix upstream su @siteed/audio-studio (issue tracker)
 *   Opzione B) fork della libreria con `reject()` allineato all'API nuova
 *   Opzione C) alternativa: `react-native-live-audio-stream` (mantenuto)
 *
 * INTANTO: il flusso in produzione bypassa già il VAD volumetrico usando lo
 * streaming WebSocket verso Deepgram (`EXPO_PUBLIC_USE_WS_VOICE_STREAM=true`)
 * → endpointing linguistico server-side → il bug orb-metering è mitigato UX.
 */

export type LocalVadRecorderOptions = {
  onReveal?: () => void;
  verbose?: boolean;
  silenceLimitMs?: number;
  maxTotalMs?: number;
};

export type LocalVadRecorderApi = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRecording: boolean;
  rms: number;
  db: number;
  orbLevel: number;
  lastError: string | null;
};

export function useLocalVadRecorder(
  _options: LocalVadRecorderOptions = {}
): LocalVadRecorderApi {
  const err =
    "VAD locale disabilitato: @siteed/audio-studio incompatibile con Expo SDK 54";
  return {
    start: async () => {
      throw new Error(err);
    },
    stop: async () => {
      /* no-op */
    },
    isRecording: false,
    rms: 0,
    db: -160,
    orbLevel: 0,
    lastError: err,
  };
}
