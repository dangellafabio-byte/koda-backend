/**
 * ColorIntro — Tutorial dei colori dell'Eclissi.
 *
 * Mostrato UNA SOLA VOLTA al primo avvio. Spiega in modo poetico come
 * l'eclissi cambia colore in base allo stato:
 *   - Viola = idle (presenza)
 *   - Blu petrolio = ti ascolto (assorbo le tue parole)
 *   - Ciclamino = sto riflettendo
 *   - Verde petrolio / Blu / Magenta = sto parlando (con sfumature emotive)
 *
 * Dopo che l'utente ha visto il tour, scriviamo un flag in SecureStore
 * (`color_intro_seen=1`) e non si vede più.
 *
 * UX: ogni step auto-avanza dopo 4s, tap per saltare avanti, "Inizia" al
 * termine. Stile: full-screen scuro, eclisse centrale, testo poetico in
 * basso, fade tra gli step.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  Dimensions,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import EclipseOrb, { OrbStatus, OrbTone } from "./EclipseOrb";

type Step = {
  status: OrbStatus;
  tone?: OrbTone;
  title: string;
  subtitle: string;
};

const STEPS: Step[] = [
  {
    status: "idle",
    tone: "neutral",
    title: "Sono qui.",
    subtitle: "Quando aspetto, sono viola.\nPresenza, niente fretta.",
  },
  {
    status: "recording",
    title: "Ti ascolto.",
    subtitle: "Quando parli, mi tingo di blu petrolio.\nLa luce si raccoglie verso di te.",
  },
  {
    status: "thinking",
    title: "Sto pensando.",
    subtitle: "Quando rifletto, divento ciclamino.\nUn'idea che pulsa, prima di dirti qualcosa.",
  },
  {
    status: "speaking",
    tone: "warm",
    title: "Ti parlo.",
    subtitle: "Quando ti rispondo, cambio colore con quello che provo:\nverde se ti abbraccio, blu se siamo in pace, magenta se mi accendi.",
  },
];

type Props = {
  onDone: () => void;
};

export default function ColorIntro({ onDone }: Props) {
  const [step, setStep] = useState(0);
  const fade = useRef(new Animated.Value(0)).current;
  const { width } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.65, 280);

  // Fade-in del primo step al mount
  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 700,
      useNativeDriver: true,
    }).start();
  }, [fade]);

  // Auto-advance ogni 4.5 secondi (ma non superiore all'ultimo step)
  useEffect(() => {
    const t = setTimeout(() => {
      if (step < STEPS.length - 1) {
        advance(step + 1);
      }
    }, 4500);
    return () => clearTimeout(t);
  }, [step]);

  const advance = (nextStep: number) => {
    // Fade out → cambia step → fade in
    Animated.timing(fade, {
      toValue: 0,
      duration: 320,
      useNativeDriver: true,
    }).start(() => {
      setStep(nextStep);
      Animated.timing(fade, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }).start();
    });
  };

  const onTap = () => {
    if (step < STEPS.length - 1) {
      advance(step + 1);
    }
    // Se sull'ultimo step, il tap non fa nulla (deve premere "Inizia")
  };

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <Pressable style={styles.tapZone} onPress={onTap}>
        <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
          {/* Step indicator (puntini) */}
          <View style={styles.stepDots}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  i === step ? styles.dotActive : styles.dotInactive,
                ]}
              />
            ))}
          </View>

          {/* Eclissi centrale */}
          <Animated.View style={[styles.orbWrap, { opacity: fade }]}>
            <EclipseOrb
              status={current.status}
              tone={current.tone || null}
              size={orbSize}
            />
          </Animated.View>

          {/* Testo poetico */}
          <Animated.View style={[styles.textBlock, { opacity: fade }]}>
            <Text style={styles.title}>{current.title}</Text>
            <Text style={styles.subtitle}>{current.subtitle}</Text>
          </Animated.View>

          {/* Pulsante "Inizia" (solo sull'ultimo step) o "salta" */}
          <View style={styles.bottomBar}>
            {isLast ? (
              <Pressable
                onPress={onDone}
                style={({ pressed }) => [
                  styles.startBtn,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.startBtnText}>Inizia</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={onDone}
                style={({ pressed }) => [
                  styles.skipBtn,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text style={styles.skipBtnText}>Salta</Text>
              </Pressable>
            )}
          </View>
        </SafeAreaView>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    zIndex: 999,
  },
  tapZone: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 24,
    paddingHorizontal: 20,
  },
  stepDots: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: "#E5E7EB",
  },
  dotInactive: {
    backgroundColor: "#3F3F46",
  },
  orbWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  textBlock: {
    alignItems: "center",
    paddingHorizontal: 20,
    minHeight: 110,
  },
  title: {
    color: "#FAFAFA",
    fontSize: 28,
    fontWeight: "300",
    letterSpacing: 0.5,
    marginBottom: 12,
    textAlign: "center",
  },
  subtitle: {
    color: "#A1A1AA",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
    fontWeight: "300",
  },
  bottomBar: {
    marginBottom: 8,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  startBtn: {
    paddingHorizontal: 44,
    paddingVertical: 14,
    borderRadius: 32,
    backgroundColor: "#FAFAFA",
  },
  startBtnText: {
    color: "#000",
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 0.5,
  },
  skipBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  skipBtnText: {
    color: "#71717A",
    fontSize: 14,
    fontWeight: "400",
  },
});
