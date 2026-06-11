/**
 * KodaSplash — splash screen evocativo all'apertura dell'app.
 *
 * Versione 3 — niente sottotitolo, SVG senza Animated stops, cross-fade
 * fluido tra 4 palette tramite OPACITY di due cerchi sovrapposti.
 */
import React, { useEffect, useRef } from "react";
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

  // === CROSS-FADE CONTINUO v4 (fix "stacco tra colore e colore") ===
  // La v3 resettava crossOp.setValue(0) nel callback dell'animazione, ma
  // l'aggiornamento di curIdx (stato React) arrivava 1-2 frame DOPO il
  // reset → per quei frame tornava visibile la palette vecchia = flash.
  // Ora: 4 cerchi SEMPRE montati, un solo Animated.Value `prog` che corre
  // 0→4 in loop lineare; l'opacity di ogni cerchio è un'interpolazione
  // triangolare ciclica. Nessun reset, nessun set-state nel loop = nessuno
  // stacco possibile, per costruzione.
  const prog = useRef(new Animated.Value(0)).current;

  const segmentMs = Math.max(2200, Math.floor(duration / PALETTES.length));

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

  // === Loop continuo del progresso palette (0 → 4, ciclico) ===
  // Al wrap 4→0 le opacity sono identiche per costruzione (ciclo chiuso),
  // quindi il riavvio del loop è invisibile.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(prog, {
        toValue: PALETTES.length,
        duration: segmentMs * PALETTES.length,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [prog, segmentMs]);

  // Opacity triangolare ciclica per il cerchio k: picco 1 quando prog === k,
  // scende a 0 verso i vicini. Il cerchio 0 ha anche il picco al wrap (=N)
  // così il riavvio del loop è otticamente invisibile.
  const N = PALETTES.length;
  const opacityFor = (k: number) => {
    if (k === 0) {
      return prog.interpolate({
        inputRange: [0, 1, N - 1, N],
        outputRange: [1, 0, 0, 1],
      });
    }
    const inputRange: number[] = [];
    const outputRange: number[] = [];
    if (k - 1 > 0) {
      inputRange.push(0);
      outputRange.push(0);
    }
    inputRange.push(k - 1, k);
    outputRange.push(0, 1);
    if (k + 1 < N) {
      inputRange.push(k + 1, N);
      outputRange.push(0, 0);
    } else {
      inputRange.push(N);
      outputRange.push(0);
    }
    return prog.interpolate({ inputRange, outputRange });
  };

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

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerWrap}>
          {/* Eclissi: 4 cerchi sempre montati, opacity ciclica continua —
              cross-fade perpetuo senza reset = zero stacchi di colore. */}
          <Animated.View
            style={{
              opacity: orbFade,
              marginBottom: 40,
              width: orbSize,
              height: orbSize,
            }}
          >
            {PALETTES.map((p, k) => (
              <Animated.View
                key={p[1]}
                style={[StyleSheet.absoluteFill, { opacity: opacityFor(k) }]}
              >
                <OrbCircle palette={p} size={orbSize} />
              </Animated.View>
            ))}
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
