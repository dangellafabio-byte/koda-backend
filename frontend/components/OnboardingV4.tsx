/**
 * components/OnboardingV4.tsx — v66.3 (Fabio 2026-06-16)
 * -----------------------------------------------------------------------------
 * NUOVA sequenza di onboarding a 6 step. Sostituisce OllenyaIntroV3 +
 * AppWelcomeIntro (deprecati). Spec Fabio 2026-06-16, punti 1-6:
 *
 *   0. (fuori da qui) /legal-consent — disclaimer + checkbox unico.
 *   1. Eclissi speaking, TTS "Ciao, io sono Ollenya, sono una presenza…"
 *      + testo sincrono a schermo + richiesta mic nativa DOPO l'inizio TTS.
 *   2. STT nome utente (timeout 10s), glow recording→speaking, poi
 *      "Piacere di conoscerti, [Nome]. Voglio mostrarti come funziona."
 *   3. Scrim + "Quando vuoi, io sono qui." → dissolve → demo scrittura
 *      REALE (1 messaggio, 1 risposta, poi avanti).
 *   4. Scrim + "Questa è la mia voce. Prova a dirmi qualcosa." → demo
 *      voce REALE (1 turno voce, 1 risposta TTS, poi avanti).
 *   5. Scrim + testo lungo LA → dissolve → eclissi con glow reattivo
 *      al mic (nessun testo, nessuna registrazione), X per chiudere.
 *   6. Scrim + "Perfetto, siamo arrivati alla fine…" → router.push('/paywall').
 *
 * Timeout unificato per step interattivi (1, 3-utente, 4-utente, 5): 10s
 * di inattività → skip avanti senza penalità.
 *
 * Voce: Turbo v2.5 forzata via microdemo=true nel body /api/tts. Tono
 * unico e coerente (feedback Fabio: mai altalenante tra emotivo/esplicativo).
 *
 * Il flag `intro_v3_completed_at` viene scritto al ROUTING verso /paywall
 * (step 6), NON al load — così un utente che kill l'app a metà rivedrà
 * l'intro al riavvio.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  Dimensions,
  StatusBar,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { createAudioPlayer, setAudioModeAsync, AudioModule, useAudioRecorder, RecordingPresets } from "expo-audio";
import type { AudioPlayer } from "expo-audio";

import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionResultEvent,
  type ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";

import EclipseOrb from "./EclipseOrb";
import type { OrbStatus } from "./EclipseOrb";
import { api, API_BASE } from "../lib/api";
import { getAuthToken } from "../lib/authToken";
import { ensureSpeechPermission } from "../lib/speechPermission";

const TAG = "[ONBOARDING_V4]";
const VOICE_CIELO_ID = "POuqf18evoXOKIqV2Px7";
const INACTIVITY_TIMEOUT_MS = 10_000;
const { width: SCREEN_W } = Dimensions.get("window");
const ORB_SIZE = Math.min(SCREEN_W * 0.6, 260);

// ==== Fasi (state machine) ==================================================
type Step =
  | "step1_speak_intro"      // TTS "Ciao... Come ti chiami?"
  | "step1_wait_mic"         // Attesa concessione microfono post-TTS
  | "step2_listen_name"      // STT nome (10s timeout)
  | "step2_confirm"          // TTS "Piacere... Voglio mostrarti come funziona"
  | "step3_scrim_write"      // Scrim + "Quando vuoi, io sono qui."
  | "step3_demo_write"       // TextInput + 1 turno (10s timeout)
  | "step4_scrim_voice"      // Scrim + "Questa è la mia voce..."
  | "step4_demo_voice"       // STT + 1 risposta TTS (10s timeout)
  | "step5_scrim_la"         // Scrim + testo lungo LA
  | "step5_demo_la"          // Eclissi mic-reattivo, X per chiudere
  | "step6_scrim_final"      // Scrim + "Perfetto, siamo arrivati..."
  | "done";                  // Marker → replace /paywall

// ==== Audio session helpers ================================================
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
  } catch (e) { console.warn(`${TAG} audio playback config failed:`, e); }
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
  } catch (e) { console.warn(`${TAG} audio recording config failed:`, e); }
}

// ==== Sub-component: Scrim overlay ==========================================
// Overlay a schermo intero con testo centrato che appare via fade-in,
// resta per un attimo, poi fade-out chiamando onDone. Se `dismissDurationMs`
// è null, resta finché il parent non lo smonta.
type ScrimProps = {
  text: string;
  onDone?: () => void;
  autoDismissMs?: number | null;
  showTapHint?: boolean;
};

const Scrim: React.FC<ScrimProps> = ({ text, onDone, autoDismissMs = 3200, showTapHint = false }) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    if (autoDismissMs != null && onDone) {
      const t = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 500, useNativeDriver: true })
          .start(({ finished }) => { if (finished) onDone(); });
      }, autoDismissMs);
      return () => clearTimeout(t);
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDismissMs]);

  const onTap = useCallback(() => {
    if (!onDone) return;
    Animated.timing(opacity, { toValue: 0, duration: 350, useNativeDriver: true })
      .start(({ finished }) => { if (finished) onDone(); });
  }, [opacity, onDone]);

  return (
    <Animated.View
      style={[styles.scrimOverlay, { opacity, paddingTop: insets.top, paddingBottom: insets.bottom }]}
      pointerEvents={showTapHint ? "auto" : "none"}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={showTapHint ? onTap : undefined}
        style={styles.scrimTouch}
      >
        <View style={styles.scrimContent}>
          <Text style={styles.scrimText}>{text}</Text>
          {showTapHint ? (
            <Text style={styles.scrimHint}>tocca per continuare</Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

// ==== Main component ========================================================
export default function OnboardingV4() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>("step1_speak_intro");
  const [userName, setUserName] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [orbStatus, setOrbStatus] = useState<OrbStatus>("idle");

  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPlayerRef = useRef<AudioPlayer | null>(null);
  // Subscriptions STT correnti (per cleanup ordinato)
  const sttSubsRef = useRef<{ remove: () => void }[]>([]);
  const sttActiveRef = useRef(false);
  const micRequestedRef = useRef(false);

  // Fade-in del root
  const rootOpacity = useRef(new Animated.Value(0)).current;
  // Breathing loop per la scala dell'orb
  const breathe = useRef(new Animated.Value(0)).current;

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const stopPlayer = useCallback(() => {
    const p = currentPlayerRef.current;
    if (p) {
      try { p.pause(); } catch {}
      try { p.remove(); } catch {}
      currentPlayerRef.current = null;
    }
  }, []);

  const stopStt = useCallback(() => {
    if (!sttActiveRef.current) return;
    sttActiveRef.current = false;
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
    for (const sub of sttSubsRef.current) {
      try { sub.remove(); } catch {}
    }
    sttSubsRef.current = [];
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    configureAudioForPlayback();
    Animated.timing(rootOpacity, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 2200, useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 2200, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      mountedRef.current = false;
      loop.stop();
      clearTimer();
      stopPlayer();
      stopStt();
    };
  }, [rootOpacity, breathe, clearTimer, stopPlayer, stopStt]);

  // ==== TTS runtime =========================================================
  const speak = useCallback(async (text: string, onDone: () => void) => {
    setSubtitle(text);
    setOrbStatus("speaking");
    try {
      const tok = getAuthToken();
      console.log(`${TAG} speak: "${text.slice(0, 60)}…"`);
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
          tone: "warm",
          microdemo: true, // bypass trial + forza turbo v2.5
        }),
      });
      if (!r.ok) {
        console.warn(`${TAG} tts HTTP ${r.status} → skip audio, keep subtitle`);
        // Fallback: teniamo il subtitle a schermo per ~2.5s, poi advance
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) onDone();
        }, 2500);
        return;
      }
      const blob = await r.blob();
      const dataUri = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onloadend = () => {
          const result = reader.result;
          resolve(typeof result === "string" ? result : null);
        };
        reader.readAsDataURL(blob);
      });
      if (!dataUri || !mountedRef.current) {
        timerRef.current = setTimeout(() => { if (mountedRef.current) onDone(); }, 400);
        return;
      }
      await configureAudioForPlayback();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!mountedRef.current) return;
      const player = createAudioPlayer({ uri: dataUri }, { updateInterval: 100 });
      currentPlayerRef.current = player;
      const onStatus = (status: { didJustFinish?: boolean }) => {
        if (status.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          onDone();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();
      // Safety net a 15s
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) { console.warn(`${TAG} speak safety-net`); onDone(); }
      }, 15_000);
    } catch (e) {
      console.warn(`${TAG} speak failed:`, e);
      timerRef.current = setTimeout(() => { if (mountedRef.current) onDone(); }, 400);
    }
  }, []);

  // ==== STT ===================================================================
  // Fa partire ExpoSpeechRecognition, ascolta fino a `maxMs`, callback su
  // transcript finale (o stringa vuota al timeout/errore). Semplificato
  // rispetto a OllenyaIntroV3: nessun restart cascade, one-shot.
  const listen = useCallback(
    async (opts: { maxMs?: number }, onTranscript: (text: string) => void) => {
      if (sttActiveRef.current) return;
      setOrbStatus("recording");
      await configureAudioForRecording();
      const perm = await ensureSpeechPermission();
      if (!perm.granted) {
        console.warn(`${TAG} listen no perm → skip`);
        onTranscript("");
        return;
      }
      let finalized = false;
      let captured = "";
      const finalize = (text: string) => {
        if (finalized) return;
        finalized = true;
        clearTimer();
        stopStt();
        onTranscript(text.trim());
      };
      const maxMs = opts.maxMs ?? INACTIVITY_TIMEOUT_MS;
      const startOpts: any = {
        lang: "it-IT",
        interimResults: true,
        continuous: Platform.OS === "android",
        maxAlternatives: 1,
        addsPunctuation: true,
        requiresOnDeviceRecognition: Platform.OS === "ios",
        volumeChangeEventOptions: { enabled: false, intervalMillis: 200 },
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
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 300,
        };
      }
      const subResult = ExpoSpeechRecognitionModule.addListener(
        "result",
        (evt: ExpoSpeechRecognitionResultEvent) => {
          const first = evt.results?.[0];
          if (!first) return;
          const text = first.transcript || "";
          if (text.length > 0) captured = text;
          if (evt.isFinal && text.trim().length > 0) {
            console.log(`${TAG} STT final: "${text}"`);
            finalize(text);
          }
        }
      );
      const subError = ExpoSpeechRecognitionModule.addListener(
        "error",
        (evt: ExpoSpeechRecognitionErrorEvent) => {
          if (evt.error === "aborted") return;
          console.log(`${TAG} STT error: ${evt.error}`);
          if (captured.trim().length > 0) finalize(captured);
          else finalize("");
        }
      );
      const subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
        if (finalized) return;
        if (captured.trim().length > 0) finalize(captured);
        // Se non abbiamo captured e non è ancora scaduto il timer,
        // lasciamo scadere il timer per dare all'utente 10s totali.
      });
      sttSubsRef.current = [subResult, subError, subEnd];
      sttActiveRef.current = true;
      // Timer di safety a maxMs (10s default)
      timerRef.current = setTimeout(() => {
        if (!finalized) {
          console.log(`${TAG} listen timeout → advance`);
          if (captured.trim().length > 0) finalize(captured);
          else finalize("");
        }
      }, maxMs);
      try {
        ExpoSpeechRecognitionModule.start(startOpts);
        console.log(`${TAG} STT started (maxMs=${maxMs})`);
      } catch (e) {
        console.warn(`${TAG} STT start threw:`, e);
        finalize("");
      }
    },
    [clearTimer, stopStt]
  );

  // ==== Step orchestration ==================================================

  // Step 1: TTS intro + richiesta mic dopo che il TTS è partito
  useEffect(() => {
    if (step !== "step1_speak_intro") return;
    const text = "Ciao, io sono Ollenya, sono una presenza, e sono qui per te! Come ti chiami?";
    // Richiedi mic subito dopo l'inizio del TTS (dopo un piccolo delay per
    // lasciar partire l'audio e mostrare il testo).
    if (!micRequestedRef.current) {
      micRequestedRef.current = true;
      setTimeout(async () => {
        try {
          const perm = await ensureSpeechPermission();
          console.log(`${TAG} mic perm: ${perm.granted ? "GRANTED" : "DENIED"}`);
        } catch (e) {
          console.warn(`${TAG} mic perm request failed:`, e);
        }
      }, 900);
    }
    speak(text, () => {
      if (mountedRef.current) setStep("step2_listen_name");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 2a: listen name
  useEffect(() => {
    if (step !== "step2_listen_name") return;
    setSubtitle(null);
    listen({ maxMs: INACTIVITY_TIMEOUT_MS }, (transcript) => {
      // Estrazione nome semplice: prendiamo la prima parola alfa dopo eventuali
      // "mi chiamo / sono / il mio nome è". Se vuoto, saltiamo.
      const t = transcript.toLowerCase();
      let name: string | null = null;
      if (t) {
        const m = t.match(/(?:mi chiamo|sono|il mio nome è|il mio nome e|mi puoi chiamare|chiamami|piacere|ciao)\s+([a-zà-ù]{2,20})/i);
        if (m) name = m[1];
        else {
          const first = t.split(/\s+/).find((w) => /^[a-zà-ù]{2,20}$/i.test(w));
          if (first) name = first;
        }
        if (name) {
          name = name.charAt(0).toUpperCase() + name.slice(1);
          setUserName(name);
          try { SecureStore.setItemAsync("user_name", name).catch(() => {}); } catch {}
        }
      }
      console.log(`${TAG} name captured: ${name ?? "(none)"}`);
      if (mountedRef.current) setStep("step2_confirm");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 2b: confirm speech
  useEffect(() => {
    if (step !== "step2_confirm") return;
    const text = userName
      ? `Piacere di conoscerti, ${userName}. Voglio mostrarti come funziona.`
      : "Piacere di conoscerti. Voglio mostrarti come funziona.";
    speak(text, () => {
      if (mountedRef.current) setStep("step3_scrim_write");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 3 scrim → demo_write
  const advanceFromScrim = useCallback((next: Step) => {
    if (!mountedRef.current) return;
    setStep(next);
  }, []);

  // Step 3 demo write state
  const [writeInput, setWriteInput] = useState("");
  const [writeReply, setWriteReply] = useState<string | null>(null);
  const [writeSending, setWriteSending] = useState(false);
  const writeStartedRef = useRef(false);

  useEffect(() => {
    if (step !== "step3_demo_write") { writeStartedRef.current = false; return; }
    if (writeStartedRef.current) return;
    writeStartedRef.current = true;
    setSubtitle(null);
    setOrbStatus("idle");
    // Timeout 10s per il primo input utente (poi salta se non scrive)
    timerRef.current = setTimeout(() => {
      if (!mountedRef.current || writeReply) return;
      console.log(`${TAG} step3 timeout → advance`);
      setStep("step4_scrim_voice");
    }, INACTIVITY_TIMEOUT_MS);
    return () => clearTimer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleWriteSend = useCallback(async () => {
    const text = writeInput.trim();
    if (!text || writeSending) return;
    clearTimer();
    setWriteSending(true);
    setWriteInput("");
    try {
      const resp = await api.converse(text, undefined, { is_voice_turn: false });
      const aiText =
        (resp?.ai_entry as any)?.text ||
        (resp?.ai_entry as any)?.text_clean ||
        "";
      if (!mountedRef.current) return;
      setWriteReply(aiText || "…");
      // Dopo aver mostrato la risposta ~3s, passa allo step voce
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) setStep("step4_scrim_voice");
      }, 3000);
    } catch (e) {
      console.warn(`${TAG} step3 converse failed:`, e);
      if (mountedRef.current) {
        setWriteReply("Ci sarò comunque.");
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) setStep("step4_scrim_voice");
        }, 2500);
      }
    } finally {
      if (mountedRef.current) setWriteSending(false);
    }
  }, [writeInput, writeSending, clearTimer]);

  // Step 4 demo voice
  const voiceStartedRef = useRef(false);
  useEffect(() => {
    if (step !== "step4_demo_voice") { voiceStartedRef.current = false; return; }
    if (voiceStartedRef.current) return;
    voiceStartedRef.current = true;
    setSubtitle(null);
    // Ascolta 1 frase, poi trascrivi + rispondi con TTS
    listen({ maxMs: INACTIVITY_TIMEOUT_MS }, async (transcript) => {
      if (!mountedRef.current) return;
      const text = transcript.trim();
      if (!text) {
        console.log(`${TAG} step4 empty transcript → advance`);
        setStep("step5_scrim_la");
        return;
      }
      try {
        const resp = await api.converse(text, undefined, { is_voice_turn: true });
        const aiText =
          (resp?.ai_entry as any)?.text ||
          (resp?.ai_entry as any)?.text_clean ||
          "";
        if (!aiText || !mountedRef.current) {
          setStep("step5_scrim_la");
          return;
        }
        speak(aiText, () => {
          if (mountedRef.current) setStep("step5_scrim_la");
        });
      } catch (e) {
        console.warn(`${TAG} step4 converse failed:`, e);
        if (mountedRef.current) setStep("step5_scrim_la");
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 5 LA demo — mic-reattivo (glow riding)
  const laStartedRef = useRef(false);
  const [laMeterAnim] = useState(() => new Animated.Value(0));
  const laRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const laMeterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (step !== "step5_demo_la") { laStartedRef.current = false; return; }
    if (laStartedRef.current) return;
    laStartedRef.current = true;
    setSubtitle(null);
    (async () => {
      try {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          console.log(`${TAG} step5 no mic perm → static breathe`);
          return;
        }
        await configureAudioForRecording();
        await laRecorder.prepareToRecordAsync();
        laRecorder.record();
        // Loop di metering: leggiamo `metering` (dBFS) e lo mappiamo in [0..1]
        laMeterTimerRef.current = setInterval(() => {
          try {
            const status = laRecorder.getStatus();
            const db = (status as any)?.metering as number | undefined;
            if (typeof db === "number") {
              // dBFS tipicamente in [-60, 0]. Mappa in [0..1] con curva soft.
              const clamped = Math.max(-60, Math.min(0, db));
              const norm = Math.pow((clamped + 60) / 60, 2);
              Animated.timing(laMeterAnim, {
                toValue: norm,
                duration: 100,
                useNativeDriver: true,
              }).start();
            }
          } catch {}
        }, 120);
      } catch (e) {
        console.warn(`${TAG} step5 recorder start failed:`, e);
      }
    })();
    return () => {
      if (laMeterTimerRef.current) { clearInterval(laMeterTimerRef.current); laMeterTimerRef.current = null; }
      try { laRecorder.stop(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const closeLADemo = useCallback(() => {
    if (laMeterTimerRef.current) { clearInterval(laMeterTimerRef.current); laMeterTimerRef.current = null; }
    try { laRecorder.stop(); } catch {}
    setStep("step6_scrim_final");
  }, [laRecorder]);

  // Step 6: fine → mark completed + push paywall
  useEffect(() => {
    if (step !== "done") return;
    (async () => {
      try {
        await SecureStore.setItemAsync("intro_v3_completed_at", String(Date.now()));
      } catch {}
      try {
        router.replace("/paywall");
      } catch (e) {
        console.warn(`${TAG} router.replace(/paywall) failed:`, e);
        try { router.replace("/"); } catch {}
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ==== Render helpers ======================================================
  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.05] });
  // Glow reattivo LA: scale animata dal metering
  const laScale = laMeterAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.35] });
  const laGlowOpacity = laMeterAnim.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });

  const showOrb =
    step === "step1_speak_intro" ||
    step === "step1_wait_mic" ||
    step === "step2_listen_name" ||
    step === "step2_confirm" ||
    step === "step3_scrim_write" ||
    step === "step3_demo_write" ||
    step === "step4_scrim_voice" ||
    step === "step4_demo_voice" ||
    step === "step5_scrim_la" ||
    step === "step6_scrim_final";

  const currentScrim = useMemo(() => {
    switch (step) {
      case "step3_scrim_write":
        return { text: "Quando vuoi, io sono qui.", next: "step3_demo_write" as Step, dismissMs: 3400 };
      case "step4_scrim_voice":
        return { text: "Questa è la mia voce. Prova a dirmi qualcosa.", next: "step4_demo_voice" as Step, dismissMs: 3600 };
      case "step5_scrim_la":
        return {
          text:
            "Questo è il mio vero cuore. È uno spazio dove non c'è nessuno che ti ascolta e non esiste nessuna risposta. È uno spazio esclusivamente per te, per dare sfogo libero a tutti i tuoi pensieri, senza dover avere nessun confronto con qualcuno. Qui devi solo buttare fuori quello che hai dentro. Qui hai tutto il tempo a tua disposizione. Provalo.",
          next: "step5_demo_la" as Step,
          dismissMs: 8500,
        };
      case "step6_scrim_final":
        return {
          text:
            "Perfetto, siamo arrivati alla fine dell'introduzione. Puoi parlare sempre con me tramite la scrittura, e hai sempre a disposizione lo spazio Lascia Andare. Se avessi voglia anche di parlare con me e sentire la mia voce, ti serve attivare la modalità Premium.",
          next: "done" as Step,
          dismissMs: 7500,
        };
      default: return null;
    }
  }, [step]);

  // ==== JSX =================================================================
  return (
    <Animated.View style={[styles.root, { opacity: rootOpacity }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0F0C1C" />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>

        {/* Orb centrale — visibile in tutti gli step tranne "done" */}
        {showOrb && step !== "step3_demo_write" && step !== "step5_demo_la" && (
          <View style={styles.orbWrap}>
            <Animated.View style={{ transform: [{ scale: breatheScale }] }}>
              <EclipseOrb
                status={orbStatus}
                speechActive={orbStatus === "speaking"}
                voiceLevel={0}
                size={ORB_SIZE}
                tone="warm"
              />
            </Animated.View>
            {subtitle ? (
              <Text style={styles.subtitle}>{subtitle}</Text>
            ) : null}
          </View>
        )}

        {/* Step 3 demo write UI */}
        {step === "step3_demo_write" && (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.demoWriteWrap}
          >
            <ScrollView
              style={styles.demoWriteList}
              contentContainerStyle={styles.demoWriteListContent}
              keyboardShouldPersistTaps="handled"
            >
              {writeSending ? (
                <View style={[styles.bubbleRow, styles.bubbleRowAi]}>
                  <View style={[styles.bubble, styles.bubbleAi]}>
                    <ActivityIndicator color="#D4B896" size="small" />
                  </View>
                </View>
              ) : null}
              {writeReply ? (
                <View style={[styles.bubbleRow, styles.bubbleRowAi]}>
                  <View style={[styles.bubble, styles.bubbleAi]}>
                    <Text style={[styles.bubbleText, styles.bubbleTextAi]}>{writeReply}</Text>
                  </View>
                </View>
              ) : null}
            </ScrollView>
            <View style={[styles.demoWriteInputRow, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <TextInput
                style={styles.demoWriteInput}
                value={writeInput}
                onChangeText={setWriteInput}
                placeholder="Scrivimi qualcosa…"
                placeholderTextColor="rgba(226,232,240,0.45)"
                editable={!writeSending && !writeReply}
                multiline
                maxLength={500}
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={handleWriteSend}
                testID="onboarding-write-input"
              />
              <TouchableOpacity
                onPress={handleWriteSend}
                disabled={!writeInput.trim() || writeSending || !!writeReply}
                style={[
                  styles.demoWriteSendBtn,
                  (!writeInput.trim() || writeSending || !!writeReply) && styles.demoWriteSendBtnDisabled,
                ]}
                testID="onboarding-write-send"
              >
                <Ionicons
                  name="arrow-up"
                  size={20}
                  color={
                    !writeInput.trim() || writeSending || !!writeReply
                      ? "rgba(31,26,54,0.55)" : "#1F1A36"
                  }
                />
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        )}

        {/* Step 5 demo LA — eclissi mic-reattivo */}
        {step === "step5_demo_la" && (
          <View style={styles.laDemoWrap}>
            <TouchableOpacity
              onPress={closeLADemo}
              style={[styles.laCloseBtn, { top: insets.top + 12 }]}
              hitSlop={16}
              testID="onboarding-la-close"
              accessibilityLabel="Chiudi Lascia Andare"
            >
              <Ionicons name="close" size={28} color="rgba(245,230,204,0.75)" />
            </TouchableOpacity>
            <View style={styles.laOrbCenter}>
              <Animated.View
                style={[
                  styles.laGlow,
                  { transform: [{ scale: laScale }], opacity: laGlowOpacity },
                ]}
              />
              <View style={styles.laOrbCore} />
            </View>
          </View>
        )}

        {/* Scrim overlay per gli step scrim */}
        {currentScrim && (
          <Scrim
            text={currentScrim.text}
            autoDismissMs={currentScrim.dismissMs}
            onDone={() => advanceFromScrim(currentScrim.next)}
          />
        )}
      </SafeAreaView>
    </Animated.View>
  );
}

