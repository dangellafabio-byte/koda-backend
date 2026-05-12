/**
 * RadialGlow — Alone radiale che parte dal centro (dove c'è il blob) e si
 * propaga verso i bordi sfumando in trasparenza. Sostituisce il vecchio
 * NeonBorder (bordi laterali) con un'aura più "viva" che sembra emanata
 * dalla macchia stessa.
 *
 * Stati & colori (coerenti con OrganicBlob):
 *  - idle       → ambra molto tenue
 *  - recording  → ambra calda viva ("tocca a te / ti ascolto")
 *  - thinking   → verde acqua ("Coda elabora")
 *  - speaking   → magenta-viola ("Coda parla")
 *
 * Implementazione: SVG fullscreen con un RadialGradient centrato.
 * Pulsa via Animated opacity (battito lento, calmo).
 */
import React, { useEffect, useRef } from "react";
import { View, StyleSheet, Animated, Easing, Dimensions } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Rect } from "react-native-svg";

export type GlowStatus = "idle" | "recording" | "thinking" | "speaking";

const STATE_COLORS: Record<GlowStatus, string> = {
  idle: "#E5E7EB",       // BIANCO/grigio neutro
  recording: "#EF4444",  // 🔴 ROSSO (parli tu)
  thinking: "#FACC15",   // 🟡 GIALLO (Coda elabora)
  speaking: "#3B82F6",   // 🔵 BLU (parla Coda)
};

// Opacità centrale (vicino al blob) in base allo stato
const STATE_OPACITY: Record<GlowStatus, number> = {
  idle: 0.08,
  recording: 0.50,
  thinking: 0.42,
  speaking: 0.55,
};

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export default function RadialGlow({
  status,
}: {
  status: GlowStatus;
}) {
  const color = STATE_COLORS[status];
  const targetOpacity = STATE_OPACITY[status];

  const opacityAnim = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  // Fade verso il target opacity allo stato corrente
  useEffect(() => {
    Animated.timing(opacityAnim, {
      toValue: targetOpacity,
      duration: 600,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [targetOpacity, opacityAnim]);

  // Pulsazione: per "speaking" simuliamo la cadenza vocale con bursts
  // rapidi e random (sillabe). Per gli altri stati, respiro regolare.
  useEffect(() => {
    if (status !== "speaking") {
      const cycleMs =
        status === "recording" ? 1400 :
        status === "thinking" ? 1100 :
        3000;
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1,
            duration: cycleMs / 2,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(pulse, {
            toValue: 0,
            duration: cycleMs / 2,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
        ])
      );
      anim.start();
      return () => anim.stop();
    }
    // SPEAKING → bursts random (sillabe), durata 80-180ms ciascuno
    let cancelled = false;
    const burst = () => {
      if (cancelled) return;
      const target = 0.3 + Math.random() * 0.7;
      const dur = 70 + Math.random() * 120;
      Animated.timing(pulse, {
        toValue: target,
        duration: dur,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start(() => {
        if (!cancelled) burst();
      });
    };
    burst();
    return () => { cancelled = true; };
  }, [status, pulse]);

  // Calcolo opacity finale come (base × (0.7..1.0) del pulse)
  const finalOpacity = Animated.multiply(
    opacityAnim,
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.0] })
  );

  const { width, height } = Dimensions.get("window");
  const W = Math.max(width, 360);
  const H = Math.max(height, 720);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          <RadialGradient
            id="glowGrad"
            cx="50%"
            cy="46%"
            r="70%"
            fx="50%"
            fy="46%"
          >
            {/* Centro: pieno (sotto il blob l'alone è massimo) */}
            <Stop offset="0%" stopColor={color} stopOpacity={1.0} />
            {/* Metà: dimezzato — l'aura sfuma morbida */}
            <Stop offset="35%" stopColor={color} stopOpacity={0.55} />
            <Stop offset="65%" stopColor={color} stopOpacity={0.18} />
            {/* Bordi: trasparente */}
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <AnimatedRect
          x={0}
          y={0}
          width={W}
          height={H}
          fill="url(#glowGrad)"
          opacity={finalOpacity as any}
        />
      </Svg>
    </View>
  );
}
