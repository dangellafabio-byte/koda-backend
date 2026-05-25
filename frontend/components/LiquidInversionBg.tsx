/**
 * LiquidInversionBg — sfondo "Liquid Inversion" (richiesta utente 2026-06).
 *
 * Concept: bianco ottico denso che si comporta come liquido magnetico
 * intrappolato nello schermo. Quando l'eclissi pulsa, ONDE CONCENTRICHE
 * si propagano dal centro verso i bordi, come increspature nel latte.
 *
 * Layer:
 *  1. Bianco ottico denso (RadialGradient) → "conca gravitazionale"
 *     attorno all'eclissi.
 *  2. "Latte retroilluminato" → tinta che corrisponde al tone corrente,
 *     visibile attraverso il bianco come bagliore filtrato.
 *  3. RIPPLES (nuovo 2026-06) → onde colorate concentriche:
 *       • Quando Koda parla → cadenza simulata (~350-500ms con jitter
 *         naturale) per imitare il ritmo del parlato italiano.
 *       • Quando l'utente parla → meterDb REALE: ogni picco di volume
 *         sopra soglia genera un'onda. Sincronia vera con la voce.
 *
 * Ogni ripple eredita il colore del tone corrente — onde pesca quando
 * Koda è "warm", onde ciclamino quando è "urgent", onde teal quando
 * stai parlando tu, ecc.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Animated, Dimensions, StyleSheet, View, Easing } from "react-native";
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from "react-native-svg";

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

// === Mappa tone → colore "latte retroilluminato" e "onde" ===
function toneToTint(tone: string | null | undefined, status?: string): string {
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
  tone?: string | null;
  status?: string;
  /** dBFS corrente del microfono (null se non in registrazione). */
  meterDb?: number | null;
  meterThreshold?: number | null;
  centerX?: number;
  centerY?: number;
}

// Singola "goccia di inchiostro nel latte". Ogni goccia ha:
//  - posizione leggermente offset dal centro dell'eclissi (jitter naturale)
//  - asimmetria sui due assi (rx ≠ ry) → forma organica, non geometrica
//  - leggera rotazione → ogni goccia "vive" in modo unico
//  - il proprio gradient radiale di fill → sfumato come fumo che si dirada
interface Ripple {
  id: number;
  color: string;
  anim: Animated.Value;
  /** offset dal centro (px) per dare l'idea di "schizzi di gocce" */
  offsetX: number;
  offsetY: number;
  /** asimmetria 0.7..1.3 sui due assi */
  ratioX: number;
  ratioY: number;
  /** rotazione iniziale 0..360° */
  rotation: number;
}

const RIPPLE_DURATION = 2800; // ms per espansione completa
const MAX_RIPPLES = 5; // limite per non saturare CPU