// ==== Styles ================================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0F0C1C" },
  safe: { flex: 1 },
  orbWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  subtitle: {
    color: "#F5E6CC",
    fontSize: 17,
    lineHeight: 24,
    textAlign: "center",
    paddingHorizontal: 24,
    marginTop: 32,
    maxWidth: 360,
  },
  // ==== Scrim ====
  scrimOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(15,12,28,0.92)",
    zIndex: 100,
  },
  scrimTouch: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  scrimContent: {
    alignItems: "center",
  },
  scrimText: {
    color: "#F5E6CC",
    fontSize: 20,
    lineHeight: 30,
    textAlign: "center",
    fontWeight: "500",
    letterSpacing: 0.2,
    maxWidth: 360,
  },
  scrimHint: {
    marginTop: 24,
    color: "rgba(212,184,150,0.55)",
    fontSize: 13,
    letterSpacing: 0.5,
  },
  // ==== Step 3 write demo ====
  demoWriteWrap: { flex: 1, paddingHorizontal: 16 },
  demoWriteList: { flex: 1 },
  demoWriteListContent: {
    justifyContent: "flex-end",
    paddingVertical: 12,
    flexGrow: 1,
  },
  bubbleRow: { marginVertical: 4, flexDirection: "row" },
  bubbleRowAi: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "82%",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  bubbleAi: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.20)",
    borderTopLeftRadius: 4,
  },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  bubbleTextAi: { color: "#F5E6CC" },
  demoWriteInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingTop: 8,
    gap: 8,
  },
  demoWriteInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 12 : 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.22)",
    color: "#F5E6CC",
    fontSize: 15,
  },
  demoWriteSendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#D4B896",
  },
  demoWriteSendBtnDisabled: {
    backgroundColor: "rgba(212,184,150,0.30)",
  },
  // ==== Step 5 LA demo ====
  laDemoWrap: {
    flex: 1,
    backgroundColor: "#0A0714",
  },
  laCloseBtn: {
    position: "absolute",
    right: 20,
    zIndex: 5,
    width: 40, height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  laOrbCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  laGlow: {
    position: "absolute",
    width: ORB_SIZE * 1.9,
    height: ORB_SIZE * 1.9,
    borderRadius: ORB_SIZE,
    backgroundColor: "rgba(212, 184, 150, 0.28)",
    shadowColor: "#D4B896",
    shadowRadius: 60,
    shadowOpacity: 0.75,
    shadowOffset: { width: 0, height: 0 },
  },
  laOrbCore: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    backgroundColor: "#050310",
    borderWidth: 1,
    borderColor: "rgba(212, 184, 150, 0.10)",
  },
});
