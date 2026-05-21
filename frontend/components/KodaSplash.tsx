/**
 * KodaSplash — splash screen evocativo all'apertura dell'app.
 *
 * Versione 2 — niente pulse/scale, solo CROSS-FADE FLUIDO tra colori.
 *
 * Scopo:
 *  - mascherare la latenza di boot (~3-5s prima che il primo TTS sia pronto)
 *  - dare un'identità visiva forte all'app fin dal primo secondo
 *
 * Design:
 *  - sfondo nero profondo (#06060A) come tutta l'app
 *  - eclissi grande e STATICA al centro (cerchio con radial gradient).
 *    Niente respiro, niente pulse. Solo i COLORI cambiano molto fluidamente
 *    facendo cross-fade tra 4 palette (viola → blu petrolio → ciclamino → rosa).
 *  - nome AI personalizzato (`aiName` dal profilo) o "Koda" come default,
 *    fade-in dolce sotto l'eclissi
 *  - sottotitolo "L'Amico Fraterno" piccolo, tenue, sotto il nome
 *  - fade-out finale di tutto verso la home
 */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Pressable, Dimensions, Platform } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";

const AnimatedStop = Animated.createAnimatedComponent(Stop);

interface Props {
  aiName?: string | null;
  /** Durata totale in ms. Default 10000. */
  duration?: number;
  onComplete: () => void;
}

// 4 palette identitarie, percorse in loop con cross-fade fluido.
const PALETTES: Array<[string, string, string]> = [
  ["#C4B5FD", "#8B5CF6", "#7C3AED"], // viola/lavanda (idle)
  ["#5EEAD4", "#0E7C7B", "#134E4A"], // blu petrolio (recording)
  ["#F9A8D4", "#EC4899", "#BE185D"], // ciclamino (thinking)
  ["#FBCFE8", "#F472B6", "#DB2777"], // rosa caldo (speaking warm)
];

export default function KodaSplash({ aiName, duration = 10000, onComplete }: Props) {
  const { width, height } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.7, 280);

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const nameFade = useRef(new Animated.Value(0)).current;
  const subFade = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  // Indice della palette attuale e successiva. Il cross-fade animato fa
  // transizionare da "current" a "next" in modo fluido.
  const [paletteIdx, setPaletteIdx] = useState(0);
  // Animated value 0..1 che pilota la transizione tra paletteIdx e paletteIdx+1.
  const crossfade = useRef(new Animated.Value(0)).current;

  // Calcolo quanti cicli di palette stanno nel `duration`. Ogni segmento dura
  // duration / PALETTES.length così copriamo tutto il tempo dello splash.
  // Esempio: 10000ms / 4 palette = 2500ms per segmento.
  const segmentMs = Math.max(1500, Math.floor(duration / PALETTES.length));
  // Tempo di cross-fade vero e proprio (deve essere ≤ segmentMs per essere fluido)
  const fadeMs = Math.floor(segmentMs * 0.85);

  // === Fade-in iniziale di tutti gli elementi ===
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
    Animated.timing(subFade, {
      toValue: 1,
      duration: 900,
      delay: 1800,
      useNativeDriver: true,
    }).start();
  }, [fade, orbFade, nameFade, subFade]);

  // === Loop cross-fade tra palette consecutive ===
  useEffect(() => {
    let alive = true;
    let timer: any = null;

    const step = () => {
      if (!alive) return;
      // Animo crossfade 0→1 in fadeMs ms
      crossfade.setValue(0);
      Animated.timing(crossfade, {
        toValue: 1,
        duration: fadeMs,
        // Per Stop colors di SVG NON possiamo usare native driver
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (!alive || !finished) return;
        // Avanza all'indice successivo e riparte
        setPaletteIdx((i) => (i + 1) % PALETTES.length);
      });
      // Schedula prossimo step dopo segmentMs (anche se la palette è in fade)
      timer = setTimeout(step, segmentMs);
    };
    step();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [crossfade, fadeMs, segmentMs]);

  // === Fade-out finale + onComplete ===
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

  // Colori della palette attuale e successiva
  const cur = PALETTES[paletteIdx];
  const nxt = PALETTES[(paletteIdx + 1) % PALETTES.length];

  // Interpolo OGNI stop tra cur e nxt, ottenendo cross-fade fluido del cerchio
  const c0 = crossfade.interpolate({ inputRange: [0, 1], outputRange: [cur[0], nxt[0]] });
  const c1 = crossfade.interpolate({ inputRange: [0, 1], outputRange: [cur[1], nxt[1]] });
  const c2 = crossfade.interpolate({ inputRange: [0, 1], outputRange: [cur[2], nxt[2]] });

  const displayName = (aiName?.trim() || "Koda").trim();
  const r = orbSize / 2;

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerWrap}>
          {/* Eclissi STATICA — solo i colori del radial gradient cambiano fluidamente */}
          <Animated.View style={{ opacity: orbFade, marginBottom: 36, width: orbSize, height: orbSize }}>
            <Svg width={orbSize} height={orbSize}>
              <Defs>
                <RadialGradient id="splashGrad" cx="50%" cy="50%" r="50%" fx="38%" fy="38%">
                  <AnimatedStop offset="0%" stopColor={c0 as any} stopOpacity={1} />
                  <AnimatedStop offset="55%" stopColor={c1 as any} stopOpacity={0.85} />
                  <AnimatedStop offset="100%" stopColor={c2 as any} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx={r} cy={r} r={r * 0.95} fill="url(#splashGrad)" />
            </Svg>
          </Animated.View>

          <Animated.Text style={[styles.name, { opacity: nameFade }]}>
            {displayName}
          </Animated.Text>

          <Animated.Text style={[styles.subtitle, { opacity: subFade }]}>
            L'Amico Fraterno
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
    fontSize: 40,
    fontWeight: "300",
    letterSpacing: 5,
    textAlign: "center",
    textShadowColor: "rgba(244,114,182,0.4)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
  },
  subtitle: {
    color: "#A78BFA",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 5,
    marginTop: 18,
    textTransform: "uppercase",
    opacity: 0.65,
  },
});
