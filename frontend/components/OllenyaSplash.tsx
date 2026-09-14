/**
 * OllenyaSplash — splash identitario dell'app.
 *
 * === v65.42 (Fabio 2026-06 fix definitivo) ================================
 *
 * Riscritto da zero per allineare esattamente al reference finale di Fabio
 * (asset2.png): eclissi grande centrata, wordmark serif elegante "Ollenya"
 * dove la "O" iniziale È essa stessa una piccola eclissi, sottotitolo
 * "Sempre con te" italic con letter-spacing, sfondo nero puro.
 *
 * Fix rispetto v65.41:
 *   1. Eliminato il glow layer "Ollenya" completo che si sovrapponeva
 *      graficamente sopra al row [mini-orb + "llenya"] causando doppioni.
 *   2. Font cambiato a SERIF (Baskerville iOS / serif Android) per matchare
 *      lo stile editoriale del reference.
 *   3. Ciclo 4 palette PARTE DA CHAMPAGNE poi passa a viola → Tiffany →
 *      ciclamino → rosa → ritorno a champagne. Il champagne è la firma
 *      identitaria dominante.
 *   4. Brand-lock: wordmark hardcoded "Ollenya", ignora `aiName` prop.
 */
import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  Pressable,
  Dimensions,
  Platform,
} from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";

interface Props {
  aiName?: string | null;
  duration?: number;
  onComplete: () => void;
}

// === 5 PALETTE (Champagne + 4 tonalità cicliche) ==========================
// Il champagne è la firma: appare all'inizio e alla fine di ogni giro,
// così l'utente lo vede sempre come tinta dominante. Le 4 tonalità
// intermedie sono la "vita" dell'eclissi.
const CHAMPAGNE: [string, string, string] = ["#F5E6CC", "#D4B896", "#8B6F4E"];
const PALETTES: [string, string, string][] = [
  CHAMPAGNE,                              // 0 — champagne (start/end)
  ["#C4B5FD", "#8B5CF6", "#7C3AED"],      // 1 — viola/lavanda
  ["#5EEAD4", "#14B8A6", "#0F766E"],      // 2 — Tiffany / petrolio
  ["#F9A8D4", "#EC4899", "#BE185D"],      // 3 — ciclamino
  ["#FBCFE8", "#F472B6", "#DB2777"],      // 4 — rosa caldo
];

// Sub-component: eclissi con anello luminoso + disco nero centrale.
function OrbCircle({
  palette,
  size,
  discRatio = 0.58,
}: {
  palette: [string, string, string];
  size: number;
  discRatio?: number;
}) {
  const r = size / 2;
  const gradId = `g_${palette[0].slice(1)}_${palette[1].slice(1)}_${Math.round(discRatio * 100)}`;
  const discR = r * discRatio;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={gradId} cx="50%" cy="50%" r="50%" fx="42%" fy="42%">
          <Stop offset="0%" stopColor={palette[0]} stopOpacity={1} />
          <Stop offset="52%" stopColor={palette[1]} stopOpacity={0.95} />
          <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={r} cy={r} r={r * 0.95} fill={`url(#${gradId})`} />
      <Circle cx={r} cy={r} r={discR} fill="#06060A" />
      <Circle
        cx={r}
        cy={r}
        r={discR}
        fill="none"
        stroke={palette[0]}
        strokeWidth={Math.max(1.5, size * 0.012)}
        opacity={0.95}
      />
    </Svg>
  );
}

// Font serif elegante multipiattaforma per il wordmark "Ollenya"
const SERIF_FONT = Platform.select({
  ios: "Didot",       // eleganza editoriale iOS
  android: "serif",   // Android serif default (Droid Serif / Noto Serif)
  default: "serif",
});

