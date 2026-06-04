/**
 * FortezzaCloseEffect — "Doppio fronte di fiamma" 2026-06.
 *
 * Versione 3: l'utente ha chiesto che entrambi i lati (alto e basso)
 * brucino, e che la fiamma sembri davvero una fiamma (non una scarica
 * elettrica). Tre layer di fuoco per ciascun fronte: glow esteso,
 * fiamma centrale calda, scintille brillanti. Tra i due fronti, il
 * contenuto della chat resta visibile e si restringe finché si chiude.
 *
 * Fasi:
 *  1. (0-1800ms)   due fronti di fiamma si avvicinano al centro
 *                  - bottom: parte dal basso sale verso il centro
 *                  - top:    parte dall'alto scende verso il centro
 *                  - dietro ogni fronte: lenzuolo nero "bruciato"
 *  2. (1800-2400ms) i fronti si incontrano, schermo totalmente nero
 *  3. (1900-2900ms) appare sigillo 🔒 + conferma "Dato grezzo cancellato"
 *  4. (3000-3500ms) fade out → onComplete
 */

import React, { useEffect } from "react";
import { View, Text, StyleSheet, Dimensions, Platform } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withTiming,
  withDelay,
  withRepeat,
  withSequence,
  Easing,
  runOnJS,
  interpolate,
  SharedValue,
} from "react-native-reanimated";
import Svg, { Path, Defs, LinearGradient, Stop, Circle } from "react-native-svg";
import * as Haptics from "expo-haptics";

const AnimatedPath = Animated.createAnimatedComponent(Path);

type Props = {
  visible: boolean;
  onComplete?: () => void;
  labels?: {
    sealed?: string;
    confirmation?: string;
  };
};

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const DEFAULT_LABELS = {
  sealed: "🔒 Sigillato. Resta tra te e te.",
  confirmation: "Dato grezzo cancellato per sempre.",
};

const BURN_DURATION = 1800;
const SEAL_APPEAR_AT = 1900;
const CONFIRM_APPEAR_AT = 2400;
const TOTAL_DURATION = 3500;

// Geometria del fronte di fuoco
const FLAME_HEIGHT = 90; // altezza del "muro di fuoco" (più alto = più fluffy)
const WAVE_POINTS = 24;

function fireHaptic(type: "light" | "medium" | "heavy") {
  if (Platform.OS === "web") return;
  try {
    if (type === "light") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  } catch {}
}

/**
 * Genera la "silhouette" superiore di un muro di fuoco — irregolare,
 * con picchi e valli che simulano lingue di fiamma. La path forma un
 * poligono chiuso che va da sinistra → su → destra → giù → chiudi.
 *
 * Direction: "up" = punte verso l'alto (per fronte che sale dal basso)
 *            "down" = punte verso il basso (per fronte che scende dall'alto)
 *
 * seed serve a generare path diverse tra i layer della fiamma.
 */
