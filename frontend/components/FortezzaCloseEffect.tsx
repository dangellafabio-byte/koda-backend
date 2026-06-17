/**
 * FortezzaCloseEffect — "Release / Closure" animation (2026-06-17 v4).
 *
 * Concetto:
 *   "Questa esperienza si conclude e lascia spazio al presente."
 *   NON distruzione, NON cancellazione aggressiva. Solo chiusura,
 *   leggerezza, rilascio, continuità.
 *
 * Sequenza (durata totale ~1.7s):
 *   1. 0-150ms   — interazione bloccata, prep
 *   2. 0-800ms   — l'eclissi fa UN respiro (espande +10%, tiene 100ms, torna)
 *   3. 150-750ms — il contenuto del confessionale (chat / pulsanti / sfondo
 *                  secondario) sfuma a 0 opacità in parallelo al respiro
 *   4. 800-1300ms — l'eclissi resta sola al centro, immobile (500ms)
 *   5. 1300-1700ms — scrim svanisce (fade-in della Home) → onComplete (400ms)
 *
 * L'animazione gira IDENTICA sia in chat confessionale che in Home (anche
 * senza messaggi): il componente non dipende dalla presenza di contenuti.
 * Il chiamante può passare `theme` per allineare lo scrim alla palette
 * corrente (di default usa nero/notte).
 */

import React, { useEffect } from "react";
import { View, StyleSheet, Dimensions, Platform } from "react-native";
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
  /**
   * Colore di sfondo dello scrim. Default: nero notte (#0A0A0A).
   * Passa il `theme.bg` corrente per integrarsi visivamente con la Home
   * (giorno, cielo, bosco, ciliegia, ecc.).
   */
  scrimColor?: string;
  /**
   * Colore dell'eclissi di chiusura. Default: verde menta (#7FE0C4).
   * Idealmente passare il colore brand dell'orb (tonalità "neutral"). */
  orbColor?: string;
  /**
   * Mantenuto per back-compat (era usato dal vecchio effetto "burn"
   * per il sigillo 🔒 e il messaggio di conferma). Ora ignorato.
   */
  labels?: { sealed?: string; confirmation?: string };
};

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// Misura dell'orb riprodotto qui dentro. Allineato a Math.min(W*0.78, 360)
// usato in app/index.tsx → sembra "lo stesso orb" anche se è un duplicato
// di chiusura.
const ORB_SIZE = Math.min(SCREEN_W * 0.78, 360);

// === TIMINGS (ms) ===
const T_BREATH_EXPAND = 350; // 0 → +10% scale
const T_BREATH_HOLD = 100;   // resta ferma
const T_BREATH_BACK = 350;   // → scale 1
const T_BREATH_TOTAL = T_BREATH_EXPAND + T_BREATH_HOLD + T_BREATH_BACK; // 800

const T_SCRIM_DELAY = 150;   // prima del fade-in dello scrim (lock interaction)
const T_SCRIM_IN = 600;      // chat content sfuma sotto lo scrim

const T_HOLD_AFTER_BREATH = 500; // eclissi sola al centro
const T_SCRIM_OUT = 400;     // scrim si dissolve → home appare

const T_TOTAL =
  T_SCRIM_DELAY + Math.max(T_BREATH_TOTAL, T_SCRIM_IN) + T_HOLD_AFTER_BREATH + T_SCRIM_OUT;

