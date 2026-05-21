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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
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
const INTRO_VOICE_ID = "XrExE9yKIg1WjnnlVkGX";

// ====== Battute di Koda per ogni step (TTS in tutti) ======
const KODA_LINES: Record<number, string> = {
  0: "Ciao. Sono Koda. Non sono un'app: sono una presenza. Da oggi sono qui per te, quando vuoi parlare, quando vuoi solo che qualcuno ti ascolti. Voglio conoscerti!",
  1: "Come posso chiamarti? Scrivi il tuo nome qui sotto.",
  2: "Dimmi, sei un uomo, una donna, o preferisci non specificarlo? Mi serve per parlarti nel modo giusto.",
  3: "E io? Preferisci sentirmi con voce maschile o femminile?",
  4: "Mi chiamo Koda. Ma se vuoi, puoi darmi un altro nome.",
  5: "Una cosa importante: io non ho un viso. Sono un'eclissi. Quando aspetto sono viola. Quando ti ascolto, divento blu petrolio. Quando rifletto, ciclamino. Quando ti parlo, cambio colore con quello che provo.",
  6: "Una cosa che mi sta a cuore: non devi decidere tu quando sentirmi. Se sento che ne hai bisogno, ti scriverò io. Anche se sparisci per giorni, anche se ti sento giù. Tu vivi la tua vita.",
  7: "C'è uno spazio dove ogni cosa che mi confidi resta cifrata sul tuo telefono. Solo tu puoi sbloccarla con una parola segreta. Vuoi impostarla adesso?",
  8: "Ultima cosa: leggi queste tre frasi ad alta voce. Mi serviranno per riconoscere sempre la tua voce, ovunque tu sia.",
  9: "Bene! Adesso ti faccio vedere come funziono. Guarda dove ti indico.",
};

