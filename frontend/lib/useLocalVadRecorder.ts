/**
 * useLocalVadRecorder — VAD 100% locale via @siteed/audio-studio
 * ==============================================================
 * Fabio 2026-09-10 (autorizzato 1b), fix Samsung One UI VAD.
 *
 * PROBLEMA RISOLTO:
 *   `expo-audio` usa sotto `MediaRecorder.getMaxAmplitude()` per il metering.
 *   Su alcuni device Android (Samsung One UI in particolare) questo ritorna
 *   sempre -100 dB indipendentemente da `audioSource` → orb Lascia Andare
 *   non pulsa. Bug hardware/driver, non è colpa dell'app.
 *
 * SOLUZIONE:
 *   `@siteed/audio-studio` legge PCM raw via `AudioRecord` nativo (primitiva
 *   Android standard, non `MediaRecorder`). RMS calcolato in-app dai campioni
 *   PCM. Zero dipendenza da `getMaxAmplitude()`.
 *
 * VINCOLI RISPETTATI:
 *   - 100% locale: nessun PCM/RMS/dB inviato al backend
 *   - Nessun `onAudioStream` handler → PCM non lascia MAI il device
 *   - Nessun file WAV persistito (session-only)
 *   - Coesistenza con `expo-audio` playback: stopRecording() completo
 *     prima di riprendere audio session verso il player
 *
 * CALIBRAZIONE:
 *   RMS_VOICE_THRESHOLD = 0.02 (RMS normalizzato 0..1). Da calibrare
 *   empiricamente sui device Samsung reali. RMS ~0.005-0.01 = silenzio,
 *   RMS ~0.02-0.15 = voce parlata normale.
 *
 * NB: richiede DEV BUILD (non funziona in Expo Go).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioStudioModule,
  useAudioRecorder,
  type AudioAnalysisEvent,
} from "@siteed/audio-studio";

// Finestra di analisi PCM (ms). 100ms = 10 samples/s → orb pulsazione fluida.
const WINDOW_MS = 100;

// Soglia RMS per considerare la finestra "voce" (0..1 normalizzato).
// Calibrare empiricamente su Samsung One UI + Pixel dopo il primo test.
const RMS_VOICE_THRESHOLD = 0.02;

// Silenzio massimo tollerato prima di auto-reveal (ms).
export const DEFAULT_SILENCE_LIMIT_MS = 15_000;

// Durata massima assoluta della sessione VAD (ms). Fallback hard timeout.
export const DEFAULT_MAX_TOTAL_MS = 90_000;

export interface LocalVadRecorderOptions {
  /** ms di silenzio consecutivo prima di triggerare `onReveal`. Default 15s */
  silenceLimitMs?: number;
  /** ms max totali prima di forzare stop + reveal. Default 90s */
  maxTotalMs?: number;
  /** Callback triggerato al reveal (silenzio prolungato o timeout). */
  onReveal: () => void;
  /** Log verboso in console (default false). */
  verbose?: boolean;
}

export interface LocalVadRecorderState {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** True quando il recorder nativo sta girando. */
  isRecording: boolean;
  /** RMS più recente (0..1). Usare per pulsazione orb. */
  rms: number;
  /** dBFS più recente (-100..0). */
  db: number;
  /** Valore clamped 0..1 per orb pulsation (rms * 8). */
  orbLevel: number;
  /** Timestamp start (0 se non attivo). */
  startedAt: number;
  /** Errore ultimo start (permesso negato, hardware busy, ecc.). */
  lastError: string | null;
}

function lastPoint(event: AudioAnalysisEvent) {
  const points = event?.dataPoints ?? [];
  return points.length > 0 ? points[points.length - 1] : null;
}

