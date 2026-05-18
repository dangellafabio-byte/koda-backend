/**
 * EclipseOrb — La nuova presenza di L'Amico Fraterno.
 *
 * METAFORA: "L'Eclissi Dinamica".
 *
 * Un disco nero perfetto al centro dello schermo (= silenzio, ombra,
 * scatola nera emotiva, custode dei segreti). Dietro di lui una sorgente
 * di luce viva — un'aurora boreale che pulsa, emerge dai bordi e si ritira
 * a seconda dello stato:
 *
 *   • idle      → respiro lentissimo, aurora discreta, neutra
 *   • recording → la luce si RITRAE verso l'interno (sta assorbendo
 *                 le tue parole), colore freddo
 *   • thinking  → flickering breve (pensiero, esitazione)
 *   • speaking  → l'aurora ESPLODE da dietro il disco, filamenti
 *                 luminosi si estendono, colore = tono emotivo della frase
 *
 * COSTRUZIONE (tutto SVG + Animated, niente Skia, niente nuovo build EAS):
 *   Layer 0 — Halo base (radial gradient grande dietro tutto)
 *   Layer 1 — 4 filamenti (radial gradients off-center che ruotano)
 *   Layer 2 — Disco nero centrale (cerchio con leggero inner gradient)
 *   Layer 3 — Rim light (anello di luce sul bordo del disco)
 *
 * Tutte le animazioni usano useNativeDriver dove possibile (rotate,
 * scale, opacity, translateX) → 60fps garantiti.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { View, StyleSheet, Animated, Easing } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";

export type OrbStatus = "idle" | "recording" | "transcribing" | "thinking" | "speaking";
export type OrbTone =
  | "neutral"
  | "calm"
  | "warm"
  | "energetic"
  | "concerned"
  | "urgent";

type Props = {
  status: OrbStatus;
  /** Tone of the latest AI reply — drives aurora color when speaking. */
  tone?: OrbTone | null;
  /** Total square size in px. Default 280. */
  size?: number;
  /** Live mic dB during recording — drives gentle inward pulse */
  meterDb?: number | null;
  meterThreshold?: number | null;
};

// === Tone → aurora palette ([bright, mid, deep])
const TONE_PALETTES: Record<OrbTone, [string, string, string]> = {
  // Oro / ambra — calore intimo, abbraccio, "ti capisco"
  warm: ["#FCD34D", "#F59E0B", "#92400E"],
  // Blu profondo — quiete, mare, respiro
  calm: ["#93C5FD", "#3B82F6", "#1E3A8A"],
  // Verde / smeraldo — vitalità, slancio, motivazione
  energetic: ["#86EFAC", "#10B981", "#064E3B"],
  // Arancio bruciato — preoccupazione lieve, attenzione
  concerned: ["#FDBA74", "#FB923C", "#7C2D12"],
  // Rosso vivo — urgenza, allarme dolce
  urgent: ["#FCA5A5", "#EF4444", "#7F1D1D"],
  // Lavanda / viola — neutralità onirica, magia
  neutral: ["#C4B5FD", "#8B5CF6", "#4C1D95"],
};

// === Color for LISTENING state (utente parla, aurora si ritira fredda)
const LISTEN_PALETTE: [string, string, string] = ["#A5F3FC", "#0891B2", "#164E63"];

