/**
 * veil-test.tsx — R&D screen per il nuovo "velo" di stato.
 *
 * Obiettivo: mostrare un velo bianco/neutro (NON colorato) che si muove
 * fluidamente come nell'acqua, senza mai toccare i bordi dello schermo.
 * Sfondo indaco identitario, wordmark "Ollenya · Sempre con te" in basso.
 *
 * Il colore sarà applicato in un secondo momento dal chiamante in base
 * allo stato conversazione (tiffany/rosa/viola). Qui il velo è pura luce
 * bianca semitrasparente per validare SOLO il movimento e la forma.
 *
 * Tecnologia: react-native-svg + reanimated. Ogni frame ricalcoliamo
 * la stringa `d` di 3 Path sovrapposti (layer front/mid/back) con
 * ampiezze/frequenze/fasi diverse. Effetto acqua: somma di seni a
 * frequenze basse (0.15-0.4 Hz) su ogni punto della spina dorsale del
 * velo + variazione dello spessore locale.
 *
 * Route pubblica: /veil-test (aggiunta a PUBLIC_ROUTES nel _layout).
 */
import React from "react";
import { View, Text, StyleSheet, Platform, Pressable } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import Svg, {
  Path,
  Defs,
  RadialGradient,
  Stop,
  Circle,
  LinearGradient,
} from "react-native-svg";
import Animated, {
  useSharedValue,
  useDerivedValue,
  useAnimatedProps,
  useFrameCallback,
} from "react-native-reanimated";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// === COLORS (validate) ======================================================
// Indaco identitario Ollenya: nero-blu profondo con leggera vignette.
const BG_CENTER = "#0F1030"; // indaco medio
const BG_EDGE = "#05060F"; // quasi nero blu

// Il velo per la prova è BIANCO — dopo verrà tintato dal caller.
const VEIL_WHITE = "#FFFFFF";

// === WORDMARK FONT ==========================================================
const SERIF_FONT = Platform.select({
  ios: "Didot",
  android: "serif",
  default: "serif",
});

// === VEIL SHAPE PARAMS ======================================================
// 11 punti di controllo lungo la spina del velo — più punti = curva più
// organica e possibilità di modulare spessore in modo fine.
const N = 11;

// Padding minimo dai bordi (percentuale schermo) — il velo NON tocca mai
// il perimetro. 6% orizzontale + 8% verticale garantiscono margine sempre.
const EDGE_PAD_X = 0.06;
const EDGE_PAD_Y = 0.08;

// Layer stack: 6 veli sovrapposti con opacity/spessore/fase/offset diversi
// = illusione di stratificazione multipla (velo di seta reale).
// vOff = vertical offset base (spostamento verticale della spina)
// I layer con vOff diverso creano ciuffi paralleli come nel riferimento.
const LAYERS = [
  { opacity: 0.05, widthMul: 1.45, phase: 0.0, speed: 0.80, amp: 1.10, vOff: -0.04 },
  { opacity: 0.06, widthMul: 1.15, phase: 1.3, speed: 0.95, amp: 0.95, vOff: -0.01 },
  { opacity: 0.08, widthMul: 0.90, phase: 2.4, speed: 1.05, amp: 0.80, vOff:  0.01 },
  { opacity: 0.09, widthMul: 0.70, phase: 3.6, speed: 1.20, amp: 0.65, vOff:  0.03 },
  { opacity: 0.11, widthMul: 0.50, phase: 4.7, speed: 1.35, amp: 0.55, vOff:  0.05 },
  { opacity: 0.13, widthMul: 0.32, phase: 5.9, speed: 1.50, amp: 0.45, vOff:  0.07 },
];

