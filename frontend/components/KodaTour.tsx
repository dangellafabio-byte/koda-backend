/**
 * KodaTour — guided tour in stile premium (giugno 2026 v6).
 *
 * Filosofia design:
 *  - L'interfaccia resta VISIBILE (niente più overlay nero al 55%).
 *  - Dim soft al 18% appena percepibile, solo per dare focus.
 *  - Spotlight morbido sull'elemento target: alone glow teal soft + leggero
 *    scale 1.03x + bordo luminoso sottile. Nessuna freccia.
 *  - Card tooltip glassmorphism flottante (max 280px) con titolo + 1 frase.
 *  - Progress dots (○ ● ○) + pulsanti "Indietro" / "Avanti" / "Salta tour".
 *  - Animazioni spring 500-700ms.
 *
 * Ispirato a: Linear, Notion, Arc Browser, Revolut, Headspace.
 *
 * I rect del target arrivano dal parent — vengono usati per posizionare
 * lo spotlight glow E la card (sopra o sotto in base allo spazio).
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
  /** Opzionali: se assenti, ricavati da `speech` (prima frase = titolo). */
  title?: string;
  description?: string;
  /** Ignorati nel design premium (kept per compat API). */
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

// Estrae titolo + descrizione da `speech` se non forniti esplicitamente.
function extractTitleAndDesc(step: TourStep): { title: string; desc: string } {
  if (step.title || step.description) {
    return { title: step.title || "", desc: step.description || step.speech };
  }
  const s = (step.speech || "").trim();
  // Cerca primo punto/punto interrogativo
  const m = s.match(/^(.+?[.!?…])\s+(.+)$/);
  if (m) {
    return { title: m[1].replace(/[.!?…]+$/, "").trim(), desc: m[2].trim() };
  }
  return { title: step.label || "Koda", desc: s };
}

const CARD_W = 280;
const CARD_VPAD = 16;
const SPOTLIGHT_INSET = -10; // glow estende oltre il bounding box

export default function KodaTour({
  steps,
  onComplete,
  onPageChange,
  voiceId,
  onStepChange,
}: Props) {
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(0)).current;
  const spotlightOpacity = useRef(new Animated.Value(0)).current;
  const spotlightScale = useRef(new Animated.Value(0.96)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const cardTranslate = useRef(new Animated.Value(8)).current;
  const cancelledRef = useRef(false);

  // Fade overlay in on mount.
  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 350,
      useNativeDriver: true,
    }).start();
    return () => {
      cancelledRef.current = true;
      try {
        SpeechMod.stop();
      } catch {}
    };
  }, [fade]);

  // Step change → animazione spotlight + card.
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

    // Animazione spring: fade-in spotlight + card.
    spotlightOpacity.setValue(0);
    spotlightScale.setValue(0.96);
    cardOpacity.setValue(0);
    cardTranslate.setValue(8);
    Animated.parallel([
      Animated.timing(spotlightOpacity, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(spotlightScale, {
        toValue: 1,
        damping: 14,
        stiffness: 110,
        mass: 0.9,
        useNativeDriver: true,
      }),
      Animated.timing(cardOpacity, {
        toValue: 1,
        duration: 500,
        delay: 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(cardTranslate, {
        toValue: 0,
        damping: 16,
        stiffness: 130,
        mass: 0.9,
        delay: 120,
        useNativeDriver: true,
      }),
    ]).start();

    // TTS: parla il messaggio dello step. NON avanziamo automaticamente —
    // l'utente clicca "Avanti" o "Indietro". Lo step è auto-paced, premium.
    let cancelled = false;
    (async () => {
      try {
        try { SpeechMod.stop(); } catch {}
        await new Promise((r) => setTimeout(r, 320)); // attendi che la card sia visibile
        if (cancelled || cancelledRef.current) return;
        await SpeechMod.speak(step.speech, {
          language: "it-IT",
          tone: "warm" as any,
          voiceId: voiceId || undefined,
        });
      } catch (e) {
        console.warn("[KodaTour] speak error:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  if (idx >= steps.length) return null;
  const step = steps[idx];
  const r = step.rect;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { title, desc } = extractTitleAndDesc(step);

  // Spotlight bounds (con leggero inset per il glow).
  const sx = r.x + SPOTLIGHT_INSET;
  const sy = r.y + SPOTLIGHT_INSET;
  const sw = r.w - SPOTLIGHT_INSET * 2;
  const sh = r.h - SPOTLIGHT_INSET * 2;

  // Posizionamento card: sotto se c'è spazio, altrimenti sopra.
  const TARGET_BOTTOM = r.y + r.h;
  const TARGET_TOP = r.y;
  const SPACE_BELOW = screenH - TARGET_BOTTOM - insets.bottom;
  const SPACE_ABOVE = TARGET_TOP - insets.top;
  const CARD_H_EST = 160; // stima per decisione
  const placeBelow = SPACE_BELOW >= CARD_H_EST + 80 || SPACE_BELOW > SPACE_ABOVE;

  // Centra orizzontalmente sul target, clampato ai bordi schermo.
  let cardX = r.x + r.w / 2 - CARD_W / 2;
  cardX = Math.max(16, Math.min(cardX, screenW - CARD_W - 16));
  const cardY = placeBelow
    ? TARGET_BOTTOM + 18
    : Math.max(insets.top + 12, TARGET_TOP - CARD_H_EST - 18);

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]} pointerEvents="auto">
      {/* Dim soft 18% — l'interfaccia resta visibile. */}
      <View style={styles.dimSoft} pointerEvents="none" />

      {/* Spotlight glow morbido attorno al target (no occlusione). */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.spotlight,
          {
            left: sx,
            top: sy,
            width: sw,
            height: sh,
            opacity: spotlightOpacity,
            transform: [{ scale: spotlightScale }],
          },
        ]}
      />
      {/* Secondo strato glow più diffuso (alone esterno). */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.spotlightOuter,
          {
            left: sx - 14,
            top: sy - 14,
            width: sw + 28,
            height: sh + 28,
            opacity: Animated.multiply(spotlightOpacity, new Animated.Value(0.6)),
            transform: [{ scale: spotlightScale }],
          },
        ]}
      />

      {/* Card tooltip glassmorphism. */}
      <Animated.View
        style={[
          styles.card,
          {
            left: cardX,
            top: cardY,
            opacity: cardOpacity,
            transform: [{ translateY: cardTranslate }],
          },
        ]}
        pointerEvents="box-none"
      >
        {/* Beak che indica il target (piccolo triangolo sopra o sotto). */}
        <View
          pointerEvents="none"
          style={[
            styles.beak,
            placeBelow ? styles.beakTop : styles.beakBottom,
            {
              left: Math.max(20, Math.min(r.x + r.w / 2 - cardX - 6, CARD_W - 32)),
            },
          ]}
        />
        <Text style={styles.cardTitle}>{title}</Text>
        {desc ? <Text style={styles.cardDesc}>{desc}</Text> : null}

        {/* Progress dots */}
        <View style={styles.dotsRow}>
          {steps.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === idx ? styles.dotActive : styles.dotInactive]}
            />
          ))}
        </View>

        {/* Nav buttons */}
        <View style={styles.navRow}>
          {idx > 0 ? (
            <Pressable
              onPress={() => {
                try { SpeechMod.stop(); } catch {}
                setIdx((i) => Math.max(0, i - 1));
              }}
              style={styles.btnGhost}
              hitSlop={12}
            >
              <Ionicons name="chevron-back" size={15} color="#FFFFFFCC" />
              <Text style={styles.btnGhostText}>Indietro</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                cancelledRef.current = true;
                try { SpeechMod.stop(); } catch {}
                onComplete();
              }}
              style={styles.btnGhost}
              hitSlop={12}
            >
              <Text style={styles.btnGhostText}>Salta</Text>
            </Pressable>
          )}

          <Pressable
            onPress={() => {
              try { SpeechMod.stop(); } catch {}
              if (idx >= steps.length - 1) {
                cancelledRef.current = true;
                onComplete();
              } else {
                setIdx((i) => i + 1);
              }
            }}
            style={styles.btnPrimary}
            hitSlop={12}
          >
            <Text style={styles.btnPrimaryText}>
              {idx >= steps.length - 1 ? "Inizia" : "Avanti"}
            </Text>
            <Ionicons
              name={idx >= steps.length - 1 ? "checkmark" : "chevron-forward"}
              size={15}
              color="#0F1622"
            />
          </Pressable>
        </View>
      </Animated.View>

      {/* Salta tour minimo in basso (sempre disponibile). */}
      <Pressable
        onPress={() => {
          cancelledRef.current = true;
          try { SpeechMod.stop(); } catch {}
          onComplete();
        }}
        style={[styles.skipFloating, { bottom: Math.max(insets.bottom + 20, 32) }]}
        hitSlop={14}
      >
        <Text style={styles.skipFloatingText}>Salta tour</Text>
      </Pressable>
    </Animated.View>
  );
}

