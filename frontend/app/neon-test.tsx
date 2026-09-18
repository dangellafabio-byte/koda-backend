/**
 * neon-test.tsx — R&D: schermata minima.
 *
 * SOLO:
 *  - Sfondo indaco identitario
 *  - Wordmark "Ollenya · Sempre con te" al centro
 *  - Neon del bordo che cambia colore in base allo stato
 *  - 4 pulsanti in basso per switchare stato live
 *
 * Nessun orb, nessun cristallo, nessun velo. Pura esperienza di stato
 * attraverso il colore.
 *
 * Route pubblica: /neon-test
 */
import React from "react";
import { View, Text, StyleSheet, Platform, Pressable } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import Svg, {
  Defs,
  RadialGradient,
  Stop,
  Circle,
  Path,
} from "react-native-svg";
import NeonBorder, { NeonBorderStatus } from "../components/NeonBorder";

// === COLORS ================================================================
const BG_CENTER = "#0F1030";
const BG_EDGE = "#05060F";

// State → labels (colori sono già dentro NeonBorder)
const STATES: { key: NeonBorderStatus; label: string; hex: string }[] = [
  { key: "idle", label: "Idle · Champagne", hex: "#D4B896" },
  { key: "listening", label: "Listening · Tiffany", hex: "#00F5D4" },
  { key: "thinking", label: "Thinking · Rosa", hex: "#EC4899" },
  { key: "speaking", label: "Speaking · Viola", hex: "#BD10E0" },
];

// Font
const SERIF_FONT = Platform.select({
  ios: "Didot",
  android: "serif",
  default: "serif",
});

// ============================================================================
// Ollenya wordmark (CENTER of screen)
// ============================================================================
function OllenyaWordmark() {
  return (
    <View style={styles.wordmarkCol} pointerEvents="none">
      <View style={styles.wordmarkRow}>
        <View style={styles.miniOrb}>
          <Svg width={50} height={50}>
            <Defs>
              <RadialGradient id="miniOrbGradN" cx="42%" cy="40%" r="55%">
                <Stop offset="0%" stopColor="#F0A6FF" stopOpacity={1} />
                <Stop offset="45%" stopColor="#8B5CF6" stopOpacity={0.95} />
                <Stop offset="100%" stopColor="#14B8A6" stopOpacity={0.9} />
              </RadialGradient>
            </Defs>
            <Circle cx={25} cy={25} r={24} fill="url(#miniOrbGradN)" />
            <Circle cx={25} cy={25} r={16} fill="#06060A" />
            <Path
              d="M 18 16 L 25 25 L 32 16 M 25 25 L 25 34"
              stroke="#F0A6FF"
              strokeWidth={2}
              strokeLinecap="round"
              fill="none"
            />
          </Svg>
        </View>
        <Text style={styles.wordText} allowFontScaling={false}>
          LLENYA
        </Text>
      </View>
      <Text style={styles.tagline} allowFontScaling={false}>
        SEMPRE  CON  TE
      </Text>
    </View>
  );
}

// ============================================================================
// Screen
// ============================================================================
export default function NeonTest() {
  const insets = useSafeAreaInsets();
  const [state, setState] = React.useState<NeonBorderStatus>("idle");

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={false} />

      {/* Sfondo indaco radiale */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject}>
        <Defs>
          <RadialGradient id="bgGradNT" cx="50%" cy="50%" r="90%">
            <Stop offset="0%" stopColor={BG_CENTER} stopOpacity={1} />
            <Stop offset="100%" stopColor={BG_EDGE} stopOpacity={1} />
          </RadialGradient>
        </Defs>
        <Path d={`M0 0 H ${9999} V ${9999} H 0 Z`} fill="url(#bgGradNT)" />
      </Svg>

      {/* NEON BORDER — cambia colore in base allo stato */}
      <NeonBorder status={state} />

      {/* Wordmark CENTRO schermo */}
      <View style={styles.centerWrap} pointerEvents="none">
        <OllenyaWordmark />
      </View>

      {/* State selector — in basso */}
      <SafeAreaView style={styles.bottomBar} edges={["bottom"]}>
        <View style={styles.stateColumn}>
          {STATES.map((s) => {
            const active = s.key === state;
            return (
              <Pressable
                key={s.key}
                onPress={() => setState(s.key)}
                style={[
                  styles.stateBtn,
                  {
                    borderColor: s.hex,
                    backgroundColor: active
                      ? s.hex + "22"
                      : "rgba(255,255,255,0.02)",
                  },
                ]}
                hitSlop={4}
              >
                <View
                  style={[styles.stateDot, { backgroundColor: s.hex }]}
                />
                <Text
                  style={[
                    styles.stateLabel,
                    {
                      color: active ? s.hex : "#B8B4C8",
                      opacity: active ? 1 : 0.75,
                    },
                  ]}
                >
                  {s.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>

      {/* Back button */}
      <Pressable
        onPress={() => {
          try {
            router.back();
          } catch {
            router.replace("/");
          }
        }}
        style={[styles.backBtn, { top: insets.top + 8 }]}
        hitSlop={12}
      >
        <Text style={styles.backTxt}>‹ Indietro</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG_EDGE },
  centerWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmarkCol: { alignItems: "center", justifyContent: "center" },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  miniOrb: { width: 50, height: 50, marginRight: 2 },
  wordText: {
    color: "#E8E4F0",
    fontSize: 42,
    fontFamily: SERIF_FONT,
    fontWeight: "300",
    letterSpacing: 6,
    includeFontPadding: false,
    textShadowColor: "rgba(180,160,220,0.4)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  tagline: {
    marginTop: 12,
    color: "rgba(210,200,230,0.7)",
    fontSize: 12,
    fontFamily: SERIF_FONT,
    letterSpacing: 8,
    fontStyle: "italic",
  },
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: 20,
  },
  stateColumn: {
    flexDirection: "column",
    gap: 8,
    paddingHorizontal: 12,
  },
  stateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 220,
    justifyContent: "center",
  },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  stateLabel: {
    fontSize: 13,
    fontFamily: SERIF_FONT,
    letterSpacing: 0.5,
  },
  backBtn: {
    position: "absolute",
    left: 14,
    padding: 6,
  },
  backTxt: {
    color: "rgba(220,220,240,0.7)",
    fontSize: 15,
    fontFamily: SERIF_FONT,
  },
});
