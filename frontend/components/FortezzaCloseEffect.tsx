/**
 * FortezzaCloseEffect — animazione di chiusura del Confessionale.
 *
 * Rituale visivo che comunica all'utente: "I dati grezzi vengono bruciati,
 * niente resta, è tutto sigillato."
 *
 * Fasi:
 *  1. (0-400ms)   bagliore arancione sale dal basso (la fiamma sta nascendo)
 *  2. (400-1500ms) particelle di fiamma + fumo salgono dal centro
 *  3. (1500-2400ms) sigillo (lucchetto) appare al centro con scritta
 *  4. (2400-3000ms) tutto sfuma in nero, animazione termina
 *
 * Haptic feedback su fase 1 (ignite), fase 3 (seal), fase 4 (close).
 *
 * ⚠️ FIX 2026-07: refactor per non violare Rules of Hooks.
 *  Le particelle sono ora un sub-component <FlameParticle/> con i propri
 *  hooks. Prima erano dentro Array.from()/`.map()` con useSharedValue/
 *  useAnimatedStyle dentro callback → crash in release build (Hermes + new arch).
 */

import React, { useEffect, useMemo } from "react";
import { View, Text, StyleSheet, Dimensions, Platform } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

type Props = {
  visible: boolean;
  onComplete?: () => void;
  // Etichette localizzabili
  labels?: {
    burning?: string;       // Fase 2 → ad esempio "Bruciando..."
    sealed?: string;        // Fase 3 → ad esempio "Sigillato. Resta tra te e te."
    confirmation?: string;  // Fase 4 → ad esempio "Dato grezzo cancellato per sempre"
  };
};

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const DEFAULT_LABELS = {
  burning: "Brucia...",
  sealed: "🔥 Sigillato. Resta tra te e te.",
  confirmation: "Dato grezzo cancellato per sempre.",
};

// 14 particelle disposte casualmente sull'asse X
const PARTICLE_COUNT = 14;

type ParticleConfig = {
  x: number;
  delay: number;
  size: number;
  color: string;
};

function fireHaptic(type: "light" | "medium" | "heavy") {
  if (Platform.OS === "web") return;
  try {
    if (type === "light") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  } catch {}
}

// ──────────────────────────────────────────────────────────────────
// Sub-component: una singola particella di fiamma.
// I propri hooks (useSharedValue + useAnimatedStyle) vivono qui in modo
// sicuro, perché viene istanziato in numero fisso (PARTICLE_COUNT).
// ──────────────────────────────────────────────────────────────────
type FlameParticleProps = {
  cfg: ParticleConfig;
  trigger: boolean;
};

