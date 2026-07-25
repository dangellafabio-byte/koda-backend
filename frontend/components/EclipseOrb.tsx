/**
 * EclipseOrb — La nuova presenza di L'Amico Fraterno.
 *
 * METAFORA: "L'Eclissi Dinamica".
 *
 * Un disco nero perfetto al centro dello schermo (= silenzio, ombra,
 * scatola nera emotiva, custode dei segreti). Dietro di lui una sorgente
 * di luce viva — un'aurora boreale che pulsa, emerge dai bordi e si ritira
 * a seconda dello stato:
 *
 *   • idle      → respiro lentissimo, aurora discreta, neutra
 *   • recording → la luce si RITRAE verso l'interno (sta assorbendo
 *                 le tue parole), colore freddo
 *   • thinking  → flickering breve (pensiero, esitazione)
 *   • speaking  → l'aurora ESPLODE da dietro il disco, filamenti
 *                 luminosi si estendono, colore = tono emotivo della frase
 *
 * COSTRUZIONE (tutto SVG + Animated, niente Skia, niente nuovo build EAS):
 *   Layer 0 — Halo base (radial gradient grande dietro tutto)
 *   Layer 1 — 4 filamenti (radial gradients off-center che ruotano)
 *   Layer 2 — Disco nero centrale (cerchio con leggero inner gradient)
 *   Layer 3 — Rim light (anello di luce sul bordo del disco)
 *
 * Tutte le animazioni usano useNativeDriver dove possibile (rotate,
 * scale, opacity, translateX) → 60fps garantiti.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { View, StyleSheet, Animated, Easing, Platform } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";
import { useTheme } from "../lib/theme";

// === TEST DIAGNOSTICO 2026-07-25 v63.9 — bagliore schermo Honor/Huawei ===
// Utente segnala flash schermo hardware ogni ~7s SOLO su Honor/Huawei
// (EMUI/HarmonyOS). Test 1+2 hanno escluso JS-timers e network. Il
// pattern ~7s coincide col ciclo del breath (3.8s×2 = 7.6s), ma la
// causa è ipotesi non ancora provata al 100%.
//
// Questa flag disabilita SOLO il breath cycle SOLO su Android, SOLO
// in questo build diagnostico v63.9. Se il flash sparisce → confermato
// colpevole → build successivo cerca soluzione tecnica (window flag
// Android, cambio scale→opacity, o altro) che elimini flash MANTENENDO
// l'animazione identica a iOS.
//
// SU iOS: TUTTO invariato (breath continua normalmente).
// SU Android: breath disabilitato per test (orb immobile — atteso).
// Rimuovere questa flag e riabilitare breath dopo che la vera fix
// tecnica sarà trovata e testata.
const KODA_BREATH_DIAGNOSTIC_DISABLE_ANDROID = Platform.OS === "android";

export type OrbStatus = "idle" | "recording" | "transcribing" | "thinking" | "speaking";
export type OrbTone =
  | "neutral"
  | "calm"
  | "warm"
  | "energetic"
  | "concerned"
  | "urgent"
  | "confessional";

type Props = {
  status: OrbStatus;
  /** Tone of the latest AI reply — drives aurora color when speaking. */
  tone?: OrbTone | null;
  /** Total square size in px. Default 280. */
  size?: number;
  /** Live mic dB during recording — drives gentle inward pulse */
  meterDb?: number | null;
  meterThreshold?: number | null;
  /** Override della palette durante "speaking" — legata alla voce scelta.
   *  Acqua=viola (default), Vento=cobalto. Se passato, sostituisce
   *  TONE_PALETTES.warm/concerned/etc durante lo speaking. */
  speakingPaletteOverride?: [string, string, string] | null;
  /** Se true, la `speakingPaletteOverride` viene applicata anche durante
   *  "idle" — non solo "speaking". Utile in KodaIntro per dare alla
   *  sfera l'identità della voce scelta in modo persistente.
   *  Default: false (mantiene il comportamento del main flow). */
  forceVoiceIdentity?: boolean;
};

