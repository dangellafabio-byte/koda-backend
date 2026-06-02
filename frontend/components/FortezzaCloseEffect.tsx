/**
 * FortezzaCloseEffect — animazione "lettera che brucia" 2026-06.
 *
 * Effetto richiesto dall'utente: una linea di fuoco frastagliata sale
 * dal basso verso l'alto, "bruciando" il contenuto della chat. Sopra
 * la linea: cenere/nero. Sotto: il contenuto della chat ancora visibile
 * che sta scomparendo. Alla fine: schermata nera totale, sigillo che
 * appare, conferma "dato grezzo cancellato" e poi onComplete.
 *
 * Fasi:
 *  1. (0-1800ms)   la linea di fuoco sale dal basso al top
 *                  + il contenuto sopra la linea diventa nero
 *                  + glow arancione sulla linea
 *  2. (1800-2400ms) tutto schermo nero, appare il sigillo 🔒
 *  3. (2400-2900ms) appare conferma "Dato grezzo cancellato"
 *  4. (2900-3500ms) fade out totale → onComplete
 *
 * Haptic: light all'inizio, medium quando appare il sigillo, heavy
 * alla conferma finale.
 */

import React, { useEffect } from "react";
import { View, Text, StyleSheet, Dimensions, Platform } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  Easing,
  runOnJS,
  interpolate,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import * as Haptics from "expo-haptics";

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

type Props = {
  visible: boolean;
  onComplete?: () => void;
  labels?: {
    burning?: string;
    sealed?: string;
    confirmation?: string;
  };
};

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const DEFAULT_LABELS = {
  burning: "Brucia...",
  sealed: "🔒 Sigillato. Resta tra te e te.",
  confirmation: "Dato grezzo cancellato per sempre.",
};

// Costanti dell'animazione
const BURN_DURATION = 1800;     // tempo che la linea impiega a salire
const SEAL_APPEAR_AT = 1900;    // quando appare il sigillo
const CONFIRM_APPEAR_AT = 2400; // quando appare la conferma
const TOTAL_DURATION = 3400;    // durata totale prima di onComplete

// Numero di punti sul wave (più alto = più frastagliato)
const WAVE_POINTS = 32;
// Ampiezza della fiamma frastagliata (in pixel)
const WAVE_AMPLITUDE = 14;

function fireHaptic(type: "light" | "medium" | "heavy") {
  if (Platform.OS === "web") return;
  try {
    if (type === "light") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  } catch {}
}

/**
 * Genera una path SVG di un'onda frastagliata orizzontale che simula
 * una fiamma. La randomness è statica perché vogliamo la stessa "forma"
 * di fiamma durante tutto il rendering (l'onda non si muove, è solo
 * traslata verticalmente dal componente padre).
 */
function generateJaggedFirePath(): string {
  const step = SCREEN_W / WAVE_POINTS;
  let d = `M -20,0`;
  for (let i = 0; i <= WAVE_POINTS; i++) {
    const x = i * step;
    // sin + random per dare un effetto fiamma irregolare
    const y =
      Math.sin(i * 0.7) * WAVE_AMPLITUDE * 0.6 +
      (Math.random() - 0.5) * WAVE_AMPLITUDE;
    d += ` L${x},${y}`;
  }
  d += ` L${SCREEN_W + 20},0`;
  return d;
}

// La path viene generata UNA volta al mount del modulo, così è stabile
// tra le re-render del componente.
const JAGGED_PATH = generateJaggedFirePath();

