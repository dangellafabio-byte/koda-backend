/**
 * MirrorPool — "Specchio d'acqua scuro e vivo" (richiesta utente 2026-06).
 *
 * Alternativa all'eclissi come avatar centrale di Koda.
 * Concept: pozza d'acqua scura e riflettente. A riposo respira appena.
 * Quando l'utente parla, la superficie si increspa. Quando Koda parla,
 * l'acqua si illumina dall'interno con la tinta del tone.
 *
 * Layer (dal basso all'alto):
 *   1. Pozza scura — gradient radiale dal nucleo profondo ai bordi morbidi
 *   2. Riflesso ambientale — tinta del tone, opacità bassissima, in respiro
 *   3. Increspature di superficie — onde sinusoidali sottili (sin/cos)
 *   4. Luminescenza interna — quando speaking/recording, brillio dal centro
 *   5. Onde concentriche interne — quando arriva voce, restano nella pozza
 *
 * Tutto SVG + Animated, niente shader. Performance ottima.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Defs, Ellipse, Path, RadialGradient, Stop } from "react-native-svg";

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);
const AnimatedPath = Animated.createAnimatedComponent(Path);

// Mappa tone → colore del riflesso e della luminescenza.
function toneToColor(tone: string | null | undefined, status?: string): string {
  if (status === "speaking") return "#FFB876"; // pesca caldo
  if (status === "recording") return "#7DD4D0"; // teal del LISTEN
  switch (tone) {
    case "calm":      return "#A8C5F0";
    case "warm":      return "#FFC8A8";
    case "energetic": return "#A8E6C8";
    case "concerned": return "#FDBA74";
    case "urgent":    return "#F8B4B4";
    case "neutral":   return "#D4C8E8";
    default:          return "#D4C8E8";
  }
}

interface Props {
  status?: string;
  tone?: string | null;
  meterDb?: number | null;
  meterThreshold?: number | null;
  size?: number;
}

interface Ripple {
  id: number;
  anim: Animated.Value;
  offsetX: number;
  offsetY: number;
}

const RIPPLE_DURATION = 2200;
const MAX_RIPPLES = 4;

export default function MirrorPool({
  status,
  tone,
  meterDb,
  meterThreshold,
  size = 280,
}: Props) {
  // === Respiro minimo a riposo (10 secondi, andata + ritorno) ===
  const breathe = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 5000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(breathe, { toValue: 0, duration: 5000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  // === Increspature di superficie: 2 onde sin lente sempre presenti ===
  const surface = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(surface, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: false })
    );
    loop.start();
    return () => loop.stop();
  }, [surface]);

  // === Luminescenza: si accende quando Koda parla / utente parla ===
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const target = status === "speaking" || status === "recording" ? 1 : 0;
    Animated.timing(glow, {
      toValue: target,
      duration: status === "speaking" || status === "recording" ? 600 : 1200,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [status, glow]);

  // === Ripple sulla superficie quando arriva voce ===
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleId = useRef(0);
  const lastEmitAt = useRef(0);

  const emitRipple = useCallback(() => {
    const anim = new Animated.Value(0);
    const id = ++rippleId.current;
    const offsetX = (Math.random() - 0.5) * (size * 0.2);
    const offsetY = (Math.random() - 0.5) * (size * 0.15);
    setRipples((prev) => {
      const next = prev.length >= MAX_RIPPLES ? prev.slice(prev.length - (MAX_RIPPLES - 1)) : prev;
      return [...next, { id, anim, offsetX, offsetY }];
    });
    Animated.timing(anim, {
      toValue: 1,
      duration: RIPPLE_DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    });
  }, [size]);

  // Speaking → ripple cadenza simulata
  useEffect(() => {
    if (status !== "speaking") return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      emitRipple();
      const delay = 400 + Math.random() * 250;
      setTimeout(tick, delay);
    };
    const t0 = setTimeout(tick, 120);
    return () => {
      cancelled = true;
      clearTimeout(t0);
    };
  }, [status, emitRipple]);

  // Recording → ripple su picco meterDb
  useEffect(() => {
    if (status !== "recording") return;
    if (meterDb == null || meterThreshold == null) return;
    const peak = meterDb > meterThreshold + 4;
    if (!peak) return;
    const now = Date.now();
    if (now - lastEmitAt.current < 220) return;
    lastEmitAt.current = now;
    emitRipple();
  }, [meterDb, meterThreshold, status, emitRipple]);

  // === Calcolo geometria ===
  const cx = size / 2;
  const cy = size / 2;
  // Pozza leggermente schiacciata (più larga che alta): più "fisico"
  const poolRx = size * 0.42;
  const poolRy = size * 0.34;

  // Respiro: scale 0.97 → 1.0 → 0.97
  const breatheScale = breathe.interpolate({
    inputRange: [0, 1],
    outputRange: [0.97, 1.03],
  });

  const reflectColor = toneToColor(tone, status);
  // Opacità riflesso ambientale: bassissimo a riposo, sale quando parla
  const reflectOpacity = glow.interpolate({
    inputRange: [0, 1],
    outputRange: [0.08, 0.32],
  });

  // Path per le increspature di superficie: 2 onde sinusoidali sottili
  // che attraversano la pozza orizzontalmente, sfalsate temporalmente.
  const wavePoints = (phase: number, ampScale = 1) => {
    const pts: string[] = [];
    const steps = 30;
    const yBase = cy - poolRy * 0.05;
    const amplitude = poolRy * 0.06 * ampScale;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = cx - poolRx + (poolRx * 2 * t);
      // Restringe l'ampiezza vicino ai bordi (la pozza si "stringe" lì)
      const edgeFactor = 1 - Math.pow(Math.abs(t - 0.5) * 2, 3);
      const y = yBase + Math.sin(t * Math.PI * 4 + phase) * amplitude * edgeFactor;
      pts.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return pts.join(" ");
  };

  // Generiamo 2 path statici per momenti diversi della fase
  // (animare un path SVG in react-native-svg è costoso → preferiamo
  // animare la translateY o lo scale del contenitore)
  // Soluzione: usiamo waveAnim per shiftare verticalmente il path.
  const waveShift1 = surface.interpolate({
    inputRange: [0, 1],
    outputRange: [-3, 3],
  });
  const waveShift2 = surface.interpolate({
    inputRange: [0, 1],
    outputRange: [3, -3],
  });

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          width: size,
          height: size,
          transform: [{ scale: breatheScale }],
        }}
      >
        <Svg width={size} height={size}>
          <Defs>
            {/* Pozza scura: nucleo profondo, bordi soft */}
            <RadialGradient id="pool" cx="50%" cy="50%" rx="50%" ry="50%" fx="50%" fy="55%">
              <Stop offset="0%" stopColor="#06080C" stopOpacity="1" />
              <Stop offset="55%" stopColor="#0E1118" stopOpacity="1" />
              <Stop offset="100%" stopColor="#1A1F2A" stopOpacity="0.85" />
            </RadialGradient>
            {/* Riflesso ambientale (tinta del tone) */}
            <RadialGradient id="reflect" cx="50%" cy="45%" rx="50%" ry="40%" fx="50%" fy="45%">
              <Stop offset="0%" stopColor={reflectColor} stopOpacity="1" />
              <Stop offset="70%" stopColor={reflectColor} stopOpacity="0.4" />
              <Stop offset="100%" stopColor={reflectColor} stopOpacity="0" />
            </RadialGradient>
            {/* Luminescenza interna: si accende quando Koda parla */}
            <RadialGradient id="glow" cx="50%" cy="50%" rx="40%" ry="40%" fx="50%" fy="50%">
              <Stop offset="0%" stopColor={reflectColor} stopOpacity="0.85" />
              <Stop offset="60%" stopColor={reflectColor} stopOpacity="0.25" />
              <Stop offset="100%" stopColor={reflectColor} stopOpacity="0" />
            </RadialGradient>
          </Defs>

          {/* === LAYER 1: pozza scura === */}
          <Ellipse cx={cx} cy={cy} rx={poolRx} ry={poolRy} fill="url(#pool)" />

          {/* === LAYER 4 (sotto le increspature): luminescenza === */}
          <AnimatedEllipse
            cx={cx}
            cy={cy}
            rx={poolRx * 0.85}
            ry={poolRy * 0.85}
            fill="url(#glow)"
            opacity={glow as any}
          />

          {/* === LAYER 2: riflesso ambientale === */}
          <AnimatedEllipse
            cx={cx}
            cy={cy * 0.9}
            rx={poolRx * 0.85}
            ry={poolRy * 0.5}
            fill="url(#reflect)"
            opacity={reflectOpacity as any}
          />

          {/* === LAYER 5: ripple interni — clipPath ellittico per
              mantenerli dentro la pozza === */}
          {ripples.map((r) => {
            const rrx = r.anim.interpolate({
              inputRange: [0, 1],
              outputRange: [poolRx * 0.1, poolRx * 0.95],
            });
            const rry = r.anim.interpolate({
              inputRange: [0, 1],
              outputRange: [poolRy * 0.08, poolRy * 0.75],
            });
            const ropacity = r.anim.interpolate({
              inputRange: [0, 0.2, 1],
              outputRange: [0, 0.5, 0],
            });
            return (
              <AnimatedEllipse
                key={r.id}
                cx={cx + r.offsetX}
                cy={cy + r.offsetY}
                rx={rrx as any}
                ry={rry as any}
                fill="none"
                stroke={reflectColor}
                strokeWidth={1.5}
                opacity={ropacity as any}
              />
            );
          })}
        </Svg>

        {/* === LAYER 3: increspature di superficie ===
            Due onde sinusoidali che si muovono in verticale lentamente,
            sovrapposte su un secondo SVG (più leggero che animare path
            interi). Restano sempre presenti, dando "vita" all'acqua. */}
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: size,
            height: size,
            transform: [{ translateY: waveShift1 }],
          }}
          pointerEvents="none"
        >
          <Svg width={size} height={size}>
            <Path d={wavePoints(0, 1)} stroke="rgba(255,255,255,0.10)" strokeWidth={1} fill="none" />
          </Svg>
        </Animated.View>
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: size,
            height: size,
            transform: [{ translateY: waveShift2 }],
          }}
          pointerEvents="none"
        >
          <Svg width={size} height={size}>
            <Path d={wavePoints(Math.PI / 2, 0.7)} stroke="rgba(255,255,255,0.07)" strokeWidth={1} fill="none" />
          </Svg>
        </Animated.View>
      </Animated.View>
    </View>
  );
}
