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
  Defs,
  RadialGradient,
  Stop,
  Circle,
  LinearGradient,
  Path,
} from "react-native-svg";
import Animated, {
  useSharedValue,
  useDerivedValue,
  useAnimatedProps,
  useFrameCallback,
} from "react-native-reanimated";

const AnimatedPath = Animated.createAnimatedComponent(Path);

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
const PANE_BOX = 300;
// Raggio dell'ottaedro (distanza dei 6 vertici dal centro)
const RADIUS = 105;
// Fattore di prospettiva (0 = ortografica, >0 = più prospettica)
const PERSP_K = 0.45;

// Font
const SERIF_FONT = Platform.select({
  ios: "Didot",
  android: "serif",
  default: "serif",
});

// ============================================================================
// OctaCrystal — Ottaedro 3D (bipiramide a 6 punte) che ruota in continuazione.
// 6 vertici: alto/basso/sinistra/destra/davanti/dietro.
// 12 spigoli neon glow. 8 facce triangolari semi-trasparenti (vetro).
// ============================================================================

// Vertici locali dell'ottaedro (asse Y verso il basso per convenzione SVG).
// Allungato verticalmente (1.4x) per matchare il cristallo di riferimento —
// le punte alto/basso sono più lunghe di quelle laterali.
// Ordine: 0=top, 1=bottom, 2=left, 3=right, 4=back, 5=front
const OCTA_VERTS: readonly [number, number, number][] = [
  [0, -1.4, 0], // 0: punta superiore (allungata)
  [0, 1.4, 0],  // 1: punta inferiore (allungata)
  [-1, 0, 0],   // 2: punta sinistra
  [1, 0, 0],    // 3: punta destra
  [0, 0, -1],   // 4: punta posteriore
  [0, 0, 1],    // 5: punta frontale
];

// 12 spigoli (coppie di indici vertici)
const OCTA_EDGES: readonly [number, number][] = [
  [0, 2], [0, 3], [0, 4], [0, 5], // top → 4 equatoriali
  [1, 2], [1, 3], [1, 4], [1, 5], // bottom → 4 equatoriali
  [2, 4], [4, 3], [3, 5], [5, 2], // 4 spigoli equatoriali
];

// 8 facce triangolari (per il fill vitreo interno)
const OCTA_FACES: readonly [number, number, number][] = [
  [0, 2, 4], [0, 3, 4], [0, 3, 5], [0, 2, 5], // 4 triangoli superiori
  [1, 2, 4], [1, 3, 4], [1, 3, 5], [1, 2, 5], // 4 triangoli inferiori
];

