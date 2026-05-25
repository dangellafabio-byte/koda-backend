/**
 * LiquidInversionBg — sfondo "Liquid Inversion" (richiesta utente 2026-06).
 *
 * Concept: di notte l'eclissi fluttua nel vuoto indaco; di giorno lo
 * sfondo è un BIANCO OTTICO DENSO che si comporta come un liquido
 * magnetico bianco intrappolato nello schermo.
 *
 * Effetti visivi simulati:
 *  1. "Conca gravitazionale" attorno all'eclissi → un RadialGradient
 *     leggermente più scuro al centro (#EAE5DB) che sfuma in bianco
 *     puro (#FBFAF7) verso i bordi. Crea l'illusione che la massa
 *     dell'eclissi pieghi lo sfondo, come un peso su un telo elastico.
 *  2. "Latte retroilluminato" → un secondo RadialGradient sopra, che
 *     prende la tinta corrente del tone dell'eclissi (calm, warm,
 *     ciclamino…) al 25-35% di opacità e sfuma in trasparente verso
 *     i bordi. Quando l'eclissi pulsa rosa, il latte si tinge rosa
 *     "dall'interno".
 *  3. "Respiro" → un Animated.Value molto lento (8s) che fa pulsare
 *     leggermente il raggio del gradient, dando la sensazione che il
 *     liquido si gonfi e sgonfi impercettibilmente.
 *
 * Implementazione: react-native-svg (già installato). Niente shader
 * WebGL — è una simulazione visiva, non fisica vera. A occhio nudo
 * l'effetto è molto convincente.
 */

import React, { useEffect, useRef } from "react";
import { Animated, Dimensions, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

// === Mappa tone → colore del "latte retroilluminato" ===
// Tonalità neon morbide; vengono attenuate dall'opacità SVG (stopOpacity)
// così il bianco resta riconoscibile e il colore traspare appena.
function toneToTint(tone: string | null | undefined, status?: string): string {
  // Quando Koda parla, vira sempre verso il calore (warm).
  if (status === "speaking") return "#FFB876"; // pesca caldo
  if (status === "recording") return "#7DD4D0"; // teal del LISTEN
  switch (tone) {
    case "calm":       return "#A8C5F0"; // azzurro chiaro
    case "warm":       return "#FFC8A8"; // pesca
    case "energetic":  return "#A8E6C8"; // verde menta
    case "concerned":  return "#FDBA74"; // arancio
    case "urgent":     return "#F8B4B4"; // ciclamino chiaro
    case "neutral":    return "#D4C8E8"; // viola morbido
    default:           return "#D4C8E8"; // viola morbido (idle/default)
  }
}

interface Props {
  /** tone corrente dell'eclissi (calm, warm, urgent, etc.) */
  tone?: string | null;
  /** status corrente (recording, speaking, idle, etc.) */
  status?: string;
  /** posizione dell'eclissi sullo schermo (0..1 per asse) */
  centerX?: number;
  centerY?: number;
}

const AnimatedSvg = Animated.createAnimatedComponent(Svg as any);

export default function LiquidInversionBg({
  tone,
  status,
  centerX = 0.5,
  centerY = 0.42, // l'eclissi è leggermente sopra il centro
}: Props) {
  const { width, height } = Dimensions.get("window");
  const breathe = useRef(new Animated.Value(0)).current;

  // === Respiro del liquido: 8s di andata, 8s di ritorno, in loop ===
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 8000,
          useNativeDriver: false,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: 8000,
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  // Il raggio del gradient varia tra ~45% e ~52% del lato lungo
  const tint = toneToTint(tone, status);
  const cx = centerX;
  const cy = centerY;

  // Per ora teniamo gli SVG statici (radius fisso) e animiamo l'opacità
  // del layer "tinta" via Animated.View — più semplice e performante che
  // animare il radius dentro l'SVG (che richiederebbe Animated.attribute).
  const tintOpacity = breathe.interpolate({
    inputRange: [0, 1],
    outputRange: [0.22, 0.35], // più chiaro → più carico
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* === LAYER 1: bianco ottico denso con conca centrale === */}
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
            {/* Centro: leggermente più scuro = "conca gravitazionale" */}
            <Stop offset="0%" stopColor="#E8E2D2" stopOpacity="1" />
            <Stop offset="35%" stopColor="#F0EBDC" stopOpacity="1" />
            <Stop offset="100%" stopColor="#FBFAF5" stopOpacity="1" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#liquidBase)" />
      </Svg>

      {/* === LAYER 2: "latte retroilluminato" — tinta dell'alone === */}
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
              {/* Concentriche: tinta al centro, sfuma a trasparente */}
              <Stop offset="0%" stopColor={tint} stopOpacity="1" />
              <Stop offset="60%" stopColor={tint} stopOpacity="0.3" />
              <Stop offset="100%" stopColor={tint} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width={width} height={height} fill="url(#liquidTint)" />
        </Svg>
      </Animated.View>
    </View>
  );
}
