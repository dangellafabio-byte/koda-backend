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
import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Animated, Easing, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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

// Tutti gli stati sono FISSI, senza pulsazione ciclica.
//
// === RISCRITTURA 2026-07-30 v64.10 — Fix definitivo flash Android ===
// Storia: il ciclo di pulsazione (SLOW_CYCLE_MS) causava un flash schermo
// periodico su Xiaomi/Honor EMUI/HarmonyOS (misurato ~19s = 20s del ciclo).
// Test binario confermò la causa. L'oscillazione era comunque impercettibile
// a occhio (bordo 3px con 15% variazione opacità), ma il compositor Android
// la vedeva e triggerava HDR-boost momentaneo → flash visibile.
//
// Nuova specifica (Fabio 2026-07-30):
//   ❌ NIENTE oscillazione ciclica nel tempo (rimosso SLOW_CYCLE_MS e loop)
//   ✅ Transizione FLUIDA di colore quando lo stato cambia (~500ms), come
//      fa l'orb quando cambia stato. Single-shot, non ciclica: parte al
//      cambio stato e si ferma.
//   ✅ Opacity fissa a 1.0 (bordo sempre pienamente visibile)
//   ✅ Elevation/shadowRadius mantenuti (glow neon statico, non pulsa più)
//
// Il comportamento è ora identico su iOS e Android.
const COLOR_TRANSITION_MS = 500;

// Display border radius:
// === FIX #6 (2026-06-22 v6) — Adattamento dinamico al device ===
// Prima usavamo `DISPLAY_RADIUS = 56` hardcoded. Su iPhone con notch/Dynamic
// Island (insets.top ~47-59) il valore funzionava, ma su device con
// schermo a spigoli più dritti (iPhone SE, iPad, Android vari) il bordo
// risultava "troppo arrotondato" e non seguiva i veri angoli del display.
//
// Heuristica: il radius reale del display correla con l'altezza dell'inset
// superiore. Notch/Island ≥ 30px → device con corner radius pieno (47-55).
// Notch piccolo o assente → schermo squadrato (~14px o meno).
// Calcoliamo runtime via useSafeAreaInsets per essere universali.
const DEFAULT_RADIUS = 47;

export default function NeonBorder({
  status,
  thickness = 3,
  speakingColorOverride,
}: {
  status: NeonBorderStatus;
  thickness?: number;
  /** Se fornito e status === "speaking", sostituisce il viola fisso #BD10E0.
   *  Serve per legare il colore dell'orb/bordo alla voce scelta
   *  (es. Acqua=viola, Vento=cobalto). */
  speakingColorOverride?: string;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Stima del corner radius reale del display:
  //   insets.top ≥ 50 → Dynamic Island (iPhone 14 Pro+)         → ~55
  //   insets.top ≥ 40 → notch standard (iPhone X..13)           → ~47
  //   insets.top ≥ 30 → notch piccolo / Android moderno         → ~38
  //   insets.top ≥ 24 → status bar normale (Android tablet)     → ~18
  //   altro           → schermo squadrato (iPhone SE, vecchi)   → ~14
  const dynamicRadius =
    insets.top >= 50 ? 55 :
    insets.top >= 40 ? 47 :
    insets.top >= 30 ? 38 :
    insets.top >= 24 ? 18 :
    14;
  // Su web/tablet usiamo un valore conservativo
  const DISPLAY_RADIUS = Platform.OS === "web" ? 24 : dynamicRadius;
  const baseColor = STATE_COLORS[status];
  // Override dinamico per "speaking" — legato alla voce scelta dall'utente.
  // Per gli altri stati il colore resta sempre fisso.
  const color = (status === "speaking" && speakingColorOverride)
    ? speakingColorOverride
    : baseColor;

  // ============ TRANSIZIONE FLUIDA DEL COLORE AL CAMBIO STATO =================
  // NIENTE animation loop. Un solo Animated.timing single-shot che parte al
  // cambio di colore, dura 500ms, e si ferma. Zero consumo CPU quando lo
  // stato è stabile → nessun trigger del power manager EMUI su Android.
  const colorProgress = useRef(new Animated.Value(1)).current;
  const prevColorRef = useRef(color);
  const [prevColor, setPrevColor] = useState(color);
  const [currColor, setCurrColor] = useState(color);
  useEffect(() => {
    if (color === prevColorRef.current) return;
    // Il colore è cambiato: parti dal vecchio e sfuma al nuovo in 500ms.
    setPrevColor(prevColorRef.current);
    setCurrColor(color);
    prevColorRef.current = color;
    colorProgress.setValue(0);
    Animated.timing(colorProgress, {
      toValue: 1,
      duration: COLOR_TRANSITION_MS,
      easing: Easing.inOut(Easing.ease),
      // useNativeDriver:false è OBBLIGATORIO per animare colori in RN.
      // Ma è single-shot (500ms), non ciclico → nessun trigger periodico
      // del compositor Android come lo era il vecchio loop.
      useNativeDriver: false,
    }).start();
  }, [color, colorProgress]);

  const animatedBorderColor = colorProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [prevColor, currColor],
  });

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
  }, [W, H, DISPLAY_RADIUS]);
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
  // v64.10: bordo con colore che sfuma dolcemente al cambio stato (500ms
  // single-shot), opacity fissa a 1.0, nessuna oscillazione ciclica.
  // Glow neon (elevation/shadowRadius) STATICO — non pulsa più → nessun
  // trigger del power manager EMUI/HarmonyOS.
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.frame,
        {
          borderColor: animatedBorderColor,
          borderWidth: thickness,
          borderRadius: DISPLAY_RADIUS,
          opacity: 1.0,
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
