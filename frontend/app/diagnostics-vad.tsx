/**
 * Diagnostics VAD — pagina PoC isolata
 * ──────────────────────────────────────────────────────────────────────
 * P1 Fase 1 (Fabio escalation 2026-06-20).
 * URL: /diagnostics-vad
 *
 * Obiettivo: dimostrare che il modello Silero VAD v5 carica nel
 * dispositivo tramite onnxruntime-react-native. Test isolato — non
 * tocca il VAD attivo dell'app (voice.ts).
 *
 * Cosa fa:
 *  - Bottone "Carica modello" → download da /api/assets/silero_vad.onnx
 *    (con barra progresso) → InferenceSession.create()
 *  - Mostra: percorso locale, dimensione file, tempo di caricamento,
 *    nomi input/output ONNX
 *  - Bottone "Test sintetico" → fa un'inference su rumore random
 *    e mostra voice_probability (deve essere bassa, < 0.2)
 *  - Bottone "Cancella cache" → pulisce il file locale per re-download
 *
 * NON FA (è Fase 2/3):
 *  - Streaming PCM dal microfono in tempo reale
 *  - Integrazione con il VAD attivo nella chat
 */

import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import {
  loadSileroVadModel,
  clearVadModelCache,
  runSyntheticTest,
  isVadLoaded,
  type ModelLoadStatus,
} from "../lib/vad/silero";
// Platform-specific via Metro resolution:
//  - lib/vad/streamingSection.tsx (mobile, full implementation)
//  - lib/vad/streamingSection.web.tsx (web stub)
import { StreamingSection } from "../lib/vad/streamingSection";

