/**
 * IntroPremium — Presentazione della home Koda conversazionale (Fabio 2026-08-22).
 *
 * ARCHITETTURA:
 *   - Fase A: introduzione vocale unica (~4s)
 *       Koda pronuncia: "Eccomi. Ora hai anche la mia voce. Toccami quando sei pronto."
 *   - Fase B: 3 coach-mark (Orb, Hands-free, Scrittura) — no voce, tap-to-close
 *   - Fase C: chiusura silenziosa + POST /intro-premium/mark-seen +
 *     SecureStore.intro_premium_seen_at + router.replace("/")
 *
 * NON tocca V1 (KodaIntro) né V3 (KodaIntroV3). Componente auto-contenuto.
 *
 * TRIGGER: SOLO alla prima apertura di un utente Premium sulla home "/"
 * (vedi router in app/index.tsx). Dopo il primo completamento, il flag
 * intro_premium_seen_at (Mongo + SecureStore mirror) blocca ogni ripetizione.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  TouchableOpacity,
  useWindowDimensions,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import EclipseOrb from "./EclipseOrb";
import { api } from "../lib/api";

const TAG = "[intro-premium]";

// La stessa clip che generiamo con scripts/gen_intro_premium_clip.py.
const CLIP_ECCOMI = require("../assets/sounds/intro/intro_premium_eccomi-cielo.mp3");

// ==================== TYPES ====================
type Phase =
  | "boot"          // fade-in schermo, orb idle
  | "speaking"      // clip in play
  | "coach_orb"     // coach-mark #1 → Orb
  | "coach_hf"      // coach-mark #2 → Hands-free
  | "coach_text"    // coach-mark #3 → Barra scrittura
  | "closing";      // fade-out + handoff

type Rect = { x: number; y: number; w: number; h: number };

// ==================== COMPONENT ====================
export default function IntroPremium() {
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();

  const [phase, setPhase] = useState<Phase>("boot");
  const [orbState, setOrbState] = useState<"idle" | "speaking">("idle");

  const screenOpacity = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const ringPulse = useRef(new Animated.Value(0)).current;

  const currentPlayerRef = useRef<any>(null);
  const safetyTimerRef = useRef<any>(null);
  const mountedRef = useRef(true);

  // ==================== TARGET RECTS ====================
  // Posizioni degli elementi della home Koda conv, calcolate con LE STESSE
  // formule usate dal Tour V1 (index.tsx righe 676-680) come fallback.
  // Non abbiamo ref vivi qui perché siamo su una route separata → usiamo
  // le formule matematiche già collaudate.
  const headerCY = Math.max(insets.top + 28, 70) + 22;
  const orbSize = Math.min(W * 0.78, 360);
  const orbCY = H * 0.46;

  const RECTS: Record<"orb" | "hf" | "text", Rect> = {
    orb: {
      x: W / 2 - orbSize / 2,
      y: orbCY - orbSize / 2,
      w: orbSize,
      h: orbSize,
    },
    hf: {
      x: 14,
      y: headerCY - 22,
      w: 44,
      h: 44,
    },
    text: {
      x: 8,
      y: H - Math.max(insets.bottom, 20) - 90,
      w: W - 16,
      h: 78,
    },
  };

  // ==================== AUDIO CONFIG ====================
  const configureAudioForPlayback = useCallback(async () => {
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      } as any);
    } catch (e) {
      console.warn(`${TAG} audio mode set failed:`, e);
    }
  }, []);

  // ==================== PLAY CLIP ====================
  const playIntroClip = useCallback(async () => {
    await configureAudioForPlayback();
    // Grace period per stabilizzare la audio session iOS
    await new Promise((r) => setTimeout(r, 120));
    if (!mountedRef.current) return;

    setPhase("speaking");
    setOrbState("speaking");

    const onFinish = () => {
      if (!mountedRef.current) return;
      setOrbState("idle");
      // Piccola pausa dopo la voce, poi entra nei coach-mark
      setTimeout(() => {
        if (!mountedRef.current) return;
        setPhase("coach_orb");
      }, 500);
    };

    try {
      const player = createAudioPlayer(CLIP_ECCOMI, { updateInterval: 100 });
      currentPlayerRef.current = player;

      const onStatus = (status: { didJustFinish?: boolean }) => {
        if (status.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          onFinish();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();

      // Safety net 12s (la clip dura ~4s)
      safetyTimerRef.current = setTimeout(() => {
        console.warn(`${TAG} clip safety-net triggered`);
        onFinish();
      }, 12000);
    } catch (e) {
      console.warn(`${TAG} playClip failed:`, e);
      // Fallback: skippa comunque alla fase coach
      safetyTimerRef.current = setTimeout(onFinish, 800);
    }
  }, [configureAudioForPlayback]);

  // ==================== LIFECYCLE ====================
  useEffect(() => {
    mountedRef.current = true;

    // Fade-in schermo, poi parte la voce
    Animated.timing(screenOpacity, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start(() => {
      if (mountedRef.current) playIntroClip();
    });

    // Ring pulse loop (per i coach-mark)
    Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(ringPulse, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();

    return () => {
      mountedRef.current = false;
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      try {
        if (currentPlayerRef.current) {
          currentPlayerRef.current.pause?.();
          currentPlayerRef.current.remove?.();
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fade-in della card testo quando entra in una fase coach
  useEffect(() => {
    if (phase === "coach_orb" || phase === "coach_hf" || phase === "coach_text") {
      cardOpacity.setValue(0);
      Animated.timing(cardOpacity, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }).start();
    }
  }, [phase, cardOpacity]);

  // ==================== ADVANCE / CLOSE ====================
  const advance = useCallback(() => {
    if (phase === "coach_orb") setPhase("coach_hf");
    else if (phase === "coach_hf") setPhase("coach_text");
    else if (phase === "coach_text") doClose();
  }, [phase]);

  const doClose = useCallback(async () => {
    setPhase("closing");

    // Persiste il flag: prima SecureStore (istantaneo), poi backend (best-effort)
    try {
      await SecureStore.setItemAsync("intro_premium_seen_at", String(Date.now()));
    } catch (e) {
      console.warn(`${TAG} SecureStore set failed:`, e);
    }
    api.markIntroPremiumSeen().catch((e: any) => {
      console.warn(`${TAG} backend mark-seen failed (best-effort):`, e);
    });

    // Fade-out e handoff alla home Koda conv
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 400,
      useNativeDriver: true,
    }).start(() => {
      try {
        router.replace("/");
      } catch (e) {
        console.warn(`${TAG} router.replace failed:`, e);
      }
    });
  }, [screenOpacity]);

  // ==================== RENDER: COACH-MARK ====================
  // Overlay scuro semi-trasparente con "spotlight" sull'elemento reale
  // (usiamo 4 rettangoli neri intorno al target + ring pulsante sopra il target).
  const renderCoachMark = (
    targetKey: "orb" | "hf" | "text",
    title: string,
    body: string,
    isCircle: boolean = false
  ) => {
    const r = RECTS[targetKey];
    const pad = isCircle ? 8 : 6;
    const spot: Rect = {
      x: r.x - pad,
      y: r.y - pad,
      w: r.w + pad * 2,
      h: r.h + pad * 2,
    };
    const radius = isCircle ? spot.w / 2 : 14;

    // Posizione della card: sotto se lo spotlight è nella metà alta, sopra altrimenti.
    const cardY =
      spot.y + spot.h / 2 < H / 2
        ? Math.min(spot.y + spot.h + 20, H - insets.bottom - 200)
        : Math.max(spot.y - 200, insets.top + 40);

    const ringScale = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
    const ringOpacity = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0.15] });

    return (
      <TouchableOpacity
        activeOpacity={1}
        onPress={advance}
        style={styles.coachTouchLayer}
      >
        {/* Overlay scuro con "buco" attorno allo spotlight — usiamo 4 patches */}
        {/* Top */}
        <View
          style={[
            styles.overlayPatch,
            { top: 0, left: 0, right: 0, height: spot.y },
          ]}
        />
        {/* Bottom */}
        <View
          style={[
            styles.overlayPatch,
            { top: spot.y + spot.h, left: 0, right: 0, bottom: 0 },
          ]}
        />
        {/* Left */}
        <View
          style={[
            styles.overlayPatch,
            { top: spot.y, left: 0, width: spot.x, height: spot.h },
          ]}
        />
        {/* Right */}
        <View
          style={[
            styles.overlayPatch,
            {
              top: spot.y,
              left: spot.x + spot.w,
              right: 0,
              height: spot.h,
            },
          ]}
        />

        {/* Ring pulsante attorno al target */}
        <Animated.View
          style={{
            position: "absolute",
            left: spot.x,
            top: spot.y,
            width: spot.w,
            height: spot.h,
            borderRadius: radius,
            borderWidth: 2,
            borderColor: "#00F5D4",
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          }}
          pointerEvents="none"
        />

        {/* Card testo */}
        <Animated.View
          style={[
            styles.card,
            {
              top: cardY,
              opacity: cardOpacity,
            },
          ]}
        >
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardBody}>{body}</Text>
          <TouchableOpacity onPress={advance} style={styles.cta}>
            <Text style={styles.ctaText}>Ho capito</Text>
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    );
  };

  // ==================== RENDER ====================
  return (
    <Animated.View style={[styles.screen, { opacity: screenOpacity }]}>
      {/* Sfondo scuro + Orb centrale (visibile in tutte le fasi tranne closing) */}
      <View style={styles.orbWrap} pointerEvents="none">
        <EclipseOrb
          size={orbSize}
          status={orbState === "speaking" ? "speaking" : "idle"}
          tone="warm"
        />
      </View>

      {/* Coach-mark: attivi solo nella fase corrispondente */}
      {phase === "coach_orb" &&
        renderCoachMark(
          "orb",
          "Toccami",
          "Toccami per parlare. Ritoccami per fermarti.",
          true
        )}
      {phase === "coach_hf" &&
        renderCoachMark(
          "hf",
          "Mani libere",
          "Se lo attivi ti ascolto in continuo. Non serve toccarmi.",
          true
        )}
      {phase === "coach_text" &&
        renderCoachMark(
          "text",
          "Scrittura",
          "Se non puoi parlare, scrivi. Rispondo in silenzio.",
          false
        )}
    </Animated.View>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0A0A0F",
  },
  orbWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  coachTouchLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayPatch: {
    position: "absolute",
    backgroundColor: "rgba(0, 0, 0, 0.78)",
  },
  card: {
    position: "absolute",
    left: 24,
    right: 24,
    backgroundColor: "#15151C",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(0, 245, 212, 0.22)",
    paddingHorizontal: 22,
    paddingVertical: 20,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 16,
      },
      android: {
        elevation: 12,
      },
    }),
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#00F5D4",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  cardBody: {
    fontSize: 16.5,
    lineHeight: 24,
    color: "#F0F0F5",
    marginBottom: 16,
  },
  cta: {
    alignSelf: "flex-end",
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(0, 245, 212, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(0, 245, 212, 0.4)",
  },
  ctaText: {
    color: "#00F5D4",
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.3,
  },
});
