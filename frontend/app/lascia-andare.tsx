/**
 * LASCIA ANDARE — "Un posto dove nessuno risponde."
 *
 * Concept (Fabio, 2026-07-16):
 *   L'utente entra, lo schermo diventa nero, solo l'orb è visibile.
 *   L'utente parla liberamente. L'orb pulsa mentre sente la voce
 *   (feedback visivo di ascolto). Koda NON risponde — né voce né testo.
 *   Zero trascrizione, zero Claude, zero ElevenLabs, zero rete.
 *   Solo il VAD locale sul dispositivo rileva quando l'utente parla.
 *   Quando l'utente esce, zero traccia rimane né sul server né sul telefono.
 *
 * Implementazione:
 *   • expo-audio recorder in modalità metering-only (16 kHz, m4a in tmp)
 *   • Poll metering ogni 100 ms → dB in ingresso
 *   • Semplice VAD con isteresi: > SPEECH_DB → orb "recording", < SILENCE_DB
 *     per >= SILENCE_MS → orb torna a "idle"
 *   • Nessuna chiamata fetch/WebSocket in tutto il file
 *   • All'uscita: recorder.stop(), release, e cancellazione FISICA del
 *     file temporaneo su disco (expo-file-system)
 *   • Nessuna scrittura su AsyncStorage / MongoDB / timeline
 *
 * Garanzia: cerca in questo file "fetch(", "WebSocket(", "api." — non
 * esistono. L'audio non lascia il dispositivo e non viene persistito.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  BackHandler,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import EclipseOrb, { OrbStatus } from "../components/EclipseOrb";

// ==== VAD tuning (calibrato sulla stessa scala di lib/voice.ts) ====
const SPEECH_DB = -35; // sopra questa soglia → voce presente
const SILENCE_DB = -45; // sotto questa soglia → silenzio (isteresi)
const SILENCE_HOLD_MS = 700; // millisecondi di silenzio per tornare a idle
const METER_POLL_MS = 100;

export default function LasciaAndareScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OrbStatus>("idle");
  const [meterDb, setMeterDb] = useState<number>(-100);
  const [ready, setReady] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);

  // Ref al recorder nativo (istanza AudioRecorder di expo-audio)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recorderRef = useRef<any>(null);
  // Path del file temporaneo che il recorder crea. Lo cancelliamo all'uscita.
  const tempUriRef = useRef<string | null>(null);
  // Timestamp ultima voce rilevata (per silence-hold)
  const lastVoiceAtRef = useRef<number>(0);
  // Interval di polling metering
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guard per evitare doppia teardown
  const teardownStartedRef = useRef(false);

  // === TEARDOWN — chiamato all'uscita ================================
  // 1) ferma il polling
  // 2) stop del recorder + release
  // 3) elimina FISICAMENTE il file temporaneo su disco
  // 4) disattiva la sessione audio (libera microfono)
  const teardown = useCallback(async () => {
    if (teardownStartedRef.current) return;
    teardownStartedRef.current = true;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    const rec = recorderRef.current;
    recorderRef.current = null;

    if (rec) {
      try {
        await rec.stop();
      } catch {}
      try {
        // Cattura l'URI PRIMA di release (dopo release non è leggibile)
        const statusUrl = rec.getStatus?.()?.url || null;
        const directUri = rec.uri || null;
        tempUriRef.current = statusUrl || directUri || tempUriRef.current;
      } catch {}
      try {
        rec.release?.();
      } catch {}
    }

    // Cancellazione FISICA del file temporaneo. È fondamentale:
    // niente audio deve restare sul telefono dopo che l'utente esce.
    const uri = tempUriRef.current;
    if (uri) {
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      } catch {}
    }
    tempUriRef.current = null;

    // Libera la sessione audio (Bluetooth/altoparlante, ecc.)
    try {
      await setIsAudioActiveAsync(false);
    } catch {}
  }, []);

  // === SETUP — chiamato al mount ======================================
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        // Permesso microfono (chiede solo se necessario)
        const p = await requestRecordingPermissionsAsync();
        if (!p?.granted) {
          setPermError(
            p?.canAskAgain === false
              ? "Serve il permesso microfono. Apri Impostazioni per abilitarlo."
              : "Serve il permesso microfono per proseguire."
          );
          return;
        }

        // Modalità audio: recording, no ducking
        try {
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          });
          await setIsAudioActiveAsync(true);
        } catch {}

        if (cancelled) return;

        // Costruisci un preset light: metering ON, bitrate basso.
        // Il file scritto su disco è irrilevante per noi — lo cancelleremo
        // all'uscita — quindi teniamo qualsiasi impostazione compatibile.
        const base = (RecordingPresets as any).HIGH_QUALITY || {};
        const preset = {
          ...base,
          extension: ".m4a",
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 24000,
          isMeteringEnabled: true,
          android: {
            ...(base.android || {}),
            extension: ".m4a",
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 24000,
            outputFormat: "mpeg4",
            audioEncoder: "aac",
            isMeteringEnabled: true,
            audioSource: "voice_communication",
          },
          ios: {
            ...(base.ios || {}),
            extension: ".m4a",
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 24000,
          },
          web: {
            ...(base.web || {}),
            mimeType: "audio/webm",
            bitsPerSecond: 24000,
          },
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rec: any = new (AudioModule as any).AudioRecorder({});
        try {
          await rec.prepareToRecordAsync(preset);
        } catch {
          // Fallback: preset default con metering
          await rec.prepareToRecordAsync({
            ...(RecordingPresets as any).HIGH_QUALITY,
            isMeteringEnabled: true,
          });
        }
        if (cancelled) {
          try {
            await rec.stop();
          } catch {}
          try {
            rec.release?.();
          } catch {}
          return;
        }

        rec.record();
        recorderRef.current = rec;
        // Cattura URI subito (per cancellazione a fine sessione)
        try {
          tempUriRef.current = rec.getStatus?.()?.url || rec.uri || null;
        } catch {}

        setReady(true);

        // === Polling metering (VAD locale) ===============================
        // Nessun invio di rete: leggiamo solo il livello del microfono in dB
        // e aggiorniamo lo stato dell'orb. L'audio scritto nel .m4a non
        // viene MAI letto né trasmesso — verrà cancellato all'uscita.
        lastVoiceAtRef.current = 0;
        pollRef.current = setInterval(() => {
          try {
            const st = recorderRef.current?.getStatus?.();
            if (!st || !st.isRecording) return;
            const db: number =
              typeof st.metering === "number" ? st.metering : -100;
            setMeterDb(db);
            const now = Date.now();
            if (db > SPEECH_DB) {
              lastVoiceAtRef.current = now;
              setStatus((prev) => (prev === "recording" ? prev : "recording"));
            } else if (db < SILENCE_DB) {
              const since = lastVoiceAtRef.current
                ? now - lastVoiceAtRef.current
                : Infinity;
              if (since >= SILENCE_HOLD_MS) {
                setStatus((prev) => (prev === "idle" ? prev : "idle"));
              }
            }
            // Zona morta tra SILENCE_DB e SPEECH_DB → mantieni stato corrente
          } catch {
            // metering può fallire brevemente tra state transitions
          }
        }, METER_POLL_MS);
      } catch (e) {
        console.warn("[LasciaAndare] setup error:", e);
        setPermError("Non è stato possibile aprire il microfono. Riprova.");
      }
    };

    setup();

    return () => {
      cancelled = true;
      // Cleanup su unmount (safety net)
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === Hardware back (Android) → uscita pulita ==========================
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleExit();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExit = useCallback(async () => {
    await teardown();
    // router.back() se possibile, altrimenti torna alla home
    try {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace("/");
      }
    } catch {
      router.replace("/");
    }
  }, [router, teardown]);

  // === RENDER ==========================================================
  return (
    <View style={styles.root}>
      {/* Uscita — pulsante discreto in alto a sinistra.
          Touch target 44×44 (linee guida iOS), icona X neutra. */}
      <TouchableOpacity
        onPress={handleExit}
        hitSlop={16}
        style={[
          styles.exitBtn,
          { top: Math.max(insets.top + 8, 20) },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Esci da Lascia andare"
        testID="lascia-andare-exit"
      >
        <Ionicons name="close" size={22} color="rgba(255,255,255,0.55)" />
      </TouchableOpacity>

      {/* Orb centrale.
          - "idle" → respiro lento, palette calda
          - "recording" → tiffany freddo, luce che si "raffredda"
          Nessun testo intorno: silenzio visivo per silenzio uditivo. */}
      <View style={styles.center}>
        <EclipseOrb
          status={status}
          size={260}
          meterDb={meterDb}
          meterThreshold={SPEECH_DB}
        />
      </View>

      {/* Micro-hint in basso — appare 1.5s dopo l'ingresso, poi svanisce.
          Solo la prima volta rassicura l'utente: "sto ascoltando, ma
          non ti sto registrando per rispondere". */}
      <View style={[styles.hintBox, { bottom: Math.max(insets.bottom + 24, 32) }]}>
        {permError ? (
          <Text style={styles.errText}>{permError}</Text>
        ) : (
          <Text style={styles.hintText}>
            {ready ? "Nessuno ti sente. Sparisce nel silenzio." : "…"}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
  },
  exitBtn: {
    position: "absolute",
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  hintBox: {
    position: "absolute",
    left: 24,
    right: 24,
    alignItems: "center",
  },
  hintText: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 13,
    letterSpacing: 0.3,
    textAlign: "center",
    fontStyle: "italic",
  },
  errText: {
    color: "rgba(255,120,120,0.85)",
    fontSize: 13,
    textAlign: "center",
    letterSpacing: 0.2,
  },
});