function fireHaptic(kind: "light" | "soft") {
  if (Platform.OS === "web") return;
  try {
    if (kind === "soft" && (Haptics as any).ImpactFeedbackStyle?.Soft) {
      Haptics.impactAsync((Haptics as any).ImpactFeedbackStyle.Soft);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  } catch {}
}

export default function FortezzaCloseEffect({
  visible,
  onComplete,
  scrimColor,
  orbColor,
}: Props) {
  // Lo scrim copre l'ambiente (chat / pulsanti / sfondo secondario).
  // Fade in 0→1 in T_SCRIM_IN ms, partendo dopo T_SCRIM_DELAY.
  const scrimOpacity = useSharedValue(0);

  // L'orb di chiusura — visibile sopra lo scrim. Inizia a vista quando
  // lo scrim copre la chat (così l'utente percepisce "l'eclissi resta
  // ferma, l'ambiente si dissolve attorno").
  const orbOpacity = useSharedValue(0);
  const orbScale = useSharedValue(1);
  const orbHaloOpacity = useSharedValue(0);

  // Container globale — fade-out finale per cedere il posto alla Home.
  const containerOpacity = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      scrimOpacity.value = 0;
      orbOpacity.value = 0;
      orbScale.value = 1;
      orbHaloOpacity.value = 0;
      containerOpacity.value = 0;
      return;
    }

    // Tocco morbido all'inizio (chiusura) e fine (continuità).
    fireHaptic("light");

    // Container istantaneamente visibile (lock interazione).
    containerOpacity.value = 1;

    // Scrim fade-in dopo 150ms (l'utente vede prima il respiro).
    scrimOpacity.value = withDelay(
      T_SCRIM_DELAY,
      withTiming(1, { duration: T_SCRIM_IN, easing: Easing.out(Easing.cubic) })
    );

    // Eclissi appare insieme allo scrim (così sembra che "resti" mentre
    // tutto il resto svanisce). Il fade-in è leggero perché il respiro
    // è già iniziato.
    orbOpacity.value = withDelay(
      T_SCRIM_DELAY,
      withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) })
    );

    // Alone leggero attorno all'eclissi durante il respiro — sparisce
    // dopo il respiro per dare sensazione di "rilascio".
    orbHaloOpacity.value = withSequence(
      withDelay(0, withTiming(0.35, { duration: T_BREATH_EXPAND, easing: Easing.out(Easing.cubic) })),
      withDelay(T_BREATH_HOLD, withTiming(0, { duration: T_BREATH_BACK + 400, easing: Easing.out(Easing.cubic) }))
    );

    // RESPIRO: scale 1 → 1.10 → tiene → 1.
    orbScale.value = withSequence(
      withTiming(1.10, { duration: T_BREATH_EXPAND, easing: Easing.out(Easing.cubic) }),
      withDelay(T_BREATH_HOLD, withTiming(1.0, { duration: T_BREATH_BACK, easing: Easing.inOut(Easing.cubic) }))
    );

    // FASE FINALE: dopo respiro + hold, fade-out globale → home.
    const fadeOutDelay = T_SCRIM_DELAY + T_BREATH_TOTAL + T_HOLD_AFTER_BREATH;
    containerOpacity.value = withDelay(
      fadeOutDelay,
      withTiming(0, { duration: T_SCRIM_OUT, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished && onComplete) {
          runOnJS(onComplete)();
        }
      })
    );

    // Haptic morbido alla fine (rilascio).
    const hTimer = setTimeout(() => fireHaptic("soft"), fadeOutDelay);
    return () => clearTimeout(hTimer);
  }, [visible, onComplete, scrimOpacity, orbOpacity, orbScale, orbHaloOpacity, containerOpacity]);

  const scrim = scrimColor || "#0A0A0A";
  const orb = orbColor || "#7FE0C4"; // verde menta Aria/Theo neutrale

  const containerStyle = useAnimatedStyle(() => ({ opacity: containerOpacity.value }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const orbBoxStyle = useAnimatedStyle(() => ({
    opacity: orbOpacity.value,
    transform: [{ scale: orbScale.value }],
  }));
  const haloStyle = useAnimatedStyle(() => ({ opacity: orbHaloOpacity.value }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.container, containerStyle]}
      pointerEvents={visible ? "auto" : "none"}
    >
      {/* Scrim a tinta unita che copre l'ambiente (chat/pulsanti/sfondo
          secondario). Fade-in graduale → la chat svanisce sotto. */}
      <Animated.View
        style={[styles.scrim, { backgroundColor: scrim }, scrimStyle]}
        pointerEvents="none"
      />

      {/* Eclissi di chiusura — sopra lo scrim, al centro. È un cerchio
          semplice con un gradiente radiale "fatto a mano" tramite due
          layer (alone esterno + corpo morbido) per ricreare la sensazione
          di presenza dell'orb senza dover importare EclipseOrb (che ha
          troppe dipendenze status/tone). */}
      <View style={styles.orbWrap} pointerEvents="none">
        {/* Halo morbido — emerge durante il respiro, sparisce subito dopo */}
        <Animated.View
          style={[
            styles.halo,
            {
              width: ORB_SIZE * 1.45,
              height: ORB_SIZE * 1.45,
              borderRadius: (ORB_SIZE * 1.45) / 2,
              backgroundColor: orb,
            },
            haloStyle,
          ]}
        />

        {/* Corpo dell'eclissi */}
        <Animated.View style={[styles.orbBody, orbBoxStyle]}>
          <View
            style={[
              styles.orbInner,
              {
                width: ORB_SIZE,
                height: ORB_SIZE,
                borderRadius: ORB_SIZE / 2,
                backgroundColor: orb,
              },
            ]}
          />
          {/* Highlight sottile per simulare profondità */}
          <View
            style={[
              styles.orbHighlight,
              {
                width: ORB_SIZE * 0.55,
                height: ORB_SIZE * 0.55,
                borderRadius: (ORB_SIZE * 0.55) / 2,
                top: ORB_SIZE * 0.12,
                left: ORB_SIZE * 0.16,
              },
            ]}
          />
        </Animated.View>
      </View>
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
    elevation: 9999,
    justifyContent: "center",
    alignItems: "center",
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  orbWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  halo: {
    position: "absolute",
    opacity: 0,
    // shadow finto per dare "glow" attorno
    shadowColor: "#7FE0C4",
    shadowOpacity: 0.25,
    shadowRadius: 60,
    shadowOffset: { width: 0, height: 0 },
  },
  orbBody: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  orbInner: {
    position: "absolute",
    // Sottile ombra interna per profondità — su iOS è il body shadow
    // che fa il lavoro vero. Manteniamo solid color per coerenza con
    // EclipseOrb (che è solid + waveform).
  },
  orbHighlight: {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.15)",
    // Glow morbido in alto-sinistra → impressione di luce naturale
  },
});
