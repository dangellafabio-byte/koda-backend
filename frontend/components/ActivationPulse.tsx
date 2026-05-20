/**
 * ActivationPulse — "Sistema attivo" effect on app cold start.
 *
 * Draws a thin neon line that TRACES the entire screen perimeter starting
 * from the top-left corner, going clockwise around: top → right → bottom
 * → left, in about 1.5 seconds. Then fades out gracefully.
 *
 * Inspired by airport access gates: those black turnstiles with blue LED
 * lights that draw a frame around the glass when the system is "armed".
 *
 * Plays exactly ONCE per app cold start. Self-unmounts via onComplete.
 * Non-blocking (pointerEvents: none).
 */
import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Easing, Platform } from "react-native";

interface Props {
  /** Neon line color. Default: viola eclissi. */
  color?: string;
  /** Trace duration (ms) for the line going around the screen. */
  duration?: number;
  /** Line thickness (px). */
  thickness?: number;
  /** Called when the animation completes (and the pulse fades out). */
  onComplete?: () => void;
}

export default function ActivationPulse({
  color = "#8B5CF6",
  duration = 1500,
  thickness = 3,
  onComplete,
}: Props) {
  const phase = useRef(new Animated.Value(0)).current;     // 0..4 → 4 edges drawn
  const fade = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    // Glow breathes briefly to add life
    const glowAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0.6, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    glowAnim.start();

    Animated.sequence([
      Animated.timing(phase, {
        toValue: 4,
        duration,
        easing: Easing.linear,
        useNativeDriver: false, // width/height animations cannot use native driver
      }),
      Animated.delay(250),
      Animated.timing(fade, {
        toValue: 0,
        duration: 500,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => {
      glowAnim.stop();
      if (onComplete) onComplete();
    });
  }, [phase, fade, glow, duration, onComplete]);

  // Each edge percentage 0..100 driven by phase
  const topW = phase.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"], extrapolate: "clamp" });
  const rightH = phase.interpolate({ inputRange: [1, 2], outputRange: ["0%", "100%"], extrapolate: "clamp" });
  const bottomW = phase.interpolate({ inputRange: [2, 3], outputRange: ["0%", "100%"], extrapolate: "clamp" });
  const leftH = phase.interpolate({ inputRange: [3, 4], outputRange: ["0%", "100%"], extrapolate: "clamp" });

  const lineStyle = {
    backgroundColor: color,
    ...Platform.select({
      ios: {
        shadowColor: color,
        shadowOpacity: 1,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 12 },
      web: { boxShadow: `0 0 12px ${color}, 0 0 24px ${color}` } as any,
      default: {},
    }),
  };

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { opacity: fade }]}
      pointerEvents="none"
    >
      {/* Animated glow opacity wrapper to make all 4 edges breathe together */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glow }]} pointerEvents="none">
        {/* TOP — grows left → right */}
        <Animated.View
          style={[
            { position: "absolute", top: 0, left: 0, height: thickness, width: topW },
            lineStyle,
          ]}
        />
        {/* RIGHT — grows top → bottom */}
        <Animated.View
          style={[
            { position: "absolute", top: 0, right: 0, width: thickness, height: rightH },
            lineStyle,
          ]}
        />
        {/* BOTTOM — grows right → left */}
        <Animated.View
          style={[
            { position: "absolute", bottom: 0, right: 0, height: thickness, width: bottomW },
            lineStyle,
          ]}
        />
        {/* LEFT — grows bottom → top */}
        <Animated.View
          style={[
            { position: "absolute", bottom: 0, left: 0, width: thickness, height: leftH },
            lineStyle,
          ]}
        />
      </Animated.View>
    </Animated.View>
  );
}
