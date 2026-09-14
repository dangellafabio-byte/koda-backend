/**
 * OllenyaSplash (già OllenyaSplash) — splash screen all'apertura dell'app.
 *
 * === v65.39 REBRAND (Fabio 2026-06) ======================================
 *
 * Fabio ha ribrandizzato l'app da "Ollenya" a "Ollenya" perché "Ollenya" era già
 * usato da altri prodotti. Il file mantiene il nome legacy `OllenyaSplash.tsx`
 * per non richiedere refactor import esteso (rename fisico in fase 2).
 *
 * Splash aggiornato:
 *   1. Wordmark "Ollenya" (sostituisce "Ollenya") con MINI-ECLISSI al posto
 *      della prima "O" iniziale — mantiene il pattern iconico del logo.
 *   2. Glow monocolore CHAMPAGNE (stesso hex dell'idle NeonBorder:
 *      #F5E6CC / #D4B896 / #8B6F4E) — signature calda unica, no ciclo 4 colori.
 *   3. Pulse morbido: l'alone respira su/giù in opacity per dare vita
 *      senza cambiare tinta.
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
} from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";

interface Props {
  aiName?: string | null;
  duration?: number;
  onComplete: () => void;
}

// === PALETTE CHAMPAGNE (monocolore) ======================================
// Riuso ESATTO della palette "neutral" dell'EclipseOrb (idle NeonBorder),
// così il splash e lo stato idle dell'app condividono la stessa firma di
// colore → coerenza identitaria.
//   [alone chiaro, tinta media, tinta scura]
const CHAMPAGNE: [string, string, string] = ["#F5E6CC", "#D4B896", "#8B6F4E"];

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

export default function OllenyaSplash({ aiName, duration = 10000, onComplete }: Props) {
  const { width } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.78, 340);
  const miniOrbSize = 38;

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const textFade = useRef(new Animated.Value(0)).current;
  // Pulse: opacity che respira 0.75 ↔ 1.0 in loop (2s andata, 2s ritorno)
  const pulse = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  // === Fade-in iniziale ===
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    Animated.timing(orbFade, {
      toValue: 1,
      duration: 1200,
      delay: 100,
      useNativeDriver: true,
    }).start();
    Animated.timing(textFade, {
      toValue: 1,
      duration: 900,
      delay: 900,
      useNativeDriver: true,
    }).start();
  }, [fade, orbFade, textFade]);

  // === Pulse: respiro morbido dell'alone ===
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  // Opacity dell'alone (pulse): oscilla 0.72 ↔ 1.0
  const orbPulseOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.72, 1],
  });

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

  // === Nome AI: fallback al nome brand "Ollenya" se non impostato =========
  const rawName = (aiName?.trim() || "Ollenya").trim();
  // Split wordmark: cerca la PRIMA "o" case-insensitive.
  // Per "Ollenya" → prefix="", suffix="llenya" → la mini-eclissi va PRIMA
  // e il suffisso "llenya" dopo. Wordmark: [🌑]llenya
  const oIdx = rawName.toLowerCase().indexOf("o");
  const hasO = oIdx >= 0;
  const prefix = hasO ? rawName.slice(0, oIdx) : rawName;
  const suffix = hasO ? rawName.slice(oIdx + 1) : "";

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerCol}>
          {/* === ECLISSI GRANDE — champagne monocolore con pulse ==========
              Nessun ciclo di tinte: la firma è UNA — il champagne caldo
              #D4B896 (stesso hex del NeonBorder idle). Vive di respiro,
              non di cambio colore. */}
          <Animated.View
            style={{
              opacity: Animated.multiply(orbFade, orbPulseOpacity),
              width: orbSize,
              height: orbSize,
              marginBottom: 48,
            }}
          >
            <OrbCircle palette={CHAMPAGNE} size={orbSize} discRatio={0.58} />
          </Animated.View>

          {/* === WORDMARK "Ollenya" con MINI-ECLISSI al posto della "O" ===
              Row: <mini-eclissi 38px> + "llenya"
              La mini-eclissi ha lo stesso pulse dell'orb grande. */}
          <Animated.View style={[styles.wordmarkRow, { opacity: textFade }]}>
            {/* Glow layer champagne dietro (esteso, allargato) */}
            <Text style={[styles.name, styles.nameGlow]} allowFontScaling={false}>
              {rawName}
            </Text>
            {/* Prefix (per "Ollenya" è vuoto — o iniziale) */}
            {prefix.length > 0 ? (
              <Text style={[styles.name, styles.nameTop]} allowFontScaling={false}>
                {prefix}
              </Text>
            ) : null}
            {hasO ? (
              <Animated.View
                style={[
                  styles.miniOrbWrap,
                  { opacity: orbPulseOpacity },
                ]}
              >
                <OrbCircle palette={CHAMPAGNE} size={miniOrbSize} discRatio={0.78} />
              </Animated.View>
            ) : null}
            <Text style={[styles.name, styles.nameTop]} allowFontScaling={false}>
              {suffix}
            </Text>
          </Animated.View>

          {/* === SOTTOTITOLO ============================================= */}
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
    marginBottom: 14,
  },
  name: {
    color: "#F5E9DA", // bianco-crema caldo, matcha champagne
    fontSize: 62,
    fontWeight: "800",
    letterSpacing: 1,
    textAlign: "center",
    includeFontPadding: false,
  },
  nameGlow: {
    position: "absolute",
    color: "rgba(212,184,150,0.28)",
    textShadowColor: "rgba(212,184,150,0.9)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 26,
    left: 0,
    right: 0,
    textAlign: "center",
  },
  nameTop: {
    textShadowColor: "rgba(212,184,150,0.55)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  miniOrbWrap: {
    width: 38,
    height: 38,
    marginHorizontal: 1,
  },
  tagline: {
    color: "rgba(230,215,190,0.7)",
    fontSize: 17,
    letterSpacing: 3,
    fontWeight: "400",
    textAlign: "center",
  },
});