function generateFlameSilhouette(
  direction: "up" | "down",
  amplitudeMul: number = 1,
  seed: number = 0
): string {
  const step = SCREEN_W / WAVE_POINTS;
  const sign = direction === "up" ? -1 : 1;
  const baseY = direction === "up" ? FLAME_HEIGHT : 0;
  // punto di partenza in basso-sinistra (per "up") o alto-sinistra (per "down")
  const closeY = direction === "up" ? FLAME_HEIGHT : 0;
  const farY = direction === "up" ? 0 : FLAME_HEIGHT;

  let d = `M -20,${closeY} L -20,${baseY}`;
  for (let i = 0; i <= WAVE_POINTS; i++) {
    const x = i * step;
    // Generiamo una silhouette tipo fiamma usando combinazione di sin
    const peak =
      Math.sin(i * 0.55 + seed) * 0.55 +
      Math.sin(i * 1.7 + seed * 2) * 0.3 +
      Math.cos(i * 0.3 + seed * 3) * 0.15;
    // peak è in -1..1, lo mappiamo su 0..FLAME_HEIGHT
    const flameTip = (peak + 1) * 0.5; // 0..1
    const y =
      direction === "up"
        ? FLAME_HEIGHT - flameTip * FLAME_HEIGHT * amplitudeMul
        : flameTip * FLAME_HEIGHT * amplitudeMul;
    d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  d += ` L${SCREEN_W + 20},${baseY} L${SCREEN_W + 20},${closeY} Z`;
  return d;
}

// Path statiche, generate una volta sola
const FLAME_BOTTOM_OUTER = generateFlameSilhouette("up", 1.0, 0);
const FLAME_BOTTOM_MID = generateFlameSilhouette("up", 0.75, 7);
const FLAME_BOTTOM_CORE = generateFlameSilhouette("up", 0.45, 13);

const FLAME_TOP_OUTER = generateFlameSilhouette("down", 1.0, 21);
const FLAME_TOP_MID = generateFlameSilhouette("down", 0.75, 29);
const FLAME_TOP_CORE = generateFlameSilhouette("down", 0.45, 37);

/**
 * Componente: il singolo "muro di fuoco" (sopra o sotto).
 * Si posiziona absolute e si traduce verticalmente.
 *
 * 2026-06 #5: aggiunti FLICKER ANIMATION e SPARKS per dare vita reale
 * alla fiamma. Le 3 layer (outer/mid/core) ora ognuna pulsa con
 * frequenza e ampiezza diversa (sinusoidale + lieve sfasamento) creando
 * l'illusione del fuoco che si agita. Sparks: 5 piccoli punti luminosi
 * che salgono e svaniscono di continuo.
 */
function FlameFront({
  direction,
  progress,
}: {
  direction: "bottom" | "top";
  // shared value 0..1 (0 = fuori schermo, 1 = al centro)
  progress: SharedValue<number>;
}) {
  const dir = direction === "bottom" ? "up" : "down";

  // === FLICKER SHARED VALUES (richiesta utente 2026-06 #5) ===
  // Tre layer indipendenti che pulsano in scaleY + opacity con frequenze
  // diverse. Risultato visivo: la fiamma sembra davvero "viva" anziché
  // un blocco statico che si traduce verticalmente.
  const flickerOuter = useSharedValue(0);
  const flickerMid = useSharedValue(0);
  const flickerCore = useSharedValue(0);

  useEffect(() => {
    // Outer: pulsa lento e ampio (la "fluffiness" esterna)
    flickerOuter.value = withRepeat(
      withTiming(1, { duration: 380, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
    // Mid: pulsa medio-rapido (la massa principale)
    flickerMid.value = withRepeat(
      withTiming(1, { duration: 220, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
    // Core: pulsa rapidissimo (il cuore della fiamma scintilla)
    flickerCore.value = withRepeat(
      withTiming(1, { duration: 140, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outerStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 0.92 + flickerOuter.value * 0.16 }],
    opacity: 0.48 + flickerOuter.value * 0.14,
  }));
  const midStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 0.88 + flickerMid.value * 0.22 }],
    opacity: 0.78 + flickerMid.value * 0.18,
  }));
  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 0.85 + flickerCore.value * 0.28 }],
    opacity: 0.82 + flickerCore.value * 0.18,
  }));

  const wrapStyle = useAnimatedStyle(() => {
    // Per la fiamma "bottom": parte dal basso e sale.
    // Quando progress=0 → la base della fiamma è a SCREEN_H (fuori schermo basso)
    // Quando progress=1 → la base è al centro (SCREEN_H/2)
    if (direction === "bottom") {
      const baseY = SCREEN_H - SCREEN_H * 0.5 * progress.value;
      return {
        top: baseY - FLAME_HEIGHT,
        opacity: interpolate(progress.value, [0, 0.05, 0.95, 1], [0, 1, 1, 0.85]),
      };
    } else {
      // top: parte da -FLAME_HEIGHT (fuori dall'alto) e scende verso SCREEN_H/2 - FLAME_HEIGHT
      const baseY = -FLAME_HEIGHT + SCREEN_H * 0.5 * progress.value;
      return {
        top: baseY,
        opacity: interpolate(progress.value, [0, 0.05, 0.95, 1], [0, 1, 1, 0.85]),
      };
    }
  });

  // Path da renderizzare in base alla direzione
  const outerPath = dir === "up" ? FLAME_BOTTOM_OUTER : FLAME_TOP_OUTER;
  const midPath = dir === "up" ? FLAME_BOTTOM_MID : FLAME_TOP_MID;
  const corePath = dir === "up" ? FLAME_BOTTOM_CORE : FLAME_TOP_CORE;
  const gradientId = direction === "bottom" ? "flameGradBot" : "flameGradTop";

  // Origine del transform scaleY: la base della fiamma (così le punte si
  // allungano/accorciano verso l'alto/basso senza traslare la base).
  const originStyle = dir === "up"
    ? { transformOrigin: "50% 100%" as any }
    : { transformOrigin: "50% 0%" as any };

  return (
    <Animated.View style={[styles.flameWrap, wrapStyle]} pointerEvents="none">
      <Svg
        width={SCREEN_W + 40}
        height={FLAME_HEIGHT}
        viewBox={`-20 0 ${SCREEN_W + 40} ${FLAME_HEIGHT}`}
        style={{ position: "absolute", left: -20 }}
      >
        <Defs>
          <LinearGradient
            id={gradientId}
            x1="0"
            y1={dir === "up" ? FLAME_HEIGHT : 0}
            x2="0"
            y2={dir === "up" ? 0 : FLAME_HEIGHT}
          >
            <Stop offset="0" stopColor="#7A0E00" stopOpacity={1} />
            <Stop offset="0.4" stopColor="#FF4500" stopOpacity={1} />
            <Stop offset="0.7" stopColor="#FFA500" stopOpacity={1} />
            <Stop offset="1" stopColor="#FFE066" stopOpacity={1} />
          </LinearGradient>
        </Defs>
      </Svg>
      {/* Layer outer con flicker indipendente */}
      <Animated.View style={[StyleSheet.absoluteFill, originStyle, outerStyle]} pointerEvents="none">
        <Svg
          width={SCREEN_W + 40}
          height={FLAME_HEIGHT}
          viewBox={`-20 0 ${SCREEN_W + 40} ${FLAME_HEIGHT}`}
          style={{ position: "absolute", left: -20 }}
        >
          <Path d={outerPath} fill={`url(#${gradientId})`} />
        </Svg>
      </Animated.View>
      {/* Layer mid */}
      <Animated.View style={[StyleSheet.absoluteFill, originStyle, midStyle]} pointerEvents="none">
        <Svg
          width={SCREEN_W + 40}
          height={FLAME_HEIGHT}
          viewBox={`-20 0 ${SCREEN_W + 40} ${FLAME_HEIGHT}`}
          style={{ position: "absolute", left: -20 }}
        >
          <Path d={midPath} fill="#FF6B1A" />
        </Svg>
      </Animated.View>
      {/* Layer core: il cuore brillante */}
      <Animated.View style={[StyleSheet.absoluteFill, originStyle, coreStyle]} pointerEvents="none">
        <Svg
          width={SCREEN_W + 40}
          height={FLAME_HEIGHT}
          viewBox={`-20 0 ${SCREEN_W + 40} ${FLAME_HEIGHT}`}
          style={{ position: "absolute", left: -20 }}
        >
          <Path d={corePath} fill="#FFE066" />
        </Svg>
      </Animated.View>
      {/* SPARKS — 6 piccoli punti che salgono e svaniscono */}
      <Sparks direction={direction} />
      {/* Glow esteso sotto la base (dove la fiamma "esce" dal nero) */}
      <View
        style={[
          styles.flameGlow,
          direction === "bottom"
            ? { bottom: -8 }
            : { top: -8 },
        ]}
      />
    </Animated.View>
  );
}