// === Tone → aurora palette ([bright, mid, deep])
// Tutta la palette identitaria di L'Amico Fraterno: viola / blu petrolio /
// verde petrolio / ciclamino / magenta. Niente colori primari "stock".
//
// === NEUTRAL IDLE (2026-05-22) ===
// Prima neutral era rosa shocking (#FF1493) — INDISTINGUIBILE dal ciclamino
// dello stato "thinking". L'utente passava ore credendo che l'app fosse
// bloccata in thinking, ma era SOLO il colore di base. Cambiato a verde
// menta soft per coerenza con NeonBorder.idle e per dare un chiaro segnale
// visivo di "pronta, in attesa".
const TONE_PALETTES: Record<OrbTone, [string, string, string]> = {
  // Viola elettrico — Koda PARLA (matcha NeonBorder "speaking")
  warm: ["#E9D5FF", "#BD10E0", "#7E22CE"],
  // Blu notte — serenità, mare profondo, respiro lungo
  calm: ["#93C5FD", "#3B82F6", "#1E3A8A"],
  // Magenta acceso — vitalità, slancio, energia vibrante
  energetic: ["#E879F9", "#C026D3", "#9333EA"],
  // Viola denso — preoccupazione lieve, "ti vedo, sono qui con te"
  concerned: ["#A78BFA", "#7C3AED", "#5B21B6"],
  // Ciclamino acceso — urgenza dolce
  urgent: ["#F472B6", "#DB2777", "#9D174D"],
  // === NEUTRAL IDLE (2026-05-23 update) ===
  // Champagne caldo / sabbia dorata. Prima era #7DD3C0 (verde menta) ma
  // troppo simile al tiffany del recording → l'utente non distingueva
  // a colpo d'occhio se Koda stava in idle o stava ascoltando.
  // Champagne caldo ↔ tiffany freddo = contrasto caldo/freddo massimo,
  // impossibile confonderli a un metro di distanza.
  //   bright (rim)  #F5E6CC  crema pallida
  //   mid   (body)  #D4B896  ← STESSO HEX del NeonBorder "idle"
  //   deep  (base)  #8B6F4E  ambra scura per profondità sul disco nero
  neutral: ["#F5E6CC", "#D4B896", "#8B6F4E"],
  // Scarlatto neon — sigillo del Confessionale (matcha NeonBorder "confessional")
  confessional: ["#FCA5A5", "#FF1744", "#7F1D1D"],
};

// === Color for LISTENING/RECORDING state (utente parla — l'aurora si
// "raffredda" su tiffany acceso, in perfetta corrispondenza con il
// NeonBorder "recording" (#00F5D4). Prima il mid era #0E7C7B (petrolio
// scuro) e il bordo appariva di un colore molto diverso dall'orb. Ora:
//   bright (rim) = #5EEAD4 chiaro
//   mid   (body) = #00F5D4 ← STESSO HEX del NeonBorder recording
//   deep  (base) = #0E7C7B per dare profondità contro il disco nero.
const LISTEN_PALETTE: [string, string, string] = ["#5EEAD4", "#00F5D4", "#0E7C7B"];

// === Color for THINKING state (il pensiero che si formula)
// Ciclamino — l'idea che pulsa, vivo, vibrante
const THINK_PALETTE: [string, string, string] = ["#F9A8D4", "#EC4899", "#BE185D"];

