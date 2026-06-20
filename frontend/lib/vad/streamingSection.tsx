/**
 * VAD Streaming Section — versione MOBILE
 * ──────────────────────────────────────────────────────────────────────
 * P1 Fase 2 (Fabio escalation 2026-06-20).
 *
 * Componente che gestisce:
 *  - useAudioRecorder hook di @siteed/audio-studio
 *  - Permission flow microfono
 *  - Pipeline mic → Silero VAD → UI live
 *
 * SOLO MOBILE. La versione .web.tsx è uno stub. Metro risolve automaticamente.
 */

import React, { useState, useRef, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";

import { isVadLoaded } from "./silero";
import { SileroStreamEngine, pcm16BeBase64ToFloat32 } from "./sileroStream";

// === Lazy require @siteed/audio-studio (P1 Fase 2) ===
// Static import top-level di @siteed/audio-studio crasha sul bundle web
// con "Cannot read properties of undefined (reading 'install')". Usiamo
// require() solo al primo uso → su web il bundle non lo carica mai e
// l'errore non si verifica. La versione .web.tsx mostra solo lo stub.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _audioStudio: any = null;
function getAudioStudio(): any {
  if (Platform.OS === "web") {
    throw new Error("@siteed/audio-studio non disponibile su web");
  }
  if (!_audioStudio) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _audioStudio = require("@siteed/audio-studio");
  }
  return _audioStudio;
}

export type StreamingSectionProps = {
  modelReady: boolean;
};

