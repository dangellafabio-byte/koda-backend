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
  // Pulsing animation for the ring
  const pulse = useRef(new Animated.Value(0)).current;
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
    (async () => {
      try {
        // Stop any leftover audio before starting next speech
        try { SpeechMod.stop(); } catch {}
        // tiny breather so the user's eye reaches the new highlight before voice
        await new Promise((r) => setTimeout(r, 400));
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
      }, 600);
    })();
    return () => { cancelled = true; };
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

  // Strip audio tags ([gently], [warmly] etc) for display
  const cleanText = step.speech.replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();

  // Decide bubble position: above ring if ring is in lower half, below ring otherwise.
  const ringCenterY = r.y + r.h / 2;
  const bubbleAbove = ringCenterY > height * 0.55;
  const bubbleTop = bubbleAbove
    ? Math.max(insets.top + 60, ringY - 160)
    : Math.min(height - 200, ringY + ringH + 24);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]} pointerEvents="auto">
      {/* Dark layer — tap-through disabled so user can't accidentally interact with home */}
      <View style={styles.dim} />

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

      {/* Speech bubble */}
      <View
        style={[
          styles.bubble,
          { top: bubbleTop, left: 20, right: 20 },
        ]}
      >
        <View style={styles.bubbleHeader}>
          <Ionicons name="pulse" size={14} color="#34D399" />
          <Text style={styles.bubbleLabel}>
            {idx + 1} di {steps.length}
            {step.label ? ` · ${step.label}` : ""}
          </Text>
        </View>
        <Text style={styles.bubbleText}>{cleanText}</Text>
      </View>

      {/* Skip button — always visible top-right */}
      <Pressable
        onPress={() => {
          cancelledRef.current = true;
          try { SpeechMod.stop(); } catch {}
          onComplete();
        }}
        style={[
          styles.skipBtn,
          { top: Math.max(insets.top + 14, 50), right: 20 },
        ]}
        hitSlop={14}
      >
        <Text style={styles.skipText}>Salta</Text>
        <Ionicons name="close" size={16} color="#FFFFFFCC" />
      </Pressable>
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
    borderWidth: 3,
    borderColor: "#34D399",
    backgroundColor: "transparent",
    // Glow via shadow (iOS) / elevation (Android approximation)
    ...Platform.select({
      ios: {
        shadowColor: "#34D399",
        shadowOpacity: 0.9,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 10 },
      default: {},
    }),
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