const TEAL = "#5EEAD4"; // glow teal premium

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 200,
  },
  dimSoft: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.18)", // soft, l'app resta visibile
  },
  spotlight: {
    position: "absolute",
    borderRadius: 22,
    borderWidth: 1.2,
    borderColor: TEAL + "AA",
    shadowColor: TEAL,
    shadowOpacity: 0.85,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  spotlightOuter: {
    position: "absolute",
    borderRadius: 30,
    backgroundColor: "transparent",
    shadowColor: TEAL,
    shadowOpacity: 0.55,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  card: {
    position: "absolute",
    width: CARD_W,
    padding: CARD_VPAD,
    paddingBottom: 14,
    borderRadius: 22,
    backgroundColor: "rgba(20, 26, 38, 0.82)",
    // glassmorphism approx — su iOS RN nativo non rende blur ma il colore
    // semi-trasparente + bordo + shadow danno un effetto pulito coerente.
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 18,
  },
  beak: {
    position: "absolute",
    width: 12,
    height: 12,
    backgroundColor: "rgba(20, 26, 38, 0.82)",
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    transform: [{ rotate: "45deg" }],
  },
  beakTop: {
    top: -7,
  },
  beakBottom: {
    bottom: -7,
    transform: [{ rotate: "225deg" }],
  },
  cardTitle: {
    color: "#F5F7FB",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.1,
    marginBottom: 6,
  },
  cardDesc: {
    color: "#F5F7FBCC",
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: "400",
  },
  dotsRow: {
    flexDirection: "row",
    gap: 5,
    marginTop: 14,
    marginBottom: 12,
    alignSelf: "flex-start",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: TEAL,
    width: 18,
  },
  dotInactive: {
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  navRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  btnGhost: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  btnGhostText: {
    color: "#FFFFFFCC",
    fontSize: 13,
    fontWeight: "600",
  },
  btnPrimary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 13,
    backgroundColor: TEAL,
  },
  btnPrimaryText: {
    color: "#0F1622",
    fontSize: 13.5,
    fontWeight: "700",
  },
  skipFloating: {
    position: "absolute",
    alignSelf: "center",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  skipFloatingText: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
});
