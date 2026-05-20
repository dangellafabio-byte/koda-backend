/**
 * KodaTour — guided spotlight tour of the home screen.
 *
 * Shows a dark overlay above the home, highlights ONE UI element at a time
 * with a glowing green ring, and has Koda speak a short explanation in voice.
 * Auto-advances when each speech ends. User can skip with a tap.
 *
 * Coordinates are FIXED (not measured from refs) — derived from the actual
 * layout of /app/frontend/app/index.tsx. If the home layout shifts, update
 * these. They use safe-area-aware values from props for the top elements.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  Easing,
  useWindowDimensions,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SpeechMod } from "../lib/speech";

type Page = "voice" | "reading";

export type TourStep = {
  /** Bounding box of the UI element to spotlight, in screen coords. */
  rect: { x: number; y: number; w: number; h: number };
  /** What Koda will say at this step (TTS, audio tags allowed). */
  speech: string;
  /** Which page to switch the home pager to BEFORE this step starts. */
  page: Page;
  /** Optional shape of the ring (default: rounded rectangle). */
  shape?: "round" | "circle";
  /** Optional tone label for display (cosmetic). */
  label?: string;
};

interface Props {
  /** Tour script — sequence of (highlight, speech) steps. */
  steps: TourStep[];
  /** Called when the tour completes (or user skips). */
  onComplete: () => void;
  /** Called when a step asks to switch the home pager between voice/reading. */
  onPageChange?: (page: Page) => void;
  /** ElevenLabs voice id to use (current Koda voice). Falls back to default. */
  voiceId?: string | null;
}

