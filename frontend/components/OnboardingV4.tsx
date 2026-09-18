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
// Timeout d'inattività per il reset "torna all'inizio": 15s.
const INACTIVITY_RESET_MS = 15_000;
// Numero di scambi obbligatori nelle demo scrittura/voce (utente → Ollenya).
const REQUIRED_EXCHANGES = 3;
const { width: SCREEN_W } = Dimensions.get("window");
// v66.6 (Fabio 2026-06-16): dimensione eclissi allineata alla Home REALE.
// Home usa Math.min(width * 0.78, 360) ma il wrapper flex + scale animation
// rendono un'immagine visualmente ~240. Uniamo intro e LA a questa taglia
// percepita per rispettare "tutte identiche alla home".
const ORB_SIZE = Math.min(SCREEN_W * 0.62, 240);
const APP_BG = "#1F1A36";
const METER_THRESHOLD = -35;
// Palette bolle chat identica a quella della chat REALE (theme NOTTE).
const CHAT_USER_BG = "#0E7C7B";
const CHAT_USER_TEXT = "#FFFFFF";
const CHAT_AI_BG = "rgba(148,163,184,0.10)";
const CHAT_AI_BORDER = "rgba(148,163,184,0.35)";
const CHAT_AI_TEXT = "#E2E8F0";

