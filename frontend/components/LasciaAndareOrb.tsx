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
import { Animated, Easing, View, StyleSheet, Dimensions, Text } from "react-native";
import EclipseOrb from "./EclipseOrb";
import { ECLIPSE_MAX_DIAMETER, ECLIPSE_MIN_DIAMETER } from "../lib/eclipseConstants";

const { width: SCREEN_W } = Dimensions.get("window");

// === COSTANTI DI DESIGN (v67.2 — mockup Fabio 2026-06-24) ==================
// Il mockup mostra un'eclissi che parte PICCOLA (~15-20% viewport height)
// e cresce fino al MASSIMO che è "circa il doppio del size iniziale".
// Interpretiamo: base rendering SVG a piena dimensione, ma il transform
// scale parte a INITIAL_SCALE (0.6) e cresce fino a MAX_SCALE (1.2).
// Rapporto max/initial = 2.0 → "circa il doppio del size iniziale" ✓
const DEFAULT_BASE_SIZE = ECLIPSE_MAX_DIAMETER;
// Scala iniziale del componente (matcha "1. INIZIO" del mockup: piccolo,
// glow minimo). Il pulse e la growth si moltiplicano SU questo valore
// tramite la growth ratchet (che parte da 1.0 = INITIAL_SCALE e sale).
const DEFAULT_INITIAL_SCALE = 0.6;
// Rapporto crescita max / iniziale. 2.0 = "circa il doppio del size iniziale".
const DEFAULT_MAX_GROWTH_RATIO = 2.0;
// MAX_SCALE del ratchet = INITIAL_SCALE * MAX_GROWTH_RATIO (relativo alla
// scala corrente in ratchet, che parte a 1.0 e sale). Con INITIAL=0.6 e
// MAX_RATIO=2.0, il ratchet arriva a scale=2.0 → visivamente 0.6×2.0=1.2 del base.
const DEFAULT_MAX_SCALE = DEFAULT_MAX_GROWTH_RATIO;
// Rate di crescita (scale-units al secondo di voce sopra soglia):
// v67.1 (2026-06-24): bumped 0.05 → 0.15. Il valore precedente rendeva
// gli incrementi impercettibili nei primi 3-5s di parlato; 0.15/s significa
// che in ~3s di voce sostenuta l'orb raggiunge scale 1.45 (visibilmente
// più grande), e in ~5s satura al cap. Coerente con "piano piano diventa
// sempre più grande" ma percettibile subito.
const DEFAULT_GROWTH_PER_SECOND = 0.15;
// Soglia sopra cui il dB conta come "parlato reale" (ignora rumore ambientale).
// v67.1 (2026-06-24): bumped da -35 a -42. iOS con `unprocessed` audioSource
// spesso restituisce valori conservativi anche durante il parlato normale
// (voce a distanza normale dal mic → -38..-32 dB). Soglia a -42 include
// anche voce sussurrata / a distanza, escludendo comunque il silenzio
// ambientale tipico (< -50 dB) e il fruscio del mic (< -55 dB).
const DEFAULT_SPEECH_THRESHOLD_DB = -42;
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
// v67.1 (2026-06-24): durata bumpata 800→1200ms + easing cambiato da
// bezier(0.7,0,0.3,1) (s-curve) a Easing.in(Easing.expo) (slow start,
// esplosiva accelerazione a fine). L'effetto "buco nero" ha bisogno di
// un collasso ACCELERATO — non simmetrico. Con expo-in, i primi 800ms
// l'orb rimpicciolisce lentamente, poi negli ultimi 400ms crolla di
// colpo verso il centro → percezione di "gravità che vince".
const IMPLODE_DURATION_MS = 1200;
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
  /** Se true, mostra un HUD di debug con meterDb + growth + imploding.
   *  Usato solo nelle build diagnostiche per verificare che il componente
   *  riceva davvero il metering e la crescita si accumuli. */
  debug?: boolean;
  /** Scala iniziale del rendering (moltiplicatore, default 0.6 = piccola).
   *  Il pulse + growth ratchet si applicano SU questa base. */
  initialScale?: number;
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
  debug = false,
  initialScale = DEFAULT_INITIAL_SCALE,
}: LasciaAndareOrbProps) {
  // === ANIMATED VALUES ======================================================
  // pulse: oscillazione frequenza (reattiva al dB istantaneo)
  // glow:  opacity (0.65 → 1.00 reattiva al dB istantaneo)
  // growth: scale cumulativo (ratchet 1.00 → maxScale, tempo di parlato)
  // implode: fattore [1..0] moltiplicativo, animato solo a chiusura
  // supernovaFlash: [0..1..0] flash luminoso centrale durante l'implosione
  const pulseAnim = useRef(new Animated.Value(PULSE_MIN)).current;
  const glowAnim = useRef(new Animated.Value(GLOW_MIN)).current;
  const growthAnim = useRef(new Animated.Value(1.0)).current;
  const implodeAnim = useRef(new Animated.Value(1.0)).current;
  const implodeOpacityAnim = useRef(new Animated.Value(1.0)).current;
  const supernovaFlashAnim = useRef(new Animated.Value(0)).current;
  const supernovaRayAnim = useRef(new Animated.Value(0)).current;

  // Accumulatore ratchet (state per re-render EclipseOrb dbBoost).
  // Il valore numerico corrente è tenuto in ref per evitare stale closures
  // dentro il setInterval.
  const growthValueRef = useRef<number>(1.0);
  const [growthState, setGrowthState] = useState<number>(1.0);
  // Freeze: se in implosione, il ratchet si ferma.
  const frozenRef = useRef<boolean>(false);
  // Ref sempre aggiornata con l'ultimo meterDb (letta dentro setInterval per
  // evitare stale closures). Dichiarata QUI, prima del useEffect che la usa.
  const meterDbLatestRef = useRef<number>(meterDb);
  // === HUD DIAGNOSTIC STATE (v67.2) ==========================================
  // Contatori per diagnosticare dove si rompe la reattività:
  // - meterUpdateCount: quante volte il prop `meterDb` è cambiato dal mount
  // - ratchetTickCount: quante volte il timer del ratchet è partito
  // - ratchetSpeechCount: quante volte il ratchet ha visto db > threshold
  const [meterUpdateCount, setMeterUpdateCount] = useState<number>(0);
  const [ratchetTickCount, setRatchetTickCount] = useState<number>(0);
  const [ratchetSpeechCount, setRatchetSpeechCount] = useState<number>(0);
  useEffect(() => {
    meterDbLatestRef.current = meterDb;
    if (debug) setMeterUpdateCount((n) => n + 1);
  }, [meterDb, debug]);

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
      useNativeDriver: false,
    }).start();

    Animated.timing(glowAnim, {
      toValue: targetGlow,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [meterDb, speechThresholdDb, pulseAnim, glowAnim]);

  // === 2. RATCHET DI CRESCITA — tempo cumulativo sopra soglia ===============
  // Tick ogni 100ms: se meterDb > threshold, aggiungi growthPerSecond * 0.1.
  // Cap a maxScale. Non decresce mai. Freeze durante implosione.
  useEffect(() => {
    if (frozenRef.current) return;

    const timer = setInterval(() => {
      if (debug) setRatchetTickCount((n) => n + 1);
      if (frozenRef.current) return;
      if (meterDbLatestRef.current <= speechThresholdDb) return;
      if (debug) setRatchetSpeechCount((n) => n + 1);

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
          useNativeDriver: false,
        }).start();
      }
    }, RATCHET_TICK_MS);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechThresholdDb, growthPerSecond, maxScale, growthAnim, debug]);

  // === 3. IMPLOSIONE "SUPERNOVA" (v67.2, mockup Fabio 2026-06-24) ===========
  // Il mockup mostra un implosione a più fasi:
  //   6→7: tap sulla X → glow inizia a ritirarsi verso il centro
  //   8:   la compressione emette RAGGI luminosi (supernova collapse)
  //   9:   collassa in un PUNTO luminoso centrale (bright flash)
  //   10:  il punto si dissolve, ritorno al nero
  // Implementazione:
  //   - implodeAnim: scale 1→0 (shrink dell'orb principale, 0..1200ms)
  //   - implodeOpacityAnim: opacity 1→0 dell'orb (0..1200ms)
  //   - supernovaFlashAnim: 0→1→0 (peak a metà, poi fade)
  //   - supernovaRayAnim: 0→1 (raggi che si espandono in outward burst)
  useEffect(() => {
    if (!imploding) return;
    if (frozenRef.current) return;
    frozenRef.current = true;

    // Ferma pulse/glow al valore corrente (non contendere l'animazione).
    pulseAnim.stopAnimation();
    glowAnim.stopAnimation();
    growthAnim.stopAnimation();

    Animated.parallel([
      // Shrink orb (con collasso esplosivo verso il centro)
      Animated.timing(implodeAnim, {
        toValue: 0,
        duration: IMPLODE_DURATION_MS,
        easing: Easing.in(Easing.exp),
        useNativeDriver: false,
      }),
      // Fade orb
      Animated.timing(implodeOpacityAnim, {
        toValue: 0,
        duration: IMPLODE_DURATION_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: false,
      }),
      // Supernova: raggi che si espandono in outward burst (0→1 in 800ms)
      Animated.timing(supernovaRayAnim, {
        toValue: 1,
        duration: IMPLODE_DURATION_MS * 0.7,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      // Supernova: flash luminoso centrale (0→1 nella prima metà, 1→0 nella seconda)
      Animated.sequence([
        Animated.timing(supernovaFlashAnim, {
          toValue: 1,
          duration: IMPLODE_DURATION_MS * 0.55,
          easing: Easing.in(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(supernovaFlashAnim, {
          toValue: 0,
          duration: IMPLODE_DURATION_MS * 0.45,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    ]).start(() => {
      onImplodeComplete?.();
    });
  }, [imploding, implodeAnim, implodeOpacityAnim, pulseAnim, glowAnim, growthAnim, supernovaFlashAnim, supernovaRayAnim, onImplodeComplete]);

  // === RENDER ===============================================================
  // Transform combinato: scale = growth * pulse * implode
  //                     opacity = glow * implodeOpacity
  // - growth  → crescita cumulativa (ratchet)
  // - pulse   → oscillazione frequenza in tempo reale con la voce
  // - implode → collasso a 0 su chiusura
  // - glow    → opacity modulata dalla voce
  // - implodeOpacity → fade a 0 su chiusura
  // v67.3: combinedScale rimosso (transform: scale ora è solo implodeAnim
  // sul wrapper. Aurora è modulata via `auroraScale` interno a EclipseOrb).
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

  // === RENDER ===============================================================
  // v67.3 (Fabio 2026-06-24) — NUCLEO FISSO, SOLO GLOW CRESCE:
  //   - EclipseOrb renderizzato a size FISSO ECLIPSE_MAX_DIAMETER=320.
  //   - Nucleo hardcoded a ECLIPSE_NUCLEUS_DIAMETER=200 (dentro EclipseOrb).
  //   - `auroraScale` prop applicata solo ai layer aurora/halo/filamenti:
  //       * growth=1.0 → auroraScale = MIN/MAX = 240/320 = 0.75 (aurora contratta)
  //       * growth=maxScale (2.0) → auroraScale = MAX/MAX = 1.0 (aurora massima)
  //   - pulseAnim modula il boost interno di EclipseOrb (dbBoost) → non
  //     più applicato come transform esterno.
  //   - Implosione: transform scale sul wrapper esterno (nucleo + aurora
  //     collassano insieme = buco nero, spec Fabio).
  const auroraGrowthScale = growthAnim.interpolate({
    inputRange: [1, maxScale],
    outputRange: [ECLIPSE_MIN_DIAMETER / ECLIPSE_MAX_DIAMETER, 1.0],
    extrapolate: "clamp",
  });
  // aurora finale = growth cumulativa × pulse voce istantanea
  const finalAuroraScale = Animated.multiply(auroraGrowthScale, pulseAnim);

  return (
    <View style={[styles.wrap, style]} pointerEvents="none">
      {/* Wrapper implosion: al collasso, TUTTO (nucleo+aurora) collassa.
          In stato normale scale=1, opacity dal glow reattivo. */}
      <Animated.View
        style={{
          opacity: combinedOpacity,
          transform: [{ scale: implodeAnim }],
        }}
      >
        <EclipseOrb
          status="recording"
          size={ECLIPSE_MAX_DIAMETER}
          meterDb={meterDb}
          meterThreshold={speechThresholdDb}
          dbBoost={dbBoost}
          auroraScale={finalAuroraScale}
        />
        {/* === SUPERNOVA RAYS (v67.2) =========================================
            Otto raggi luminosi che si irraggiano verso l'esterno durante
            l'implosione. */}
        {imploding && (
          <Animated.View
            style={{
              position: "absolute",
              top: ECLIPSE_MAX_DIAMETER / 2 - 2,
              left: ECLIPSE_MAX_DIAMETER / 2 - ECLIPSE_MAX_DIAMETER * 0.9,
              width: ECLIPSE_MAX_DIAMETER * 1.8,
              height: 4,
              opacity: supernovaRayAnim.interpolate({
                inputRange: [0, 0.3, 0.7, 1],
                outputRange: [0, 1, 1, 0],
              }),
              transform: [
                {
                  scaleX: supernovaRayAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.1, 1.4],
                  }),
                },
              ],
            }}
            pointerEvents="none"
          >
            {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map((deg) => (
              <View
                key={deg}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  transform: [{ rotate: `${deg}deg` }],
                }}
              >
                <View
                  style={{
                    width: "100%",
                    height: "100%",
                    backgroundColor: "#B9F5EC",
                    borderRadius: 2,
                    shadowColor: "#00F5D4",
                    shadowOpacity: 0.9,
                    shadowRadius: 10,
                    shadowOffset: { width: 0, height: 0 },
                  }}
                />
              </View>
            ))}
          </Animated.View>
        )}
        {/* === SUPERNOVA FLASH (v67.2) ========================================= */}
        {imploding && (
          <Animated.View
            style={{
              position: "absolute",
              top: ECLIPSE_MAX_DIAMETER / 2 - 12,
              left: ECLIPSE_MAX_DIAMETER / 2 - 12,
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: "#FFFFFF",
              opacity: supernovaFlashAnim,
              transform: [
                {
                  scale: supernovaFlashAnim.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: [0.3, 1.4, 2.0],
                  }),
                },
              ],
              shadowColor: "#B9F5EC",
              shadowOpacity: 1,
              shadowRadius: 30,
              shadowOffset: { width: 0, height: 0 },
            }}
            pointerEvents="none"
          />
        )}
      </Animated.View>
      {/* === HUD DIAGNOSTICO (debug=true, temporaneo) ========================== */}
      {debug && (
        <View
          style={{
            position: "absolute",
            bottom: -120,
            left: -150,
            right: -150,
            alignItems: "center",
            paddingVertical: 8,
            paddingHorizontal: 10,
            backgroundColor: "rgba(0,0,0,0.85)",
            borderRadius: 8,
          }}
          pointerEvents="none"
        >
          <Text style={{ color: "#00F5D4", fontSize: 11, fontFamily: "monospace" }}>
            {`meterDb=${meterDb.toFixed(1)} thr=${speechThresholdDb} active=${meterDb > speechThresholdDb ? "Y" : "N"}`}
          </Text>
          <Text style={{ color: "#F5E6CC", fontSize: 11, fontFamily: "monospace" }}>
            {`growth=${growthState.toFixed(3)} max=${maxScale.toFixed(2)} imploding=${imploding ? "Y" : "N"}`}
          </Text>
          <Text style={{ color: "#FFB86C", fontSize: 10, fontFamily: "monospace" }}>
            {`upd=${meterUpdateCount} tick=${ratchetTickCount} speech=${ratchetSpeechCount}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
});
