/**
 * NeonBorder v4 — bordo neon arrotondato sul perimetro del display.
 *
 * Cambiamenti rispetto a v3:
 *  - PULSAZIONE LENTISSIMA E INDIPENDENTE: ~7s per ciclo per tutti gli stati,
 *    opacity oscilla 0.75 ↔ 1.0 (quasi fissa, sempre molto visibile).
 *    Non c'è sincronia con l'eclissi: il bordo "respira" per conto suo,
 *    lentamente, come una presenza costante.
 *  - THINKING = LUCE CHE GIRA attorno al perimetro: niente più pulsazione
 *    classica, mostriamo un segmento di neon che corre continuamente lungo
 *    tutto il bordo arrotondato (effetto "caricamento neon"). Bel sostituto
 *    del solito spinner.
 *  - Colori shocking neon (validati).
 */
import React, { useEffect, useMemo, useRef } from "react";
import { StyleSheet, Animated, Easing, Platform, useWindowDimensions } from "react-native";
import Svg, { Rect } from "react-native-svg";

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export type NeonBorderStatus = "idle" | "recording" | "thinking" | "speaking" | "confessional" | "listening";

// === COLORI SHOCKING NEON ===
const STATE_COLORS: Record<NeonBorderStatus, string> = {
  idle: "#FF1493",        // 🌸 Rosa shocking
  recording: "#00F5D4",   // 💎 Tiffany neon
  listening: "#5EEAD4",   // 💧 Tiffany chiaro
  thinking: "#1E90FF",    // ⚡ Blu elettrico
  speaking: "#BD10E0",    // 🟣 Viola elettrico
  confessional: "#FF1744",// ❤️‍🔥 Scarlatto
};

// Tutti gli stati hanno pulsazione MOLTO lenta (~7s), quasi immobile,
// per essere una presenza costante senza distrarre.
const SLOW_CYCLE_MS = 7000;

// Display border radius (matcha gli angoli iPhone moderni)
const DISPLAY_RADIUS = 56;

export default function NeonBorder({
  status,
  thickness = 3,
}: {
  status: NeonBorderStatus;
  thickness?: number;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const color = STATE_COLORS[status];

  // ============ PULSAZIONE LENTA (tutti gli stati tranne thinking) ============
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pulse.setValue(0);
    if (status === "thinking") return; // thinking ha la sua animazione (chase)
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: SLOW_CYCLE_MS / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: SLOW_CYCLE_MS / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [status, pulse]);

  // opacity quasi fissa: oscilla tra 0.75 e 1.0 (sempre molto visibile)
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] });

  // ============ CHASE LIGHT (solo thinking) ============
  // Animazione di un segmento di neon che corre attorno al perimetro
  // arrotondato. Usiamo SVG Rect con strokeDasharray + strokeDashoffset.
  // Il perimetro arrotondato vero è ~ 2*(W+H) - 8*r + 2*pi*r.
  const perimeter = useMemo(() => {
    const r = DISPLAY_RADIUS;
    return 2 * (W + H) - 8 * r + 2 * Math.PI * r;
  }, [W, H]);
  // Lunghezza del segmento luminoso = 25% del perimetro
  const dashLen = Math.max(80, perimeter * 0.25);
  // Pattern dash: [segmento_acceso, segmento_spento]
  const dashArray = `${dashLen} ${perimeter}`;

  const dashOffset = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    dashOffset.setValue(0);
    if (status !== "thinking") return;
    const anim = Animated.loop(
      Animated.timing(dashOffset, {
        toValue: -perimeter,
        duration: 2200, // tempo per fare un giro completo
        easing: Easing.linear,
        // strokeDashoffset NON supporta native driver
        useNativeDriver: false,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [status, perimeter, dashOffset]);

  // ============ RENDER ============
  if (status === "thinking") {
    // SVG full-screen con segmento di neon che corre attorno al perimetro
    return (
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            ...Platform.select({
              ios: {
                shadowColor: color,
                shadowOpacity: 1,
                shadowRadius: 22,
                shadowOffset: { width: 0, height: 0 },
              },
              android: { elevation: 18 },
              default: {},
            }),
          },
        ]}
      >
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <AnimatedRect
            x={thickness / 2}
            y={thickness / 2}
            width={W - thickness}
            height={H - thickness}
            rx={DISPLAY_RADIUS}
            ry={DISPLAY_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset as any}
            opacity={1}
          />
        </Svg>
      </Animated.View>
    );
  }

  // Tutti gli altri stati: bordo fisso arrotondato con pulsazione lentissima
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.frame,
        {
          borderColor: color,
          borderWidth: thickness,
          borderRadius: DISPLAY_RADIUS,
          opacity,
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
