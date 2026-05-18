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
import * as voiceWaveform from "../lib/voiceWaveform";
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
  /** Mappa colore singolo HEX per stato — sovrascrive i default rosso/giallo/blu/bianco.
   *  Da ognuno deriviamo automaticamente la triade (chiaro, medio, scuro). */
  statePalettes?: {
    recording?: string | null;
    speaking?: string | null;
    thinking?: string | null;
    idle?: string | null;
  } | null;
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

/** Da un singolo HEX deriva la triade [chiaro, medio, scuro] usata dal blob. */
function deriveTriad(hex: string): [string, string, string] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const lighten = (v: number) => Math.min(255, Math.round(v + (255 - v) * 0.45));
  const darken = (v: number) => Math.max(0, Math.round(v * 0.6));
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return [
    `#${toHex(lighten(r))}${toHex(lighten(g))}${toHex(lighten(b))}`,
    `#${toHex(r)}${toHex(g)}${toHex(b)}`,
    `#${toHex(darken(r))}${toHex(darken(g))}${toHex(darken(b))}`,
  ];
}

// === Color palettes per texture
const TEXTURE_COLORS: Record<BlobTexture, [string, string, string]> = {
  // Spec "Sinestetica": Ascolto = colori tenui blu/viola
  morbida: ["#A78BFA", "#8B5CF6", "#6366F1"],   // viola/blu tenue (ascolto)
  vibrante: ["#86EFAC", "#22D3EE", "#06B6D4"],  // electric cyan-mint (motivante)
  solida: ["#FCA5A5", "#F87171", "#DC2626"],    // grounded red — pietra calda (sprone serio)
};

const TONE_COLORS: Record<BlobTone, [string, string, string]> = {
  neutral: ["#A78BFA", "#8B5CF6", "#7C3AED"],
  calm: ["#60A5FA", "#38BDF8", "#0EA5E9"],
  warm: ["#FCD34D", "#FBBF24", "#F59E0B"],
  energetic: ["#86EFAC", "#34D399", "#10B981"],
  concerned: ["#FDBA74", "#FB923C", "#F97316"],
  urgent: ["#FCA5A5", "#F87171", "#EF4444"],
};