// ==== Fasi (state machine) ==================================================
type Step =
  | "step1_speak_intro"      // TTS "Ciao... Come ti chiami?"
  | "step1_wait_mic"         // Attesa concessione microfono post-TTS
  | "step2_listen_name"      // STT nome (10s timeout)
  | "step2_confirm"          // TTS "Piacere... Voglio mostrarti come funziona"
  | "step3_scrim_write"      // Scrim + "Quando vuoi, io sono qui." (TTS + testo)
  | "step3_demo_write"       // TextInput, richiesti REQUIRED_EXCHANGES turni
  | "step4_scrim_voice"      // Scrim + "Questa è la mia voce..." (TTS + testo)
  | "step4_demo_voice"       // STT + risposta TTS, richiesti REQUIRED_EXCHANGES turni
  | "step5_scrim_la"         // Scrim + testo lungo LA (TTS + testo)
  | "step5_demo_la"          // Eclissi mic-reattivo, X per chiudere
  | "step6_scrim_final"      // Scrim + "Perfetto, siamo arrivati..." (TTS + testo)
  | "paused_by_inactivity"   // 15s senza input → orb idle, tap per riavviare
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
  // v66.5 (Fabio 2026-06-16): metering per orb reattivo durante STT.
  // Popolato dai volumechange events di ExpoSpeechRecognitionModule
  // (step2_listen_name e step4_demo_voice) — passato a EclipseOrb come
  // meterDb + dbBoost così l'orb pulsa esattamente come nella Home.
  const [orbMeterDb, setOrbMeterDb] = useState(-60);

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
    // v66.4 (Fabio 2026-06-16, bug 4): flag idempotente + clear del safety-
    // net timer. Prima: onStatus.didJustFinish → onDone; timer 15s scattava
    // 12s dopo (mentre lo step successivo era già in corso) → chiamava
    // onDone di NUOVO → doppio advance → loop di frasi ripetute osservato
    // ("Piacere di conoscerti" e "Quando vuoi io sono qui" 2-3 volte).
    let doneCalled = false;
    const safeDone = () => {
      if (doneCalled) return;
      doneCalled = true;
      clearTimer();
      onDone();
    };
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
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) safeDone();
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
        timerRef.current = setTimeout(() => { if (mountedRef.current) safeDone(); }, 400);
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
          safeDone();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();
      // Safety net a 15s. Il flag `doneCalled` garantisce che questo timer
      // NON possa firing un secondo advance se onStatus è già passato.
      timerRef.current = setTimeout(() => {
        if (mountedRef.current && !doneCalled) {
          console.warn(`${TAG} speak safety-net`);
          safeDone();
        }
      }, 15_000);
    } catch (e) {
      console.warn(`${TAG} speak failed:`, e);
      timerRef.current = setTimeout(() => { if (mountedRef.current) safeDone(); }, 400);
    }
  }, [clearTimer]);

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
        // v66.4 (bug 5): dopo la fine dell'ascolto, rimettiamo l'orb in
        // "idle" così non resta il glow teal sospeso in attesa del prossimo
        // speak. Il caller cambierà a "speaking" quando parte il TTS.
        if (mountedRef.current) setOrbStatus("idle");
        onTranscript(text.trim());
      };
      const maxMs = opts.maxMs ?? INACTIVITY_RESET_MS;
      const startOpts: any = {
        lang: "it-IT",
        interimResults: true,
        continuous: Platform.OS === "android",
        maxAlternatives: 1,
        addsPunctuation: true,
        requiresOnDeviceRecognition: Platform.OS === "ios",
        // v66.5 (Fabio 2026-06-16): metering ATTIVO. Ogni 80ms riceviamo
        // il volume raw dell'utente e lo mappiamo in meterDb (-60..-20)
        // per far pulsare l'EclipseOrb come nella Home.
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
      // v66.5: metering → EclipseOrb. Il `value` viene normalizzato a
      // dBFS-like [-60..-20]: iOS restituisce dBFS negativi (~[-60..0]),
      // Android restituisce 0..10 → mappiamo linearmente su [-60..-20].
      const subVolume = ExpoSpeechRecognitionModule.addListener(
        "volumechange",
        (evt: { value?: number }) => {
          const raw = typeof evt?.value === "number" ? evt.value : -60;
          let db: number;
          if (Platform.OS === "android") {
            // Android: value ~ 0..10, mappa linearmente in [-60..-20]
            const clamped = Math.max(0, Math.min(10, raw));
            db = -60 + (clamped / 10) * 40;
          } else {
            // iOS: value ~ dBFS negativo (-60..0). Clamp e shift.
            db = Math.max(-60, Math.min(-20, raw));
          }
          setOrbMeterDb(db);
        }
      );
      sttSubsRef.current = [subResult, subError, subEnd, subVolume];
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
    listen({ maxMs: INACTIVITY_RESET_MS }, (transcript) => {
      // v66.4 (Fabio 2026-06-16, bug 2): estrazione nome più permissiva.
      // Rimuoviamo punteggiatura, gestiamo "mi chiamo / sono / è / piacere,
      // sono …" e come fallback prendiamo il primo token alfabetico (2-20
      // lettere) che NON sia una stop-word italiana. Log dettagliato per
      // diagnosi future.
      const raw = transcript || "";
      const cleaned = raw.toLowerCase().replace(/[.,!?;:'"]/g, "").trim();
      console.log(`${TAG} name transcript raw="${raw}" cleaned="${cleaned}"`);
      let name: string | null = null;
      if (cleaned) {
        const m = cleaned.match(
          /(?:mi chiamo|il mio nome è|il mio nome e|mi puoi chiamare|chiamami|piacere sono|piacere,? sono|sono|piacere ciao sono)\s+([a-zà-ù]{2,20})/i
        );
        if (m) name = m[1];
        else {
          const STOP = new Set([
            "il","la","lo","gli","le","un","uno","una","mi","ti","si","ci","vi","ne",
            "no","non","che","chi","cosa","come","ecco","di","da","in","con","su","per",
            "tra","fra","e","ed","o","è","e","ma","ho","hai","ha","sto","sta","va","ok",
            "ciao","salve","ehi","hey","ola","allora","io","tu","lui","lei","noi","voi",
            "loro","questo","questa","quello","quella","quel","qui","qua","già","ancora",
            "sempre","mai","molto","bene","male","ora","adesso","poi","pure","anche","più",
            "meno","e","del","della","dello","al","alla","allo","dal","dalla","dallo",
          ]);
          for (const w of cleaned.split(/\s+/)) {
            if (/^[a-zà-ù]{2,20}$/i.test(w) && !STOP.has(w)) { name = w; break; }
          }
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
  // v66.7 (Fabio 2026-06-16): "voglio mostrarti ciò che sono" — meno
  // tecnico di "come funziono", più affettivo/identitario. Ollenya si
  // presenta come presenza, non come feature-set.
  useEffect(() => {
    if (step !== "step2_confirm") return;
    const text = userName
      ? `Ciao ${userName}, piacere. Voglio mostrarti ciò che sono.`
      : "Piacere di conoscerti. Voglio mostrarti ciò che sono.";
    speak(text, () => {
      if (mountedRef.current) setStep("step3_scrim_write");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // v66.4 (Fabio 2026-06-16, bug 4): clear subtitle SUBITO su cambio step.
  // Prima il subtitle "Piacere di conoscerti…" restava visibile sotto lo
  // scrim "Quando vuoi io sono qui" causando l'illusione di doppie frasi.
  // Ora ogni cambio step azzera il testo, sarà lo speak() a ripopolarlo.
  useEffect(() => {
    setSubtitle(null);
  }, [step]);

  // v66.6 (Fabio 2026-06-16): timer d'inattività globale. Al termine di
  // ogni azione utente (typing, send, transcript) resettiamo. Se scade
  // (15s) → step "paused_by_inactivity": orb idle + tap per riavviare
  // l'intero flow. La quota Free consumata dagli scambi già effettuati
  // resta consumata (comportamento voluto: se apri, "chatti" e chiudi,
  // hai usato i tuoi messaggi).
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }, []);
  const resetInactivityTimer = useCallback(() => {
    clearInactivityTimer();
    inactivityTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      console.log(`${TAG} inactivity 15s → paused_by_inactivity`);
      // Ferma qualsiasi player/STT in corso
      stopPlayer();
      stopStt();
      setOrbStatus("idle");
      setSubtitle(null);
      setStep("paused_by_inactivity");
    }, INACTIVITY_RESET_MS);
  }, [clearInactivityTimer, stopPlayer, stopStt]);

  // Step 3 scrim → demo_write
  const advanceFromScrim = useCallback((next: Step) => {
    if (!mountedRef.current) return;
    setStep(next);
  }, []);

  // v66.6 (Fabio 2026-06-16): SCRIM TTS. Ogni scrim di spiegazione ora
  // pronuncia il testo con la voce di Cielo (turbo v2.5) e avanza SOLO
  // quando il TTS è completato. Prima il scrim era timer-based e la voce
  // non parlava — feedback: "tutte le spiegazioni scritte devono essere
  // accompagnate dalla voce".
  const scrimStartedRef = useRef<Record<string, boolean>>({});
  const scrimSpeakStep = useCallback((thisStep: Step, text: string, next: Step) => {
    if (step !== thisStep) return;
    if (scrimStartedRef.current[thisStep]) return;
    scrimStartedRef.current[thisStep] = true;
    setOrbStatus("speaking");
    // Il subtitle è mostrato dallo scrim overlay, non usiamo setSubtitle.
    speak(text, () => {
      if (mountedRef.current) setStep(next);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, speak]);

  useEffect(() => {
    if (step === "step3_scrim_write") {
      scrimSpeakStep(
        "step3_scrim_write",
        "Qui puoi scrivermi quando vuoi. La scrittura è sempre attiva, sempre gratuita, sempre a disposizione. Uno spazio di comunicazione che non si chiude mai. Quando vuoi, io sono qui.",
        "step3_demo_write"
      );
    } else if (step === "step4_scrim_voice") {
      scrimSpeakStep(
        "step4_scrim_voice",
        "Adesso ti presento la mia voce. Questa è la mia funzione principale: quando parliamo davvero, tu dici quello che senti e io ti rispondo con la mia voce, come una vera conversazione. Prova ora. Dimmi qualcosa, anche solo una parola. Ti risponderò.",
        "step4_demo_voice"
      );
    } else if (step === "step5_scrim_la") {
      scrimSpeakStep(
        "step5_scrim_la",
        "Questo è il mio vero cuore. È uno spazio dove non c'è nessuno che ti ascolta e non esiste nessuna risposta. È uno spazio esclusivamente per te, per dare sfogo libero a tutti i tuoi pensieri, senza dover avere nessun confronto con qualcuno. Qui devi solo buttare fuori quello che hai dentro. Qui hai tutto il tempo a tua disposizione. Provalo.",
        "step5_demo_la"
      );
    } else if (step === "step6_scrim_final") {
      scrimSpeakStep(
        "step6_scrim_final",
        "Perfetto, siamo arrivati alla fine dell'introduzione. Puoi parlare sempre con me tramite la scrittura, e hai sempre a disposizione lo spazio Lascia Andare. Se avessi voglia anche di parlare con me e sentire la mia voce, ti serve attivare la modalità Premium.",
        "done"
      );
    } else {
      // Reset del guard quando siamo su uno step non-scrim (permette
      // il riavvio dello stesso scrim in caso di reset per inattività).
      scrimStartedRef.current = {};
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 3 demo write state
  // v66.4/v66.6: bolle user + AI in log, counter esplicito degli scambi
  // (richiesti REQUIRED_EXCHANGES=3 prima di avanzare a step4).
  type WriteMsg = { id: string; role: "user" | "ai"; text: string };
  const [writeMessages, setWriteMessages] = useState<WriteMsg[]>([]);
  const [writeInput, setWriteInput] = useState("");
  const [writeSending, setWriteSending] = useState(false);
  const [writeCompleted, setWriteCompleted] = useState(false);
  const [writeExchangeCount, setWriteExchangeCount] = useState(0);
  const writeStartedRef = useRef(false);

  useEffect(() => {
    if (step !== "step3_demo_write") { writeStartedRef.current = false; return; }
    if (writeStartedRef.current) return;
    writeStartedRef.current = true;
    setSubtitle(null);
    setOrbStatus("idle");
    // v66.6 (Fabio 2026-06-16): 15s di inattività assoluta → reset a
    // paused_by_inactivity. Se l'utente scrive qualcosa, il timer viene
    // resettato in handleWriteSend/onChangeText.
    resetInactivityTimer();
    return () => clearTimer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleWriteSend = useCallback(async () => {
    const text = writeInput.trim();
    if (!text || writeSending || writeCompleted) return;
    clearTimer();
    setWriteSending(true);
    // v66.4 (bug 1): salviamo IMMEDIATAMENTE il messaggio utente nel log.
    const userMsg: WriteMsg = { id: `u-${Date.now()}`, role: "user", text };
    setWriteMessages((prev) => [...prev, userMsg]);
    setWriteInput("");
    try {
      const resp = await api.converse(text, undefined, { is_voice_turn: false });
      const aiText =
        (resp?.ai_entry as any)?.text ||
        (resp?.ai_entry as any)?.text_clean ||
        "";
      if (!mountedRef.current) return;
      const aiMsg: WriteMsg = { id: `a-${Date.now()}`, role: "ai", text: aiText || "…" };
      setWriteMessages((prev) => [...prev, aiMsg]);
      const newCount = writeExchangeCount + 1;
      setWriteExchangeCount(newCount);
      // v66.6 (Fabio 2026-06-16): richiesti REQUIRED_EXCHANGES (3) turni
      // completi. Solo al 3° avanziamo. Prima di allora restiamo qui,
      // resettiamo il timer d'inattività a 15s per il prossimo turno.
      if (newCount >= REQUIRED_EXCHANGES) {
        setWriteCompleted(true);
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) setStep("step4_scrim_voice");
        }, 3200);
      } else {
        resetInactivityTimer();
      }
    } catch (e) {
      console.warn(`${TAG} step3 converse failed:`, e);
      if (mountedRef.current) {
        const aiMsg: WriteMsg = { id: `a-${Date.now()}`, role: "ai", text: "Ci sarò comunque." };
        setWriteMessages((prev) => [...prev, aiMsg]);
        // Rete/backend giù: consideriamo il turno "andato" e resettiamo
        // il timer inattività per il prossimo tentativo.
        resetInactivityTimer();
      }
    } finally {
      if (mountedRef.current) setWriteSending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeInput, writeSending, writeCompleted, writeExchangeCount, clearTimer]);

  // Step 4 demo voice — v66.6 (Fabio 2026-06-16): 3 scambi obbligatori.
  // Ciclo: listen → converse → speak(ai reply) → listen (turno 2) → …
  // Se transcript vuoto (STT non capta), Ollenya dice "Non ho sentito,
  // riprova." e ri-ascolta senza consumare uno scambio. Dopo 3 exchange
  // completi, avanza a step5. Timer d'inattività: gestito da listen()
  // via il timer safety interno + globale (resetInactivityTimer).
  const voiceStartedRef = useRef(false);
  const [voiceExchangeCount, setVoiceExchangeCount] = useState(0);

  const runVoiceExchange = useCallback(() => {
    if (!mountedRef.current) return;
    resetInactivityTimer();
    setOrbStatus("recording");
    listen({ maxMs: INACTIVITY_RESET_MS }, async (transcript) => {
      if (!mountedRef.current) return;
      const text = transcript.trim();
      if (!text) {
        // Retry: Ollenya chiede di ripetere, poi riavvia la stessa "prova"
        console.log(`${TAG} step4 empty transcript → retry prompt`);
        speak("Non ho sentito, prova a ripetere.", () => {
          if (mountedRef.current && step === "step4_demo_voice") runVoiceExchange();
        });
        return;
      }
      try {
        const resp = await api.converse(text, undefined, { is_voice_turn: true });
        const aiText =
          (resp?.ai_entry as any)?.text ||
          (resp?.ai_entry as any)?.text_clean ||
          "";
        if (!aiText || !mountedRef.current) {
          speak("Ho capito. Vai avanti.", () => {
            if (mountedRef.current && step === "step4_demo_voice") runVoiceExchange();
          });
          return;
        }
        speak(aiText, () => {
          if (!mountedRef.current) return;
          setVoiceExchangeCount((prev) => {
            const nextCount = prev + 1;
            if (nextCount >= REQUIRED_EXCHANGES) {
              // Ultimo turno: piccola pausa, poi step5
              setTimeout(() => {
                if (mountedRef.current) setStep("step5_scrim_la");
              }, 1200);
            } else {
              // Prossimo turno voce
              setTimeout(() => {
                if (mountedRef.current && step === "step4_demo_voice") runVoiceExchange();
              }, 600);
            }
            return nextCount;
          });
        });
      } catch (e) {
        console.warn(`${TAG} step4 converse failed:`, e);
        if (mountedRef.current) {
          // Non blocchiamo il flow su errore rete
          speak("Un momento. Riprova.", () => {
            if (mountedRef.current && step === "step4_demo_voice") runVoiceExchange();
          });
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listen, speak, resetInactivityTimer, step]);

  useEffect(() => {
    if (step !== "step4_demo_voice") { voiceStartedRef.current = false; return; }
    if (voiceStartedRef.current) return;
    voiceStartedRef.current = true;
    setSubtitle(null);
    setVoiceExchangeCount(0);
    runVoiceExchange();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 5 LA demo — usa il pattern REALE di Lascia Andare (v66.4, bug 6):
  // EclipseOrb con dbBoost calcolato dal metering, così il glow reagisce
  // dinamicamente alla voce come nella LA principale. dB range utile
  // [-60, -20] mappato in [0, 1]. Il glow è champagne come nella LA reale.
  const laStartedRef = useRef(false);
  const [laMeterDb, setLaMeterDb] = useState(-60);
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
        // Loop di metering: leggiamo `metering` (dBFS) e lo passiamo in state.
        laMeterTimerRef.current = setInterval(() => {
          try {
            const status = laRecorder.getStatus();
            const db = (status as any)?.metering as number | undefined;
            if (typeof db === "number") setLaMeterDb(db);
          } catch {}
        }, 100);
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
    step === "step6_scrim_final" ||
    step === "paused_by_inactivity";

  // v66.6: testo dello scrim renderizzato durante gli step scrim (Ollenya
  // parla in parallelo grazie a scrimSpeakStep). Nessun autoDismissMs:
  // l'advance è pilotato dalla fine del TTS.
  const currentScrimText = useMemo(() => {
    switch (step) {
      case "step3_scrim_write":
        return "Qui puoi scrivermi quando vuoi.\n\nLa scrittura è sempre attiva, sempre gratuita, sempre a disposizione. Uno spazio di comunicazione che non si chiude mai.\n\nQuando vuoi, io sono qui.";
      case "step4_scrim_voice":
        return "Adesso ti presento la mia voce.\n\nQuesta è la mia funzione principale: quando parliamo davvero, tu dici quello che senti e io ti rispondo con la mia voce, come una vera conversazione.\n\nProva ora. Dimmi qualcosa — anche solo una parola. Ti risponderò.";
      case "step5_scrim_la":
        return "Questo è il mio vero cuore.\n\nÈ uno spazio dove non c'è nessuno che ti ascolta e non esiste nessuna risposta. È uno spazio esclusivamente per te, per dare sfogo libero a tutti i tuoi pensieri, senza dover avere nessun confronto con qualcuno.\n\nQui devi solo buttare fuori quello che hai dentro. Qui hai tutto il tempo a tua disposizione. Provalo.";
      case "step6_scrim_final":
        return "Perfetto, siamo arrivati alla fine dell'introduzione.\n\nPuoi parlare sempre con me tramite la scrittura, e hai sempre a disposizione lo spazio Lascia Andare.\n\nSe avessi voglia anche di parlare con me e sentire la mia voce, ti serve attivare la modalità Premium.";
      default: return null;
    }
  }, [step]);

  // ==== JSX =================================================================
  return (
    <Animated.View style={[styles.root, { opacity: rootOpacity }]}>
      <StatusBar barStyle="light-content" backgroundColor={APP_BG} />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>

        {/* Orb centrale — visibile in tutti gli step tranne "done".
            v66.4 (Fabio 2026-06-16, bug 7): subtitle in absolute-positioned
            SOTTO l'orb per NON shiftare l'orb verso l'alto quando appare.
            Prima l'orb si spostava tra speaking (con testo) e recording
            (senza testo) di ~24px. Ora l'orb è centrato assolutamente
            nel wrapper flex e il subtitle occupa uno slot fisso più in
            basso, indipendente dal contenuto. */}
        {showOrb && step !== "step3_demo_write" && step !== "step5_demo_la" && (
          <View style={styles.orbWrap}>
            <View style={styles.orbCenter}>
              <Animated.View style={{ transform: [{ scale: breatheScale }] }}>
                <EclipseOrb
                  status={orbStatus}
                  speechActive={orbStatus === "speaking"}
                  voiceLevel={0}
                  size={ORB_SIZE}
                  tone="warm"
                  // v66.5 (Fabio 2026-06-16): meterDb + dbBoost passati sempre
                  // così durante recording l'orb modula come nella Home. In
                  // stato non-recording, i valori sono neutri (-60/0) e non
                  // influenzano il rendering.
                  meterDb={orbStatus === "recording" ? orbMeterDb : -60}
                  meterThreshold={METER_THRESHOLD}
                  dbBoost={
                    orbStatus === "recording"
                      ? Math.max(
                          0,
                          Math.min(1, (Math.max(-60, Math.min(-20, orbMeterDb)) + 60) / 40)
                        )
                      : 0
                  }
                />
              </Animated.View>
            </View>
            <View style={styles.subtitleSlot} pointerEvents="none">
              {subtitle ? (
                <Text style={styles.subtitle}>{subtitle}</Text>
              ) : null}
            </View>
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
              {/* v66.4 (bug 1): rendering ENTRAMBI i lati (user + ai). */}
              {writeMessages.map((m) => (
                <View
                  key={m.id}
                  style={[
                    styles.bubbleRow,
                    m.role === "user" ? styles.bubbleRowUser : styles.bubbleRowAi,
                  ]}
                >
                  <View
                    style={[
                      styles.bubble,
                      m.role === "user" ? styles.bubbleUser : styles.bubbleAi,
                    ]}
                  >
                    <Text
                      style={[
                        styles.bubbleText,
                        m.role === "user" ? styles.bubbleTextUser : styles.bubbleTextAi,
                      ]}
                    >
                      {m.text}
                    </Text>
                  </View>
                </View>
              ))}
              {writeSending ? (
                <View style={[styles.bubbleRow, styles.bubbleRowAi]}>
                  <View style={[styles.bubble, styles.bubbleAi]}>
                    <ActivityIndicator color="#D4B896" size="small" />
                  </View>
                </View>
              ) : null}
            </ScrollView>
            <View style={[styles.demoWriteInputRow, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <TextInput
                style={styles.demoWriteInput}
                value={writeInput}
                onChangeText={(t) => {
                  setWriteInput(t);
                  // v66.6: ogni battuta resetta il timer d'inattività 15s.
                  if (t.length > 0) resetInactivityTimer();
                }}
                placeholder="Scrivimi qualcosa…"
                placeholderTextColor="rgba(226,232,240,0.45)"
                editable={!writeSending && !writeCompleted}
                multiline
                maxLength={500}
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={handleWriteSend}
                testID="onboarding-write-input"
              />
              <TouchableOpacity
                onPress={handleWriteSend}
                disabled={!writeInput.trim() || writeSending || writeCompleted}
                style={[
                  styles.demoWriteSendBtn,
                  (!writeInput.trim() || writeSending || writeCompleted) && styles.demoWriteSendBtnDisabled,
                ]}
                testID="onboarding-write-send"
              >
                <Ionicons
                  name="arrow-up"
                  size={20}
                  color={
                    !writeInput.trim() || writeSending || writeCompleted
                      ? "rgba(255,255,255,0.55)" : "#FFFFFF"
                  }
                />
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        )}

        {/* Step 5 demo LA — v66.4 (bug 6): usa EclipseOrb reale con dbBoost
            calcolato dal metering microfonico, identico al pattern di
            /lascia-andare. Il glow champagne pulsa dinamicamente con la
            voce dell'utente. Nessun testo, nessuna registrazione persistente. */}
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
              <EclipseOrb
                status="recording"
                size={ORB_SIZE}
                meterDb={laMeterDb}
                meterThreshold={-40}
                dbBoost={Math.max(
                  0,
                  Math.min(1, (Math.max(-60, Math.min(-20, laMeterDb)) + 60) / 40)
                )}
              />
            </View>
          </View>
        )}

        {/* v66.6 (Fabio 2026-06-16): paused_by_inactivity — orb idle,
            full-screen tap per riavviare l'intro da capo. Rimane finché
            l'utente tocca o chiude l'app (in tal caso al riavvio si torna
            qui via router perché intro_v3_completed_at non è settato). */}
        {step === "paused_by_inactivity" && (
          <TouchableOpacity
            activeOpacity={1}
            style={StyleSheet.absoluteFillObject}
            onPress={() => {
              console.log(`${TAG} tap → restart intro`);
              // Reset di tutti i counter locali e riparti da step 1
              setWriteMessages([]);
              setWriteExchangeCount(0);
              setWriteCompleted(false);
              setWriteInput("");
              setVoiceExchangeCount(0);
              scrimStartedRef.current = {};
              writeStartedRef.current = false;
              voiceStartedRef.current = false;
              micRequestedRef.current = false;
              setStep("step1_speak_intro");
            }}
            testID="onboarding-restart-tap"
            accessibilityLabel="Tocca lo schermo per riavviare"
          >
            <View style={styles.pausedHintWrap} pointerEvents="none">
              <Text style={styles.pausedHintText}>tocca lo schermo per continuare</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Scrim overlay per gli step scrim — v66.6: no auto-dismiss.
            Il testo resta visibile finché Ollenya finisce di parlare
            (advance pilotato da scrimSpeakStep in speak.onDone). */}
        {currentScrimText && (
          <View
            style={[styles.scrimOverlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
            pointerEvents="none"
          >
            <View style={styles.scrimContent}>
              <Text style={styles.scrimText}>{currentScrimText}</Text>
            </View>
          </View>
        )}
      </SafeAreaView>
    </Animated.View>
  );
}

// ==== Styles ================================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: APP_BG },
  safe: { flex: 1 },
  orbWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    position: "relative",
  },
  // v66.4 (bug 7): l'orb è centrato geometricamente nel wrapper flex.
  // Il subtitle vive in un slot separato in absolute-position sotto,
  // così l'aggiunta/rimozione del testo NON sposta l'orb.
  orbCenter: {
    alignItems: "center",
    justifyContent: "center",
  },
  subtitleSlot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "18%",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  subtitle: {
    color: "#F5E6CC",
    fontSize: 17,
    lineHeight: 24,
    textAlign: "center",
    maxWidth: 360,
  },
  // ==== Scrim ====
  scrimOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(31,26,54,0.92)",
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
  bubbleRowUser: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "82%",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  bubbleAi: {
    backgroundColor: CHAT_AI_BG,
    borderWidth: 1,
    borderColor: CHAT_AI_BORDER,
    borderTopLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: CHAT_USER_BG,
    borderTopRightRadius: 4,
  },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  bubbleTextAi: { color: CHAT_AI_TEXT },
  bubbleTextUser: { color: CHAT_USER_TEXT, fontWeight: "500" },
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
    backgroundColor: "rgba(148,163,184,0.08)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.30)",
    color: CHAT_AI_TEXT,
    fontSize: 15,
  },
  demoWriteSendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: CHAT_USER_BG,
  },
  demoWriteSendBtnDisabled: {
    backgroundColor: "rgba(14,124,123,0.35)",
  },
  // v66.6 (Fabio 2026-06-16): pausedHint per lo step di reset inattività.
  pausedHintWrap: {
    position: "absolute",
    left: 0, right: 0, bottom: 60,
    alignItems: "center",
  },
  pausedHintText: {
    color: "rgba(226,232,240,0.5)",
    fontSize: 14,
    letterSpacing: 0.5,
    fontStyle: "italic",
  },
  // ==== Step 5 LA demo ====
  laDemoWrap: {
    flex: 1,
    backgroundColor: APP_BG,
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