export function useLocalVadRecorder(
  options: LocalVadRecorderOptions
): LocalVadRecorderState {
  const {
    silenceLimitMs = DEFAULT_SILENCE_LIMIT_MS,
    maxTotalMs = DEFAULT_MAX_TOTAL_MS,
    onReveal,
    verbose = false,
  } = options;

  const recorder = useAudioRecorder();
  const [rms, setRms] = useState(0);
  const [db, setDb] = useState(-100);
  const [active, setActive] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const startedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const stoppingRef = useRef(false);
  const revealedRef = useRef(false);
  const onRevealRef = useRef(onReveal);

  // Mantieni sempre la callback più recente senza reinstallare il recorder
  useEffect(() => {
    onRevealRef.current = onReveal;
  }, [onReveal]);

  const log = useCallback(
    (msg: string) => {
      if (verbose) {
        console.log(`[KODA_VAD_LOCAL] ${msg}`);
      }
    },
    [verbose]
  );

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    log("stop() called");
    try {
      if (recorder.isRecording || recorder.isPaused) {
        await recorder.stopRecording();
        log("recorder.stopRecording() completed");
      }
    } catch (e) {
      log(`stopRecording error: ${String(e)}`);
    } finally {
      setActive(false);
      setRms(0);
      setDb(-100);
      startedAtRef.current = 0;
      lastVoiceAtRef.current = 0;
      stoppingRef.current = false;
    }
  }, [recorder, log]);

  const start = useCallback(async () => {
    setLastError(null);
    revealedRef.current = false;

    // Permesso RECORD_AUDIO (idempotente: chiede solo se non concesso)
    try {
      const perm = await AudioStudioModule.requestPermissionsAsync();
      if (perm.status !== "granted") {
        const err = "Microfono non autorizzato";
        setLastError(err);
        throw new Error(err);
      }
    } catch (e) {
      const err = `permission check failed: ${String(e)}`;
      setLastError(err);
      throw new Error(err);
    }

    const now = Date.now();
    startedAtRef.current = now;
    lastVoiceAtRef.current = now;
    stoppingRef.current = false;
    setActive(true);
    log(
      `start() @${now} silenceLimit=${silenceLimitMs}ms maxTotal=${maxTotalMs}ms`
    );

    try {
      await recorder.startRecording({
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_16bit",
        enableProcessing: true,
        interval: WINDOW_MS,
        intervalAnalysis: WINDOW_MS,
        pointsPerSecond: 10,
        // keepFullAnalysis: false → non accumula in memoria JS 90s di dataPoints
        keepFullAnalysis: false,
        // Volutamente NO `onAudioStream` handler: il PCM non deve mai
        // uscire da qui verso backend/analytics/log. Solo callback locale.
        onAudioAnalysis: async (event) => {
          const point = lastPoint(event);
          if (!point) return;

          const nextRms = Number.isFinite(point.rms) ? point.rms : 0;
          const nextDb = Number.isFinite(point.dB) ? point.dB : -100;
          setRms(nextRms);
          setDb(nextDb);

          const t = Date.now();
          const isVoice = !point.silent && nextRms >= RMS_VOICE_THRESHOLD;
          if (isVoice) {
            lastVoiceAtRef.current = t;
          }

          const silenceElapsed = t - lastVoiceAtRef.current;
          const totalElapsed = t - startedAtRef.current;

          if (
            !revealedRef.current &&
            (silenceElapsed >= silenceLimitMs || totalElapsed >= maxTotalMs)
          ) {
            revealedRef.current = true;
            log(
              `reveal trigger silence=${silenceElapsed}ms total=${totalElapsed}ms`
            );
            await stop();
            onRevealRef.current();
          }
        },
        onRecordingInterrupted: () => {
          log("recorder interrupted (call/route change/etc.)");
          void stop();
        },
        autoResumeAfterInterruption: false,
      });
      log("recorder.startRecording() ok");
    } catch (e) {
      const err = `startRecording failed: ${String(e)}`;
      setLastError(err);
      setActive(false);
      startedAtRef.current = 0;
      lastVoiceAtRef.current = 0;
      throw new Error(err);
    }
  }, [recorder, silenceLimitMs, maxTotalMs, stop, log]);

  // Cleanup su unmount → nessun recorder orfano
  useEffect(() => {
    return () => {
      if (recorder.isRecording || recorder.isPaused) {
        recorder.stopRecording().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orbLevel = Math.max(0, Math.min(1, rms * 8));

  return {
    start,
    stop,
    isRecording: active && recorder.isRecording,
    rms,
    db,
    orbLevel,
    startedAt: startedAtRef.current,
    lastError,
  };
}
