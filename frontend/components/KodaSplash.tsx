/**
 * KodaSplash — splash screen evocativo all'apertura dell'app.
 *
 * Versione 3 — niente sottotitolo, SVG senza Animated stops, cross-fade
 * fluido tra 4 palette tramite OPACITY di due cerchi sovrapposti.
 */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Easing, Pressable, Dimensions } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";

interface Props {
  aiName?: string | null;
  duration?: number;
  onComplete: () => void;
}

// 4 palette identitarie, percorse in loop con cross-fade fluido.
const PALETTES: Array<[string, string, string]> = [
  ["#C4B5FD", "#8B5CF6", "#7C3AED"], // viola/lavanda
  ["#5EEAD4", "#0E7C7B", "#134E4A"], // blu petrolio
  ["#F9A8D4", "#EC4899", "#BE185D"], // ciclamino
  ["#FBCFE8", "#F472B6", "#DB2777"], // rosa caldo
];

// Sub-component: cerchio con gradient di una sola palette, statico.
// Renderizza l'ECLISSI completa:
//  1) alone esterno (radial gradient palette)
//  2) disco nero centrale (il "buco" dell'eclissi)
//  3) rim light (anello sottile di luce sul bordo del disco)
function OrbCircle({ palette, size }: { palette: [string, string, string]; size: number }) {
  const r = size / 2;
  const gradId = `g_${palette[0].slice(1)}_${palette[1].slice(1)}`;
  // Disco nero centrale al 50% del raggio totale → eclissi "ad anello"
  const discR = r * 0.5;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={gradId} cx="50%" cy="50%" r="50%" fx="38%" fy="38%">
          <Stop offset="0%" stopColor={palette[0]} stopOpacity={1} />
          <Stop offset="55%" stopColor={palette[1]} stopOpacity={0.9} />
          <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* 1) Alone luminoso esterno */}
      <Circle cx={r} cy={r} r={r * 0.95} fill={`url(#${gradId})`} />
      {/* 2) Disco nero centrale — il vero "occhio" dell'eclissi */}
      <Circle cx={r} cy={r} r={discR} fill="#06060A" />
      {/* 3) Rim light — anello sottile luminoso attorno al disco */}
      <Circle
        cx={r}
        cy={r}
        r={discR}
        fill="none"
        stroke={palette[0]}
        strokeWidth={1.5}
        opacity={0.85}
      />
    </Svg>
  );
}

export default function KodaSplash({ aiName, duration = 10000, onComplete }: Props) {
  const { width } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.75, 320);

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const nameFade = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  // Indice della palette attuale (sotto) e successiva (sopra, fade-in).
  const [curIdx, setCurIdx] = useState(0);
  // Animated value 0..1 = opacity del cerchio "successivo" sovrapposto.
  const crossOp = useRef(new Animated.Value(0)).current;

  const segmentMs = Math.max(2200, Math.floor(duration / PALETTES.length));
  // Cross-fade più lungo (95% del segmento) per transizioni "burrose" senza
  // stacchi percettibili. Easing inOut sotto per ammorbidire ulteriormente.
  const fadeMs = Math.floor(segmentMs * 0.95);

  // === Fade-in iniziale ===
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    Animated.timing(orbFade, {
      toValue: 1,
      duration: 1000,
      delay: 100,
      useNativeDriver: true,
    }).start();
    Animated.timing(nameFade, {
      toValue: 1,
      duration: 900,
      delay: 900,
      useNativeDriver: true,
    }).start();
  }, [fade, orbFade, nameFade]);

  // === Cross-fade loop tra palette consecutive ===
  // Strategia: due cerchi sovrapposti, "bottom" e "top".
  // - bottom: palette attuale (PALETTES[curIdx])
  // - top:    palette successiva (PALETTES[curIdx+1])
  // Animo l'opacity di top da 0 a 1 in fadeMs ms. Quando finito:
  //   - aggiorno curIdx = curIdx+1 (così bottom diventa la nuova palette)
  //   - reset crossOp = 0 istantaneamente (top torna invisibile)
  //   - ripeto
  useEffect(() => {
    let alive = true;
    let timer: any = null;
    const tick = () => {
      if (!alive) return;
      Animated.timing(crossOp, {
        toValue: 1,
        duration: fadeMs,
        // Easing inOut sine = velocità che parte lenta, accelera al centro,
        // rallenta in uscita. Risultato visivo: NESSUNO stacco percettibile.
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!alive || !finished) return;
        // Avanza indice e resetta opacity in modo invisibile
        setCurIdx((i) => (i + 1) % PALETTES.length);
        crossOp.setValue(0);
      });
      timer = setTimeout(tick, segmentMs);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [crossOp, fadeMs, segmentMs]);

  // === Fade-out finale ===
  useEffect(() => {
    const t = setTimeout(() => {
      if (completedRef.current) return;
      completedRef.current = true;
      Animated.timing(fade, {
        toValue: 0,
        duration: 800,
        useNativeDriver: true,
      }).start(() => onComplete());
    }, duration);
    return () => clearTimeout(t);
  }, [duration, fade, onComplete]);

  const handleSkip = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    Animated.timing(fade, {
      toValue: 0,
      duration: 350,
      useNativeDriver: true,
    }).start(() => onComplete());
  };

  const displayName = (aiName?.trim() || "Koda").trim();
  const curPalette = PALETTES[curIdx];
  const nextPalette = PALETTES[(curIdx + 1) % PALETTES.length];

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerWrap}>
          {/* Eclissi: due cerchi sovrapposti, cross-fade fluido tra palette */}
          <Animated.View
            style={{
              opacity: orbFade,
              marginBottom: 40,
              width: orbSize,
              height: orbSize,
            }}
          >
            {/* Cerchio "bottom" — palette attuale, sempre piena opacity */}
            <View style={StyleSheet.absoluteFill}>
              <OrbCircle palette={curPalette} size={orbSize} />
            </View>
            {/* Cerchio "top" — palette successiva, opacity 0→1 (cross-fade) */}
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: crossOp }]}>
              <OrbCircle palette={nextPalette} size={orbSize} />
            </Animated.View>
          </Animated.View>

          {/* Solo nome AI, niente sottotitolo */}
          <Animated.Text style={[styles.name, { opacity: nameFade }]}>
            {displayName}
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
  centerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  name: {
    color: "#F5E6F0",
    fontSize: 52,
    fontWeight: "600",
    letterSpacing: 4,
    textAlign: "center",
    textShadowColor: "rgba(244,114,182,0.55)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 24,
  },
});
