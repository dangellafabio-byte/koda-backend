/**
 * components/LasciaAndareOrb.tsx — v67 (Fabio 2026-06-19)
 * -----------------------------------------------------------------------------
 * Componente VISUALE condiviso per Lascia Andare, usato sia in:
 *   - /app/lascia-andare.tsx  (produzione, "Stanza dello Sfogo")
 *   - /components/OnboardingV4.tsx step5_demo_la  (intro demo)
 *
 * SPEC (Fabio 2026-06-19, in questa sessione):
 *   1. Frequenza: il glow pulsa in tempo reale reagendo all'intensità della
 *      voce, esattamente come lo stato Speaking di Ollenya. Reattività
 *      continua sul dB corrente (attack 180ms / release 500ms).
 *   2. Grandezza: cresce CUMULATIVAMENTE in base al tempo totale in cui
 *      il volume della voce supera SPEECH_THRESHOLD_DB (ratchet, mai
 *      retrocede). "Piano piano diventa sempre più grande fino a metà
 *      schermo" — cap = MAX_SCALE.
 *   3. Reset ad ogni apertura: lo stato di crescita non persiste tra
 *      sessioni (il componente si smonta/rimonta, l'accumulatore è locale
 *      allo useRef/useState). Nessuna persistenza SecureStore/AsyncStorage.
 *   4. Uscita: quando `imploding=true` → animazione buco nero (scale→0,
 *      opacity→0 in 800ms con easing accelerato). onImplodeComplete
 *      firea a fine animazione così il caller può fare navigation/teardown.
 *
 * Il componente NON gestisce l'audio recorder: riceve `meterDb` come prop
 * dal caller (che ha il suo pipeline expo-audio + permessi + cleanup file).
 * Questo mantiene i callers indipendenti sulle policy audio (frasi di
 * apertura/chiusura in produzione, sequenza intro in OnboardingV4).
 */

import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, View, StyleSheet, Dimensions } from "react-native";
import EclipseOrb from "./EclipseOrb";

const { width: SCREEN_W } = Dimensions.get("window");

// === COSTANTI DI DESIGN =====================================================
// baseSize allineata al valore usato in produzione (`lascia-andare.tsx`) e in
// OnboardingV4 → nessuna discrepanza percettiva tra i due contesti.
const DEFAULT_BASE_SIZE = Math.min(SCREEN_W * 0.62, 240);
// Cap di crescita: metà schermo (spec Fabio). Il computo è sul cerchio
// "core" dell'eclissi; l'aurora esterna aggiunge un extra ~30% quindi a
// scale=MAX_SCALE la presenza visiva copre effettivamente > 50% viewport.
const DEFAULT_MAX_SCALE = Math.max(
  1.2, // safety floor: qualcosa DEVE crescere anche su tablet
  Math.min(1.8, (SCREEN_W * 0.5) / DEFAULT_BASE_SIZE + 1.0)
);
// Rate di crescita (scale-units al secondo di voce sopra soglia):
// (maxScale - 1) / rate = tempo per saturare. Con rate=0.05 e maxScale=1.5
// servono ~10s di parlato continuo per raggiungere il cap. Coerente con
// "piano piano diventa sempre più grande" (Fabio).
const DEFAULT_GROWTH_PER_SECOND = 0.05;
// Soglia sopra cui il dB conta come "parlato reale" (ignora rumore ambientale).
// Allineata a SPEECH_DB di /lascia-andare.tsx.
const DEFAULT_SPEECH_THRESHOLD_DB = -35;
// Range dB usato per la mappatura pulse/glow.
const DB_CLAMP_MIN = -60;
const DB_CLAMP_MAX = -20;
// Pulse (frequenza reattiva): [1.00, 1.05] — piccola oscillazione visibile,
// come lo stato Speaking dell'eclissi. Non deve competere con la crescita.
const PULSE_MIN = 1.0;
const PULSE_MAX = 1.05;
// Glow (opacity reattiva): [0.65, 1.00] — coerente con produzione attuale.
const GLOW_MIN = 0.65;
const GLOW_MAX = 1.0;
// Curve temporali della pulsazione (attack veloce, release naturale).
const ATTACK_MS = 180;
const RELEASE_MS = 500;
// Implosione buco nero.
const IMPLODE_DURATION_MS = 800;
// Tick del ratchet di crescita. 100ms = 10 tick/sec, allineato al polling
// tipico expo-audio metering.
const RATCHET_TICK_MS = 100;

