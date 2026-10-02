/**
 * components/CosmicBackground.tsx — v67.8 (Fabio 2026-06-24)
 * -----------------------------------------------------------------------------
 * Sfondo "cosmic space" per la schermata Lascia Andare (sezione 1 doc unico).
 *
 * Design minimale e silenzioso:
 *   • Base: COSMIC_SPACE_BG (indaco quasi-nero).
 *   • 36 stelle statiche distribuite in modo pseudo-random deterministico
 *     (seed fisso → sempre nello stesso posto, nessuna animazione CPU-heavy
 *     che possa competere con il metering vocale della LA).
 *   • Due nuvole di nebulosa radiali (viola molto desaturato) molto leggere,
 *     per dare profondità senza "disturbare" il buio.
 *
 * Vincoli:
 *   • pointerEvents="none" — l'orb e la X restano gli unici elementi
 *     interattivi.
 *   • Nessuna animazione in loop: la LA è uno spazio di SILENZIO, lo sfondo
 *     non deve avere vita propria.
 */
import React, { useMemo } from "react";
import { View, StyleSheet, Dimensions } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop, Rect } from "react-native-svg";
import { COSMIC_SPACE_BG } from "../lib/uiConstants";

const STAR_COUNT = 36;

// LCG deterministico — stesse stelle sempre.
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Star = { cx: number; cy: number; r: number; opacity: number };

export default function CosmicBackground() {
  const { width, height } = Dimensions.get("window");

  const stars = useMemo<Star[]>(() => {
    const rand = seededRandom(42);
    const out: Star[] = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      // Più stelle piccole lontano dal centro (dove c'è l'orb),
      // nessuna stella nei 180px centrali per non interferire visualmente.
      let cx = 0;
      let cy = 0;
      let dist = 0;
      let tries = 0;
      do {
        cx = rand() * width;
        cy = rand() * height;
        dist = Math.hypot(cx - width / 2, cy - height / 2);
        tries++;
      } while (dist < 170 && tries < 6);
      out.push({
        cx,
        cy,
        r: 0.6 + rand() * 1.0,       // 0.6..1.6 px — stelle piccole
        opacity: 0.25 + rand() * 0.5, // 0.25..0.75 — nessuna troppo brillante
      });
    }
    return out;
  }, [width, height]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Defs>
          {/* Nebulosa 1: viola molto desaturato, in alto-sinistra */}
          <RadialGradient id="neb1" cx="25%" cy="22%" r="48%">
            <Stop offset="0%" stopColor="#2A1C44" stopOpacity={0.45} />
            <Stop offset="55%" stopColor="#171028" stopOpacity={0.15} />
            <Stop offset="100%" stopColor="#000000" stopOpacity={0} />
          </RadialGradient>
          {/* Nebulosa 2: indaco profondo, in basso-destra */}
          <RadialGradient id="neb2" cx="78%" cy="80%" r="55%">
            <Stop offset="0%" stopColor="#1A1434" stopOpacity={0.5} />
            <Stop offset="60%" stopColor="#0C0920" stopOpacity={0.18} />
            <Stop offset="100%" stopColor="#000000" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {/* Base — nero cosmico */}
        <Rect x={0} y={0} width={width} height={height} fill={COSMIC_SPACE_BG} />
        {/* Nebulose */}
        <Rect x={0} y={0} width={width} height={height} fill="url(#neb1)" />
        <Rect x={0} y={0} width={width} height={height} fill="url(#neb2)" />
        {/* Stelle */}
        {stars.map((s, i) => (
          <Circle
            key={i}
            cx={s.cx}
            cy={s.cy}
            r={s.r}
            fill="#F5E6CC"
            opacity={s.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}
