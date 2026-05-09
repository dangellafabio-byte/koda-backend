/**
 * OrganicBlob — La nuova "presenza" di Coda.
 *
 * Non è un cerchio, è una **macchia organica vivente** che:
 *  - si deforma continuamente cambiando i suoi 8 punti di controllo
 *  - vaga liberamente sullo schermo (drift X/Y autonomo)
 *  - cambia "texture" in base al tone dell'AI:
 *      • morbida   → comforting (pulsazione lenta, glow morbido, bordi sfumati)
 *      • vibrante  → motivating (deformazioni rapide, nucleo elettrico)
 *      • solida    → reminding (forma più stabile, contorno più definito)
 *  - reagisce a voce dell'utente (recording: bordi più ampi, ondulazione)
 *  - reagisce alla parola di Coda (speaking: pulsazione ritmica)
 *
 * Implementazione: SVG path con 8 punti di controllo lungo un cerchio,
 * ognuno con un radius animato indipendente. Il path Bezier interpola tra
 * questi punti → blob morphing fluido, completamente nativo, niente
 * dipendenze pesanti.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, Animated, Easing, Image } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Path, Circle, G } from "react-native-svg";

const AnimatedPath = Animated.createAnimatedComponent(Path);

export type BlobStatus = "idle" | "recording" | "thinking" | "speaking";
export type BlobTexture = "morbida" | "vibrante" | "solida";
export type BlobTone =
  | "neutral" | "calm" | "warm" | "energetic" | "concerned" | "urgent";

type Props = {
  status: BlobStatus;
  /** Live mic dB during recording — mapped to ondulazione bordi */
  meterDb?: number | null;
  meterThreshold?: number | null;
  /** Tone of the latest AI reply — selects texture + colors */
  tone?: BlobTone | null;
  /** Total square size in px. Default 240. */
  size?: number;
  /** Optional avatar inside the blob (replaces gradient core) */
  avatarUri?: string | null;
  /** Custom palette [outer, mid, core] — overrides tone-derived */
  palette?: [string, string, string] | null;
  /** Warmth 0..1 from useOrbAmbient — boosts intensity */
  warmth?: number;
  /** Dim 0..1 — fades the blob when user is silent for a long time */
  dim?: number;
  /** Drift around its centre point. Default true. */
  drift?: boolean;
  /** Texture override (debug/manual). Otherwise inferred from tone. */
  texture?: BlobTexture | null;
};

// === Map AI tone → blob texture (the "umore" of Coda)
function textureFromTone(tone: BlobTone | null | undefined): BlobTexture {
  if (!tone) return "morbida";
  if (tone === "energetic" || tone === "urgent") return "vibrante";
  if (tone === "concerned") return "solida";
  return "morbida"; // warm, calm, neutral
}

// === Color palettes per texture
const TEXTURE_COLORS: Record<BlobTexture, [string, string, string]> = {
  morbida: ["#FCD34D", "#F59E0B", "#EAB308"],   // golden warmth (like the ref mockup)
  vibrante: ["#86EFAC", "#22D3EE", "#06B6D4"],  // electric cyan-mint
  solida: ["#FCA5A5", "#F87171", "#DC2626"],    // grounded red — pietra calda
};

const TONE_COLORS: Record<BlobTone, [string, string, string]> = {
  neutral: ["#A78BFA", "#8B5CF6", "#7C3AED"],
  calm: ["#60A5FA", "#38BDF8", "#0EA5E9"],
  warm: ["#FCD34D", "#FBBF24", "#F59E0B"],
  energetic: ["#86EFAC", "#34D399", "#10B981"],
  concerned: ["#FDBA74", "#FB923C", "#F97316"],
  urgent: ["#FCA5A5", "#F87171", "#EF4444"],
};

// === Blob path generator
//
// Builds a smooth closed path via 8 control points on a circle. Each point
// has its own animated radius (rNorm[i] ∈ ~[0.85, 1.15]). The path uses
// cubic Bezier "C" segments via tangent vectors in the direction of the
// next point, which gives a smooth blob that breathes when radii change.
const POINTS = 8;
const ANGLES = Array.from({ length: POINTS }, (_, i) => (i / POINTS) * Math.PI * 2);

