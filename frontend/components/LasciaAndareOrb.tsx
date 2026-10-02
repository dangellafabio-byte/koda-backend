/**
 * components/LasciaAndareOrb.tsx — v67.7 (Fabio 2026-06-24, documento unico)
 * -----------------------------------------------------------------------------
 * Componente VISUALE condiviso per Lascia Andare — produzione e intro.
 *
 * SPEC v67.7 (documento unico sezione 5-6):
 *   • Il GLOW NON si riduce MAI durante la stessa sessione.
 *       - Pulse (frequenza voce): monotono crescente (ratchet).
 *       - Glow (opacity): monotona crescente (ratchet).
 *       - Growth (dimensione): monotona crescente (ratchet, come già v67.3).
 *       Il silenzio ferma la crescita ma NON la riduce.
 *   • MAX_SCALE aumentato per rendere più evidente l'accumulo e più
 *     intensa l'implosione finale (unico valore condiviso, hardcoded).
 *   • Implosione: NO stella, NO raggi, NO flash. Solo collasso rapido
 *     verso il centro con easing accelerato. Più marcato e pulito.
 */

import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, View, StyleSheet, Dimensions, Text } from "react-native";
import EclipseOrb from "./EclipseOrb";
import { ECLIPSE_MAX_DIAMETER, ECLIPSE_MIN_DIAMETER } from "../lib/eclipseConstants";

const { width: SCREEN_W } = Dimensions.get("window");

const DEFAULT_BASE_SIZE = ECLIPSE_MAX_DIAMETER;
const DEFAULT_INITIAL_SCALE = 0.6;
// v67.7: maxScale aumentato 2.0 → 2.8 (sezione 5.2 doc unico).
// 0.6 initialScale × 2.8 ratchet = 1.68 scale finale.
// Sui display più stretti (iPhone SE 320px) l'orb copre ~84% viewport.
const DEFAULT_MAX_GROWTH_RATIO = 2.8;
const DEFAULT_MAX_SCALE = DEFAULT_MAX_GROWTH_RATIO;
const DEFAULT_GROWTH_PER_SECOND = 0.18;
const DEFAULT_SPEECH_THRESHOLD_DB = -42;
const DB_CLAMP_MIN = -60;
const DB_CLAMP_MAX = -20;
// v67.7: PULSE/GLOW ratchet. Non torna indietro sui silenzi.
const PULSE_MIN = 1.0;
const PULSE_MAX = 1.05;
const GLOW_MIN = 0.65;
const GLOW_MAX = 1.0;
const ATTACK_MS = 180;
// v67.7: implosione più marcata (sezione 6). Collasso rapido + pulito.
const IMPLODE_DURATION_MS = 900;

export interface LasciaAndareOrbProps {
  meterDb: number;
  imploding?: boolean;
  onImplodeComplete?: () => void;
  baseSize?: number;
  maxScale?: number;
  growthPerSecond?: number;
  speechThresholdDb?: number;
  style?: any;
  debug?: boolean;
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
  const pulseAnim = useRef(new Animated.Value(PULSE_MIN)).current;
  const glowAnim = useRef(new Animated.Value(GLOW_MIN)).current;
  const growthAnim = useRef(new Animated.Value(1.0)).current;
  const implodeAnim = useRef(new Animated.Value(1.0)).current;
  const implodeOpacityAnim = useRef(new Animated.Value(1.0)).current;

  // === RATCHET REFS (v67.7: pulse/glow/growth monotoni) =====================
  const pulseValueRef = useRef<number>(PULSE_MIN);
  const glowValueRef = useRef<number>(GLOW_MIN);
  const growthValueRef = useRef<number>(1.0);
  const [growthState, setGrowthState] = useState<number>(1.0);
  const frozenRef = useRef<boolean>(false);

  const meterDbLatestRef = useRef<number>(meterDb);
  const [meterUpdateCount, setMeterUpdateCount] = useState<number>(0);
  const [ratchetTickCount, setRatchetTickCount] = useState<number>(0);
  const [ratchetSpeechCount, setRatchetSpeechCount] = useState<number>(0);
  useEffect(() => {
    meterDbLatestRef.current = meterDb;
    if (debug) setMeterUpdateCount((n) => n + 1);
  }, [meterDb, debug]);

