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
  // === FIX 2026-08-27 v65.12 — Ring/orb allineamento Android (Fabio) ========
  // Prima (v65.4): measureInWindow orb → RECT assoluto. Su Android edge-to-edge
  // la Y ritornata INCLUDE lo status bar mentre il ROOT del componente (che è
  // parent del ring) parte SOTTO lo status bar → mismatch di ~24-32px.
  // Ora misuriamo ANCHE il ROOT e sottraiamo la sua Y, ottenendo coordinate
  // RELATIVE al root — così ring e orb condividono lo stesso sistema di
  // riferimento su qualsiasi configurazione (iOS notch, Android edge-to-edge,
  // Android status bar bianca, foldable, ecc.).
  const orbRefEl = useRef<any>(null);
  const rootRefEl = useRef<any>(null);
  const [measuredOrbRect, setMeasuredOrbRect] = useState<Rect | null>(null);

  // ==================== RECTS (coerenti con home reale) ====================
  // === FIX ECLISSI CENTRATA (Fabio 2026-08-24) ==========================
  // Prima: orbCY = H/2 + 28 per matchare l'offset home Page 0 (paddingTop:90
  // + gap:18 + label 16 → shift ~28px in basso). Adesso la home è stata
  // ricentrata a H/2 → l'orb virtuale per posizionare i coach-mark labels
  // ora è ANCHE lui a H/2 esatto.
  const headerCY = Math.max(insets.top + 28, 70) + 22;
  const orbSize = Math.min(W * 0.78, 360);
  const orbCY = H / 2;

  const RECTS: Record<"orb" | "hf" | "la" | "settings", Rect> = {
    orb: measuredOrbRect || { x: W / 2 - orbSize / 2, y: orbCY - orbSize / 2, w: orbSize, h: orbSize },
    hf: { x: 14, y: headerCY - 22, w: 44, h: 44 },
    la: { x: W / 2 - 95, y: Math.max(insets.top + 100, 150), w: 190, h: 44 },
    settings: { x: W - 58, y: headerCY - 22, w: 44, h: 44 },
  };

  // === FIX 2026-08-27 v65.12 — Misura RELATIVE al root (fix Android) =====
  // Misuriamo sia orb che root, poi facciamo la differenza. Se root non è
  // ancora montato (edge case), fallback a coordinate assolute (v65.4 style).
  useEffect(() => {
    let done = false;
    const measureNow = () => {
      if (done || !mountedRef.current) return;
      try {
        const orbNode = orbRefEl.current;
        const rootNode = rootRefEl.current;
        if (!orbNode) return;
        orbNode.measureInWindow?.((ox: number, oy: number, ow: number, oh: number) => {
          if (!mountedRef.current || !(ow > 0 && oh > 0)) return;
          if (rootNode?.measureInWindow) {
            rootNode.measureInWindow((rx: number, ry: number) => {
              if (!mountedRef.current) return;
              const relX = ox - rx;
              const relY = oy - ry;
              console.log(`${TAG} orb measured RELATIVE: root=(${rx.toFixed(0)},${ry.toFixed(0)}) orb=(${ox.toFixed(0)},${oy.toFixed(0)}) rel=(${relX.toFixed(0)},${relY.toFixed(0)}) size=${ow.toFixed(0)}x${oh.toFixed(0)}`);
              setMeasuredOrbRect({ x: relX, y: relY, w: ow, h: oh });
              done = true;
            });
          } else {
            // Fallback: coordinate assolute (comportamento v65.4)
            console.log(`${TAG} orb measured ABS (root ref missing): x=${ox.toFixed(0)} y=${oy.toFixed(0)}`);
            setMeasuredOrbRect({ x: ox, y: oy, w: ow, h: oh });
            done = true;
          }
        });
      } catch (e) { console.warn(`${TAG} measure failed:`, e); }
    };
    // Doppio tentativo: 400ms (primo layout) e 900ms (se il primo era prematuro)
    const t1 = setTimeout(measureNow, 400);
    const t2 = setTimeout(measureNow, 900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // ==================== AUDIO ====================
  const configureAudio = useCallback(async () => {
    try {
      // === FIX 2026-08-27 v65.5 — Audio Android fix (Fabio) =================
      // Prima: solo playsInSilentMode:true. Su Android alcuni build ignorano
      // la clip se allowsRecording è residuo di una sessione mic precedente
      // (Stefania viene dopo il paywall/router, non da un fresh boot puro).
      // Aggiungiamo interruptionMode + interruptionModeAndroid espliciti.
      // Su iOS il comportamento resta invariato (interruptionMode:duckOthers
      // è già il default effettivo su iOS).
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: "duckOthers",
        interruptionModeAndroid: "duckOthers",
        shouldRouteThroughEarpiece: false,
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
      // === FIX 2026-08-27 v65.12 — Volume esplicito + wait load (Android) =====
      // Su Android alcuni device inizializzano il player con volume<1.0
      // (specialmente se la sessione audio precedente aveva ducking attivo).
      // Forziamo full volume subito dopo la creazione.
      try { (player as any).volume = 1.0; } catch {}
      // Aspettiamo che il player sia caricato prima di play. Su Android
      // createAudioPlayer è async internamente e `play()` prima del load
      // silenzia il primo turno di intro (bug osservato Stefania 2026-08-27).
      // Polling: max 2s (20 × 100ms).
      for (let i = 0; i < 20; i++) {
        if ((player as any).isLoaded === true) break;
        await new Promise((r) => setTimeout(r, 100));
        if (!mountedRef.current) return;
      }
      const onStatus = (s: { didJustFinish?: boolean }) => {
        if (s.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          onFinish();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      // Volume di nuovo dopo load (alcuni Android lo resettano)
      try { (player as any).volume = 1.0; } catch {}
      player.play();
      console.log(`${TAG} clip started (isLoaded=${(player as any).isLoaded}, volume=${(player as any).volume})`);
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
    // === FIX 2026-08-27 v65.7 — Loop /intro-premium (Fabio/Stefania) =========
    // Prima: SecureStore.intro_premium_seen_at veniva scritto SOLO dentro
    // IntroPremiumFinalStep.finish() (tap "Ho capito"). Ma la home router
    // intro-premium (index.tsx ~1226) legge SecureStore al mount: se vuoto,
    // considera l'intro "needed" e RIDIRIGE a /intro-premium PRIMA che
    // l'overlay finale possa mostrare il tap → LOOP infinito osservato
    // su Android in produzione da Stefania (2026-08-27).
    // Ora scriviamo il mirror SecureStore GIÀ ORA (fine coach_swipe), così
    // il router locale trova "seen" e non ridirige. Il backend viene
    // marcato al tap "Ho capito" dell'overlay finale (invariato).
    // Fallback safety: se l'utente killa l'app durante l'overlay finale,
    // al prossimo boot il mirror locale dirà seen → nessun re-loop.
    // Trade-off accettato: perde la clip di chiusura Cielo in caso di kill,
    // ma non resta bloccata nell'intro.
    (async () => {
      try {
        await SecureStore.setItemAsync("intro_premium_seen_at", String(Date.now()));
      } catch (e) { console.warn(`${TAG} early SecureStore mark failed:`, e); }
    })();
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
    <Animated.View ref={rootRefEl} style={[styles.screen, { opacity: screenOpacity }]}>
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
            ref={orbRefEl}
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

      {/* Coach-mark cards (fuori dallo swipe wrapper).
          Ring/evidenziature RIMESSE (Fabio 2026-08-23): l'utente le vuole
          per marcare visivamente quale elemento la card sta indicando. */}
      {phase === "coach_orb" &&
        renderCard(RECTS.orb, "Toccami", "Il secondo tocco è per fermarmi.", true, true)}
      {phase === "coach_hf" &&
        renderCard(RECTS.hf, "Mani libere", "Se lo attivi ti ascolto in continuo. Non serve toccarmi.", true, true)}
      {phase === "coach_la" &&
        renderCard(RECTS.la, "Lascia andare", "Tocca per tornare al mio cuore.", false, true)}
      {phase === "coach_settings" &&
        renderCard(RECTS.settings, "Impostazioni", "Da qui cambi voce, tema, memoria.", true, true)}
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
