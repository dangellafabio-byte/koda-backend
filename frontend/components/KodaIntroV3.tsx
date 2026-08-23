/**
 * KodaIntroV3.tsx — L'intro del "Cuore" (2026-08-22, Fabio)
 *
 * Onboarding narrativo del PRIMO BOOT che introduce SOLO Lascia Andare
 * ("il cuore di Koda"). La voce di Koda (Premium) NON viene mai
 * menzionata qui — arriva solo DOPO la prima sessione LA come reveal
 * separato (vedi HeartVoiceReveal).
 *
 * ==== SEQUENZA COMPLETA V3 ====
 *
 *  [1200ms silenzio apertura — orb idle]
 *  1. Cielo: "Ciao. Io sono Koda. Voglio farti conoscere il mio cuore."
 *  [900ms — respiro: orb resta speaking]
 *  2. Cielo: "Come ti chiami?"
 *  3. [utente parla il nome — STT nativo con VAD end-of-speech]
 *  [900ms — accoglienza: orb thinking]
 *  4. Cielo: "Bene. Te lo mostro."   (nessuna ripetizione del nome —
 *     evita finta comprensione; onesto anche se STT fallisce)
 *  5. save profilo + handoff → /lascia-andare?firstBoot=1
 *
 * ==== DIFFERENZE DA V2 (KodaIntroConversational) ====
 *   • RIMOSSO: runtime_tts_name ("[Nome].") — no finta comprensione
 *   • RIMOSSO: presentazione_koda ("Io sono Koda. Grazie di essere qui...")
 *   • RIMOSSO: live_response (Koda LLM inline) — Fase D è la demo separata
 *   • CAMBIATO: handoff a /lascia-andare?firstBoot=1 (non a /)
 *   • MANTENUTO: gender lookup in background (silenzioso, utile per app)
 *   • MANTENUTO: STT retry-on-silence
 *
 * Route: /intro-v3 (attiva solo al primo boot).
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
import { ensureSpeechPermission } from "../lib/speechPermission";
import type {
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";
import EclipseOrb, { OrbStatus, OrbTone } from "./EclipseOrb";
import NeonBorder, { NeonBorderStatus } from "./NeonBorder";
import { api } from "../lib/api";
import { useTheme } from "../lib/theme";

const TAG = "KODA_INTRO_V3";

// ==================== AUDIO CLIP REGISTRY (V3) ====================
// === SPEC 2026-08-21 (Fabio) — SEQUENZA DEFINITIVA V3 =============
// Rimosse dal registry (e dal disco) le clip obsolete della vecchia
// sequenza "Come ti chiami?": come_ti_chiami-cielo.mp3, intro_v3_te_lo_mostro-cielo.mp3.
// Aggiunta intro_v3_parte_di_me-cielo.mp3 come clip di transizione verso LA.
// La clip intro_v3_saluto-cielo.mp3 è stata rigenerata con il nuovo testo:
//   "Ciao, piacere di conoscerti… io sono Koda, e tu?"
// (rispetto al vecchio testo "Ciao. Io sono Koda. Voglio farti conoscere il mio cuore.")
const CIELO_CLIPS = {
  intro_v3_saluto: require("../assets/sounds/intro/intro_v3_saluto-cielo.mp3"),
  intro_v3_parte_di_me: require("../assets/sounds/intro/intro_v3_parte_di_me-cielo.mp3"),
};

// ==================== STATE MACHINE TYPES ====================
type OrbState = "idle" | "speaking" | "listening" | "thinking";

type Turn =
  | { kind: "silence"; ms: number; label?: string; orbState?: OrbState }
  | { kind: "speak"; clipKey: keyof typeof CIELO_CLIPS }
  | { kind: "listen"; maxMs?: number; showLabel?: boolean; noTranscript?: boolean }
  | { kind: "save_and_handoff" };

// La sequenza — ogni pausa ha un'intenzione narrativa.
// REGOLA IDLE (ereditata da V2): orb NON torna idle tra frase e frase —
// solo all'apertura assoluta.
//
// === SPEC 2026-08-21 (Fabio) — SEQUENZA DEFINITIVA V3 ==================
// Prima apertura, obbligatoria, una sola volta. Nessuna X disponibile
// durante questa sequenza — l'utente non può uscire finché non arriva
// in Lascia Andare (dove sarà LA a gestire la sua fase iniziale).
//
//   #0 silence 1200ms      orb=idle       (apertura calma)
//   #1 speak  saluto       orb=speaking   "Ciao, piacere di conoscerti… io sono Koda, e tu?"
//   #2 listen VAD-only     orb=listening  Utente risponde. STT usato SOLO come proxy VAD
//                                          per rilevare l'end-of-speech. Il transcript è
//                                          COMPLETAMENTE SCARTATO: niente updateProfile,
//                                          niente user_display_name, niente gender lookup,
//                                          niente uso del contenuto. Timeout hardware 45s
//                                          (safety-net esistente): se l'utente non parla,
//                                          si procede comunque alla clip successiva SENZA
//                                          reprompt e senza forzatura.
//   #3 speak  parte_di_me  orb=speaking   "Voglio farti conoscere una parte di me."
//   #4 save_and_handoff                    Set intro_v3_completed_at + onboarded=true,
//                                          fade-out, router.replace("/lascia-andare?firstBoot=1")
const CONVERSATION_V3: Turn[] = [
  // #0 — apertura silenziosa: UNICO idle di tutto il flusso
  { kind: "silence", ms: 1200, label: "apertura", orbState: "idle" },
  // #1 — saluto + domanda finale: "Ciao, piacere di conoscerti… io sono Koda, e tu?"
  { kind: "speak", clipKey: "intro_v3_saluto" },
  // #2 — VAD-only: transcript SCARTATO. Non usiamo il contenuto della risposta.
  { kind: "listen", maxMs: 45000, noTranscript: true },
  // #3 — clip di transizione: "Voglio farti conoscere una parte di me."
  { kind: "speak", clipKey: "intro_v3_parte_di_me" },
  // #4 — flag intro V3 completata + handoff verso Lascia Andare
  { kind: "save_and_handoff" },
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

// ==================== COMPONENT ====================
const { width: WINDOW_WIDTH } = Dimensions.get("window");
const ORB_SIZE = Math.min(WINDOW_WIDTH * 0.78, 360);

export default function KodaIntroV3() {
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

  const shownLabels = useRef<Set<string>>(new Set());
  const currentPlayerRef = useRef<AudioPlayer | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenActiveRef = useRef(false);
  const sttSubsRef = useRef<{ remove: () => void }[]>([]);
  const labelOpacity = useRef(new Animated.Value(0)).current;
  const volAnim = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(true);
  const screenOpacity = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;

  const currentTurn = CONVERSATION_V3[turnIdx];

  const advance = useCallback((skip = 1) => {
    if (!mountedRef.current) return;
    setTurnIdx((i) => Math.min(i + skip, CONVERSATION_V3.length - 1));
  }, []);

  // ==================== STT CLEANUP ====================
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

  // ==================== HANDLE NAME CAPTURE ====================
  const handleNameCaptured = useCallback(
    (rawText: string) => {
      const text = rawText.trim();
      try {
        console.log(`[${TAG} DIAG] STT rawText="${rawText}" trimmed="${text}" len=${text.length}`);
      } catch {}
      // Prima parola pulita = nome
      const firstWord = text.split(/\s+/)[0].replace(/[.,!?;:"']/g, "");
      if (firstWord && firstWord.length >= 2) {
        const capitalized = firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
        console.log(`[${TAG}] captured name: "${capitalized}" (raw: "${text}")`);
        setUserName(capitalized);
        // Gender lookup silenzioso in background
        api.introGenderFromName(capitalized)
          .then((r) => {
            const g = r?.gender;
            const conf = r?.confidence || 0;
            if ((g === "m" || g === "f") && conf >= 0.7) {
              userGenderRef.current = g;
              console.log(`[${TAG}] gender BG lookup: ${g} (conf=${conf.toFixed(2)})`);
            }
          })
          .catch(() => {}); // silenzioso, non blocca
      } else {
        console.log(`[${TAG}] name capture: no usable word (rawLen=${text.length})`);
      }
      advance();
    },
    [advance]
  );

  // ==================== START LISTEN (STT come proxy VAD; con retry su silenzio) ====================
  // === SPEC 2026-08-21 (Fabio) — VAD-ONLY MODE =========================
  // Se `noTranscript=true`, questa funzione usa la stessa pipeline
  // ExpoSpeechRecognitionModule ma il testo prodotto viene ESPLICITAMENTE
  // SCARTATO in `finalize()`. Nessun handleNameCaptured, nessuna
  // api.updateProfile, nessuna interpretazione: l'unico segnale
  // significativo è "l'utente ha finito di parlare" (result final,
  // safety-net timeout, o restart-give-up dopo N silenzi).
  const startListen = useCallback(
    async (maxMs: number, withLabel: boolean, noTranscript: boolean = false) => {
      if (listenActiveRef.current) return;
      listenActiveRef.current = true;

      // 1. Permission — ora via helper condiviso (Fabio 2026-08-22).
      //    Coerenza rituale: stesso pre-prompt in tutta l'app (Intro Premium,
      //    Home Koda conv, KodaIntroV3). Vedi lib/speechPermission.ts.
      try {
        const perm = await ensureSpeechPermission();
        if (!perm.granted) {
          listenActiveRef.current = false;
          console.warn(`[${TAG}] mic/speech permission NOT granted (path=${perm.path})`);
          setMicBlocked(true);
          return;
        }
      } catch (e) {
        console.warn(`[${TAG}] ensureSpeechPermission threw:`, e);
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
        if (noTranscript) {
          // === SPEC 2026-08-21 (Fabio) — TRANSCRIPT DISCARDED ===
          // Lo STT è servito solo come proxy VAD: rilevata la fine del
          // parlato, buttiamo via il contenuto e avanziamo. Nessun
          // salvataggio, nessuna profilazione, nessun uso del testo.
          try {
            console.log(`[${TAG}] listen(noTranscript) end-of-speech → advance (raw len=${text.length} DISCARDED)`);
          } catch {}
          advance();
          return;
        }
        handleNameCaptured(text);
      };

      const giveUp = () => {
        console.log(`[${TAG}] giveUp: no transcript after ${restartAttempts} attempts in ${Date.now() - listenStartTime}ms`);
        stopSTT();
        // Risposta punto 8 utente: STT fail → salta comunque all'A8, no retry
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
        console.log(`[${TAG}] STT started (maxMs=${maxMs})`);
      } catch (e) {
        console.warn(`[${TAG}] STT start threw:`, e);
        stopSTT();
        timerRef.current = setTimeout(() => advance(), 500);
        return;
      }

      // 5. Micro-label first-time
      if (withLabel) showLabel("ti ascolto");

      // 6. Safety net
      listenSafetyRef.current = setTimeout(() => {
        if (capturedFinal) return;
        console.warn(`[${TAG}] listen safety-net (maxMs=${maxMs})`);
        if (capturedTranscript.trim().length > 0) finalize(capturedTranscript);
        else giveUp();
      }, maxMs);
    },
    [advance, stopSTT, volAnim, handleNameCaptured, showLabel]
  );

  // ==================== PLAY MP3 CLIP ====================
  const playClip = useCallback(
    async (clipSource: number, onDone: () => void) => {
      await configureAudioForPlayback();
      // Grace period per stabilizzare audio session (evita "voce tagliata" iOS)
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
        // Safety net 15s
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

  // ==================== SAVE & HANDOFF a Lascia Andare ====================
  // Salva profilo (nome + gender se disponibile), scrive flag di completamento
  // intro_v3, e naviga a /lascia-andare?firstBoot=1 con fade morbido.
  const doSaveAndHandoff = useCallback(async () => {
    setOrbState("thinking");
    // === SPEC 2026-08-21 (Fabio) — NO USER-RESPONSE PERSISTENCE ===
    // La nuova sequenza intro V3 NON acquisisce alcuna informazione
    // dall'utente. Il turn "listen" era solo un VAD proxy: il transcript
    // è stato scartato. Qui manteniamo SOLO:
    //   - onboarded=true (segna che l'utente è passato dall'intro)
    //   - flag SecureStore.intro_v3_completed_at (router condizionale)
    // Rimosso: name, koda_voice, ai_gender, user_gender, user_display_name.
    try {
      await api.updateProfile({ onboarded: true });
      console.log(`[${TAG}] profile marked onboarded (no name/gender capture — VAD-only intro)`);
    } catch (e) {
      console.warn(`[${TAG}] profile save failed (procedo comunque):`, e);
    }
    if (!mountedRef.current) return;
    // Flag: intro V3 completata (usato dal router condizionale in index.tsx
    // per non ripetere mai più la sequenza narrativa)
    try {
      await SecureStore.setItemAsync("intro_v3_completed_at", String(Date.now()));
    } catch (e) {
      console.warn(`[${TAG}] set intro_v3_completed_at failed:`, e);
    }
    setOrbState("idle");
    console.log(`[${TAG}] intro V3 complete → fade + handoff to /lascia-andare?firstBoot=1`);
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 1200,
      useNativeDriver: true,
    }).start(() => {
      if (!mountedRef.current) return;
      try {
        router.replace("/lascia-andare?firstBoot=1");
      } catch (e) {
        console.warn(`[${TAG}] router.replace failed:`, e);
      }
    });
  }, [router, screenOpacity]);

  // ==================== TURN EXECUTOR ====================
  useEffect(() => {
    if (!currentTurn) return;
    cleanupCurrent();

    try {
      console.log(`[${TAG} DIAG] enter turn #${turnIdx} kind=${currentTurn.kind}`);
    } catch {}

    switch (currentTurn.kind) {
      case "silence": {
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
        try {
          console.log(`[${TAG} DIAG] speak clipKey="${currentTurn.clipKey}"`);
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
        try {
          console.log(`[${TAG} DIAG] listen maxMs=${currentTurn.maxMs ?? 45000} showLabel=${!!currentTurn.showLabel} noTranscript=${!!currentTurn.noTranscript}`);
        } catch {}
        configureAudioForRecording();
        timerRef.current = setTimeout(() => {
          startListen(currentTurn.maxMs ?? 45000, !!currentTurn.showLabel, !!currentTurn.noTranscript);
        }, 250);
        break;
      }
      case "save_and_handoff": {
        doSaveAndHandoff();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnIdx]);

  // Mount/unmount + fade-in + breathe loop
  useEffect(() => {
    mountedRef.current = true;
    configureAudioForPlayback();
    Animated.timing(screenOpacity, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
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

  // Mic denied handlers
  const onOpenSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);
  const onMicBlockedContinue = useCallback(() => {
    setMicBlocked(false);
    cleanupCurrent();
    // Se l'utente non concede microfono: procediamo comunque a LA senza nome
    // (coerente con "nome opzionale, mai bloccante" — risposta punto 7 utente)
    doSaveAndHandoff();
  }, [cleanupCurrent, doSaveAndHandoff]);

  // ==================== RENDER ====================
  const orbProps = useMemo(() => orbPropsFor(orbState), [orbState]);
  const neonStatus = useMemo(() => neonStatusFor(orbState), [orbState]);
  const isListening = orbState === "listening";
  const breatheScale = breathe.interpolate({
    inputRange: [0, 1],
    outputRange: [0.95, 1.07],
  });
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
      <NeonBorder
        status={neonStatus}
        thickness={neonStatus === "idle" ? 2 : 3}
      />

      {/* === SPEC 2026-08-21 (Fabio) — NESSUNA X NELL'INTRO ===================
          La prima apertura è obbligatoria e non skippabile. Il pulsante X
          precedente (testID "intro-v3-skip") è stato RIMOSSO in linea con
          la spec definitiva V3: "Nessuna via d'uscita qui — è fisso e
          obbligatorio, nessuna X disponibile in questo blocco".
          La X torna disponibile solo dopo che la sequenza narrativa
          arriva in Lascia Andare (fase B), controllata dal gate
          `firstBootGate` in app/lascia-andare.tsx. */}

      {/* Orb centrale */}
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
          {/* Spacer per replicare il layout home (Fabio 2026-08-23):
              nella home Page 0 sotto l'orb c'è gap:18 + statusLabel 16px.
              Il flex-center centra il gruppo [orb + spacer] → orb 17px più
              in alto del centro. Con questo spacer orb=STESSA posizione. */}
          <View style={{ height: 34 }} pointerEvents="none" />
        </Animated.View>

        {/* Micro-label sotto l'orb (position:absolute per non spostare l'orb).
            Con centerContainer.paddingTop=90 (allineamento home), l'orb è
            a centro Y = H/2 + 45. Il label deve compensare quel +45 rispetto
            al top:"50%" del container. Formula: ORB_SIZE/2 + 27 (spaziatura
            classica) + 45 (compensazione paddingTop) = ORB_SIZE/2 + 72. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            marginTop: ORB_SIZE / 2 + 72,
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
              Solo per sentire il tuo nome. Se vuoi, apri le impostazioni e
              attivalo. Altrimenti possiamo procedere lo stesso.
            </Text>
            <TouchableOpacity style={styles.micBlockedPrimaryBtn} onPress={onOpenSettings}>
              <Text style={styles.micBlockedPrimaryText}>Apri Impostazioni</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.micBlockedSecondaryBtn} onPress={onMicBlockedContinue}>
              <Text style={styles.micBlockedSecondaryText}>Continua senza nome</Text>
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
    // Allineamento pixel-perfect con la home Page 0 (Fabio 2026-08-23):
    // stesso paddingTop del wrapper della home (index.tsx riga ~5247)
    // così l'orb è ESATTAMENTE nello stesso punto tra V3 e home vera.
    paddingTop: 90,
  },
  orbWrap: {
    alignItems: "center",
    justifyContent: "center",
    // marginBottom: 0 (Fabio 2026-08-23) — coerenza con home (nessun offset
    // che sposta l'orb rispetto al centro geometrico del wrapper).
    marginBottom: 0,
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