function buildBlobPath(
  cx: number,
  cy: number,
  baseR: number,
  rNorm: number[]
): string {
  const pts = ANGLES.map((a, i) => {
    const r = baseR * rNorm[i];
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number];
  });
  // For each segment, control points sit on the tangent at t=0 and t=1.
  // Tangent direction approximated as the perpendicular to the radius.
  const c = (pa: [number, number], pb: [number, number], aA: number, aB: number) => {
    // Distance between consecutive points along tangents (1/3 of arc)
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * 0.36;
    const tA: [number, number] = [-Math.sin(aA) * d, Math.cos(aA) * d];
    const tB: [number, number] = [Math.sin(aB) * d, -Math.cos(aB) * d];
    return {
      c1: [pa[0] + tA[0], pa[1] + tA[1]] as [number, number],
      c2: [pb[0] + tB[0], pb[1] + tB[1]] as [number, number],
    };
  };
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < POINTS; i++) {
    const next = (i + 1) % POINTS;
    const { c1, c2 } = c(pts[i], pts[next], ANGLES[i], ANGLES[next]);
    d += ` C ${c1[0].toFixed(2)} ${c1[1].toFixed(2)}, ${c2[0].toFixed(2)} ${c2[1].toFixed(2)}, ${pts[next][0].toFixed(2)} ${pts[next][1].toFixed(2)}`;
  }
  d += " Z";
  return d;
}

