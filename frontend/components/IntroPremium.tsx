/**
 * IntroPremium v2 — Presentazione one-shot della home Koda conversazionale.
 * Fabio 2026-08-22 (sequenza definitiva 11 passi).
 *
 * ARCHITETTURA (rispetta "elemento non esiste finché non è il suo momento"):
 *   Passo 3 → boot: schermo scuro + SOLO orb visibile
 *   Passo 3 → Koda parla clip MP3 (~4s)
 *   Passo 3.5 → richiesta permesso Speech Recognition (via ensureSpeechPermission)
 *   Passo 4 → attesa tap sull'orb (5s → tooltip "Toccami")
 *   Passo 5 → coach-mark #1 "Il secondo tocco è per fermarmi."
 *   Passo 6 → toggle Mani libere FADE-IN + coach-mark #2
 *   Passo 7 → barra Scrittura FADE-IN + coach-mark #3
 *   Passo 8 → pillola "Lascia andare" FADE-IN + coach-mark #4
 *   Passo 9 → pulsante ⋯ Impostazioni FADE-IN + coach-mark #5
 *   Passo 10 → fade-out + POST mark-seen + SecureStore + router.replace("/")
 *
 * INVARIANTI:
 *   1. La sequenza NON si blocca mai anche se il permesso è negato
 *      (l'utente vive comunque l'intero rituale; potrà parlare quando
 *      re-attiverà il permesso).
 *   2. Gli elementi UI (toggle, barra, pillola, ⋯) NON esistono a schermo
 *      finché non è il loro turno — sono ridisegnati QUI, non montati dalla
 *      home vera. La transizione al Passo 10 li sostituisce con quelli reali.
 *   3. Coordinate degli elementi coerenti con le formule della home reale
 *      (index.tsx tourSteps): se cambia il layout, aggiornare le costanti RECTS.
 *   4. Nessuna dipendenza da measureRef vivi (siamo su una rotta separata).
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
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import EclipseOrb from "./EclipseOrb";
import { api } from "../lib/api";
import { ensureSpeechPermission } from "../lib/speechPermission";

const TAG = "[intro-premium]";
const CLIP_ECCOMI = require("../assets/sounds/intro/intro_premium_eccomi-cielo.mp3");

// ==================== TYPES ====================
type Phase =
  | "boot"
  | "speaking"
  | "asking_permission"
  | "waiting_tap"
  | "coach_orb"
  | "coach_hf"
  | "coach_text"
  | "coach_la"
  | "coach_settings"
  | "closing";

type Rect = { x: number; y: number; w: number; h: number };

export default function IntroPremium() {
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();

  const [phase, setPhase] = useState<Phase>("boot");
  const [orbState, setOrbState] = useState<"idle" | "speaking">("idle");
  const [showTapHint, setShowTapHint] = useState(false);

  // Animazioni
  const screenOpacity = useRef(new Animated.Value(0)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const ringPulse = useRef(new Animated.Value(0)).current;
  const tapHintOpacity = useRef(new Animated.Value(0)).current;
  // Fade-in progressivi per gli elementi che appaiono dal nulla
  const hfOpacity = useRef(new Animated.Value(0)).current;
  const textBarOpacity = useRef(new Animated.Value(0)).current;
  const laOpacity = useRef(new Animated.Value(0)).current;
  const settingsOpacity = useRef(new Animated.Value(0)).current;

  const currentPlayerRef = useRef<any>(null);
  const safetyTimerRef = useRef<any>(null);
  const tapHintTimerRef = useRef<any>(null);
  const mountedRef = useRef(true);

  // ==================== RECTS ====================
  // Posizioni coerenti con la home reale (index.tsx tourSteps).
  const headerCY = Math.max(insets.top + 28, 70) + 22;
  const orbSize = Math.min(W * 0.78, 360);
  const orbCY = H * 0.46;

  const RECTS: Record<"orb" | "hf" | "text" | "la" | "settings", Rect> = {
    orb: { x: W / 2 - orbSize / 2, y: orbCY - orbSize / 2, w: orbSize, h: orbSize },
    hf: { x: 14, y: headerCY - 22, w: 44, h: 44 },
    text: { x: 8, y: H - Math.max(insets.bottom, 20) - 90, w: W - 16, h: 78 },
    la: {
      x: W / 2 - 95,
      y: Math.max(insets.top + 100, 150),
      w: 190,
      h: 44,
    },
    settings: { x: W - 58, y: headerCY - 22, w: 44, h: 44 },
  };

  // ==================== AUDIO SETUP ====================
  const configureAudio = useCallback(async () => {
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      } as any);
    } catch (e) {
      console.warn(`${TAG} audio mode failed:`, e);
    }
  }, []);

  // ==================== PLAY CLIP + PERMISSION FLOW ====================
  const playIntroClip = useCallback(async () => {
    await configureAudio();
    await new Promise((r) => setTimeout(r, 120));
    if (!mountedRef.current) return;

    setPhase("speaking");
    setOrbState("speaking");

    const onFinish = () => {
      if (!mountedRef.current) return;
      setOrbState("idle");
      // Passo 3.5 → richiesta permesso (non blocca la sequenza)
      askPermission();
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

      // Safety net 12s
      safetyTimerRef.current = setTimeout(() => {
        console.warn(`${TAG} clip safety-net triggered`);
        onFinish();
      }, 12000);
    } catch (e) {
      console.warn(`${TAG} playClip failed:`, e);
      safetyTimerRef.current = setTimeout(onFinish, 800);
    }
  }, [configureAudio]);

  const askPermission = useCallback(async () => {
    setPhase("asking_permission");
    // La sequenza prosegue SEMPRE, indipendentemente dall'esito.
    // Se negato ora, l'helper è idempotente e ri-partirà al primo tap
    // orb / toggle hands-free dalla home vera.
    try {
      const res = await ensureSpeechPermission();
      console.log(`${TAG} permission result: ${res.path} (granted=${res.granted})`);
    } catch (e) {
      console.warn(`${TAG} ensureSpeechPermission threw:`, e);
    }
    if (!mountedRef.current) return;
    setPhase("waiting_tap");
  }, []);

  // ==================== TAP HINT (Passo 4, dopo 5s senza tap) ====================
  useEffect(() => {
    if (phase !== "waiting_tap") return;
    tapHintTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setShowTapHint(true);
      Animated.timing(tapHintOpacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 5000);
    return () => {
      if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
    };
  }, [phase, tapHintOpacity]);

  // ==================== LIFECYCLE ====================
  useEffect(() => {
    mountedRef.current = true;
    // Fade-in schermo, poi parte tutto
    Animated.timing(screenOpacity, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start(() => {
      if (mountedRef.current) playIntroClip();
    });
    // Ring pulse loop per i coach-mark
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
      if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
      try {
        if (currentPlayerRef.current) {
          currentPlayerRef.current.pause?.();
          currentPlayerRef.current.remove?.();
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fade-in card quando entra in fase coach
  useEffect(() => {
    if (
      phase === "coach_orb" ||
      phase === "coach_hf" ||
      phase === "coach_text" ||
      phase === "coach_la" ||
      phase === "coach_settings"
    ) {
      cardOpacity.setValue(0);
      Animated.timing(cardOpacity, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }).start();
    }
  }, [phase, cardOpacity]);

  // Fade-in progressivo degli elementi (ognuno rimane visibile per i successivi)
  useEffect(() => {
    if (phase === "coach_hf") {
      Animated.timing(hfOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    } else if (phase === "coach_text") {
      Animated.timing(textBarOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    } else if (phase === "coach_la") {
      Animated.timing(laOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    } else if (phase === "coach_settings") {
      Animated.timing(settingsOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    }
  }, [phase, hfOpacity, textBarOpacity, laOpacity, settingsOpacity]);

  // ==================== ADVANCE ====================
  const onOrbTap = useCallback(() => {
    if (phase !== "waiting_tap") return;
    if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
    setShowTapHint(false);
    setPhase("coach_orb");
  }, [phase]);

  const advance = useCallback(() => {
    if (phase === "coach_orb") setPhase("coach_hf");
    else if (phase === "coach_hf") setPhase("coach_text");
    else if (phase === "coach_text") setPhase("coach_la");
    else if (phase === "coach_la") setPhase("coach_settings");
    else if (phase === "coach_settings") doClose();
  }, [phase]);

  // ==================== CLOSE ====================
  const doClose = useCallback(async () => {
    setPhase("closing");
    try {
      await SecureStore.setItemAsync("intro_premium_seen_at", String(Date.now()));
    } catch (e) {
      console.warn(`${TAG} SecureStore set failed:`, e);
    }
    api.markIntroPremiumSeen().catch((e: any) => {
      console.warn(`${TAG} backend mark-seen failed:`, e);
    });
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

  // ==================== COACH-MARK RENDER ====================
  // Card sotto/sopra il target + ring pulsante attorno al target.
  // NON usa overlay a "buco": qui gli elementi target sono DISEGNATI DA NOI,
  // quindi lo schermo è tutto nostro — basta una card + un ring visibile.
  const renderCard = (
    targetRect: Rect,
    title: string,
    body: string,
    isCircle: boolean,
    showRing: boolean = true
  ) => {
    const pad = isCircle ? 8 : 6;
    const spot: Rect = {
      x: targetRect.x - pad,
      y: targetRect.y - pad,
      w: targetRect.w + pad * 2,
      h: targetRect.h + pad * 2,
    };
    const radius = isCircle ? spot.w / 2 : 14;

    // Posiziona la card sotto lo spotlight se sta nella metà alta, sopra altrimenti
    const cardY =
      spot.y + spot.h / 2 < H / 2
        ? Math.min(spot.y + spot.h + 20, H - insets.bottom - 220)
        : Math.max(spot.y - 220, insets.top + 40);

    const ringScale = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
    const ringOpacityAnim = ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 0.25] });

    return (
      <TouchableOpacity
        activeOpacity={1}
        onPress={advance}
        style={styles.tapLayer}
      >
        {showRing && (
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
              opacity: ringOpacityAnim,
              transform: [{ scale: ringScale }],
            }}
            pointerEvents="none"
          />
        )}
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
  // Ridisegniamo qui gli elementi che sulla home vera ci sono davvero,
  // per posizionarli identici e farli comparire in fade-in al loro turno.
  const renderFakeHandsFree = () => (
    <Animated.View
      style={[
        styles.fakeButton,
        {
          left: RECTS.hf.x,
          top: RECTS.hf.y,
          width: RECTS.hf.w,
          height: RECTS.hf.h,
          borderRadius: RECTS.hf.w / 2,
          opacity: hfOpacity,
        },
      ]}
      pointerEvents="none"
    >
      <Ionicons name="hand-left-outline" size={20} color="#F0F0F5" />
    </Animated.View>
  );

  const renderFakeTextBar = () => (
    <Animated.View
      style={[
        styles.fakeTextBar,
        {
          left: RECTS.text.x,
          top: RECTS.text.y,
          width: RECTS.text.w,
          height: RECTS.text.h,
          opacity: textBarOpacity,
        },
      ]}
      pointerEvents="none"
    >
      <Ionicons
        name="chatbubble-ellipses-outline"
        size={22}
        color="rgba(240,240,245,0.55)"
      />
      <Text style={styles.fakeTextBarLabel}>Scrivimi…</Text>
    </Animated.View>
  );

  const renderFakeLA = () => (
    <Animated.View
      style={[
        styles.fakeLA,
        {
          left: RECTS.la.x,
          top: RECTS.la.y,
          width: RECTS.la.w,
          height: RECTS.la.h,
          opacity: laOpacity,
        },
      ]}
      pointerEvents="none"
    >
      <Text style={styles.fakeLAText}>Lascia andare</Text>
    </Animated.View>
  );

  const renderFakeSettings = () => (
    <Animated.View
      style={[
        styles.fakeButton,
        {
          left: RECTS.settings.x,
          top: RECTS.settings.y,
          width: RECTS.settings.w,
          height: RECTS.settings.h,
          borderRadius: RECTS.settings.w / 2,
          opacity: settingsOpacity,
        },
      ]}
      pointerEvents="none"
    >
      <Ionicons name="ellipsis-horizontal" size={22} color="#F0F0F5" />
    </Animated.View>
  );

  // ==================== RENDER ====================
  const orbAreaTappable =
    phase === "waiting_tap" ? { pointerEvents: "auto" as const } : { pointerEvents: "none" as const };

  return (
    <Animated.View style={[styles.screen, { opacity: screenOpacity }]}>
      {/* Orb centrale — visibile in tutte le fasi tranne closing */}
      <View style={styles.orbWrap} {...orbAreaTappable}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={onOrbTap}
          disabled={phase !== "waiting_tap"}
          style={{ width: orbSize, height: orbSize, alignItems: "center", justifyContent: "center" }}
        >
          <EclipseOrb
            size={orbSize}
            status={orbState === "speaking" ? "speaking" : "idle"}
            tone="warm"
          />
        </TouchableOpacity>
      </View>

      {/* Tap hint (Passo 4, dopo 5s senza tap) */}
      {showTapHint && phase === "waiting_tap" && (
        <Animated.View
          style={[
            styles.tapHint,
            {
              top: orbCY - orbSize / 2 - 44,
              opacity: tapHintOpacity,
            },
          ]}
          pointerEvents="none"
        >
          <Text style={styles.tapHintText}>Toccami</Text>
        </Animated.View>
      )}

      {/* Elementi UI progressivi (persistono una volta apparsi) */}
      {(phase === "coach_hf" ||
        phase === "coach_text" ||
        phase === "coach_la" ||
        phase === "coach_settings") &&
        renderFakeHandsFree()}
      {(phase === "coach_text" ||
        phase === "coach_la" ||
        phase === "coach_settings") &&
        renderFakeTextBar()}
      {(phase === "coach_la" || phase === "coach_settings") && renderFakeLA()}
      {phase === "coach_settings" && renderFakeSettings()}

      {/* Coach-mark cards (una per phase) */}
      {phase === "coach_orb" &&
        renderCard(
          RECTS.orb,
          "Toccami",
          "Il secondo tocco è per fermarmi.",
          true,
          false // niente ring: l'orb è già l'attenzione, non serve incorniciarlo
        )}
      {phase === "coach_hf" &&
        renderCard(
          RECTS.hf,
          "Mani libere",
          "Se lo attivi ti ascolto in continuo. Non serve toccarmi.",
          true
        )}
      {phase === "coach_text" &&
        renderCard(
          RECTS.text,
          "Scrittura",
          "Se non puoi parlare, scrivi. Rispondo in silenzio.",
          false
        )}
      {phase === "coach_la" &&
        renderCard(
          RECTS.la,
          "Lascia andare",
          "Tocca per tornare al mio cuore.",
          false
        )}
      {phase === "coach_settings" &&
        renderCard(
          RECTS.settings,
          "Impostazioni",
          "Da qui cambi voce, tema, memoria.",
          true
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
  tapHint: {
    position: "absolute",
    alignSelf: "center",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  tapHintText: {
    color: "rgba(240,240,245,0.65)",
    fontSize: 14,
    fontStyle: "italic",
    letterSpacing: 0.5,
  },
  tapLayer: {
    ...StyleSheet.absoluteFillObject,
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
      android: { elevation: 12 },
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
  // Elementi UI ridisegnati (fake della home vera)
  fakeButton: {
    position: "absolute",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  fakeTextBar: {
    position: "absolute",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 10,
  },
  fakeTextBarLabel: {
    color: "rgba(240,240,245,0.55)",
    fontSize: 15,
  },
  fakeLA: {
    position: "absolute",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  fakeLAText: {
    color: "#F0F0F5",
    fontSize: 13.5,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
});
