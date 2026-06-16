/**
 * KodaTour — guided tour of the home screen.
 *
 * Versione "freccia animata" (giugno 2026 v3):
 *  - Niente cerchi, niente halo, niente quadrati che coprono l'elemento.
 *  - Una FRECCIA animata (bounce) appare vicino al target indicando esattamente
 *    quale elemento Koda sta descrivendo. La freccia è SEMPRE fuori
 *    dall'elemento, mai sopra (non interferisce con la UI).
 *  - Dim full-screen al 55% per dare focus al target.
 *  - TTS con retry automatico (1 retry su fallimento, safety 12s).
 *  - Pulsante "Salta tour" sempre visibile.
 *
 * Il `rect` arriva dal parent (in screen coords) e viene usato SOLO per
 * decidere dove disegnare la freccia. La freccia punta sempre verso il
 * centro del target.
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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SpeechMod } from "../lib/speech";

type Page = "voice" | "reading";

export type TourStep = {
  rect: { x: number; y: number; w: number; h: number };
  speech: string;
  page: Page;
  shape?: "round" | "circle";
  label?: string;
};

interface Props {
  steps: TourStep[];
  onComplete: () => void;
  onPageChange?: (page: Page) => void;
  voiceId?: string | null;
  onStepChange?: (idx: number, step: TourStep | null) => void;
}

export default function KodaTour({
  steps,
  onComplete,
  onPageChange,
  voiceId,
  onStepChange,
}: Props) {
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(0)).current;
  const cancelledRef = useRef(false);

  // Fade overlay in on mount, hard-stop TTS on unmount.
  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
    return () => {
      cancelledRef.current = true;
      try {
        SpeechMod.stop();
      } catch {}
    };
  }, [fade]);

  // Loop di bounce della freccia (8px su/giù).
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [bounce]);

  // Drive the tour: speak each step, auto-advance.
  useEffect(() => {
    if (idx >= steps.length) {
      onComplete();
      return;
    }
    const step = steps[idx];
    try {
      if (onStepChange) onStepChange(idx, step);
    } catch {}
    if (onPageChange) onPageChange(step.page);

    let cancelled = false;
    const safetyTimer = setTimeout(() => {
      if (!cancelled && !cancelledRef.current) {
        console.warn("[KodaTour] safety timeout — advancing");
        setIdx((i) => i + 1);
      }
    }, 12000);

    (async () => {
      const speakWithRetry = async (): Promise<void> => {
        try {
          try {
            SpeechMod.stop();
          } catch {}
          await SpeechMod.speak(step.speech, {
            language: "it-IT",
            tone: "warm" as any,
            voiceId: voiceId || undefined,
          });
        } catch (e1) {
          if (cancelled || cancelledRef.current) return;
          console.warn("[KodaTour] speak failed (1st), retrying:", e1);
          await new Promise((r) => setTimeout(r, 400));
          if (cancelled || cancelledRef.current) return;
          try {
            await SpeechMod.speak(step.speech, {
              language: "it-IT",
              tone: "warm" as any,
              voiceId: voiceId || undefined,
            });
          } catch (e2) {
            console.warn("[KodaTour] speak failed (2nd, giving up):", e2);
          }
        }
      };

      try {
        await new Promise((r) => setTimeout(r, 500));
        if (cancelled) return;
        await speakWithRetry();
      } catch (e) {
        console.warn("[KodaTour] step error:", e);
      }

      if (cancelled || cancelledRef.current) return;
      setTimeout(() => {
        if (!cancelled && !cancelledRef.current) setIdx((i) => i + 1);
      }, 450);
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

  // === LOGICA POSIZIONE FRECCIA ===
  // Se il target è nella metà superiore dello schermo → freccia SOTTO il
  // target, punta verso l'alto (arrow-up). Altrimenti → freccia SOPRA il
  // target, punta verso il basso (arrow-down). Così la freccia non copre
  // mai il bottone e l'utente vede chiaramente dove guardare.
  const targetCenterY = r.y + r.h / 2;
  const arrowBelow = targetCenterY < screenH * 0.5; // se target in alto, freccia sotto
  const arrowX = r.x + r.w / 2 - 22; // centra orizzontalmente sul target (size icon 44)
  // Distanza dalla bordo del target: 14px (così non tocca l'elemento).
  const arrowY = arrowBelow ? r.y + r.h + 14 : r.y - 14 - 44;
  const iconName: any = arrowBelow ? "arrow-up" : "arrow-down";

  // Bounce: traslazione verticale che porta la freccia verso/lontano dal target.
  const bounceTy = bounce.interpolate({
    inputRange: [0, 1],
    outputRange: arrowBelow ? [0, -8] : [0, 8], // se la freccia è sotto e punta in alto, bouncia verso l'alto
  });

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]} pointerEvents="auto">
      {/* Dim scuro full-screen — dà focus al target. */}
      <View style={styles.dim} pointerEvents="none" />

      {/* Freccia animata vicino al target. */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: arrowX,
          top: arrowY,
          transform: [{ translateY: bounceTy }],
        }}
      >
        <View style={styles.arrowBg}>
          <Ionicons name={iconName} size={28} color="#0F1622" />
        </View>
      </Animated.View>

      {/* Skip button — bottom center. */}
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
            try {
              SpeechMod.stop();
            } catch {}
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
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  arrowBg: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#A7F3D0", // verde menta morbido — alta visibilità su dim
    alignItems: "center",
    justifyContent: "center",
    // Glow soft per attirare l'occhio (iOS shadow + Android elevation).
    shadowColor: "#34D399",
    shadowOpacity: 0.95,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  skipBtn: {
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