export default function OrganicBlob({
  status,
  meterDb,
  meterThreshold,
  tone,
  size = 240,
  avatarUri,
  palette: customPalette,
  warmth = 0,
  dim = 0,
  drift = true,
  texture: textureOverride,
}: Props) {
  // === Texture resolution
  const texture: BlobTexture = textureOverride || textureFromTone(tone);

  // === Color resolution
  const colors: [string, string, string] = useMemo(() => {
    // RECORDING wins over everything else — verde brillante per dire
    // chiaramente "ti sto ascoltando, parla". Niente pulsanti, è la
    // macchia stessa il segnale.
    if (status === "recording") return ["#86EFAC", "#22C55E", "#15803D"];
    // THINKING → viola sereno (Coda sta riflettendo)
    if (status === "thinking") return ["#C4B5FD", "#8B5CF6", "#6D28D9"];
    // SPEAKING → palette dal tone emotivo dell'AI
    if (status === "speaking" && tone && TONE_COLORS[tone]) return TONE_COLORS[tone];
    // IDLE → ambient ora-del-giorno (default warm)
    if (customPalette) return customPalette;
    return TEXTURE_COLORS[texture];
  }, [status, tone, customPalette, texture]);

  // === Blob deformation: 8 radius values that morph independently.
  //     We re-render the SVG path on each tick using JS state (60fps not
  //     required — 12-15fps morphing is plenty and keeps perf high).
  const [radii, setRadii] = useState<number[]>(
    () => Array.from({ length: POINTS }, () => 1)
  );
  const targets = useRef<number[]>(Array.from({ length: POINTS }, () => 1));
  const phases = useRef<number[]>(
    Array.from({ length: POINTS }, () => Math.random() * Math.PI * 2)
  );

  // Pick the morph rate based on texture: morbida = slow, vibrante = fast, solida = very slow
  const morphConfig = useMemo(() => {
    switch (texture) {
      case "vibrante": return { fps: 22, amplitude: 0.22, freq: 0.020 };
      case "solida":   return { fps: 9,  amplitude: 0.07, freq: 0.005 };
      default:         return { fps: 15, amplitude: 0.13, freq: 0.010 }; // morbida
    }
  }, [texture]);

  // Drive the morph loop
  useEffect(() => {
    let running = true;
    let raf: any;
    const tick = () => {
      if (!running) return;
      // Each radius oscillates around 1.0 with its own phase + a random walk
      const next = phases.current.map((ph, i) => {
        // Update the phase forward — speed scales with morphConfig.freq
        phases.current[i] = ph + morphConfig.freq * (12 + Math.random() * 6);
        // Sin-based oscillation, amplitude scaled per texture
        const osc = Math.sin(phases.current[i]) * morphConfig.amplitude;
        // Tiny random jitter (more for vibrante, none for solida)
        const jitter =
          texture === "vibrante"
            ? (Math.random() - 0.5) * 0.06
            : texture === "morbida"
            ? (Math.random() - 0.5) * 0.02
            : 0;
        return 1 + osc + jitter;
      });
      setRadii(next);
      raf = setTimeout(tick, 1000 / morphConfig.fps);
    };
    tick();
    return () => {
      running = false;
      if (raf) clearTimeout(raf);
    };
  }, [morphConfig, texture]);

  // === Drift on X/Y (the blob wanders) — Animated values, useNativeDriver
  const driftX = useRef(new Animated.Value(0)).current;
  const driftY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!drift) return;
    let stop = false;
    const amount = size * 0.08;
    const step = (val: Animated.Value, delay: number) => {
      if (stop) return;
      const target = (Math.random() * 2 - 1) * amount;
      const dur = 4500 + Math.random() * 3500;
      Animated.timing(val, {
        toValue: target,
        duration: dur,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
        delay,
      }).start(({ finished }) => finished && step(val, 0));
    };
    step(driftX, 0);
    step(driftY, 1700);
    return () => { stop = true; };
  }, [drift, size, driftX, driftY]);

  // === Speaking pulse — same idea as Orb, scales the whole blob
  const speakPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status !== "speaking") {
      Animated.timing(speakPulse, { toValue: 0, duration: 350, useNativeDriver: true }).start();
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(speakPulse, { toValue: 1, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(speakPulse, { toValue: 0, duration: 520, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [status, speakPulse]);

  // === Recording amplitude — boost a few specific radii to create a "voice ripple"
  const meterAmp = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status !== "recording" || meterDb == null) {
      Animated.timing(meterAmp, { toValue: 0, duration: 250, useNativeDriver: true }).start();
      return;
    }
    const floor = meterThreshold != null && meterThreshold > -60 ? meterThreshold : -55;
    const norm = Math.max(0, Math.min(1, (meterDb - floor) / (-10 - floor)));
    Animated.timing(meterAmp, { toValue: norm, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [status, meterDb, meterThreshold, meterAmp]);

  // === Smooth warmth & dim
  const warmthAnim = useRef(new Animated.Value(0)).current;
  const dimAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(warmthAnim, { toValue: warmth, duration: 800, useNativeDriver: true }).start();
  }, [warmth, warmthAnim]);
  useEffect(() => {
    Animated.timing(dimAnim, { toValue: dim, duration: 1200, useNativeDriver: true }).start();
  }, [dim, dimAnim]);

  // === Rebuild the SVG path each render based on current radii
  const cx = size / 2;
  const cy = size / 2;
  // Base radius leaves room for halo + meter ondulazione
  const baseR = size * 0.30;
  // When recording, slightly inflate even radii to create asymmetric ripple
  const rippleRadii = useMemo(() => {
    if (status !== "recording") return radii;
    return radii.map((r, i) => r + (i % 2 === 0 ? 0.06 : 0.02));
  }, [radii, status]);
  const blobPath = useMemo(
    () => buildBlobPath(cx, cy, baseR, rippleRadii),
    [cx, cy, baseR, rippleRadii]
  );
  // Halo path (slightly larger and softer)
  const haloPath = useMemo(
    () => buildBlobPath(cx, cy, baseR * 1.45, radii.map((r) => 1 + (r - 1) * 0.5)),
    [cx, cy, baseR, radii]
  );

  // === Container transform: drift + speak-pulse + opacity dim
  const totalScale = Animated.add(
    Animated.add(
      new Animated.Value(1),
      speakPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.06] })
    ),
    warmthAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.04] })
  );
  const containerOpacity = dimAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.3],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          opacity: containerOpacity,
          transform: [
            { translateX: driftX },
            { translateY: driftY },
            { scale: totalScale },
          ],
          pointerEvents: "none",
        },
      ]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <RadialGradient id="haloGrad" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={colors[0]} stopOpacity={texture === "solida" ? 0.45 : 0.35} />
            <Stop offset="60%" stopColor={colors[0]} stopOpacity={0.12} />
            <Stop offset="100%" stopColor={colors[0]} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="bodyGrad" cx="40%" cy="35%" r="65%">
            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity={texture === "solida" ? 0.7 : 0.95} />
            <Stop offset="35%" stopColor={colors[0]} stopOpacity={0.95} />
            <Stop offset="75%" stopColor={colors[1]} stopOpacity={0.85} />
            <Stop offset="100%" stopColor={colors[2]} stopOpacity={texture === "solida" ? 0.95 : 0.6} />
          </RadialGradient>
        </Defs>
        {/* Outer halo — wide soft glow */}
        <Path d={haloPath} fill="url(#haloGrad)" />
        {/* Main body — the blob proper */}
        <Path d={blobPath} fill="url(#bodyGrad)" />
        {/* Tiny inner spark */}
        {!avatarUri && (
          <Circle cx={cx - baseR * 0.22} cy={cy - baseR * 0.28} r={baseR * 0.13} fill="#FFFFFF" opacity={0.85} />
        )}
      </Svg>
      {avatarUri ? (
        <View style={[styles.avatarWrap, { width: baseR * 1.4, height: baseR * 1.4, borderRadius: baseR * 0.7, top: cy - baseR * 0.7, left: cx - baseR * 0.7 }]}>
          <Image source={{ uri: avatarUri }} style={{ width: "100%", height: "100%", borderRadius: baseR * 0.7 }} />
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatarWrap: {
    position: "absolute",
    overflow: "hidden",
  },
});
