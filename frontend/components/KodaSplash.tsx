/**
 * KodaSplash — splash screen evocativo all'apertura dell'app.
 *
 * === RESTORE v65.35 (Fabio 2026-06 fix) ==================================
 * L'agente precedente aveva salvato per errore uno screenshot della chat
 * come asset splash (splash_koda_eclipse.webp). Rimosso. Il splash torna
 * ad essere composto interamente da elementi nativi (SVG + Text), così:
 *  1. Zero asset immagine → nessun rischio di regressione da asset sbagliato
 *  2. Il glow attorno all'eclissi cambia colore ciclicamente (4 palette
 *     cross-fade viola → petrolio → ciclamino → rosa) come voluto
 *  3. Testi "Koda / SEMPRE CON TE / ASCOLTA • PARLA • SENTITI MEGLIO" +
 *     curva orizzonte, progress bar e footer "QUALCOSA DI BELLO TI ASPETTA"
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
import Svg, { Defs, RadialGradient, Stop, Circle, Path } from "react-native-svg";

interface Props {
  aiName?: string | null;
  duration?: number;
  onComplete: () => void;
}

// 4 palette identitarie, percorse in loop con cross-fade fluido.
// [alone luminoso, tinta media, tinta scura] per RadialGradient dell'eclissi.
const PALETTES: [string, string, string][] = [
  ["#C4B5FD", "#8B5CF6", "#7C3AED"], // viola/lavanda (default)
  ["#A78BFA", "#7C3AED", "#5B21B6"], // viola profondo
  ["#F9A8D4", "#EC4899", "#BE185D"], // ciclamino
  ["#FBCFE8", "#F472B6", "#DB2777"], // rosa caldo
];

// Sub-component: cerchio con gradient di una sola palette, statico.
// Renderizza l'ECLISSI completa:
//  1) alone esterno (radial gradient palette) — la corona luminosa
//  2) disco nero centrale (il "buco" dell'eclissi)
//  3) rim light (anello sottile di luce sul bordo del disco)
function OrbCircle({ palette, size }: { palette: [string, string, string]; size: number }) {
  const r = size / 2;
  const gradId = `g_${palette[0].slice(1)}_${palette[1].slice(1)}`;
  // Disco nero centrale al 52% del raggio totale → eclissi "ad anello"
  // con corona luminosa più larga (come nel reference di Fabio).
  const discR = r * 0.52;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={gradId} cx="50%" cy="50%" r="50%" fx="42%" fy="42%">
          <Stop offset="0%" stopColor={palette[0]} stopOpacity={1} />
          <Stop offset="52%" stopColor={palette[1]} stopOpacity={0.95} />
          <Stop offset="100%" stopColor={palette[2]} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* 1) Alone luminoso esterno — la CORONA dell'eclissi */}
      <Circle cx={r} cy={r} r={r * 0.95} fill={`url(#${gradId})`} />
      {/* 2) Disco nero centrale — il vero "buco" dell'eclissi */}
      <Circle cx={r} cy={r} r={discR} fill="#06060A" />
      {/* 3) Rim light — anello sottile luminoso attorno al disco */}
      <Circle
        cx={r}
        cy={r}
        r={discR}
        fill="none"
        stroke={palette[0]}
        strokeWidth={2}
        opacity={0.9}
      />
    </Svg>
  );
}

