/**
 * pane-test.tsx — R&D per la "lastra di vetro rotante".
 *
 * Concetto:
 *  - Occupa lo stesso footprint dell'EclipseOrb (280×280 centrato).
 *  - Al centro un rettangolo VETRO che ruota di continuo in 3D
 *    (rotY + rotX a velocità diverse) → sembra un rombo dinamico.
 *  - Superficie LISCIA (no caustiche interne).
 *  - Bordo neon che RIFLETTE il colore di stato: viola/tiffany/rosa/champagne.
 *  - 4 pulsanti in alto per switchare colore live e validare il concetto.
 *
 * Tecnologia: Animated.View + reanimated per rotazione 3D nativa
 * (perspective + rotateX + rotateY). Dentro, un SVG che disegna il
 * rettangolo con bordo neon (stack di stroke per fake bloom) + tint
 * interno leggerissimo.
 *
 * Route pubblica: /pane-test (aggiunta a PUBLIC_ROUTES nel _layout).
 */
import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import Svg, {
  Rect,
  Defs,
  RadialGradient,
  Stop,
  Circle,
  LinearGradient,
  Path,
} from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from "react-native-reanimated";

// === COLORS (indaco identitario) ===========================================
const BG_CENTER = "#0F1030";
const BG_EDGE = "#05060F";

// === STATE COLORS ==========================================================
type StateKey = "idle" | "listening" | "thinking" | "speaking";
type StateColor = {
  label: string;
  neon: string; // colore principale del bordo
  glow: string; // colore alone (di solito uguale al neon)
  tint: string; // tinta interna leggerissima (5% opacity)
};
const STATE_COLORS: Record<StateKey, StateColor> = {
  idle: {
    label: "Champagne",
    neon: "#D4B896",
    glow: "#EAD3AC",
    tint: "#D4B896",
  },
  listening: {
    label: "Tiffany",
    neon: "#00F5D4",
    glow: "#5FFCE0",
    tint: "#00F5D4",
  },
  thinking: {
    label: "Rosa",
    neon: "#EC4899",
    glow: "#F472B6",
    tint: "#EC4899",
  },
  speaking: {
    label: "Viola",
    neon: "#BD10E0",
    glow: "#D07DFF",
    tint: "#BD10E0",
  },
};

// === SIZES =================================================================
// Stesso footprint dell'EclipseOrb (default size = 280).
const PANE_BOX = 280;
// Rettangolo rhomboid: leggermente più largo che alto (ratio ~5:3)
const RECT_W = 240;
const RECT_H = 150;

// Font
const SERIF_FONT = Platform.select({
  ios: "Didot",
  android: "serif",
  default: "serif",
});

