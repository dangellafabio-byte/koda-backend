/**
 * IntroPremium v3 — Sequenza a 5 fasi + handoff finale (Fabio 2026-08-22).
 *
 * ARCHITETTURA "split" (chirurgica):
 *   Route /intro-premium (questa) → 5 fasi:
 *     1. speaking + asking_permission (voce Cielo, richiesta permesso)
 *     2. coach_orb   (card sotto orb)
 *     3. coach_hf    (HandsFreeOrb VERO fade-in, card)
 *     4. coach_la    (pillola fade-in, card SENZA modal downstream)
 *     5. coach_settings (⋯ fade-in, card)
 *     6. coach_swipe (auto-swipe dimostrativo: home fake trasla a sx e torna)
 *   → handoff: router.replace("/?intro=writing_final")
 *
 * Home Taccuino legge il query param, scrolla su Page 1 e monta
 * <IntroPremiumFinalStep /> (overlay) che disegna il coach-mark sulla
 * barra scrittura VERA + suona la clip di chiusura Cielo.
 * Overlay chiude: markIntroPremiumSeen + markLasciaAndareIntroSeen.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Animated, Easing, TouchableOpacity,
  useWindowDimensions, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import EclipseOrb from "./EclipseOrb";
import HandsFreeOrb from "./HandsFreeOrb";
import { ensureSpeechPermission } from "../lib/speechPermission";

const TAG = "[intro-premium]";
const CLIP_ECCOMI = require("../assets/sounds/intro/intro_premium_eccomi-cielo.mp3");

type Phase =
  | "boot" | "speaking" | "asking_permission" | "waiting_tap"
  | "coach_orb" | "coach_hf" | "coach_la" | "coach_settings" | "coach_swipe"
  | "handoff";

type Rect = { x: number; y: number; w: number; h: number };

export default function IntroPremium() {
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();

  const [phase, setPhase] = useState<Phase>("boot");
  const [orbState, setOrbState] = useState<"idle" | "speaking">("idle");
  const [showTapHint, setShowTapHint] = useState(false);

  // Animazioni base
  const screenOpacity = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const ringPulse = useRef(new Animated.Value(0)).current;
  const tapHintOpacity = useRef(new Animated.Value(0)).current;
  // Fade-in progressivi
  const hfOpacity = useRef(new Animated.Value(0)).current;
  const laOpacity = useRef(new Animated.Value(0)).current;
  const settingsOpacity = useRef(new Animated.Value(0)).current;
  // Auto-swipe: intera fake-home trasla in X di -40 e torna
  const swipeX = useRef(new Animated.Value(0)).current;

  const currentPlayerRef = useRef<any>(null);
  const safetyTimerRef = useRef<any>(null);
  const tapHintTimerRef = useRef<any>(null);
  const mountedRef = useRef(true);

  // ==================== RECTS (coerenti con home reale) ====================
  const headerCY = Math.max(insets.top + 28, 70) + 22;
  const orbSize = Math.min(W * 0.78, 360);
  const orbCY = H * 0.46;

  const RECTS: Record<"orb" | "hf" | "la" | "settings", Rect> = {
    orb: { x: W / 2 - orbSize / 2, y: orbCY - orbSize / 2, w: orbSize, h: orbSize },
    hf: { x: 14, y: headerCY - 22, w: 44, h: 44 },
    la: { x: W / 2 - 95, y: Math.max(insets.top + 100, 150), w: 190, h: 44 },
    settings: { x: W - 58, y: headerCY - 22, w: 44, h: 44 },
  };

  // ==================== AUDIO ====================
  const configureAudio = useCallback(async () => {
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      } as any);
    } catch (e) { console.warn(`${TAG} audio mode:`, e); }
  }, []);

  const playIntroClip = useCallback(async () => {
    await configureAudio();
    await new Promise((r) => setTimeout(r, 120));
    if (!mountedRef.current) return;

    setPhase("speaking"); setOrbState("speaking");

    const onFinish = () => {
      if (!mountedRef.current) return;
      setOrbState("idle");
      askPermission();
    };
    try {
      const player = createAudioPlayer(CLIP_ECCOMI, { updateInterval: 100 });
      currentPlayerRef.current = player;
      const onStatus = (s: { didJustFinish?: boolean }) => {
        if (s.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          onFinish();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();
      safetyTimerRef.current = setTimeout(() => { console.warn(`${TAG} clip safety`); onFinish(); }, 12000);
    } catch (e) {
      console.warn(`${TAG} playClip failed:`, e);
      safetyTimerRef.current = setTimeout(onFinish, 800);
    }
  }, [configureAudio]);

  const askPermission = useCallback(async () => {
    setPhase("asking_permission");
    try {
      const res = await ensureSpeechPermission();
      console.log(`${TAG} permission: ${res.path} (granted=${res.granted})`);
    } catch (e) { console.warn(`${TAG} ensureSpeechPermission:`, e); }
    if (!mountedRef.current) return;
    setPhase("waiting_tap");
  }, []);

  // ==================== TAP HINT ====================
  useEffect(() => {
    if (phase !== "waiting_tap") return;
    tapHintTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setShowTapHint(true);
      Animated.timing(tapHintOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    }, 5000);
    return () => { if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current); };
  }, [phase, tapHintOpacity]);

  // ==================== LIFECYCLE ====================
  useEffect(() => {
    mountedRef.current = true;
    Animated.timing(screenOpacity, { toValue: 1, duration: 500, useNativeDriver: true })
      .start(() => { if (mountedRef.current) playIntroClip(); });
    Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(ringPulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
    return () => {
      mountedRef.current = false;
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
      try {
        if (currentPlayerRef.current) {
          currentPlayerRef.current.pause?.(); currentPlayerRef.current.remove?.();
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      phase === "coach_orb" || phase === "coach_hf" ||
      phase === "coach_la"  || phase === "coach_settings" ||
      phase === "coach_swipe"
    ) {
      cardOpacity.setValue(0);
      Animated.timing(cardOpacity, { toValue: 1, duration: 280, useNativeDriver: true }).start();
    }
  }, [phase, cardOpacity]);

  useEffect(() => {
    if (phase === "coach_hf") {
      Animated.timing(hfOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    } else if (phase === "coach_la") {
      Animated.timing(laOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    } else if (phase === "coach_settings") {
      Animated.timing(settingsOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    }
  }, [phase, hfOpacity, laOpacity, settingsOpacity]);

  // ==================== ADVANCE ====================
  const onOrbTap = useCallback(() => {
    if (phase !== "waiting_tap") return;
    if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
    setShowTapHint(false);
    setPhase("coach_orb");
  }, [phase]);

  const advance = useCallback(() => {
    if (phase === "coach_orb") setPhase("coach_hf");
    else if (phase === "coach_hf") setPhase("coach_la");
    else if (phase === "coach_la") setPhase("coach_settings");
    else if (phase === "coach_settings") setPhase("coach_swipe");
    else if (phase === "coach_swipe") doAutoSwipeAndHandoff();
  }, [phase]);

  // ==================== AUTO-SWIPE + HANDOFF (Fase 6/Passo Swipe) ==========
  const doAutoSwipeAndHandoff = useCallback(() => {
    setPhase("handoff");
    // Fade-out card (opacity già gestita da phase change)
    // Auto-swipe: -40px sinistra, poi torna (280ms + 220ms), poi handoff
    Animated.sequence([
      Animated.timing(swipeX, { toValue: -40, duration: 280, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      Animated.timing(swipeX, { toValue: 0,   duration: 220, easing: Easing.in(Easing.ease),  useNativeDriver: true }),
    ]).start(() => {
      // Fade-out schermo poi handoff
      Animated.timing(screenOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
        .start(() => {
          try { router.replace("/?intro=writing_final"); }
          catch (e) { console.warn(`${TAG} handoff router.replace failed:`, e); }
        });
    });
  }, [swipeX, screenOpacity]);

  // ==================== RENDER CARD ====================
  const renderCard = (
    targetRect: Rect | null,
    title: string, body: string,
    isCircle: boolean, showRing: boolean = true
  ) => {
    let ringElement: React.ReactNode = null;
    let cardY = H / 2;
    if (targetRect) {
      const pad = isCircle ? 8 : 6;
      const spot: Rect = { x: targetRect.x - pad, y: targetRect.y - pad, w: targetRect.w + pad * 2, h: targetRect.h + pad * 2 };
      const radius = isCircle ? spot.w / 2 : 14;
      cardY = spot.y + spot.h / 2 < H / 2
        ? Math.min(spot.y + spot.h + 20, H - insets.bottom - 220)
        : Math.max(spot.y - 220, insets.top + 40);
      if (showRing) {
        const ringScale = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
        const ringOpacityAnim = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 0.25] });
        ringElement = (
          <Animated.View
            style={{
              position: "absolute", left: spot.x, top: spot.y,
              width: spot.w, height: spot.h, borderRadius: radius,
              borderWidth: 2, borderColor: "#00F5D4",
              opacity: ringOpacityAnim, transform: [{ scale: ringScale }],
            }}
            pointerEvents="none"
          />
        );
      }
    }
    return (
      <TouchableOpacity activeOpacity={1} onPress={advance} style={styles.tapLayer}>
        {ringElement}
        <Animated.View style={[styles.card, { top: cardY, opacity: cardOpacity }]}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardBody}>{body}</Text>
          <TouchableOpacity onPress={advance} style={styles.cta}>
            <Text style={styles.ctaText}>Ho capito</Text>
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    );
  };

  // ==================== FAKE UI ELEMENTS ====================
  const renderFakeHandsFree = () => (
    <Animated.View
      style={[styles.fakeButton, {
        left: RECTS.hf.x, top: RECTS.hf.y,
        width: RECTS.hf.w, height: RECTS.hf.h,
        borderRadius: RECTS.hf.w / 2, opacity: hfOpacity,
      }]}
      pointerEvents="none"
    >
      {/* FIX B: icona VERA dalla home reale */}
      <HandsFreeOrb active={false} size={26} />
    </Animated.View>
  );

  const renderFakeLA = () => (
    <Animated.View
      style={[styles.fakeLA, {
        left: RECTS.la.x, top: RECTS.la.y,
        width: RECTS.la.w, height: RECTS.la.h, opacity: laOpacity,
      }]}
      pointerEvents="none"
    >
      <Text style={styles.fakeLAText}>Lascia andare</Text>
    </Animated.View>
  );

  const renderFakeSettings = () => (
    <Animated.View
      style={[styles.fakeButton, {
        left: RECTS.settings.x, top: RECTS.settings.y,
        width: RECTS.settings.w, height: RECTS.settings.h,
        borderRadius: RECTS.settings.w / 2, opacity: settingsOpacity,
      }]}
      pointerEvents="none"
    >
      <Ionicons name="ellipsis-horizontal" size={22} color="#F0F0F5" />
    </Animated.View>
  );

  // ==================== RENDER ====================
  const orbAreaTappable = phase === "waiting_tap"
    ? { pointerEvents: "auto" as const }
    : { pointerEvents: "none" as const };

  return (
    <Animated.View style={[styles.screen, { opacity: screenOpacity }]}>
      {/* Wrapper che riceve l'auto-swipe: contiene TUTTI gli elementi
          della fake-home (orb + toggle + pillola + ⋯) — la card resta
          fuori dal wrapper così non si muove. */}
      <Animated.View
        style={[
          styles.screen,
          { transform: [{ translateX: swipeX }] },
        ]}
      >
        {/* Orb centrale */}
        <View style={styles.orbWrap} {...orbAreaTappable}>
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={onOrbTap}
            disabled={phase !== "waiting_tap"}
            style={{ width: orbSize, height: orbSize, alignItems: "center", justifyContent: "center" }}
          >
            <EclipseOrb size={orbSize} status={orbState === "speaking" ? "speaking" : "idle"} tone="warm" />
          </TouchableOpacity>
        </View>

        {/* Tap hint (5s senza tap) */}
        {showTapHint && phase === "waiting_tap" && (
          <Animated.View
            style={[styles.tapHint, { top: orbCY - orbSize / 2 - 44, opacity: tapHintOpacity }]}
            pointerEvents="none"
          >
            <Text style={styles.tapHintText}>Toccami</Text>
          </Animated.View>
        )}

        {/* Elementi UI progressivi */}
        {(phase === "coach_hf" || phase === "coach_la" ||
          phase === "coach_settings" || phase === "coach_swipe" ||
          phase === "handoff") && renderFakeHandsFree()}
        {(phase === "coach_la" || phase === "coach_settings" ||
          phase === "coach_swipe" || phase === "handoff") && renderFakeLA()}
        {(phase === "coach_settings" || phase === "coach_swipe" ||
          phase === "handoff") && renderFakeSettings()}
      </Animated.View>

      {/* Coach-mark cards (fuori dallo swipe wrapper) */}
      {phase === "coach_orb" &&
        renderCard(RECTS.orb, "Toccami", "Il secondo tocco è per fermarmi.", true, false)}
      {phase === "coach_hf" &&
        renderCard(RECTS.hf, "Mani libere", "Se lo attivi ti ascolto in continuo. Non serve toccarmi.", true)}
      {phase === "coach_la" &&
        renderCard(RECTS.la, "Lascia andare", "Tocca per tornare al mio cuore.", false)}
      {phase === "coach_settings" &&
        renderCard(RECTS.settings, "Impostazioni", "Da qui cambi voce, tema, memoria.", true)}
      {phase === "coach_swipe" &&
        renderCard(null, "Scrittura", "Scorri verso sinistra per scrivermi.", false, false)}
    </Animated.View>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0A0A0F" },
  orbWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center", alignItems: "center",
  },
  tapHint: {
    position: "absolute", alignSelf: "center",
    left: 0, right: 0, alignItems: "center",
  },
  tapHintText: {
    color: "rgba(240,240,245,0.65)", fontSize: 14,
    fontStyle: "italic", letterSpacing: 0.5,
  },
  tapLayer: { ...StyleSheet.absoluteFillObject },
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
  fakeButton: {
    position: "absolute", backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1, borderColor: "rgba(255, 255, 255, 0.15)",
    alignItems: "center", justifyContent: "center",
  },
  fakeLA: {
    position: "absolute", borderRadius: 22,
    borderWidth: 1, borderColor: "rgba(255, 255, 255, 0.18)",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center", justifyContent: "center",
  },
  fakeLAText: { color: "#F0F0F5", fontSize: 13.5, fontWeight: "600", letterSpacing: 0.4 },
});
