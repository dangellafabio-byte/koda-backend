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
// Cristallo affusolato — più alto che largo. PANE_BOX segue il footprint
// dell'EclipseOrb ma verticalmente più esteso per accomodare l'elongazione.
const PANE_BOX = 380;
// Raggio dell'ottaedro (distanza dei vertici equatoriali dal centro)
const RADIUS = 70;
// Fattore di prospettiva (0 = ortografica, >0 = più prospettica)
const PERSP_K = 0.35;

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
// Allungato verticalmente (2.2x) per matchare il cristallo affusolato del
// riferimento — le punte alto/basso sono molto più lunghe di quelle laterali.
// Ordine: 0=top, 1=bottom, 2=left, 3=right, 4=back, 5=front
const OCTA_VERTS: readonly [number, number, number][] = [
  [0, -2.2, 0], // 0: punta superiore (molto allungata)
  [0, 2.2, 0],  // 1: punta inferiore (molto allungata)
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
    const cx2 = PANE_BOX / 2;
    const cy2 = PANE_BOX / 2;
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

    // === FACCE — separo in 3 bucket per luminosità (fake lighting) ========
    // Simuliamo una sorgente luce da alto-sinistra-avanti (normale L = -0.5,-0.5,-0.7).
    // Per ogni faccia calcoliamo la normale ruotata e il dot product con L.
    // Le facce che "riflettono" verso la camera → BRIGHT, quelle laterali →
    // MEDIUM, quelle dietro → DARK. Concateno i path di ogni bucket in un
    // unico stringa e li disegno con 3 AnimatedPath a opacità fissa diverse.
    let facesBrightD = "";
    let facesMediumD = "";
    let facesDarkD = "";
    let facesRimD = ""; // faccia più luminosa: highlight lucido bianco

    // Direzione luce (normalizzata approssimativamente)
    const LX = -0.5, LY = -0.4, LZ = -0.75;

    // Trovo la faccia più luminosa per il rim highlight
    let maxBright = -Infinity;
    let brightestFaceD = "";

    for (let i = 0; i < OCTA_FACES.length; i++) {
      const [ia, ib, ic] = OCTA_FACES[i];
      // Vertici in coordinate 3D già ruotate (le riprendo dal local rotato)
      const [ax, ay0, az] = OCTA_VERTS[ia];
      const [bx, by0, bz] = OCTA_VERTS[ib];
      const [cx3, cy3, cz3] = OCTA_VERTS[ic];
      // Riapplico rotazione (necessario perché serve normale in world space)
      const rotP = (x: number, y: number, z: number) => {
        const x1 = x * cy + z * sy;
        const y1 = y;
        const z1 = -x * sy + z * cy;
        return [x1, y1 * cx - z1 * sx, y1 * sx + z1 * cx];
      };
      const A = rotP(ax, ay0, az);
      const B = rotP(bx, by0, bz);
      const C = rotP(cx3, cy3, cz3);
      // Normale = (B-A) × (C-A)
      const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
      const e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const nnx = nx / nlen, nny = ny / nlen, nnz = nz / nlen;
      // Dot product con la direzione luce (rovesciata: quanto la faccia riflette
      // verso la luce). Range [-1, 1] → mappo a [0, 1].
      const dot = nnx * LX + nny * LY + nnz * LZ;
      const bright = Math.max(0, dot); // solo facce esposte

      // Solo facce anteriori (centroidZ < 0.1) contribuiscono al render
      // (le altre sono nascoste dietro le anteriori — SVG non fa depth-test
      // ma il layering visivo funziona bene se le disegniamo in ordine)
      const va = projected[ia], vb = projected[ib], vc = projected[ic];
      const centroidZ = (va.z + vb.z + vc.z) / 3;

      const seg =
        `M ${va.x.toFixed(1)} ${va.y.toFixed(1)} ` +
        `L ${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ` +
        `L ${vc.x.toFixed(1)} ${vc.y.toFixed(1)} Z `;

      if (centroidZ < 0.1) {
        // Faccia visibile (davanti)
        if (bright > 0.55) facesBrightD += seg;
        else if (bright > 0.20) facesMediumD += seg;
        else facesDarkD += seg;

        if (bright > maxBright) {
          maxBright = bright;
          brightestFaceD = seg;
        }
      } else {
        // Faccia posteriore — sempre in bucket "dark" (rifrazione)
        facesDarkD += seg;
      }
    }
    facesRimD = brightestFaceD;

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

    return { edgesD, facesBrightD, facesMediumD, facesDarkD, facesRimD, tipsGlowD, tipsCoreD, verts: projected };
  });

  // Animated props per i vari layer
  const facesBrightAP = useAnimatedProps(() => ({ d: geom.value.facesBrightD }));
  const facesMediumAP = useAnimatedProps(() => ({ d: geom.value.facesMediumD }));
  const facesDarkAP = useAnimatedProps(() => ({ d: geom.value.facesDarkD }));
  const facesRimAP = useAnimatedProps(() => ({ d: geom.value.facesRimD }));
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
        <Defs>
          {/* Alone volumetrico dietro al cristallo (radial gradient
              del colore stato che sfuma verso l'esterno) */}
          <RadialGradient id="ambientGlow" cx="50%" cy="50%" r="45%">
            <Stop offset="0%" stopColor={color.glow} stopOpacity="0.25" />
            <Stop offset="40%" stopColor={color.glow} stopOpacity="0.10" />
            <Stop offset="100%" stopColor={color.glow} stopOpacity="0" />
          </RadialGradient>
          {/* Gradient per il rim highlight bianco sulla faccia più luminosa */}
          <LinearGradient id="rimShine" x1="0%" y1="0%" x2="50%" y2="80%">
            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.45" />
            <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </LinearGradient>
        </Defs>

        {/* Alone volumetrico ambient — SEMPRE dietro tutto */}
        <Path
          d={`M0 0 H ${PANE_BOX} V ${PANE_BOX} H 0 Z`}
          fill="url(#ambientGlow)"
        />

        {/* === FACCE VETROSE — 3 bucket per fake lighting =================== */}
        {/* DARK: facce posteriori e in ombra (rifrazione tenue) */}
        <AnimatedPath
          animatedProps={facesDarkAP}
          fill={color.tint}
          fillOpacity={0.06}
          stroke="none"
        />
        {/* MEDIUM: facce laterali (rifrazione media) */}
        <AnimatedPath
          animatedProps={facesMediumAP}
          fill={color.tint}
          fillOpacity={0.16}
          stroke="none"
        />
        {/* BRIGHT: facce che riflettono verso la luce (piene) */}
        <AnimatedPath
          animatedProps={facesBrightAP}
          fill={color.tint}
          fillOpacity={0.32}
          stroke="none"
        />
        {/* BRIGHT overlay glow: layer extra per far brillare la faccia più esposta */}
        <AnimatedPath
          animatedProps={facesBrightAP}
          fill={color.glow}
          fillOpacity={0.18}
          stroke="none"
        />
        {/* RIM shine bianco sulla faccia più luminosa (specular highlight) */}
        <AnimatedPath
          animatedProps={facesRimAP}
          fill="url(#rimShine)"
          stroke="none"
        />

        {/* === SPIGOLI — sottili, solo per definire i bordi del cristallo === */}
        {/* Bloom morbido esterno */}
        <AnimatedPath
          animatedProps={edgesGlowXL}
          stroke={color.glow}
          strokeOpacity={0.15}
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <AnimatedPath
          animatedProps={edgesGlowL}
          stroke={color.glow}
          strokeOpacity={0.28}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Bordo core sottile — non più "wireframe" ma sottile spigolo di vetro */}
        <AnimatedPath
          animatedProps={edgesCore}
          stroke={color.neon}
          strokeOpacity={0.65}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Highlight bianco sottilissimo — il "riflesso" sullo spigolo */}
        <AnimatedPath
          animatedProps={edgesWhite}
          stroke="#FFFFFF"
          strokeOpacity={0.55}
          strokeWidth={0.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />

        {/* === PUNTE — glow esterno + core bianco brillante ================= */}
        <AnimatedPath
          animatedProps={tipsGlow}
          fill={color.glow}
          fillOpacity={0.65}
          stroke="none"
        />
        <AnimatedPath
          animatedProps={tipsCore}
          fill="#FFFFFF"
          fillOpacity={0.95}
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
