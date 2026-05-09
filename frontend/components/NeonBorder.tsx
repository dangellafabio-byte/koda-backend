/**
 * NeonBorder — Bordo neon sui 4 lati dello schermo che pulsa col colore
 * dello stato corrente. È il **feedback periferico**: anche se non guardi
 * la macchia (es. stai guardando di sotto, stai parlando senza fissare
 * lo schermo), il colore lampeggia ai bordi e ti dice cosa fare.
 *
 * Stati:
 *  - idle        → invisibile (bordo trasparente)
 *  - recording   → verde brillante pulsante (PARLA: ti sto ascoltando)
 *  - thinking    → viola tenue (sto pensando, aspetta)
 *  - speaking    → ambra calda (sto parlando io, ascolta)
 *
 * Implementazione: 4 LinearGradient absolute lungo i bordi (top/bottom
 * nero→colore→nero, left/right idem). Pulsa via Animated opacity.
 * Pointer-events: none (non blocca i tap sotto).
 */
import React, { useEffect, useRef } from "react";
import { View, StyleSheet, Animated, Easing, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

export type NeonBorderStatus = "idle" | "recording" | "thinking" | "speaking";

const STATE_COLORS: Record<NeonBorderStatus, string | null> = {
  idle: null,                 // invisibile
  recording: "#22C55E",        // verde brillante
  thinking: "#A78BFA",         // viola tenue
  speaking: "#F59E0B",         // ambra calda
};

export default function NeonBorder({
  status,
  thickness = 22,
}: {
  status: NeonBorderStatus;
  thickness?: number;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const color = STATE_COLORS[status];

  // Fade in/out as status changes (smooth transitions)
  useEffect(() => {
    Animated.timing(fade, {
      toValue: color ? 1 : 0,
      duration: 350,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [color, fade]);

  // Pulsing — speed varies per status to feel alive
  useEffect(() => {
    if (!color) return;
    const cycleMs = status === "recording" ? 1100 : status === "speaking" ? 900 : 1800;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: cycleMs / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: cycleMs / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [color, status, pulse]);

  if (!color) {
    // Mantengo il container montato ma invisibile per evitare flicker al
    // cambio di stato. fade gestisce l'opacità.
  }

  // pulse 0..1 → opacity 0.5..1 (così non sparisce mai del tutto durante
  // un loop) moltiplicato per fade (0..1) che gestisce idle vs attivo.
  const opacity = Animated.multiply(
    fade,
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] })
  );

  // Colore con tre stop per fade ai bordi (più intenso al centro del lato)
  const transparent = color + "00";
  const mid = color + "FF";
  const edge = color + "33";

  // Common gradient style props
  const horizGrad = {
    locations: [0, 0.5, 1] as any,
    colors: [edge, mid, edge],
  };
  const vertGrad = {
    locations: [0, 0.5, 1] as any,
    colors: [edge, mid, edge],
  };

  // Each edge fades to transparent in the perpendicular direction
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* TOP */}
      <Animated.View style={[styles.edge, { top: 0, left: 0, right: 0, height: thickness, opacity }]}>
        <LinearGradient
          colors={[mid, transparent]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          colors={horizGrad.colors as any}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.6 }]}
        />
      </Animated.View>
      {/* BOTTOM */}
      <Animated.View style={[styles.edge, { bottom: 0, left: 0, right: 0, height: thickness, opacity }]}>
        <LinearGradient
          colors={[transparent, mid]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          colors={horizGrad.colors as any}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.6 }]}
        />
      </Animated.View>
      {/* LEFT */}
      <Animated.View style={[styles.edge, { top: 0, bottom: 0, left: 0, width: thickness, opacity }]}>
        <LinearGradient
          colors={[mid, transparent]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          colors={vertGrad.colors as any}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.6 }]}
        />
      </Animated.View>
      {/* RIGHT */}
      <Animated.View style={[styles.edge, { top: 0, bottom: 0, right: 0, width: thickness, opacity }]}>
        <LinearGradient
          colors={[transparent, mid]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          colors={vertGrad.colors as any}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.6 }]}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  edge: {
    position: "absolute",
    overflow: "hidden",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0,
      },
      web: {
        // a slight blur on web so the gradient feels softer
        filter: "blur(2px)",
      } as any,
    }),
  },
});
