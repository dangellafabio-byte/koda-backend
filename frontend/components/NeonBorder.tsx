/**
 * NeonBorder v4 — bordo neon arrotondato sul perimetro del display.
 *
 * Cambiamenti rispetto a v3:
 *  - PULSAZIONE LENTISSIMA E INDIPENDENTE: ~7s per ciclo per tutti gli stati,
 *    opacity oscilla 0.75 ↔ 1.0 (quasi fissa, sempre molto visibile).
 *    Non c'è sincronia con l'eclissi: il bordo "respira" per conto suo,
 *    lentamente, come una presenza costante.
 *  - THINKING = LUCE CHE GIRA attorno al perimetro: niente più pulsazione
 *    classica, mostriamo un segmento di neon che corre continuamente lungo
 *    tutto il bordo arrotondato (effetto "caricamento neon"). Bel sostituto
 *    del solito spinner.
 *  - Colori shocking neon (validati).
 */
import React, { useEffect, useMemo, useRef } from "react";
import { StyleSheet, Animated, Easing, Platform, useWindowDimensions } from "react-native";
import Svg, { Rect } from "react-native-svg";

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export type NeonBorderStatus = "idle" | "recording" | "thinking" | "speaking" | "confessional" | "listening";

// === COLORI SHOCKING NEON ===
// IMPORTANTE: queste palette DEVONO restare 1:1 sincronizzate con quelle
// di EclipseOrb (components/EclipseOrb.tsx). Se cambi un colore qui, devi
// cambiarlo anche lì — altrimenti il bordo e l'eclissi diventano
// desincronizzati e l'utente non capisce più cosa sta facendo l'app.
//
// Mappatura attuale (NeonBorder ↔ EclipseOrb):
//   idle          #D4B896 ↔ TONE_PALETTES.neutral[1]      (champagne caldo)
//   recording     #00F5D4 ↔ LISTEN_PALETTE[1]              (tiffany neon)
//   listening     (alias di recording — vedi index.tsx, ora unificati)
//   thinking      #EC4899 ↔ THINK_PALETTE[1]               (ciclamino)
//   speaking      #BD10E0 ↔ TONE_PALETTES.warm[1]          (viola elettrico)
//   confessional  #FF1744 ↔ TONE_PALETTES.confessional[1]  (scarlatto)
//
// === IDLE COLOR HISTORY ===
// 1ª versione: #FF1493 (rosa shocking) — INDISTINGUIBILE dal ciclamino
//   del thinking → utente credeva l'app "stuck on thinking" per ore.
// 2ª versione: #7DD3C0 (verde menta) — distinto dal ciclamino, MA troppo
//   simile al tiffany del recording → utente non capiva se stava
//   ascoltando o era ferma.
// 3ª versione: #D4B896 (champagne caldo) ✓ — contrasto caldo/freddo
//   massimo con tiffany. Impossibile confondere a colpo d'occhio. Coerente
//   con la metafora: idle = candela accesa, attesa pacata.
const STATE_COLORS: Record<NeonBorderStatus, string> = {
  idle: "#D4B896",        // 🕯️ Champagne caldo (READY/IN ATTESA)
  recording: "#00F5D4",   // 💎 Tiffany neon (TI ASCOLTO — match orb LISTEN_PALETTE[1])
  listening: "#00F5D4",   // 💎 Tiffany neon (alias di recording, stesso colore)
  thinking: "#EC4899",    // 🩷 Ciclamino (STO PENSANDO)
  speaking: "#BD10E0",    // 🟣 Viola elettrico (STO PARLANDO)
  confessional: "#FF1744",// ❤️‍🔥 Scarlatto (STANZA SEGRETA)
};

// Tutti gli stati hanno pulsazione MOLTO lenta (~7s), quasi immobile,
// per essere una presenza costante senza distrarre.
const SLOW_CYCLE_MS = 7000;

// Display border radius (matcha gli angoli iPhone moderni)
const DISPLAY_RADIUS = 56;

export default function NeonBorder({
  status,
  thickness = 3,
}: {
  status: NeonBorderStatus;
  thickness?: number;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const color = STATE_COLORS[status];

  // ============ PULSAZIONE LENTA (tutti gli stati tranne thinking) ============
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pulse.setValue(0);
    if (status === "thinking") return; // thinking ha la sua animazione (chase)
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: SLOW_CYCLE_MS / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: SLOW_CYCLE_MS / 2,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [status, pulse]);

  // opacity quasi fissa: oscilla tra 0.75 e 1.0 (sempre molto visibile)
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] });

  // ============ LIQUID NEON FLOW (solo thinking) ============
  // Flusso circolare con scia: una "testa" luminosa corre attorno al perimetro
  // arrotondato, seguita da una "scia" più lunga e sfumata. Loop continuo.
  // Implementato con DUE Rect SVG sovrapposti che condividono lo stesso
  // dashOffset animato:
  //   1) "scia" = dashLen lunga (30% perim), opacity bassa, no glow forte
  //   2) "testa" = dashLen corta (6% perim), opacity 1, glow massimo
  // L'effetto visivo è: una luce neon che scorre come liquido lungo il bordo.
  const perimeter = useMemo(() => {
    const r = DISPLAY_RADIUS;
    return 2 * (W + H) - 8 * r + 2 * Math.PI * r;
  }, [W, H]);
  const headLen = Math.max(40, perimeter * 0.06);
  const trailLen = Math.max(120, perimeter * 0.30);
  const headDashArray = `${headLen} ${perimeter}`;
  const trailDashArray = `${trailLen} ${perimeter}`;

  const dashOffset = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    dashOffset.setValue(0);
    if (status !== "thinking") return;
    const anim = Animated.loop(
      Animated.timing(dashOffset, {
        toValue: -perimeter,
        duration: 2400,
        easing: Easing.linear,
        useNativeDriver: false,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [status, perimeter, dashOffset]);
  // Offset per la testa: stessa posizione della scia + lunghezza scia
  // (così la testa è SOPRA la coda della scia, illuminandone l'estremità).
  const headOffset = Animated.subtract(dashOffset, new Animated.Value(trailLen - headLen)) as any;

  // ============ RENDER ============
  // NB: thinking ora usa lo stesso bordo fisso degli altri stati (user
  // feedback: "togli il bordo che si muove, fallo fisso come tutti").
  // L'effetto chase Liquid Neon Flow è disabilitato per ora.
  //
  // Tutti gli stati: bordo fisso arrotondato con pulsazione lentissima
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.frame,
        {
          borderColor: color,
          borderWidth: thickness,
          borderRadius: DISPLAY_RADIUS,
          opacity,
          ...Platform.select({
            ios: {
              shadowColor: color,
              shadowOpacity: 1,
              shadowRadius: 28,
              shadowOffset: { width: 0, height: 0 },
            },
            android: { elevation: 18 },
            default: {},
          }),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
  },
});