export default function KodaSplash({ aiName, duration = 10000, onComplete }: Props) {
  const { width, height } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.85, 380);

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const textFade = useRef(new Animated.Value(0)).current;
  const barProgress = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  // === CROSS-FADE CONTINUO v4 (fix "stacco tra colore e colore") ===
  // 4 cerchi SEMPRE montati, un solo Animated.Value `prog` che corre
  // 0→4 in loop lineare; l'opacity di ogni cerchio è un'interpolazione
  // triangolare ciclica. Nessun reset, nessun set-state nel loop = nessuno
  // stacco possibile, per costruzione.
  const prog = useRef(new Animated.Value(0)).current;

  const segmentMs = Math.max(2200, Math.floor(duration / PALETTES.length));

  // === Fade-in scaglionato ===
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
    // Progress bar: si riempie in `duration` totale (linear)
    Animated.timing(barProgress, {
      toValue: 1,
      duration,
      easing: Easing.linear,
      useNativeDriver: false, // width animation
    }).start();
  }, [fade, orbFade, textFade, barProgress, duration]);

  // === Loop continuo del progresso palette (0 → 4, ciclico) ===
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

  // Progress bar width: 0% → 100% in `duration` ms
  const barWidthPct = barProgress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        {/* === ECLISSI centrale — 4 cerchi cross-fade continuo ================
            La corona luminosa cambia tinta in loop tra 4 palette senza mai
            avere un frame di stacco (opacità triangolari cicliche). Il disco
            nero centrale è disegnato dentro OrbCircle stesso. */}
        <View style={[styles.orbWrap, { top: height * 0.14 }]}>
          <Animated.View
            style={{
              opacity: orbFade,
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
        </View>

        {/* === TESTO CENTRALE — WORDMARK Koda iconico ====================
            3 layer sovrapposti + swash SVG sotto per identità distintiva:
              L1  outer glow (rosa, blur forte)
              L2  mid glow (lavanda)
              L3  testo principale (serif italic)
              L4  swash SVG (curva sottile sotto il wordmark)
            Font: Baskerville su iOS, serif su Android — entrambi hanno
            un carattere elegante e "editoriale" che si stacca dal system
            sans-serif della UI, rendendo il nome un logo. */}
        <Animated.View
          style={[
            styles.textBlock,
            { top: height * 0.14 + orbSize + 34, opacity: textFade },
          ]}
        >
          <View style={styles.nameWrap}>
            {/* L1 — outer rosa glow */}
            <Text style={[styles.name, styles.nameGlowOuter]} allowFontScaling={false}>
              {displayName}
            </Text>
            {/* L2 — mid lavanda glow */}
            <Text style={[styles.name, styles.nameGlowMid]} allowFontScaling={false}>
              {displayName}
            </Text>
            {/* L3 — testo principale (top) */}
            <Text style={[styles.name, styles.nameTop]} allowFontScaling={false}>
              {displayName}
            </Text>
            {/* L4 — swash curvo sotto il wordmark */}
            <Svg
              width={220}
              height={18}
              viewBox="0 0 220 18"
              style={styles.swash}
            >
              <Path
                d="M4 10 Q 60 2, 110 8 T 216 10"
                stroke="rgba(196,181,253,0.75)"
                strokeWidth={1.4}
                fill="none"
                strokeLinecap="round"
              />
            </Svg>
          </View>
          <Text style={styles.tagline}>SEMPRE CON TE</Text>
        </Animated.View>

        {/* === TRE VERBI ================================================== */}
        <Animated.View
          style={[
            styles.verbsBlock,
            { top: height * 0.14 + orbSize + 190, opacity: textFade },
          ]}
        >
          <Text style={styles.verb}>ASCOLTA</Text>
          <View style={styles.dotSep} />
          <Text style={styles.verb}>PARLA</Text>
          <View style={styles.dotSep} />
          <Text style={styles.verb}>SENTITI MEGLIO</Text>
        </Animated.View>

        {/* === CURVA ORIZZONTE + PROGRESS + FOOTER ======================== */}
        <View style={styles.bottomStack}>
          {/* Curva orizzonte glow: un'ellisse molto larga con bordo alto
              luminoso, tagliata dall'ovale della viewport. Effetto "pianeta". */}
          <View style={styles.horizonWrap}>
            <View style={styles.horizonGlow} />
          </View>

          {/* Progress bar minimale: 0→100% in `duration` ms */}
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: barWidthPct }]} />
          </View>

          {/* Footer wistful */}
          <Text style={styles.footerText}>QUALCOSA DI BELLO TI ASPETTA</Text>
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
  },
  // Contenitore assoluto dell'eclissi — centrata orizzontalmente,
  // posizione verticale calcolata rispetto all'altezza schermo.
  orbWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  textBlock: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    fontSize: 68,
    fontWeight: "700",
    letterSpacing: 2,
    textAlign: "center",
    // Font "editoriale" — Baskerville iOS / serif Android. Dà al wordmark
    // un carattere di logo (non "text system"), pur restando leggibile.
    fontFamily: Platform.select({
      ios: "Baskerville",
      android: "serif",
      default: "serif",
    }),
    fontStyle: "italic",
    includeFontPadding: false,
  },
  nameWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 14,
  },
  // Layer 1: outer glow rosa carico. textShadow molto largo, opacity bassa.
  nameGlowOuter: {
    position: "absolute",
    color: "rgba(244,114,182,0.55)",
    textShadowColor: "rgba(244,114,182,0.9)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 40,
  },
  // Layer 2: mid glow lavanda. Più definito, meno soft.
  nameGlowMid: {
    position: "absolute",
    color: "rgba(196,181,253,0.75)",
    textShadowColor: "rgba(196,181,253,0.9)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
  },
  // Layer 3: top layer nitido — bianco caldo con leggero shadow rosa.
  nameTop: {
    color: "#F8E9F3",
    textShadowColor: "rgba(244,114,182,0.5)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  // Swash SVG: curva sottile sotto il wordmark, richiama la curva orizzonte
  // in fondo. Piccolo segno grafico che rende il logo "firmato".
  swash: {
    position: "absolute",
    bottom: -2,
    alignSelf: "center",
  },
  tagline: {
    marginTop: 14,
    color: "rgba(245,230,240,0.75)",
    fontSize: 15,
    letterSpacing: 6,
    textAlign: "center",
    fontWeight: "500",
  },
  verbsBlock: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 12,
  },
  verb: {
    color: "rgba(230,215,235,0.85)",
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: "500",
  },
  dotSep: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(244,114,182,0.7)",
  },
  // Stack in fondo: curva + progress + footer
  bottomStack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 40,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  // Curva orizzonte: rettangolo con top border luminoso e forte
  // border-radius orizzontale → simula la curvatura del "pianeta".
  horizonWrap: {
    width: "150%",
    height: 80,
    overflow: "hidden",
    marginBottom: 30,
    alignItems: "center",
  },
  horizonGlow: {
    width: "100%",
    height: 200,
    borderRadius: 1000,
    borderTopWidth: 1.5,
    borderTopColor: "rgba(196,181,253,0.55)",
    // Alone soft della curva
    shadowColor: "#C4B5FD",
    shadowOpacity: 0.6,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: -20 },
  },
  progressTrack: {
    width: 140,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    marginBottom: 18,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "rgba(196,181,253,0.85)",
    borderRadius: 2,
  },
  footerText: {
    color: "rgba(230,215,235,0.7)",
    fontSize: 11,
    letterSpacing: 3,
    fontWeight: "500",
    textAlign: "center",
  },
});