// ============================================================================
// VeilPath — un singolo layer del velo, animato con reanimated worklet.
// ============================================================================
function VeilPath({
  W,
  H,
  t,
  opacity,
  widthMul,
  phase,
  speed,
  amp,
  vOff,
}: {
  W: number;
  H: number;
  t: Animated.SharedValue<number>;
  opacity: number;
  widthMul: number;
  phase: number;
  speed: number;
  amp: number;
  vOff: number;
}) {
  const animatedProps = useAnimatedProps(() => {
    "worklet";
    const tt = t.value * speed;

    // === 1) Costruisci la SPINA del velo ===================================
    // Base = diagonale che parte in alto a sinistra (thin tail), curva
    // dolcemente in mezzo, esce a destra a metà altezza. Molto vicino
    // al reference: quasi lineare con leggera S.
    const spine: { x: number; y: number }[] = [];
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1); // 0..1 lungo la spina
      // X: distribuzione quasi lineare da EDGE_PAD_X a 1-EDGE_PAD_X
      const bx = EDGE_PAD_X + u * (1 - 2 * EDGE_PAD_X);
      // Y: parte a 0.22 (upper-left), scende dolcemente a 0.46 (mid-right).
      // L'aggiunta di un piccolo sin() dà la curvatura naturale del velo.
      const by =
        0.24 + u * 0.20 + Math.sin(u * Math.PI * 0.8) * 0.06 + vOff;

      // Perturbazione fluida: somma di seni a frequenze irrazionali
      // basse (0.15-0.6 Hz) → movimento lento come acqua.
      const dx =
        (Math.sin(tt * 0.5 + i * 0.7 + phase) * 0.022 +
          Math.sin(tt * 0.29 + i * 1.6 + phase * 1.3) * 0.013) *
        amp;
      const dy =
        (Math.cos(tt * 0.45 + i * 1.0 + phase * 0.7) * 0.030 +
          Math.sin(tt * 0.24 + i * 0.4 + phase * 1.9) * 0.016) *
        amp;

      // Clamp entro padding verticale per non uscire mai dai bordi
      const finalY = Math.max(
        EDGE_PAD_Y,
        Math.min(1 - EDGE_PAD_Y, by + dy)
      );
      spine.push({ x: (bx + dx) * W, y: finalY * H });
    }

    // === 2) Spessore locale del velo ========================================
    // Bell-curve asimmetrica: massimo shift-ato verso u=0.45 (come reference).
    // Nei tail (u<0.10 e u>0.90) larghezza tende a 0 → aspetto wispy.
    const halfWidths: number[] = [];
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      // Kernel: sin^1.5 sposta il picco verso sinistra, tail più lunghi
      const shifted = u < 0.45 ? u / 0.45 : 1 - (u - 0.45) / 0.55;
      const bell = Math.pow(Math.max(0, shifted), 1.4);
      const base = bell * 0.11 * Math.min(W, H) * widthMul;
      // Modulazione: variazione di spessore che scorre lungo il velo
      const flutter =
        Math.sin(tt * 0.9 + i * 0.55 + phase) * 4 * amp +
        Math.sin(tt * 1.7 + i * 1.8 + phase * 0.7) * 2 * amp;
      halfWidths.push(Math.max(0.3, base + flutter));
    }

    // === 3) Calcola bordi upper/lower via normale perpendicolare ===========
    const upper: { x: number; y: number }[] = [];
    const lower: { x: number; y: number }[] = [];
    for (let i = 0; i < N; i++) {
      const prev = spine[Math.max(0, i - 1)];
      const next = spine[Math.min(N - 1, i + 1)];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      tx /= len;
      ty /= len;
      // Normale = tangente ruotata 90°
      const nx = -ty;
      const ny = tx;
      const w = halfWidths[i];
      upper.push({ x: spine[i].x + nx * w, y: spine[i].y + ny * w });
      lower.push({ x: spine[i].x - nx * w, y: spine[i].y - ny * w });
    }

    // === 4) Costruisci il path con smoothing quadratic-bezier =============
    // Trick del midpoint per curva C¹-continua senza calcolare tangenti.
    const smoothChain = (pts: { x: number; y: number }[]): string => {
      if (pts.length < 2) return "";
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        d +=
          ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ` +
          `${mx.toFixed(1)} ${my.toFixed(1)}`;
      }
      const last = pts[pts.length - 1];
      d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
      return d;
    };

    const dUpper = smoothChain(upper);

    // Lower va percorso in senso inverso per chiudere il poligono.
    const lowerRev: { x: number; y: number }[] = [];
    for (let i = lower.length - 1; i >= 0; i--) lowerRev.push(lower[i]);

    let dLower = ` L ${lowerRev[0].x.toFixed(1)} ${lowerRev[0].y.toFixed(1)}`;
    for (let i = 1; i < lowerRev.length - 1; i++) {
      const mx = (lowerRev[i].x + lowerRev[i + 1].x) / 2;
      const my = (lowerRev[i].y + lowerRev[i + 1].y) / 2;
      dLower +=
        ` Q ${lowerRev[i].x.toFixed(1)} ${lowerRev[i].y.toFixed(1)} ` +
        `${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const lastLow = lowerRev[lowerRev.length - 1];
    dLower += ` L ${lastLow.x.toFixed(1)} ${lastLow.y.toFixed(1)} Z`;

    return { d: dUpper + dLower };
  });

  return (
    <AnimatedPath
      animatedProps={animatedProps}
      fill={VEIL_WHITE}
      fillOpacity={opacity}
    />
  );
}

