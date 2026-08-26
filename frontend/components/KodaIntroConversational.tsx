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
import * as SecureStore from "expo-secure-store";
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
  // Clip unificata (fix 2026-08-07 iter.7) — sostituisce le 3 clip separate
  // io_sono_koda / grazie_di_essere_qui / da_dove_cominciare che restano
  // su disco ma NON sono più referenziate.
  presentazione_koda: require("../assets/sounds/intro/presentazione_koda-cielo.mp3"),
  io_sono_koda: require("../assets/sounds/intro/io_sono_koda-cielo.mp3"),
  grazie_di_essere_qui: require("../assets/sounds/intro/grazie_di_essere_qui-cielo.mp3"),
  da_dove_cominciare: require("../assets/sounds/intro/da_dove_cominciare-cielo.mp3"),
};

// ==================== EXPECTED TEXT REGISTRY (diag only) ====================
// Testi canonici approvati (copione Presence System V2) — sorgente:
// /app/frontend/scripts/generate-intro-audio.js, chiavi corrispondenti.
// Servono SOLO per il log diagnostico [KODA_INTRO_V2 DIAG] — non usati per
// logica o rendering. Se il testo pronunciato dall'MP3 diverge da questi,
// significa che l'MP3 in assets/sounds/intro/ è disallineato con la sorgente.
const CIELO_CLIP_EXPECTED_TEXT: Record<keyof typeof CIELO_CLIPS, string> = {
  ciao: "Ciao.",
  come_ti_chiami: "Come ti chiami?",
  presentazione_koda: "Io sono Koda. Grazie di essere qui. Da dove ti va di cominciare?",
  io_sono_koda: "Io sono Koda.",
  grazie_di_essere_qui: "Grazie di essere qui.",
  da_dove_cominciare: "Da dove ti va di cominciare?",
};
const CIELO_CLIP_FILENAME: Record<keyof typeof CIELO_CLIPS, string> = {
  ciao: "assets/sounds/intro/ciao-cielo.mp3",
  come_ti_chiami: "assets/sounds/intro/come_ti_chiami-cielo.mp3",
  presentazione_koda: "assets/sounds/intro/presentazione_koda-cielo.mp3",
  io_sono_koda: "assets/sounds/intro/io_sono_koda-cielo.mp3",
  grazie_di_essere_qui: "assets/sounds/intro/grazie_di_essere_qui-cielo.mp3",
  da_dove_cominciare: "assets/sounds/intro/da_dove_cominciare-cielo.mp3",
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
  // #8 — PRESENTAZIONE UNIFICATA (fix 2026-08-07 iter.7)
  //     Prima erano 3 clip separate ("Io sono Koda." + silence 1800 +
  //     "Grazie di essere qui." + silence 1500 + "Da dove ti va di
  //     cominciare?") — l'utente sentiva 3 stacchi netti mentre l'orb
  //     restava sempre viola/speaking, quindi risultava innaturale.
  //     Ora un'unica clip continua: "Io sono Koda. Grazie di essere qui.
  //     Da dove ti va di cominciare?" (4.0s totali, con micro-pause
  //     naturali interne gestite da TTS).
  { kind: "speak", clipKey: "presentazione_koda" },
  // #9 — LIVE RESPONSE: utente parla → thinking → converse → speaking
  //       (dentro il turn, gli stati sono gestiti in sequenza inline)
  { kind: "live_response" },
  // #10 — save profilo + fade a home (thinking durante save)
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

  // === POST-INTRO TRANSITION (2026-08-10, Opzione B) ===
  // Dopo il Turn #10 (save_and_end) l'utente viene portato nella Home vera
  // (index.tsx) tramite router.replace("/") preceduto da un fade orchestrato
  // di 1500ms. Vedi doSaveAndEnd() più sotto per i dettagli.
  // NB: la vecchia Opzione D (phase="free_talk" in-place con voiceStreamConverse
  // loop) è stata rimossa il 2026-08-10 — surrogato non coerente con la vera
  // esperienza Koda che vive solo nel monolite index.tsx.

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

  // === ORB MEASURE 2026-08 (debug parity home ↔ intro) ===
  // measureInWindow ci dà le coordinate assolute dell'orb rispetto alla
  // viewport. Utente le legge sull'overlay in basso a sinistra insieme al
  // valore della home per calcolare l'offset esatto. NON stimare, MISURARE.
  // === CLEANUP 2026-08-26 (Fabio) — state orbMeasure rimosso, resta solo il
  // log console per debug futuro; l'overlay visibile è stato tolto.
  const orbMeasureRef = useRef<any>(null);
  const measureOrb = useCallback(() => {
    try {
      orbMeasureRef.current?.measureInWindow?.((_x: number, y: number, _w: number, h: number) => {
        if (typeof y === "number" && typeof h === "number") {
          console.log(`[ORB_MEASURE:INTRO] y=${y.toFixed(2)} h=${h.toFixed(2)} centerY=${(y + h / 2).toFixed(2)}`);
        }
      });
    } catch {}
  }, []);

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
      // === DIAG LOG STT output (2026-08-07) ===
      try {
        console.log(`[${TAG} DIAG] STT handleListenOutput purpose="${purpose}" rawText="${rawText}" trimmed="${text}" len=${text.length}`);
      } catch {}
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
  // FIX 2026-08-06 iter.5 — voci tagliate.
  // Causa: configureAudioForPlayback era fire-and-forget PRIMA di player.play(),
  // ma setAudioModeAsync su iOS impiega ~50-200ms per stabilizzare la sessione.
  // Se play() partiva PRIMA che la nuova modalità fosse attiva, iOS troncava
  // i primi ms dell'audio (o cambiava routing mid-play).
  // Fix: await la configureAudioForPlayback + 120ms di grace period prima di play.
  const playClip = useCallback(
    async (clipSource: number, onDone: () => void) => {
      await configureAudioForPlayback();
      // Grace period: lascia stabilizzare la audio session prima di play()
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!mountedRef.current) return;
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
  // 2026-08-10 (Opzione B, Fabio): la "Koda vera" vive solo dentro
  // index.tsx (Home). L'Intro V2 non può replicarla senza refactoring del
  // monolite (verifica tecnica precedente). Portiamo quindi l'utente
  // nella Home vera con una transizione morbida:
  //   1. Save profile (onboarded=true → apre finestra 5gg del trial)
  //   2. Prefetch di "/" per pre-montare la Home in background
  //   3. Fade orchestrato dell'intero screen dell'Intro (opacity 1→0, 1500ms)
  //   4. router.replace("/") → la Home si monta con l'animazione fade
  //      nativa di expo-router (già in _layout: animation: "fade")
  // L'orb resta geometricamente al centro sia in Intro che in Home (stesso
  // componente EclipseOrb, stessa posizione), quindi il crossfade fra le
  // due schermate crea la sensazione di continuità dell'orb.
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
    if (!mountedRef.current) return;
    // === SKIP-SPLASH FLAG (2026-08-11, Fabio) ===
    // Scriviamo un timestamp che index.tsx leggerà al mount per decidere se
    // saltare il KodaSplash da 10s. Il timestamp (invece di un semplice "1")
    // permette a index.tsx di ignorare il flag se troppo vecchio — così un
    // eventuale flag "appeso" (crash tra fine Intro e boot) non causerà un
    // salto splash indebito settimane dopo. Comunque cancellato al primo
    // boot successivo indipendentemente dall'esito (vedi handler in index.tsx).
    try {
      await SecureStore.setItemAsync("koda_intro_completed_at", String(Date.now()));
    } catch (e) {
      console.warn(`[${TAG}] set intro_completed_at flag failed:`, e);
    }
    // Prefetch della Home in background, non blocca il fade
    try {
      // @ts-ignore - prefetch è disponibile su expo-router recenti
      router.prefetch?.("/");
    } catch {
      // ignore — prefetch è ottimizzazione opzionale, il fade parte comunque
    }
    setOrbState("idle");
    console.log(`[${TAG}] intro complete → fade out then replace to /`);
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 1500, // fade lungo per sensazione di continuità (non taglio)
      useNativeDriver: true,
    }).start(() => {
      if (!mountedRef.current) return;
      try {
        router.replace("/");
      } catch {
        try { router.back(); } catch {}
      }
    });
  }, [userName, router, screenOpacity]);

  // ==================== TURN EXECUTOR ====================
  useEffect(() => {
    if (!currentTurn) return;
    cleanupCurrent();

    // === DIAG LOG turn entry (2026-08-07, richiesta Fabio) ===
    // Log passivo: nessuna modifica a logica/timing/audio, solo osservazione.
    // Ci permette di ricostruire dall'esterno la sequenza reale eseguita.
    try {
      console.log(`[${TAG} DIAG] enter turn #${turnIdx} kind=${currentTurn.kind}`);
    } catch {}

    switch (currentTurn.kind) {
      case "silence": {
        // orbState opzionale — default "idle" per compat, ma nella sequenza V2
        // TUTTI i silence tra due speak sono orbState="speaking" (Koda non
        // torna idle tra frase e frase). Idle solo all'apertura.
        try {
          console.log(`[${TAG} DIAG] silence label="${currentTurn.label ?? ""}" ms=${currentTurn.ms} orbState=${currentTurn.orbState ?? "idle"}`);
        } catch {}
        setOrbState(currentTurn.orbState ?? "idle");
        timerRef.current = setTimeout(() => advance(), currentTurn.ms);
        break;
      }
      case "speak": {
        setOrbState("speaking");
        const clipSource = CIELO_CLIPS[currentTurn.clipKey];
        // === DIAG LOG speak (2026-08-07) ===
        try {
          const expected = CIELO_CLIP_EXPECTED_TEXT[currentTurn.clipKey];
          const filename = CIELO_CLIP_FILENAME[currentTurn.clipKey];
          console.log(`[${TAG} DIAG] speak clipKey="${currentTurn.clipKey}" file="${filename}" expectedText="${expected}"`);
        } catch {}
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
        // === DIAG LOG listen (2026-08-07) ===
        try {
          console.log(`[${TAG} DIAG] listen purpose="${currentTurn.purpose}" maxMs=${currentTurn.maxMs ?? 30000} showLabel=${!!currentTurn.showLabel}`);
        } catch {}
        configureAudioForRecording();
        timerRef.current = setTimeout(() => {
          startListen(currentTurn.purpose, currentTurn.maxMs ?? 30000, !!currentTurn.showLabel);
        }, 250);
        break;
      }
      case "runtime_tts_name": {
        // === DIAG LOG runtime_tts_name (2026-08-07) ===
        try {
          const nameText = userName ? `${userName}.` : "(nome non catturato, turno saltato)";
          console.log(`[${TAG} DIAG] runtime_tts_name text="${nameText}" voice_id="${VOICE_CIELO_ID}" tone="warm"`);
        } catch {}
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

          // === DIAG LOG live_response STT result (2026-08-07) ===
          try {
            console.log(`[${TAG} DIAG] live_response STT transcript raw="${transcript}" len=${transcript?.length ?? 0}`);
          } catch {}

          // Fase B: thinking + converse
          setOrbState("thinking");
          showLabel("sto pensando");
          const userText = (transcript || "").trim();
          if (!userText) {
            console.warn(`[${TAG}] live_response: transcript empty, skip converse`);
            advance();
            return;
          }
          // === DIAG LOG converse prompt (2026-08-07) ===
          try {
            console.log(`[${TAG} DIAG] converse prompt userText="${userText}" endpoint="${API_BASE}/converse" ephemeral=false`);
          } catch {}
          const aiEntry = await fetchConverse(userText);
          if (!mountedRef.current) return;
          if (!aiEntry) {
            console.warn(`[${TAG}] live_response: converse failed, skip`);
            advance();
            return;
          }
          // === DIAG LOG converse response (2026-08-07) ===
          try {
            console.log(`[${TAG} DIAG] converse response text="${aiEntry.text}" tone="${aiEntry.tone ?? "warm"}" len=${aiEntry.text?.length ?? 0}`);
          } catch {}

          // Fase C: TTS della risposta LLM
          setOrbState("speaking");
          await configureAudioForPlayback();
          // === DIAG LOG runtime TTS for LLM response (2026-08-07) ===
          try {
            console.log(`[${TAG} DIAG] live_response TTS request text="${aiEntry.text}" voice_id="${VOICE_CIELO_ID}" tone="${aiEntry.tone || "warm"}"`);
          } catch {}
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

  // ==================== POST-INTRO TRANSITION ====================
  // (2026-08-10, Opzione B) La transizione dall'Intro V2 alla Home vera
  // avviene interamente dentro `doSaveAndEnd()` — vedi sopra. Nessun free-talk
  // loop qui: la vera Koda vive in index.tsx, l'Intro V2 la introduce e poi
  // le cede il palco con un crossfade morbido.

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
          ref={orbMeasureRef}
          onLayout={measureOrb}
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

        {/* Micro-label sotto l'orb — position:absolute così l'apparire/
            sparire del label NON entra nel flex-flow di centerContainer
            e quindi NON sposta più l'orb via justifyContent:center.
            FIX 2026-08-07 iter.7 — prima il label ("ti ascolto",
            "sto pensando") era nel flex, con marginTop:32 + fontSize:13
            aggiungeva ~49px al gruppo di children durante listen/thinking
            e l'orb si spostava visibilmente in alto rispetto agli altri
            stati. Ora è un overlay che galleggia sotto l'orb senza
            impattare la posizione. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            // Posiziono il label ~32px sotto il bordo inferiore dell'orb.
            // Il centro dell'orb è a Vh/2 − 5 (vedi commento in
            // centerContainer/orbWrap), quindi: bordo inferiore
            // dell'orb = 50% − 5 + ORB_SIZE/2 → label top = 50% + (ORB_SIZE/2 − 5 + 32) = 50% + ORB_SIZE/2 + 27.
            marginTop: ORB_SIZE / 2 + 27,
            alignItems: "center",
          }}
        >
          {labelText && (
            <Animated.Text
              style={[styles.microLabel, { opacity: labelOpacity, marginTop: 0 }]}
            >
              {labelText}
            </Animated.Text>
          )}
        </View>
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

      {/* === ORB MEASURE DEBUG OVERLAY — RIMOSSO (Fabio 2026-08-26) ===
          Era un box "INTRO orb y=... h=... cY=..." in basso a sinistra usato
          per calibrare la posizione dell'orb rispetto alla home. Layout
          stabile → non deve essere visibile agli utenti reali. */}
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
    // FIX 2026-08 VERIFICATO EMPIRICAMENTE — misurazione onLayout →
    // measureInWindow su TestFlight (iPhone 15, Vh=844):
    //   HOME: cY orb = 416.7  →  formula: cY_home = Vh/2 − 5
    //   INTRO: cY orb = 512.0  →  formula: cY_intro = (Vh + paddingTop)/2
    // Con paddingTop:0 + marginBottom:10 su orbWrap:
    //   cY_intro = Vh/2 − marginBottom/2 = Vh/2 − 5  =  cY_home  ✓
    // Vale per QUALSIASI viewport perché "la roba sotto l'orb" della
    // home (gap + statusLabel + gap + hint) ha altezza fissa in pixel,
    // quindi l'orb della home è sempre 5 px sopra il centro geometrico
    // dello schermo, e noi replichiamo esattamente quello.
    // Vecchio valore: paddingTop:180 (stima matematica errata).
    paddingTop: 0,
  },
  orbWrap: {
    alignItems: "center",
    justifyContent: "center",
    // FIX 2026-08 VERIFICATO EMPIRICAMENTE — vedi commento in
    // centerContainer sopra. marginBottom sposta il centro dell'orb
    // esattamente 5 px sopra il centro geometrico dello schermo,
    // combaciando con la posizione della home.
    marginBottom: 10,
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