export default function EclipseOrb({
  status,
  tone,
  size = 280,
  meterDb,
  meterThreshold,
  speakingPaletteOverride,
  forceVoiceIdentity = false,
}: Props) {
  // === FIX 2026-06-29 v37 — Eclissi nel tema giorno (negativo fotografico) ===
  // Nel tema chiaro il "disco nero" perde senso (sarebbe un buco scuro
  // dentro un ambiente luminoso). Invertiamo: disco perlato/avorio.
  // L'alone/halo manteniamo gli STESSI colori della palette (signature
  // emotiva), ma con opacità ridotte (Strada 1: "ombra colorata"
  // pittorica, soft, niente neon esplosivi su chiaro).
  const { theme } = useTheme();
  const isLight = !theme.isDark;
  // Multiplier applicato a tutte le opacities dei layer luminosi quando
  // siamo nel tema chiaro. <1 = più desaturato/sottile.
  const haloOpacityScale = isLight ? 0.55 : 1.0;
  // === Palette resolution: tone-driven when speaking, blu petrolio when
  // listening, ciclamino while thinking, viola when idle.
  const palette: [string, string, string] = useMemo(() => {
    if (status === "recording") return LISTEN_PALETTE;
    if (status === "thinking" || status === "transcribing") return THINK_PALETTE;
    // === SPEAKING: override per voce (Acqua=viola, Vento=cobalto) ===
    // Se è passata una palette custom legata alla voce, ha la priorità
    // sul tone-driven default (warm/concerned/etc).
    if (status === "speaking" && speakingPaletteOverride) {
      return speakingPaletteOverride;
    }
    // === FORCE VOICE IDENTITY (KodaIntro 2026-06) ===
    // Quando il chiamante chiede esplicitamente di "indossare" l'identità
    // della voce anche fuori dallo speaking (es. in idle durante l'intro),
    // applichiamo la palette voce anche qui. Non incluso recording/thinking
    // sopra: quelli restano sempre fissi per riconoscibilità stato.
    if (forceVoiceIdentity && speakingPaletteOverride) {
      return speakingPaletteOverride;
    }
    if (tone && TONE_PALETTES[tone]) return TONE_PALETTES[tone];
    return TONE_PALETTES.neutral;
  }, [status, tone, speakingPaletteOverride, forceVoiceIdentity]);

  // === Animated values — all useNativeDriver for 60fps
  // Aurora intensity (overall halo brightness): 0..1
  const auroraIntensity = useRef(new Animated.Value(0.35)).current;
  // Filament radial extension: 0 = retracted into disc, 1 = fully extended
  const filamentExtend = useRef(new Animated.Value(0.55)).current;
  // Slow continuous rotation of filament cluster (drives "dancing" feel)
  const rotation = useRef(new Animated.Value(0)).current;
  // Breath cycle (0..1..0) — always running, drives subtle scale
  const breath = useRef(new Animated.Value(0)).current;
  // Thinking flicker
  const flicker = useRef(new Animated.Value(1)).current;
  // Speech pulse — fast-ish pulse during speaking to feel "voice-alive"
  const speakPulse = useRef(new Animated.Value(0)).current;
  // Recording inward "absorption" pulse
  const listenPulse = useRef(new Animated.Value(0)).current;

  // === Continuous breath cycle (always running, regardless of status)
  useEffect(() => {
    // === TEST DIAGNOSTICO v63.9 ===
    // Se disabilitato per test (Android only, per verificare bagliore
    // schermo Honor/Huawei), non avviare il loop e lascia breath a 0.
    // iOS: sempre attivo. Rimuovere questa gate dopo il test.
    if (KODA_BREATH_DIAGNOSTIC_DISABLE_ANDROID) {
      console.log(
        "[EclipseOrb] BREATH DISABLED (test diagnostico v63.9 — verifica flash Honor/Huawei)"
      );
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 3800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 3800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

  // === Continuous slow rotation (always running, very slow — 80s per full turn)
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 80000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [rotation]);

  // === State-driven animations
  useEffect(() => {
    // Stop any inflight state animations cleanly
    auroraIntensity.stopAnimation();
    filamentExtend.stopAnimation();
    flicker.stopAnimation();
    speakPulse.stopAnimation();
    listenPulse.stopAnimation();

    if (status === "speaking") {
      // Aurora ESPLODE: alta intensità, filamenti estesi, pulse rapido
      Animated.parallel([
        Animated.timing(auroraIntensity, {
          toValue: 0.85,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(filamentExtend, {
          toValue: 0.85,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();

      // === PULSAZIONE ORGANICA DEL PARLATO ===
      // Simula la cadenza sillabica italiana con burst irregolari.
      //
      // DELAY iniziale: lo status "speaking" si attiva PRIMA che l'audio TTS
      // arrivi davvero (latenza prepare ~400-600ms su iOS Ad-Hoc). Per
      // sincronizzare visivamente eclissi e voce, partiamo dopo ~450ms.
      const SPEAK_PULSE_DELAY_MS = 450;
      let cancelled = false;
      let syllableCount = 0;
      let phraseCount = 0;
      const step = () => {
        if (cancelled) return;
        const rand = Math.random();
        let intensity: number;
        let duration: number;
        if (phraseCount >= 2 && rand < 0.18) {
          intensity = 1.0;
          duration = 550 + Math.random() * 250;
          phraseCount = 0;
        } else if (syllableCount >= 6 && rand < 0.30) {
          intensity = 0.25;
          duration = 380 + Math.random() * 320;
          syllableCount = 0;
          phraseCount++;
        } else {
          // SILLABA — burst breve con ampiezza variabile
          intensity = 0.55 + Math.random() * 0.45; // 0.55..1.0
          duration = 110 + Math.random() * 130;   // 110..240ms
          syllableCount++;
        }
        Animated.timing(speakPulse, {
          toValue: intensity,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished && !cancelled) step();
        });
      };
      // Avvia la sequenza dopo SPEAK_PULSE_DELAY_MS per allinearla all'audio
      // reale che ha latenza ~400-600ms su iOS Ad-Hoc (TTS prepare).
      const startTimer = setTimeout(() => {
        if (!cancelled) step();
      }, SPEAK_PULSE_DELAY_MS);
      return () => {
        cancelled = true;
        clearTimeout(startTimer);
        speakPulse.stopAnimation();
        Animated.timing(speakPulse, {
          toValue: 0,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      };
    }

    if (status === "recording") {
      // RITIRO: la luce si raccoglie, i filamenti si contraggono verso
      // l'interno. Effetto = "sto assorbendo le tue parole".
      Animated.parallel([
        Animated.timing(auroraIntensity, {
          toValue: 0.45,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(filamentExtend, {
          toValue: 0.25,
          duration: 800,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
      // Listen pulse: respiro lento "in entrata" (assorbimento), 1.5s ciclo
      const inhaleLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(listenPulse, {
            toValue: 1,
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(listenPulse, {
            toValue: 0,
            duration: 1500,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      inhaleLoop.start();
      return () => inhaleLoop.stop();
    }

    if (status === "thinking" || status === "transcribing") {
      // FLICKER: brevi variazioni di intensità — "battito di palpebre",
      // il pensiero che si formula (vale anche per la trascrizione).
      Animated.parallel([
        Animated.timing(auroraIntensity, {
          toValue: 0.7,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(filamentExtend, {
          toValue: 0.65,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
      // Sequenza di flicker irregolare
      const seq: Animated.CompositeAnimation[] = [];
      for (let i = 0; i < 30; i++) {
        const dim = 0.55 + Math.random() * 0.45;
        const dur = 180 + Math.random() * 220;
        seq.push(
          Animated.timing(flicker, {
            toValue: dim,
            duration: dur,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          })
        );
      }
      const flickerLoop = Animated.loop(Animated.sequence(seq));
      flickerLoop.start();
      return () => flickerLoop.stop();
    }

    // IDLE: respiro lento, aurora discreta
    // === FIX UTENTE GIUGNO 2026: alza idle aurora intensity ===
    // Prima 0.35 → l'orb in attesa risultava troppo "spento", l'utente
    // lo percepiva come un bug ("oscuramento"). Portato a 0.70 così
    // resta chiaramente presente anche in idle, pur restando più calmo
    // delle fasi attive (speaking 0.85, recording 0.45).
    Animated.parallel([
      Animated.timing(auroraIntensity, {
        toValue: 0.70,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(filamentExtend, {
        toValue: 0.55,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(flicker, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();
  }, [status, auroraIntensity, filamentExtend, flicker, speakPulse, listenPulse]);

  // === Geometry constants
  const center = size / 2;
  const discRadius = size * 0.30;   // disco nero centrale
  const haloRadius = size * 0.50;   // halo globale
  const filamentSize = size * 0.95; // ogni filamento è una "macchia di luce"

  // Pre-calc filament positions (4 filaments at 0/90/180/270° baseline,
  // each rotates around the centre).
  const FILAMENT_COUNT = 4;
  const filamentAngles = useMemo(
    () => Array.from({ length: FILAMENT_COUNT }, (_, i) => (i / FILAMENT_COUNT) * 360),
    []
  );

  // === Derived animated transforms
  // Global breath — scale 1.00..1.025 (subtle, always on)
  const breathScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.025],
  });
  // Speaking pulse — ALLARGAMENTO/RESTRINGIMENTO visibile dell'eclissi
  // intera in sync con il ritmo sillabico procedurale. Scale 1.0..1.10
  // (10% di variazione → ben visibile, non grottesco).
  const speakScale = speakPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.94, 1.10],
  });
  // Aurora intensity boost durante le sillabe — l'aurora "splende" sui colpi
  const speakOpacityBoost = speakPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.35],
  });
  // Filamenti che si estendono sulle sillabe forti (aurora "uscente" dalle sillabe)
  const speakFilamentBoost = speakPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -size * 0.04],
  });
  // Listen pulse — gentle inward radial pull (translate filaments inward by ~6px)
  const listenInwardPx = listenPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -8],
  });
  // Rotation deg string
  const rotateDeg = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          transform: [{ scale: breathScale }, { scale: speakScale }],
        },
      ]}
      pointerEvents="none"
    >
      {/* === Layer 0: HALO BASE (radial gradient grande, dietro tutto) */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: Animated.multiply(auroraIntensity, flicker) },
        ]}
      >
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={palette[0]} stopOpacity={0.0} />
              <Stop offset="35%" stopColor={palette[1]} stopOpacity={0.18 * haloOpacityScale} />
              <Stop offset="55%" stopColor={palette[1]} stopOpacity={0.32 * haloOpacityScale} />
              <Stop offset="75%" stopColor={palette[2]} stopOpacity={0.18 * haloOpacityScale} />
              <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={center} cy={center} r={haloRadius} fill="url(#halo)" />
        </Svg>
      </Animated.View>

      {/* === Layer 1: FILAMENTI (4 macchie di luce che orbitano) ===
          Ciascuno è un radial gradient off-center, che la maggior parte
          del tempo è coperto dal disco nero. Solo la parte "esterna"
          rispetto al disco si vede → effetto "aurora dietro l'eclissi".
          Ruotano insieme su tutta la cluster (Animated rotate).
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [{ rotate: rotateDeg }],
            opacity: Animated.add(
              Animated.multiply(auroraIntensity, flicker),
              speakOpacityBoost
            ),
          },
        ]}
      >
        {filamentAngles.map((baseDeg, i) => (
          <Animated.View
            key={i}
            style={[
              styles.filamentLayer,
              {
                width: filamentSize,
                height: filamentSize,
                left: (size - filamentSize) / 2,
                top: (size - filamentSize) / 2,
                // Filament is rotated to its base position
                transform: [
                  { rotate: `${baseDeg}deg` },
                  // translateY = radial extension (negative = outward from centre)
                  // PARLATO: ogni sillaba spinge i filamenti fuori (speakFilamentBoost),
                  // poi rientrano. ASCOLTO: ritiro graduale verso il centro.
                  {
                    translateY: Animated.add(
                      Animated.add(
                        Animated.multiply(
                          filamentExtend,
                          new Animated.Value(-size * 0.08)
                        ),
                        listenInwardPx
                      ),
                      speakFilamentBoost
                    ),
                  },
                ],
              },
            ]}
          >
            <Svg width="100%" height="100%" viewBox="0 0 100 100">
              <Defs>
                <RadialGradient
                  id={`filament-${i}`}
                  cx="50%"
                  cy="35%"
                  r="35%"
                >
                  <Stop offset="0%" stopColor={palette[0]} stopOpacity={0.85} />
                  <Stop offset="40%" stopColor={palette[1]} stopOpacity={0.45} />
                  <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx="50" cy="50" r="50" fill={`url(#filament-${i})`} />
            </Svg>
          </Animated.View>
        ))}
      </Animated.View>

      {/* === Layer 2: RIM LIGHT (sottile anello di luce sul bordo del disco) ===
          Si vede SOPRA i filamenti ma SOTTO il disco nero. Serve per dare
          un "bordo luminoso" netto al disco, come se la luce filtrasse dai
          bordi dell'eclissi.
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: Animated.multiply(auroraIntensity, flicker) },
        ]}
      >
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <RadialGradient id="rim" cx="50%" cy="50%" r="50%">
              <Stop offset={`${(discRadius / haloRadius) * 100 * 0.97}%`} stopColor={palette[0]} stopOpacity={0} />
              <Stop offset={`${(discRadius / haloRadius) * 100 * 1.01}%`} stopColor={palette[0]} stopOpacity={0.95 * haloOpacityScale} />
              <Stop offset={`${(discRadius / haloRadius) * 100 * 1.08}%`} stopColor={palette[1]} stopOpacity={0.55 * haloOpacityScale} />
              <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={center} cy={center} r={haloRadius} fill="url(#rim)" />
        </Svg>
      </Animated.View>

      {/* === Layer 3: DISCO CENTRALE ===
          Notte: cerchio nero (scatola nera emotiva, custode dei segreti).
          Giorno (negativo fotografico): cerchio perlato/avorio — la luce
          si concentra al centro invece che intorno. Mantiene la stessa
          metafora di "punto fermo che custodisce", in polarità opposta.
      */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            {isLight ? (
              <RadialGradient id="disc" cx="42%" cy="38%" r="55%">
                <Stop offset="0%" stopColor="#FBF8EE" stopOpacity={1} />
                <Stop offset="60%" stopColor="#F0EADC" stopOpacity={1} />
                <Stop offset="100%" stopColor="#E5DECB" stopOpacity={1} />
              </RadialGradient>
            ) : (
              <RadialGradient id="disc" cx="42%" cy="38%" r="55%">
                <Stop offset="0%" stopColor="#0F0F1A" stopOpacity={1} />
                <Stop offset="60%" stopColor="#050507" stopOpacity={1} />
                <Stop offset="100%" stopColor="#000000" stopOpacity={1} />
              </RadialGradient>
            )}
          </Defs>
          <Circle cx={center} cy={center} r={discRadius} fill="url(#disc)" />
        </Svg>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  filamentLayer: {
    position: "absolute",
  },
});
