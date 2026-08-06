/**
 * KodaIntroConversational.tsx — V2 (2026-08-06, Fabio)
 *
 * Onboarding conversazionale unificato secondo il "Koda Presence System"
 * (vedi /app/memory/KODA_PRESENCE_SYSTEM.md).
 *
 * Principio: Koda non cerca di sembrare umana. Cerca di essere presente.
 * Ogni pausa è una partitura, ogni transizione ha inerzia.
 *
 * ==== SEQUENZA COMPLETA ====
 *
 *  [1200ms silenzio apertura — dare spazio, non fretta]
 *  1. Cielo:  "Ciao."
 *  [900ms — respiro]
 *  2. Cielo:  "Come ti chiami?"
 *  3. [utente parla il proprio nome — STT con retry infinito su silenzio]
 *  [500ms — PAUSA DI ACCOGLIENZA: il nome è stato ricevuto]
 *  4. Cielo (runtime TTS): "[Nome]." (con tone: warm)
 *  [700ms — lasciar risuonare il nome]
 *  5. Cielo:  "Io sono Koda."
 *  [1000ms — passaggio a tono relazionale]
 *  6. Cielo:  "Grazie di essere qui."
 *  [900ms — respiro prima della domanda aperta]
 *  7. Cielo:  "Da dove ti va di cominciare?"
 *  8. [utente parla liberamente — STT con retry]
 *  9. [Koda LLM risposta LIVE: /api/converse → /api/tts → play — l'onboarding
 *      si dissolve nella conversazione reale]
 *  10. [save profilo + transizione fade lunga alla home]
 *
 * ==== INVARIANTI (dal Presence System §2) ====
 *   • Eclissi nera (EclipseOrb), stessa dimensione della home
 *   • NeonBorder attivo, stesso colore-per-stato della home
 *   • Nessuna interruzione visiva (tutti i turni nella stessa schermata)
 *   • Ogni transizione tra stati ha inerzia (600ms di easing nell'orb)
 *   • Deduzione genere in BACKGROUND (silenziosa, non tocca lo script)
 *   • Voice choice RIMOSSA (default Cielo, si cambia dopo in impostazioni)
 *
 * ==== BUG FIX INCLUSI (2026-08-06) ====
 *   • Audio session routing corretto: speaker attivo anche senza cuffie
 *   • STT retry automatico su silenzio: Koda continua ad ascoltare finché
 *     l'utente non parla davvero (fino a maxMs del turno)
 *
 * Route: /intro-v2 (isolata per testing su TestFlight; il vecchio KodaIntro
 * resta live sulla home finché V2 non è validato).
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
  Linking,
  Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";
import EclipseOrb, { OrbStatus, OrbTone } from "./EclipseOrb";
import NeonBorder, { NeonBorderStatus } from "./NeonBorder";
import { api, API_BASE } from "../lib/api";
import { getAuthToken } from "../lib/authToken";
import { useTheme } from "../lib/theme";

const TAG = "KODA_INTRO_V2";

// ==================== AUDIO CLIP REGISTRY (V2 — Presence System) ====================
const CIELO_CLIPS = {
  ciao: require("../assets/sounds/intro/ciao-cielo.mp3"),
  come_ti_chiami: require("../assets/sounds/intro/come_ti_chiami-cielo.mp3"),
  io_sono_koda: require("../assets/sounds/intro/io_sono_koda-cielo.mp3"),
  grazie_di_essere_qui: require("../assets/sounds/intro/grazie_di_essere_qui-cielo.mp3"),
  da_dove_cominciare: require("../assets/sounds/intro/da_dove_cominciare-cielo.mp3"),
};

// Voice ID default (Cielo). Voice choice rimossa dall'onboarding V2 —
// si cambia dopo dalle Impostazioni.
const VOICE_CIELO_ID = "POuqf18evoXOKIqV2Px7";

// ==================== STATE MACHINE TYPES ====================
type OrbState = "idle" | "speaking" | "listening" | "thinking";

type ListenPurpose = "capture_name" | "capture_free_response";

type Turn =
  | { kind: "silence"; ms: number; label?: string; orbState?: OrbState }
  | { kind: "speak"; clipKey: keyof typeof CIELO_CLIPS }
  | { kind: "listen"; purpose: ListenPurpose; maxMs?: number; showLabel?: boolean }
  | { kind: "runtime_tts_name" } // "[Nome]." — runtime, warm tone
  | { kind: "live_response" } // /api/converse → /api/tts → play
  | { kind: "save_and_end" };

// La sequenza — ogni pausa ha un'intenzione (vedi documento Presence System §6)
//
// REGOLA IDLE (2026-08-06 rev.3): l'orb NON deve MAI tornare a idle durante
// l'intro tranne all'apertura. Tra due frasi di Koda: orb resta in "speaking"
// (Koda prende fiato, non "si spegne"). Dopo che l'utente parla: orb va in
// "thinking" (Koda accoglie/riflette). Idle = solo il primissimo momento
// prima che Koda parli per la prima volta.
const CONVERSATION: Turn[] = [
  // #0 — apertura silenziosa: UNICO idle di tutto il flusso
  { kind: "silence", ms: 1500, label: "apertura", orbState: "idle" },
  // #1
  { kind: "speak", clipKey: "ciao" },
  // #2 — respiro tra saluto e prima domanda: Koda NON torna idle,
  //      resta "speaking" (sta prendendo fiato, non si spegne)
  { kind: "silence", ms: 1500, label: "respiro", orbState: "speaking" },
  // #3
  { kind: "speak", clipKey: "come_ti_chiami" },
  // #4 — utente parla: nessuna pausa prima, direttamente recording
  { kind: "listen", purpose: "capture_name", maxMs: 45000, showLabel: true },
  // #5 — ACCOGLIENZA: Koda riflette sul nome, NON idle → thinking.
  //      In BACKGROUND parte il gender lookup silenzioso.
  { kind: "silence", ms: 900, label: "accoglienza", orbState: "thinking" },
  // #6 — "[Nome]." runtime, tone: warm
  { kind: "runtime_tts_name" },
  // #7 — risonanza: Koda resta speaking, non torna idle
  { kind: "silence", ms: 1500, label: "risonanza", orbState: "speaking" },
  // #8
  { kind: "speak", clipKey: "io_sono_koda" },
  // #9 — passaggio a tono relazionale, Koda resta speaking
  { kind: "silence", ms: 1800, label: "relazionale", orbState: "speaking" },
  // #10
  { kind: "speak", clipKey: "grazie_di_essere_qui" },
  // #11 — respiro prima della domanda aperta, Koda resta speaking
  { kind: "silence", ms: 1500, label: "pre-apertura", orbState: "speaking" },
  // #12
  { kind: "speak", clipKey: "da_dove_cominciare" },
  // #13 — LIVE RESPONSE: utente parla → thinking → converse → speaking
  //       (dentro il turn, gli stati sono gestiti in sequenza inline)
  { kind: "live_response" },
  // #14 — save profilo + fade a home (thinking durante save)
  { kind: "save_and_end" },
];

// ==================== ORB STATE → EclipseOrb + NeonBorder ====================
function orbPropsFor(state: OrbState): { status: OrbStatus; tone: OrbTone | null } {
  switch (state) {
    case "idle":
      return { status: "idle", tone: null };
    case "speaking":
      return { status: "speaking", tone: "warm" };
    case "listening":
      return { status: "recording", tone: null };
    case "thinking":
      return { status: "thinking", tone: null };
  }
}

function neonStatusFor(state: OrbState): NeonBorderStatus {
  switch (state) {
    case "idle":
      return "idle";
    case "speaking":
      return "speaking";
    case "listening":
      return "recording";
    case "thinking":
      return "thinking";
  }
}

// ==================== VOLUME NORMALIZATION ====================
function normalizeVolume(rawValue: number): number {
  const clamped = Math.max(-2, Math.min(10, rawValue));
  const linear = (clamped + 2) / 12;
  return Math.sqrt(Math.max(0, linear));
}

// ==================== AUDIO SESSION HELPERS ====================
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

// ==================== RUNTIME TTS FETCH ====================
async function fetchRuntimeTTS(text: string, tone: string = "warm"): Promise<string | null> {
  try {
    const authTok = getAuthToken();
    const r = await fetch(`${API_BASE}/tts`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(authTok ? { Authorization: `Bearer ${authTok}` } : {}),
      },
      body: JSON.stringify({ text, voice_id: VOICE_CIELO_ID, tone }),
    });
    if (!r.ok) {
      console.warn(`[${TAG}] runtime TTS non OK: ${r.status}`);
      return null;
    }
    const blob = await r.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === "string") resolve(result);
        else resolve(null);
      };
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn(`[${TAG}] runtime TTS fetch failed:`, e);
    return null;
  }
}

// ==================== CONVERSE (prima risposta LLM live) ====================
type ConverseAiEntry = { text: string; tone?: string };
async function fetchConverse(text: string): Promise<ConverseAiEntry | null> {
  try {
    const authTok = getAuthToken();
    const r = await fetch(`${API_BASE}/converse`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(authTok ? { Authorization: `Bearer ${authTok}` } : {}),
      },
      body: JSON.stringify({ text, ephemeral: false }),
    });
    if (!r.ok) {
      console.warn(`[${TAG}] converse non OK: ${r.status}`);
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
}

// ==================== COMPONENT ====================
const { width: WINDOW_WIDTH } = Dimensions.get("window");
// Stessa formula della home (index.tsx riga 5071)
const ORB_SIZE = Math.min(WINDOW_WIDTH * 0.78, 360);

export default function KodaIntroConversational() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useTheme();
  const [turnIdx, setTurnIdx] = useState(0);
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [labelText, setLabelText] = useState<string | null>(null);

  // Dati raccolti
  const [userName, setUserName] = useState<string | null>(null);
  const userGenderRef = useRef<"m" | "f" | "ambiguous" | null>(null);

  // Mic permission blocca il flusso?
  const [micBlocked, setMicBlocked] = useState(false);

  // Traccia se i micro-label sono già stati mostrati (first-time only)
  const shownLabels = useRef<Set<string>>(new Set());

  // Riferimenti runtime
  const currentPlayerRef = useRef<AudioPlayer | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenActiveRef = useRef(false);
  const sttSubsRef = useRef<{ remove: () => void }[]>([]);
  const labelOpacity = useRef(new Animated.Value(0)).current;
  const volAnim = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(true);
  // Fade globale della schermata per transizione morbida a fine intro
  const screenOpacity = useRef(new Animated.Value(0)).current;
  // Breathe loop — respirazione continua dell'orb (identica alla home,
  // vedi app/index.tsx riga 5040-5050). Senza questo l'orb sembra "morto"
  // e visivamente più piccolo del suo omologo nella home.
  const breathe = useRef(new Animated.Value(0)).current;

  const currentTurn = CONVERSATION[turnIdx];

  const advance = useCallback((skip = 1) => {
    if (!mountedRef.current) return;
    setTurnIdx((i) => Math.min(i + skip, CONVERSATION.length - 1));
  }, []);

  // ==================== STT CLEANUP HELPER ====================
  const stopSTT = useCallback(() => {
    listenActiveRef.current = false;
    if (listenSafetyRef.current) {
      clearTimeout(listenSafetyRef.current);
      listenSafetyRef.current = null;
    }
    for (const sub of sttSubsRef.current) {
      try { sub.remove(); } catch {}
    }
    sttSubsRef.current = [];
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
    Animated.timing(volAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [volAnim]);

  const cleanupCurrent = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (currentPlayerRef.current) {
      try { currentPlayerRef.current.remove(); } catch {}
      currentPlayerRef.current = null;
    }
    stopSTT();
  }, [stopSTT]);

  // Micro-label first-time-only
  const showLabel = useCallback(
    (text: string) => {
      if (shownLabels.current.has(text)) return;
      shownLabels.current.add(text);
      setLabelText(text);
      labelOpacity.setValue(0);
      Animated.timing(labelOpacity, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }).start();
      setTimeout(() => {
        if (!mountedRef.current) return;
        Animated.timing(labelOpacity, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished && mountedRef.current) setLabelText(null);
        });
      }, 3000);
    },
    [labelOpacity]
  );

  // ==================== HANDLE LISTEN OUTPUT ====================
  // Applica il transcript e avanza (o triggera live_response).
  const handleListenOutput = useCallback(
    (rawText: string, purpose: ListenPurpose) => {
      const text = rawText.trim();
      if (purpose === "capture_name") {
        // Prima parola pulita = nome
        const firstWord = text.split(/\s+/)[0].replace(/[.,!?;:"']/g, "");
        if (firstWord && firstWord.length >= 2) {
          const capitalized = firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
          console.log(`[${TAG}] captured name: "${capitalized}" (raw: "${text}")`);
          setUserName(capitalized);
          // Avvia gender lookup in BACKGROUND — invisibile, non blocca
          api.introGenderFromName(capitalized)
            .then((r) => {
              const g = r?.gender;
              const conf = r?.confidence || 0;
              if (g === "m" || g === "f") {
                if (conf >= 0.7) {
                  userGenderRef.current = g;
                  console.log(`[${TAG}] gender BG lookup: ${g} (conf=${conf.toFixed(2)})`);
                }
              }
            })
            .catch(() => {}); // silenzioso — Claude userà forme agnostiche
        }
        advance();
      } else if (purpose === "capture_free_response") {
        // Passato al chiamante nel turn live_response
        pendingResponseRef.current = text;
        advance();
      }
    },
    [advance]
  );

  // Storage temp per la risposta libera catturata (usata da live_response)
  const pendingResponseRef = useRef<string>("");

  // ==================== START LISTEN (STT con retry su silenzio) ====================
  const startListen = useCallback(
    async (purpose: ListenPurpose, maxMs: number, withLabel: boolean) => {
      if (listenActiveRef.current) return;
      listenActiveRef.current = true;

      // 1. Permission
      try {
        const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!perm.granted) {
          listenActiveRef.current = false;
          console.warn(`[${TAG}] mic/speech permission NOT granted`);
          setMicBlocked(true);
          return;
        }
      } catch (e) {
        console.warn(`[${TAG}] permission request threw:`, e);
        listenActiveRef.current = false;
        timerRef.current = setTimeout(() => advance(), 800);
        return;
      }

      // 2. Stato locale del turno
      let capturedTranscript = "";
      let capturedFinal = false;
      const listenStartTime = Date.now();
      let restartAttempts = 0;
      const MAX_RESTART_ATTEMPTS = 12;
      const RESTART_MIN_REMAINING_MS = 3000;

      // Build startOpts (riusato per restart)
      const startOpts: {
        lang: string;
        interimResults: boolean;
        continuous: boolean;
        maxAlternatives: number;
        addsPunctuation: boolean;
        requiresOnDeviceRecognition: boolean;
        volumeChangeEventOptions: { enabled: boolean; intervalMillis: number };
        iosCategory?: { category: string; categoryOptions: string[]; mode: string };
        androidIntentOptions?: Record<string, number>;
      } = {
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
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 6000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 4000,
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 500,
        };
      }

      const finalize = (text: string) => {
        if (!listenActiveRef.current) return;
        capturedFinal = true;
        stopSTT();
        handleListenOutput(text, purpose);
      };

      const giveUp = () => {
        console.log(`[${TAG}] giveUp: no transcript after ${restartAttempts} attempts in ${Date.now() - listenStartTime}ms`);
        stopSTT();
        // Per intro V2 non ho fallback text: se veramente non parla, advance.
        // Il maxMs alto (45s per nome, 60s per risposta libera) rende
        // questo scenario molto raro. Se accade, l'intro salva con nome
        // vuoto e Claude si arrangia.
        advance();
      };

      const restartOrGiveUp = () => {
        if (capturedFinal || !listenActiveRef.current) return;
        const elapsed = Date.now() - listenStartTime;
        const remaining = maxMs - elapsed;
        restartAttempts++;
        if (remaining < RESTART_MIN_REMAINING_MS || restartAttempts > MAX_RESTART_ATTEMPTS) {
          giveUp();
          return;
        }
        console.log(`[${TAG}] restart STT (attempt ${restartAttempts}, elapsed ${elapsed}ms, remaining ${remaining}ms)`);
        try { ExpoSpeechRecognitionModule.abort(); } catch {}
        setTimeout(() => {
          if (!listenActiveRef.current || capturedFinal) return;
          try { ExpoSpeechRecognitionModule.start(startOpts); } catch (e) {
            console.warn(`[${TAG}] restart start() threw:`, e);
            giveUp();
          }
        }, 250);
      };

      // 3. Listeners
      const subResult = ExpoSpeechRecognitionModule.addListener(
        "result",
        (evt: ExpoSpeechRecognitionResultEvent) => {
          const first = evt.results?.[0];
          if (!first) return;
          const text = first.transcript || "";
          if (text.length > 0) capturedTranscript = text;
          if (evt.isFinal && text.trim().length > 0) {
            console.log(`[${TAG}] result FINAL: "${text}"`);
            finalize(text);
          }
        }
      );
      const subError = ExpoSpeechRecognitionModule.addListener(
        "error",
        (evt: ExpoSpeechRecognitionErrorEvent) => {
          if (evt.error === "aborted") return;
          if (evt.error === "no-speech") {
            if (capturedTranscript.trim().length > 0) {
              finalize(capturedTranscript);
              return;
            }
            restartOrGiveUp();
            return;
          }
          if (!capturedFinal) giveUp();
        }
      );
      const subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
        if (capturedFinal) return;
        if (capturedTranscript.trim().length > 0) {
          finalize(capturedTranscript);
          return;
        }
        if (listenActiveRef.current) restartOrGiveUp();
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

      // 4. Primo start
      try {
        ExpoSpeechRecognitionModule.start(startOpts);
        console.log(`[${TAG}] STT started (purpose=${purpose}, maxMs=${maxMs})`);
      } catch (e) {
        console.warn(`[${TAG}] STT start threw:`, e);
        stopSTT();
        timerRef.current = setTimeout(() => advance(), 500);
        return;
      }

      // 5. Micro-label (first-time-only)
      if (withLabel) showLabel("ti ascolto");

      // 6. Safety net
      listenSafetyRef.current = setTimeout(() => {
        if (capturedFinal) return;
        console.warn(`[${TAG}] listen safety-net (maxMs=${maxMs})`);
        if (capturedTranscript.trim().length > 0) finalize(capturedTranscript);
        else giveUp();
      }, maxMs);
    },
    [advance, stopSTT, volAnim, handleListenOutput, showLabel]
  );

  // ==================== PLAY MP3 CLIP ====================
  const playClip = useCallback(
    (clipSource: number, onDone: () => void) => {
      configureAudioForPlayback();
      try {
        const player = createAudioPlayer(clipSource, { updateInterval: 100 });
        currentPlayerRef.current = player;
        const onStatus = (status: { didJustFinish?: boolean }) => {
          if (status.didJustFinish) {
            try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
            onDone();
          }
        };
        player.addListener("playbackStatusUpdate", onStatus);
        player.play();
        // Safety net: 15s
        timerRef.current = setTimeout(() => {
          console.warn(`[${TAG}] playClip safety-net triggered`);
          onDone();
        }, 15000);
      } catch (e) {
        console.warn(`[${TAG}] playClip failed:`, e);
        timerRef.current = setTimeout(onDone, 500);
      }
    },
    []
  );

  // ==================== RUNTIME TTS NAME "[Nome]." ====================
  const playRuntimeName = useCallback(async () => {
    setOrbState("speaking");
    await configureAudioForPlayback();
    const text = userName ? `${userName}.` : "";
    if (!text) {
      // Se non abbiamo il nome (fallimento STT), salta senza spendere ElevenLabs
      timerRef.current = setTimeout(() => advance(), 400);
      return;
    }
    const uri = await fetchRuntimeTTS(text, "warm");
    if (!uri) {
      timerRef.current = setTimeout(() => advance(), 400);
      return;
    }
    try {
      const player = createAudioPlayer({ uri }, { updateInterval: 100 });
      currentPlayerRef.current = player;
      const onStatus = (status: { didJustFinish?: boolean }) => {
        if (status.didJustFinish) {
          try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
          advance();
        }
      };
      player.addListener("playbackStatusUpdate", onStatus);
      player.play();
      timerRef.current = setTimeout(() => advance(), 8000);
    } catch (e) {
      console.warn(`[${TAG}] runtime TTS name play failed:`, e);
      timerRef.current = setTimeout(() => advance(), 400);
    }
  }, [advance, userName]);

  // ==================== SAVE & END ====================
  const doSaveAndEnd = useCallback(async () => {
    setOrbState("thinking");
    try {
      const user_gender = userGenderRef.current;
      await api.updateProfile({
        name: userName || undefined,
        koda_voice: "aria", // default Cielo
        ai_gender: "f",
        ...(user_gender === "m" || user_gender === "f" ? { user_gender } : {}),
        onboarded: true,
      });
      console.log(`[${TAG}] profile saved: name=${userName} user_gender=${user_gender}`);
    } catch (e) {
      console.warn(`[${TAG}] profile save failed:`, e);
    }
    // Fade morbido a home (Presence System §6: nessun cambio secco)
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 800,
      useNativeDriver: true,
    }).start(() => {
      try { router.replace("/"); } catch { router.back(); }
    });
  }, [userName, router, screenOpacity]);

  // ==================== TURN EXECUTOR ====================
  useEffect(() => {
    if (!currentTurn) return;
    cleanupCurrent();

    switch (currentTurn.kind) {
      case "silence": {
        // orbState opzionale — default "idle" per compat, ma nella sequenza V2
        // TUTTI i silence tra due speak sono orbState="speaking" (Koda non
        // torna idle tra frase e frase). Idle solo all'apertura.
        setOrbState(currentTurn.orbState ?? "idle");
        timerRef.current = setTimeout(() => advance(), currentTurn.ms);
        break;
      }
      case "speak": {
        setOrbState("speaking");
        const clipSource = CIELO_CLIPS[currentTurn.clipKey];
        if (!clipSource) {
          console.warn(`[${TAG}] clip not found: ${currentTurn.clipKey}`);
          timerRef.current = setTimeout(() => advance(), 400);
          break;
        }
        playClip(clipSource, () => advance());
        break;
      }
      case "listen": {
        setOrbState("listening");
        configureAudioForRecording();
        timerRef.current = setTimeout(() => {
          startListen(currentTurn.purpose, currentTurn.maxMs ?? 30000, !!currentTurn.showLabel);
        }, 250);
        break;
      }
      case "runtime_tts_name": {
        playRuntimeName();
        break;
      }
      case "live_response": {
        // Sequenza inline: listen → thinking → converse → speaking → advance
        (async () => {
          setOrbState("listening");
          await configureAudioForRecording();
          // Uso una promise + callback custom per capture (non riuso handleListenOutput
          // perché lì c'è advance automatico che qui NON vogliamo)
          const transcript = await new Promise<string>((resolve) => {
            let done = false;
            const finishOnce = (text: string) => {
              if (done) return;
              done = true;
              resolve(text);
            };

            // Config STT + retry — inline per avere controllo diretto
            let captured = "";
            let capturedFinal = false;
            const startedAt = Date.now();
            let attempts = 0;
            const MAX_ATT = 12;
            const MAX_MS = 60000;
            const MIN_REMAINING = 3000;

            const startOpts: {
              lang: string;
              interimResults: boolean;
              continuous: boolean;
              maxAlternatives: number;
              addsPunctuation: boolean;
              requiresOnDeviceRecognition: boolean;
              volumeChangeEventOptions: { enabled: boolean; intervalMillis: number };
              iosCategory?: { category: string; categoryOptions: string[]; mode: string };
              androidIntentOptions?: Record<string, number>;
            } = {
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
                EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 6000,
                EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 4000,
                EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 500,
              };
            }

            const stopLocal = () => {
              try { ExpoSpeechRecognitionModule.abort(); } catch {}
              for (const s of sttSubsRef.current) { try { s.remove(); } catch {} }
              sttSubsRef.current = [];
              Animated.timing(volAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
            };

            const finalizeLocal = (text: string) => {
              if (capturedFinal) return;
              capturedFinal = true;
              stopLocal();
              finishOnce(text);
            };

            const restartLocal = () => {
              if (capturedFinal) return;
              const elapsed = Date.now() - startedAt;
              const remaining = MAX_MS - elapsed;
              attempts++;
              if (remaining < MIN_REMAINING || attempts > MAX_ATT) {
                stopLocal();
                finishOnce(captured);
                return;
              }
              try { ExpoSpeechRecognitionModule.abort(); } catch {}
              setTimeout(() => {
                if (capturedFinal) return;
                try { ExpoSpeechRecognitionModule.start(startOpts); } catch {
                  stopLocal();
                  finishOnce(captured);
                }
              }, 250);
            };

            sttSubsRef.current = [
              ExpoSpeechRecognitionModule.addListener("result", (evt: ExpoSpeechRecognitionResultEvent) => {
                const first = evt.results?.[0];
                if (!first) return;
                const text = first.transcript || "";
                if (text.length > 0) captured = text;
                if (evt.isFinal && text.trim().length > 0) finalizeLocal(text);
              }),
              ExpoSpeechRecognitionModule.addListener("error", (evt: ExpoSpeechRecognitionErrorEvent) => {
                if (evt.error === "aborted") return;
                if (evt.error === "no-speech") {
                  if (captured.trim().length > 0) { finalizeLocal(captured); return; }
                  restartLocal();
                  return;
                }
                if (!capturedFinal) { stopLocal(); finishOnce(captured); }
              }),
              ExpoSpeechRecognitionModule.addListener("end", () => {
                if (capturedFinal) return;
                if (captured.trim().length > 0) { finalizeLocal(captured); return; }
                restartLocal();
              }),
              ExpoSpeechRecognitionModule.addListener("volumechange", (evt: { value?: number }) => {
                const raw = typeof evt?.value === "number" ? evt.value : -2;
                const norm = normalizeVolume(raw);
                Animated.timing(volAnim, { toValue: norm, duration: 120, useNativeDriver: true }).start();
              }),
            ];

            try { ExpoSpeechRecognitionModule.start(startOpts); } catch {
              stopLocal();
              finishOnce(captured);
            }

            listenSafetyRef.current = setTimeout(() => {
              if (capturedFinal) return;
              stopLocal();
              finishOnce(captured);
            }, MAX_MS);

            showLabel("ti ascolto");
          });

          if (!mountedRef.current) return;

          // Fase B: thinking + converse
          setOrbState("thinking");
          showLabel("sto pensando");
          const userText = (transcript || "").trim();
          if (!userText) {
            console.warn(`[${TAG}] live_response: transcript empty, skip converse`);
            advance();
            return;
          }
          const aiEntry = await fetchConverse(userText);
          if (!mountedRef.current) return;
          if (!aiEntry) {
            console.warn(`[${TAG}] live_response: converse failed, skip`);
            advance();
            return;
          }

          // Fase C: TTS della risposta LLM
          setOrbState("speaking");
          await configureAudioForPlayback();
          const uri = await fetchRuntimeTTS(aiEntry.text, aiEntry.tone || "warm");
          if (!mountedRef.current) return;
          if (!uri) {
            advance();
            return;
          }
          try {
            const player = createAudioPlayer({ uri }, { updateInterval: 100 });
            currentPlayerRef.current = player;
            const onStatus = (status: { didJustFinish?: boolean }) => {
              if (status.didJustFinish) {
                try { player.removeListener("playbackStatusUpdate", onStatus); } catch {}
                advance();
              }
            };
            player.addListener("playbackStatusUpdate", onStatus);
            player.play();
            timerRef.current = setTimeout(() => advance(), 30000);
          } catch (e) {
            console.warn(`[${TAG}] live_response play failed:`, e);
            timerRef.current = setTimeout(() => advance(), 400);
          }
        })();
        break;
      }
      case "save_and_end": {
        doSaveAndEnd();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnIdx]);

  // Mount/unmount + fade-in iniziale della schermata + breathe loop
  useEffect(() => {
    mountedRef.current = true;
    configureAudioForPlayback();
    // Fade-in morbido all'ingresso (Presence System §6: inerzia)
    Animated.timing(screenOpacity, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
    // Breathe loop (identico alla home): 0→1 in 2400ms + 1→0 in 2400ms,
    // ping-pong infinito. L'output viene interpolato a scale 0.95↔1.07.
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
      breatheLoop.stop();
      cleanupCurrent();
    };
  }, [cleanupCurrent, screenOpacity, breathe]);

  // ==================== M4: mic denied handlers ====================
  const onOpenSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);
  const onMicBlockedContinue = useCallback(() => {
    setMicBlocked(false);
    cleanupCurrent();
    router.back();
  }, [cleanupCurrent, router]);

  // ==================== RENDER ====================
  const orbProps = useMemo(() => orbPropsFor(orbState), [orbState]);
  const neonStatus = useMemo(() => neonStatusFor(orbState), [orbState]);
  const isListening = orbState === "listening";
  // Breathe scale (respiro continuo, identico alla home)
  const breatheScale = breathe.interpolate({
    inputRange: [0, 1],
    outputRange: [0.95, 1.07],
  });
  // VU meter scale (solo durante listening, sopra il breathe)
  const vuScale = volAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });

  return (
    <Animated.View
      style={[
        styles.root,
        { backgroundColor: theme.bg, opacity: screenOpacity },
      ]}
    >
      {/* NeonBorder — identico alla home, stessi colori-per-stato */}
      <NeonBorder
        status={neonStatus}
        thickness={neonStatus === "idle" ? 2 : 3}
      />

      {/* Skip (×) discreto in alto a destra */}
      <TouchableOpacity
        onPress={() => {
          cleanupCurrent();
          router.back();
        }}
        style={[styles.skipBtn, { top: insets.top + 12 }]}
        hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
        testID="intro-v2-skip"
      >
        <Ionicons name="close" size={20} color="rgba(226,232,240,0.5)" />
      </TouchableOpacity>

      {/* Orb centrale — stessa dimensione E stesso respiro della home */}
      <View style={styles.centerContainer}>
        <Animated.View
          style={[
            styles.orbWrap,
            {
              transform: isListening
                ? [{ scale: breatheScale }, { scale: vuScale }]
                : [{ scale: breatheScale }],
            },
          ]}
        >
          <EclipseOrb
            status={orbProps.status}
            tone={orbProps.tone}
            size={ORB_SIZE}
          />
        </Animated.View>

        {/* Micro-label sotto l'orb (first-time only, fade in/out) */}
        {labelText && (
          <Animated.Text
            style={[styles.microLabel, { opacity: labelOpacity }]}
          >
            {labelText}
          </Animated.Text>
        )}
      </View>

      {/* Mic denied overlay */}
      {micBlocked && (
        <View style={styles.micBlockedOverlay}>
          <View style={styles.micBlockedCard}>
            <Ionicons name="mic-off-outline" size={32} color="#D4B896" />
            <Text style={styles.micBlockedTitle}>Mi serve il microfono</Text>
            <Text style={styles.micBlockedText}>
              Per riconoscerti quando torni. Se vuoi, apri le impostazioni e
              attivalo — poi ricominciamo insieme.
            </Text>
            <TouchableOpacity style={styles.micBlockedPrimaryBtn} onPress={onOpenSettings}>
              <Text style={styles.micBlockedPrimaryText}>Apri Impostazioni</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.micBlockedSecondaryBtn} onPress={onMicBlockedContinue}>
              <Text style={styles.micBlockedSecondaryText}>Per ora esco</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </Animated.View>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  skipBtn: {
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
    // FIX 2026-08-06 iter.4 — matching home Page 0 layout:
    // vedi app/index.tsx riga 5011 → `paddingTop: 90`. Senza questo l'orb
    // si vede 90px più in alto rispetto alla home, dando la sensazione
    // che "si sposta" nella transizione tra le due schermate.
    paddingTop: 90,
  },
  orbWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  microLabel: {
    marginTop: 32,
    fontSize: 13,
    color: "rgba(226,232,240,0.65)",
    fontStyle: "italic",
    letterSpacing: 0.3,
  },
  micBlockedOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(15, 15, 26, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    paddingHorizontal: 28,
  },
  micBlockedCard: {
    width: "100%",
    maxWidth: 340,
    paddingVertical: 26,
    paddingHorizontal: 22,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.25)",
    alignItems: "center",
  },
  micBlockedTitle: {
    color: "#F5E6CC",
    fontSize: 17,
    fontWeight: "700",
    marginTop: 12,
    letterSpacing: 0.3,
  },
  micBlockedText: {
    color: "rgba(226,232,240,0.75)",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 10,
    marginBottom: 20,
  },
  micBlockedPrimaryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 26,
    borderRadius: 999,
    backgroundColor: "#D4B896",
    marginBottom: 10,
  },
  micBlockedPrimaryText: {
    color: "#1F1A36",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  micBlockedSecondaryBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  micBlockedSecondaryText: {
    color: "rgba(226,232,240,0.55)",
    fontSize: 13,
  },
});