function FlameParticle({ cfg, trigger }: FlameParticleProps) {
  const y = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (!trigger) {
      // reset quando l'overlay viene smontato / nascosto
      y.value = 0;
      opacity.value = 0;
      return;
    }
    opacity.value = withDelay(
      cfg.delay,
      withSequence(
        withTiming(1, { duration: 200 }),
        withDelay(800, withTiming(0, { duration: 400 }))
      )
    );
    y.value = withDelay(
      cfg.delay,
      withTiming(-SCREEN_H * 0.7, { duration: 1400, easing: Easing.out(Easing.quad) })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  const pStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        styles.particle,
        {
          left: cfg.x,
          width: cfg.size,
          height: cfg.size,
          backgroundColor: cfg.color,
          shadowColor: cfg.color,
        },
        pStyle,
      ]}
    />
  );
}

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────
export default function FortezzaCloseEffect({ visible, onComplete, labels }: Props) {
  const L = { ...DEFAULT_LABELS, ...(labels || {}) };

  const containerOpacity = useSharedValue(0);
  const glowOpacity = useSharedValue(0);
  const sealScale = useSharedValue(0);
  const sealOpacity = useSharedValue(0);
  const confirmOpacity = useSharedValue(0);

  // Generato una sola volta. È solo dati, niente hooks dentro.
  const particleConfigs = useMemo<ParticleConfig[]>(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        x: (i / PARTICLE_COUNT) * SCREEN_W + (Math.random() - 0.5) * 40,
        delay: 100 + i * 60 + Math.random() * 200,
        size: 8 + Math.random() * 16,
        color: ["#FF6B35", "#FFB000", "#FF4500", "#FFD700", "#FF8C00"][i % 5],
      })),
    []
  );

  useEffect(() => {
    if (!visible) {
      // reset state quando viene chiuso
      containerOpacity.value = 0;
      glowOpacity.value = 0;
      sealScale.value = 0;
      sealOpacity.value = 0;
      confirmOpacity.value = 0;
      return;
    }

    // FASE 1: bagliore (ignite)
    fireHaptic("light");
    containerOpacity.value = withTiming(1, { duration: 200 });
    glowOpacity.value = withSequence(
      withTiming(0.6, { duration: 400, easing: Easing.out(Easing.quad) }),
      withDelay(2000, withTiming(0, { duration: 600 }))
    );

    // FASE 3: sigillo appare con piccolo "thump"
    sealOpacity.value = withDelay(1500, withTiming(1, { duration: 400 }));
    sealScale.value = withDelay(
      1500,
      withSequence(
        withTiming(1.2, { duration: 300, easing: Easing.out(Easing.back(2)) }),
        withTiming(1, { duration: 200 })
      )
    );
    const t1 = setTimeout(() => fireHaptic("medium"), 1500);

    // FASE 4: conferma + chiusura
    confirmOpacity.value = withDelay(2100, withTiming(1, { duration: 400 }));
    const t2 = setTimeout(() => fireHaptic("heavy"), 2400);

    // Fade out tutto
    containerOpacity.value = withDelay(
      2700,
      withTiming(0, { duration: 600 }, (finished) => {
        if (finished && onComplete) {
          runOnJS(onComplete)();
        }
      })
    );

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glowOpacity.value }));
  const sealStyle = useAnimatedStyle(() => ({
    opacity: sealOpacity.value,
    transform: [{ scale: sealScale.value }],
  }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: confirmOpacity.value }));

  // IMPORTANTE: NON return null prima degli hooks per evitare hook-count
  // mismatch. Invece, nascondiamo l'overlay solo a livello di stile.
  if (!visible) return null;

  return (
    <Animated.View style={[styles.container, containerStyle]} pointerEvents="none">
      {/* Glow caldo dal basso */}
      <Animated.View style={[styles.glow, glowStyle]} />

      {/* Particelle di fiamma — ogni particella è un sub-component con i propri hooks */}
      {particleConfigs.map((cfg, idx) => (
        <FlameParticle key={idx} cfg={cfg} trigger={visible} />
      ))}

      {/* Sigillo centrale */}
      <Animated.View style={[styles.sealContainer, sealStyle]}>
        <Text style={styles.sealIcon}>🔒</Text>
        <Text style={styles.sealText}>{L.sealed}</Text>
      </Animated.View>

      {/* Conferma cancellazione */}
      <Animated.View style={[styles.confirmContainer, confirmStyle]}>
        <Text style={styles.confirmText}>{L.confirmation}</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.92)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 9999,
  },
  glow: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: SCREEN_H * 0.5,
    backgroundColor: "#FF4500",
    opacity: 0.3,
    // Gradient simulation: shadow grande verso il top
    shadowColor: "#FF6B35",
    shadowOpacity: 0.8,
    shadowRadius: 80,
    shadowOffset: { width: 0, height: -40 },
  },
  particle: {
    position: "absolute",
    bottom: 60,
    borderRadius: 999,
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  sealContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  sealIcon: {
    fontSize: 80,
    marginBottom: 16,
    textShadowColor: "#FF6B35",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 24,
  },
  sealText: {
    color: "#FFE4B5",
    fontSize: 18,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 40,
    textShadowColor: "rgba(255, 107, 53, 0.8)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  confirmContainer: {
    position: "absolute",
    bottom: SCREEN_H * 0.18,
    paddingHorizontal: 32,
  },
  confirmText: {
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 14,
    textAlign: "center",
    fontStyle: "italic",
  },
});
