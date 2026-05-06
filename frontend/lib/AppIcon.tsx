/**
 * AppIcon — evocative pulsing orb that represents the assistant's "presence".
 * Used as the empty state hero, onboarding hero and brand mark.
 * Pulses gently to feel alive.
 */
import React, { useEffect, useRef } from "react";
import { View, Animated, Easing, StyleSheet } from "react-native";
import { useTheme } from "./theme";

type Props = {
  size?: number;
  animate?: boolean;
};

export default function AppIcon({ size = 96, animate = true }: Props) {
  const { theme } = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [animate, pulse]);

  const ring1Scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const ring2Scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.32] });
  const ring1Opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0.18] });
  const ring2Opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.05] });

  const core = size * 0.42;
  const r1 = size * 0.7;
  const r2 = size * 0.95;

  return (
    <View
      style={[
        styles.wrap,
        { width: size, height: size },
      ]}
    >
      {/* outer pulsing ring */}
      <Animated.View
        style={[
          styles.ring,
          {
            width: r2,
            height: r2,
            borderRadius: r2 / 2,
            borderColor: theme.primary,
            opacity: ring2Opacity,
            transform: [{ scale: ring2Scale }],
          },
        ]}
      />
      {/* mid pulsing ring */}
      <Animated.View
        style={[
          styles.ring,
          {
            width: r1,
            height: r1,
            borderRadius: r1 / 2,
            borderColor: theme.primary,
            opacity: ring1Opacity,
            transform: [{ scale: ring1Scale }],
          },
        ]}
      />
      {/* glowing core */}
      <View
        style={[
          styles.core,
          {
            width: core,
            height: core,
            borderRadius: core / 2,
            backgroundColor: theme.primary,
            shadowColor: theme.primary,
          },
        ]}
      />
      {/* small white highlight on core (gives a "wet"/alive feel) */}
      <View
        style={[
          styles.highlight,
          {
            width: core * 0.32,
            height: core * 0.18,
            top: size / 2 - core * 0.4,
            left: size / 2 - core * 0.2,
            backgroundColor: theme.isDark ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.85)",
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  ring: {
    position: "absolute",
    borderWidth: 1.5,
  },
  core: {
    shadowOpacity: 0.6,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  highlight: {
    position: "absolute",
    borderRadius: 999,
    opacity: 0.7,
  },
});
