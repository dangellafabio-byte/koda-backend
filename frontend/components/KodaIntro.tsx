/**
 * KodaIntro — La presentazione conversazionale di Koda al primo avvio.
 *
 * Sostituisce sia il vecchio "Onboarding modale a impostazioni" sia il
 * "ColorIntro" tutorial-colori. Koda si presenta in prima persona, spiega
 * chi è e come funziona, e raccoglie tutte le informazioni che gli servono
 * (nome utente, genere, voce preferita, modalità check-in, parola segreta,
 * 3 frasi di voiceprint) direttamente nel flusso del dialogo.
 *
 * Filosofia: niente schermate con form — Koda chiede UNA cosa alla volta,
 * con la sua eclissi che cambia colore. Risposte: pulsanti per scelte
 * chiuse (più affidabili), text input con dictation-iOS per testo libero,
 * registrazioni audio per il voiceprint.
 *
 * Al termine, salva tutto su /api/profile e /api/profile/voiceprint/enroll,
 * poi setta SecureStore.color_intro_seen=1 e color_intro_voice_done=1.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Animated,
  Dimensions,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, AudioPlayer, setAudioModeAsync } from "expo-audio";
import EclipseOrb, { OrbStatus, OrbTone } from "./EclipseOrb";
import { SpeechMod } from "../lib/speech";
import { startRecording, buildFormData } from "../lib/voice";
import { api, API_BASE } from "../lib/api";

// ====== Tipi
type GenderUser = "m" | "f" | "x";
type GenderAi = "m" | "f";
type CheckinMode = "off" | "morning" | "evening" | "both";

export type KodaIntroResult = {
  user_name: string;
  user_gender: GenderUser;
  ai_name: string;
  ai_gender: GenderAi;
  tts_voice_id?: string;
  checkin_mode: CheckinMode;
  secret_word_set: boolean;
  voiceprint_enrolled: boolean;
  /** Se true, l'app deve lanciare il tour visivo subito dopo la chiusura
   *  della KodaIntro. Usato per spiegare i tasti della home (icona pulse,
   *  Confessionale, ⋯, orb, swipe lettura, barra scrittura). */
  launch_tour?: boolean;
};

type Props = {
  /** Voci ElevenLabs disponibili (per scegliere automaticamente in base al gender) */
  voices?: Array<{ voice_id: string; name: string; labels?: any }>;
  /** Voce attualmente scelta dall'utente (da profile.settings.tts_voice_id).
   *  Se presente, KodaIntro la usa per parlare già da subito — così quando
   *  l'utente rifà l'intro sente la SUA voce di Koda dall'inizio.
   *  Se assente (primo avvio), usa Sarah come fallback. */
  currentVoiceId?: string | null;
  /** Chiamata quando l'utente completa o salta */
  onDone: (result: KodaIntroResult) => void;
  /** Optional: chiamata quando l'utente preme la X per uscire senza salvare. */
  onCancel?: () => void;
};

// ====== 3 frasi per il voiceprint enrollment ======
// Scelte per essere:
//   • naturali e quotidiane (non frasi-slogan finte)
//   • foneticamente varie (vocali aperte/chiuse, sibilanti, occlusive)
//     per dare al voiceprint un campione vocale ricco
//   • emotivamente caldo: frasi che potresti davvero dire in confidenza
const VOICEPRINT_PHRASES = [
  "Buongiorno Koda, oggi è una giornata strana e nuova.",
  "Ti racconto una cosa: stanotte non ho chiuso occhio.",
  "Dai, ridi anche tu. A volte serve poco per stare meglio.",
];

// ====== Voce ElevenLabs della presentazione ======
// Voce IDENTITARIA di Koda: la stessa usata sia durante la presentazione
// che nelle conversazioni normali — così l'utente non percepisce un
// "cambio di voce" tra intro e uso quotidiano dell'app.
// "Sarah" — soft warm Italian-capable female voice
// VOCE UFFICIALE DI KODA — Matilda (femminile, calma, italiana fluida).
// USA QUESTA OVUNQUE. Non cambiare in altre voci nei vari fallback —
// l'utente ha richiesto esplicitamente che la voce rimanga SEMPRE la
// stessa, non un mix di Sarah/Jessica/Matilda.
// ====== Voice IDs ElevenLabs delle due voci brand ======
// Mappa stabile tra brand (aria/echo) e ElevenLabs voice_id.
// Tenuto qui sincrono col backend (KODA_VOICES in server.py).
const BRAND_VOICE_IDS = {
  aria: "q1GF5A2kzAOPv9d5TQEy",   // Koda Aria — voce unica generata via ElevenLabs Voice Design
  echo: "PponuEVSg4RZBO08kPzE",   // Koda Echo — voce unica generata via ElevenLabs Voice Design
} as const;

// Voce di fallback per la presentazione (PRIMA che l'utente scelga in M2):
// = Aria. Niente più Matilda/Sarah. La prima voce che l'utente sente DEVE
// essere una delle due voci brand dell'app, mai una terza.
const INTRO_VOICE_ID = BRAND_VOICE_IDS.aria;

