/**
 * KodaTour — guided tour of the home screen.
 *
 * Versione minimalista (giugno 2026):
 *  - SOLO un dim scuro full-screen (45% nero).
 *  - NIENTE cerchi/halo/ring attorno agli elementi (feedback utente: "togli
 *    il cerchio e basta, l'evidenziatura non cambia niente").
 *  - SOLO la voce di Koda guida il tour.
 *  - TTS con retry automatico: se la generazione fallisce, riprova UNA volta
 *    prima di proseguire. Safety timer ridotto a 12s.
 *  - Pulsante "Salta tour" sempre visibile in basso.
 *
 * I `rect` continuano ad arrivare dal parent per compatibilità API, ma
 * vengono ignorati: nessun highlight grafico.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SpeechMod } from "../lib/speech";

type Page = "voice" | "reading";

export type TourStep = {
  /** Bounding box (ignorato nella versione minimalista — kept for API compat). */
  rect: { x: number; y: number; w: number; h: number };
  /** What Koda will say at this step (TTS). */
  speech: string;
  /** Which page to switch the home pager to BEFORE this step starts. */
  page: Page;
  /** Optional shape — ignorato (compat). */
  shape?: "round" | "circle";
  /** Optional tone label — ignorato (compat). */
  label?: string;
};

interface Props {
  steps: TourStep[];
  onComplete: () => void;
  onPageChange?: (page: Page) => void;
  voiceId?: string | null;
  /** Notifica al parent quando lo step cambia (per overlay sincronizzati). */
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
  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(0)).current;
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

  // Drive the tour: speak each step, auto-advance on completion (with retry).
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
    // Safety net: se il TTS dovesse hangare, andiamo avanti dopo 12s.
    const safetyTimer = setTimeout(() => {
      if (!cancelled && !cancelledRef.current) {
        console.warn("[KodaTour] safety timeout — advancing");
        setIdx((i) => i + 1);
      }
    }, 12000);

    (async () => {
      // Helper: prova a parlare. Se fallisce (rete, audio session, ecc.)
      // ritenta UNA volta dopo 400ms prima di rinunciare.
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
        // Breather corto prima di parlare → lascia il tempo al pager di
        // completare lo scroll e all'audio session di stabilizzarsi.
        await new Promise((r) => setTimeout(r, 500));
        if (cancelled) return;
        await speakWithRetry();
      } catch (e) {
        console.warn("[KodaTour] step error:", e);
      }

      if (cancelled || cancelledRef.current) return;
      // Brief pause then advance.
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

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]} pointerEvents="auto">
      {/* Solo dim scuro full-screen. Nessun cerchio, nessun halo. */}
      <View style={styles.dim} pointerEvents="none" />

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
