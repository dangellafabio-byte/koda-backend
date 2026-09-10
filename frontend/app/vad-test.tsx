/**
 * /vad-test — Pagina test VAD locale via @siteed/audio-studio
 * ===========================================================
 * Fabio 2026-09-10 — Diagnostica Samsung One UI VAD.
 *
 * OBIETTIVO:
 *   Testare il nuovo hook `useLocalVadRecorder` in isolamento su
 *   Samsung / Pixel / altri device Android per:
 *   1. Verificare che RMS/dB varino con la voce (vs MediaRecorder morto)
 *   2. Calibrare `RMS_VOICE_THRESHOLD` empiricamente
 *   3. Confermare che 15s silenzio → auto-reveal funziona
 *   4. Zero rete: audio non lascia il device
 *
 * USO:
 *   Apri l'app (dev build), naviga a `/vad-test`, tieni premuto "REC"
 *   e osserva:
 *   - RMS live (verde se >= threshold, rosso se sotto)
 *   - dB live
 *   - Barra visuale orbLevel
 *   - Tempo silenzio consecutivo (contatore)
 *
 * NON toccare `lascia-andare.tsx` finché la calibrazione non è chiusa.
 */

import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalVadRecorder } from "../lib/useLocalVadRecorder";

export default function VadTestScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [revealCount, setRevealCount] = useState(0);
  const [lastRevealAt, setLastRevealAt] = useState<number>(0);

  const handleReveal = useCallback(() => {
    setRevealCount((n) => n + 1);
    setLastRevealAt(Date.now());
  }, []);

  const vad = useLocalVadRecorder({
    onReveal: handleReveal,
    verbose: true,
    // Per il test uso timer brevi (verifica veloce)
    silenceLimitMs: 15_000,
    maxTotalMs: 90_000,
  });

  const onStart = async () => {
    try {
      await vad.start();
    } catch (e) {
      Alert.alert(
        "Impossibile avviare VAD",
        String(e),
        [{ text: "OK" }]
      );
    }
  };

  const onStop = async () => {
    await vad.stop();
  };

  // Colore RMS: verde se sopra soglia (0.02), rosso se sotto
  const rmsColor = vad.rms >= 0.02 ? "#4ade80" : "#ef4444";
  const orbPercent = Math.round(vad.orbLevel * 100);

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 16 }]}>
      <TouchableOpacity
        style={styles.backBtn}
        onPress={() => router.back()}
        accessibilityRole="button"
      >
        <Text style={styles.backText}>← Indietro</Text>
      </TouchableOpacity>

      <Text style={styles.title}>VAD Test — @siteed/audio-studio</Text>
      <Text style={styles.subtitle}>
        Diagnostica Samsung One UI. Zero rete, PCM in-app only.
      </Text>

      <View style={styles.metricsBox}>
        <Text style={styles.label}>Stato recorder</Text>
        <Text
          style={[
            styles.value,
            { color: vad.isRecording ? "#4ade80" : "#a3a3a3" },
          ]}
        >
          {vad.isRecording ? "RECORDING" : "IDLE"}
        </Text>

        <View style={styles.divider} />

        <Text style={styles.label}>RMS live (0..1)</Text>
        <Text style={[styles.value, { color: rmsColor }]}>
          {vad.rms.toFixed(4)}
        </Text>
        <Text style={styles.hint}>
          soglia voce: 0.0200 · {vad.rms >= 0.02 ? "VOCE" : "silenzio"}
        </Text>

        <View style={styles.divider} />

        <Text style={styles.label}>dBFS live</Text>
        <Text style={styles.value}>{vad.db.toFixed(1)} dB</Text>

        <View style={styles.divider} />

        <Text style={styles.label}>orbLevel (rms × 8 clamp)</Text>
        <View style={styles.orbBarBg}>
          <View
            style={[
              styles.orbBarFill,
              { width: `${orbPercent}%` },
            ]}
          />
        </View>
        <Text style={styles.hint}>{orbPercent}%</Text>

        <View style={styles.divider} />

        <Text style={styles.label}>Reveal triggered</Text>
        <Text style={styles.value}>
          {revealCount} volte
          {lastRevealAt > 0 &&
            ` (ultimo: ${new Date(lastRevealAt).toLocaleTimeString()})`}
        </Text>

        {vad.lastError && (
          <>
            <View style={styles.divider} />
            <Text style={styles.label}>Ultimo errore</Text>
            <Text style={[styles.value, { color: "#ef4444" }]}>
              {vad.lastError}
            </Text>
          </>
        )}
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: vad.isRecording ? "#444" : "#4ade80" },
          ]}
          onPress={onStart}
          disabled={vad.isRecording}
        >
          <Text style={styles.btnText}>START</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: vad.isRecording ? "#ef4444" : "#444" },
          ]}
          onPress={onStop}
          disabled={!vad.isRecording}
        >
          <Text style={styles.btnText}>STOP</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        Se RMS varia con la voce = fix confermato.{"\n"}
        Se RMS resta ~0 anche parlando = bug hardware più profondo.
      </Text>
    </View>
  );
}

// Colori hardcoded: pagina diagnostica, no dependency dal theme.
const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: "#0a0a0a",
    paddingHorizontal: 20,
  },
  backBtn: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  backText: {
    color: "#a3a3a3",
    fontSize: 15,
  },
  title: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 4,
  },
  subtitle: {
    color: "#a3a3a3",
    fontSize: 13,
    marginBottom: 20,
  },
  metricsBox: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  label: {
    color: "#a3a3a3",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "600",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  hint: {
    color: "#737373",
    fontSize: 11,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: "#262626",
    marginVertical: 10,
  },
  orbBarBg: {
    height: 12,
    backgroundColor: "#262626",
    borderRadius: 6,
    marginTop: 6,
    overflow: "hidden",
  },
  orbBarFill: {
    height: "100%",
    backgroundColor: "#60a5fa",
    borderRadius: 6,
  },
  controls: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 20,
  },
  btn: {
    flex: 1,
    height: 56,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  btnText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  footer: {
    color: "#737373",
    fontSize: 12,
    textAlign: "center",
    marginTop: 8,
  },
});
