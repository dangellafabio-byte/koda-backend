/**
 * MicroDemoKoda.tsx — Micro-demo vocale post-Heart-Reveal (Fabio 2026-08-22).
 *
 * Fase D del piano onboarding V3. Attivata cliccando "Ascolta la mia voce"
 * sulla schermata HeartVoiceReveal.
 *
 * ==== VINCOLI ARCHITETTURALI ====
 *   • Max 3 turni COMPLETI (user→koda→user→koda→user→koda)
 *   • Timer max 90s dal primo turno completato
 *   • Rate-limit 1x per 24h per DEVICE (SecureStore.microdemo_last_at)
 *     → consumato SOLO se ≥1 turno completo, no consumo su abort precoce
 *   • Backend TTS: usa flag `microdemo: true` per bypassare trial enforcement
 *   • Backend converse: usa `ephemeral: true` per NON salvare in timeline
 *   • Copy fissi (approvazione Fabio, no modifiche senza consenso esplicito):
 *       Apertura Koda: "Eccomi. Dimmi qualcosa, quello che vuoi."
 *       Chiusura Koda: "Per ora è tutto. Ma possiamo continuare, se vuoi."
 *
 * ==== STATE MACHINE ====
 *   opening   → play clip microdemo_open, poi listening
 *   listening → STT nativo (VAD end-of-speech)
 *   thinking  → POST /api/converse ephemeral → riceve ai_entry
 *   speaking  → POST /api/tts (microdemo=true) → play MP3 blob
 *   [check turno count / timer → listening OR closing]
 *   closing   → play clip microdemo_close
 *   done      → salva SecureStore + navigate /paywall?variant=post-demo
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
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";
import EclipseOrb, { OrbStatus, OrbTone } from "../components/EclipseOrb";
import { API_BASE } from "../lib/api";
import { getAuthToken } from "../lib/authToken";

const TAG = "KODA_MICRODEMO";

const CLIP_OPEN = require("../assets/sounds/intro/microdemo_open-cielo.mp3");
const CLIP_CLOSE = require("../assets/sounds/intro/microdemo_close-cielo.mp3");
const VOICE_CIELO_ID = "POuqf18evoXOKIqV2Px7";

const MAX_TURNS = 3;
const MAX_DURATION_MS = 90_000;
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24h

const { width: WINDOW_WIDTH } = Dimensions.get("window");
const ORB_SIZE = Math.min(WINDOW_WIDTH * 0.78, 360);

type Phase = "checking" | "opening" | "listening" | "thinking" | "speaking" | "closing" | "done";

function orbPropsFor(phase: Phase): { status: OrbStatus; tone: OrbTone | null } {
  switch (phase) {
    case "opening":
    case "speaking":
    case "closing":
      return { status: "speaking", tone: "warm" };
    case "listening":
      return { status: "recording", tone: null };
    case "thinking":
      return { status: "thinking", tone: null };
    default:
      return { status: "idle", tone: null };
  }
}

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

async function configureAudioForRecording(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (e) {
    console.warn(`[${TAG}] configureAudioForRecording failed:`, e);
  }
}

function normalizeVolume(rawValue: number): number {
  const clamped = Math.max(-2, Math.min(10, rawValue));
  const linear = (clamped + 2) / 12;
  return Math.sqrt(Math.max(0, linear));
}

export default function MicroDemoKoda() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("checking");
  const [turnCount, setTurnCount] = useState(0);

  const playerRef = useRef<AudioPlayer | null>(null);
  const sttSubsRef = useRef<{ remove: () => void }[]>([]);
  const sttActiveRef = useRef(false);
  const listenSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstTurnStartedAtRef = useRef<number | null>(null); // per timer 90s (parte dopo primo turno completo)
  const turnsCompletedRef = useRef(0); // sincronizzato con turnCount, per closure
  const abortRef = useRef(false);
  const mountedRef = useRef(true);

  const screenOpacity = useRef(new Animated.Value(0)).current;
  const orbOpacity = useRef(new Animated.Value(0)).current;
  const orbScale = useRef(new Animated.Value(0.3)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const volAnim = useRef(new Animated.Value(0)).current;

  // ==================== CLEANUP ====================
  const stopSTT = useCallback(() => {
    sttActiveRef.current = false;
    if (listenSafetyRef.current) {
      clearTimeout(listenSafetyRef.current);
      listenSafetyRef.current = null;
    }
    for (const s of sttSubsRef.current) {
      try { s.remove(); } catch {}
    }
    sttSubsRef.current = [];
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
  }, []);

  const stopPlayback = useCallback(() => {
    try { playerRef.current?.remove(); } catch {}
    playerRef.current = null;
  }, []);

  const cleanupAll = useCallback(() => {
    stopSTT();
    stopPlayback();
  }, [stopSTT, stopPlayback]);

  // ==================== PERSISTENZA RATE-LIMIT ====================
  // Consuma solo se ≥1 turno completato (risposta punto 2 utente).
  const consumeRateLimit = useCallback(async () => {
    if (turnsCompletedRef.current < 1) {
      console.log(`[${TAG}] rate-limit NOT consumed (turns=${turnsCompletedRef.current} < 1)`);
      return;
    }
    try {
      await SecureStore.setItemAsync("microdemo_last_at", String(Date.now()));
      console.log(`[${TAG}] rate-limit consumed (turns=${turnsCompletedRef.current})`);
    } catch (e) {
      console.warn(`[${TAG}] consumeRateLimit failed:`, e);
    }
  }, []);

  // Naviga al paywall dopo aver chiuso
  const navigateToPaywall = useCallback(() => {
    if (!mountedRef.current) return;
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 600,
      useNativeDriver: true,
    }).start(() => {
      if (!mountedRef.current) return;
      try {
        router.replace("/paywall?variant=post-demo");
      } catch (e) {
        console.warn(`[${TAG}] navigation to paywall failed:`, e);
      }
    });
  }, [screenOpacity, router]);

  // ==================== HELPERS FETCH ====================
  const fetchConverse = useCallback(async (userText: string): Promise<{ text: string; tone: string } | null> => {
    try {
      const tok = getAuthToken();
      const r = await fetch(`${API_BASE}/converse`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ text: userText, ephemeral: true }),
      });
      if (!r.ok) {
        console.warn(`[${TAG}] converse HTTP ${r.status}`);
        return null;
      }
      const data = await r.json();
      const ai = data?.ai_entry;
      if (!ai?.text) return null;
      return { text: ai.text, tone: ai.tone || "warm" };
    } catch (e) {
      console.warn(`[${TAG}] converse fetch failed:`, e);
      return null;
    }
  }, []);

  const fetchTTS = useCallback(async (text: string, tone: string): Promise<string | null> => {
    try {
      const tok = getAuthToken();
      const r = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          text,
          voice_id: VOICE_CIELO_ID,
          tone,
          microdemo: true, // bypass trial enforcement per la demo (backend consapevole)
        }),
      });
      if (!r.ok) {
        console.warn(`[${TAG}] tts HTTP ${r.status}`);
        return null;
      }
      const blob = await r.blob();
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onloadend = () => {
          const result = reader.result;
          resolve(typeof result === "string" ? result : null);
        };
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.warn(`[${TAG}] tts fetch failed:`, e);
      return null;
    }
  }, []);

  // ==================== PLAY BUNDLED / URI ====================
  const playClipUri = useCallback((uri: string, onDone: () => void) => {
    try {
      const player = createAudioPlayer({ uri }, { updateInterval: 100 });
      playerRef.current = player;
      const onStatus = (status: { didJustFinish?: boolean }) => {
        if (status.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          onDone();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();
    } catch (e) {
      console.warn(`[${TAG}] playClipUri failed:`, e);
      setTimeout(onDone, 400);
    }
  }, []);

  const playClipBundled = useCallback((clipSource: number, onDone: () => void) => {
    try {
      const player = createAudioPlayer(clipSource, { updateInterval: 100 });
      playerRef.current = player;
      const onStatus = (status: { didJustFinish?: boolean }) => {
        if (status.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          onDone();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();
    } catch (e) {
      console.warn(`[${TAG}] playClipBundled failed:`, e);
      setTimeout(onDone, 400);
    }
  }, []);

  // ==================== STT (con VAD end-of-speech nativo) ====================
  const startSTT = useCallback((onFinal: (text: string) => void, onFail: () => void) => {
    if (sttActiveRef.current) return;
    sttActiveRef.current = true;

    let captured = "";
    let capturedFinal = false;

    const startOpts: any = {
      lang: "it-IT",
      interimResults: true,
      continuous: Platform.OS === "android",
      maxAlternatives: 1,
      addsPunctuation: true,
      requiresOnDeviceRecognition: Platform.OS === "ios",
      volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
    };
    if (Platform.OS === "ios") {
      startOpts.iosCategory = {
        category: "playAndRecord",
        categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
        mode: "measurement",
      };
    }
    if (Platform.OS === "android") {
      startOpts.androidIntentOptions = {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2500,
        EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 500,
      };
    }

    const finalize = (text: string) => {
      if (!sttActiveRef.current) return;
      capturedFinal = true;
      stopSTT();
      onFinal(text.trim());
    };

    const giveUp = () => {
      stopSTT();
      onFail();
    };

    const subResult = ExpoSpeechRecognitionModule.addListener(
      "result",
      (evt: ExpoSpeechRecognitionResultEvent) => {
        const first = evt.results?.[0];
        if (!first) return;
        const text = first.transcript || "";
        if (text.length > 0) captured = text;
        if (evt.isFinal && text.trim().length > 0) {
          finalize(text);
        }
      }
    );
    const subError = ExpoSpeechRecognitionModule.addListener(
      "error",
      (evt: ExpoSpeechRecognitionErrorEvent) => {
        if (evt.error === "aborted") return;
        if (evt.error === "no-speech") {
          if (captured.trim().length > 0) finalize(captured);
          else giveUp();
          return;
        }
        if (!capturedFinal) giveUp();
      }
    );
    const subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
      if (capturedFinal) return;
      if (captured.trim().length > 0) finalize(captured);
      else if (sttActiveRef.current) giveUp();
    });
    const subVolume = ExpoSpeechRecognitionModule.addListener(
      "volumechange",
      (evt: { value?: number }) => {
        const raw = typeof evt?.value === "number" ? evt.value : -2;
        const norm = normalizeVolume(raw);
        Animated.timing(volAnim, {
          toValue: norm,
          duration: 120,
          useNativeDriver: true,
        }).start();
      }
    );
    sttSubsRef.current = [subResult, subError, subEnd, subVolume];

    try {
      ExpoSpeechRecognitionModule.start(startOpts);
    } catch (e) {
      console.warn(`[${TAG}] STT start failed:`, e);
      stopSTT();
      onFail();
      return;
    }

    // Safety net 20s per turno di demo (breve — se non parlano, chiudi)
    listenSafetyRef.current = setTimeout(() => {
      if (capturedFinal) return;
      console.warn(`[${TAG}] STT safety-net (20s)`);
      if (captured.trim().length > 0) finalize(captured);
      else giveUp();
    }, 20000);
  }, [stopSTT, volAnim]);

  // ==================== TURN CONDUCTOR ====================
  // Un turno completo: user parla → converse → TTS → play.
  // Alla fine del play → checkContinueOrClose.
  const runTurn = useCallback(async () => {
    if (abortRef.current || !mountedRef.current) return;

    // 1. LISTEN
    setPhase("listening");
    await configureAudioForRecording();
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        console.warn(`[${TAG}] mic permission not granted → close demo`);
        setPhase("closing");
        return;
      }
    } catch (e) {
      console.warn(`[${TAG}] mic permission threw:`, e);
      setPhase("closing");
      return;
    }

    const userText = await new Promise<string | null>((resolve) => {
      startSTT(
        (text) => resolve(text || null),
        () => resolve(null)
      );
    });

    if (abortRef.current || !mountedRef.current) return;

    if (!userText) {
      console.log(`[${TAG}] no user text → close demo`);
      setPhase("closing");
      return;
    }

    console.log(`[${TAG}] turn user text: "${userText}"`);

    // 2. THINKING (converse)
    setPhase("thinking");
    const aiReply = await fetchConverse(userText);
    if (abortRef.current || !mountedRef.current) return;

    if (!aiReply?.text) {
      console.warn(`[${TAG}] converse failed → close demo`);
      setPhase("closing");
      return;
    }

    // 3. SPEAKING (TTS)
    setPhase("speaking");
    await configureAudioForPlayback();
    const ttsUri = await fetchTTS(aiReply.text, aiReply.tone);
    if (abortRef.current || !mountedRef.current) return;

    if (!ttsUri) {
      console.warn(`[${TAG}] tts failed → close demo`);
      setPhase("closing");
      return;
    }

    await new Promise<void>((resolve) => {
      playClipUri(ttsUri, () => resolve());
    });

    if (abortRef.current || !mountedRef.current) return;

    // 4. TURN COMPLETED
    turnsCompletedRef.current += 1;
    setTurnCount(turnsCompletedRef.current);
    console.log(`[${TAG}] turn completed (count=${turnsCompletedRef.current}/${MAX_TURNS})`);

    // Start global timer al primo turno completato
    if (firstTurnStartedAtRef.current === null) {
      firstTurnStartedAtRef.current = Date.now();
    }

    // 5. CHECK CONTINUE OR CLOSE
    const elapsed = Date.now() - (firstTurnStartedAtRef.current || Date.now());
    if (turnsCompletedRef.current >= MAX_TURNS || elapsed >= MAX_DURATION_MS) {
      console.log(`[${TAG}] demo end reached (turns=${turnsCompletedRef.current} elapsed=${(elapsed / 1000).toFixed(1)}s)`);
      setPhase("closing");
      return;
    }

    // Altrimenti: nuovo turno
    runTurn();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSTT, fetchConverse, fetchTTS, playClipUri]);

  // ==================== PHASE EXECUTOR ====================
  useEffect(() => {
    if (phase === "opening") {
      configureAudioForPlayback().then(() => {
        if (abortRef.current || !mountedRef.current) return;
        console.log(`[${TAG}] play open clip`);
        playClipBundled(CLIP_OPEN, () => {
          if (abortRef.current || !mountedRef.current) return;
          runTurn();
        });
      });
    } else if (phase === "closing") {
      // Play chiusura + persistenza rate-limit + navigate paywall
      configureAudioForPlayback().then(() => {
        if (abortRef.current || !mountedRef.current) return;
        console.log(`[${TAG}] play close clip`);
        playClipBundled(CLIP_CLOSE, async () => {
          if (abortRef.current || !mountedRef.current) return;
          await consumeRateLimit();
          setPhase("done");
          navigateToPaywall();
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ==================== MOUNT: rate-limit check + start ====================
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const lastAtStr = await SecureStore.getItemAsync("microdemo_last_at");
        const lastAt = lastAtStr ? parseInt(lastAtStr, 10) : 0;
        const now = Date.now();
        if (lastAt && now - lastAt < RATE_LIMIT_MS) {
          const hoursLeft = Math.ceil((RATE_LIMIT_MS - (now - lastAt)) / (60 * 60 * 1000));
          console.log(`[${TAG}] rate-limit active (last=${lastAt}, hoursLeft=${hoursLeft}) → paywall`);
          Alert.alert(
            "Riprova domani",
            `Puoi riascoltarmi tra ~${hoursLeft} ore. Nel frattempo, Lascia Andare resta tuo.`,
            [{ text: "Va bene" }],
            { cancelable: false }
          );
          setPhase("done");
          navigateToPaywall();
          return;
        }
      } catch (e) {
        console.warn(`[${TAG}] rate-limit read failed (proceeding):`, e);
      }
      if (!mountedRef.current) return;
      // Fade-in schermata + orb
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
      setPhase("opening");
    })();
    // Breathe loop
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
    return () => {
      mountedRef.current = false;
      abortRef.current = true;
      breatheLoop.stop();
      cleanupAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hardware back (Android) = abort demo, consuma rate-limit se ≥1 turno
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onAbort();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onAbort = useCallback(async () => {
    if (abortRef.current) return;
    abortRef.current = true;
    console.log(`[${TAG}] user abort (turns=${turnsCompletedRef.current})`);
    cleanupAll();
    await consumeRateLimit(); // no-op se turni < 1
    navigateToPaywall();
  }, [cleanupAll, consumeRateLimit, navigateToPaywall]);

  // ==================== RENDER ====================
  const orbProps = useMemo(() => orbPropsFor(phase), [phase]);
  const isListening = phase === "listening";
  const breatheScale = useMemo(
    () => breathe.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.07] }),
    [breathe]
  );
  const vuScale = useMemo(
    () => volAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }),
    [volAnim]
  );

  return (
    <Animated.View style={[styles.root, { opacity: screenOpacity }]}>
      {/* X in alto a destra — abort */}
      <TouchableOpacity
        onPress={onAbort}
        style={[styles.abortBtn, { top: Math.max(insets.top + 12, 24) }]}
        hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Interrompi demo"
        testID="microdemo-abort"
      >
        <Ionicons name="close" size={20} color="rgba(226,232,240,0.5)" />
      </TouchableOpacity>

      {/* Orb centrato */}
      <View style={styles.centerContainer}>
        <Animated.View
          style={{
            opacity: orbOpacity,
            transform: isListening
              ? [{ scale: orbScale }, { scale: breatheScale }, { scale: vuScale }]
              : [{ scale: orbScale }, { scale: breatheScale }],
          }}
        >
          <EclipseOrb
            status={orbProps.status}
            tone={orbProps.tone}
            size={ORB_SIZE}
          />
        </Animated.View>
      </View>

      {/* Turno counter discreto in basso (opzionale, per feedback) */}
      {phase !== "checking" && phase !== "done" && (
        <View
          pointerEvents="none"
          style={[
            styles.counterBox,
            { bottom: Math.max(insets.bottom + 20, 32) },
          ]}
        >
          <Text style={styles.counterText}>
            {turnCount} / {MAX_TURNS}
          </Text>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0F0F1A",
  },
  abortBtn: {
    position: "absolute",
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    zIndex: 10,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    // Allineamento pixel-perfect con home Page 0 (Fabio 2026-08-23):
    // stesso paddingTop del wrapper home (index.tsx riga ~5247) →
    // orb sempre nella stessa posizione, senza salti tra sessioni.
    paddingTop: 90,
  },
  counterBox: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  counterText: {
    fontSize: 12,
    color: "rgba(226,232,240,0.4)",
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
  },
});