export default function FortezzaCloseEffect({ visible, onComplete, labels }: Props) {
  const L = { ...DEFAULT_LABELS, ...(labels || {}) };

  // SharedValues per le animazioni
  const containerOpacity = useSharedValue(0);
  const burnProgress = useSharedValue(0);  // 0 = linea in basso, 1 = linea in cima
  const sealOpacity = useSharedValue(0);
  const sealScale = useSharedValue(0.5);
  const confirmOpacity = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      // reset
      containerOpacity.value = 0;
      burnProgress.value = 0;
      sealOpacity.value = 0;
      sealScale.value = 0.5;
      confirmOpacity.value = 0;
      return;
    }

    // === FASE 1: la linea di fuoco si accende e sale ===
    fireHaptic("light");
    // Fade in completa container in 200ms, poi resta fino al fade-out finale
    containerOpacity.value = withSequence(
      withTiming(1, { duration: 200 }),
      withDelay(
        TOTAL_DURATION - 200 - 600,
        withTiming(0, { duration: 600 }, (finished) => {
          if (finished && onComplete) {
            runOnJS(onComplete)();
          }
        })
      )
    );
    // La fiamma sale dal basso (0) verso l'alto (1)
    burnProgress.value = withTiming(1, {
      duration: BURN_DURATION,
      easing: Easing.inOut(Easing.cubic),
    });

    // === FASE 2: sigillo appare con piccolo "thump" ===
    const t1 = setTimeout(() => fireHaptic("medium"), SEAL_APPEAR_AT);
    sealOpacity.value = withDelay(SEAL_APPEAR_AT, withTiming(1, { duration: 350 }));
    sealScale.value = withDelay(
      SEAL_APPEAR_AT,
      withSequence(
        withTiming(1.15, { duration: 280, easing: Easing.out(Easing.back(2)) }),
        withTiming(1, { duration: 180 })
      )
    );

    // === FASE 3: conferma ===
    const t2 = setTimeout(() => fireHaptic("heavy"), CONFIRM_APPEAR_AT);
    confirmOpacity.value = withDelay(
      CONFIRM_APPEAR_AT,
      withTiming(1, { duration: 400 })
    );

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Stili animati
  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));

  // Il "lenzuolo nero" della parte già bruciata: parte dall'alto e
  // cresce verso il basso man mano che la fiamma sale.
  // L'altezza è SCREEN_H * burnProgress, ma la calcoliamo da
  // bottom-up: quando progress=1, copre tutto lo schermo.
  const ashStyle = useAnimatedStyle(() => {
    // burnProgress: 0 → top=SCREEN_H (niente nero). 1 → top=0 (tutto nero)
    const burnedHeight = SCREEN_H * burnProgress.value;
    return {
      height: burnedHeight,
    };
  });

  // La linea di fuoco si posiziona sul confine tra ash (sopra) e chat (sotto)
  const fireLineStyle = useAnimatedStyle(() => {
    const top = SCREEN_H * (1 - burnProgress.value) - 24; // -24 = metà altezza linea
    return {
      top,
      // Verso la fine la linea sparisce (perché ha già bruciato tutto)
      opacity: interpolate(burnProgress.value, [0, 0.05, 0.92, 1], [0, 1, 1, 0]),
    };
  });

  // Sigillo al centro
  const sealStyle = useAnimatedStyle(() => ({
    opacity: sealOpacity.value,
    transform: [{ scale: sealScale.value }],
  }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: confirmOpacity.value }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.container, containerStyle]}
      pointerEvents="none"
    >
      {/* Lenzuolo nero (parte bruciata) — parte dall'alto e cresce */}
      <Animated.View style={[styles.ash, ashStyle]} />

      {/* Linea di fuoco frastagliata che sale */}
      <Animated.View style={[styles.fireLineWrap, fireLineStyle]}>
        {/* Glow chiaro arancione (alone) — più ampio */}
        <View style={styles.glowOuter} />
        {/* Glow stretto intenso */}
        <View style={styles.glowInner} />
        {/* La fiamma vera e propria (path SVG frastagliata) */}
        <Svg
          width={SCREEN_W + 40}
          height={48}
          style={{ position: "absolute", left: -20, top: 0 }}
          viewBox={`-20 -24 ${SCREEN_W + 40} 48`}
        >
          {/* Stroke arancione spesso */}
          <Path
            d={JAGGED_PATH}
            stroke="#FFB000"
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Stroke giallo brillante più sottile (cuore della fiamma) */}
          <Path
            d={JAGGED_PATH}
            stroke="#FFF5C0"
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </Animated.View>

      {/* Sigillo al centro (appare dopo la combustione) */}
      <Animated.View style={[styles.sealContainer, sealStyle]} pointerEvents="none">
        <Text style={styles.sealIcon}>🔒</Text>
        <Text style={styles.sealText}>{L.sealed}</Text>
      </Animated.View>

      {/* Conferma */}
      <Animated.View style={[styles.confirmContainer, confirmStyle]} pointerEvents="none">
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
    zIndex: 9999,
    overflow: "hidden",
  },
  // Lenzuolo nero che copre l'area "bruciata" (dall'alto, cresce)
  ash: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "#0A0A0A",
  },
  // Container della linea di fuoco — altezza 48px così c'è spazio per il glow
  fireLineWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  // Glow esteso (sfumato) attorno alla linea
  glowOuter: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 12,
    height: 24,
    backgroundColor: "#FF6B35",
    opacity: 0.35,
    // Su iOS lo shadow funziona, su Android serve elevation
    shadowColor: "#FF8C00",
    shadowOpacity: 1,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
    elevation: 24,
  },
  // Glow intenso centrale (cuore della fiamma)
  glowInner: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 22,
    height: 4,
    backgroundColor: "#FFD27A",
    opacity: 0.95,
    shadowColor: "#FFD27A",
    shadowOpacity: 1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  // Sigillo al centro dello schermo
  sealContainer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  sealIcon: {
    fontSize: 72,
    marginBottom: 18,
    textShadowColor: "#FF6B35",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  sealText: {
    color: "#FFE4B5",
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 40,
    textShadowColor: "rgba(255, 107, 53, 0.55)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  // Conferma in basso
  confirmContainer: {
    position: "absolute",
    bottom: SCREEN_H * 0.18,
    left: 0,
    right: 0,
    paddingHorizontal: 32,
    alignItems: "center",
  },
  confirmText: {
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 14,
    textAlign: "center",
    fontStyle: "italic",
  },
});