export default function OllenyaSplash({ aiName: _aiName, duration = 12000, onComplete }: Props) {
  // Brand-lock: sempre "Ollenya", mai aiName utente.
  void _aiName;
  const suffix = "llenya"; // il "O" iniziale è la mini-eclissi

  const { width } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.78, 360);
  // Mini-eclissi allineata all'altezza x del serif (68pt) → ~44px
  const miniOrbSize = 46;

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const textFade = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  // === CROSS-FADE con PLATEAU su 5 palette ================================
  const prog = useRef(new Animated.Value(0)).current;
  const N = PALETTES.length; // 5
  // Con duration=12s e N=5 → 2.4s per palette (>2s = ok visibile).
  const segmentMs = Math.max(2000, Math.floor(duration / N));

  // Fade-in scaglionato
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    Animated.timing(orbFade, {
      toValue: 1, duration: 1200, delay: 100, useNativeDriver: true,
    }).start();
    Animated.timing(textFade, {
      toValue: 1, duration: 900, delay: 900, useNativeDriver: true,
    }).start();
  }, [fade, orbFade, textFade]);

  // Loop del progresso palette (0 → N in loop lineare)
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(prog, {
        toValue: N,
        duration: segmentMs * N,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [prog, segmentMs, N]);

  // Opacity con plateau per ogni palette (fw = fade width, on = plateau on)
  const opacityFor = (k: number) => {
    const fw = 0.2;
    if (k === 0) {
      // Champagne: doppio picco (start + wrap) per fluidità del loop
      return prog.interpolate({
        inputRange: [0, 1 - fw, 1, N - 1, N - fw, N],
        outputRange: [1, 1, 0, 0, 1, 1],
      });
    }
    const start = k - fw;
    const on1 = k;
    const on2 = k + 1 - fw;
    const off = k + 1;
    return prog.interpolate({
      inputRange: [0, start, on1, on2, off, N],
      outputRange: [0, 0, 1, 1, 0, 0],
    });
  };

  // Fade-out finale
  useEffect(() => {
    const t = setTimeout(() => {
      if (completedRef.current) return;
      completedRef.current = true;
      Animated.timing(fade, {
        toValue: 0, duration: 800, useNativeDriver: true,
      }).start(() => onComplete());
    }, duration);
    return () => clearTimeout(t);
  }, [duration, fade, onComplete]);

  const handleSkip = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    Animated.timing(fade, {
      toValue: 0, duration: 350, useNativeDriver: true,
    }).start(() => onComplete());
  };

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerCol}>
          {/* === ECLISSI GRANDE — 5 palette con plateau (start: champagne) */}
          <Animated.View
            style={{
              opacity: orbFade,
              width: orbSize,
              height: orbSize,
              marginBottom: 56,
            }}
          >
            {PALETTES.map((p, k) => (
              <Animated.View
                key={`orb_${k}`}
                style={[StyleSheet.absoluteFill, { opacity: opacityFor(k) }]}
              >
                <OrbCircle palette={p} size={orbSize} discRatio={0.58} />
              </Animated.View>
            ))}
          </Animated.View>

          {/* === WORDMARK "Ollenya" — mini-eclissi + "llenya" serif italic
               Row PULITO: [mini-orb] + [Text serif]. Nessun glow overlay
               "Ollenya" completo dietro. Ogni elemento è indipendente. */}
          <Animated.View style={[styles.wordmarkRow, { opacity: textFade }]}>
            {/* Mini-eclissi al posto della "O" iniziale */}
            <View style={styles.miniOrbWrap}>
              {PALETTES.map((p, k) => (
                <Animated.View
                  key={`mini_${k}`}
                  style={[StyleSheet.absoluteFill, { opacity: opacityFor(k) }]}
                >
                  <OrbCircle palette={p} size={miniOrbSize} discRatio={0.72} />
                </Animated.View>
              ))}
            </View>
            {/* Resto del wordmark */}
            <Text style={styles.nameSuffix} allowFontScaling={false}>
              {suffix}
            </Text>
          </Animated.View>

          {/* === SOTTOTITOLO — "Sempre con te" serif italic letter-spaced */}
          <Animated.Text
            style={[styles.tagline, { opacity: textFade }]}
            allowFontScaling={false}
          >
            Sempre con te
          </Animated.Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#06060A",
    zIndex: 9999,
    elevation: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  centerCol: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    // Ombra caldo-champagne dietro tutta la riga (sostituisce il glow
    // duplicato che causava sovrapposizione). Effetto morbido di luce
    // attorno al wordmark.
    shadowColor: "#D4B896",
    shadowOpacity: 0.5,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
  },
  miniOrbWrap: {
    width: 46,
    height: 46,
    marginRight: 2,
  },
  nameSuffix: {
    color: "#F5E9DA",
    fontSize: 62,
    fontWeight: "400",
    letterSpacing: 0,
    fontFamily: SERIF_FONT,
    includeFontPadding: false,
    textShadowColor: "rgba(212,184,150,0.6)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  tagline: {
    color: "rgba(230,215,190,0.75)",
    fontSize: 17,
    letterSpacing: 4,
    fontStyle: "italic",
    fontFamily: SERIF_FONT,
    textAlign: "center",
    textShadowColor: "rgba(212,184,150,0.4)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
});