// ====== Battute di Koda per ogni step (TTS in tutti) ======
const KODA_LINES: Record<number, string> = {
  0: "Ciao. Sono Koda. Non sono un'app: sono una presenza. Da oggi sono qui per te, quando vuoi parlare, quando vuoi solo che qualcuno ti ascolti. Voglio conoscerti!",
  1: "Come posso chiamarti? Scrivi il tuo nome qui sotto.",
  2: "Dimmi, sei un uomo, una donna, o preferisci non specificarlo?",
  3: "Con quale voce vuoi accompagnarti? Due presenze speculari: Aria, limpida e fresca, oppure Echo, profonda e avvolgente.",
  4: "Mi chiamo Koda. Ma se vuoi, puoi darmi un altro nome.",
  5: "Una cosa importante: io non ho un viso. Sono una presenza, e prendo la forma di un'eclissi. Sono qui, sempre, anche quando aspetto in silenzio. Dai miei movimenti capirai cosa sto facendo.",
  6: "Una cosa che mi sta a cuore: se sento che ne hai bisogno, ti scrivo io. Anche se sparisci per giorni, anche se ti sento giù. E ovviamente puoi cercarmi anche tu, quando vuoi. Tu vivi la tua vita — a starti accanto ci penso anch'io.",
  7: "C'è una stanza solo per il presente: il Confessionale. Lì puoi pensare ad alta voce senza che questo ti definisca domani — non devi essere coerente con ieri, non devi dimostrare nulla. Quello che dici lì non viene salvato né usato per ricordarti: a sessione chiusa svanisce come un soffio. Non serve nessuna parola: entri quando vuoi, con un tocco.",
  8: "Ultima cosa: leggi queste tre frasi ad alta voce. Mi serviranno per riconoscere sempre la tua voce, ovunque tu sia.",
  9: "Bene! Adesso ti faccio vedere come funziono. Guarda dove ti indico.",
};