export default function EclipseOrb({
  status,
  tone,
  size = 280,
  meterDb,
  meterThreshold,
}: Props) {
  // === Palette resolution: tone-driven when speaking, cool when listening,
  //     last-known-warm when thinking/idle (so the orb still has identity).
  const palette: [string, string, string] = useMemo(() => {
    if (status === "recording") return LISTEN_PALETTE;
    if (tone && TONE_PALETTES[tone]) return TONE_PALETTES[tone];
    return TONE_PALETTES.neutral;
  }, [status, tone]);

  // === Animated values — all useNativeDriver for 60fps
  // Aurora intensity (overall halo brightness): 0..1
  const auroraIntensity = useRef(new Animated.Value(0.35)).current;
  // Filament radial extension: 0 = retracted into disc, 1 = fully extended
  const filamentExtend = useRef(new Animated.Value(0.55)).current;
  // Slow continuous rotation of filament cluster (drives "dancing" feel)
  const rotation = useRef(new Animated.Value(0)).current;
  // Breath cycle (0..1..0) — always running, drives subtle scale
  const breath = useRef(new Animated.Value(0)).current;
  // Thinking flicker
  const flicker = useRef(new Animated.Value(1)).current;
  // Speech pulse — fast-ish pulse during speaking to feel "voice-alive"
  const speakPulse = useRef(new Animated.Value(0)).current;
  // Recording inward "absorption" pulse
  const listenPulse = useRef(new Animated.Value(0)).current;

  // === Continuous breath cycle (always running, regardless of status)
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 3800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 3800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

  // === Continuous slow rotation (always running, very slow — 80s per full turn)
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 80000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [rotation]);

  // === State-driven animations
  useEffect(() => {
    // Stop any inflight state animations cleanly
    auroraIntensity.stopAnimation();
    filamentExtend.stopAnimation();
    flicker.stopAnimation();
    speakPulse.stopAnimation();
    listenPulse.stopAnimation();

    if (status === "speaking") {
      // Aurora ESPLODE: alta intensità, filamenti estesi, pulse rapido
      Animated.parallel([
        Animated.timing(auroraIntensity, {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(filamentExtend, {
          toValue: 1,
          duration: 700,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
      // Speech pulse: loop continuo 600-800ms con ampiezza naturale
      const pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(speakPulse, {
            toValue: 1,
            duration: 650,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(speakPulse, {
            toValue: 0,
            duration: 750,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );
      pulseLoop.start();
      return () => pulseLoop.stop();
    }

    if (status === "recording") {
      // RITIRO: la luce si raccoglie, i filamenti si contraggono verso
      // l'interno. Effetto = "sto assorbendo le tue parole".
      Animated.parallel([
        Animated.timing(auroraIntensity, {
          toValue: 0.45,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(filamentExtend, {
          toValue: 0.25,
          duration: 800,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
      // Listen pulse: respiro lento "in entrata" (assorbimento), 1.5s ciclo
      const inhaleLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(listenPulse, {
            toValue: 1,
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(listenPulse, {
            toValue: 0,
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      inhaleLoop.start();
      return () => inhaleLoop.stop();
    }

    if (status === "thinking" || status === "transcribing") {
      // FLICKER: brevi variazioni di intensità — "battito di palpebre",
      // il pensiero che si formula (vale anche per la trascrizione).
      Animated.parallel([
        Animated.timing(auroraIntensity, {
          toValue: 0.7,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(filamentExtend, {
          toValue: 0.65,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
      // Sequenza di flicker irregolare
      const seq: Animated.CompositeAnimation[] = [];
      for (let i = 0; i < 30; i++) {
        const dim = 0.55 + Math.random() * 0.45;
        const dur = 180 + Math.random() * 220;
        seq.push(
          Animated.timing(flicker, {
            toValue: dim,
            duration: dur,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          })
        );
      }
      const flickerLoop = Animated.loop(Animated.sequence(seq));
      flickerLoop.start();
      return () => flickerLoop.stop();
    }

    // IDLE: respiro lento, aurora discreta
    Animated.parallel([
      Animated.timing(auroraIntensity, {
        toValue: 0.35,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(filamentExtend, {
        toValue: 0.55,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(flicker, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();
  }, [status, auroraIntensity, filamentExtend, flicker, speakPulse, listenPulse]);

  // === Geometry constants
  const center = size / 2;
  const discRadius = size * 0.30;   // disco nero centrale
  const haloRadius = size * 0.50;   // halo globale
  const filamentSize = size * 0.95; // ogni filamento è una "macchia di luce"

  // Pre-calc filament positions (4 filaments at 0/90/180/270° baseline,
  // each rotates around the centre).
  const FILAMENT_COUNT = 4;
  const filamentAngles = useMemo(
    () => Array.from({ length: FILAMENT_COUNT }, (_, i) => (i / FILAMENT_COUNT) * 360),
    []
  );

  // === Derived animated transforms
  // Global breath — scale 1.00..1.025 (subtle, always on)
  const breathScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.025],
  });
  // Speaking pulse — scale 1.00..1.05 + opacity boost
  const speakScale = speakPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.05],
  });
  const speakOpacityBoost = speakPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.2],
  });
  // Listen pulse — gentle inward radial pull (translate filaments inward by ~6px)
  const listenInwardPx = listenPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -8],
  });
  // Rotation deg string
  const rotateDeg = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          transform: [{ scale: breathScale }, { scale: speakScale }],
        },
      ]}
      pointerEvents="none"
    >
      {/* === Layer 0: HALO BASE (radial gradient grande, dietro tutto) */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: Animated.multiply(auroraIntensity, flicker) },
        ]}
      >
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={palette[0]} stopOpacity={0.0} />
              <Stop offset="35%" stopColor={palette[1]} stopOpacity={0.18} />
              <Stop offset="55%" stopColor={palette[1]} stopOpacity={0.32} />
              <Stop offset="75%" stopColor={palette[2]} stopOpacity={0.18} />
              <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={center} cy={center} r={haloRadius} fill="url(#halo)" />
        </Svg>
      </Animated.View>

      {/* === Layer 1: FILAMENTI (4 macchie di luce che orbitano) ===
          Ciascuno è un radial gradient off-center, che la maggior parte
          del tempo è coperto dal disco nero. Solo la parte "esterna"
          rispetto al disco si vede → effetto "aurora dietro l'eclissi".
          Ruotano insieme su tutta la cluster (Animated rotate).
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [{ rotate: rotateDeg }],
            opacity: Animated.add(
              Animated.multiply(auroraIntensity, flicker),
              speakOpacityBoost
            ),
          },
        ]}
      >
        {filamentAngles.map((baseDeg, i) => (
          <Animated.View
            key={i}
            style={[
              styles.filamentLayer,
              {
                width: filamentSize,
                height: filamentSize,
                left: (size - filamentSize) / 2,
                top: (size - filamentSize) / 2,
                // Filament is rotated to its base position
                transform: [
                  { rotate: `${baseDeg}deg` },
                  // translateY = radial extension (negative = outward from centre)
                  {
                    translateY: Animated.add(
                      Animated.multiply(
                        filamentExtend,
                        new Animated.Value(-size * 0.08)
                      ),
                      listenInwardPx
                    ),
                  },
                ],
              },
            ]}
          >
            <Svg width="100%" height="100%" viewBox="0 0 100 100">
              <Defs>
                <RadialGradient
                  id={`filament-${i}`}
                  cx="50%"
                  cy="35%"
                  r="35%"
                >
                  <Stop offset="0%" stopColor={palette[0]} stopOpacity={0.85} />
                  <Stop offset="40%" stopColor={palette[1]} stopOpacity={0.45} />
                  <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx="50" cy="50" r="50" fill={`url(#filament-${i})`} />
            </Svg>
          </Animated.View>
        ))}
      </Animated.View>

      {/* === Layer 2: RIM LIGHT (sottile anello di luce sul bordo del disco) ===
          Si vede SOPRA i filamenti ma SOTTO il disco nero. Serve per dare
          un "bordo luminoso" netto al disco, come se la luce filtrasse dai
          bordi dell'eclissi.
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: Animated.multiply(auroraIntensity, flicker) },
        ]}
      >
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <RadialGradient id="rim" cx="50%" cy="50%" r="50%">
              <Stop offset={`${(discRadius / haloRadius) * 100 * 0.97}%`} stopColor={palette[0]} stopOpacity={0} />
              <Stop offset={`${(discRadius / haloRadius) * 100 * 1.01}%`} stopColor={palette[0]} stopOpacity={0.95} />
              <Stop offset={`${(discRadius / haloRadius) * 100 * 1.08}%`} stopColor={palette[1]} stopOpacity={0.55} />
              <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={center} cy={center} r={haloRadius} fill="url(#rim)" />
        </Svg>
      </Animated.View>

      {/* === Layer 3: DISCO NERO CENTRALE ===
          Cerchio perfettamente nero al centro. Un sottilissimo gradient
          interno (#000 → #0A0A12) lo fa sembrare 3D / solido, non un buco
          piatto. Resta SEMPRE al centro, non ruota e non pulsa (è
          la "scatola nera emotiva" — punto fermo).
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <RadialGradient id="disc" cx="42%" cy="38%" r="55%">
              <Stop offset="0%" stopColor="#0F0F1A" stopOpacity={1} />
              <Stop offset="60%" stopColor="#050507" stopOpacity={1} />
              <Stop offset="100%" stopColor="#000000" stopOpacity={1} />
            </RadialGradient>
          </Defs>
          <Circle cx={center} cy={center} r={discRadius} fill="url(#disc)" />
        </Svg>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  filamentLayer: {
    position: "absolute",
  },
});
