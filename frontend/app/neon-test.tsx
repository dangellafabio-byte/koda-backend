/**
 * neon-test.tsx — R&D: schermata minima con riempimento sfondo dai bordi.
 *
 * COSA CI SONO:
 *  - Sfondo indaco identitario SEMPRE (mai cambia)
 *  - Wordmark "Ollenya · Sempre con te" al centro
 *  - Neon del bordo che cambia colore in base allo stato (fade 500ms)
 *  - RIEMPIMENTO dai bordi verso il centro col colore dello stato:
 *    - Cresce durante listening (tiffany) e speaking (viola)
 *    - Si ritira su idle (champagne) e thinking (rosa)
 *  - 4 pulsanti per switchare stato + 1 pulsante "▶ Play ciclo demo"
 *    che simula un turno completo automaticamente.
 *
 * Route pubblica: /neon-test
 */
import React from "react";
import { View, Text, StyleSheet, Platform, Pressable, useWindowDimensions } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import Svg, {
  Defs,
  RadialGradient,
  Stop,
  Circle,
  Path,
  Rect,
} from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  withSequence,
  withDelay,
  Easing,
  cancelAnimation,
  runOnJS,
} from "react-native-reanimated";
import NeonBorder, { NeonBorderStatus } from "../components/NeonBorder";

const AnimatedStop = Animated.createAnimatedComponent(Stop);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

// === COLORS ================================================================
const BG_CENTER = "#0F1030";
const BG_EDGE = "#05060F";

// State → labels e hex per il riempimento sfondo
const STATE_INFO: Record<
  NeonBorderStatus,
  { label: string; hex: string; fills: boolean }
> = {
  idle: { label: "Idle · Champagne", hex: "#D4B896", fills: false },
  listening: { label: "Listening · Tiffany", hex: "#00F5D4", fills: true },
  recording: { label: "Recording · Tiffany", hex: "#00F5D4", fills: true },
  thinking: { label: "Thinking · Rosa", hex: "#EC4899", fills: false },
  speaking: { label: "Speaking · Viola", hex: "#BD10E0", fills: true },
};

const STATES: NeonBorderStatus[] = ["idle", "listening", "thinking", "speaking"];

const SERIF_FONT = Platform.select({
  ios: "Didot",
  android: "serif",
  default: "serif",
});

// ============================================================================
// EdgeFill — riempimento animato dai bordi verso il centro.
//
// Approccio: una Rect a schermo intero riempita con un radial gradient FISSO
// (centro trasparente, bordo colorato saturo). La OPACITY complessiva della
// Rect viene animata da 0 (invisibile) a 1 (piena) col crescere di `progress`.
// Percettivamente: quando progress cresce, il colore diventa visibile
// partendo dai bordi (dove il gradient è più saturo) verso l'interno.
// ============================================================================
function EdgeFill({
  color,
  progress,
}: {
  color: string;
  progress: Animated.SharedValue<number>;
}) {
  const { width: SW, height: SH } = useWindowDimensions();
  // Anima l'opacity della Rect dal valore progress
  const rectAP = useAnimatedProps(() => ({
    opacity: progress.value,
  }));

  return (
    <Svg
      width={SW}
      height={SH}
      style={StyleSheet.absoluteFillObject}
      pointerEvents="none"
    >
      <Defs>
        <RadialGradient
          id="edgeFillGrad"
          cx="50%"
          cy="50%"
          rx="75%"
          ry="75%"
          fx="50%"
          fy="50%"
        >
          {/* Center totalmente trasparente per almeno il primo 30% */}
          <Stop offset="0" stopColor={color} stopOpacity={0} />
          <Stop offset="0.35" stopColor={color} stopOpacity={0} />
          {/* Poi cresce gradualmente */}
          <Stop offset="0.65" stopColor={color} stopOpacity={0.25} />
          <Stop offset="0.85" stopColor={color} stopOpacity={0.50} />
          <Stop offset="1" stopColor={color} stopOpacity={0.70} />
        </RadialGradient>
      </Defs>
      <AnimatedRect
        animatedProps={rectAP}
        x={0}
        y={0}
        width={SW}
        height={SH}
        fill="url(#edgeFillGrad)"
      />
    </Svg>
  );
}