export default function LiquidInversionBg({
  tone,
  status,
  meterDb,
  meterThreshold,
  centerX = 0.5,
  centerY = 0.42,
}: Props) {
  const { width, height } = Dimensions.get("window");
  const breathe = useRef(new Animated.Value(0)).current;
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleIdRef = useRef(0);
  // ref tracciante l'ultimo picco audio (per debounce ripple su recording)
  const lastUserRippleAt = useRef(0);

  // === Respiro del liquido (8s + 8s) ===
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 8000, useNativeDriver: false }),
        Animated.timing(breathe, { toValue: 0, duration: 8000, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  // === Emette una nuova "goccia di inchiostro" ===
  const emitRipple = useCallback((color: string) => {
    const anim = new Animated.Value(0);
    const id = ++rippleIdRef.current;
    // Parametri organici random — ogni goccia è "unica":
    //  - offset ±35px dal centro dell'eclissi (schizzo naturale)
    //  - asimmetria assi: 0.75..1.25 → l'ellisse non è mai un cerchio
    //  - rotazione 0..360°
    const offsetX = (Math.random() - 0.5) * 70;
    const offsetY = (Math.random() - 0.5) * 70;
    const ratioX = 0.75 + Math.random() * 0.5;
    const ratioY = 0.75 + Math.random() * 0.5;
    const rotation = Math.random() * 360;
    setRipples((prev) => {
      const next = prev.length >= MAX_RIPPLES ? prev.slice(prev.length - (MAX_RIPPLES - 1)) : prev;
      return [...next, { id, color, anim, offsetX, offsetY, ratioX, ratioY, rotation }];
    });
    Animated.timing(anim, {
      toValue: 1,
      duration: RIPPLE_DURATION,
      // ease-out morbido: la goccia si dilata velocemente all'inizio
      // (come l'inchiostro reale che esplode nei primi istanti),
      // poi rallenta mentre si dirada nel latte.
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    });
  }, []);

  // === SPEAKING: cadenza simulata del parlato italiano (~350-500ms) ===
  useEffect(() => {
    if (status !== "speaking") return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const color = toneToTint(tone, status);
      emitRipple(color);
      // Cadenza naturale: 320-520ms con jitter
      const delay = 320 + Math.random() * 200;
      setTimeout(tick, delay);
    };
    // Prima onda dopo un piccolo ritardo per non collidere con l'inizio
    const t0 = setTimeout(tick, 120);
    return () => {
      cancelled = true;
      clearTimeout(t0);
    };
  }, [status, tone, emitRipple]);

  // === RECORDING: ripple sincrono al meterDb reale dell'utente ===
  // Quando l'utente parla, ogni volta che il livello audio supera il
  // threshold (con cooldown di ~180ms per non saturare), nasce un'onda.
  // Questo è sincronia VERA: il latte vibra al ritmo della tua voce.
  useEffect(() => {
    if (status !== "recording") return;
    if (meterDb == null || meterThreshold == null) return;
    // Considera "picco" se il livello è sopra threshold + 4dB
    const peak = meterDb > meterThreshold + 4;
    if (!peak) return;
    const now = Date.now();
    if (now - lastUserRippleAt.current < 180) return;
    lastUserRippleAt.current = now;
    emitRipple(toneToTint(tone, status));
  }, [meterDb, meterThreshold, status, tone, emitRipple]);

  // Tinta del "latte retroilluminato" — leggero, sempre presente
  const tint = toneToTint(tone, status);
  const cx = centerX;
  const cy = centerY;
  const cxAbs = width * cx;
  const cyAbs = height * cy;

  const tintOpacity = breathe.interpolate({
    inputRange: [0, 1],
    outputRange: [0.22, 0.35],
  });

  // Raggio massimo dell'onda: copre lo schermo dal centro al vertice
  // più lontano. Calcoliamo la diagonale ai 4 angoli e prendiamo il max.
  const maxR = Math.hypot(
    Math.max(cxAbs, width - cxAbs),
    Math.max(cyAbs, height - cyAbs)
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* === LAYER 1: bianco ottico denso con conca === */}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient
            id="liquidBase"
            cx={`${cx * 100}%`}
            cy={`${cy * 100}%`}
            rx="65%"
            ry="65%"
            fx={`${cx * 100}%`}
            fy={`${cy * 100}%`}
          >
            <Stop offset="0%" stopColor="#E8E2D2" stopOpacity="1" />
            <Stop offset="35%" stopColor="#F0EBDC" stopOpacity="1" />
            <Stop offset="100%" stopColor="#FBFAF5" stopOpacity="1" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#liquidBase)" />
      </Svg>

      {/* === LAYER 2: latte retroilluminato dal tone === */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: tintOpacity }]}>
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient
              id="liquidTint"
              cx={`${cx * 100}%`}
              cy={`${cy * 100}%`}
              rx="50%"
              ry="50%"
              fx={`${cx * 100}%`}
              fy={`${cy * 100}%`}
            >
              <Stop offset="0%" stopColor={tint} stopOpacity="1" />
              <Stop offset="60%" stopColor={tint} stopOpacity="0.3" />
              <Stop offset="100%" stopColor={tint} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width={width} height={height} fill="url(#liquidTint)" />
        </Svg>
      </Animated.View>

      {/* === LAYER 3: "Gocce d'inchiostro" che si diffondono nel latte ===
          Ogni goccia è un Ellisse (non un cerchio perfetto) con:
            - posizione leggermente sfalsata dal centro
            - asimmetria sui due assi → forma organica
            - rotazione random → ogni goccia è unica
            - fill RadialGradient → pieno al centro, sfumato a 0 ai
              bordi → effetto fumo/inchiostro che si dirada nel latte,
              non un anello.
          Sincrone con la voce: cadenza simulata mentre Koda parla,
          meterDb reale mentre parli tu. */}
      {ripples.length > 0 && (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Defs>
            {ripples.map((r) => (
              <RadialGradient
                key={`grad-${r.id}`}
                id={`drop-${r.id}`}
                cx="50%"
                cy="50%"
                rx="50%"
                ry="50%"
                fx="50%"
                fy="50%"
              >
                {/* Pieno al centro: l'inchiostro è denso lì.
                    Verso i bordi: si dirada nel latte. */}
                <Stop offset="0%" stopColor={r.color} stopOpacity="0.55" />
                <Stop offset="55%" stopColor={r.color} stopOpacity="0.22" />
                <Stop offset="100%" stopColor={r.color} stopOpacity="0" />
              </RadialGradient>
            ))}
          </Defs>
          {ripples.map((r) => {
            // Dimensione: parte piccola (60px) → cresce fino a coprire
            // ~70% dello schermo, poi sfuma via.
            const baseRadius = r.anim.interpolate({
              inputRange: [0, 1],
              outputRange: [40, maxR * 1.2],
            });
            const opacity = r.anim.interpolate({
              inputRange: [0, 0.18, 1],
              outputRange: [0, 0.95, 0],
            });
            // rx e ry diversi (asimmetria) → forma organica
            const rx = Animated.multiply(baseRadius, new Animated.Value(r.ratioX));
            const ry = Animated.multiply(baseRadius, new Animated.Value(r.ratioY));
            const dropCx = cxAbs + r.offsetX;
            const dropCy = cyAbs + r.offsetY;
            return (
              <AnimatedEllipse
                key={r.id}
                cx={dropCx}
                cy={dropCy}
                rx={rx as any}
                ry={ry as any}
                fill={`url(#drop-${r.id})`}
                opacity={opacity as any}
                transform={`rotate(${r.rotation} ${dropCx} ${dropCy})`}
              />
            );
          })}
        </Svg>
      )}
    </View>
  );
}
