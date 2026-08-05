/**
 * /mockup-light — Design mockup screen (2026-08-04, richiesta Fabio).
 *
 * Schermata di lavoro interna per decidere la variante di **azzurro
 * diurno** per il light mode. Concept: "eclissi solare" — stesso orb del
 * dark mode ma con cielo azzurro attorno invece che indaco notturno.
 *
 * Rendering REALE (non mockup grafico):
 *   - Usa l'EclipseOrb effettivo del prodotto
 *   - Cicla automaticamente attraverso i 4 stati (idle → recording →
 *     thinking → speaking → confessional) ogni 2s
 *   - Ogni variante è wrappata in un ThemeProvider locale forzato a
 *     "giorno" → l'orb rende in modalità light (disco perlato,
 *     halo desaturato) esattamente come sarà in produzione
 *
 * Accesso: URL diretto /mockup-light — non c'è entry-point in UI.
 * Rimuovere il file (o pulire questa route) quando il colore è deciso.
 */
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import EclipseOrb, { OrbStatus, OrbTone } from "../components/EclipseOrb";
import { ThemeProvider } from "../lib/theme";

type AzureVariant = {
  key: "A" | "B" | "C";
  name: string;
  hex: string;
  desc: string;
};

const AZURE_VARIANTS: AzureVariant[] = [
  {
    key: "A",
    name: "Ceruleo Mediterraneo",
    hex: "#7FB3D5",
    desc: "Azzurro bilanciato — cielo estivo Sud Italia (S 47% · L 66%)",
  },
  {
    key: "B",
    name: "Azzurro Delft",
    hex: "#6E9DC9",
    desc: "Più scuro/deciso — vira leggermente verso blu, tinta ceramica",
  },
  {
    key: "C",
    name: "Azzurro Ceramica",
    hex: "#5A8FBF",
    desc: "Il più intenso — al limite del light mode ancora leggibile",
  },
];

type CycleStep = {
  status: OrbStatus;
  tone: OrbTone | null;
  label: string;
  color: string;
  hex: string;
};

// I 5 stati che ci interessa vedere. "confessional" non è uno status di
// OrbStatus, è un tone; lo esprimiamo passando tone="confessional" con
// status idle (l'orb applica automaticamente la palette confessional).
const STATE_CYCLE: CycleStep[] = [
  { status: "idle",      tone: null,           label: "Idle",         color: "champagne", hex: "#D4B896" },
  { status: "recording", tone: null,           label: "Recording",    color: "tiffany",   hex: "#00F5D4" },
  { status: "thinking",  tone: null,           label: "Thinking",     color: "ciclamino", hex: "#EC4899" },
  { status: "speaking",  tone: "warm",         label: "Speaking",     color: "viola",     hex: "#BD10E0" },
  { status: "idle",      tone: "confessional", label: "Confessional", color: "scarlatto", hex: "#FF1744" },
];

const CYCLE_MS = 2000;

export default function MockupLightScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [stateIdx, setStateIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(
      () => setStateIdx((n) => (n + 1) % STATE_CYCLE.length),
      CYCLE_MS
    );
    return () => clearInterval(id);
  }, [paused]);

  const current = STATE_CYCLE[stateIdx];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color="#E2E8F0" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Mockup Light Mode</Text>
          <Text style={styles.subtitle}>Eclissi solare · 3 varianti di cielo</Text>
        </View>
        <TouchableOpacity
          onPress={() => setPaused((p) => !p)}
          style={styles.pauseBtn}
          hitSlop={10}
        >
          <Ionicons
            name={paused ? "play" : "pause"}
            size={16}
            color="#1F1A36"
          />
        </TouchableOpacity>
      </View>

      <View style={styles.statusBar}>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: current.hex },
          ]}
        />
        <Text style={styles.statusText}>
          {current.label} · {current.color} ({current.hex})
        </Text>
        <View style={styles.progressPips}>
          {STATE_CYCLE.map((_, i) => (
            <View
              key={i}
              style={[
                styles.pip,
                i === stateIdx && styles.pipActive,
              ]}
            />
          ))}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40, paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {AZURE_VARIANTS.map((v) => (
          <View key={v.key} style={styles.section}>
            <View style={styles.metaRow}>
              <View
                style={[styles.swatch, { backgroundColor: v.hex }]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.variantName}>
                  {v.key} · {v.name}
                </Text>
                <Text style={styles.variantHex}>{v.hex}</Text>
                <Text style={styles.variantDesc}>{v.desc}</Text>
              </View>
            </View>
            <View style={[styles.orbFrame, { backgroundColor: v.hex }]}>
              <ThemeProvider initialName="giorno">
                <EclipseOrb
                  status={current.status}
                  tone={current.tone}
                  size={200}
                />
              </ThemeProvider>
            </View>
          </View>
        ))}

        <View style={styles.footNote}>
          <Text style={styles.footTitle}>Cosa guardare</Text>
          <Text style={styles.footBody}>
            • Il <Text style={styles.bold}>tiffany</Text> (recording) è il canary — cyan chiaro su cielo azzurro chiaro può appiattirsi. Se ne uno delle 3 varianti sparisce, quella variante è fuori.
          </Text>
          <Text style={styles.footBody}>
            {"• "}<Text style={styles.bold}>Ciclamino</Text> e <Text style={styles.bold}>viola</Text> sono complementari all{"'"}azzurro → devono saltare fuori bene in tutte e 3.
          </Text>
          <Text style={styles.footBody}>
            • <Text style={styles.bold}>Scarlatto</Text> (confessional) e <Text style={styles.bold}>champagne</Text> (idle) sono caldi/saturi → contrasto naturale col cielo freddo.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#1F1A36", // indaco notte Koda — cornice "tool"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  pauseBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#D4B896", // champagne
  },
  title: {
    color: "#E2E8F0",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  subtitle: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 2,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 12,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  statusText: {
    color: "#E2E8F0",
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  progressPips: {
    flexDirection: "row",
    gap: 4,
  },
  pip: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  pipActive: {
    backgroundColor: "#D4B896",
  },
  section: {
    marginBottom: 20,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  variantName: {
    color: "#E2E8F0",
    fontSize: 15,
    fontWeight: "700",
  },
  variantHex: {
    color: "#94A3B8",
    fontSize: 11,
    fontFamily: "SpaceMono",
    marginTop: 1,
  },
  variantDesc: {
    color: "#94A3B8",
    fontSize: 11,
    marginTop: 2,
  },
  orbFrame: {
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    // NOTE: `backgroundColor` overridden inline con la variant.hex
  },
  footNote: {
    marginTop: 8,
    padding: 16,
    borderRadius: 16,
    backgroundColor: "rgba(212,184,150,0.08)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.25)",
    gap: 8,
  },
  footTitle: {
    color: "#D4B896",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  footBody: {
    color: "#CBD5E1",
    fontSize: 12,
    lineHeight: 18,
  },
  bold: {
    color: "#E2E8F0",
    fontWeight: "700",
  },
});
