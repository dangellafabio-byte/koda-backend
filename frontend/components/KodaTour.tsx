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
import Svg, { Defs, Mask, Rect as SvgRect, Circle as SvgCircle, RoundedRect } from "react-native-svg";
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
  // GLOW interno sul bottone: alterna da 0 a 0.32 opacity, dando l'effetto
  // che il bottone stesso "respira di luce" senza disegnare anelli esterni.
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.0, 0.32] });

  // === HALO BIANCO INTENSO ===
  // Anima l'opacità dell'alone bianco fra 0.65 e 1.0 — fa "respirare" il
  // bottone come una stella, restando ben visibile anche sopra lo sfondo
  // dimmerato al 45%. Cross-platform: iOS usa shadow nativa, Android usa
  // anelli concentrici con bordi semi-trasparenti.
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1.0] });
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1.0, 1.04] });

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]} pointerEvents="auto">
      {/* === SPOTLIGHT con OSCURAMENTO PARZIALE — NIENTE ANELLI ===
          User feedback: "non voglio niente di evidenziato/cerchiato.
          Solo che si oscuri la pagina e rimanga in evidenza per contrasto
          quello di cui sta parlando".
          
          4 rettangoli scuri attorno al "buco" trasparente del target.
          Il bottone target risalta SOLO perché il resto è scurito al 45%. */}
      {/* === SPOTLIGHT DIM CON SVG MASK (giugno 2026 — fix quadrato) ===
          Prima usavamo 4 rettangoli View con backgroundColor scuro disposti
          attorno a un "buco" rettangolare. Risultato: per i target rotondi
          (orb, hands-free, menu) i 4 angoli del buco rettangolare restavano
          visibili come un QUADRATO chiaro attorno al cerchio.
          Ora un singolo SVG fullscreen con una mask che ritaglia esattamente
          il cerchio (shape=circle) o il rounded-rect (shape=round). */}
      <Svg
        width={W}
        height={H}
        style={StyleSheet.absoluteFill}
        pointerEvents="auto"
      >
        <Defs>
          <Mask id="spotlight">
            {/* TUTTO bianco = visibile (scuro), il "buco" sarà nero = trasparente */}
            <SvgRect x="0" y="0" width={W} height={H} fill="white" />
            {shape === "circle" ? (
              <SvgCircle
                cx={ringX + ringW / 2}
                cy={ringY + ringH / 2}
                r={Math.max(ringW, ringH) / 2}
                fill="black"
              />
            ) : (
              <RoundedRect
                x={ringX}
                y={ringY}
                width={ringW}
                height={ringH}
                rx={radius}
                ry={radius}
                fill="black"
              />
            )}
          </Mask>
        </Defs>
        <SvgRect
          x="0"
          y="0"
          width={W}
          height={H}
          fill="rgba(0,0,0,0.45)"
          mask="url(#spotlight)"
        />
      </Svg>

      {/* === HALO BIANCO INTENSO sopra il bottone evidenziato ===
          Sopra i 4 rettangoli di dim, disegniamo un alone bianco multistrato
          ESATTAMENTE attorno al bottone, così risalta come una stella.
          - iOS: una vista trasparente con shadowColor bianco e shadowRadius 28
                 → alone soft naturale gestito dal compositor.
          - Android: 3 anelli concentrici con bordi bianchi semi-trasparenti
                     → effetto halo sintetico (l'elevation di RN non disegna
                     vere ombre colorate).
          - Cross: bordo bianco 2px sul rect del target per il "contorno
                   netto" che fa staccare il bottone dallo sfondo dimmerato.
          pointerEvents="none" così il bottone sottostante resta cliccabile
          quando il tour finirà (mentre il tour è attivo non importa). */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.haloBorder,
          {
            top: ringY,
            left: ringX,
            width: ringW,
            height: ringH,
            borderRadius: radius,
            opacity: haloOpacity,
            transform: [{ scale: haloScale }],
          },
        ]}
      />
      {/* Ring esterno bianco semi-trasparente — visibile su Android e iOS,
          aggiunge "spessore" all'aura anche quando l'ombra iOS non si nota */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.haloRing1,
          {
            top: ringY - 6,
            left: ringX - 6,
            width: ringW + 12,
            height: ringH + 12,
            borderRadius: radius + 6,
            opacity: haloOpacity,
            transform: [{ scale: haloScale }],
          },
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.haloRing2,
          {
            top: ringY - 12,
            left: ringX - 12,
            width: ringW + 24,
            height: ringH + 24,
            borderRadius: radius + 12,
            opacity: haloOpacity,
            transform: [{ scale: haloScale }],
          },
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.haloRing3,
          {
            top: ringY - 20,
            left: ringX - 20,
            width: ringW + 40,
            height: ringH + 40,
            borderRadius: radius + 20,
            opacity: haloOpacity,
            transform: [{ scale: haloScale }],
          },
        ]}
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
    // Oscuramento PARZIALE: la home/dettatura resta visibile dietro,
    // così l'utente capisce esattamente dove si trova nell'app.
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  // === STILI HALO BIANCO ===
  // haloBorder: bordo netto bianco 2px attorno al target — fa "stagliare"
  // il bottone contro il dim. Su iOS gli aggiungiamo anche una shadow bianca
  // forte (l'unico modo nativo per ottenere un vero glow morbido).
  haloBorder: {
    position: "absolute",
    // === FIX QUADRATO SOTTO (giugno 2026 #12) ===
    // L'utente vedeva un "quadrato bianco" attorno al target del tour
    // sia in giorno che in notte. Causa: borderWidth 2px + borderColor
    // bianco SOLIDO disegnava un contorno netto come uno spillo, e per
    // bottoni con borderRadius basso appariva come un rettangolo evidente.
    // Riduciamo a borderWidth 0 → l'effetto highlight resta SOLO via
    // shadow iOS (alone soffice) e rings semi-trasparenti su Android.
    borderWidth: 0,
    borderColor: "transparent",
    backgroundColor: "transparent",
    ...Platform.select({
      ios: {
        shadowColor: "#FFFFFF",
        shadowOpacity: 1,
        shadowRadius: 28,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 0 }, // su Android usiamo i ring concentrici
      default: {},
    }),
  },
  // Ring 1: leggermente più grande del target, bianco più morbido
  haloRing1: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.55)",
    backgroundColor: "transparent",
    ...Platform.select({
      ios: {
        shadowColor: "#FFFFFF",
        shadowOpacity: 0.9,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 0 },
      },
      default: {},
    }),
  },
  // Ring 2: ancora più grande, bianco diluito
  haloRing2: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.25)",
    backgroundColor: "transparent",
  },
  // Ring 3: outermost, quasi invisibile → solo sfumatura
  haloRing3: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "transparent",
  },
  outerRing: {
    position: "absolute",
    borderWidth: 3,
    borderColor: "#A7F3D0",
    backgroundColor: "transparent",
    ...Platform.select({
      ios: {
        shadowColor: "#34D399",
        shadowOpacity: 0.9,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 12 },
      default: {},
    }),
  },
  sonar: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "#A7F3D0",
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