// ============================================================================
// GlassPane — rettangolo che ruota in 3D con bordo neon
// ============================================================================
function GlassPane({ color }: { color: StateColor }) {
  // Due angoli Euler animati con velocità diverse per rotazione infinita
  // non-ripetitiva.
  const rotY = useSharedValue(0);
  const rotX = useSharedValue(0);

  React.useEffect(() => {
    rotY.value = withRepeat(
      withTiming(360, { duration: 12000, easing: Easing.linear }),
      -1,
      false
    );
    rotX.value = withRepeat(
      withTiming(360, { duration: 18000, easing: Easing.linear }),
      -1,
      false
    );
  }, [rotY, rotX]);

  // Stile animato: perspective + rotate su entrambi gli assi
  const animStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { perspective: 900 },
        { rotateY: `${rotY.value}deg` },
        { rotateX: `${rotX.value}deg` },
      ],
    };
  });

  return (
    <View style={styles.paneBox}>
      <Animated.View style={[styles.paneCore, animStyle]}>
        <Svg
          width={RECT_W + 60}
          height={RECT_H + 60}
          viewBox={`0 0 ${RECT_W + 60} ${RECT_H + 60}`}
        >
          <Defs>
            {/* Gradient interno del vetro: leggerissimo tint dal colore
                stato → più scuro in basso a destra per dare volume */}
            <LinearGradient id="paneFillGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%" stopColor={color.tint} stopOpacity="0.10" />
              <Stop offset="50%" stopColor={color.tint} stopOpacity="0.04" />
              <Stop offset="100%" stopColor={color.tint} stopOpacity="0.14" />
            </LinearGradient>

            {/* Highlight lucido dell'angolo alto-sinistra */}
            <LinearGradient id="paneShine" x1="0%" y1="0%" x2="60%" y2="60%">
              <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.35" />
              <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
            </LinearGradient>
          </Defs>

          {/* Stack di stroke esterni per fake-bloom neon */}
          {/* Alone più esterno, ampio e diffuso */}
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="none"
            stroke={color.glow}
            strokeOpacity={0.10}
            strokeWidth={22}
          />
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="none"
            stroke={color.glow}
            strokeOpacity={0.18}
            strokeWidth={14}
          />
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="none"
            stroke={color.neon}
            strokeOpacity={0.35}
            strokeWidth={8}
          />
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="none"
            stroke={color.neon}
            strokeOpacity={0.85}
            strokeWidth={3.5}
          />

          {/* Superficie di vetro riempita col gradient */}
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="url(#paneFillGrad)"
          />

          {/* Highlight lucido angolo alto-sinistra (illusione vetro liscio) */}
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="url(#paneShine)"
          />

          {/* Bordo interno crispato bianco (spigolo di vetro) */}
          <Rect
            x={30}
            y={30}
            width={RECT_W}
            height={RECT_H}
            rx={4}
            ry={4}
            fill="none"
            stroke="#FFFFFF"
            strokeOpacity={0.55}
            strokeWidth={1.2}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

// ============================================================================
// Ollenya wordmark (bottom-center)
// ============================================================================
function OllenyaWordmark() {
  return (
    <View style={styles.wordmarkCol} pointerEvents="none">
      <View style={styles.wordmarkRow}>
        <View style={styles.miniOrb}>
          <Svg width={38} height={38}>
            <Defs>
              <RadialGradient id="miniOrbGrad2" cx="42%" cy="40%" r="55%">
                <Stop offset="0%" stopColor="#F0A6FF" stopOpacity={1} />
                <Stop offset="45%" stopColor="#8B5CF6" stopOpacity={0.95} />
                <Stop offset="100%" stopColor="#14B8A6" stopOpacity={0.9} />
              </RadialGradient>
            </Defs>
            <Circle cx={19} cy={19} r={18} fill="url(#miniOrbGrad2)" />
            <Circle cx={19} cy={19} r={12} fill="#06060A" />
            <Path
              d="M 13 12 L 19 19 L 25 12 M 19 19 L 19 26"
              stroke="#F0A6FF"
              strokeWidth={1.6}
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
export default function PaneTest() {
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = useWindowDimensions();

  // Stato corrente di conversazione (simulato)
  const [state, setState] = React.useState<StateKey>("speaking");
  const color = STATE_COLORS[state];

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={false} />

      {/* Sfondo indaco radiale */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject}>
        <Defs>
          <RadialGradient id="bgGradP" cx="50%" cy="50%" r="90%">
            <Stop offset="0%" stopColor={BG_CENTER} stopOpacity={1} />
            <Stop offset="100%" stopColor={BG_EDGE} stopOpacity={1} />
          </RadialGradient>
        </Defs>
        <Path d={`M0 0 H ${9999} V ${9999} H 0 Z`} fill="url(#bgGradP)" />
      </Svg>

      {/* Lastra centrale */}
      <View style={styles.centerWrap} pointerEvents="none">
        <GlassPane color={color} />
      </View>

      {/* State selector (top) */}
      <SafeAreaView style={[styles.topBar]} edges={["top"]}>
        <View style={styles.stateRow}>
          {(Object.keys(STATE_COLORS) as StateKey[]).map((k) => {
            const c = STATE_COLORS[k];
            const active = k === state;
            return (
              <Pressable
                key={k}
                onPress={() => setState(k)}
                style={[
                  styles.stateBtn,
                  {
                    borderColor: c.neon,
                    backgroundColor: active
                      ? c.neon + "22"
                      : "rgba(255,255,255,0.02)",
                  },
                ]}
                hitSlop={4}
              >
                <View
                  style={[styles.stateDot, { backgroundColor: c.neon }]}
                />
                <Text
                  style={[
                    styles.stateLabel,
                    { color: active ? c.neon : "#B8B4C8", opacity: active ? 1 : 0.75 },
                  ]}
                >
                  {c.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>

      {/* Wordmark bottom */}
      <SafeAreaView style={styles.bottomSafe} edges={["bottom"]}>
        <OllenyaWordmark />
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
  paneBox: {
    width: PANE_BOX,
    height: PANE_BOX,
    alignItems: "center",
    justifyContent: "center",
  },
  paneCore: {
    width: RECT_W + 60,
    height: RECT_H + 60,
    alignItems: "center",
    justifyContent: "center",
  },
  topBar: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    alignItems: "center",
  },
  stateRow: {
    flexDirection: "row",
    marginTop: 44,
    gap: 6,
    paddingHorizontal: 12,
  },
  stateBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stateDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stateLabel: {
    fontSize: 11.5,
    fontFamily: SERIF_FONT,
    letterSpacing: 0.5,
  },
  bottomSafe: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: 32,
  },
  wordmarkCol: { alignItems: "center", justifyContent: "center" },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  miniOrb: { width: 38, height: 38, marginRight: 2 },
  wordText: {
    color: "#E8E4F0",
    fontSize: 30,
    fontFamily: SERIF_FONT,
    fontWeight: "300",
    letterSpacing: 4,
    includeFontPadding: false,
    textShadowColor: "rgba(180,160,220,0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  tagline: {
    marginTop: 8,
    color: "rgba(200,190,220,0.55)",
    fontSize: 10,
    fontFamily: SERIF_FONT,
    letterSpacing: 6,
    fontStyle: "italic",
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
