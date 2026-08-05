/**
 * KodaIntroConversational.tsx — M2 (2026-08-06, Fabio)
 *
 * Onboarding conversazionale unificato di Koda: UN SOLO flusso, senza
 * schermate testuali, senza bottoni "Continua/Ho capito", con l'orb
 * che cambia stato dal vivo esattamente come nell'uso quotidiano.
 *
 * ==== MILESTONE M2 (in consegna oggi) ====
 *   • State machine conversazionale (turn queue) ✅
 *   • Audio pre-registrati bundled (11 clip statiche Cielo — vedi
 *     /assets/sounds/intro/ generate con scripts/generate-intro-audio.js) ✅
 *   • EclipseOrb con stati dal vivo (idle → speaking → listening →
 *     thinking → speaking …) ✅
 *   • VU meter live sull'orb durante il listening (scale reattivo al
 *     volume del microfono via `volumechange` di expo-speech-recognition) ✅
 *   • STT reale via expo-speech-recognition (SFSpeechRecognizer on-device
 *     su iOS, Google SpeechRecognizer su Android) ✅
 *   • Micro-label first-time-only ("ti ascolto", "sto pensando"),
 *     mostrata solo la primissima volta di ogni stato ✅
 *   • Skip (×) globale in alto a destra per uscire subito ✅
 *   • Nome utente catturato dal primo listen (ask_name) → salvato per M3 ✅
 *
 * ==== ANCORA DA FARE (M3+) ====
 *   • Frase TTS runtime con nome ("Ciao [Nome], piacere di conoscerti.")
 *     via ElevenLabs (per ora skipped, va direttamente ad ask_why)
 *   • Reveal Vento + choice di voce (Turno 6-7)
 *   • Gender detection backend (Claude Haiku)
 *   • Voiceprint invisible upload (cattura 3 sample audio raw durante
 *     ask_why / ask_day / ask_moment mentre STT gira in parallelo)
 *   • Fallback testuale su STT permanent-fail (M4)
 *   • Retry conversazionale su transcript vuoto (M4)
 *
 * Route: /intro-v2 (isolata per testing, il vecchio KodaIntro resta
 * live sulla home finché questo file non è completo e validato).
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Animated, Platform } from "react-native";
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

const TAG = "KODA_INTRO_V2";

// ==================== AUDIO CLIP REGISTRY ====================
// Metro bundler risolve i require() statici in build-time e inlina
// gli asset nell'IPA. Ogni clip corrisponde a un file MP3 generato
// da scripts/generate-intro-audio.js.
//
// Nota M2: uso solo Cielo per ora. Vento verrà aggiunto in M3.
const CIELO_CLIPS = {
  intro_1a: require("../assets/sounds/intro/intro_1a-cielo.mp3"),
  intro_1b: require("../assets/sounds/intro/intro_1b-cielo.mp3"),
  ask_name: require("../assets/sounds/intro/ask_name-cielo.mp3"),
  ask_why: require("../assets/sounds/intro/ask_why-cielo.mp3"),
  filler: require("../assets/sounds/intro/filler-cielo.mp3"),
  ask_day: require("../assets/sounds/intro/ask_day-cielo.mp3"),
  ask_moment: require("../assets/sounds/intro/ask_moment-cielo.mp3"),
  confirm_choice: require("../assets/sounds/intro/confirm_choice-cielo.mp3"),
  ask_gender: require("../assets/sounds/intro/ask_gender-cielo.mp3"),
};

// ==================== STATE MACHINE TYPES ====================
type OrbState = "idle" | "speaking" | "listening" | "thinking";

// Cosa fare con il transcript catturato in un turno di listen.
// - "capture_name": salva in userName state (usato per personalizzazione M3)
// - "discard": buttalo (turni "voiceprint sample only" — M3 catturerà audio raw)
type ListenPurpose = "capture_name" | "discard";

type Turn =
  | { kind: "silence"; ms: number }
  | { kind: "speak"; clipKey: keyof typeof CIELO_CLIPS }
  | { kind: "listen"; label?: string; purpose: ListenPurpose; maxMs?: number }
  | { kind: "think"; ms: number }
  | { kind: "end" };

// La sequenza conversazionale M2 (solo Cielo).
// M3 aggiungerà: Turno 6 (Vento reveal), Turno 7 (choice), TTS runtime
// per le frasi con nome.
const CONVERSATION_M2: Turn[] = [
  { kind: "silence", ms: 2500 }, // Apertura silenziosa
  { kind: "speak", clipKey: "intro_1a" }, // "Sono qui. Non ho fretta..."
  { kind: "silence", ms: 500 },
  { kind: "speak", clipKey: "intro_1b" }, // "Solo di riconoscerti quando torni."
  { kind: "silence", ms: 700 },
  { kind: "speak", clipKey: "ask_name" }, // "Come ti chiamo?"
  { kind: "listen", label: "ti ascolto", purpose: "capture_name", maxMs: 12000 },
  { kind: "think", ms: 1500 }, // Elaborazione (M3: qui va il TTS "Ciao [Nome]")
  { kind: "speak", clipKey: "ask_why" }, // "E cosa ti ha portato qui..."
  { kind: "listen", label: "ti ascolto", purpose: "discard", maxMs: 25000 },
  { kind: "think", ms: 1500 },
  { kind: "speak", clipKey: "filler" }, // "Grazie."
  { kind: "silence", ms: 300 },
  { kind: "speak", clipKey: "ask_day" }, // "Quando torni da me..."
  { kind: "listen", label: "ti ascolto", purpose: "discard", maxMs: 25000 },
  { kind: "think", ms: 1500 },
  // M2 termina qui. M3 aggiungerà ask_moment (se serve) + reveal Vento + scelta.
  { kind: "end" },
];

// ==================== ORB STATE → EclipseOrb PROPS ====================
function orbPropsFor(state: OrbState): { status: OrbStatus; tone: OrbTone | null } {
  switch (state) {
    case "idle":
      return { status: "idle", tone: null };
    case "speaking":
      return { status: "speaking", tone: "warm" }; // viola
    case "listening":
      return { status: "recording", tone: null }; // tiffany
    case "thinking":
      return { status: "thinking", tone: null }; // ciclamino
  }
}

// ==================== VOLUME NORMALIZATION ====================
// expo-speech-recognition emette `volumechange` con value ∈ [-2, 10]
// (float). -2 = silenzio, 10 = molto forte. Normalizziamo su [0..1]
// con una piccola compressione low-end così anche voci morbide danno
// una risposta visibile.
function normalizeVolume(rawValue: number): number {
  const clamped = Math.max(-2, Math.min(10, rawValue));
  const linear = (clamped + 2) / 12; // 0..1
  // Curva soft (sqrt) → più risposta nella prima metà
  return Math.sqrt(Math.max(0, linear));
}

// ==================== COMPONENT ====================
export default function KodaIntroConversational() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [turnIdx, setTurnIdx] = useState(0);
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [labelText, setLabelText] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [micDeniedMsg, setMicDeniedMsg] = useState<string | null>(null);

  // Traccia se i micro-label sono già stati mostrati (first-time only)
  const shownLabels = useRef<Set<string>>(new Set());

  // Riferimento al player audio corrente (per cleanup su unmount)
  const currentPlayerRef = useRef<AudioPlayer | null>(null);
  // Timer di transizione (per cleanup su unmount)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timer safety-net del listen turn (max duration)
  const listenSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: siamo dentro un listen turn attivo?
  const listenActiveRef = useRef(false);
  // Riferimenti alle subscription STT (per cleanup preciso)
  const sttSubsRef = useRef<{ remove: () => void }[]>([]);
  // Guard permission già chiesta almeno una volta in questa sessione
  const permAskedRef = useRef(false);
  // Anim per fade-in del label
  const labelOpacity = useRef(new Animated.Value(0)).current;
  // Anim per lo scale dell'orb in base al volume mic (VU meter live)
  // scale = 1 + volAnim * 0.06 → +6% sui picchi forti
  const volAnim = useRef(new Animated.Value(0)).current;
  // Guard unmount (evita setState dopo unmount)
  const mountedRef = useRef(true);

  const currentTurn = CONVERSATION_M2[turnIdx];

  // Avanza allo step successivo
  const advance = useCallback(() => {
    if (!mountedRef.current) return;
    setTurnIdx((i) => Math.min(i + 1, CONVERSATION_M2.length - 1));
  }, []);

  // ==================== STT CLEANUP HELPER ====================
  const stopSTT = useCallback(() => {
    listenActiveRef.current = false;
    if (listenSafetyRef.current) {
      clearTimeout(listenSafetyRef.current);
      listenSafetyRef.current = null;
    }
    // Rimuovi tutte le subscription
    for (const sub of sttSubsRef.current) {
      try {
        sub.remove();
      } catch {}
    }
    sttSubsRef.current = [];
    // Ferma il recognizer (abort è più aggressivo di stop → cleanup
    // istantaneo, nessun "end result" residuo)
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
    // Reset visivo volume
    Animated.timing(volAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [volAnim]);

  // Cleanup helper generale
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

  // Mostra label con fade-in + memoria "first-time"
  const showLabel = useCallback(
    (text: string) => {
      if (shownLabels.current.has(text)) {
        // Già mostrato → skip (per definizione: solo la prima volta)
        return;
      }
      shownLabels.current.add(text);
      setLabelText(text);
      labelOpacity.setValue(0);
      Animated.timing(labelOpacity, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }).start();
      // Dopo 3s fai fade-out
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

  // ==================== START LISTEN (STT) ====================
  const startListen = useCallback(
    async (purpose: ListenPurpose, maxMs: number) => {
      // Guard: doppio start
      if (listenActiveRef.current) return;
      listenActiveRef.current = true;

      // 1. Permission check + request
      try {
        const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!perm.granted) {
          listenActiveRef.current = false;
          console.warn(`[${TAG}] mic/speech permission NOT granted`);
          // M2: mostra messaggio breve e avanza dopo 3s (M4 avrà bottone
          // "apri impostazioni" e fallback testuale). Il flusso NON si
          // interrompe: Koda continua a parlare, l'utente sperimenta
          // l'introduzione anche se non può rispondere a voce.
          if (mountedRef.current) {
            setMicDeniedMsg(
              "Ho bisogno del microfono per riconoscerti. Per ora ti ascolto in silenzio."
            );
          }
          timerRef.current = setTimeout(() => {
            if (mountedRef.current) setMicDeniedMsg(null);
            advance();
          }, 3500);
          return;
        }
      } catch (e) {
        console.warn(`[${TAG}] permission request threw:`, e);
        listenActiveRef.current = false;
        // Skip graceful
        timerRef.current = setTimeout(advance, 800);
        return;
      }
      permAskedRef.current = true;

      // 2. Registra listeners PRIMA di start()
      let capturedTranscript = "";
      let capturedFinal = false;

      const finalize = (text: string) => {
        if (!listenActiveRef.current) return; // già finalizzato/abortito
        capturedFinal = true;
        // Salva l'output se richiesto
        if (purpose === "capture_name" && text.trim().length > 0) {
          // Prendi la prima parola "utile" come nome (Claude in M3 rifinirà)
          const firstWord = text
            .trim()
            .split(/\s+/)[0]
            .replace(/[.,!?;:"']/g, "");
          if (firstWord && firstWord.length >= 2) {
            console.log(`[${TAG}] captured name: "${firstWord}" (raw: "${text}")`);
            if (mountedRef.current) setUserName(firstWord);
          }
        }
        stopSTT();
        advance();
      };

      const subResult = ExpoSpeechRecognitionModule.addListener(
        "result",
        (evt: ExpoSpeechRecognitionResultEvent) => {
          const first = evt.results?.[0];
          if (!first) return;
          const text = first.transcript || "";
          capturedTranscript = text;
          if (evt.isFinal) {
            console.log(`[${TAG}] result FINAL: "${text}"`);
            finalize(text);
          }
        }
      );

      const subError = ExpoSpeechRecognitionModule.addListener(
        "error",
        (evt: ExpoSpeechRecognitionErrorEvent) => {
          console.log(`[${TAG}] error code=${evt.error} msg="${evt.message || ""}"`);
          // "no-speech" e "aborted" sono benigni: gestiti dall'end handler
          if (evt.error === "aborted") return;
          if (evt.error === "no-speech") {
            // Se abbiamo un transcript parziale, salvalo comunque
            if (capturedTranscript.trim().length > 0) {
              finalize(capturedTranscript);
              return;
            }
            // Altrimenti avanza gracefully (M4 aggiungerà un retry gentile)
            if (!capturedFinal) {
              stopSTT();
              advance();
            }
            return;
          }
          // Errori seri (permission mid-flight, audio session): skip graceful
          if (!capturedFinal) {
            stopSTT();
            timerRef.current = setTimeout(advance, 500);
          }
        }
      );

      const subEnd = ExpoSpeechRecognitionModule.addListener("end", () => {
        // Il modulo può emettere "end" senza aver mandato isFinal:true
        // (es. Android chiude su silenzio prolungato). Se abbiamo un
        // transcript parziale, usalo. Altrimenti avanza gracefully.
        if (capturedFinal) return; // già gestito da result isFinal
        if (capturedTranscript.trim().length > 0) {
          finalize(capturedTranscript);
        } else {
          if (listenActiveRef.current) {
            stopSTT();
            advance();
          }
        }
      });

      const subVolume = ExpoSpeechRecognitionModule.addListener(
        "volumechange",
        (evt: { value?: number }) => {
          const raw = typeof evt?.value === "number" ? evt.value : -2;
          const norm = normalizeVolume(raw);
          // Animazione morbida verso il target (smoothing su 120ms
          // così il pulse dell'orb è organico, non "scatti a scatti")
          Animated.timing(volAnim, {
            toValue: norm,
            duration: 120,
            useNativeDriver: true,
          }).start();
        }
      );

      sttSubsRef.current = [subResult, subError, subEnd, subVolume];

      // 3. Start recognizer
      try {
        const startOpts: any = {
          lang: "it-IT",
          interimResults: true,
          continuous: Platform.OS === "android", // bypass beep Android
          maxAlternatives: 1,
          addsPunctuation: true,
          requiresOnDeviceRecognition: Platform.OS === "ios",
          volumeChangeEventOptions: {
            enabled: true,
            intervalMillis: 80, // ~12 fps → smooth ma non pesante
          },
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
        timerRef.current = setTimeout(advance, 500);
        return;
      }

      // 4. Safety net: se dopo maxMs non abbiamo ricevuto un final,
      // stop forzato e avanza. Serve per il caso limite in cui il
      // modulo si "blocca" (raro ma possibile) o l'utente non parla
      // proprio mai (M4 sostituirà con un retry conversazionale).
      listenSafetyRef.current = setTimeout(() => {
        if (capturedFinal) return;
        console.warn(`[${TAG}] listen safety-net triggered (maxMs=${maxMs})`);
        if (capturedTranscript.trim().length > 0) {
          finalize(capturedTranscript);
        } else {
          stopSTT();
          advance();
        }
      }, maxMs);
    },
    [advance, stopSTT, volAnim]
  );

  // ==================== TURN EXECUTOR ====================
  useEffect(() => {
    if (!currentTurn) return;
    cleanupCurrent();

    switch (currentTurn.kind) {
      case "silence": {
        setOrbState("idle");
        timerRef.current = setTimeout(advance, currentTurn.ms);
        break;
      }

      case "speak": {
        setOrbState("speaking");
        try {
          const clipSource = CIELO_CLIPS[currentTurn.clipKey];
          const player = createAudioPlayer(clipSource, { updateInterval: 100 });
          currentPlayerRef.current = player;
          const onStatus = (status: any) => {
            if (status.didJustFinish) {
              try {
                player.removeListener("playbackStatusUpdate", onStatus);
              } catch {}
              advance();
            }
          };
          player.addListener("playbackStatusUpdate", onStatus);
          player.play();
          // Safety net: se didJustFinish non arriva, avanza dopo 10s
          timerRef.current = setTimeout(() => {
            console.warn(`[${TAG}] speak safety-net triggered for`, currentTurn.clipKey);
            advance();
          }, 10000);
        } catch (e) {
          console.warn(`[${TAG}] audio playback failed:`, e);
          timerRef.current = setTimeout(advance, 800);
        }
        break;
      }

      case "listen": {
        setOrbState("listening");
        if (currentTurn.label) showLabel(currentTurn.label);
        // Piccolo delay (250ms) per far settle il transition speaking→listening
        // dell'orb prima che il mic si attivi. Evita "flash" visivi.
        timerRef.current = setTimeout(() => {
          startListen(currentTurn.purpose, currentTurn.maxMs ?? 20000);
        }, 250);
        break;
      }

      case "think": {
        setOrbState("thinking");
        showLabel("sto pensando");
        timerRef.current = setTimeout(advance, currentTurn.ms);
        break;
      }

      case "end": {
        setOrbState("idle");
        // M2: torna alla home come placeholder finale.
        // M3 sostituirà con Turno 6 (Vento reveal) + Turno 7 (choice).
        // Log userName catturato per debug M3 handoff.
        console.log(`[${TAG}] end reached. userName="${userName || "(none)"}"`);
        timerRef.current = setTimeout(() => {
          router.back();
        }, 2000);
        break;
      }
    }
    // Nota: intenzionalmente NON includiamo helper stabili nelle deps
    // — includerli farebbe re-eseguire il turno inutilmente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnIdx]);

  // Mount / unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupCurrent();
    };
  }, [cleanupCurrent]);

  // ==================== RENDER ====================
  const orbProps = useMemo(() => orbPropsFor(orbState), [orbState]);
  const isListening = orbState === "listening";

  // Scale wrapper: sempre 1 tranne durante listening dove reagisce al mic.
  // In tutti gli altri stati, forziamo scale a 1 (nessuna influenza del
  // volume residuo). Volume anim si azzera in stopSTT().
  const orbScale = volAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Skip button — presente sempre, cleanup automatico via unmount */}
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

      {/* Orb centrale — wrapper Animated per VU meter live */}
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

      {/* Micro-label sotto l'orb (fade in/out, solo first-time) */}
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

      {/* Mic denied — messaggio in-character (M4 aggiungerà "apri impostazioni") */}
      {micDeniedMsg && (
        <View style={styles.micDeniedWrap}>
          <Text style={styles.micDeniedText}>{micDeniedMsg}</Text>
        </View>
      )}

      {/* Debug info (rimossa in M4) */}
      <View style={[styles.debugRow, { bottom: insets.bottom + 8 }]}>
        <Text style={styles.debugText}>
          M2 · turn {turnIdx + 1}/{CONVERSATION_M2.length} · {currentTurn?.kind}
          {userName ? ` · name:${userName}` : ""}
        </Text>
      </View>
    </View>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#1F1A36", // indaco Koda notte
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
  micDeniedWrap: {
    position: "absolute",
    bottom: 120,
    left: 32,
    right: 32,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.25)",
    alignItems: "center",
  },
  micDeniedText: {
    color: "rgba(226,232,240,0.85)",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  debugRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  debugText: {
    color: "rgba(255,255,255,0.18)",
    fontSize: 10,
    fontFamily: "SpaceMono",
  },
});
