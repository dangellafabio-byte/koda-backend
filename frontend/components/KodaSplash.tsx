/**
 * KodaSplash — splash screen evocativo all'apertura dell'app.
 *
 * === v65.38 (Fabio 2026-06 fix Tiffany + wordmark iconico) ================
 *
 * Fix 1 — Tiffany ripristinato tra le 4 palette.
 *   La v65.37 aveva sostituito il Tiffany (#5EEAD4 blu petrolio) con un
 *   secondo viola. Ora il ciclo torna a: viola → Tiffany → ciclamino → rosa.
 *
 * Fix 2 — Plateau per ogni palette.
 *   opacityFor era triangolare: picco istantaneo poi calando subito → il
 *   colore era "visibile" solo per un attimo. Ora ogni palette ha:
 *     - 0.2 unità di fade-in
 *     - 0.6 unità di piena opacità (plateau)
 *     - 0.2 unità di fade-out
 *   Con duration 12s / 4 palette → 3s per colore → ~1.8s di piena visibilità.
 *
 * Fix 3 — Wordmark "Koda" con mini-eclissi al posto della prima "o".
 *   Compone "K" + <mini-eclissi SVG> + "da" in row. La mini-eclissi
 *   segue lo stesso ciclo di colori del grande orb → coerenza visiva.
 *
 * Fix 4 — Layout semplificato al reference di Fabio.
 *   Rimossi: verbi ASCOLTA/PARLA/SENTITI MEGLIO, curva orizzonte,
 *   progress bar, footer "QUALCOSA DI BELLO TI ASPETTA".
 *   Restano: eclissi grande, Koda wordmark, "Sempre con te".
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

// 4 palette identitarie in ciclo. [alone, tinta media, tinta scura].
// Ordine: viola → Tiffany/petrolio → ciclamino → rosa caldo.
const PALETTES: [string, string, string][] = [
  ["#C4B5FD", "#8B5CF6", "#7C3AED"], // viola/lavanda (default)
  ["#5EEAD4", "#14B8A6", "#0F766E"], // Tiffany / blu petrolio
  ["#F9A8D4", "#EC4899", "#BE185D"], // ciclamino
  ["#FBCFE8", "#F472B6", "#DB2777"], // rosa caldo
];

// Sub-component: eclissi con anello luminoso + disco nero centrale.
// `discRatio` regola quanto è "grande" il buco nero (1 = tutto nero,
// 0 = solo alone). Per l'orb grande: 0.58. Per la mini-o: 0.78 (anello sottile).
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
      {/* Alone luminoso — la corona dell'eclissi */}
      <Circle cx={r} cy={r} r={r * 0.95} fill={`url(#${gradId})`} />
      {/* Disco nero centrale */}
      <Circle cx={r} cy={r} r={discR} fill="#06060A" />
      {/* Rim light — bordo luminoso sottile attorno al disco */}
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

