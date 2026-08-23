/**
 * IntroPremiumFinalStep — Overlay in home per l'ultima fase dell'Intro Premium.
 * Fabio 2026-08-22.
 *
 * SEQUENZA (dopo handoff da IntroPremium.tsx via ?intro=writing_final):
 *   1. Home Taccuino scrolla su Page 1 ("reading") con lo swipe reale
 *   2. Questo overlay monta SOPRA la Page 1 vera (backdrop scuro trasparente)
 *   3. Coach-mark sopra la barra scrittura VERA — testo: "Rispondo qui in silenzio."
 *   4. Al tap "Ho capito" o tap ovunque:
 *      - suona la clip di chiusura Cielo "Adesso ci siamo. Cominciamo."
 *      - fade-out overlay
 *      - api.markIntroPremiumSeen() + api.markLasciaAndareIntroSeen()
 *      - SecureStore mirror di intro_premium_seen_at
 *      - onComplete() → parent pulisce il query param e nasconde overlay
 *
 * INVARIANTI:
 *   - Non tocca lo stato della home Taccuino se non via onComplete
 *   - Idempotente: se già seen, il chiamante non lo monta
 *   - Persistenza doppia (locale + backend) per sopravvivere reinstall/wipe
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Animated, Easing, TouchableOpacity,
  useWindowDimensions, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { api } from "../lib/api";

const TAG = "[intro-premium-final]";
const CLIP_CLOSING = require("../assets/sounds/intro/intro_premium_closing-cielo.mp3");

type Props = {
  onComplete: () => void;
};

export default function IntroPremiumFinalStep({ onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();

  const [showCard, setShowCard] = useState(false);
  const [closing, setClosing] = useState(false);

  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const ringPulse = useRef(new Animated.Value(0)).current;

  const playerRef = useRef<any>(null);
  const mountedRef = useRef(true);

  // === Barra scrittura VERA: posizione = quella della Page 1 (reading) ==========
  // Coerente con il layout della home (bottomBarHeight ~ 90px).
  const textBarRect = {
    x: 8,
    y: H - Math.max(insets.bottom, 20) - 90,
    w: W - 16,
    h: 78,
  };
  const cardY = Math.max(textBarRect.y - 210, insets.top + 40);

  // === Fade-in overlay + start ring pulse ================================
  useEffect(() => {
    mountedRef.current = true;
    // Piccolo delay per lasciare che lo swipe verso Page 1 si completi visivamente
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      setShowCard(true);
      Animated.timing(backdropOpacity, {
        toValue: 1, duration: 320, useNativeDriver: true,
      }).start();
      Animated.timing(cardOpacity, {
        toValue: 1, duration: 320, useNativeDriver: true,
      }).start();
    }, 480);
    Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(ringPulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
    return () => {
      mountedRef.current = false;
      clearTimeout(t);
      try {
        playerRef.current?.pause?.();
        playerRef.current?.remove?.();
      } catch {}
    };
  }, [backdropOpacity, cardOpacity, ringPulse]);

  const playClosingClip = useCallback(async () => {
    try {
      await setAudioModeAsync({
        allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false,
      } as any);
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
    try {
      const player = createAudioPlayer(CLIP_CLOSING, { updateInterval: 100 });
      playerRef.current = player;
      player.play();
    } catch (e) {
      console.warn(`${TAG} closing clip failed:`, e);
    }
  }, []);

  const finish = useCallback(async () => {
    if (closing) return;
    setClosing(true);

    // Suona la clip in parallelo alla persistenza + fade-out
    playClosingClip();

    // Persistenza (best-effort, fire-and-forget)
    (async () => {
      try {
        await SecureStore.setItemAsync("intro_premium_seen_at", String(Date.now()));
      } catch (e) { console.warn(`${TAG} SecureStore mirror failed:`, e); }
      api.markIntroPremiumSeen().catch((e: any) =>
        console.warn(`${TAG} markIntroPremiumSeen:`, e)
      );
      // FIX C (Fabio 2026-08-22): un utente Premium ha già vissuto LA
      // come Free — il banner "Che cos'è Lascia Andare" NON deve mai
      // apparire sulla home post-Intro. Idempotente lato backend.
      api.markLasciaAndareIntroSeen().catch((e: any) =>
        console.warn(`${TAG} markLasciaAndareIntroSeen:`, e)
      );
    })();

    // Fade-out: aspetta che la clip finisca (durata ~3s) + un po' extra
    setTimeout(() => {
      if (!mountedRef.current) return;
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(cardOpacity, { toValue: 0, duration: 350, useNativeDriver: true }),
      ]).start(() => {
        if (mountedRef.current) onComplete();
      });
    }, 2400);
  }, [closing, backdropOpacity, cardOpacity, onComplete, playClosingClip]);

  // === Ring pulsante rimosso (spec Fabio 2026-08-23) ============================
  // Vecchie variabili ringScale/ringOpacityAnim eliminate dopo la rimozione
  // del ring pulsante sulla barra scrittura vera (regola PARTE 4).

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      {/* Backdrop scuro semi-trasparente */}
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: "rgba(0,0,0,0.55)", opacity: backdropOpacity },
        ]}
        pointerEvents={showCard ? "auto" : "none"}
      />
      {/* Layer tappabile (chiude al tap ovunque) */}
      {showCard && !closing && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={finish}
          style={StyleSheet.absoluteFillObject}
        />
      )}
      {/* Ring pulsante RIMOSSO (Fabio 2026-08-23, PARTE 4 spec):
          "Mai un elemento evidenziato se già presente: ogni elemento che
          compare durante un coach-mark deve apparire dal nulla (fade-in),
          mai essere illuminato da uno stato preesistente con ring/glow/torcia."
          La barra scrittura È preesistente sulla home reale → niente ring.
          La card sopra è già sufficiente ancoraggio visivo. */}
      {/* Card testo — sopra la barra */}
      {showCard && (
        <Animated.View
          style={[
            styles.card,
            { top: cardY, opacity: cardOpacity },
          ]}
        >
          <Text style={styles.cardTitle}>Scrittura</Text>
          <Text style={styles.cardBody}>Rispondo qui in silenzio.</Text>
          <TouchableOpacity onPress={finish} style={styles.cta} disabled={closing}>
            <Text style={styles.ctaText}>Ho capito</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute", left: 24, right: 24,
    backgroundColor: "#15151C", borderRadius: 20,
    borderWidth: 1, borderColor: "rgba(0, 245, 212, 0.22)",
    paddingHorizontal: 22, paddingVertical: 20,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16 },
      android: { elevation: 12 },
    }),
  },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#00F5D4", letterSpacing: 0.4, marginBottom: 8 },
  cardBody: { fontSize: 16.5, lineHeight: 24, color: "#F0F0F5", marginBottom: 16 },
  cta: {
    alignSelf: "flex-end", paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: 999, backgroundColor: "rgba(0, 245, 212, 0.14)",
    borderWidth: 1, borderColor: "rgba(0, 245, 212, 0.4)",
  },
  ctaText: { color: "#00F5D4", fontWeight: "700", fontSize: 14, letterSpacing: 0.3 },
});