export default function DiagnosticsVadScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ModelLoadStatus | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [syntheticResult, setSyntheticResult] = useState<{ noise_prob: number; inference_ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleLoad = async () => {
    setError(null);
    setProgress(null);
    setLoading(true);
    try {
      const res = await loadSileroVadModel((received, total) => {
        setProgress({ received, total });
      });
      setStatus(res);
      if (!res.ok) setError(res.error || "load failed");
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSyntheticTest = async () => {
    setError(null);
    try {
      const r = await runSyntheticTest();
      setSyntheticResult(r);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const handleClear = async () => {
    setError(null);
    setStatus(null);
    setSyntheticResult(null);
    setProgress(null);
    try {
      await clearVadModelCache();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.back}>← Indietro</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Diagnostica VAD</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          Test isolato del modello Silero VAD v5 (Fase 1 — PoC).{"\n"}
          NON tocca l'app reale: serve solo a verificare che il modello
          si carica nel dispositivo.
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Carica modello</Text>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, loading && styles.btnDisabled]}
            onPress={handleLoad}
            disabled={loading}
            testID="vad-load-btn"
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.btnText}>
                {status?.ok ? "Ricarica modello" : "Carica modello"}
              </Text>
            )}
          </TouchableOpacity>
          {progress && (
            <Text style={styles.progressText}>
              Download: {(progress.received / 1024).toFixed(0)} / {(progress.total / 1024).toFixed(0)} KB
              {" "}({((progress.received / progress.total) * 100).toFixed(0)}%)
            </Text>
          )}
        </View>

        {status && (
          <View style={[styles.section, status.ok ? styles.sectionSuccess : styles.sectionError]}>
            <Text style={styles.sectionTitle}>
              {status.ok ? "✅ Modello caricato" : "❌ Errore caricamento"}
            </Text>
            {status.ok ? (
              <View style={styles.kvBlock}>
                <KV k="Percorso locale" v={status.modelPath || "—"} />
                <KV k="Dimensione" v={status.modelSize ? `${(status.modelSize / 1024).toFixed(0)} KB` : "—"} />
                <KV k="Tempo caricamento" v={status.loadTimeMs != null ? `${status.loadTimeMs} ms` : "—"} />
                <KV k="Input ONNX" v={status.sessionInputs?.join(", ") || "—"} />
                <KV k="Output ONNX" v={status.sessionOutputs?.join(", ") || "—"} />
                <KV k="Platform" v={`${Platform.OS} ${Platform.Version || ""}`} />
              </View>
            ) : (
              <Text style={styles.errorText}>{status.error}</Text>
            )}
          </View>
        )}

        {status?.ok && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Test sintetico (rumore random)</Text>
            <Text style={styles.subtitleHint}>
              Genera 512 sample di rumore casuale e fa inference.
              La voice_probability dovrebbe essere BASSA (&lt; 0.2) perché il
              rumore non è voce umana. Se è alta il modello potrebbe
              essere il wrong model.
            </Text>
            <TouchableOpacity
              style={[styles.btn, styles.btnSecondary]}
              onPress={handleSyntheticTest}
              testID="vad-synthetic-btn"
            >
              <Text style={styles.btnText}>Esegui test</Text>
            </TouchableOpacity>
            {syntheticResult && (
              <View style={styles.kvBlock}>
                <KV
                  k="voice_probability"
                  v={syntheticResult.noise_prob.toFixed(4)}
                  highlight={syntheticResult.noise_prob < 0.2 ? "green" : "amber"}
                />
                <KV k="Latenza inference" v={`${syntheticResult.inference_ms} ms`} />
                <Text style={styles.miniNote}>
                  {syntheticResult.noise_prob < 0.2
                    ? "✅ Modello risponde correttamente (bassa prob su rumore)"
                    : "⚠️ Probability inaspettatamente alta — verificare"}
                </Text>
              </View>
            )}
          </View>
        )}

        {status?.ok && <StreamingSection modelReady={true} />}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>4. Reset cache (debug)</Text>
          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={handleClear}
            testID="vad-clear-btn"
          >
            <Text style={[styles.btnText, { color: "#FF6B6B" }]}>Cancella modello dalla cache</Text>
          </TouchableOpacity>
        </View>

        {error && (
          <View style={[styles.section, styles.sectionError]}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        <View style={[styles.section, { marginTop: 24 }]}>
          <Text style={styles.smallNote}>
            Stato sessione runtime: {isVadLoaded() ? "✅ attiva" : "❌ non caricata"}
          </Text>
          <Text style={styles.smallNote}>
            Modello: Silero VAD v5 (Apache 2.0) — github.com/snakers4/silero-vad
          </Text>
          <Text style={styles.smallNote}>
            Fase 2 (prossima): streaming PCM dal microfono via @siteed/expo-audio-stream.{"\n"}
            Fase 3 (finale): sostituire il VAD volumetrico in voice.ts.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function KV({ k, v, highlight }: { k: string; v: string; highlight?: "green" | "amber" }) {
  const color = highlight === "green" ? "#3DDC97" : highlight === "amber" ? "#F5A623" : "#E5E5E5";
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={[styles.kvVal, { color }]} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0E14",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  back: {
    color: "#7E8A9B",
    fontSize: 16,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  intro: {
    color: "#A3ADBA",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  section: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  sectionSuccess: {
    borderColor: "rgba(61,220,151,0.3)",
    backgroundColor: "rgba(61,220,151,0.06)",
  },
  sectionError: {
    borderColor: "rgba(255,107,107,0.3)",
    backgroundColor: "rgba(255,107,107,0.06)",
  },
  sectionTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 12,
  },
  subtitleHint: {
    color: "#7E8A9B",
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  btn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  btnPrimary: { backgroundColor: "#0E7C7B" },
  btnSecondary: { backgroundColor: "rgba(255,255,255,0.1)" },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: "rgba(255,107,107,0.3)" },
  btnDisabled: { opacity: 0.6 },
  btnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },
  progressText: {
    color: "#7E8A9B",
    fontSize: 12,
    marginTop: 10,
    textAlign: "center",
  },
  kvBlock: {
    marginTop: 4,
  },
  kvRow: {
    flexDirection: "row",
    paddingVertical: 6,
    alignItems: "flex-start",
  },
  kvKey: {
    color: "#7E8A9B",
    fontSize: 12,
    width: 140,
  },
  kvVal: {
    flex: 1,
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) as any,
  },
  errorText: {
    color: "#FF6B6B",
    fontSize: 13,
    lineHeight: 18,
  },
  smallNote: {
    color: "#5C6573",
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 6,
  },
  miniNote: {
    color: "#A3ADBA",
    fontSize: 12,
    marginTop: 10,
    fontStyle: "italic",
  },
  // === Live streaming UI (P1 Fase 2) ===
  liveBlock: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  liveNumberRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  liveBigNumber: {
    fontSize: 48,
    fontWeight: "300",
    fontVariant: ["tabular-nums"],
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) as any,
  },
  liveLabel: {
    color: "#7E8A9B",
    fontSize: 11,
    marginTop: 4,
  },
  speechBadge: {
    backgroundColor: "rgba(61,220,151,0.15)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
    borderWidth: 1,
    borderColor: "rgba(61,220,151,0.4)",
  },
  speechBadgeText: {
    color: "#3DDC97",
    fontSize: 11,
    fontWeight: "700",
  },
  probBarBg: {
    height: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 16,
    position: "relative",
  },
  probBarFg: {
    height: "100%",
    borderRadius: 6,
  },
  threshMarker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    opacity: 0.5,
  },
  sparkline: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 60,
    marginVertical: 12,
    paddingHorizontal: 4,
  },
});