export default function KodaSplash({ aiName, duration = 12000, onComplete }: Props) {
  const { width } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.78, 340);
  // Mini-eclissi al posto della "o": ~48% dell'altezza del testo (fontSize 72).
  const miniOrbSize = 38;

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const textFade = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  // === CROSS-FADE con PLATEAU (fix "Tiffany non visibile") ==================
  // prog: 0 → N in loop lineare. Ogni palette k è visibile con plateau
  // durante il segmento [k, k+1].
  const prog = useRef(new Animated.Value(0)).current;

  // Per assicurare che tutte le palette abbiano tempo di essere PIENE,
  // il segment deve durare abbastanza. Con duration=12s e N=4 → 3s per colore.
  const segmentMs = Math.max(2500, Math.floor(duration / PALETTES.length));

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

  // === Loop del progresso palette ===
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

  // === Opacity con PLATEAU per ogni palette ================================
  // Fade-in 0.2 unità → plateau 0.6 unità → fade-out 0.2 unità → OFF 3 unità.
  // Somma ciclica = 4 unità = N segmenti = 1 giro completo.
  // Per k=0: doppio picco (inizio + wrap) per fluidità del loop.
  const N = PALETTES.length;
  const opacityFor = (k: number) => {
    const fw = 0.2; // fade width
    if (k === 0) {
      // ON da [0, 1-fw] con fade-out fino a 1, poi OFF fino a N-fw,
      // fade-in fino a N. Il wrap N → 0 chiude senza stacco.
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

  const rawName = (aiName?.trim() || "Koda").trim();
  // Split wordmark: cerca la PRIMA "o" case-insensitive.
  const oIdx = rawName.toLowerCase().indexOf("o");
  const hasO = oIdx >= 0;
  const prefix = hasO ? rawName.slice(0, oIdx) : rawName;
  const suffix = hasO ? rawName.slice(oIdx + 1) : "";

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerCol}>
          {/* === ECLISSI GRANDE — 4 palette cross-fade con plateau ==========
              Corona luminosa che cambia colore ciclicamente: viola →
              Tiffany → ciclamino → rosa. Ogni colore ha ~1.8s di piena
              visibilità grazie al plateau nella opacityFor. */}
          <Animated.View
            style={{
              opacity: orbFade,
              width: orbSize,
              height: orbSize,
              marginBottom: 44,
            }}
          >
            {PALETTES.map((p, k) => (
              <Animated.View
                key={p[1]}
                style={[StyleSheet.absoluteFill, { opacity: opacityFor(k) }]}
              >
                <OrbCircle palette={p} size={orbSize} discRatio={0.58} />
              </Animated.View>
            ))}
          </Animated.View>

          {/* === WORDMARK "Koda" con MINI-ECLISSI al posto della prima "o" =
              Row: "K" + <mini-eclissi 4-palette> + "da"
              Il mini-orb usa la stessa `opacityFor` → cambia colore in
              sincrono con l'orb grande. Attorno al wordmark: layer glow
              rosa/lavanda per l'aura luminosa. */}
          <Animated.View style={[styles.wordmarkRow, { opacity: textFade }]}>
            {/* Glow layer (esteso, dietro) */}
            <Text style={[styles.name, styles.nameGlow]} allowFontScaling={false}>
              {rawName}
            </Text>
            {/* Prefix "K" */}
            <Text style={[styles.name, styles.nameTop]} allowFontScaling={false}>
              {prefix}
            </Text>
            {hasO ? (
              <View style={styles.miniOrbWrap}>
                {PALETTES.map((p, k) => (
                  <Animated.View
                    key={`mini_${p[1]}`}
                    style={[StyleSheet.absoluteFill, { opacity: opacityFor(k) }]}
                  >
                    <OrbCircle palette={p} size={miniOrbSize} discRatio={0.78} />
                  </Animated.View>
                ))}
              </View>
            ) : null}
            {/* Suffix "da" */}
            <Text style={[styles.name, styles.nameTop]} allowFontScaling={false}>
              {suffix}
            </Text>
          </Animated.View>

          {/* === SOTTOTITOLO ============================================== */}
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
    paddingHorizontal: 32,
  },
  // Wordmark row: "K" + mini-eclissi + "da"
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  // Testo principale del wordmark (sans-serif system bold)
  name: {
    color: "#F5E9F3",
    fontSize: 72,
    fontWeight: "800",
    letterSpacing: 1,
    textAlign: "center",
    includeFontPadding: false,
  },
  // Glow layer dietro il wordmark — assoluto, allargato tramite blur pesante
  nameGlow: {
    position: "absolute",
    color: "rgba(196,181,253,0.35)",
    textShadowColor: "rgba(196,181,253,0.85)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 28,
    // Copre l'intero wordmark: prefix + o placeholder + suffix
    left: 0,
    right: 0,
    textAlign: "center",
  },
  // Testo principale sopra (nitido, bianco caldo con soft glow)
  nameTop: {
    textShadowColor: "rgba(244,114,182,0.45)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  // Contenitore assoluto per la mini-eclissi che sostituisce la "o"
  miniOrbWrap: {
    width: 38,
    height: 38,
    marginHorizontal: 2,
  },
  tagline: {
    color: "rgba(230,220,235,0.7)",
    fontSize: 18,
    letterSpacing: 3,
    fontWeight: "400",
    textAlign: "center",
  },
});
