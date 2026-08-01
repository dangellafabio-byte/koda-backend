/**
 * RadialGlow — Alone radiale che parte dal centro (dove c'è il blob) e si
 * propaga verso i bordi sfumando in trasparenza.
 *
 * Stati & colori (coerenti con OrganicBlob):
 *  - idle       → viola profondo (presenza)
 *  - recording  → blu petrolio (ti ascolto)
 *  - thinking   → ciclamino (elabora)
 *  - speaking   → viola (override dal blob)
 *
 * Implementazione: SVG fullscreen con un RadialGradient centrato.
 *
 * === v64.17 (2026-08-01) — REWRITE PERFORMANCE-FIRST ===
 * Il vecchio RadialGlow aveva una `Animated.loop` continua con 4 timing su
 * `useNativeDriver: false` che pulsava l'opacity di un SVG a schermo pieno
 * 24/7 (anche in idle). Su iPhone il thread JS era abbastanza veloce da
 * reggere, ma su Xiaomi tablet Android il FPS crollava da 120 → 13 anche
 * quando l'utente non stava facendo nulla (misurato v64.15).
 *
 * Test A/B v64.16 (RadialGlow disabilitato solo su Android):
 *   FPS idle: 13 → 120  (+800%)
 *   FPS scroll: 11 → 120 (+700%)
 * Causa confermata con numeri reali.
 *
 * Fix definitivo (questo file):
 *   - RIMOSSA pulsazione continua (Animated.loop) — modulava opacity 70-100%
 *     di un alone già molto tenue (idle 0.05, recording 0.30), impatto
 *     visivo trascurabile ma costo perf enorme.
 *   - MANTENUTO fade colore su cambio stato (700ms ease-out) — è la parte
 *     "viva" dell'alone, importante per la sincronia con l'orb centrale.
 *   - MANTENUTA transizione opacity su cambio stato (Animated.timing 600ms,
 *     single-shot, non loop → non trigger power manager Android).
 *   - Riabilitato su ENTRAMBE le piattaforme (parità visiva iOS/Android).
 */
import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Animated, Easing, Dimensions } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Rect } from "react-native-svg";

export type GlowStatus = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

const STATE_COLORS: Record<GlowStatus, string> = {
  idle: "#7C3AED",         // VIOLA profondo (presenza)
  recording: "#0E7C7B",    // BLU PETROLIO (ti ascolto)
  transcribing: "#BE185D", // CICLAMINO (ponte pensiero/trascrizione)
  thinking: "#BE185D",     // CICLAMINO (sto pensando)
  speaking: "#7C3AED",     // VIOLA — override dal blob, qui è base
};

// Opacità dell'alone in base allo stato. In v64.16 il valore era modulato
// da un pulse tra 70-100% (es. idle: 0.035↔0.05, recording: 0.21↔0.30).
// In v64.17 usiamo direttamente il valore massimo — l'occhio non distingueva
// comunque la modulazione su un'aura così tenue.
const STATE_OPACITY: Record<GlowStatus, number> = {
  idle: 0.05,
  recording: 0.30,
  transcribing: 0.28,
  thinking: 0.28,
  speaking: 0.20,
};

// === RGB interpolation helpers (transizioni colore graduali) ==========
function hexToRgb(hex: string | undefined | null): [number, number, number] {
  if (!hex || typeof hex !== "string") return [229, 231, 235]; // #E5E7EB
  const h = hex.replace("#", "");
  const v = h.length === 3
    ? h.split("").map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [v[0] || 0, v[1] || 0, v[2] || 0];
}
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export default function RadialGlow({
  status,
}: {
  status: GlowStatus;
}) {
  const targetColor = STATE_COLORS[status];
  const targetOpacity = STATE_OPACITY[status];

  // Fade opacity — Animated.Value che parte da 0 e sale al target su
  // cambio stato. Single-shot, non ciclico → nessun trigger continuo del
  // power manager Android. Su cambio stato si aggiorna in 600ms.
  const opacityAnim = useRef(new Animated.Value(0)).current;

  // === TRANSIZIONE COLORE GRADUALE (700ms ease-out) =====================
  // Solo su cambio stato: interpolazione RGB via requestAnimationFrame.
  // Single-shot, 42 render in 700ms poi si ferma → costo marginale.
  const [color, setColor] = useState<string>(targetColor);
  const fromColorRef = useRef<string>(targetColor);
  const targetColorRef = useRef<string>(targetColor);
  const animStartRef = useRef<number>(0);

  useEffect(() => {
    if (targetColorRef.current === targetColor) return;
    fromColorRef.current = color;
    targetColorRef.current = targetColor;
    animStartRef.current = Date.now();
    const DUR = 700;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - animStartRef.current;
      const t = Math.min(1, elapsed / DUR);
      const eased = 1 - Math.pow(1 - t, 3);
      const c = lerpColor(fromColorRef.current, targetColorRef.current, eased);
      setColor(c);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [targetColor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fade opacità al target sul cambio stato. Anche questo è SINGLE-SHOT
  // (600ms poi si ferma) → nessuna oscillazione continua, nessun consumo
  // CPU quando lo stato è stabile.
  useEffect(() => {
    Animated.timing(opacityAnim, {
      toValue: targetOpacity,
      duration: 600,
      easing: Easing.out(Easing.quad),
      // useNativeDriver:false è obbligatorio per animare props SVG.
      // Ma è single-shot → nessun problema di perf su Android.
      useNativeDriver: false,
    }).start();
  }, [targetOpacity, opacityAnim]);

  const { width, height } = Dimensions.get("window");
  const W = Math.max(width, 360);
  const H = Math.max(height, 720);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          <RadialGradient
            id="glowGrad"
            cx="50%"
            cy="46%"
            r="70%"
            fx="50%"
            fy="46%"
          >
            {/* Centro: pieno (sotto il blob l'alone è massimo) */}
            <Stop offset="0%" stopColor={color} stopOpacity={1.0} />
            {/* Metà: dimezzato — l'aura sfuma morbida */}
            <Stop offset="35%" stopColor={color} stopOpacity={0.55} />
            <Stop offset="65%" stopColor={color} stopOpacity={0.18} />
            {/* Bordi: trasparente */}
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <AnimatedRect
          x={0}
          y={0}
          width={W}
          height={H}
          fill="url(#glowGrad)"
          opacity={opacityAnim as any}
        />
      </Svg>
    </View>
  );
}