// ============================================================================
// Ollenya wordmark (bottom-center) — replica fedele dell'immagine
// ============================================================================
function OllenyaWordmark() {
  return (
    <View style={styles.wordmarkCol} pointerEvents="none">
      <View style={styles.wordmarkRow}>
        {/* Mini eclissi al posto della O — colori identità: viola/teal/rosa */}
        <View style={styles.miniOrb}>
          <Svg width={38} height={38}>
            <Defs>
              <RadialGradient id="miniOrbGrad" cx="42%" cy="40%" r="55%">
                <Stop offset="0%" stopColor="#F0A6FF" stopOpacity={1} />
                <Stop offset="45%" stopColor="#8B5CF6" stopOpacity={0.95} />
                <Stop offset="100%" stopColor="#14B8A6" stopOpacity={0.9} />
              </RadialGradient>
            </Defs>
            <Circle cx={19} cy={19} r={18} fill="url(#miniOrbGrad)" />
            <Circle cx={19} cy={19} r={12} fill="#06060A" />
            {/* piccola Y stilizzata al centro */}
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
// Static top-left bubbles (dettaglio decorativo dell'immagine reference)
// ============================================================================
function TopBubbles({ W }: { W: number }) {
  const bubbles = [
    { x: 0.08, y: 0.02, r: 1.6, o: 0.55 },
    { x: 0.12, y: 0.05, r: 1.0, o: 0.35 },
    { x: 0.05, y: 0.08, r: 1.3, o: 0.5 },
    { x: 0.16, y: 0.11, r: 0.9, o: 0.30 },
    { x: 0.09, y: 0.13, r: 1.4, o: 0.45 },
    { x: 0.19, y: 0.16, r: 0.8, o: 0.28 },
    { x: 0.04, y: 0.18, r: 1.1, o: 0.35 },
  ];
  return (
    <Svg
      width={W}
      height={W * 0.5}
      style={{ position: "absolute", top: 0, left: 0 }}
      pointerEvents="none"
    >
      {bubbles.map((b, i) => (
        <Circle
          key={i}
          cx={b.x * W}
          cy={b.y * W * 0.9}
          r={b.r}
          fill="#B8E5DE"
          fillOpacity={b.o}
        />
      ))}
    </Svg>
  );
}

// ============================================================================
// Screen
// ============================================================================
export default function VeilTest() {
  const insets = useSafeAreaInsets();

  // Frame-driven clock (secondi) — shared value letto dai worklet SVG.
  const t = useSharedValue(0);
  useFrameCallback((info) => {
    "worklet";
    // info.timestamp è in ms
    t.value = info.timestamp / 1000;
  }, true);

  // Layout size — misuriamo il container per essere responsive
  const [size, setSize] = React.useState({ w: 0, h: 0 });

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={false} />

      {/* Sfondo indaco con vignette radiale */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFillObject}>
        <Defs>
          <RadialGradient id="bgGrad" cx="50%" cy="50%" r="90%">
            <Stop offset="0%" stopColor={BG_CENTER} stopOpacity={1} />
            <Stop offset="100%" stopColor={BG_EDGE} stopOpacity={1} />
          </RadialGradient>
        </Defs>
        <Path d={`M0 0 H ${9999} V ${9999} H 0 Z`} fill="url(#bgGrad)" />
      </Svg>

      {/* Container che misura la sua dimensione per il veil */}
      <View
        style={StyleSheet.absoluteFillObject}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width !== size.w || height !== size.h) {
            setSize({ w: width, h: height });
          }
        }}
      >
        {size.w > 0 && size.h > 0 && (
          <>
            {/* Bubbles decorative in alto a sinistra */}
            <TopBubbles W={size.w} />

            {/* IL VELO — 6 layer sovrapposti */}
            <Svg
              width={size.w}
              height={size.h}
              style={StyleSheet.absoluteFillObject}
            >
              {LAYERS.map((L, i) => (
                <VeilPath
                  key={i}
                  W={size.w}
                  H={size.h}
                  t={t}
                  opacity={L.opacity}
                  widthMul={L.widthMul}
                  phase={L.phase}
                  speed={L.speed}
                  amp={L.amp}
                  vOff={L.vOff}
                />
              ))}
            </Svg>
          </>
        )}
      </View>

      {/* Wordmark in basso */}
      <SafeAreaView style={styles.bottomSafe} edges={["bottom"]}>
        <OllenyaWordmark />
      </SafeAreaView>

      {/* Back button (dev) */}
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
  root: {
    flex: 1,
    backgroundColor: BG_EDGE,
  },
  bottomSafe: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: 32,
  },
  wordmarkCol: {
    alignItems: "center",
    justifyContent: "center",
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  miniOrb: {
    width: 38,
    height: 38,
    marginRight: 2,
  },
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