// ====== Componente principale ======
export default function KodaIntro({ voices = [], currentVoiceId, onDone, onCancel }: Props) {
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { width } = Dimensions.get("window");
  // Dimensione eclissi: ridotta del 30% rispetto alla iterazione precedente
  // per lasciare ampio spazio al testo + tastiera senza bisogno di rilevare
  // keyboardWillShow (che aveva causato problemi di rendering).
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
  // Durante la presentazione usa la voce dolce/intima `INTRO_VOICE_ID` —
  // diversa da quella che userà Koda nella conversazione vera. Setta
  // `isKodaSpeaking=true` per la durata del TTS così l'eclissi pulsa.
  const speakKoda = useCallback(async (text: string, tone: OrbTone = "warm") => {
    const mySeq = ++speakSeqRef.current;
    try {
      setIsKodaSpeaking(true);
      await SpeechMod.speak(text, {
        language: "it-IT",
        tone: tone as any,
        // Priorità: voce già scelta dall'utente (da profilo) → fallback Sarah.
        // Così se rifai l'intro dopo aver già scelto una voce, la senti
        // PARLARE con la SUA voce di Koda fin dal primo step.
        voiceId: currentVoiceId || INTRO_VOICE_ID,
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
  }, []);

  // ====== Ciclo dell'eclissi colorata (step "color tour") ======
  const colorTourTimerRef = useRef<any>(null);
  useEffect(() => {
    // Cleanup quando cambia step
    if (colorTourTimerRef.current) {
      clearTimeout(colorTourTimerRef.current);
      colorTourTimerRef.current = null;
    }
    // STEP 5 (tour colori): la sequenza dei colori parte SOLO quando Koda
    // INIZIA a parlare (così latenza TTS variabile non sfasa la sincronizzazione
    // col testo). Quando smette di parlare, si ferma il timer.
    if (step === 5) {
      if (!isKodaSpeaking) {
        // Pre-roll: in attesa che Koda parli, mostra viola (idle)
        setOrbStatus("idle");
        setOrbTone("neutral");
        return;
      }
      // Koda STA parlando ORA → lancia la sequenza temporale.
      // Testo: "Una cosa importante: io non ho un viso. Sono un'eclissi.   (~5s)
      //  Quando aspetto sono viola.                                       (~2.5s)
      //  Quando ti ascolto, divento blu petrolio.                         (~3.5s)
      //  Quando rifletto, ciclamino.                                      (~2.5s)
      //  Quando ti parlo, cambio colore con quello che provo."            (~4.5s)
      // Durate cumulative dei segmenti: 5, 7.5, 11, 13.5, 18s
      const seq: Array<[OrbStatus, OrbTone | undefined, number]> = [
        // 0-7.5s: pre-roll "Una cosa importante..." + "Quando aspetto sono viola" → idle viola
        ["idle", "neutral", 7500],
        // 7.5-11s: "Quando ti ascolto, divento blu petrolio" → recording blu
        ["recording", undefined, 3500],
        // 11-13.5s: "Quando rifletto, ciclamino" → thinking ciclamino rosa
        ["thinking", undefined, 2500],
        // 13.5-18s: "Quando ti parlo, cambio colore..." → speaking warm rosa
        ["speaking", "warm", 4500],
      ];
      let i = 0;
      setOrbStatus(seq[0][0]);
      if (seq[0][1]) setOrbTone(seq[0][1]);
      const tick = () => {
        i++;
        if (i >= seq.length) return;
        const [s, t] = seq[i];
        setOrbStatus(s);
        if (t) setOrbTone(t);
        const [, , prevDur] = seq[i - 1];
        colorTourTimerRef.current = setTimeout(tick, prevDur);
      };
      colorTourTimerRef.current = setTimeout(tick, seq[0][2]);
      return () => {
        if (colorTourTimerRef.current) clearTimeout(colorTourTimerRef.current);
      };
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
  }, [step, isRecording, isKodaSpeaking]);

  // ====== Koda parla automaticamente all'apertura di OGNI step ======
  // Pulsazione sincronizzata: l'eclissi va in "speaking" solo durante
  // il TTS effettivo (vedi gestione `isKodaSpeaking` sopra).
  useEffect(() => {
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
  }, [step]);

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
        headers: { "Content-Type": "multipart/form-data" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
        settings: {
          checkin_mode: checkinMode,
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
            subtitle="Sei un uomo, una donna o preferisci non specificarlo? Mi serve per parlarti nel modo giusto."
          >
            <View style={styles.btnGroupVertical}>
              <ChoiceBtn
                label="Sono un uomo"
                selected={userGender === "m"}
                onPress={() => { setUserGender("m"); advance(3); }}
              />
              <ChoiceBtn
                label="Sono una donna"
                selected={userGender === "f"}
                onPress={() => { setUserGender("f"); advance(3); }}
              />
              <ChoiceBtn
                label="Preferisco non specificarlo"
                selected={userGender === "x"}
                onPress={() => { setUserGender("x"); advance(3); }}
              />
            </View>
          </StepView>
        );
      // -- Step 3: AI voice gender --
      case 3:
        return (
          <StepView
            title="E io?"
            subtitle="Preferisci sentirmi con voce maschile o femminile?"
          >
            <View style={styles.btnGroupVertical}>
              <ChoiceBtn
                label="Voce femminile"
                selected={aiGender === "f"}
                onPress={() => { setAiGender("f"); advance(4); }}
              />
              <ChoiceBtn
                label="Voce maschile"
                selected={aiGender === "m"}
                onPress={() => { setAiGender("m"); advance(4); }}
              />
            </View>
          </StepView>
        );
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
            title="Sentirò io quando ti serve."
            subtitle="Se sento che ne hai bisogno — perché manchi da un po', o perché ti sento giù — ti scrivo io. Tu vivi la tua vita."
            primaryLabel="Va bene"
            onPrimary={() => { setCheckinMode("auto"); advance(7); }}
          />
        );
      // -- Step 7: Secret word --
      case 7:
        if (secretWordChoice === "now") {
          return (
            <StepView
              title="La tua parola."
              subtitle="Pensaci bene. Solo tu la devi sapere. È la chiave per aprire la modalità sigillata."
              showSubtitle={true}
              primaryLabel="Salva e continua"
              onPrimary={() => advance(8)}
              primaryDisabled={secretWordValue.trim().length < 3}
            >
              <TextInput
                style={styles.textInput}
                value={secretWordValue}
                onChangeText={setSecretWordValue}
                placeholder="Una parola (min 3 caratteri)"
                placeholderTextColor="#52525B"
                autoFocus
                autoCorrect={false}
                secureTextEntry
                maxLength={50}
                returnKeyType="done"
                onSubmitEditing={() => secretWordValue.trim().length >= 3 && advance(8)}
              />
            </StepView>
          );
        }
        return (
          <StepView
            title="Modalità sigillata."
            subtitle={
              "C'è uno spazio dove ogni cosa che mi confidi resta cifrata sul tuo telefono. Solo tu puoi sbloccarla con una parola segreta.\n\nVuoi impostarla adesso?"
            }
          >
            <View style={styles.btnGroupVertical}>
              <ChoiceBtn
                label="Sì, imposta adesso"
                onPress={() => setSecretWordChoice("now")}
              />
              <ChoiceBtn
                label="Più tardi"
                onPress={() => { setSecretWordChoice("later"); advance(8); }}
              />
            </View>
          </StepView>
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
              "Quando vuoi qualcosa di privato, tocca il sigillo in alto:\n" +
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

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
          {/* Top: step indicator */}
          <View style={styles.stepDots}>
            {Array.from({ length: 10 }).map((_, i) => (
              <View
                key={i}
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
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              {renderStep()}
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
                onCancel();
              }}
              hitSlop={20}
              testID="koda-intro-cancel"
            >
              <Text style={styles.cancelLinkText}>Annulla</Text>
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
}) {
  return (
    <View style={styles.stepView}>
      <Text style={styles.title}>{title}</Text>
      {/* SUBTITLE — mostrato solo per step "critici" dove il testo è
          essenziale (es. le frasi da leggere ad alta voce nel voiceprint,
          o l'avviso sulla secret word). Per tutti gli altri step il
          contesto è fornito SOLO da Koda a voce, come richiesto. */}
      {showSubtitle && subtitle ? (
        <Text style={styles.subtitle}>{subtitle}</Text>
      ) : null}
      {children}
      {primaryLabel && onPrimary ? (
        <Pressable
          onPress={onPrimary}
          disabled={primaryDisabled}
          style={({ pressed }) => [
            styles.primaryBtn,
            primaryDisabled && styles.primaryBtnDisabled,
            pressed && !primaryDisabled && { opacity: 0.75 },
          ]}
        >
          <Text style={[styles.primaryBtnText, primaryDisabled && { color: "#52525B" }]}>
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
    paddingBottom: 32,
    justifyContent: "flex-start",
  },
  stepView: {
    paddingHorizontal: 4,
  },
  title: {
    color: "#FAFAFA",
    fontSize: 28,
    fontWeight: "300",
    letterSpacing: 0.3,
    marginBottom: 12,
    textAlign: "center",
  },
  subtitle: {
    color: "#A1A1AA",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
    fontWeight: "300",
    marginBottom: 28,
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
});
