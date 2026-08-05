/**
 * KodaIntroConversational.tsx — M2+M3+M4 (2026-08-06, Fabio)
 *
 * Onboarding conversazionale unificato di Koda: UN SOLO flusso, senza
 * schermate testuali, senza bottoni "Continua/Ho capito", con l'orb
 * che cambia stato dal vivo esattamente come nell'uso quotidiano.
 *
 * ==== TUTTO IL FLUSSO (M2+M3+M4) ====
 *
 *  1. Silenzio 2.5s — Apertura
 *  2. Cielo: "Sono qui. Non ho fretta…"
 *  3. Cielo: "Solo di riconoscerti quando torni."
 *  4. Cielo: "Come ti chiamo?"
 *  5. STT — cattura nome (12s max) + VU meter orb
 *  6. Think (2s) — background: gender detection via /intro/gender-from-name
 *  7. Runtime TTS Cielo: "Ciao [Nome], piacere di conoscerti."
 *  8. Cielo: "E cosa ti ha portato qui, se ti va di dirmelo?"
 *  9. STT — risposta libera (25s)
 * 10. Think (1.5s)
 * 11. Cielo: "Grazie."
 * 12. Cielo: "Quando torni da me, com'è di solito la tua giornata?"
 * 13. STT — risposta libera (25s)
 * 14. Think (1.5s)
 * 15. Vento: "Anche io sono Koda." (colpo di scena)
 * 16. Vento: "Puoi sceglierci."
 * 17. VOICE CHOICE — STT keyword matching (vocale) → fallback 2 orb tap
 * 18. Speak confirm_choice con voce scelta: "Bene. Sarò qui."
 * 19. [SE gender=ambiguous] Cielo: "Solo per essere sicura — preferisci…"
 * 20. [SE gender=ambiguous] STT — cattura risposta gender (10s)
 * 21. SAVE — api.updateProfile({name, user_gender, koda_voice, ai_gender,
 *     onboarded:true}) + naviga a /
 *
 * ==== M4 EDGE CASES COPERTI ====
 *   • Mic permission negato → messaggio in-character + bottone "Apri
 *     Impostazioni" (Linking.openSettings()) + skip graceful del flusso
 *   • STT fallisce 2 volte consecutive → fallback TextInput con placeholder
 *     "scrivimi qui" (mantiene il flusso su binario, l'utente scrive
 *     il nome/genere invece di dirlo)
 *   • Voice choice non riconosciuta (STT parsing ambiguo) → dopo 2
 *     tentativi mostra due orb affiancati tap-to-select
 *   • Skip (×) globale → cleanup completo + router.back()
 *   • Runtime TTS fetch fail → skip graceful della frase con nome
 *   • Backend gender detection fail/timeout → fallback ambiguous (chiede)
 *
 * Route: /intro-v2 (isolata per testing; il vecchio KodaIntro resta live
 * sulla home finché non è validato su TestFlight).
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
  TextInput,
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";
import EclipseOrb, { OrbStatus, OrbTone } from "./EclipseOrb";
import { api, API_BASE } from "../lib/api";
import { getAuthToken } from "../lib/authToken";

const TAG = "KODA_INTRO_V2";

// ==================== AUDIO CLIP REGISTRY ====================
// Metro bundler risolve i require() statici in build-time e inlina
// gli asset nell'IPA. Ogni clip corrisponde a un file MP3 generato
// da scripts/generate-intro-audio.js (M1).
const CIELO_CLIPS = {
  intro_1a: require("../assets/sounds/intro/intro_1a-cielo.mp3"),
  intro_1b: require("../assets/sounds/intro/intro_1b-cielo.mp3"),
  ask_name: require("../assets/sounds/intro/ask_name-cielo.mp3"),
  ask_why: require("../assets/sounds/intro/ask_why-cielo.mp3"),
  filler: require("../assets/sounds/intro/filler-cielo.mp3"),
  ask_day: require("../assets/sounds/intro/ask_day-cielo.mp3"),
  confirm_choice: require("../assets/sounds/intro/confirm_choice-cielo.mp3"),
  ask_gender: require("../assets/sounds/intro/ask_gender-cielo.mp3"),
};
const VENTO_CLIPS = {
  vento_reveal_1: require("../assets/sounds/intro/vento_reveal_1-vento.mp3"),
  vento_reveal_2: require("../assets/sounds/intro/vento_reveal_2-vento.mp3"),
  confirm_choice: require("../assets/sounds/intro/confirm_choice-vento.mp3"),
};

// ==================== VOICE CONSTANTS ====================
// Voice IDs ElevenLabs (allineati con backend KODA_VOICES).
const VOICE_CIELO_ID = "POuqf18evoXOKIqV2Px7"; // aria
const VOICE_VENTO_ID = "ll9WG7PDTuyHwgC5MD6g"; // theo

// ==================== STATE MACHINE TYPES ====================
type OrbState = "idle" | "speaking" | "listening" | "thinking";
type VoiceKey = "cielo" | "vento";

// Cosa fare con il transcript catturato in un turno di listen.
type ListenPurpose = "capture_name" | "capture_gender" | "voice_choice" | "discard";

type Turn =
  | { kind: "silence"; ms: number }
  | { kind: "speak"; voice: VoiceKey; clipKey: string }
  | { kind: "listen"; label?: string; purpose: ListenPurpose; maxMs?: number }
  | { kind: "think"; ms: number; task?: "gender_lookup" }
  | { kind: "runtime_tts"; voice: VoiceKey; template: string } // template usa {name}
  | { kind: "voice_choice_reveal_orbs" } // mostra 2 orb per tap-to-select (fallback UI)
  | { kind: "conditional_gender_ask" } // se gender==ambiguous, entra nel ramo ask
  | { kind: "save_and_end" };

// Sequenza conversazionale completa.
// Note su turni condizionali:
//  - `conditional_gender_ask` è un branching node: se gender!='ambiguous' skippa
//    i due turni successivi (speak ask_gender + listen capture_gender)
const CONVERSATION: Turn[] = [
  { kind: "silence", ms: 2500 },
  { kind: "speak", voice: "cielo", clipKey: "intro_1a" },
  { kind: "silence", ms: 500 },
  { kind: "speak", voice: "cielo", clipKey: "intro_1b" },
  { kind: "silence", ms: 700 },
  { kind: "speak", voice: "cielo", clipKey: "ask_name" },
  { kind: "listen", label: "ti ascolto", purpose: "capture_name", maxMs: 12000 },
  { kind: "think", ms: 2000, task: "gender_lookup" },
  { kind: "runtime_tts", voice: "cielo", template: "Ciao {name}, piacere di conoscerti." },
  { kind: "speak", voice: "cielo", clipKey: "ask_why" },
  { kind: "listen", label: "ti ascolto", purpose: "discard", maxMs: 25000 },
  { kind: "think", ms: 1500 },
  { kind: "speak", voice: "cielo", clipKey: "filler" },
  { kind: "silence", ms: 300 },
  { kind: "speak", voice: "cielo", clipKey: "ask_day" },
  { kind: "listen", label: "ti ascolto", purpose: "discard", maxMs: 25000 },
  { kind: "think", ms: 1500 },
  // === REVEAL VENTO — colpo di scena ===
  { kind: "speak", voice: "vento", clipKey: "vento_reveal_1" },
  { kind: "silence", ms: 600 },
  { kind: "speak", voice: "vento", clipKey: "vento_reveal_2" },
  // === VOICE CHOICE ===
  { kind: "listen", label: undefined, purpose: "voice_choice", maxMs: 15000 },
  // Turno di conferma — la voce dipende dalla scelta (risolto a runtime)
  { kind: "speak", voice: "cielo", clipKey: "confirm_choice" }, // voice sovrascritta in runtime
  // === GENDER QUERY (condizionale) ===
  { kind: "conditional_gender_ask" }, // salta i due turni successivi se non serve
  { kind: "speak", voice: "cielo", clipKey: "ask_gender" },
  { kind: "listen", label: "ti ascolto", purpose: "capture_gender", maxMs: 10000 },
  // === SAVE + END ===
  { kind: "save_and_end" },
];

// ==================== ORB STATE → EclipseOrb PROPS ====================
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

// ==================== VOLUME NORMALIZATION ====================
// expo-speech-recognition emette `volumechange` con value ∈ [-2, 10].
// Normalizziamo su [0..1] con compressione sqrt per rispondere anche
// alle voci morbide.
function normalizeVolume(rawValue: number): number {
  const clamped = Math.max(-2, Math.min(10, rawValue));
  const linear = (clamped + 2) / 12;
  return Math.sqrt(Math.max(0, linear));
}

// ==================== KEYWORD MATCHING per VOICE CHOICE ====================
// Ritorna la voce scelta se riconosciuta, altrimenti null.
function parseVoiceChoice(transcript: string): VoiceKey | null {
  const t = transcript.toLowerCase().trim();
  if (!t) return null;
  // Cielo — femminile / prima / la donna / voce chiara
  if (/\bcielo\b|\bprim[ao]\b|\buno\b|\bfemminile\b|\bdonna\b|\blei\b|\bchiar[ao]\b/.test(t)) {
    return "cielo";
  }
  // Vento — maschile / seconda / l'altra / grave / lui
  if (/\bvento\b|\bsecond[ao]\b|\bdue\b|\baltro\b|\baltra\b|\bmaschile\b|\buomo\b|\blui\b|\bgrav[ae]\b/.test(t)) {
    return "vento";
  }
  return null;
}

// ==================== KEYWORD MATCHING per GENDER ====================
function parseUserGender(transcript: string): "m" | "f" | null {
  const t = transcript.toLowerCase().trim();
  if (!t) return null;
  if (/\bl[ei][io]\b|\buomo\b|\bmaschio\b|\bmaschile\b|\bragazz[oi]\b|\bsignore\b/.test(t)) {
    return "m";
  }
  if (/\blei\b|\bdonna\b|\bfemmin[ai]\b|\bragazz[ae]\b|\bsignora\b/.test(t)) {
    return "f";
  }
  return null;
}

// ==================== RUNTIME TTS FETCH ====================
// Genera un MP3 al volo dall'endpoint /api/tts (già esistente). Ritorna
// URI locale usable da createAudioPlayer, o null in caso di fail.
async function fetchRuntimeTTS(text: string, voice: VoiceKey): Promise<string | null> {
  try {
    const voice_id = voice === "vento" ? VOICE_VENTO_ID : VOICE_CIELO_ID;
    const authTok = getAuthToken();
    const r = await fetch(`${API_BASE}/tts`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(authTok ? { Authorization: `Bearer ${authTok}` } : {}),
      },
      body: JSON.stringify({ text, voice_id, tone: "warm" }),
    });
    if (!r.ok) {
      console.warn(`[${TAG}] runtime TTS non OK: ${r.status}`);
      return null;
    }
    const blob = await r.blob();
    // Convert blob → base64 data URI (funziona su React Native con expo-audio)
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

// ==================== COMPONENT ====================
export default function KodaIntroConversational() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [turnIdx, setTurnIdx] = useState(0);
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [labelText, setLabelText] = useState<string | null>(null);

  // === Dati raccolti durante il flusso ===
  const [userName, setUserName] = useState<string | null>(null);
  const [userGender, setUserGender] = useState<"m" | "f" | "ambiguous" | null>(null);
  const [voiceChoice, setVoiceChoice] = useState<VoiceKey | null>(null);

  // === UI states per fallback M4 ===
  // Mic permission blocca il flusso? Se true, mostro overlay con "Apri Impostazioni".
  const [micBlocked, setMicBlocked] = useState(false);
  // Contatore fallimenti STT consecutivi (per fallback TextInput dopo 2)
  const sttFailCountRef = useRef(0);
  const [textFallbackVisible, setTextFallbackVisible] = useState(false);
  const [textFallbackValue, setTextFallbackValue] = useState("");
  const [textFallbackPlaceholder, setTextFallbackPlaceholder] = useState("scrivimi qui…");
  // Voice choice tap fallback (dopo 2 STT failures nel voice_choice turn)
  const voiceChoiceAttemptsRef = useRef(0);
  const [voiceChoiceOrbsVisible, setVoiceChoiceOrbsVisible] = useState(false);

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
  // Callback pendente per turno TextInput fallback
  const textFallbackResolverRef = useRef<((text: string) => void) | null>(null);

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
      try {
        sub.remove();
      } catch {}
    }
    sttSubsRef.current = [];
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
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
      try {
        currentPlayerRef.current.remove();
      } catch {}
      currentPlayerRef.current = null;
    }
    stopSTT();
  }, [stopSTT]);

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

  // ==================== TEXT FALLBACK ====================
  // Mostra un TextInput che si comporta come un "listen" invisibile.
  // Restituisce il testo inserito via callback.
  const showTextFallback = useCallback(
    (placeholder: string): Promise<string> => {
      setTextFallbackPlaceholder(placeholder);
      setTextFallbackValue("");
      setTextFallbackVisible(true);
      return new Promise<string>((resolve) => {
        textFallbackResolverRef.current = resolve;
      });
    },
    []
  );

  const submitTextFallback = useCallback(() => {
    const text = textFallbackValue.trim();
    setTextFallbackVisible(false);
    Keyboard.dismiss();
    const resolver = textFallbackResolverRef.current;
    textFallbackResolverRef.current = null;
    if (resolver) resolver(text);
  }, [textFallbackValue]);

  // ==================== HANDLE LISTEN OUTPUT ====================
  // Applica il transcript catturato in base a `purpose` e avanza.
  const handleListenOutput = useCallback(
    (rawText: string, purpose: ListenPurpose) => {
      const text = rawText.trim();
      if (purpose === "capture_name") {
        const firstWord = text.split(/\s+/)[0].replace(/[.,!?;:"']/g, "");
        if (firstWord && firstWord.length >= 2) {
          console.log(`[${TAG}] captured name: "${firstWord}"`);
          setUserName(firstWord);
          sttFailCountRef.current = 0;
        } else {
          sttFailCountRef.current++;
        }
      } else if (purpose === "capture_gender") {
        const g = parseUserGender(text);
        if (g) {
          console.log(`[${TAG}] captured user_gender: ${g}`);
          setUserGender(g);
          sttFailCountRef.current = 0;
        } else {
          // Non riconosciuto → default femminile (statisticamente più
          // frequente nell'onboarding wellness, M4 potrà raffinare)
          console.log(`[${TAG}] gender not parsable, default f`);
          setUserGender("f");
        }
      } else if (purpose === "voice_choice") {
        const v = parseVoiceChoice(text);
        if (v) {
          console.log(`[${TAG}] captured voice_choice: ${v}`);
          setVoiceChoice(v);
          sttFailCountRef.current = 0;
          voiceChoiceAttemptsRef.current = 0;
        } else {
          voiceChoiceAttemptsRef.current++;
          if (voiceChoiceAttemptsRef.current >= 2) {
            // Fallback tap orbs — mostra UI (gestito nel render)
            setVoiceChoiceOrbsVisible(true);
            // Non avanzare finché l'utente non tocca un orb
            return;
          }
          // 1° tentativo fallito: retry silenziosamente (ripeti listen)
          // Semplice: torna indietro di 1 (re-esegue lo stesso turno).
          // In pratica settiamo turnIdx=turnIdx (re-trigger effect) — troppo
          // complicato, meglio non fare retry qui: forziamo tap.
          setVoiceChoiceOrbsVisible(true);
          return;
        }
      }
      // Advance
      advance();
    },
    [advance]
  );

  // ==================== START LISTEN (STT) ====================
  const startListen = useCallback(
    async (purpose: ListenPurpose, maxMs: number) => {
      if (listenActiveRef.current) return;
      listenActiveRef.current = true;

      // Se abbiamo già fallito 2 volte in STT, salta direttamente al fallback text
      if (sttFailCountRef.current >= 2 && purpose !== "voice_choice") {
        listenActiveRef.current = false;
        console.log(`[${TAG}] stt fail count>=2 → text fallback for ${purpose}`);
        const placeholder =
          purpose === "capture_name"
            ? "scrivi il tuo nome…"
            : purpose === "capture_gender"
            ? "uomo o donna?"
            : "scrivi la tua risposta…";
        const inputText = await showTextFallback(placeholder);
        handleListenOutput(inputText, purpose);
        return;
      }

      // 1. Permission check + request
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

      // 2. Registra listeners PRIMA di start()
      let capturedTranscript = "";
      let capturedFinal = false;

      const finalize = (text: string) => {
        if (!listenActiveRef.current) return;
        capturedFinal = true;
        stopSTT();
        handleListenOutput(text, purpose);
      };

      const subResult = ExpoSpeechRecognitionModule.addListener(
        "result",
        (evt: ExpoSpeechRecognitionResultEvent) => {
          const first = evt.results?.[0];
          if (!first) return;
          const text = first.transcript || "";
          capturedTranscript = text;
          if (evt.isFinal) {
            console.log(`[${TAG}] result FINAL: "${text}" (purpose=${purpose})`);
            finalize(text);
          }
        }
      );

      const subError = ExpoSpeechRecognitionModule.addListener(
        "error",
        (evt: ExpoSpeechRecognitionErrorEvent) => {
          console.log(`[${TAG}] error code=${evt.error} msg="${evt.message || ""}"`);
          if (evt.error === "aborted") return;
          if (evt.error === "no-speech") {
            if (capturedTranscript.trim().length > 0) {
              finalize(capturedTranscript);
              return;
            }
            if (!capturedFinal) {
              sttFailCountRef.current++;
              stopSTT();
              // Per voice_choice: incrementa attempts e mostra tap se >=2
              if (purpose === "voice_choice") {
                voiceChoiceAttemptsRef.current++;
                if (voiceChoiceAttemptsRef.current >= 2) {
                  setVoiceChoiceOrbsVisible(true);
                  return;
                }
              }
              // Per altri purpose: text fallback se già 2 fail totali
              if (sttFailCountRef.current >= 2) {
                const placeholder =
                  purpose === "capture_name"
                    ? "scrivi il tuo nome…"
                    : purpose === "capture_gender"
                    ? "uomo o donna?"
                    : "scrivi la tua risposta…";
                showTextFallback(placeholder).then((t) =>
                  handleListenOutput(t, purpose)
                );
                return;
              }
              // Prima fail: avanza semplicemente (M4 policy: no retry
              // conversazionale per non essere invasivi; se serve, l'utente
              // ripete al prossimo turno con text fallback)
              advance();
            }
            return;
          }
          // Errori seri → skip
          if (!capturedFinal) {
            sttFailCountRef.current++;
            stopSTT();
            timerRef.current = setTimeout(() => advance(), 500);
          }
        }
      );

      const subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
        if (capturedFinal) return;
        if (capturedTranscript.trim().length > 0) {
          finalize(capturedTranscript);
        } else if (listenActiveRef.current) {
          // Same treatment as no-speech
          sttFailCountRef.current++;
          stopSTT();
          if (purpose === "voice_choice") {
            voiceChoiceAttemptsRef.current++;
            if (voiceChoiceAttemptsRef.current >= 2) {
              setVoiceChoiceOrbsVisible(true);
              return;
            }
          }
          if (sttFailCountRef.current >= 2 && purpose !== "voice_choice") {
            const placeholder =
              purpose === "capture_name"
                ? "scrivi il tuo nome…"
                : purpose === "capture_gender"
                ? "uomo o donna?"
                : "scrivi la tua risposta…";
            showTextFallback(placeholder).then((t) =>
              handleListenOutput(t, purpose)
            );
            return;
          }
          advance();
        }
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
        const startOpts: {
          lang: string;
          interimResults: boolean;
          continuous: boolean;
          maxAlternatives: number;
          addsPunctuation: boolean;
          requiresOnDeviceRecognition: boolean;
          volumeChangeEventOptions: { enabled: boolean; intervalMillis: number };
          iosCategory?: {
            category: string;
            categoryOptions: string[];
            mode: string;
          };
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
            EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4000,
            EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 3000,
            EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 500,
          };
        }
        ExpoSpeechRecognitionModule.start(startOpts);
        console.log(`[${TAG}] STT started (purpose=${purpose}, maxMs=${maxMs})`);
      } catch (e) {
        console.warn(`[${TAG}] STT start threw:`, e);
        stopSTT();
        timerRef.current = setTimeout(() => advance(), 500);
        return;
      }

      listenSafetyRef.current = setTimeout(() => {
        if (capturedFinal) return;
        console.warn(`[${TAG}] listen safety-net triggered (maxMs=${maxMs})`);
        if (capturedTranscript.trim().length > 0) {
          finalize(capturedTranscript);
        } else {
          sttFailCountRef.current++;
          stopSTT();
          if (purpose === "voice_choice") {
            voiceChoiceAttemptsRef.current++;
            setVoiceChoiceOrbsVisible(true);
            return;
          }
          if (sttFailCountRef.current >= 2) {
            const placeholder =
              purpose === "capture_name"
                ? "scrivi il tuo nome…"
                : purpose === "capture_gender"
                ? "uomo o donna?"
                : "scrivi la tua risposta…";
            showTextFallback(placeholder).then((t) =>
              handleListenOutput(t, purpose)
            );
            return;
          }
          advance();
        }
      }, maxMs);
    },
    [advance, stopSTT, volAnim, handleListenOutput, showTextFallback]
  );

  // ==================== BACKGROUND: gender lookup ====================
  const doGenderLookup = useCallback(async () => {
    if (!userName) {
      setUserGender("ambiguous");
      return;
    }
    try {
      const r = await api.introGenderFromName(userName);
      const g = r?.gender || "ambiguous";
      const conf = r?.confidence || 0;
      // Se ambiguous OR confidence bassa → chiediamo direttamente
      if (g === "ambiguous" || conf < 0.7) {
        console.log(`[${TAG}] gender lookup uncertain (g=${g} conf=${conf})`);
        setUserGender("ambiguous");
      } else {
        console.log(`[${TAG}] gender lookup confident: ${g} (conf=${conf})`);
        setUserGender(g);
      }
    } catch (e) {
      console.warn(`[${TAG}] gender lookup failed:`, e);
      setUserGender("ambiguous");
    }
  }, [userName]);

  // ==================== BACKGROUND: runtime TTS greeting ====================
  const playRuntimeTTS = useCallback(
    async (template: string, voice: VoiceKey) => {
      setOrbState("speaking");
      const text = template.replace("{name}", userName || "amico");
      const uri = await fetchRuntimeTTS(text, voice);
      if (!uri) {
        console.warn(`[${TAG}] runtime TTS skipped (fetch failed)`);
        timerRef.current = setTimeout(() => advance(), 500);
        return;
      }
      try {
        const player = createAudioPlayer({ uri }, { updateInterval: 100 });
        currentPlayerRef.current = player;
        const onStatus = (status: { didJustFinish?: boolean }) => {
          if (status.didJustFinish) {
            try {
              player.removeListener("playbackStatusUpdate", onStatus);
            } catch {}
            advance();
          }
        };
        player.addListener("playbackStatusUpdate", onStatus);
        player.play();
        // Safety net
        timerRef.current = setTimeout(() => {
          console.warn(`[${TAG}] runtime TTS safety-net triggered`);
          advance();
        }, 12000);
      } catch (e) {
        console.warn(`[${TAG}] runtime TTS play failed:`, e);
        timerRef.current = setTimeout(() => advance(), 500);
      }
    },
    [advance, userName]
  );

  // ==================== SAVE & END ====================
  const doSaveAndEnd = useCallback(async () => {
    setOrbState("thinking");
    try {
      // Map voice choice → koda_voice (backend key) + ai_gender
      const koda_voice = voiceChoice === "vento" ? "theo" : "aria";
      const ai_gender = voiceChoice === "vento" ? "m" : "f";
      const user_gender =
        userGender === "m" ? "m" : userGender === "f" ? "f" : undefined;
      await api.updateProfile({
        name: userName || undefined,
        koda_voice,
        ai_gender,
        ...(user_gender ? { user_gender } : {}),
        onboarded: true,
      });
      console.log(
        `[${TAG}] profile saved: name=${userName} voice=${koda_voice} ai_g=${ai_gender} u_g=${user_gender}`
      );
    } catch (e) {
      console.warn(`[${TAG}] profile save failed:`, e);
    }
    // Brief settle poi torna alla home
    timerRef.current = setTimeout(() => {
      // Reset stack navigation e vai alla home
      try {
        router.replace("/");
      } catch {
        router.back();
      }
    }, 800);
  }, [userName, userGender, voiceChoice, router]);

  // ==================== TURN EXECUTOR ====================
  useEffect(() => {
    if (!currentTurn) return;
    cleanupCurrent();

    switch (currentTurn.kind) {
      case "silence": {
        setOrbState("idle");
        timerRef.current = setTimeout(() => advance(), currentTurn.ms);
        break;
      }

      case "speak": {
        setOrbState("speaking");
        try {
          // Per confirm_choice: se voiceChoice esiste, usa quella voce
          let voice = currentTurn.voice;
          if (currentTurn.clipKey === "confirm_choice" && voiceChoice) {
            voice = voiceChoice;
          }
          const clipMap = voice === "vento" ? VENTO_CLIPS : CIELO_CLIPS;
          const clipSource = (clipMap as Record<string, number>)[currentTurn.clipKey];
          if (!clipSource) {
            console.warn(`[${TAG}] clip not found: ${voice}/${currentTurn.clipKey}`);
            timerRef.current = setTimeout(() => advance(), 400);
            break;
          }
          const player = createAudioPlayer(clipSource, { updateInterval: 100 });
          currentPlayerRef.current = player;
          const onStatus = (status: { didJustFinish?: boolean }) => {
            if (status.didJustFinish) {
              try {
                player.removeListener("playbackStatusUpdate", onStatus);
              } catch {}
              advance();
            }
          };
          player.addListener("playbackStatusUpdate", onStatus);
          player.play();
          timerRef.current = setTimeout(() => {
            console.warn(`[${TAG}] speak safety-net for`, currentTurn.clipKey);
            advance();
          }, 10000);
        } catch (e) {
          console.warn(`[${TAG}] audio playback failed:`, e);
          timerRef.current = setTimeout(() => advance(), 800);
        }
        break;
      }

      case "listen": {
        setOrbState("listening");
        if (currentTurn.label) showLabel(currentTurn.label);
        timerRef.current = setTimeout(() => {
          startListen(currentTurn.purpose, currentTurn.maxMs ?? 20000);
        }, 250);
        break;
      }

      case "think": {
        setOrbState("thinking");
        showLabel("sto pensando");
        // Task async in background (gender lookup)
        if (currentTurn.task === "gender_lookup") {
          doGenderLookup();
        }
        timerRef.current = setTimeout(() => advance(), currentTurn.ms);
        break;
      }

      case "runtime_tts": {
        playRuntimeTTS(currentTurn.template, currentTurn.voice);
        break;
      }

      case "conditional_gender_ask": {
        // Se gender è già noto (m o f) → salta i 2 turni successivi (ask + listen)
        if (userGender && userGender !== "ambiguous") {
          console.log(`[${TAG}] gender=${userGender} → skip ask_gender branch`);
          advance(3); // skip conditional + speak + listen → arriva a save_and_end
        } else {
          advance(1); // procedi con speak ask_gender
        }
        break;
      }

      case "save_and_end": {
        doSaveAndEnd();
        break;
      }

      case "voice_choice_reveal_orbs": {
        // Non usato direttamente — è un placeholder per turnare via UI tap
        setVoiceChoiceOrbsVisible(true);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnIdx]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupCurrent();
    };
  }, [cleanupCurrent]);

  // ==================== HANDLERS FALLBACK UI ====================
  const onTapVoiceChoice = useCallback(
    (v: VoiceKey) => {
      console.log(`[${TAG}] voice choice via tap: ${v}`);
      setVoiceChoice(v);
      setVoiceChoiceOrbsVisible(false);
      voiceChoiceAttemptsRef.current = 0;
      // Se stavamo nel turno listen(voice_choice), avanziamo manualmente
      if (currentTurn?.kind === "listen" && currentTurn.purpose === "voice_choice") {
        stopSTT();
        advance();
      }
    },
    [advance, currentTurn, stopSTT]
  );

  const onOpenSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);

  const onMicBlockedContinue = useCallback(() => {
    // Uscita graceful — utente non può fare l'intro voice-only.
    // Torna a home (l'app funziona anche senza intro completo).
    setMicBlocked(false);
    cleanupCurrent();
    router.back();
  }, [cleanupCurrent, router]);

  // ==================== RENDER ====================
  const orbProps = useMemo(() => orbPropsFor(orbState), [orbState]);
  const isListening = orbState === "listening";

  const orbScale = volAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Skip button (× top-right) */}
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

      {/* Orb centrale con VU meter live */}
      <Animated.View
        style={[
          styles.orbWrap,
          isListening ? { transform: [{ scale: orbScale }] } : null,
        ]}
      >
        <EclipseOrb
          status={orbProps.status}
          tone={orbProps.tone}
          size={220}
        />
      </Animated.View>

      {/* Micro-label sotto l'orb (first-time only, fade in/out) */}
      {labelText && (
        <Animated.Text
          style={[
            styles.microLabel,
            { opacity: labelOpacity },
          ]}
        >
          {labelText}
        </Animated.Text>
      )}

      {/* === M4: Voice choice fallback — due orb tap-to-select === */}
      {voiceChoiceOrbsVisible && (
        <View style={styles.voiceChoiceRow}>
          <TouchableOpacity
            style={styles.voiceOrbBtn}
            onPress={() => onTapVoiceChoice("cielo")}
            testID="intro-v2-choose-cielo"
          >
            <View style={[styles.voiceOrbDot, { backgroundColor: "#BD10E0" }]} />
            <Text style={styles.voiceOrbLabel}>Cielo</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.voiceOrbBtn}
            onPress={() => onTapVoiceChoice("vento")}
            testID="intro-v2-choose-vento"
          >
            <View style={[styles.voiceOrbDot, { backgroundColor: "#3B82F6" }]} />
            <Text style={styles.voiceOrbLabel}>Vento</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* === M4: Mic permission blocked — full overlay === */}
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

      {/* === M4: Text fallback dopo 2 STT fails === */}
      {textFallbackVisible && (
        <View style={styles.textFallbackWrap}>
          <TextInput
            value={textFallbackValue}
            onChangeText={setTextFallbackValue}
            placeholder={textFallbackPlaceholder}
            placeholderTextColor="rgba(226,232,240,0.4)"
            style={styles.textFallbackInput}
            autoFocus
            autoCorrect={false}
            autoCapitalize="words"
            onSubmitEditing={submitTextFallback}
            returnKeyType="done"
            testID="intro-v2-text-fallback"
          />
          <TouchableOpacity
            style={styles.textFallbackBtn}
            onPress={submitTextFallback}
            testID="intro-v2-text-submit"
          >
            <Ionicons name="arrow-forward" size={18} color="#1F1A36" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#1F1A36",
    alignItems: "center",
    justifyContent: "center",
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
  // Voice choice tap fallback
  voiceChoiceRow: {
    position: "absolute",
    bottom: 120,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-evenly",
    alignItems: "center",
    gap: 24,
  },
  voiceOrbBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.25)",
    minWidth: 110,
  },
  voiceOrbDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginBottom: 10,
  },
  voiceOrbLabel: {
    color: "rgba(226,232,240,0.85)",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  // Mic blocked overlay
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
  // Text fallback input
  textFallbackWrap: {
    position: "absolute",
    bottom: 60,
    left: 24,
    right: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.25)",
  },
  textFallbackInput: {
    flex: 1,
    color: "#F5E6CC",
    fontSize: 15,
    paddingVertical: 6,
  },
  textFallbackBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: "#D4B896",
    alignItems: "center",
    justifyContent: "center",
  },
});
