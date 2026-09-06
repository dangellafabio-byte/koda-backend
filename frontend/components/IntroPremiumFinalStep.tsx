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
      // === FIX 2026-09-06 v65.20 — Android audio parità con IntroPremium (Fabio) ==
      // Bug: la clip "Adesso ci siamo. Cominciamo." era MUTA su Android
      // perché questo componente aveva un setAudioModeAsync minimo, senza
      // i field Android specifici del fix v65.5/v65.12 in IntroPremium.tsx.
      // Ora applichiamo lo stesso trattamento completo:
      //   - interruptionMode + interruptionModeAndroid espliciti
      //   - shouldRouteThroughEarpiece:false
      //   - volume=1.0 doppio (creazione + post-load)
      //   - polling isLoaded fino a 2s (createAudioPlayer è async internamente)
      //   - logging strutturato [KODA_INTRO_FINAL] per diag buffer Fabio
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: "duckOthers",
        interruptionModeAndroid: "duckOthers",
        shouldRouteThroughEarpiece: false,
      } as any);
    } catch (e) {
      console.warn(`${TAG} setAudioModeAsync failed:`, e);
    }
    // Delay più lungo (250ms invece di 120) per lasciare che Android
    // settle l'audio focus dopo il release della session precedente.
    await new Promise((r) => setTimeout(r, 250));
    if (!mountedRef.current) return;
    try {
      const player = createAudioPlayer(CLIP_CLOSING, { updateInterval: 100 });
      playerRef.current = player;
      // Volume immediato (Android alcuni device inizializzano a 0.x)
      try { (player as any).volume = 1.0; } catch {}
      // Polling isLoaded fino a 2s (Stefania bug fix v65.5, riportato qui)
      for (let i = 0; i < 20; i++) {
        if ((player as any).isLoaded === true) break;
        await new Promise((r) => setTimeout(r, 100));
        if (!mountedRef.current) return;
      }
      // Volume di nuovo dopo load (alcuni Android lo resettano)
      try { (player as any).volume = 1.0; } catch {}
      player.play();
      console.log(
        `[KODA_INTRO_FINAL] closing clip started platform=${Platform.OS} ` +
        `isLoaded=${(player as any).isLoaded} volume=${(player as any).volume} ` +
        `playing=${(player as any).playing ?? '?'} status=${(player as any).status ?? '?'}`
      );
      // v65.20 (Fabio 2026-09-06): Android watchdog double-play — vedi
      // stesso pattern in IntroPremium.tsx.
      if (Platform.OS === "android") {
        setTimeout(() => {
          if (!mountedRef.current) return;
          try {
            const playing = (player as any).playing;
            if (playing !== true) {
              console.warn(
                `[KODA_INTRO_FINAL] Android double-play triggered: ` +
                `playing=${playing} isLoaded=${(player as any).isLoaded}`
              );
              try { player.play(); } catch (e) { console.warn(`${TAG} double-play failed:`, e); }
            } else {
              console.log(`[KODA_INTRO_FINAL] Android watchdog OK — playing confirmed`);
            }
          } catch (e) { console.warn(`${TAG} watchdog exception:`, e); }
        }, 500);
      }
    } catch (e) {
      console.warn(`[KODA_INTRO_FINAL] closing clip failed:`, e);
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

  // === Ring pulsante attorno alla barra scrittura vera (Fabio 2026-08-23,
  // ripristinato: l'utente vuole l'evidenziatura per marcare l'elemento). ==
  const ringScale = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
  const ringOpacityAnim = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 0.25] });

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
      {/* Ring pulsante attorno alla barra scrittura VERA (Fabio 2026-08-23,
          ripristinato dopo rimozione temporanea). */}
      {showCard && (
        <Animated.View
          style={{
            position: "absolute",
            left: textBarRect.x - 6,
            top: textBarRect.y - 6,
            width: textBarRect.w + 12,
            height: textBarRect.h + 12,
            borderRadius: 20,
            borderWidth: 2,
            borderColor: "#00F5D4",
            opacity: ringOpacityAnim,
            transform: [{ scale: ringScale }],
          }}
          pointerEvents="none"
        />
      )}
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