export function StreamingSection({ modelReady }: StreamingSectionProps) {
  const [streaming, setStreaming] = useState(false);
  const [liveProb, setLiveProb] = useState<number>(0);
  const [liveRmsDb, setLiveRmsDb] = useState<number>(-100);
  const [speechCount, setSpeechCount] = useState<number>(0);
  const [framesCount, setFramesCount] = useState<number>(0);
  const [inSpeech, setInSpeech] = useState<boolean>(false);
  const [history, setHistory] = useState<number[]>(new Array(60).fill(0));
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<SileroStreamEngine | null>(null);
  // useAudioRecorder via lazy require — su web mai chiamato (componente
  // viene risolto da .web.tsx stub).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recorder = (getAudioStudio().useAudioRecorder as () => any)();
  const recorderStartedRef = useRef(false);

  const handleStart = async () => {
    setError(null);
    if (!isVadLoaded()) {
      setError("Devi prima caricare il modello (step 1)");
      return;
    }
    try {
      const perm = await getAudioStudio().ExpoAudioStreamModule.requestPermissionsAsync();
      if (perm?.status !== "granted") {
        setError("Permesso microfono negato. Vai in Impostazioni iOS per abilitarlo.");
        return;
      }
      const engine = new SileroStreamEngine({
        onProbability: (prob, rmsDb) => {
          setLiveProb(prob);
          setLiveRmsDb(rmsDb);
          setFramesCount(engine.totalFrames);
          setHistory((prev) => [...prev.slice(1), prob]);
        },
        onSpeechStart: () => {
          setInSpeech(true);
          setSpeechCount((c) => c + 1);
          console.log("[KODA_VAD] speech_start");
        },
        onSpeechEnd: (durMs) => {
          setInSpeech(false);
          console.log(`[KODA_VAD] speech_end after ${durMs}ms`);
        },
        onError: (err) => console.warn("[KODA_VAD] engine error:", err),
      });
      engine.start();
      engineRef.current = engine;

      await recorder.startRecording({
        sampleRate: 16000,
        channels: 1,
        encoding: "pcm_16bit",
        interval: 100,
        streamFormat: "float32",
        output: { primary: { enabled: false } } as any,
        onAudioStream: async (event: any) => {
          try {
            let samples: Float32Array | null = null;
            if (event.data instanceof Float32Array) samples = event.data;
            else if (typeof event.data === "string") samples = pcm16BeBase64ToFloat32(event.data);
            if (samples) await engineRef.current?.feedSamples(samples);
          } catch (e: any) {
            console.warn("[KODA_VAD] feed error:", e?.message);
          }
        },
      } as any);
      recorderStartedRef.current = true;
      setStreaming(true);
      setFramesCount(0);
      setSpeechCount(0);
      setHistory(new Array(60).fill(0));
    } catch (e: any) {
      setError(e?.message || String(e));
      try { engineRef.current?.stop(); } catch {}
      engineRef.current = null;
    }
  };

  const handleStop = async () => {
    setStreaming(false);
    try {
      if (recorderStartedRef.current) {
        await recorder.stopRecording();
        recorderStartedRef.current = false;
      }
    } catch (e) {
      console.warn("[KODA_VAD] stopRecording err:", e);
    }
    try { engineRef.current?.stop(); } catch {}
    engineRef.current = null;
    setInSpeech(false);
  };

  useEffect(() => {
    return () => {
      if (recorderStartedRef.current) recorder.stopRecording().catch(() => {});
      engineRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!modelReady) return null;

  const probColor = liveProb > 0.5 ? "#3DDC97" : liveProb > 0.3 ? "#F5A623" : "#6B7280";

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>3. Streaming live dal microfono (Fase 2)</Text>
      <Text style={styles.subtitleHint}>
        Connette il modello al microfono REALE. Parla → la voice_probability sale.
        Stai zitto → scende. In furgone col motore acceso è il vero test: il
        rumore deve restare basso, solo la tua voce alza il numero.
      </Text>
      {!streaming ? (
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={handleStart} testID="vad-stream-start">
          <Text style={styles.btnText}>▶ Inizia streaming live</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={handleStop} testID="vad-stream-stop">
          <Text style={[styles.btnText, { color: "#FF6B6B" }]}>■ Stop streaming</Text>
        </TouchableOpacity>
      )}

      {error && <Text style={styles.errorText}>⚠️ {error}</Text>}

      {(streaming || framesCount > 0) && (
        <View style={styles.liveBlock}>
          <View style={styles.liveNumberRow}>
            <Text style={[styles.liveBigNumber, { color: probColor }]}>{liveProb.toFixed(3)}</Text>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.liveLabel}>voice_probability</Text>
              {inSpeech && (
                <View style={styles.speechBadge}>
                  <Text style={styles.speechBadgeText}>🎙 SPEECH</Text>
                </View>
              )}
            </View>
          </View>
          <View style={styles.probBarBg}>
            <View style={[styles.probBarFg, { width: `${Math.min(100, liveProb * 100)}%`, backgroundColor: probColor }]} />
            <View style={[styles.threshMarker, { left: "35%", backgroundColor: "#F5A623" }]} />
            <View style={[styles.threshMarker, { left: "50%", backgroundColor: "#3DDC97" }]} />
          </View>
          <Text style={styles.liveLabel}>Ultimi {history.length} frame (sx → dx)</Text>
          <View style={styles.sparkline}>
            {history.map((p, idx) => (
              <View
                key={idx}
                style={{
                  width: 4,
                  marginRight: 1,
                  height: Math.max(2, p * 56),
                  backgroundColor: p > 0.5 ? "#3DDC97" : p > 0.3 ? "#F5A623" : "#6B7280",
                  opacity: 0.85,
                  borderRadius: 1,
                }}
              />
            ))}
          </View>
          <View style={styles.kvBlock}>
            <KV k="RMS audio" v={`${liveRmsDb.toFixed(1)} dB`} highlight={liveRmsDb > -40 ? "green" : "amber"} />
            <KV k="Frame totali" v={String(framesCount)} />
            <KV k="Segmenti speech rilevati" v={String(speechCount)} />
            <KV k="Stato motore" v={streaming ? "in corso" : "fermo"} />
          </View>
          <Text style={styles.miniNote}>
            💡 Soglia ON 0.50 (verde), OFF 0.35 (giallo).{"\n"}
            Schmitt trigger: serve {">"} 96ms continui sopra 0.50 per "speech_start",
            {" "}{">"} 480ms sotto 0.35 per "speech_end".
          </Text>
        </View>
      )}
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
  section: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  sectionTitle: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", marginBottom: 12 },
  subtitleHint: { color: "#7E8A9B", fontSize: 12, lineHeight: 17, marginBottom: 12 },
  btn: { paddingVertical: 14, borderRadius: 10, alignItems: "center", justifyContent: "center", minHeight: 48 },
  btnPrimary: { backgroundColor: "#0E7C7B" },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: "rgba(255,107,107,0.3)" },
  btnText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  errorText: { color: "#FF6B6B", fontSize: 13, lineHeight: 18, marginTop: 12 },
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
  liveLabel: { color: "#7E8A9B", fontSize: 11, marginTop: 4 },
  speechBadge: {
    backgroundColor: "rgba(61,220,151,0.15)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
    borderWidth: 1,
    borderColor: "rgba(61,220,151,0.4)",
  },
  speechBadgeText: { color: "#3DDC97", fontSize: 11, fontWeight: "700" },
  probBarBg: {
    height: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 16,
    position: "relative",
  },
  probBarFg: { height: "100%", borderRadius: 6 },
  threshMarker: { position: "absolute", top: 0, bottom: 0, width: 2, opacity: 0.5 },
  sparkline: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 60,
    marginVertical: 12,
    paddingHorizontal: 4,
  },
  kvBlock: { marginTop: 4 },
  kvRow: { flexDirection: "row", paddingVertical: 6, alignItems: "flex-start" },
  kvKey: { color: "#7E8A9B", fontSize: 12, width: 140 },
  kvVal: {
    flex: 1,
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) as any,
  },
  miniNote: { color: "#A3ADBA", fontSize: 12, marginTop: 10, fontStyle: "italic" },
});
