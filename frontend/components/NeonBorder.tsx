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
import React from "react";
import { StyleSheet, Platform, useWindowDimensions, View } from "react-native";
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

// Tutti gli stati sono FISSI, senza pulsazione ciclica, senza fade.
//
// === RISCRITTURA 2026-07-30 v64.10 — Fix definitivo flash Android ===
// Il ciclo di pulsazione (SLOW_CYCLE_MS) causava un flash schermo periodico
// su Xiaomi/Honor EMUI/HarmonyOS. Rimossa oscillazione ciclica.
//
// === v64.11 — Rimozione elevation/shadow ===
// elevation:18 causava vignette scura permanente su Honor. Rimossa.
//
// === v64.13 (2026-07-31) — Sync perfetto con l'orb ===
// Rimosso anche il fade di 500ms sul cambio colore. L'orb (EclipseOrb)
// cambia colore ISTANTANEAMENTE via useMemo → il bordo deve fare uguale
// per essere sincronizzato. Ora il colore è applicato direttamente allo
// style come step function (0ms), senza animazione intermedia.

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
  thickness,
  speakingColorOverride,
  idleColorOverride,
  radiusOverride,
}: {
  status: NeonBorderStatus;
  /** Se non fornito: 3px iOS/web, 4px Android (curva schermo "mangia" il bordo,
   *  serve leggermente più spessore per essere ugualmente visibile). */
  thickness?: number;
  /** Se fornito e status === "speaking", sostituisce il viola fisso #BD10E0.
   *  Serve per legare il colore dell'orb/bordo alla voce scelta
   *  (es. Acqua=viola, Vento=cobalto). */
  speakingColorOverride?: string;
  /** Se fornito e status === "idle", sostituisce lo champagne #D4B896.
   *  Alcuni utenti su schermi curvi Honor/Xiaomi trovano lo champagne poco
   *  visibile: possono scegliere un colore più contrastato via Impostazioni
   *  → Bordo → "Colore idle alternativo". */
  idleColorOverride?: string;
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
  //   42-52px, tablet più squadrati.
  //
  //   === FIX Honor curved edges (2026-08-02, Fabio) ===
  //   Alzato il default da 42 → 48. Su Honor con schermo curvo pronunciato,
  //   42px lasciava il bordo "dentro" la curva fisica → invisibile agli
  //   angoli. 48px lo porta più fuori sui device curvi senza penalizzare
  //   Samsung/Pixel (schermi più squadrati) che al massimo hanno un radius
  //   leggermente esuberante ma comunque visibile.
  //
  // Se il default non combacia su un dispositivo specifico, l'utente può
  // passare `radiusOverride` dal chiamante (app/index.tsx, che lo prende
  // dallo slider di calibrazione in Impostazioni → Bordo).
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
    // Smartphone Android moderno: curva generosa (Honor curvo, Xiaomi, Samsung, Pixel)
    return 48;
  })();

  const DISPLAY_RADIUS = radiusOverride ?? computedRadius;
  // Thickness default per piattaforma: Android +1px per compensare il "mangia
  // bordo" delle curve fisiche degli schermi curvi Honor/Xiaomi.
  const effectiveThickness = thickness ?? (Platform.OS === "android" ? 4 : 3);
  const baseColor = STATE_COLORS[status];
  // Override dinamico per "speaking" — legato alla voce scelta dall'utente.
  // Override statico per "idle" — permette calibrazione utente su schermi
  // curvi dove lo champagne default si vede poco. Per gli altri stati il
  // colore resta sempre fisso (l'utente non deve poter cambiare i colori
  // di feedback delle azioni — parte del linguaggio visivo dell'app).
  const color =
    (status === "speaking" && speakingColorOverride) ? speakingColorOverride :
    (status === "idle" && idleColorOverride) ? idleColorOverride :
    baseColor;

  // ============ CAMBIO COLORE ISTANTANEO (v64.13) =============================
  // === STORIA DEL PROBLEMA E SOLUZIONE DEFINITIVA ===
  // v64.10-12: il bordo aveva un fade di 500ms sul cambio colore, prima con
  // Animated di RN (JS thread, lento su Honor), poi con Reanimated (thread
  // nativo UI, veloce). Ma anche con Reanimated il fade DURA 500ms →
  // l'utente percepiva un desync di ~500ms con l'eclissi (EclipseOrb), che
  // invece cambia colore ISTANTANEAMENTE (useMemo, 0ms transition).
  //
  // v64.13 (2026-07-31, Fabio): sync perfetto richiede che entrambi i
  // componenti abbiano la STESSA curva di transizione. EclipseOrb usa
  // step function (0ms) → NeonBorder DEVE fare lo stesso.
  //
  // Approccio: nessuna animazione. Il colore viene applicato direttamente
  // come style. React ri-renderizza entrambi i componenti nello stesso
  // ciclo → sync garantito matematicamente su ogni piattaforma, senza
  // dipendenze da JS thread, native driver, o library di animazione.
  //
  // Trade-off accettato: perdiamo la sfumatura morbida del fade. Ma il
  // requisito primario ("sync perfetto con l'orb") è non negoziabile.
  //
  // ============ CODICE MORTO RIMOSSO ============
  // Il vecchio "LIQUID NEON FLOW" (luce che scorre lungo il perimetro
  // durante `thinking`) era stato scritto ma mai renderizzato — rimosso
  // completamente in v64.12.

  // ============ RENDER ============
  //
  // === RIMOZIONE elevation + shadowRadius (v64.11) ===
  // elevation:18 su View absoluteFill causava un alone SCURO fisso lungo
  // il perimetro interno su smartphone Honor (EMUI/MagicOS). Android
  // rende `elevation` come drop-shadow reale → su superficie a schermo
  // pieno = vignette scura permanente. Rimosso; il neon-effect si ottiene
  // dai colori vividi + spessore 3px, senza glow artificiale.
  return (
    <View
      pointerEvents="none"
      style={[
        styles.frame,
        {
          borderColor: color,
          borderWidth: effectiveThickness,
          borderRadius: DISPLAY_RADIUS,
          opacity: 1.0,
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
