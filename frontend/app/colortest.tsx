/**
 * Pagina di test temporanea per confrontare i colori degli orb.
 * Apri /colortest nel browser preview per vedere il confronto live.
 * Da rimuovere una volta scelto il colore della voce maschile.
 */
import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";

const ORB_SIZE = 140;
const SMALL_ORB = 100;

type OrbProps = { color: string; label: string; hex: string; size?: number };

function Orb({ color, label, hex, size = ORB_SIZE }: OrbProps) {
  return (
    <View style={styles.orbWrapper}>
      <View style={styles.glowOuter}>
        <View
          style={[
            styles.glow,
            {
              backgroundColor: color,
              opacity: 0.22,
              width: size * 1.9,
              height: size * 1.9,
              borderRadius: (size * 1.9) / 2,
            },
          ]}
        />
        <View
          style={[
            styles.glow,
            {
              backgroundColor: color,
              opacity: 0.35,
              width: size * 1.4,
              height: size * 1.4,
              borderRadius: (size * 1.4) / 2,
              position: "absolute",
            },
          ]}
        />
        <View
          style={[
            styles.orb,
            {
              backgroundColor: color,
              width: size,
              height: size,
              borderRadius: size / 2,
              position: "absolute",
              shadowColor: color,
            },
          ]}
        />
      </View>
      <Text style={styles.orbLabel}>{label}</Text>
      <Text style={[styles.orbHex, { color }]}>{hex}</Text>
    </View>
  );
}

export default function ColorTest() {
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Confronto colori orb</Text>
      <Text style={styles.subtitle}>
        Recording (attuale) vs Speaking maschile (proposto)
      </Text>

      {/* Top: principale confronto */}
      <View style={styles.row}>
        <Orb color="#00F5D4" label="RECORDING" hex="#00F5D4 tiffany neon" />
        <Orb color="#4A7C59" label="SPEAKING M" hex="#4A7C59 verde salvia" />
      </View>

      <View style={styles.divider} />

      <Text style={styles.subtitle}>
        Tutti i candidati per la voce maschile
      </Text>

      {/* Reference */}
      <Text style={styles.smallTitle}>Riferimento Recording (attuale)</Text>
      <View style={styles.rowCenter}>
        <Orb color="#00F5D4" label="RECORDING" hex="#00F5D4" size={SMALL_ORB} />
      </View>

      <Text style={styles.smallTitle}>Candidati voce maschile</Text>
      <View style={styles.rowGrid}>
        <Orb color="#4A7C59" label="Verde salvia" hex="#4A7C59" size={SMALL_ORB} />
        <Orb color="#A0522D" label="Terra Siena" hex="#A0522D" size={SMALL_ORB} />
        <Orb color="#1F5F5F" label="Blu petrolio" hex="#1F5F5F" size={SMALL_ORB} />
        <Orb color="#8B5A3C" label="Bronzo caldo" hex="#8B5A3C" size={SMALL_ORB} />
      </View>

      <View style={styles.divider} />

      <Text style={styles.smallTitle}>Riferimento Speaking femminile (attuale)</Text>
      <View style={styles.rowCenter}>
        <Orb color="#BD10E0" label="SPEAKING F" hex="#BD10E0 viola elettrico" size={SMALL_ORB} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#18161C" },
  content: { padding: 24, paddingBottom: 60, alignItems: "center" },
  title: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
    textAlign: "center",
  },
  subtitle: {
    color: "#bbb",
    fontSize: 16,
    marginBottom: 28,
    textAlign: "center",
  },
  smallTitle: {
    color: "#888",
    fontSize: 13,
    letterSpacing: 1.5,
    marginTop: 16,
    marginBottom: 16,
    textTransform: "uppercase",
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-around",
    width: "100%",
    flexWrap: "wrap",
    gap: 20,
  },
  rowCenter: {
    flexDirection: "row",
    justifyContent: "center",
    width: "100%",
  },
  rowGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-around",
    width: "100%",
    gap: 12,
  },
  orbWrapper: {
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 18,
    minWidth: 160,
  },
  glowOuter: {
    width: ORB_SIZE * 2,
    height: ORB_SIZE * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  glow: {},
  orb: {
    shadowOpacity: 0.9,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
    elevation: 18,
  },
  orbLabel: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 4,
    letterSpacing: 1,
  },
  orbHex: {
    fontSize: 12,
    marginTop: 4,
    fontFamily: "Courier",
  },
  divider: {
    width: "80%",
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginVertical: 32,
  },
});