export default function KodaTour({ steps, onComplete, onPageChange, voiceId }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [idx, setIdx] = useState(0);
  // Two animation values:
  //   - pulse: ring breathe (scale 1 → 1.08)
  //   - impulse: outward wave that expands + fades (like a sonar ping)
  const pulse = useRef(new Animated.Value(0)).current;
  const impulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const cancelledRef = useRef(false);

  // Ring breathe
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  // Sonar "impulse" wave — expands outward + fades.
  // Restarts every 1.6s so the effect feels alive.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(impulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(impulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [impulse]);

  // Fade overlay in on mount, out on unmount
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    return () => {
      cancelledRef.current = true;
      try { SpeechMod.stop(); } catch {}
    };
  }, [fade]);

  // Drive the tour: speak each step, auto-advance on completion.
  useEffect(() => {
    if (idx >= steps.length) {
      onComplete();
      return;
    }
    const step = steps[idx];
    // Switch home pager to the right page if needed (handled by parent).
    if (onPageChange) onPageChange(step.page);
    let cancelled = false;
    // Safety net: if TTS hangs / fails silently, auto-advance after 15s
    // so the tour never gets stuck on a single step.
    const safetyTimer = setTimeout(() => {
      if (!cancelled && !cancelledRef.current) {
        console.warn("[KodaTour] safety timeout — advancing");
        setIdx((i) => i + 1);
      }
    }, 15000);
    (async () => {
      try {
        // Stop any leftover audio before starting next speech
        try { SpeechMod.stop(); } catch {}
        // Longer breather when page changes (give pager animation time to settle)
        // so the audio session doesn't conflict with the scroll animation.
        await new Promise((r) => setTimeout(r, 700));
        if (cancelled) return;
        await SpeechMod.speak(step.speech, {
          language: "it-IT",
          tone: "warm" as any,
          voiceId: voiceId || undefined,
        });
      } catch (e) {
        // ignore — keep tour moving even if a single TTS fails
        console.warn("[KodaTour] speak failed:", e);
      }
      if (cancelled || cancelledRef.current) return;
      // Brief pause then advance
      setTimeout(() => {
        if (!cancelled && !cancelledRef.current) setIdx((i) => i + 1);
      }, 500);
    })();
    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  if (idx >= steps.length) return null;
  const step = steps[idx];
  const r = step.rect;
  // Padding around target so the ring doesn't squeeze the element.
  const pad = 10;
  const ringX = r.x - pad;
  const ringY = r.y - pad;
  const ringW = r.w + pad * 2;
  const ringH = r.h + pad * 2;
  const radius = step.shape === "circle" ? ringW / 2 : Math.min(ringW, ringH) / 2;

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });
  // Sonar wave: scales from 1 → 2.2x and fades opacity 0.7 → 0
  const sonarScale = impulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const sonarOpacity = impulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]} pointerEvents="auto">
      {/* === VERO SPOTLIGHT === 
          Invece di una maschera unica che cubre TUTTO (così non si vede
          nulla dell'elemento sotto), usiamo 4 rettangoli scuri attorno
          al "buco" trasparente. L'elemento evidenziato resta perfettamente
          visibile, e tutto il resto è scurito all'82%. */}
      {/* TOP — dalla cima dello schermo fino all'alto del buco */}
      <View
        style={[styles.dim, { top: 0, left: 0, right: 0, height: Math.max(0, ringY) }]}
        pointerEvents="auto"
      />
      {/* BOTTOM — dal fondo del buco fino in fondo */}
      <View
        style={[styles.dim, { top: ringY + ringH, left: 0, right: 0, bottom: 0 }]}
        pointerEvents="auto"
      />
      {/* LEFT — fascia laterale sinistra alta come il buco */}
      <View
        style={[styles.dim, { top: ringY, left: 0, width: Math.max(0, ringX), height: ringH }]}
        pointerEvents="auto"
      />
      {/* RIGHT — fascia laterale destra alta come il buco */}
      <View
        style={[styles.dim, { top: ringY, left: ringX + ringW, right: 0, height: ringH }]}
        pointerEvents="auto"
      />

      {/* SONAR WAVE — outward expanding ring (impulse effect).
          Placed BEHIND the main ring so the main ring stays crisp. */}
      <Animated.View
        style={[
          styles.sonar,
          {
            left: ringX,
            top: ringY,
            width: ringW,
            height: ringH,
            borderRadius: radius,
            transform: [{ scale: sonarScale }],
            opacity: sonarOpacity,
          },
        ]}
        pointerEvents="none"
      />

      {/* Glowing ring around the target */}
      <Animated.View
        style={[
          styles.ring,
          {
            left: ringX,
            top: ringY,
            width: ringW,
            height: ringH,
            borderRadius: radius,
            transform: [{ scale: ringScale }],
            opacity: ringOpacity,
          },
        ]}
        pointerEvents="none"
      />

      {/* NIENTE BUBBLE DI TESTO — l'esperienza è tutta a voce, come 
          richiesto dall'utente. Solo highlight + voce di Koda. */}

      {/* Skip button — bottom center, "fuori dalle balle".
          Wrappato in un View full-width con alignItems:center perché
          `alignSelf: center` su Pressable absolute non funziona. */}
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: Math.max(insets.bottom + 28, 40),
          alignItems: "center",
        }}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() => {
            cancelledRef.current = true;
            try { SpeechMod.stop(); } catch {}
            onComplete();
          }}
          style={styles.skipBtn}
          hitSlop={14}
        >
          <Text style={styles.skipText}>Salta tour</Text>
          <Ionicons name="close-circle" size={16} color="#FFFFFFCC" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 200,
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.82)",
  },
  ring: {
    position: "absolute",
    borderWidth: 4,
    borderColor: "#34D399",
    backgroundColor: "transparent",
    // Glow via shadow (iOS) / elevation (Android approximation)
    ...Platform.select({
      ios: {
        shadowColor: "#34D399",
        shadowOpacity: 1,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 14 },
      default: {},
    }),
  },
  sonar: {
    position: "absolute",
    borderWidth: 3,
    borderColor: "#34D399",
    backgroundColor: "transparent",
  },
  bubble: {
    position: "absolute",
    paddingVertical: 16,
    paddingHorizontal: 18,
    backgroundColor: "rgba(15,22,32,0.96)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(52,211,153,0.35)",
  },
  bubbleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
    opacity: 0.7,
  },
  bubbleLabel: {
    color: "#A7F3D0",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  bubbleText: {
    color: "#E5F7EE",
    fontSize: 16,
    lineHeight: 23,
  },
  skipBtn: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  skipText: {
    color: "#FFFFFFDD",
    fontSize: 13,
    fontWeight: "600",
  },
});