/**
 * Sparks: piccoli punti luminosi che salgono dalla cresta della fiamma
 * e svaniscono. Per il fronte bottom salgono verso l'alto; per il fronte
 * top "cadono" verso il basso (effetto specchio).
 */
function Sparks({ direction }: { direction: "bottom" | "top" }) {
  const SPARK_COUNT = 6;
  const sparks = React.useMemo(() => {
    return new Array(SPARK_COUNT).fill(0).map((_, i) => ({
      x: 30 + (i * SCREEN_W) / SPARK_COUNT + Math.random() * 40,
      delay: i * 130 + Math.random() * 200,
      duration: 700 + Math.random() * 400,
      size: 1.5 + Math.random() * 2.5,
    }));
  }, []);
  return (
    <>
      {sparks.map((s, i) => (
        <Spark key={i} {...s} direction={direction} />
      ))}
    </>
  );
}

function Spark({
  x,
  delay,
  duration,
  size,
  direction,
}: {
  x: number;
  delay: number;
  duration: number;
  size: number;
  direction: "bottom" | "top";
}) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withRepeat(
      withSequence(
        withDelay(delay, withTiming(1, { duration, easing: Easing.out(Easing.quad) })),
        withTiming(0, { duration: 0 })
      ),
      -1,
      false
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const animStyle = useAnimatedStyle(() => {
    const travel = 50; // px che lo spark percorre verticalmente
    const dy = direction === "bottom" ? -travel * p.value : travel * p.value;
    const opacity = interpolate(p.value, [0, 0.15, 1], [0, 1, 0]);
    return {
      transform: [{ translateY: dy }],
      opacity,
    };
  });
  const startY = direction === "bottom" ? 0 : FLAME_HEIGHT;
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: x,
          top: startY - size,
          width: size * 2,
          height: size * 2,
          borderRadius: size,
          backgroundColor: "#FFE8A8",
          shadowColor: "#FFB347",
          shadowOpacity: 0.9,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 0 },
        },
        animStyle,
      ]}
      pointerEvents="none"
    />
  );
}

