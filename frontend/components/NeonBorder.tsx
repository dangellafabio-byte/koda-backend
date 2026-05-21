/**
 * NeonBorder v3 — bordo neon che segue il perimetro arrotondato del display
 * iOS/Android, con colori "shocking neon" intensi e glow shadow forte.
 *
 * Differenza chiave vs versione precedente:
 *  - PRIMA: 4 LinearGradient rettangolari indipendenti (top/bottom/left/right),
 *    che lasciavano scoperti gli angoli arrotondati dell'iPhone, il notch,
 *    e la home indicator. Brutto.
 *  - ADESSO: un SOLO `Animated.View` in absoluteFill con `borderWidth` +
 *    `borderRadius` ALTO. Il radius matcha quello del display (54px su iPhone
 *    moderni), così il bordo è una cornice continua perfetta. Il glow è
 *    ottenuto via `shadowColor + shadowRadius` (iOS) e `elevation` (Android).
 *
 * Bonus: l'opacity (pulse) è animata tramite useNativeDriver, fluida anche
 * sotto carico, e il color cambia via `borderColor` su rerender (transizione
 * gestita da `fade`).
 */
import React, { useEffect, useRef } from "react";
import { StyleSheet, Animated, Easing, Platform } from "react-native";

export type NeonBorderStatus = "idle" | "recording" | "thinking" | "speaking" | "confessional" | "listening";

// === COLORI SHOCKING NEON ===
// Saturazione massima, luminosità alta, sembrano "LED veri".
const STATE_COLORS: Record<NeonBorderStatus, string> = {
  // Rosa shocking — vita costante dell'app a riposo
  idle: "#FF1493",
  // Tiffany/turchese neon — registrazione attiva
  recording: "#00F5D4",
  // Tiffany più tenue per hands-free listening
  listening: "#5EEAD4",
  // Blu elettrico neon — riflessione/pensiero
  thinking: "#1E90FF",
  // Viola elettrico neon — Koda sta parlando
  speaking: "#BD10E0",
  // Scarlatto neon — sigillo Confessionale
  confessional: "#FF1744",
};

const STATE_BASE_OPACITY: Record<NeonBorderStatus, number> = {
  idle: 0.55,         // discreto ma sempre vivo
  recording: 1.0,
  listening: 0.85,
  thinking: 1.0,
  speaking: 1.0,
  confessional: 1.0,
};

// Cicli di pulsazione (ms) — più lento = più "calmo".
const STATE_CYCLE_MS: Record<NeonBorderStatus, number> = {
  idle: 4000,         // respiro lento, quasi impercettibile
  recording: 1100,
  listening: 1500,
  thinking: 1900,
  speaking: 900,
  confessional: 1700,
};

export default function NeonBorder({
  status,
  thickness = 3,
}: {
  status: NeonBorderStatus;
  thickness?: number;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const color = STATE_COLORS[status];
  const baseOp = STATE_BASE_OPACITY[status] ?? 1;
  const cycleMs = STATE_CYCLE_MS[status] ?? 1800;

  // Fade-in al cambio di stato (transizione fluida tra colori)
  useEffect(() => {
    Animated.timing(fade, {
      toValue: baseOp,
      duration: 350,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [baseOp, fade]);

  // Pulsazione "respiro" del bordo
  useEffect(() => {
    pulse.setValue(0);
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: cycleMs / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: cycleMs / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [cycleMs, pulse]);

  // opacity finale = fade × interp(pulse 0..1 → 0.45..1)
  // Così il bordo non scompare mai del tutto durante un loop, ma respira.
  const opacity = Animated.multiply(
    fade,
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] })
  );

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.frame,
        {
          borderColor: color,
          borderWidth: thickness,
          // Radius alto per matchare il rounding del display moderno.
          // iPhone 13 Pro/14/15 hanno ~50-55px di radius display.
          // Su Android moderni il radius è simile.
          borderRadius: 56,
          opacity,
          // Glow neon via shadow (iOS) ed elevation (Android).
          ...Platform.select({
            ios: {
              shadowColor: color,
              shadowOpacity: 1,
              shadowRadius: 28,
              shadowOffset: { width: 0, height: 0 },
            },
            android: { elevation: 18 },
            default: {},
          }),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
  },
});