  // === 1. PULSE + GLOW — RATCHET MONOTONO (v67.7) ============================
  // Prima: pulse/glow seguivano la voce real-time, scendendo quando silenzio.
  // Adesso: pulse/glow salgono SOLO verso l'alto. Quando l'utente parla, si
  // alzano verso il target in base al dB. Quando tace, RESTANO al valore
  // raggiunto. Il silenzio ferma la crescita ma non la riduce.
  useEffect(() => {
    if (frozenRef.current) return;

    const clamped = Math.max(DB_CLAMP_MIN, Math.min(DB_CLAMP_MAX, meterDb));
    const norm = (clamped - DB_CLAMP_MIN) / (DB_CLAMP_MAX - DB_CLAMP_MIN);

    const targetPulse = PULSE_MIN + norm * (PULSE_MAX - PULSE_MIN);
    const targetGlow = GLOW_MIN + norm * (GLOW_MAX - GLOW_MIN);

    // RATCHET: anima SOLO se il nuovo target è MAGGIORE del valore corrente.
    if (targetPulse > pulseValueRef.current) {
      pulseValueRef.current = targetPulse;
      Animated.timing(pulseAnim, {
        toValue: targetPulse,
        duration: ATTACK_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    }
    if (targetGlow > glowValueRef.current) {
      glowValueRef.current = targetGlow;
      Animated.timing(glowAnim, {
        toValue: targetGlow,
        duration: ATTACK_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    }
  }, [meterDb, pulseAnim, glowAnim]);

  // === 2. RATCHET DI CRESCITA (invariato v67.3) ==============================
  useEffect(() => {
    if (frozenRef.current) return;

    const timer = setInterval(() => {
      if (debug) setRatchetTickCount((n) => n + 1);
      if (frozenRef.current) return;
      if (meterDbLatestRef.current <= speechThresholdDb) return;
      if (debug) setRatchetSpeechCount((n) => n + 1);

      const delta = growthPerSecond * 0.1;
      const next = Math.min(maxScale, growthValueRef.current + delta);
      if (next !== growthValueRef.current) {
        growthValueRef.current = next;
        setGrowthState(next);
        Animated.timing(growthAnim, {
          toValue: next,
          duration: 120,
          easing: Easing.linear,
          useNativeDriver: false,
        }).start();
      }
    }, 100);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechThresholdDb, growthPerSecond, maxScale, growthAnim, debug]);

  // === 3. IMPLOSIONE PULITA — NO STELLA, NO RAGGI, NO FLASH ================
  // v67.7 (sezione 6 doc unico): "Non devono comparire stelle, scintille a
  // forma di stella o elementi decorativi equivalenti."
  // Solo collasso rapido verso il centro con easing accelerato (expo).
  useEffect(() => {
    if (!imploding) return;
    if (frozenRef.current) return;
    frozenRef.current = true;

    pulseAnim.stopAnimation();
    glowAnim.stopAnimation();
    growthAnim.stopAnimation();

    Animated.parallel([
      Animated.timing(implodeAnim, {
        toValue: 0,
        duration: IMPLODE_DURATION_MS,
        easing: Easing.in(Easing.exp),
        useNativeDriver: false,
      }),
      Animated.timing(implodeOpacityAnim, {
        toValue: 0,
        duration: IMPLODE_DURATION_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start(() => {
      onImplodeComplete?.();
    });
  }, [imploding, implodeAnim, implodeOpacityAnim, pulseAnim, glowAnim, growthAnim, onImplodeComplete]);

  const combinedOpacity = Animated.multiply(glowAnim, implodeOpacityAnim);

  const auroraGrowthScale = growthAnim.interpolate({
    inputRange: [1, maxScale],
    outputRange: [ECLIPSE_MIN_DIAMETER / ECLIPSE_MAX_DIAMETER, 1.0],
    extrapolate: "clamp",
  });
  const finalAuroraScale = Animated.multiply(auroraGrowthScale, pulseAnim);

  const dbBoostStatic = glowValueRef.current; // ratchet, mai scende

  return (
    <View style={[styles.wrap, style]} pointerEvents="none">
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
          dbBoost={dbBoostStatic}
          auroraScale={finalAuroraScale}
        />
      </Animated.View>
      {debug && (
        <View style={styles.hud} pointerEvents="none">
          <Text style={styles.hudText}>
            {`meterDb=${meterDb.toFixed(1)} thr=${speechThresholdDb}`}
          </Text>
          <Text style={styles.hudText}>
            {`growth=${growthState.toFixed(3)} max=${maxScale.toFixed(2)}`}
          </Text>
          <Text style={styles.hudText}>
            {`upd=${meterUpdateCount} tick=${ratchetTickCount} speech=${ratchetSpeechCount}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  hud: {
    position: "absolute",
    bottom: -120,
    left: -150,
    right: -150,
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderRadius: 8,
  },
  hudText: { color: "#F5E6CC", fontSize: 10, fontFamily: "monospace" },
});
