/**
 * HeartVoiceReveal.tsx — Il reveal della voce di Koda (Fabio 2026-08-22).
 *
 * Fase C del piano onboarding V3: dopo che l'utente ha vissuto la prima
 * sessione di Lascia Andare per almeno 60s (con silenzio 15s continuo O
 * tocco X), si arriva qui.
 *
 * Sequenza:
 *   1. Fade-in orb centrato, palette warm (viola Cielo)
 *   2. Play clip pre-registrata: "Questo è il mio cuore. È tuo, sempre,
 *      gratuitamente. Ma ho anche una voce. Se vuoi, posso parlarti
 *      davvero."
 *   3. Al termine clip → fade-in 2 CTA:
 *        • [primary] "Ascolta la mia voce" → /microdemo
 *        • [secondary] "Non ora, grazie"    → /lascia-andare (senza firstBoot)
 *   4. Nessun timer: se l'utente non tocca nulla, orb resta idle. "No fretta."
 *
 * Al primo dismiss (qualunque CTA): scriviamo intro_v3_completed_at se
 * non già presente + heart_reveal_dismissed_at. Da qui in poi la sequenza
 * narrativa non si ripete mai più.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
  Dimensions,
  BackHandler,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import EclipseOrb from "../components/EclipseOrb";

const TAG = "KODA_HEART_REVEAL";
const REVEAL_CLIP = require("../assets/sounds/intro/reveal_cuore_voce-cielo.mp3");

const { width: WINDOW_WIDTH } = Dimensions.get("window");
const ORB_SIZE = Math.min(WINDOW_WIDTH * 0.78, 360);

async function configureAudioForPlayback(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (e) {
    console.warn(`[${TAG}] configureAudioForPlayback failed:`, e);
  }
}

export default function HeartVoiceReveal() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [ctaVisible, setCtaVisible] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const playerRef = useRef<AudioPlayer | null>(null);
  const mountedRef = useRef(true);
  const screenOpacity = useRef(new Animated.Value(0)).current;
  const orbOpacity = useRef(new Animated.Value(0)).current;
  const orbScale = useRef(new Animated.Value(0.3)).current;
  const ctaOpacity = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;

  // Persistenza: chiama sempre al primo dismiss
  const persistDismiss = useCallback(async () => {
    try {
      const existing = await SecureStore.getItemAsync("intro_v3_completed_at");
      if (!existing) {
        await SecureStore.setItemAsync("intro_v3_completed_at", String(Date.now()));
      }
      await SecureStore.setItemAsync("heart_reveal_dismissed_at", String(Date.now()));
    } catch (e) {
      console.warn(`[${TAG}] persistDismiss failed:`, e);
    }
  }, []);

  // Fade-out morbido → naviga
  const fadeOutAndNavigate = useCallback(
    (destination: string) => {
      if (dismissing) return;
      setDismissing(true);
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: 600,
        useNativeDriver: true,
      }).start(() => {
        if (!mountedRef.current) return;
        try { playerRef.current?.remove(); } catch {}
        try {
          router.replace(destination);
        } catch (e) {
          console.warn(`[${TAG}] navigation to ${destination} failed:`, e);
        }
      });
    },
    [dismissing, screenOpacity, router]
  );

  const onListenVoice = useCallback(async () => {
    console.log(`[${TAG}] CTA primary → /microdemo`);
    await persistDismiss();
    fadeOutAndNavigate("/microdemo");
  }, [persistDismiss, fadeOutAndNavigate]);

  const onNotNow = useCallback(async () => {
    console.log(`[${TAG}] CTA secondary → /lascia-andare`);
    await persistDismiss();
    fadeOutAndNavigate("/lascia-andare");
  }, [persistDismiss, fadeOutAndNavigate]);

  // Hardware back (Android) = equivalente "Non ora, grazie"
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onNotNow();
      return true;
    });
    return () => sub.remove();
  }, [onNotNow]);

  // Mount: fade-in schermata + orb, play clip, fade-in CTA a fine clip
  useEffect(() => {
    mountedRef.current = true;

    // Fade-in schermata (600ms) + orb (900ms, in parallelo con scale)
    Animated.timing(screenOpacity, {
      toValue: 1,
      duration: 600,
      useNativeDriver: true,
    }).start();
    Animated.parallel([
      Animated.timing(orbOpacity, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
      Animated.timing(orbScale, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
    ]).start();

    // Breathe loop identico a intro/LA
    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 2400,
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: 2400,
          useNativeDriver: true,
        }),
      ])
    );
    breatheLoop.start();

    // Play clip dopo grace period 800ms (dà tempo all'orb di apparire)
    let clipStarted = false;
    const startPlayback = async () => {
      await configureAudioForPlayback();
      await new Promise((r) => setTimeout(r, 120)); // stabilizza audio session
      if (!mountedRef.current || clipStarted) return;
      clipStarted = true;
      try {
        const player = createAudioPlayer(REVEAL_CLIP, { updateInterval: 100 });
        playerRef.current = player;
        const onStatus = (status: { didJustFinish?: boolean }) => {
          if (status.didJustFinish) {
            try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
            // Clip finita → fade-in CTA
            if (mountedRef.current) {
              setCtaVisible(true);
              Animated.timing(ctaOpacity, {
                toValue: 1,
                duration: 500,
                useNativeDriver: true,
              }).start();
            }
          }
        };
        player.addListener("playbackStatusUpdate", onStatus);
        player.play();
        console.log(`[${TAG}] reveal clip started`);
      } catch (e) {
        console.warn(`[${TAG}] playback failed:`, e);
        // Fallback: mostra CTA comunque dopo 3s per non lasciare l'utente bloccato
        if (mountedRef.current) {
          setTimeout(() => {
            if (mountedRef.current) {
              setCtaVisible(true);
              Animated.timing(ctaOpacity, {
                toValue: 1,
                duration: 500,
                useNativeDriver: true,
              }).start();
            }
          }, 3000);
        }
      }
    };
    const clipTimer = setTimeout(startPlayback, 800);

    return () => {
      mountedRef.current = false;
      clearTimeout(clipTimer);
      breatheLoop.stop();
      try { playerRef.current?.remove(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const breatheScale = useMemo(
    () =>
      breathe.interpolate({
        inputRange: [0, 1],
        outputRange: [0.95, 1.07],
      }),
    [breathe]
  );

  return (
    <Animated.View style={[styles.root, { opacity: screenOpacity }]}>
      {/* Orb centrale */}
      <View style={styles.centerContainer}>
        <Animated.View
          style={{
            opacity: orbOpacity,
            transform: [{ scale: orbScale }, { scale: breatheScale }],
          }}
        >
          <EclipseOrb status="speaking" tone="warm" size={ORB_SIZE} />
          {/* Spacer per replicare layout home (Fabio 2026-08-23):
              home ha gap:18 + statusLabel 16px sotto orb → 34px totali.
              Con questo spacer l'orb è nella STESSA posizione della home. */}
          <View style={{ height: 34 }} pointerEvents="none" />
        </Animated.View>
      </View>

      {/* CTA — appare solo dopo che la clip è finita */}
      {ctaVisible && (
        <Animated.View
          style={[
            styles.ctaBlock,
            {
              opacity: ctaOpacity,
              bottom: Math.max(insets.bottom + 32, 44),
            },
          ]}
        >
          <TouchableOpacity
            onPress={onListenVoice}
            disabled={dismissing}
            style={[styles.primaryCta, { opacity: dismissing ? 0.5 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Ascolta la mia voce"
            testID="heart-reveal-listen"
          >
            <Text style={styles.primaryCtaText}>Ascolta la mia voce</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onNotNow}
            disabled={dismissing}
            style={styles.secondaryCta}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Non ora, grazie"
            testID="heart-reveal-not-now"
          >
            <Text style={styles.secondaryCtaText}>Non ora, grazie</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Sfondo Koda-blu profondo (coerente con LA + Intro)
    backgroundColor: "#0F0F1A",
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    // === FIX ECLISSI CENTRATA (Fabio 2026-08-24) =========================
    // paddingTop RIMOSSO. Orb ora al centro esatto H/2 dello schermo.
    paddingTop: 0,
  },
  ctaBlock: {
    position: "absolute",
    left: 24,
    right: 24,
    alignItems: "center",
    gap: 16,
  },
  primaryCta: {
    width: "100%",
    paddingVertical: 16,
    borderRadius: 999,
    backgroundColor: "#D4B896", // champagne (identità Koda)
    alignItems: "center",
  },
  primaryCtaText: {
    color: "#1F1A36",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  secondaryCta: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  secondaryCtaText: {
    color: "rgba(226,232,240,0.55)",
    fontSize: 14,
    letterSpacing: 0.3,
  },
});
