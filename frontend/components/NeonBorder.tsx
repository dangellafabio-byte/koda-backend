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
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Platform, useWindowDimensions } from "react-native";
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolateColor,
  Easing as ReanimatedEasing,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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

export default function NeonBorder({
  status,
  thickness = 3,
  speakingColorOverride,
  radiusOverride,
}: {
  status: NeonBorderStatus;
  thickness?: number;
  /** Se fornito e status === "speaking", sostituisce il viola fisso #BD10E0.
   *  Serve per legare il colore dell'orb/bordo alla voce scelta
   *  (es. Acqua=viola, Vento=cobalto). */
  speakingColorOverride?: string;
  /** Override del corner radius calcolato euristicamente. Utile se un
   *  dispositivo specifico (Honor XY, Xiaomi ZZ) ha una curvatura schermo
   *  che l'euristica non azzecca — passa il valore corretto da index.tsx. */
  radiusOverride?: number;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // === CALCOLO CORNER RADIUS DELLO SCHERMO ===
  //
  // Ogni dispositivo ha una curvatura degli angoli fisicamente diversa.
  // La vera rilevazione automatica richiederebbe un native module (Android
  // 12+ espone `WindowInsets.getRoundedCorner()`, iOS ha una tabella per
  // modello). Per ora usiamo una euristica pragmatica per piattaforma.
  //
  // iOS: `insets.top` correla bene col corner radius reale.
  //   Dynamic Island (iPhone 14 Pro+)  → insets.top ~59 → radius 55
  //   Notch standard (iPhone X..13)    → insets.top ~47 → radius 47
  //   Notch piccolo (iPhone Xr, ecc.)  → insets.top ~44 → radius 40
  //   iPad / iPhone SE (squadrati)     → insets.top ~20 → radius 14
  //
  // Android: `insets.top` NON correla col radius (uno smartphone Honor con
  //   status bar 28px può avere angoli da 42-48px). Usiamo una euristica
  //   basata sulla dimensione schermo: smartphone moderni 2020+ tipicamente
  //   32-48px, tablet più squadrati. Default smartphone Android = 42
  //   (valore medio che si adatta a Honor, Xiaomi, Samsung, Pixel, OnePlus).
  //
  // Se il default non combacia su un dispositivo specifico, l'utente può
  // passare `radiusOverride` dal chiamante (app/index.tsx).
  const shortSide = Math.min(W, H);
  const isTabletSize = shortSide >= 600;

  const computedRadius = (() => {
    if (Platform.OS === "web") return 24;

    if (Platform.OS === "ios") {
      if (isTabletSize) return 18; // iPad
      return insets.top >= 55 ? 55 :
             insets.top >= 45 ? 47 :
             insets.top >= 35 ? 40 :
             insets.top >= 25 ? 22 :
             14;
    }

    // Android
    if (isTabletSize) return 16; // Android tablet (schermi tipicamente squadrati)
    // Smartphone Android moderno: curva generosa (Honor, Xiaomi, Samsung, Pixel)
    return 42;
  })();

  const DISPLAY_RADIUS = radiusOverride ?? computedRadius;
  const baseColor = STATE_COLORS[status];
  // Override dinamico per "speaking" — legato alla voce scelta dall'utente.
  // Per gli altri stati il colore resta sempre fisso.
  const color = (status === "speaking" && speakingColorOverride)
    ? speakingColorOverride
    : baseColor;

  // ============ TRANSIZIONE FLUIDA DEL COLORE AL CAMBIO STATO =================
  // === v64.12 (2026-08 fix sync Honor): migrato ad REANIMATED 3 ===
  // Storia: usavamo Animated.timing di React Native con useNativeDriver:false
  // (obbligatorio per animare `borderColor` in RN). Su iPhone/iPad il thread
  // JS è veloce e l'animazione partiva subito → sync perfetto con l'orb (che
  // cambia colore istantaneamente al cambio stato).
  // Su Honor / Android sotto carico (WebSocket voce, VAD, audio decode) il
  // thread JS era occupato → Animated.timing partiva in ritardo di ~500ms
  // → utente vedeva bordo aggiornarsi 0.5s dopo l'eclissi. Non accettabile.
  //
  // Fix definitivo: Reanimated 3 esegue l'animazione sul thread NATIVO UI,
  // indipendente dal carico JS. Il colore parte a cambiare immediatamente
  // al momento del cambio prop → sync perfetto con l'orb su ogni dispositivo.
  const colorProgress = useSharedValue(1);
  const prevColorRef = useRef(color);
  const [prevColor, setPrevColor] = useState(color);
  const [currColor, setCurrColor] = useState(color);
  useEffect(() => {
    if (color === prevColorRef.current) return;
    // Il colore è cambiato: parti dal vecchio e sfuma al nuovo in 500ms
    // sul thread UI nativo (indipendente dal JS thread).
    setPrevColor(prevColorRef.current);
    setCurrColor(color);
    prevColorRef.current = color;
    colorProgress.value = 0;
    colorProgress.value = withTiming(1, {
      duration: COLOR_TRANSITION_MS,
      easing: ReanimatedEasing.inOut(ReanimatedEasing.ease),
    });
  }, [color, colorProgress]);

  const animatedBorderStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      colorProgress.value,
      [0, 1],
      [prevColor, currColor],
    ),
  }));

  // ============ CODICE MORTO RIMOSSO (v64.12) ============
  // Il vecchio "LIQUID NEON FLOW" (luce che scorre lungo il perimetro
  // durante `thinking`) era stato scritto ma mai renderizzato — restava
  // calcolato in memoria e faceva girare un Animated.loop su useNativeDriver:
  // false che comunque scaldava il JS thread. Rimosso completamente qui.
  // Se in futuro si vuole recuperare l'effetto, va reimplementato con
  // Reanimated + react-native-svg Reanimated bindings.

  // ============ RENDER ============
  // v64.11 (2026-08 fix Honor): bordo con colore che sfuma dolcemente al
  // cambio stato (500ms single-shot), opacity fissa a 1.0, nessuna
  // oscillazione ciclica.
  //
  // === RIMOZIONE elevation + shadowRadius ===
  // Storia: elevation:18 su View absoluteFill causava un alone SCURO fisso
  // lungo tutto il perimetro interno su smartphone Honor (EMUI/MagicOS).
  // Android rende `elevation` come drop-shadow reale: su una superficie
  // grande quanto lo schermo, l'ombra proiettata risulta come una vignette
  // scura permanente. Non era "neon glow" ma inquinamento visivo.
  // Anche shadowRadius:28 su iOS creava un effetto simile (meno marcato).
  //
  // Nuova specifica: bordo pulito, solo `borderColor` + `borderWidth`.
  // I colori shocking-neon (#00F5D4 tiffany, #EC4899 ciclamino, ecc.)
  // sono già sufficientemente vividi da leggersi come "neon" senza glow.
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        styles.frame,
        {
          borderWidth: thickness,
          borderRadius: DISPLAY_RADIUS,
          opacity: 1.0,
        },
        animatedBorderStyle,
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
