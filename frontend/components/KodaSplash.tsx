/**
 * KodaSplash — splash screen evocativo all'apertura dell'app.
 *
 * Scopo:
 *  - mascherare la latenza di boot (~3-5s prima che il primo TTS sia pronto)
 *  - dare un'identità visiva forte all'app fin dal primo secondo
 *  - far sentire l'utente che "l'app si sta svegliando", non che è bloccata
 *
 * Design:
 *  - sfondo nero profondo (#06060A) come tutta l'app
 *  - eclissi grande al centro che cicla automaticamente tra i 4 stati
 *    cromatici (viola → blu petrolio → ciclamino → rosa caldo), una sorta
 *    di "respiro di luce" che dura 4 secondi
 *  - nome AI personalizzato (`aiName` dal profilo) o "Koda" come default,
 *    fade-in dolce sotto l'eclissi
 *  - sottotitolo "L'Amico Fraterno" piccolo, tenue, sotto il nome
 *  - fade-out finale di tutto verso la home
 *
 * Comportamento:
 *  - chiama `onComplete()` dopo 4000ms (configurabile via `duration`)
 *  - se l'utente tocca lo schermo, completa subito (skip)
 */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Pressable, Dimensions } from "react-native";
import EclipseOrb, { OrbStatus, OrbTone } from "./EclipseOrb";

interface Props {
  /** Nome AI da mostrare (default: "Koda"). */
  aiName?: string | null;
  /** Durata totale in ms prima del fade-out. Default 4000. */
  duration?: number;
  /** Chiamato quando lo splash è completo (o l'utente lo tocca). */
  onComplete: () => void;
}

// Ciclo automatico dei 4 stati cromatici, distribuiti sui ~3.5s di splash:
// idle viola → recording blu → thinking ciclamino → speaking warm rosa.
const COLOR_CYCLE: Array<[OrbStatus, OrbTone | undefined, number]> = [
  ["idle", "neutral", 900],          // viola
  ["recording", undefined, 800],     // blu petrolio
  ["thinking", undefined, 800],      // ciclamino
  ["speaking", "warm", 1000],        // rosa caldo
];

export default function KodaSplash({ aiName, duration = 4000, onComplete }: Props) {
  const { width, height } = Dimensions.get("window");
  const orbSize = Math.min(width * 0.7, 280);

  const fade = useRef(new Animated.Value(0)).current;
  const orbFade = useRef(new Animated.Value(0)).current;
  const nameFade = useRef(new Animated.Value(0)).current;
  const subFade = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  const [status, setStatus] = useState<OrbStatus>("idle");
  const [tone, setTone] = useState<OrbTone | undefined>("neutral");

  // === Sequenza di fade-in ===
  useEffect(() => {
    // Background subito
    Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    // Orb fade-in dopo 100ms
    Animated.timing(orbFade, {
      toValue: 1,
      duration: 800,
      delay: 100,
      useNativeDriver: true,
    }).start();
    // Nome fade-in dopo 700ms (mentre l'orb è ancora respirando)
    Animated.timing(nameFade, {
      toValue: 1,
      duration: 700,
      delay: 700,
      useNativeDriver: true,
    }).start();
    // Sottotitolo fade-in dopo 1.4s
    Animated.timing(subFade, {
      toValue: 1,
      duration: 700,
      delay: 1400,
      useNativeDriver: true,
    }).start();
  }, [fade, orbFade, nameFade, subFade]);

  // === Ciclo automatico colori dell'orb ===
  useEffect(() => {
    let i = 0;
    let timer: any = null;
    const tick = () => {
      const [s, t, d] = COLOR_CYCLE[i % COLOR_CYCLE.length];
      setStatus(s);
      setTone(t ?? "neutral");
      i++;
      timer = setTimeout(tick, d);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  // === Trigger fade-out + onComplete dopo `duration` ms ===
  useEffect(() => {
    const t = setTimeout(() => {
      if (completedRef.current) return;
      completedRef.current = true;
      Animated.timing(fade, {
        toValue: 0,
        duration: 600,
        useNativeDriver: true,
      }).start(() => {
        onComplete();
      });
    }, duration);
    return () => clearTimeout(t);
  }, [duration, fade, onComplete]);

  const handleSkip = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    Animated.timing(fade, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start(() => {
      onComplete();
    });
  };

  const displayName = (aiName?.trim() || "Koda").trim();

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} pointerEvents="auto">
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSkip}>
        <View style={styles.centerWrap}>
          {/* Eclissi che respira colori */}
          <Animated.View style={{ opacity: orbFade, marginBottom: 28 }}>
            <EclipseOrb status={status} tone={tone} size={orbSize} />
          </Animated.View>

          {/* Nome AI */}
          <Animated.Text style={[styles.name, { opacity: nameFade }]}>
            {displayName}
          </Animated.Text>

          {/* Sottotitolo identitario */}
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
    fontSize: 38,
    fontWeight: "300",
    letterSpacing: 4,
    textAlign: "center",
    // Glow soffuso per dare profondità al nome
    textShadowColor: "rgba(244,114,182,0.4)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  subtitle: {
    color: "#A78BFA",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 5,
    marginTop: 16,
    textTransform: "uppercase",
    opacity: 0.7,
  },
});