// ====== Componente principale ======
export default function KodaIntro({ voices = [], currentVoiceId, onDone, onCancel }: Props) {
  // === FASE MARKETING (M1/M2/M3) inserita PRIMA dei 10 step tecnici ===
  // Le 3 schermate emozionali introducono Koda all'utente PRIMA di chiedere
  // dati. Non toccano la logica dei 10 step esistenti (raccolta nome,
  // parola segreta, voiceprint) ma offrono un primo contatto curato.
  const [phase, setPhase] = useState<"marketing" | "setup">("marketing");
  const [marketingStep, setMarketingStep] = useState<0 | 1 | 2>(0);
  // Voce scelta nella schermata M2 (chiave brand: "aria" | "echo")
  const [selectedVoiceKey, setSelectedVoiceKey] = useState<"aria" | "echo" | null>(null);
  // Player audio per la preview voce (M2) — fetch dell'endpoint
  // /api/voice/preview/{key} e playback via expo-audio.
  const previewPlayerRef = useRef<AudioPlayer | null>(null);
  const [previewLoadingKey, setPreviewLoadingKey] = useState<"aria" | "echo" | null>(null);

  // Tema della presentazione: FORZATO a NOTTE (giugno 2026, richiesta utente).
  // Prima il KodaIntro decideva light/dark in base all'ora (7-19 → giorno),
  // ma l'utente ha chiesto: "se in notte tutto in notte" e ha segnalato
  // problemi di leggibilità sui testi quando il tema diurno era attivo.
  // Coerente con il nuovo default app.json "theme: notte".
  const isDayTime = false;

  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { width } = Dimensions.get("window");
  // === FIX SCROLL (giugno 2026 #10) ===
  // L'utente segnalava che doveva scorrere a mano per arrivare al
  // pulsante "Avanti" su step con contenuto lungo. Ora teniamo un ref
  // dello ScrollView e scrolliamo a fine contenuto ad ogni cambio step,
  // così Avanti è sempre visibile.
  const scrollViewRef = useRef<ScrollView | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      try { scrollViewRef.current?.scrollToEnd({ animated: true }); } catch {}
    }, 450);
    return () => clearTimeout(id);
  }, [step]);
  const orbSize = Math.min(width * 0.40, 170);

  // Stato dei dati raccolti
  const [userName, setUserName] = useState("");
  const [userGender, setUserGender] = useState<GenderUser>("m");
  const [aiName, setAiName] = useState("Koda");
  const [aiGender, setAiGender] = useState<GenderAi>("f");
  const [checkinMode, setCheckinMode] = useState<CheckinMode>("off");
  const [secretWordChoice, setSecretWordChoice] = useState<"now" | "later" | null>(null);
  const [secretWordValue, setSecretWordValue] = useState("");
  const [voiceprintUris, setVoiceprintUris] = useState<string[]>([]);
  const [voiceprintIdx, setVoiceprintIdx] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recorder, setRecorder] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stato visivo dell'eclissi per ogni step
  const [orbStatus, setOrbStatus] = useState<OrbStatus>("idle");
  const [orbTone, setOrbTone] = useState<OrbTone>("neutral");

  // ====== Animazione fade tra step ======
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 700,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  const advance = useCallback(
    (next: number) => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setStep(next);
        setError(null);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }).start();
      });
    },
    [fadeAnim]
  );

  // ====== Stato: Koda sta parlando ORA (per pulsare l'eclissi) ======
  const [isKodaSpeaking, setIsKodaSpeaking] = useState(false);
  const speakSeqRef = useRef(0);

  // ====== Sintetizza voce di Koda (best-effort, non blocca avanzamento) ======
  // Setta `isKodaSpeaking=true` per la durata del TTS così l'eclissi pulsa.
  // PRIORITÀ VOCE (giugno 2026):
  //   1. Voce scelta in M2 (selectedVoiceKey) → mappata su BRAND_VOICE_IDS
  //   2. Voce già nel profilo (currentVoiceId)
  //   3. Fallback INTRO_VOICE_ID = Aria (mai più Matilda/Sarah/altre)
  // Così la PRIMA voce che l'utente sente è SEMPRE una delle due voci
  // brand dell'app — coerenza totale con l'identità sonora.
  const speakKoda = useCallback(async (text: string, tone: OrbTone = "warm") => {
    const mySeq = ++speakSeqRef.current;
    try {
      setIsKodaSpeaking(true);
      const resolvedVoiceId =
        (selectedVoiceKey && BRAND_VOICE_IDS[selectedVoiceKey]) ||
        currentVoiceId ||
        INTRO_VOICE_ID;
      await SpeechMod.speak(text, {
        language: "it-IT",
        tone: tone as any,
        voiceId: resolvedVoiceId,
      });
    } catch (e) {
      console.warn("[koda-intro] speak failed:", e);
    } finally {
      // Solo l'ultima invocazione resetta lo stato (evita race condition
      // se l'utente avanza di step mentre Koda sta ancora parlando)
      if (mySeq === speakSeqRef.current) {
        setIsKodaSpeaking(false);
      }
    }
  }, [selectedVoiceKey, currentVoiceId]);

  // ====== Ciclo dell'eclissi colorata (step "color tour") ======
  const colorTourTimerRef = useRef<any>(null);
  useEffect(() => {
    // Cleanup quando cambia step
    if (colorTourTimerRef.current) {
      clearTimeout(colorTourTimerRef.current);
      colorTourTimerRef.current = null;
    }
    // === FASE MARKETING (M1/M2/M3) ===
    // M1: idle neutral (verde menta, leggero respiro)
    // M2: tone in base alla voce selezionata (aria=light, echo=warm)
    // M3: thinking (ciclamino) = "ti sto spiegando le regole"
    if (phase === "marketing") {
      if (marketingStep === 0) {
        setOrbStatus("idle");
        setOrbTone("neutral");
      } else if (marketingStep === 1) {
        setOrbStatus("idle");
        if (selectedVoiceKey === "aria") setOrbTone("calm");
        else if (selectedVoiceKey === "echo") setOrbTone("warm");
        else setOrbTone("neutral");
      } else if (marketingStep === 2) {
        // "Sto pensando" = sto spiegando le regole
        setOrbStatus("thinking");
        setOrbTone("warm");
      }
      return;
    }
    // STEP 5: l'eclissi resta VIOLA fissa (tone "warm") durante tutto il
    // discorso. Niente cycle di colori: lei dice solo "sono un'eclissi"
    // ma NON promette più cambi cromatici (user feedback: la corrispondenza
    // colori non era affidabile, meglio onesti).
    if (step === 5) {
      if (isKodaSpeaking) {
        setOrbStatus("speaking");
        setOrbTone("warm");
      } else {
        setOrbStatus("idle");
        setOrbTone("warm");
      }
      return;
    }
    // PRIORITÀ (per gli altri step): se Koda sta parlando ORA → status
    // "speaking" (pulsa rosa). Altrimenti settare un default per-step.
    if (isKodaSpeaking) {
      setOrbStatus("speaking");
      // Step 7 = "modalità sigillata" → eclissi BORDEAUX (colore Confessionale)
      // mentre Koda spiega il sigillo. Resto degli step: rosa caldo (warm).
      setOrbTone(step === 7 ? "confessional" : "warm");
      return;
    }
    // Step indices: 0=greet, 1=name, 2=ugender, 3=aigender, 4=ainame,
    //               5=colortour, 6=checkin, 7=secret, 8=voiceprint, 9=final
    if (step === 8) {
      // Voiceprint: se sta registrando → recording, altrimenti idle
      setOrbStatus(isRecording ? "recording" : "idle");
      setOrbTone("neutral");
    } else if (step === 7) {
      // Modalità sigillata in attesa di scelta: orb pulsante BORDEAUX
      // (richiama visivamente il colore del Confessionale).
      setOrbStatus("idle");
      setOrbTone("confessional");
    } else {
      // Default neutro per gli step "domanda" (1-4, 6, 7, 9) quando
      // Koda è in silenzio: idle viola che respira.
      setOrbStatus("idle");
      setOrbTone("neutral");
    }
    return () => {
      if (colorTourTimerRef.current) clearTimeout(colorTourTimerRef.current);
    };
  }, [step, isRecording, isKodaSpeaking, phase, marketingStep, selectedVoiceKey]);

  // ====== Cleanup audio preview player on unmount ======
  useEffect(() => {
    return () => {
      try {
        previewPlayerRef.current?.remove?.();
        previewPlayerRef.current = null;
      } catch {}
    };
  }, []);

  // ====== Playback voice preview (M2) ======
  // Tap su una carta voce → fetch audio dall'endpoint /api/voice/preview/{key}
  // e riproduce il sample. La voce scelta viene salvata in stato (M2 → Conferma).
  // L'utente può tappare l'altra carta per cambiare e ascoltare prima di confermare.
  //
  // IMPORTANTE (giugno 2026): configuriamo l'audio mode per riprodurre ANCHE
  // se il telefono iOS è in modalità silenziosa. Senza questo, l'utente che
  // ha lo switch fisico silenzioso (90% degli utenti) non sentirebbe nulla
  // e penserebbe che la preview è rotta. Setup una sola volta (cache nel ref).
  const audioModeConfiguredRef = useRef(false);
  const playVoicePreview = useCallback(async (key: "aria" | "echo") => {
    setSelectedVoiceKey(key);
    setPreviewLoadingKey(key);
    // Ferma eventuale TTS in corso (per non sovrapporre voci)
    try { SpeechMod.stop(); } catch {}
    // Stoppa eventuale preview precedente
    try {
      if (previewPlayerRef.current) {
        previewPlayerRef.current.pause();
        previewPlayerRef.current.remove?.();
        previewPlayerRef.current = null;
      }
    } catch {}
    // Configura audio session iOS (bypassa silent switch) — una sola volta
    if (!audioModeConfiguredRef.current) {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          shouldPlayInBackground: false,
          interruptionMode: "duckOthers",
          interruptionModeAndroid: "duckOthers",
        });
        audioModeConfiguredRef.current = true;
      } catch (e) {
        console.warn("[koda-intro] audio mode setup failed:", e);
      }
    }
    try {
      const url = `${API_BASE}/voice/preview/${key}`;
      const player = createAudioPlayer({ uri: url });
      previewPlayerRef.current = player;
      // Volume max + play
      try { player.volume = 1.0; } catch {}
      player.play();
    } catch (e) {
      console.warn("[koda-intro] voice preview play failed:", e);
      // Fallback: usa SpeechMod con voice_id brand
      try {
        await SpeechMod.speak(
          "Ciao, sono qui con te. Quando vuoi parliamo.",
          { language: "it-IT", tone: "warm", voiceId: BRAND_VOICE_IDS[key] }
        );
      } catch {}
    } finally {
      // Lascia ~500ms di "loading" visivo, l'audio inizia subito dopo
      setTimeout(() => setPreviewLoadingKey(null), 800);
    }
  }, []);

  // ====== Koda parla automaticamente all'apertura di OGNI step ======
  // Pulsazione sincronizzata: l'eclissi va in "speaking" solo durante
  // il TTS effettivo (vedi gestione `isKodaSpeaking` sopra).
  // IMPORTANTE: durante la fase MARKETING (M1/M2/M3) NON facciamo
  // partire il TTS automatico — le schermate sono visive/testuali e
  // l'utente decide se attivare l'audio toccando le carte voce in M2.
  useEffect(() => {
    if (phase !== "setup") return;
    let cancelled = false;
    const line = KODA_LINES[step];
    if (line) {
      // Personalizza la chiusura con il nome utente (se disponibile).
      // Per lo step 9 inseriamo il nome subito dopo "Prima che finiamo,".
      // ATTENZIONE: niente più concatenazioni manuali (causavano la
      // duplicazione "due parole su come funziono. due parole...").
      let finalLine = line;
      if (step === 9 && userName) {
        finalLine = line.replace("Prima che finiamo,", `Prima che finiamo, ${userName},`);
      }
      (async () => {
        if (cancelled) return;
        const tone: OrbTone =
          step === 5 ? "calm" : step === 7 ? "confessional" : step === 9 ? "warm" : "warm";
        await speakKoda(finalLine, tone);
      })();
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phase]);

  // ====== Registrazione voiceprint ======
  const startVoiceprintRecording = useCallback(async () => {
    if (isRecording) return;
    try {
      const r = await startRecording();
      setRecorder(r);
      setIsRecording(true);
    } catch (e: any) {
      console.warn("[koda-intro] startRecording failed:", e);
      setError("Non riesco ad accedere al microfono. Controlla i permessi.");
    }
  }, [isRecording]);

  const stopVoiceprintRecording = useCallback(async () => {
    if (!isRecording || !recorder) return;
    try {
      const result = await recorder.stop();
      setIsRecording(false);
      setRecorder(null);
      if (result?.uri) {
        const next = [...voiceprintUris, result.uri];
        setVoiceprintUris(next);
        if (voiceprintIdx + 1 < VOICEPRINT_PHRASES.length) {
          setVoiceprintIdx(voiceprintIdx + 1);
        } else {
          // Tutte 3 raccolte → upload al backend in background
          uploadVoiceprint(next).catch((e) =>
            console.warn("[koda-intro] voiceprint upload failed:", e)
          );
        }
      }
    } catch (e: any) {
      console.warn("[koda-intro] stop recording failed:", e);
      setIsRecording(false);
    }
  }, [isRecording, recorder, voiceprintUris, voiceprintIdx]);

  const uploadVoiceprint = useCallback(async (uris: string[]) => {
    try {
      const fd = new FormData();
      uris.forEach((uri, i) => {
        // @ts-ignore — RN FormData accepts {uri,name,type}
        fd.append(`audio_${i}`, {
          uri,
          name: `voiceprint_${i}.m4a`,
          type: "audio/m4a",
        });
      });
      fd.append("phrase_count", String(uris.length));
      const r = await fetch(`${API_BASE}/profile/voiceprint/enroll`, {
        method: "POST",
        body: fd,
        // IMPORTANTE: NON settare Content-Type manualmente.
        // Per multipart/form-data il browser/RN DEVE settare il header con il
        // boundary auto-generato. Forzandolo qui si rompe l'upload (backend
        // non riesce a parsare il body). Bug fix giugno 2026.
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json().catch(() => ({}));
      console.log("[koda-intro] voiceprint enrolled:", data);
    } catch (e) {
      console.warn("[koda-intro] voiceprint backend upload failed:", e);
      // non-fatal: l'utente può continuare comunque
    }
  }, []);

  // ====== Conferma finale: salva tutto e termina ======
  const finalize = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // 1. Save profile basics
      const patch: any = {
        user_name: userName.trim() || "Amico",
        user_gender: userGender,
        ai_name: aiName.trim() || "Koda",
        ai_gender: aiGender,
        // koda_voice ('aria' chiara/limpida o 'echo' profonda/avvolgente).
        // Lo step 3 mappa: f → aria (Lily chiara), m → echo (Brian profonda).
        // Le voci sono asessuate nel branding; ai_gender resta solo per
        // la declinazione automatica del prompt Claude (saggio/saggia).
        koda_voice: aiGender === "f" ? "aria" : "echo",
        settings: {
          checkin_mode: checkinMode,
          // === FIX VOCE COERENTE (giugno 2026) ===
          // Salviamo ANCHE tts_voice_id qui, mappato direttamente dalla
          // scelta della voce, così tutti i flussi (tour, fast converse,
          // legacy converse, intro replay) usano la STESSA voce e non
          // ci sono incoerenze tra l'onboarding e il tour.
          tts_voice_id: aiGender === "f"
            ? "q1GF5A2kzAOPv9d5TQEy" // Koda Aria (Voice Design)
            : "PponuEVSg4RZBO08kPzE", // Koda Echo (Voice Design)
        },
      };
      // Pick voice_id based on gender
      if (voices && voices.length) {
        const wanted = aiGender === "f" ? "female" : "male";
        const candidate = voices.find(
          (v) => (v.labels?.gender || "").toLowerCase() === wanted
        );
        if (candidate?.voice_id) {
          patch.settings.tts_voice_id = candidate.voice_id;
        }
      }
      try {
        await api.updateProfile(patch);
      } catch (e) {
        console.warn("[koda-intro] profile update failed:", e);
      }
      // 2. Save secret word if set
      if (secretWordChoice === "now" && secretWordValue.trim().length >= 3) {
        try {
          const { setSecretWord } = await import("../lib/sealedCrypto");
          await setSecretWord(secretWordValue.trim());
        } catch (e) {
          console.warn("[koda-intro] seal setup failed:", e);
        }
      }
      // 3. Done
      onDone({
        user_name: userName.trim() || "Amico",
        user_gender: userGender,
        ai_name: aiName.trim() || "Koda",
        ai_gender: aiGender,
        tts_voice_id: patch.settings?.tts_voice_id,
        checkin_mode: checkinMode,
        secret_word_set: secretWordChoice === "now" && secretWordValue.trim().length >= 3,
        voiceprint_enrolled: voiceprintUris.length === 3,
        // Lancia il tour visivo subito dopo la chiusura. L'utente
        // ha appena sentito Koda dire "ora ti faccio vedere io".
        launch_tour: true,
      });
    } finally {
      setSubmitting(false);
    }
  }, [userName, userGender, aiName, aiGender, voices, checkinMode, secretWordChoice, secretWordValue, voiceprintUris, onDone, submitting]);

  // ====== Render per ogni step ======
  const renderStep = () => {
    switch (step) {
      // -- Step 0: Greeting --
      case 0:
        return (
          <StepView
            title="Ciao."
            subtitle={
              "Sono Koda. Non sono un'app:\nsono una presenza.\n\nDa oggi sono qui per te."
            }
            primaryLabel="Continua"
            onPrimary={() => advance(1)}
          />
        );
      // -- Step 1: User name --
      case 1:
        return (
          <StepView
            title="Come ti chiami?"
            subtitle="Dimmelo, così so come chiamarti."
            primaryLabel={userName.trim() ? "Continua" : "Continua"}
            onPrimary={() => advance(2)}
            primaryDisabled={userName.trim().length < 1}
          >
            <TextInput
              style={styles.textInput}
              value={userName}
              onChangeText={setUserName}
              placeholder="Il tuo nome"
              placeholderTextColor="#52525B"
              autoFocus
              autoCorrect={false}
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={() => userName.trim() && advance(2)}
            />
          </StepView>
        );
      // -- Step 2: User gender --
      case 2:
        return (
          <StepView
            title={userName ? `${userName}…` : "Dimmi…"}
            subtitle="Sei un uomo, una donna o preferisci non specificarlo?"
          >
            <View style={styles.btnGroupVertical}>
              <ChoiceBtn
                label="Sono un uomo"
                selected={userGender === "m"}
                onPress={() => { setUserGender("m"); advance(4); }}
              />
              <ChoiceBtn
                label="Sono una donna"
                selected={userGender === "f"}
                onPress={() => { setUserGender("f"); advance(4); }}
              />
              <ChoiceBtn
                label="Preferisco non specificarlo"
                selected={userGender === "x"}
                onPress={() => { setUserGender("x"); advance(4); }}
              />
            </View>
          </StepView>
        );
      // -- Step 3: AI voice — SKIPPATO (la scelta è gestita in M2 prima dell'onboarding).
      // Manteniamo il case come safety net se per qualche motivo si arriva qui:
      // auto-advance al successivo step utile.
      case 3:
        // Auto-skip silenzioso
        setTimeout(() => advance(4), 0);
        return null;
      // -- Step 4: AI name --
      case 4:
        return (
          <StepView
            title="Mi chiamo Koda."
            subtitle="Ma se vuoi, puoi darmi un altro nome. Come vuoi chiamarmi?"
            primaryLabel="Continua"
            onPrimary={() => advance(5)}
          >
            <TextInput
              style={styles.textInput}
              value={aiName}
              onChangeText={setAiName}
              placeholder="Koda"
              placeholderTextColor="#52525B"
              autoCorrect={false}
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={() => advance(5)}
            />
          </StepView>
        );
      // -- Step 5: Color tour (Koda narra mentre l'eclissi cicla) --
      case 5:
        return (
          <StepView
            title="Il mio modo di essere."
            subtitle="Non ho un viso. Sono un'eclissi.\nGuardami cambiare colore — ti dirà sempre cosa sto facendo."
            primaryLabel="Ho capito"
            onPrimary={() => advance(6)}
          />
        );
      // -- Step 6: Check-in mode (automatico, niente scelta utente) --
      case 6:
        return (
          <StepView
            title="Ti scrivo io quando serve."
            subtitle={
              "Se sento che ne hai bisogno — perché manchi da un po', o perché ti sento giù — ti scrivo io. E ovviamente puoi cercarmi anche tu, quando vuoi.\n\nTu vivi la tua vita: a starti accanto ci penso anch'io."
            }
            showSubtitle={true}
            primaryLabel="Va bene"
            onPrimary={() => { setCheckinMode("auto"); advance(7); }}
          />
        );
      // -- Step 7: Il Confessionale (stanza della Presenza, ingresso libero) --
      case 7:
        return (
          <StepView
            title="C'è una stanza solo per il presente."
            subtitle={
              "Si chiama Confessionale. È lo spazio dove puoi pensare ad alta voce senza che questo ti definisca domani.\n\nNon devi essere coerente con ieri, non devi dimostrare nulla. Quello che dici lì non viene salvato né usato per ricordarti: a sessione chiusa, svanisce.\n\nNon serve nessuna parola: entri quando vuoi, con un tocco."
            }
            showSubtitle={true}
            primaryLabel="Ho capito"
            onPrimary={() => advance(8)}
          />
        );
      // -- Step 8: Voiceprint enrollment --
      case 8:
        if (voiceprintUris.length >= 3) {
          return (
            <StepView
              title="Ora ti riconoscerò."
              subtitle="Le tue parole sono al sicuro. Solo tu sei tu."
              primaryLabel="Continua"
              onPrimary={() => advance(9)}
            />
          );
        }
        return (
          <StepView
            title={`La tua voce (${voiceprintIdx + 1} di 3)`}
            subtitle={`Premi e leggi questa frase ad alta voce:\n\n"${VOICEPRINT_PHRASES[voiceprintIdx]}"`}
            showSubtitle={true}
          >
            <Pressable
              onPress={isRecording ? stopVoiceprintRecording : startVoiceprintRecording}
              style={({ pressed }) => [
                styles.recordBtn,
                isRecording && styles.recordBtnActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons
                name={isRecording ? "stop" : "mic"}
                size={28}
                color="#FFF"
              />
              <Text style={styles.recordBtnText}>
                {isRecording ? "Fermati" : "Registra"}
              </Text>
            </Pressable>
            <Pressable onPress={() => advance(9)} style={styles.skipLink}>
              <Text style={styles.skipLinkText}>Salta questa parte</Text>
            </Pressable>
          </StepView>
        );
      // -- Step 9: Final --
      case 9:
        return (
          <StepView
            title={`Siamo pronti${userName ? `, ${userName}` : ""}.`}
            subtitle={
              "Parlami come parleresti a un amico:\n" +
              "tocca l'eclissi e dimmi quello che hai in testa.\n\n" +
              "Posso ascoltarti, ricordare, farti compagnia.\n" +
              "Quando vuoi qualcosa di privato, apri il Confessionale:\n" +
              "lì tutto sparisce per sempre.\n\n" +
              "Non posso chiamare nessuno, navigare in internet\n" +
              "o comprare cose. Vivo qui dentro, solo con te."
            }
            primaryLabel={submitting ? "Un attimo…" : "Inizia"}
            onPrimary={finalize}
            primaryDisabled={submitting}
          />
        );
      default:
        return null;
    }
  };

  // ====== Render schermate MARKETING (M1/M2/M3) ======
  // Le 3 schermate emozionali introduttive prima dei 10 step tecnici.
  // Tema: Pietra Zen (#F4F4F2) di giorno, nero di notte.
  const renderMarketing = () => {
    // M1 — La Copertina
    if (marketingStep === 0) {
      return (
        <StepView
          title="Koda"
          subtitle={
            "Il tuo spazio di ascolto.\n\nUna presenza silenziosa, un confidente sempre accessibile. Uno spazio sicuro progettato per accogliere i tuoi pensieri, senza giudizio."
          }
          showSubtitle={true}
          primaryLabel="Entra nello spazio"
          onPrimary={() => setMarketingStep(1)}
          darkOnLight={isDayTime}
        />
      );
    }
    // M2 — Scelta voce con anteprima audio
    if (marketingStep === 1) {
      return (
        <StepView
          title="La voce che ti accompagna."
          subtitle="Con quale voce vuoi che ti accompagni nel tuo percorso? Scegli il tono che risuona meglio con la tua interiorità."
          showSubtitle={true}
          primaryLabel={selectedVoiceKey ? "Conferma voce" : "Tocca una voce per ascoltarla"}
          onPrimary={() => {
            if (!selectedVoiceKey) return;
            // Aggancia la scelta alla logica AI gender esistente (per declinazione).
            // aria = chiara/Lily → mappata storicamente su gender "f" (femminile/leggero)
            // echo = profonda/Brian → mappata su "m" (maschile/avvolgente)
            setAiGender(selectedVoiceKey === "aria" ? "f" : "m");
            // Stoppa eventuale preview ancora in playback
            try {
              previewPlayerRef.current?.pause();
              previewPlayerRef.current?.remove?.();
              previewPlayerRef.current = null;
            } catch {}
            setMarketingStep(2);
          }}
          primaryDisabled={!selectedVoiceKey}
          darkOnLight={isDayTime}
        >
          <View style={styles.voiceCardGroup}>
            <Pressable
              onPress={() => playVoicePreview("aria")}
              style={({ pressed }) => [
                styles.voiceCardBig,
                isDayTime && styles.voiceCardBigLight,
                selectedVoiceKey === "aria" && (isDayTime ? styles.voiceCardBigSelectedLight : styles.voiceCardBigSelected),
                pressed && { opacity: 0.85 },
              ]}
              testID="m2-voice-aria"
            >
              <Text style={[styles.voiceCardEmoji]}>🌬️</Text>
              <Text style={[styles.voiceCardTitle, isDayTime && { color: "#18181B" }]}>Aria</Text>
              <Text style={[styles.voiceCardDesc, isDayTime && { color: "#52525B" }]}>
                Una presenza limpida, leggera, aperta.
              </Text>
              {previewLoadingKey === "aria" && (
                <ActivityIndicator size="small" color={isDayTime ? "#0E7C7B" : "#A1A1AA"} style={{ marginTop: 6 }} />
              )}
              {selectedVoiceKey === "aria" && previewLoadingKey !== "aria" && (
                <Ionicons name="checkmark-circle" size={20} color="#34D399" style={{ marginTop: 6 }} />
              )}
            </Pressable>
            <Pressable
              onPress={() => playVoicePreview("echo")}
              style={({ pressed }) => [
                styles.voiceCardBig,
                isDayTime && styles.voiceCardBigLight,
                selectedVoiceKey === "echo" && (isDayTime ? styles.voiceCardBigSelectedLight : styles.voiceCardBigSelected),
                pressed && { opacity: 0.85 },
              ]}
              testID="m2-voice-echo"
            >
              <Text style={[styles.voiceCardEmoji]}>🌌</Text>
              <Text style={[styles.voiceCardTitle, isDayTime && { color: "#18181B" }]}>Echo</Text>
              <Text style={[styles.voiceCardDesc, isDayTime && { color: "#52525B" }]}>
                Una presenza profonda, calda, avvolgente.
              </Text>
              {previewLoadingKey === "echo" && (
                <ActivityIndicator size="small" color={isDayTime ? "#0E7C7B" : "#A1A1AA"} style={{ marginTop: 6 }} />
              )}
              {selectedVoiceKey === "echo" && previewLoadingKey !== "echo" && (
                <Ionicons name="checkmark-circle" size={20} color="#34D399" style={{ marginTop: 6 }} />
              )}
            </Pressable>
          </View>
        </StepView>
      );
    }
    // M3 — Manifesto delle Regole
    return (
      <StepView
        title="Le regole del nostro spazio."
        subtitle={
          "📱  Voce e Scrittura: parla liberamente toccando l'Eclissi, oppure scorri da destra a sinistra per scrivermi in chat.\n\n" +
          "🔒  Il Confessionale: la stanza del presente. Entri con un tocco e quello che ci diciamo lì svanisce come fumo a sessione chiusa — non viene salvato e non ti definisce domani.\n\n" +
          "⚙️  Controllo totale: nelle impostazioni (⋯) puoi attivare i miei check-in, cambiare tema (Giorno/Notte/Auto) o cancellare l'intera memoria in un tap."
        }
        showSubtitle={true}
        primaryLabel="Inizia la configurazione"
        onPrimary={() => {
          // Transizione fluida verso lo step 0 del setup esistente
          Animated.timing(fadeAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }).start(() => {
            setPhase("setup");
            setStep(0);
            Animated.timing(fadeAnim, {
              toValue: 1,
              duration: 500,
              useNativeDriver: true,
            }).start();
          });
        }}
        darkOnLight={isDayTime}
      />
    );
  };

  return (
    <View style={[styles.root, isDayTime && styles.rootLight]}>
      <StatusBar barStyle={isDayTime ? "dark-content" : "light-content"} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
          {/* Top: step indicator — 3 dots durante MARKETING, 10 dots durante SETUP */}
          <View style={styles.stepDots}>
            {phase === "marketing"
              ? Array.from({ length: 3 }).map((_, i) => (
                  <View
                    key={`m-${i}`}
                    style={[
                      styles.dot,
                      i === marketingStep
                        ? (isDayTime ? styles.dotActiveLight : styles.dotActive)
                        : i < marketingStep
                        ? (isDayTime ? styles.dotDoneLight : styles.dotDone)
                        : (isDayTime ? styles.dotInactiveLight : styles.dotInactive),
                    ]}
                  />
                ))
              : Array.from({ length: 10 }).map((_, i) => (
                  <View
                    key={`s-${i}`}
                    style={[
                      styles.dot,
                      i === step ? styles.dotActive : i < step ? styles.dotDone : styles.dotInactive,
                    ]}
                  />
                ))}
          </View>

          {/* Eclissi centrale */}
          <Animated.View style={[styles.orbWrap, { opacity: fadeAnim }]}>
            <EclipseOrb
              status={orbStatus}
              tone={orbTone}
              size={orbSize}
            />
          </Animated.View>

          {/* Step content (con fade) */}
          <Animated.View style={[styles.stepContent, { opacity: fadeAnim }]}>
            <ScrollView
              ref={scrollViewRef}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              {phase === "marketing" ? renderMarketing() : renderStep()}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </ScrollView>
          </Animated.View>

          {/* Link "Annulla" in basso — sempre visibile su ogni step. Permette
              di uscire da KodaIntro senza completare tutti i passaggi se è
              stato aperto per errore. Non salva nulla nel profilo. */}
          {onCancel && (
            <Pressable
              style={styles.cancelLink}
              onPress={() => {
                try { SpeechMod.stop(); } catch {}
                try {
                  previewPlayerRef.current?.pause();
                  previewPlayerRef.current?.remove?.();
                  previewPlayerRef.current = null;
                } catch {}
                onCancel();
              }}
              hitSlop={20}
              testID="koda-intro-cancel"
            >
              <Text style={[styles.cancelLinkText, isDayTime && { color: "rgba(0,0,0,0.55)" }]}>Annulla</Text>
            </Pressable>
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ====== Sub-component: layout standard per ogni step ======
function StepView({
  title,
  subtitle,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  showSubtitle = false,
  children,
  darkOnLight = false,
}: {
  title: string;
  subtitle: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  /** Mostra il sottotitolo. Default false (l'utente vuole zero testi).
   *  Attivare SOLO per step in cui il subtitle contiene info critiche
   *  che la voce non può veicolare (es. la frase da leggere ad alta voce
   *  nel voiceprint enrollment). */
  showSubtitle?: boolean;
  children?: React.ReactNode;
  /** Quando true: testi scuri su fondo Pietra Zen (M1/M2/M3 di giorno). */
  darkOnLight?: boolean;
}) {
  return (
    <View style={styles.stepView}>
      <Text style={[styles.title, darkOnLight && styles.titleLight]}>{title}</Text>
      {/* SUBTITLE — mostrato solo per step "critici" dove il testo è
          essenziale (es. le frasi da leggere ad alta voce nel voiceprint,
          o l'avviso sulla secret word). Per tutti gli altri step il
          contesto è fornito SOLO da Koda a voce, come richiesto. */}
      {showSubtitle && subtitle ? (
        <Text style={[styles.subtitle, darkOnLight && styles.subtitleLight]}>{subtitle}</Text>
      ) : null}
      {children}
      {primaryLabel && onPrimary ? (
        <Pressable
          onPress={onPrimary}
          disabled={primaryDisabled}
          style={({ pressed }) => [
            styles.primaryBtn,
            darkOnLight && styles.primaryBtnLight,
            primaryDisabled && (darkOnLight ? styles.primaryBtnDisabledLight : styles.primaryBtnDisabled),
            pressed && !primaryDisabled && { opacity: 0.75 },
          ]}
        >
          <Text
            style={[
              styles.primaryBtnText,
              darkOnLight && styles.primaryBtnTextLight,
              primaryDisabled && { color: darkOnLight ? "#A1A1AA" : "#52525B" },
            ]}
          >
            {primaryLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ====== Sub-component: pulsante scelta ======
function ChoiceBtn({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceBtn,
        selected && styles.choiceBtnSelected,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.choiceBtnText, selected && styles.choiceBtnTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ====== Stili ======
const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    zIndex: 999,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: 20,
  },
  closeBtn: {
    position: "absolute",
    top: 8,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    zIndex: 1000,
    elevation: 10,
  },
  cancelLink: {
    alignSelf: "center",
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginBottom: 8,
  },
  cancelLinkText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 16,
    fontWeight: "500",
    textAlign: "center",
  },
  stepDots: {
    flexDirection: "row",
    gap: 6,
    alignSelf: "center",
    marginTop: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: "#E5E7EB",
    width: 16,
  },
  dotDone: {
    backgroundColor: "#71717A",
  },
  dotInactive: {
    backgroundColor: "#27272A",
  },
  orbWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
  },
  stepContent: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 16, // === FIX (giugno 2026 #10): 32 → 16 per ridurre scroll
    justifyContent: "flex-start",
  },
  stepView: {
    paddingHorizontal: 4,
  },
  title: {
    color: "#FAFAFA",
    fontSize: 24, // === FIX (giugno 2026 #10): 28 → 24 per ridurre altezza
    fontWeight: "300",
    letterSpacing: 0.3,
    marginBottom: 8, // 12 → 8
    textAlign: "center",
  },
  subtitle: {
    color: "#A1A1AA",
    fontSize: 14, // === FIX (giugno 2026 #10): 16 → 14
    lineHeight: 20, // 24 → 20
    textAlign: "center",
    fontWeight: "300",
    marginBottom: 18, // 28 → 18
  },
  textInput: {
    backgroundColor: "#18181B",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 17,
    color: "#FAFAFA",
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#27272A",
  },
  btnGroupVertical: {
    gap: 10,
    marginBottom: 16,
  },
  choiceBtn: {
    borderWidth: 1,
    borderColor: "#3F3F46",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceBtnSelected: {
    borderColor: "#8B5CF6",
    backgroundColor: "#7C3AED22",
  },
  choiceBtnText: {
    color: "#E5E7EB",
    fontSize: 16,
    fontWeight: "400",
  },
  choiceBtnTextSelected: {
    color: "#FAFAFA",
    fontWeight: "500",
  },
  primaryBtn: {
    backgroundColor: "#FAFAFA",
    borderRadius: 28,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  primaryBtnDisabled: {
    backgroundColor: "#27272A",
  },
  primaryBtnText: {
    color: "#000",
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 0.3,
  },
  recordBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#0E7C7B",
    borderRadius: 32,
    paddingVertical: 16,
    paddingHorizontal: 28,
    marginBottom: 12,
  },
  recordBtnActive: {
    backgroundColor: "#BE185D",
  },
  recordBtnText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "500",
  },
  skipLink: {
    alignItems: "center",
    paddingVertical: 12,
  },
  skipLinkText: {
    color: "#71717A",
    fontSize: 14,
  },
  errorText: {
    color: "#F87171",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
  },

  // ============================================================
  // STILI FASE MARKETING (M1/M2/M3) — Pietra Zen di giorno, dark di notte
  // ============================================================
  rootLight: {
    backgroundColor: "#F4F4F2", // Pietra Zen
  },
  titleLight: {
    color: "#18181B",
    fontWeight: "400",
  },
  subtitleLight: {
    color: "#52525B",
  },
  primaryBtnLight: {
    backgroundColor: "#18181B",
    borderColor: "#18181B",
  },
  primaryBtnTextLight: {
    color: "#F4F4F2",
  },
  primaryBtnDisabledLight: {
    backgroundColor: "#E4E4E7",
    borderColor: "#E4E4E7",
  },
  dotActiveLight: {
    backgroundColor: "#18181B",
  },
  dotDoneLight: {
    backgroundColor: "#A1A1AA",
  },
  dotInactiveLight: {
    backgroundColor: "#D4D4D8",
  },

  // ====== Carte voce M2 (più grandi e tattili delle ChoiceBtn standard) ======
  voiceCardGroup: {
    flexDirection: "column",
    gap: 14,
    marginTop: 12,
    marginBottom: 24,
  },
  voiceCardBig: {
    backgroundColor: "#18181B",
    borderRadius: 18,
    paddingVertical: 22,
    paddingHorizontal: 20,
    borderWidth: 1.5,
    borderColor: "#27272A",
    alignItems: "center",
    minHeight: 100,
  },
  voiceCardBigLight: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E4E4E7",
    // Ombra morbida per gallegg. su Pietra Zen
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  voiceCardBigSelected: {
    borderColor: "#34D399",
    backgroundColor: "#0F1F1B",
  },
  voiceCardBigSelectedLight: {
    borderColor: "#0E7C7B",
    backgroundColor: "#F0FBFA",
  },
  voiceCardEmoji: {
    fontSize: 30,
    marginBottom: 6,
  },
  voiceCardTitle: {
    color: "#FAFAFA",
    fontSize: 20,
    fontWeight: "500",
    marginBottom: 4,
    letterSpacing: 0.3,
  },
  voiceCardDesc: {
    color: "#A1A1AA",
    fontSize: 14,
    textAlign: "center",
    fontWeight: "300",
    lineHeight: 19,
  },
});