// === RGB color interpolation helpers (per transizioni colore graduali)
function hexToRgb(hex: string | undefined | null): [number, number, number] {
  // Difensivo: se hex è null/undefined/non-string, ritorniamo grigio chiaro.
  if (!hex || typeof hex !== "string") return [229, 231, 235];
  const h = hex.replace("#", "");
  const v = h.length === 3
    ? h.split("").map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [v[0] || 0, v[1] || 0, v[2] || 0];
}
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
function lerpPalette(
  a: [string, string, string],
  b: [string, string, string],
  t: number
): [string, string, string] {
  return [lerpColor(a[0], b[0], t), lerpColor(a[1], b[1], t), lerpColor(a[2], b[2], t)];
}

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
  statePalettes,
  warmth = 0,
  dim = 0,
  drift = true,
  texture: textureOverride,
}: Props) {
  // === Texture resolution
  const texture: BlobTexture = textureOverride || textureFromTone(tone);

  // === Color resolution
  // SISTEMA 4 COLORI DI STATO:
  //  🔴 ROSSO       → recording  (parli TU)
  //  🟡 GIALLO      → thinking   (Coda elabora)
  //  🔵 BLU         → speaking   (parla CODA)
  //  ⚪ BIANCO/grigio → idle      (standby neutro)
  //
  // L'utente può sovrascrivere OGNI singolo stato via comando vocale →
  // statePalettes={recording, speaking, thinking, idle}. Da un singolo HEX
  // deriviamo automaticamente la triade chiaro/medio/scuro.
  const targetColors: [string, string, string] = useMemo(() => {
    // Debug visibile nei log Metro per capire se statePalettes arriva.
    if (statePalettes && typeof console !== "undefined") {
      console.log(
        "[OrganicBlob] statePalettes:",
        JSON.stringify(statePalettes),
        "| status:",
        status
      );
    }
    // Helper: prende override hex per uno stato e lo trasforma in triade
    const overrideFor = (k: "recording" | "speaking" | "thinking" | "idle") => {
      const hex = statePalettes?.[k];
      if (hex && typeof hex === "string") {
        const triad = deriveTriad(hex);
        if (triad) return triad;
      }
      return null;
    };
    if (status === "recording") {
      return overrideFor("recording") || ["#FCA5A5", "#EF4444", "#B91C1C"]; // ROSSO
    }
    if (status === "thinking") {
      return overrideFor("thinking") || ["#FDE68A", "#FACC15", "#CA8A04"]; // GIALLO
    }
    if (status === "speaking") {
      return overrideFor("speaking") || ["#93C5FD", "#3B82F6", "#1D4ED8"]; // BLU
    }
    if (customPalette) return customPalette;
    return overrideFor("idle") || ["#F3F4F6", "#E5E7EB", "#D1D5DB"]; // BIANCO neutro
  }, [status, customPalette, statePalettes]);

  // === TRANSIZIONE COLORE GRADUALE ===
  // Mantieni il colore "visualizzato" che si interpola verso targetColors
  // in 700ms con ease-out. Niente più "pam pam".
  const [colors, setDisplayColors] = useState<[string, string, string]>(targetColors);
  const fromRef = useRef<[string, string, string]>(targetColors);
  const animStartRef = useRef<number>(0);
  const targetRef = useRef<[string, string, string]>(targetColors);

  useEffect(() => {
    // Se il target non è cambiato, niente da fare
    if (
      targetRef.current[0] === targetColors[0] &&
      targetRef.current[1] === targetColors[1] &&
      targetRef.current[2] === targetColors[2]
    ) return;
    fromRef.current = colors; // parti da quello attualmente mostrato
    targetRef.current = targetColors;
    animStartRef.current = Date.now();
    const DUR = 700; // ms
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - animStartRef.current;
      const t = Math.min(1, elapsed / DUR);
      // Ease-out cubica (parte veloce, rallenta)
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayColors(lerpPalette(fromRef.current, targetRef.current, eased));
      if (t < 1) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [targetColors]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // SPEAKING → simula corde vocali: alta frequenza + ampiezza più ampia.
    // Sovrapposizione di onde porta a un'oscillazione "parlato-like".
    if (status === "speaking") {
      return { fps: 28, amplitude: 0.18, freq: 0.045, speech: true };
    }
    if (status === "recording") {
      return { fps: 20, amplitude: 0.16, freq: 0.028, speech: false };
    }
    switch (texture) {
      case "vibrante": return { fps: 22, amplitude: 0.22, freq: 0.020, speech: false };
      case "solida":   return { fps: 9,  amplitude: 0.07, freq: 0.005, speech: false };
      default:         return { fps: 15, amplitude: 0.13, freq: 0.010, speech: false }; // morbida
    }
  }, [texture, status]);

  // === Speech burst envelope — drives blob morph in sync with real audio.
  //
  // Step 3 (Fase 4): when AI is speaking, instead of a random burst we read
  // the REAL RMS amplitude of the currently playing audio (computed
  // server-side and exposed via `lib/voiceWaveform.getCurrentAmplitude()`).
  // The blob now visibly pulses on syllables, dips on pauses, and goes still
  // at the end of sentences — perfectly sync'd with what the user hears.
  //
  // Fallback: if waveform data isn't loaded yet (first ~500ms of playback,
  // OR for non-streaming TTS paths), we use a SUBTLE procedural envelope so
  // when real waveform kicks in, the visual contrast is dramatic (user sees
  // the blob "wake up" and pulse with syllables).
  const speechBurstRef = useRef<number>(1);
  // Animated value updated every 40ms from the live amplitude — drives a
  // DIRECT scale on the whole blob (so loud syllables make the blob "puff").
  const voiceAmp = useRef(new Animated.Value(0)).current;
  // Smoothed amplitude (1st-order low-pass) for visually pleasant transitions.
  const smoothedAmpRef = useRef<number>(0);
  useEffect(() => {
    if (status !== "speaking") {
      speechBurstRef.current = 1;
      smoothedAmpRef.current = 0;
      voiceAmp.setValue(0);
      return;
    }
    let cancelled = false;
    let proceduralTimer: any = null;
    const proceduralStep = () => {
      if (cancelled) return;
      // Procedural fallback INTENTIONALLY narrow (almost still). This way,
      // when real waveform data kicks in ~600ms after speech starts, the
      // blob comes ALIVE — a visually unmistakable "now I'm reacting" moment.
      const target = 0.90 + Math.random() * 0.18; // ~0.90..1.08
      speechBurstRef.current = target;
      // Procedural shows very little voice puff (just a tiny "we're alive" cue)
      voiceAmp.setValue(0.08 + Math.random() * 0.06);
      const dur = 220 + Math.random() * 180;
      proceduralTimer = setTimeout(proceduralStep, dur);
    };
    let ampSamples: number[] = [];
    let nullCount = 0;
    const realTimer = setInterval(() => {
      if (cancelled) return;
      const amp = voiceWaveform.getCurrentAmplitude();
      if (amp !== null) {
        // Low-pass smoothing so the visual flow feels analog (not jittery).
        // Faster attack (sillaba parte rapida), slower release.
        const prev = smoothedAmpRef.current;
        const target = amp;
        const alpha = target > prev ? 0.55 : 0.30; // attack vs release
        const smoothed = prev * (1 - alpha) + target * alpha;
        smoothedAmpRef.current = smoothed;

        // Map smoothed amplitude [0..1] → burst [0.4..2.4] (much wider range
        // than before for clearly visible per-point morphing).
        speechBurstRef.current = 0.4 + smoothed * 2.0;

        // Drive the WHOLE-BLOB voice puff: 0..1 mapped to scale +0..+22%.
        // This is the change that makes "Apple Siri / Apple Intelligence"
        // breathing visible — the blob itself swells on each syllable.
        voiceAmp.setValue(smoothed);

        ampSamples.push(amp);
        if (ampSamples.length === 25) {
          const min = Math.min(...ampSamples).toFixed(3);
          const max = Math.max(...ampSamples).toFixed(3);
          const avg = (ampSamples.reduce((s,v)=>s+v,0)/ampSamples.length).toFixed(3);
          console.log(`[blob amp] REAL ${ampSamples.length} samples — min=${min} max=${max} avg=${avg}`);
          ampSamples = [];
        }
        if (proceduralTimer) {
          clearTimeout(proceduralTimer);
          proceduralTimer = null;
        }
      } else {
        nullCount++;
        if (nullCount === 25) {
          console.log(`[blob amp] still NULL after 1s — waveform=${voiceWaveform.hasWaveform()}`);
          nullCount = 0;
        }
        if (!proceduralTimer) {
          proceduralStep();
        }
      }
    }, 40);
    proceduralStep();
    return () => {
      cancelled = true;
      if (proceduralTimer) clearTimeout(proceduralTimer);
      clearInterval(realTimer);
      // Smooth release of the voice puff
      Animated.timing(voiceAmp, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    };
  }, [status, voiceAmp]);

  // Drive the morph loop
  useEffect(() => {
    let running = true;
    let raf: any;
    const tick = () => {
      if (!running) return;
      // Each radius oscillates around 1.0 with its own phase + a random walk
      const burst = morphConfig.speech ? speechBurstRef.current : 1;
      const next = phases.current.map((ph, i) => {
        // Update the phase forward — speed scales with morphConfig.freq
        phases.current[i] = ph + morphConfig.freq * (12 + Math.random() * 6);
        // Sin-based oscillation, amplitude scaled per texture × burst
        const osc = Math.sin(phases.current[i]) * morphConfig.amplitude * burst;
        // Speech additional high-frequency tremor (vocal cords ~80-200Hz collapsed
        // to a low-freq visual proxy ~6-10Hz)
        const tremor = morphConfig.speech
          ? Math.sin(phases.current[i] * 3.2 + i * 0.7) * 0.04 * burst
          : 0;
        // Tiny random jitter (more for vibrante, none for solida)
        const jitter =
          texture === "vibrante"
            ? (Math.random() - 0.5) * 0.06
            : texture === "morbida"
            ? (Math.random() - 0.5) * 0.02
            : 0;
        return 1 + osc + tremor + jitter;
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

  // === Speaking pulse — slow ambient breathing (used as a backup so the
  //     blob never feels totally inert, especially during pauses between
  //     syllables when amplitude reads near zero). The real per-syllable
  //     pulsation is now driven by `voiceAmp` (see above), so we keep this
  //     loop subtle: just enough to feel alive when amp is silent.
  const speakPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status !== "speaking") {
      Animated.timing(speakPulse, { toValue: 0, duration: 350, useNativeDriver: true }).start();
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(speakPulse, { toValue: 1, duration: 950, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(speakPulse, { toValue: 0, duration: 950, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
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

  // === Container transform: drift + speak-pulse + amp puff + opacity dim
  // The voiceAmp contribution (+0..+22%) is the dominant visual cue during
  // speech — this is what makes the blob "puff" with each syllable, in
  // perfect sync with the real audio waveform.
  const totalScale = Animated.add(
    Animated.add(
      Animated.add(
        new Animated.Value(1),
        speakPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.03] })
      ),
      voiceAmp.interpolate({ inputRange: [0, 1], outputRange: [0, 0.22] })
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