export default function FortezzaCloseEffect({ visible, onComplete, labels }: Props) {
  const L = { ...DEFAULT_LABELS, ...(labels || {}) };

  const containerOpacity = useSharedValue(0);
  const burnProgress = useSharedValue(0);   // 0..1 — quanto si è avvicinato il fuoco al centro
  const blackoutOpacity = useSharedValue(0); // 0..1 — nero finale che copre tutto
  const sealOpacity = useSharedValue(0);
  const sealScale = useSharedValue(0.5);
  const confirmOpacity = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      containerOpacity.value = 0;
      burnProgress.value = 0;
      blackoutOpacity.value = 0;
      sealOpacity.value = 0;
      sealScale.value = 0.5;
      confirmOpacity.value = 0;
      return;
    }

    fireHaptic("light");

    // FASE 1: i due fronti di fuoco si avvicinano al centro in 1800ms
    containerOpacity.value = withSequence(
      withTiming(1, { duration: 200 }),
      withDelay(
        TOTAL_DURATION - 200 - 600,
        withTiming(0, { duration: 600 }, (finished) => {
          if (finished && onComplete) {
            runOnJS(onComplete)();
          }
        })
      )
    );
    burnProgress.value = withTiming(1, {
      duration: BURN_DURATION,
      easing: Easing.inOut(Easing.cubic),
    });

    // FASE 2: blackout (i due fronti si incontrano)
    blackoutOpacity.value = withDelay(
      BURN_DURATION - 100,
      withTiming(1, { duration: 350 })
    );

    // FASE 3: sigillo
    const t1 = setTimeout(() => fireHaptic("medium"), SEAL_APPEAR_AT);
    sealOpacity.value = withDelay(SEAL_APPEAR_AT, withTiming(1, { duration: 350 }));
    sealScale.value = withDelay(
      SEAL_APPEAR_AT,
      withSequence(
        withTiming(1.15, { duration: 280, easing: Easing.out(Easing.back(2)) }),
        withTiming(1, { duration: 180 })
      )
    );

    // FASE 4: conferma
    const t2 = setTimeout(() => fireHaptic("heavy"), CONFIRM_APPEAR_AT);
    confirmOpacity.value = withDelay(
      CONFIRM_APPEAR_AT,
      withTiming(1, { duration: 400 })
    );

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Stili
  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));
  // Lenzuolo nero che cresce dal basso (dietro la fiamma bottom)
  const ashBottomStyle = useAnimatedStyle(() => {
    const h = SCREEN_H * 0.5 * burnProgress.value;
    return { height: h };
  });
  // Lenzuolo nero che cresce dall'alto (dietro la fiamma top)
  const ashTopStyle = useAnimatedStyle(() => {
    const h = SCREEN_H * 0.5 * burnProgress.value;
    return { height: h };
  });
  const blackoutStyle = useAnimatedStyle(() => ({
    opacity: blackoutOpacity.value,
  }));
  const sealStyle = useAnimatedStyle(() => ({
    opacity: sealOpacity.value,
    transform: [{ scale: sealScale.value }],
  }));
  const confirmStyle = useAnimatedStyle(() => ({ opacity: confirmOpacity.value }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.container, containerStyle]}
      pointerEvents="none"
    >
      {/* Lenzuolo nero dall'alto */}
      <Animated.View style={[styles.ashTop, ashTopStyle]} />
      {/* Lenzuolo nero dal basso */}
      <Animated.View style={[styles.ashBottom, ashBottomStyle]} />

      {/* Fronti di fuoco */}
      <FlameFront direction="top" progress={burnProgress} />
      <FlameFront direction="bottom" progress={burnProgress} />

      {/* Blackout finale che copre tutto quando i fronti si incontrano */}
      <Animated.View style={[styles.blackout, blackoutStyle]} />

      {/* Sigillo */}
      <Animated.View style={[styles.sealContainer, sealStyle]} pointerEvents="none">
        <Text style={styles.sealIcon}>🔒</Text>
        <Text style={styles.sealText}>{L.sealed}</Text>
      </Animated.View>

      {/* Conferma */}
      <Animated.View style={[styles.confirmContainer, confirmStyle]} pointerEvents="none">
        <Text style={styles.confirmText}>{L.confirmation}</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    overflow: "hidden",
  },
  // Lenzuolo nero dall'alto
  ashTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "#0A0A0A",
  },
  // Lenzuolo nero dal basso
  ashBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#0A0A0A",
  },
  // Wrapper di un fronte di fuoco (la posizione viene animata)
  flameWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    height: FLAME_HEIGHT,
  },
  // Glow esteso sotto/sopra il fronte (per dare "calore" all'aria circostante)
  flameGlow: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 30,
    backgroundColor: "#FF6B1A",
    opacity: 0.18,
    shadowColor: "#FF8C00",
    shadowOpacity: 1,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  // Blackout totale finale (sopra fiamme + nero)
  blackout: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000000",
  },
  // Sigillo
  sealContainer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  sealIcon: {
    fontSize: 72,
    marginBottom: 18,
    textShadowColor: "#FF6B35",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  sealText: {
    color: "#FFE4B5",
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 40,
    textShadowColor: "rgba(255, 107, 53, 0.55)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  confirmContainer: {
    position: "absolute",
    bottom: SCREEN_H * 0.18,
    left: 0,
    right: 0,
    paddingHorizontal: 32,
    alignItems: "center",
  },
  confirmText: {
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 14,
    textAlign: "center",
    fontStyle: "italic",
  },
});