function OctaCrystal({ color }: { color: StateColor }) {
  // Clock condiviso: seconds since app start, letto in worklet
  const t = useSharedValue(0);
  useFrameCallback((info) => {
    "worklet";
    t.value = info.timestamp / 1000;
  }, true);

  // useDerivedValue calcola in worklet ogni frame:
  //  - matrice rotazione (rotY + rotX con velocità diverse)
  //  - proietta i 6 vertici in 2D con perspective
  //  - genera le stringhe path per spigoli e facce
  const geom = useDerivedValue(() => {
    "worklet";
    const tt = t.value;
    // Velocità: rotY ~30°/s (12s giro), rotX ~20°/s (18s giro)
    const ay = tt * ((Math.PI * 2) / 12);
    const ax = tt * ((Math.PI * 2) / 18);
    const sy = Math.sin(ay), cy = Math.cos(ay);
    const sx = Math.sin(ax), cx = Math.cos(ax);

    // Proietta un vertice locale (x,y,z) → schermo 2D
    const cx2 = 150; // centro X del viewBox 300×300
    const cy2 = 150;
    const projected: { x: number; y: number; z: number; p: number }[] = [];
    for (let i = 0; i < OCTA_VERTS.length; i++) {
      const [lx, ly, lz] = OCTA_VERTS[i];
      // 1) rotY: (x*cy + z*sy, y, -x*sy + z*cy)
      const x1 = lx * cy + lz * sy;
      const y1 = ly;
      const z1 = -lx * sy + lz * cy;
      // 2) rotX: (x, y*cx - z*sx, y*sx + z*cx)
      const rx = x1;
      const ry = y1 * cx - z1 * sx;
      const rz = y1 * sx + z1 * cx;
      // Prospettiva: p = 1 / (1 + z*K). z=-1 (vicino) → p ~1.82, z=1 (lontano) → p ~0.69
      const p = 1 / (1 + rz * PERSP_K);
      projected.push({
        x: cx2 + rx * RADIUS * p,
        y: cy2 + ry * RADIUS * p,
        z: rz,
        p,
      });
    }

    // Path per gli spigoli — concatenati "M x y L x y" per farli disegnare
    // in un unico Path (performance)
    let edgesD = "";
    for (let i = 0; i < OCTA_EDGES.length; i++) {
      const [a, b] = OCTA_EDGES[i];
      const va = projected[a], vb = projected[b];
      edgesD +=
        `M ${va.x.toFixed(1)} ${va.y.toFixed(1)} ` +
        `L ${vb.x.toFixed(1)} ${vb.y.toFixed(1)} `;
    }

    // Path per le facce triangolari — un unico Path con subpaths chiusi
    let facesD = "";
    for (let i = 0; i < OCTA_FACES.length; i++) {
      const [a, b, c] = OCTA_FACES[i];
      const va = projected[a], vb = projected[b], vc = projected[c];
      facesD +=
        `M ${va.x.toFixed(1)} ${va.y.toFixed(1)} ` +
        `L ${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ` +
        `L ${vc.x.toFixed(1)} ${vc.y.toFixed(1)} Z `;
    }

    // Path per i "puntini luminosi" ai 6 vertici — cerchi disegnati come
    // sub-path con M + due archi. Raggio proporzionale alla vicinanza camera
    // (vertici davanti = puntini più grandi). Generiamo 2 varianti: glow
    // (esterno, morbido) + core (bianco, più piccolo).
    let tipsGlowD = "";
    let tipsCoreD = "";
    for (let i = 0; i < projected.length; i++) {
      const v = projected[i];
      const rGlow = 5 + 5 * v.p; // v.p in [~0.69 .. ~1.82]
      const rCore = 1.5 + 1.5 * v.p;
      tipsGlowD +=
        `M ${v.x.toFixed(1)} ${v.y.toFixed(1)} ` +
        `m -${rGlow.toFixed(1)} 0 ` +
        `a ${rGlow.toFixed(1)} ${rGlow.toFixed(1)} 0 1 0 ${(rGlow * 2).toFixed(1)} 0 ` +
        `a ${rGlow.toFixed(1)} ${rGlow.toFixed(1)} 0 1 0 ${(-rGlow * 2).toFixed(1)} 0 `;
      tipsCoreD +=
        `M ${v.x.toFixed(1)} ${v.y.toFixed(1)} ` +
        `m -${rCore.toFixed(1)} 0 ` +
        `a ${rCore.toFixed(1)} ${rCore.toFixed(1)} 0 1 0 ${(rCore * 2).toFixed(1)} 0 ` +
        `a ${rCore.toFixed(1)} ${rCore.toFixed(1)} 0 1 0 ${(-rCore * 2).toFixed(1)} 0 `;
    }

    return { edgesD, facesD, tipsGlowD, tipsCoreD, verts: projected };
  });

  // Animated props per i vari layer
  const facesAP = useAnimatedProps(() => ({ d: geom.value.facesD }));
  const edgesGlowXL = useAnimatedProps(() => ({ d: geom.value.edgesD }));
  const edgesGlowL = useAnimatedProps(() => ({ d: geom.value.edgesD }));
  const edgesMid = useAnimatedProps(() => ({ d: geom.value.edgesD }));
  const edgesCore = useAnimatedProps(() => ({ d: geom.value.edgesD }));
  const edgesWhite = useAnimatedProps(() => ({ d: geom.value.edgesD }));
  const tipsGlow = useAnimatedProps(() => ({ d: geom.value.tipsGlowD }));
  const tipsCore = useAnimatedProps(() => ({ d: geom.value.tipsCoreD }));

  return (
    <View style={styles.paneBox}>
      <Svg
        width={PANE_BOX}
        height={PANE_BOX}
        viewBox={`0 0 ${PANE_BOX} ${PANE_BOX}`}
      >
        {/* Facce vitree interne — riempimento semitrasparente colore stato */}
        <AnimatedPath
          animatedProps={facesAP}
          fill={color.tint}
          fillOpacity={0.07}
          stroke="none"
        />
        {/* Secondo layer di facce con tinta diversa per creare gradiente
            interno naturale durante la rotazione (le facce che si sovrappongono
            sommano l'opacità → zone più chiare al centro) */}
        <AnimatedPath
          animatedProps={facesAP}
          fill={color.glow}
          fillOpacity={0.04}
          stroke="none"
        />

        {/* Spigoli — stack di stroke per fake bloom neon */}
        {/* Alone esterno molto diffuso */}
        <AnimatedPath
          animatedProps={edgesGlowXL}
          stroke={color.glow}
          strokeOpacity={0.10}
          strokeWidth={20}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <AnimatedPath
          animatedProps={edgesGlowL}
          stroke={color.glow}
          strokeOpacity={0.20}
          strokeWidth={11}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <AnimatedPath
          animatedProps={edgesMid}
          stroke={color.neon}
          strokeOpacity={0.50}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <AnimatedPath
          animatedProps={edgesCore}
          stroke={color.neon}
          strokeOpacity={0.95}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Filo bianco crispato al centro dello spigolo → look "vetro sottile" */}
        <AnimatedPath
          animatedProps={edgesWhite}
          stroke="#FFFFFF"
          strokeOpacity={0.60}
          strokeWidth={0.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />

        {/* Puntini luminosi ai 6 vertici — glow esterno + core bianco */}
        <AnimatedPath
          animatedProps={tipsGlow}
          fill={color.glow}
          fillOpacity={0.55}
          stroke="none"
        />
        <AnimatedPath
          animatedProps={tipsCore}
          fill="#FFFFFF"
          fillOpacity={0.90}
          stroke="none"
        />
      </Svg>
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
        <OctaCrystal color={color} />
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
    width: 300,
    height: 300,
    alignItems: "center",
    justifyContent: "center",
  },
  faceLayer: {
    position: "absolute",
    width: 300,
    height: 300,
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