export interface LasciaAndareOrbProps {
  /** Valore corrente del metering in dB fornito dal caller (recorder expo-audio). */
  meterDb: number;
  /** Quando true, avvia l'animazione di implosione "buco nero". */
  imploding?: boolean;
  /** Callback firato a fine implosione (usa per navigation/teardown). */
  onImplodeComplete?: () => void;
  /** Dimensione base dell'orb (default: min(width*0.62, 240)). */
  baseSize?: number;
  /** Cap massimo della crescita cumulativa (default: metà schermo). */
  maxScale?: number;
  /** Scale-units cresciute per secondo di voce sopra soglia (default 0.05). */
  growthPerSecond?: number;
  /** dB sopra cui il tempo conta come "parlato reale" (default -35). */
  speechThresholdDb?: number;
  /** Wrapping style opzionale per posizionamento esterno. */
  style?: any;
}

export default function LasciaAndareOrb({
  meterDb,
  imploding = false,
  onImplodeComplete,
  baseSize = DEFAULT_BASE_SIZE,
  maxScale = DEFAULT_MAX_SCALE,
  growthPerSecond = DEFAULT_GROWTH_PER_SECOND,
  speechThresholdDb = DEFAULT_SPEECH_THRESHOLD_DB,
  style,
}: LasciaAndareOrbProps) {
  // === ANIMATED VALUES ======================================================
  // pulse: oscillazione frequenza (reattiva al dB istantaneo)
  // glow:  opacity (0.65 → 1.00 reattiva al dB istantaneo)
  // growth: scale cumulativo (ratchet 1.00 → maxScale, tempo di parlato)
  // implode: fattore [1..0] moltiplicativo, animato solo a chiusura
  const pulseAnim = useRef(new Animated.Value(PULSE_MIN)).current;
  const glowAnim = useRef(new Animated.Value(GLOW_MIN)).current;
  const growthAnim = useRef(new Animated.Value(1.0)).current;
  const implodeAnim = useRef(new Animated.Value(1.0)).current;
  const implodeOpacityAnim = useRef(new Animated.Value(1.0)).current;

  // Accumulatore ratchet (state per re-render EclipseOrb dbBoost).
  // Il valore numerico corrente è tenuto in ref per evitare stale closures
  // dentro il setInterval.
  const growthValueRef = useRef<number>(1.0);
  const [, setGrowthState] = useState<number>(1.0);
  // Freeze: se in implosione, il ratchet si ferma.
  const frozenRef = useRef<boolean>(false);
  // Ref sempre aggiornata con l'ultimo meterDb (letta dentro setInterval per
  // evitare stale closures). Dichiarata QUI, prima del useEffect che la usa.
  const meterDbLatestRef = useRef<number>(meterDb);
  useEffect(() => {
    meterDbLatestRef.current = meterDb;
  }, [meterDb]);

  // === 1. PULSE + GLOW — reattivi al dB istantaneo ==========================
  // Mappa dB → target pulse/glow con isteresi temporale (attack/release).
  useEffect(() => {
    if (frozenRef.current) return; // durante l'implosione non modulo più

    const clamped = Math.max(DB_CLAMP_MIN, Math.min(DB_CLAMP_MAX, meterDb));
    const norm = (clamped - DB_CLAMP_MIN) / (DB_CLAMP_MAX - DB_CLAMP_MIN); // [0,1]

    const targetPulse = PULSE_MIN + norm * (PULSE_MAX - PULSE_MIN);
    const targetGlow = GLOW_MIN + norm * (GLOW_MAX - GLOW_MIN);

    // Attack veloce se c'è segnale, release naturale se silenzio.
    const duration = meterDb < speechThresholdDb ? RELEASE_MS : ATTACK_MS;

    Animated.timing(pulseAnim, {
      toValue: targetPulse,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    Animated.timing(glowAnim, {
      toValue: targetGlow,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [meterDb, speechThresholdDb, pulseAnim, glowAnim]);

  // === 2. RATCHET DI CRESCITA — tempo cumulativo sopra soglia ===============
  // Tick ogni 100ms: se meterDb > threshold, aggiungi growthPerSecond * 0.1.
  // Cap a maxScale. Non decresce mai. Freeze durante implosione.
  useEffect(() => {
    if (frozenRef.current) return;

    const timer = setInterval(() => {
      if (frozenRef.current) return;
      if (meterDbLatestRef.current <= speechThresholdDb) return;

      const delta = growthPerSecond * (RATCHET_TICK_MS / 1000);
      const next = Math.min(maxScale, growthValueRef.current + delta);
      if (next !== growthValueRef.current) {
        growthValueRef.current = next;
        setGrowthState(next);
        // Aggiorna anche l'Animated.Value con una piccola easing per
        // rendere la crescita fluida invece che a scatti.
        Animated.timing(growthAnim, {
          toValue: next,
          duration: RATCHET_TICK_MS + 20, // leggero overshoot temporale per smoothness
          easing: Easing.linear,
          useNativeDriver: true,
        }).start();
      }
    }, RATCHET_TICK_MS);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechThresholdDb, growthPerSecond, maxScale, growthAnim]);

  // === 3. IMPLOSIONE "BUCO NERO" ============================================
  useEffect(() => {
    if (!imploding) return;
    if (frozenRef.current) return;
    frozenRef.current = true;

    // Ferma pulse/glow al valore corrente (non contendere l'animazione).
    pulseAnim.stopAnimation();
    glowAnim.stopAnimation();
    growthAnim.stopAnimation();

    Animated.parallel([
      Animated.timing(implodeAnim, {
        toValue: 0,
        duration: IMPLODE_DURATION_MS,
        // Curva accelerata: prima metà lenta, seconda metà veloce → percezione
        // "collasso improvviso nel centro" tipico di un buco nero.
        easing: Easing.bezier(0.7, 0, 0.3, 1),
        useNativeDriver: true,
      }),
      Animated.timing(implodeOpacityAnim, {
        toValue: 0,
        duration: IMPLODE_DURATION_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      onImplodeComplete?.();
    });
  }, [imploding, implodeAnim, implodeOpacityAnim, pulseAnim, glowAnim, growthAnim, onImplodeComplete]);

  // === RENDER ===============================================================
  // Transform combinato: scale = growth * pulse * implode
  //                     opacity = glow * implodeOpacity
  // - growth  → crescita cumulativa (ratchet)
  // - pulse   → oscillazione frequenza in tempo reale con la voce
  // - implode → collasso a 0 su chiusura
  // - glow    → opacity modulata dalla voce
  // - implodeOpacity → fade a 0 su chiusura
  const combinedScale = Animated.multiply(
    Animated.multiply(growthAnim, pulseAnim),
    implodeAnim
  );
  const combinedOpacity = Animated.multiply(glowAnim, implodeOpacityAnim);

  // dbBoost per EclipseOrb (opacity dei layer interni aurora/rim). Uguale
  // alla formula di produzione: [-60,-20] → [0,1] per rendere il glow
  // percepibile sopra il baseline dell'eclissi. È indipendente dallo
  // ratchet della SCALA: qui è la modulazione ISTANTANEA della luminosità.
  const dbBoost = Math.max(
    0,
    Math.min(
      1,
      (Math.max(DB_CLAMP_MIN, Math.min(DB_CLAMP_MAX, meterDb)) - DB_CLAMP_MIN) /
        (DB_CLAMP_MAX - DB_CLAMP_MIN)
    )
  );

  return (
    <View style={[styles.wrap, style]} pointerEvents="none">
      <Animated.View
        style={{
          opacity: combinedOpacity,
          transform: [{ scale: combinedScale }],
        }}
      >
        <EclipseOrb
          status="recording"
          size={baseSize}
          meterDb={meterDb}
          meterThreshold={speechThresholdDb}
          dbBoost={dbBoost}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
});