// ============================================================================
// Ollenya wordmark (CENTER)
// ============================================================================
function OllenyaWordmark() {
  return (
    <View style={styles.wordmarkCol} pointerEvents="none">
      <View style={styles.wordmarkRow}>
        <View style={styles.miniOrb}>
          <Svg width={50} height={50}>
            <Defs>
              <RadialGradient id="miniOrbGradN2" cx="42%" cy="40%" r="55%">
                <Stop offset="0%" stopColor="#F0A6FF" stopOpacity={1} />
                <Stop offset="45%" stopColor="#8B5CF6" stopOpacity={0.95} />
                <Stop offset="100%" stopColor="#14B8A6" stopOpacity={0.9} />
              </RadialGradient>
            </Defs>
            <Circle cx={25} cy={25} r={24} fill="url(#miniOrbGradN2)" />
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
  const [autoplay, setAutoplay] = React.useState(false);

  const info = STATE_INFO[state];

  // Progress del riempimento sfondo. Anima automaticamente in base a stato.
  const progress = useSharedValue(0);

  // Quando lo stato cambia manualmente, animiamo il progress:
  // - listening/speaking → cresce a 1 in 2s
  // - thinking/idle → ritorna a 0 in 700ms
  React.useEffect(() => {
    cancelAnimation(progress);
    if (info.fills) {
      progress.value = withTiming(1, {
        duration: 2000,
        easing: Easing.out(Easing.quad),
      });
    } else {
      progress.value = withTiming(0, {
        duration: 700,
        easing: Easing.out(Easing.quad),
      });
    }
  }, [state, info.fills, progress]);

  // === Autoplay ciclo demo ===
  const autoplayRef = React.useRef<{ cancelled: boolean }>({ cancelled: false });
  React.useEffect(() => {
    if (!autoplay) {
      autoplayRef.current.cancelled = true;
      return;
    }
    autoplayRef.current = { cancelled: false };
    const wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const cycle = async () => {
      while (!autoplayRef.current.cancelled) {
        // 1) Idle 1.8s
        setState("idle");
        await wait(1800);
        if (autoplayRef.current.cancelled) return;
        // 2) Listening (utente parla) 4.5s
        setState("listening");
        await wait(4500);
        if (autoplayRef.current.cancelled) return;
        // 3) Thinking 1.5s
        setState("thinking");
        await wait(1500);
        if (autoplayRef.current.cancelled) return;
        // 4) Speaking (Ollenya risponde) 5s
        setState("speaking");
        await wait(5000);
        if (autoplayRef.current.cancelled) return;
      }
    };
    cycle();
    return () => {
      autoplayRef.current.cancelled = true;
    };
  }, [autoplay]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={false} />

      {/* Sfondo indaco radiale — SEMPRE presente, mai cambia */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject}>
        <Defs>
          <RadialGradient id="bgGradNT2" cx="50%" cy="50%" r="90%">
            <Stop offset="0%" stopColor={BG_CENTER} stopOpacity={1} />
            <Stop offset="100%" stopColor={BG_EDGE} stopOpacity={1} />
          </RadialGradient>
        </Defs>
        <Path d={`M0 0 H ${9999} V ${9999} H 0 Z`} fill="url(#bgGradNT2)" />
      </Svg>

      {/* Riempimento dai bordi (sopra l'indaco, sotto tutto il resto) */}
      <EdgeFill color={info.hex} progress={progress} />

      {/* Neon border — sopra il fill */}
      <NeonBorder status={state} />

      {/* Wordmark centro */}
      <View style={styles.centerWrap} pointerEvents="none">
        <OllenyaWordmark />
      </View>

      {/* Controlli in basso */}
      <SafeAreaView style={styles.bottomBar} edges={["bottom"]}>
        <View style={styles.stateColumn}>
          {STATES.map((k) => {
            const s = STATE_INFO[k];
            const active = k === state;
            return (
              <Pressable
                key={k}
                onPress={() => {
                  setAutoplay(false);
                  setState(k);
                }}
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
                <View style={[styles.stateDot, { backgroundColor: s.hex }]} />
                <Text
                  style={[
                    styles.stateLabel,
                    {
                      color: active ? s.hex : "#B8B4C8",
                      opacity: active ? 1 : 0.8,
                    },
                  ]}
                >
                  {s.label}
                </Text>
              </Pressable>
            );
          })}

          {/* Play ciclo demo */}
          <Pressable
            onPress={() => setAutoplay((v) => !v)}
            style={[
              styles.playBtn,
              {
                backgroundColor: autoplay
                  ? "rgba(255,255,255,0.10)"
                  : "rgba(255,255,255,0.03)",
                borderColor: autoplay ? "#FFFFFF" : "rgba(255,255,255,0.35)",
              },
            ]}
          >
            <Text style={styles.playLabel} allowFontScaling={false}>
              {autoplay
                ? "◼  Stop ciclo demo"
                : "▶  Play ciclo demo (idle→listen→think→speak…)"}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>

      {/* Back */}
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
    minWidth: 240,
    justifyContent: "center",
  },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  stateLabel: {
    fontSize: 13,
    fontFamily: SERIF_FONT,
    letterSpacing: 0.5,
  },
  playBtn: {
    marginTop: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  playLabel: {
    color: "#EFEDF6",
    fontSize: 12,
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
