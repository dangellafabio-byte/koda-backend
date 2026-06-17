import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Modal,
  KeyboardAvoidingView,
  Pressable,
  Keyboard,
  Image,
  ImageBackground,
  useWindowDimensions,
  Dimensions,
  Alert,
  AppState,
  Switch,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TouchableOpacity as GHTouchableOpacity } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { LinearGradient } from "expo-linear-gradient";
import {
  api,
  API_BASE,
  BACKEND,
  TimelineEntry,
  Profile,
  toneStyle,
  domainBadge,
  Domain,
  Action,
  VoiceOption,
  Tone,
} from "../lib/api";
import { startRecording, buildFormData, Recorder, prewarmMic } from "../lib/voice";
import { SpeechMod, unlockSpeech, setDefaultVoiceId, preloadFillerPool } from "../lib/speech";
import { startThinkingSound, stopThinkingSound } from "../lib/thinkingSound";
import { classifyEmotion, classifyIntent, secureWipeStrings } from "../lib/emotionClassifier";
import {
  loadProfileCache,
  saveProfileCache,
  loadTimelineCache,
  saveTimelineCache,
} from "../lib/localCache";
import Constants from "expo-constants";
import FortezzaCloseEffect from "../components/FortezzaCloseEffect";
import { scheduleAt, scheduleCheckin, cancelAllCheckins, cancelCheckin } from "../lib/notifications";
import { useTheme, THEME_LIST, ThemeName, Palette } from "../lib/theme";
import AppIcon from "../lib/AppIcon";
import Orb, { OrbTone } from "../components/Orb";
import EclipseOrb from "../components/EclipseOrb";
import MirrorPool from "../components/MirrorPool";
import LiquidInversionBg from "../components/LiquidInversionBg";
import KodaIntro, { KodaIntroResult } from "../components/KodaIntro";
import KodaSplash from "../components/KodaSplash";
import KodaTour, { TourStep } from "../components/KodaTour";
import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import NeonBorder, { NeonBorderStatus } from "../components/NeonBorder";
import ActivationPulse from "../components/ActivationPulse";
import RadialGlow from "../components/RadialGlow";
import SealSetupModal from "../components/SealSetupModal";
import InfoModal from "../components/InfoModal";
import SafetyAlert from "../components/SafetyAlert";
import FreemiumCounter from "../components/FreemiumCounter";
import ProactiveOffer from "../components/ProactiveOffer";
import { useRouter } from "expo-router";
import type { SafetyCheckResult, FreemiumStatus as FreemiumStatusType } from "../lib/api";
import { useOrbAmbient } from "../lib/useOrbAmbient";
import { useFonts, Caveat_400Regular, Caveat_500Medium } from "@expo-google-fonts/caveat";
// === Zero-Knowledge Confessional crypto ===
import {
  hasSecretWord,
  getSessionKey,
  forgetSessionKey,
  setSecretWord,
  clearSecretWord,
  sealText,
  unsealText,
  keyToBase64,
  biometricAvailable,
} from "../lib/sealedCrypto";

type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

// === Background presets — gradients evocative of Taccuino Vivo identity
type BgPreset = {
  id: string;
  name: string;
  colors: [string, string, ...string[]];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
};
const BG_PRESETS: BgPreset[] = [
  // Solo 3 sfondi essenziali — meno scelte, meno friction.
  // 1. Notturno: scuro silenzioso (default per chi vuole zen totale)
  { id: "notturno", name: "Notturno", colors: ["#000000", "#1A1A2E", "#16213E"] },
  // 2. Aurora: viola intimo (perfetto per la macchia gialla calda)
  { id: "aurora", name: "Aurora", colors: ["#0F0C29", "#302B63", "#24243E"] },
  // 3. Carta: caldo / diurno per chi preferisce sfondo chiaro
  { id: "carta", name: "Carta", colors: ["#F5E9D7", "#E8D5B7", "#D4B896"] },
];

// === Day separator helper
function dayLabelFor(d: Date): string {
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Oggi";
  if (sameDay(d, yest)) return "Ieri";
  const days = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  const months = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  // Capitalize first letter
  const dn = days[d.getDay()];
  return `${dn[0].toUpperCase()}${dn.slice(1)} ${d.getDate()} ${months[d.getMonth()]}`;
}

const LANGUAGES = [
  { code: "it", label: "Italiano", emoji: "🇮🇹" },
  { code: "en", label: "English", emoji: "🇬🇧" },
  { code: "es", label: "Español", emoji: "🇪🇸" },
  { code: "fr", label: "Français", emoji: "🇫🇷" },
  { code: "de", label: "Deutsch", emoji: "🇩🇪" },
];

function detectDeviceLang(): string {
  try {
    if (typeof navigator !== "undefined" && navigator.language) {
      const code = navigator.language.slice(0, 2).toLowerCase();
      if (LANGUAGES.find((l) => l.code === code)) return code;
    }
  } catch {}
  return "it";
}

// Mappa nomi italiani → HEX per i comandi vocali "cambia colore in [nome]"
const NAMED_COLORS: Record<string, string> = {
  rosso: "#EF4444", red: "#EF4444",
  blu: "#3B82F6", blue: "#3B82F6",
  giallo: "#FACC15", yellow: "#FACC15",
  verde: "#22C55E", green: "#22C55E",
  rosa: "#EC4899", pink: "#EC4899",
  viola: "#8B5CF6", purple: "#8B5CF6",
  arancione: "#F97316", orange: "#F97316",
  azzurro: "#38BDF8", celeste: "#7DD3FC",
  nero: "#1F2937", black: "#1F2937",
  bianco: "#F3F4F6", white: "#F3F4F6",
  marrone: "#92400E", brown: "#92400E",
  ambra: "#FBBF24", magenta: "#D946EF",
  turchese: "#14B8A6", oro: "#FBBF24", argento: "#D1D5DB",
  fucsia: "#E11D48", lilla: "#C4B5FD", indaco: "#6366F1",
};

// Rimuove i tag [TONE:xxx], gli [audio tags], le *narrazioni* tra
// asterischi (es. *sighs*, *laughs*) e le (azioni) tra parentesi dal
// testo per la visualizzazione in chat. Difensivo: il backend già
// pulisce, ma vecchi dati o race possono far arrivare il prefisso
// grezzo (es. "[TONE:warm] ...", "*sighs* Ciao...").
function stripDisplayTags(text: string): string {
  if (!text) return text;
  return text
    // [TONE:warm] e simili
    .replace(/\[\s*TONE\s*:\s*[a-zA-Z_\-]+\s*\]\s*/gi, "")
    // [audio tags] generici (sospira, ride, gently, ecc.)
    .replace(/\[[a-zA-Zàèéìòùç '_,/-]{1,40}\]/g, "")
    // *azioni in asterischi* tipiche di output LLM "narrato"
    // (es. *sighs*, *laughs*, *sospira*, *sorride*)
    .replace(/\*[^*\n]{1,60}\*/g, "")
    // (azioni in parentesi tonde) — solo se sembrano descrizioni d'azione,
    // cioè brevi e in minuscolo/verbo (es. "(laughs)", "(sospira)").
    // Conservativo: max 30 char, no cifre.
    .replace(/\(\s*[a-zàèéìòùç' ]{2,30}\s*\)/gi, "")
    .replace(/  +/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

export default function Taccuino() {
  const insets = useSafeAreaInsets();
  const { theme, themeName, setThemeName, setHours, dayStart, nightStart } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [textInput, setTextInput] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  // === KODA INTRO ===
  // Presentazione conversazionale di Koda al primo avvio. Sostituisce
  // sia il vecchio onboarding modale che il tutorial colori. Koda si
  // presenta in prima persona, chiede tutte le info che gli servono
  // (nome, gender, voce, check-in, parola segreta, voiceprint) e poi
  // si congeda. Persistito in SecureStore con `koda_intro_seen=1`.
  // `null` = ancora da verificare; `true` = mostra; `false` = nascondi.
  const [showColorIntro, setShowColorIntro] = useState<boolean | null>(null);
  // Splash screen all'apertura (4 sec) per mascherare la latenza di boot e
  // dare un'identità visiva forte: eclissi che respira colori + nome AI.
  const [showSplash, setShowSplash] = useState<boolean>(true);
  const [voiceList, setVoiceList] = useState<Array<any>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seen = await SecureStore.getItemAsync("koda_intro_seen");
        if (!cancelled) setShowColorIntro(seen !== "1");
      } catch {
        if (!cancelled) setShowColorIntro(false);
      }
      // Carica le voci ElevenLabs disponibili per la scelta automatica
      try {
        const r = await fetch(`${API_BASE}/voices`);
        if (r.ok) {
          const v = await r.json();
          if (!cancelled && Array.isArray(v)) setVoiceList(v);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  // === ACTIVATION PULSE (idea 1) ===
  // Effetto "sistema attivo" all'avvio dell'app: linea neon viola traccia
  // il perimetro dello schermo in 1.5s, poi svanisce. Mostrato SOLO al
  // cold start. State `false` significa "ancora da mostrare".
  const [activationPulseDone, setActivationPulseDone] = useState(false);

  // === TOUR GUIDATO (spotlight) ===
  // Si attiva dopo che KodaIntro termina (campo `launch_tour: true` nel
  // result). Mostra un overlay scuro sopra la home con un anello luminoso
  // attorno a ciascun elemento UI, mentre Koda parla a voce spiegando
  // cosa fa. Auto-avanzamento al termine di ogni voce.
  const [tourActive, setTourActive] = useState(false);
  const [tourSteps, setTourSteps] = useState<TourStep[]>([]);
  // === Tour step tracker (giugno 2026, round 5) ===
  // Sappiamo quale step del tour è attivo per sincronizzare gli
  // overlay nella pagina di lettura (messaggi finti + simulazione
  // tieni-premuto) col narrato di Koda.
  const [tourCurrentStep, setTourCurrentStep] = useState<{ idx: number; label?: string; page?: string } | null>(null);
  const tourDims = useWindowDimensions();
  // Mirror del tourActive in ref — serve per leggere il valore aggiornato
  // dentro setTimeout/closure che sono stati schedulati PRIMA che il tour
  // partisse (es. l'auto-mic-open timeout da 450ms): senza questo controllo
  // il mic si apriva nel gap tra "KodaIntro chiusa" e "tourActive=true".
  const tourActiveRef = useRef(false);
  useEffect(() => { tourActiveRef.current = tourActive; }, [tourActive]);

  /** Costruisce gli step del tour usando le coordinate REALI della home
   *  in base a insets e dimensioni schermo. Va chiamato al momento del
   *  lancio per avere coordinate aggiornate (rotazione/foldable safe). */
  /** Misura le coordinate REALI di un elemento UI tramite measureInWindow.
   *  Risolve null se il nodo non è montato/misurabile.
   *  RETRY (giugno 2026): su iOS native (TestFlight) il measureInWindow a
   *  volte ritorna 0/0/0/0 al primo tentativo perché il layout non è
   *  ancora stabilizzato. Riproviamo fino a 4 volte con backoff di 120ms.*/
  const measureRef = useCallback(
    (ref: React.RefObject<any>): Promise<{ x: number; y: number; w: number; h: number } | null> =>
      new Promise((resolve) => {
        const attempt = (n: number) => {
          const node = ref?.current;
          if (!node || typeof node.measureInWindow !== "function") {
            resolve(null);
            return;
          }
          let settled = false;
          try {
            node.measureInWindow((x: number, y: number, w: number, h: number) => {
              settled = true;
              if (w > 0 && h > 0 && (x !== 0 || y !== 0 || n >= 3)) {
                resolve({ x, y, w, h });
              } else if (n < 3) {
                // Retry: layout non ancora pronto
                setTimeout(() => attempt(n + 1), 120);
              } else {
                resolve(w > 0 && h > 0 ? { x, y, w, h } : null);
              }
            });
          } catch {
            resolve(null);
            return;
          }
          setTimeout(() => {
            if (!settled) {
              if (n < 3) attempt(n + 1);
              else resolve(null);
            }
          }, 400);
        };
        attempt(0);
      }),
    []
  );

  /** Costruisce gli step del tour. Le coordinate degli elementi della pagina
   *  voce sono MISURATE dai veri nodi UI (measureInWindow) — prima erano
   *  calcolate a mano e risultavano decentrate. Fallback al calcolo
   *  geometrico se la misura non è disponibile. Le aree della pagina lettura
   *  (non montate al momento del lancio) restano approssimazioni geometriche. */
  const buildTourSteps = useCallback(async (): Promise<TourStep[]> => {
    const W = tourDims.width;
    const H = tourDims.height;
    const headerCY = Math.max(insets.top + 28, 70) + 22;
    const userName = profile?.user_name || "amico";
    const orbSize = Math.min(W * 0.78, 360);
    const orbCY = H * 0.46;
    const [hf, conf, menu, orb, hint] = await Promise.all([
      measureRef(handsFreeBtnRef),
      measureRef(confessionaleBtnRef),
      measureRef(menuBtnRef),
      measureRef(orbBtnRef),
      measureRef(scrollHintRef),
    ]);
    const hfRect = hf || { x: 14, y: headerCY - 22, w: 44, h: 44 };
    const confRect = conf || { x: W / 2 - 95, y: Math.max(insets.top + 100, 150), w: 190, h: 44 };
    const menuRect = menu || { x: W - 58, y: headerCY - 22, w: 44, h: 44 };
    const orbRect = orb || { x: W / 2 - orbSize / 2, y: orbCY - orbSize / 2, w: orbSize, h: orbSize };
    const hintRect = hint || { x: W / 2 - 110, y: H * 0.8, w: 220, h: 36 };
    return [
      // -------- Pagina VOCE --------
      // === FIX TESTI TOUR (richiesta utente giugno 2026 round 2) ===
      // Riscritti: BREVI, EASY, no caramello. 1-2 frasi per step. Tono
      // amichevole ma diretto, no melenso. Rimosso riferimento "lucchetto"
      // dal Confessionale (ora non c'è più l'icona). Niente parole doppie
      // tra step contigui.
      {
        page: "voice",
        rect: hfRect,
        label: "Hands-free",
        shape: "circle",
        speech: `Questa è la modalità mani libere, ${userName}. Quando è attiva ti ascolto io. Toccala per fermarla.`,
      },
      {
        page: "voice",
        rect: confRect,
        label: "Confessionale",
        shape: "round",
        speech: `Qui è il Confessionale: parli e poi tutto sparisce, niente memoria. Per i pensieri che vuoi liberare e basta.`,
      },
      {
        page: "voice",
        rect: menuRect,
        label: "Menu",
        shape: "circle",
        speech: `Da qui: voce, tema, memoria. Tutto quello che vuoi cambiare.`,
      },
      {
        page: "voice",
        rect: orbRect,
        label: "Eclissi",
        shape: "circle",
        speech: `Questa sono io. Toccami per parlarti, ritoccami per fermarmi.`,
      },
      {
        page: "voice",
        rect: hintRect,
        label: "Scorri",
        shape: "round",
        speech: `Scorri verso sinistra: trovi tutta la nostra chat scritta.`,
      },
      // -------- Pagina LETTURA --------
      {
        page: "reading",
        rect: { x: 8, y: Math.max(insets.top + 70, 110), w: W - 16, h: H * 0.55 },
        label: "Lettura",
        shape: "round",
        speech: `Qui rileggi tutto. Tocca una bolla per risentirmi a voce.`,
      },
      {
        page: "reading",
        rect: { x: 8, y: Math.max(insets.top + 100, 140), w: W - 16, h: H * 0.50 },
        label: "Tieni premuto",
        shape: "round",
        speech: `Tieni premuto un messaggio per cancellarlo. Sparisce dal mio ricordo.`,
      },
      {
        page: "reading",
        rect: { x: 8, y: H - Math.max(insets.bottom, 20) - 90, w: W - 16, h: 78 },
        label: "Scrittura",
        shape: "round",
        speech: `Quando non puoi parlare, scrivi qui. Ti rispondo in silenzio.`,
      },
      // -------- Chiusura --------
      {
        page: "voice",
        rect: orbRect,
        label: "Pronti",
        shape: "circle",
        speech: `Ecco, è tutto. Sono qui, ${userName}.`,
      },
    ];
  }, [tourDims.width, tourDims.height, insets.top, insets.bottom, profile?.user_name, measureRef]);

  // === MIC OFF DURANTE INTRO/TOUR ===
  // Se KodaIntro o il Tour si aprono mentre il mic era attivo (hands-free),
  // chiudi immediatamente il mic per liberare la sessione audio. Senza
  // questo, l'AVAudioSession resta in "recording" e blocca il TTS di Koda
  // (la voce non parte durante l'intro).
  useEffect(() => {
    const intruderActive = showColorIntro === true || tourActive || showOnboarding;
    if (intruderActive && recRef.current) {
      // Mic spento brutalmente — non vogliamo né silenzio rilevato né invio.
      // Chiamiamo cancel() (fire-and-forget): voice.ts dentro safeStop()
      // rilascia il recorder e la sessione audio si normalizza al prossimo
      // startTalk (voice.ts setta allowsRecording:true ogni volta).
      // NON tocchiamo setAudioModeAsync qui — altrimenti rischiamo di
      // bloccare la sessione iOS in playback-only e il mic non torna più.
      const r = recRef.current;
      recRef.current = null;
      setStatus("idle");
      try { r.cancel?.(); } catch {}
    }
  }, [showColorIntro, tourActive, showOnboarding]);

  const dismissColorIntro = useCallback(async (result?: KodaIntroResult) => {
    setShowColorIntro(false);
    try {
      await SecureStore.setItemAsync("koda_intro_seen", "1");
    } catch {}
    // Refresh profile dopo che Koda ha salvato i dati
    try {
      const p = await api.getProfile();
      setProfile(p);
    } catch {}
    // Se Koda ha appena chiuso con "lancia tour", apri il tour visivo
    // invece di mostrare il banner di conferma.
    if (result?.launch_tour) {
      // Costruzione step DOPO che il profilo è stato aggiornato (così il
      // nome utente nel testo del tour è quello giusto).
      // DELAY AUMENTATO da 250ms a 600ms (giugno 2026): su iOS native
      // TestFlight il KodaIntro modal impiega ~400ms a fare unmount + il
      // layout della UI principale necessita di un altro frame per
      // stabilizzarsi. Con 250ms i measureInWindow tornavano coordinate
      // sballate → highlights del tour decentrati.
      setTimeout(async () => {
        const steps = await buildTourSteps();
        setTourSteps(steps);
        setTourActive(true);
      }, 600);
      return;
    }
    // Mostra il banner di conferma in home — l'utente ha completato la
    // presentazione (o l'ha rifatta) e i suoi dati sono stati salvati.
    showSavedBanner();
  // showSavedBanner è definita sotto ma è stable (useCallback []), OK.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildTourSteps]);
  /** Riapri la presentazione di Koda (back-door: tap sull'icona ⋯ in alto a destra). */
  const reopenKodaIntro = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync("koda_intro_seen");
    } catch {}
    setShowColorIntro(true);
  }, []);
  // Banner "Configurazione salvata ✓" — mostrato per ~4 secondi quando
  // l'utente completa (o ri-completa) KodaIntro. Conferma visiva che le
  // modifiche al profilo sono state registrate. Sparisce automaticamente.
  const [savedBannerVisible, setSavedBannerVisible] = useState(false);
  const showSavedBanner = useCallback(() => {
    setSavedBannerVisible(true);
    setTimeout(() => setSavedBannerVisible(false), 4000);
  }, []);
  /** Esci da KodaIntro senza salvare nulla (tap su X).
   *  Marca comunque `koda_intro_seen=1` così al prossimo avvio non riappare. */
  const cancelKodaIntro = useCallback(async () => {
    try { SpeechMod.stop(); } catch {}
    setShowColorIntro(false);
    try {
      await SecureStore.setItemAsync("koda_intro_seen", "1");
    } catch {}
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  // === MODALITÀ CONFESSIONALE ===
  // Quando true, /converse viene chiamato con ephemeral=true: il messaggio
  // dell'utente E la risposta dell'AI NON vengono salvati su MongoDB, NON
  // entrano nel memory_summary di lungo periodo, e a fine sessione (chiusura
  // app o toggle off) spariscono dalla RAM.
  const [confessionalMode, setConfessionalMode] = useState(false);
  // === EFFETTO USCITA CONFESSIONALE (giugno 2026, suggerimento ChatGPT) ===
  // driftOut: translateY -12, opacity 1→0 in 220ms. Quando il toggle Confessional
  // passa da ON a OFF, i messaggi confessional NON spariscono di colpo: prima
  // vengono animati per 220ms (con confessionalExiting=true), poi sparire.
  const [confessionalExiting, setConfessionalExiting] = useState(false);
  const confessionalDriftAnim = useRef(new Animated.Value(0)).current;
  const prevConfessionalRef = useRef(false);
  useEffect(() => {
    // Trigger driftOut SOLO sulla transizione true → false (uscita).
    if (prevConfessionalRef.current && !confessionalMode) {
      setConfessionalExiting(true);
      confessionalDriftAnim.setValue(0);
      Animated.timing(confessionalDriftAnim, {
        toValue: 1,
        duration: 220,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start(() => {
        setConfessionalExiting(false);
      });
    }
    prevConfessionalRef.current = confessionalMode;
  }, [confessionalMode, confessionalDriftAnim]);
  // FORTEZZA: stato dell'animazione di chiusura (fiamma + sigillo).
  // Si attiva quando l'utente esce dal confessionale dopo aver scambiato
  // almeno un messaggio in modalità Fortezza. Al termine, wipe locale.
  const [showFortezzaWipe, setShowFortezzaWipe] = useState(false);
  // FIX 2026-06: tracciamo l'uso della Fortezza tramite un ref invece che
  // controllare la timeline. La timeline viene periodicamente ri-fetchata
  // dal backend, e i messaggi Fortezza (che NON vengono salvati su DB per
  // design zero-knowledge) sparivano dalla timeline → l'animazione di
  // chiusura non partiva mai. Il ref è indipendente dal refetch.
  // Viene messo a true al primo messaggio Fortezza inviato/ricevuto, e
  // resettato al termine dell'animazione di wipe.
  const fortezzaUsedThisSessionRef = useRef<boolean>(false);
  // GHOST SESSION TOKEN — "Doppia Stanza" 2026-06.
  // UUID anonimo generato all'entrata del Confessionale, distrutto
  // all'uscita. NON contiene/non è collegato all'ID utente.
  // Serve solo come firma anonima della sessione lato server.
  const confessionalGhostTokenRef = useRef<string | null>(null);
  // === Zero-Knowledge: Parola Segreta (Sigillo) ===
  // Se l'utente ha impostato una Parola Segreta, in modalità Confessionale
  // il messaggio viene cifrato sul dispositivo e inviato a /converse/sealed.
  // Senza Parola Segreta, fallback a ephemeral (no DB ma backend vede testo).
  const [hasSeal, setHasSeal] = useState<boolean>(false);
  const [showSealSetup, setShowSealSetup] = useState(false);
  const [showConfessionalIntro, setShowConfessionalIntro] = useState(false);
  const [sealUnlocking, setSealUnlocking] = useState(false);
  // Re-check seal availability on mount + after any setup/clear.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await hasSecretWord();
        if (!cancelled) setHasSeal(has);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [recapText, setRecapText] = useState<string | null>(null);
  const [showRecap, setShowRecap] = useState(false);

  // === SAFETY ALERT (giugno 2026) ============================================
  // Quando /api/safety/check rileva rischio: blocca l'invio normale, mostra
  // overlay con risorse italiane verificate.
  const [safetyResult, setSafetyResult] = useState<SafetyCheckResult | null>(null);
  const [safetyVisible, setSafetyVisible] = useState(false);

  // === FREEMIUM 3 MESSAGGI (giugno 2026) =====================================
  const router = useRouter();
  const [freemium, setFreemium] = useState<FreemiumStatusType | null>(null);
  const freemiumRef = useRef<FreemiumStatusType | null>(null);
  useEffect(() => { freemiumRef.current = freemium; }, [freemium]);

  // Carica stato freemium al mount + ogni volta che il profilo cambia
  useEffect(() => {
    let cancelled = false;
    api.freemiumStatus()
      .then((s) => { if (!cancelled) setFreemium(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [profile?.id]);

  const inputMode = (profile?.settings?.input_mode === "text"
    ? "text"
    : profile?.settings?.input_mode === "both"
      ? "both"
      : "voice") as "voice" | "text" | "both";
  const conversationOn = !!profile?.settings?.conversation_mode;
  // Tracks "we are inside an active hands-free conversation loop"
  const [convActive, setConvActive] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesEnabled, setVoicesEnabled] = useState(true);
  const [voicePreviewLoading, setVoicePreviewLoading] = useState<string | null>(null);
  const convActiveRef = useRef(false);
  // Flag: scaricato la cronologia confessionale (cifrata) dal backend in
  // questa sessione app. Evita fetch ripetuti.
  const confessionalHistoryLoadedRef = useRef(false);
  useEffect(() => {
    convActiveRef.current = convActive;
  }, [convActive]);

  // === HANDS-FREE MODE ===
  // Default ON. Quando attivo, il microfono si apre da solo non appena Coda
  // entra in idle (dopo aver finito di parlare). Il VAD chiude il mic dopo
  // 800ms di silenzio. Disattivabile a voce ("Coda modalità manuale",
  // "disattiva mani libere") o dal toggle in alto a sinistra dell'header.
  // Persistito in profile.settings.hands_free.
  const handsFree = (profile?.settings as any)?.hands_free !== false; // default true
  const handsFreeRef = useRef(handsFree);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
  // Quando l'utente disattiva via voce mostriamo un toast di conferma breve.
  const [handsFreeToast, setHandsFreeToast] = useState<string | null>(null);
  // === Banner "Dimmi, ti ascolto" ===
  // Mostrato la prima volta che entriamo in passive-listen (sessione hands-free
  // appena partita). Sparisce dopo 3.5s o appena l'utente parla davvero.
  const [listenBanner, setListenBanner] = useState<string | null>(null);
  const firstListenShownRef = useRef(false);
  const listenBannerTimerRef = useRef<any>(null);
  const setHandsFreeMode = useCallback(async (on: boolean) => {
    if (!profile) return;
    const next = {
      ...profile,
      settings: { ...profile.settings, hands_free: on } as any,
    };
    setProfile(next);
    handsFreeRef.current = on;
    // Reset banner state: se riattiviamo dopo essere stati spenti, mostra
    // di nuovo "Dimmi, ti ascolto" al primo avvio.
    if (on) firstListenShownRef.current = false;
    setHandsFreeToast(on ? "Hands-free attivo" : "Modalità manuale — tocca per parlare");
    setTimeout(() => setHandsFreeToast(null), 2500);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  }, [profile]);

  const recRef = useRef<Recorder | null>(null);
  const scrollRef = useRef<FlatList<any>>(null);
  // === FIRST-TAP GATE (richiesto utente 2026-05-23) ===
  // Regola: ad ogni cold-start dell'app E ad ogni ritorno dal background,
  // la PRIMA attivazione del microfono deve essere fatta a mano (tap
  // sull'orb). Solo DOPO la prima interazione manuale dell'utente in
  // questa "sessione foreground", il loop hands-free riparte da solo.
  //
  // Motivo: l'auto-mic-open immediato al cold start spesso incappava in
  // una sessione AVAudioSession iOS "incantata" (specie dopo lunghi
  // background), causando l'orb bloccato sul verde/tiffany e mic morto.
  // Con il primo tap esplicito siamo certi che l'utente è presente, il
  // sistema audio è "caldo" e tutto parte pulito.
  const userInteractedRef = useRef<boolean>(false);
  // Pager horizontale: pagina 0 = voce zen, pagina 1 = lettura.
  const pagerRef = useRef<ScrollView>(null);
  // Refs ai veri elementi UI della pagina voce — usati dal Tour guidato per
  // misurare le coordinate REALI (measureInWindow) invece di calcolarle a
  // mano (che risultavano decentrate). Vedi buildTourSteps.
  const handsFreeBtnRef = useRef<any>(null);
  const menuBtnRef = useRef<any>(null);
  const confessionaleBtnRef = useRef<any>(null);
  const orbBtnRef = useRef<any>(null);
  const scrollHintRef = useRef<any>(null);
  const [viewMode, setViewMode] = useState<"voice" | "reading">("voice");
  const dimensions = useWindowDimensions();
  // Use window width with sensible fallback (Dimensions.get) for first render
  const windowWidth = dimensions.width || Dimensions.get("window").width || 390;
  // === Keyboard height tracking (richiesta utente 2026-06) ===
  // Su iOS, anche con KeyboardAvoidingView, una `bottomBar` con
  // position:"absolute" non si solleva automaticamente quando la tastiera
  // appare. Teniamo un piccolo stato `kbHeight` aggiornato dagli eventi
  // nativi, e lo aggiungiamo come marginBottom alla bottomBar in modo che
  // l'input rimanga sempre visibile sopra la tastiera.
  const [kbHeight, setKbHeight] = useState<number>(0);
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvt, (e) => {
      const h = e?.endCoordinates?.height ?? 0;
      setKbHeight(h);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const pulse = useRef(new Animated.Value(1)).current;
  // === AURORA: ciclo neon infinito (richiesta utente 2026-06) ===
  // Quando il tema è "giorno" (label "Aurora"), interpoliamo il
  // backgroundColor attraverso 5 tinte neon notturne in un loop di
  // 5 minuti per ciclo, completamente liscio (linear easing, no step).
  // L'animazione gira sempre — non spreca CPU rilevabile (1 interpola-
  // zione di colore per frame sul JS thread).
  const auroraAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (theme.name !== "giorno") return;
    auroraAnim.setValue(0);
    const loop = Animated.loop(
      Animated.timing(auroraAnim, {
        toValue: 1,
        duration: 300000, // 5 minuti per ciclo completo
        easing: Easing.linear,
        useNativeDriver: false, // color interpolation richiede JS
      })
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [theme.name, auroraAnim]);
  // Colori Aurora — sequenza dei colori dell'AURORA BOREALE (richiesta
  // utente 2026-06). Verde dominante (il colore signature dell'aurora
  // reale, dovuto all'ossigeno), turchese, blu acqua, viola e magenta
  // rari ma straordinari. Loop infinito che simula una vera danza
  // dell'aurora nel cielo notturno.
  // Sequenza: Verde lime → Verde menta → Turchese → Blu acqua →
  //           Viola elettrico → Magenta → Verde lime (loop)
  const auroraBg = auroraAnim.interpolate({
    inputRange: [0, 0.166, 0.333, 0.5, 0.666, 0.833, 1],
    outputRange: [
      "#39FF14", // 1. Verde lime — aurora classica (ossigeno)
      "#7CFC00", // 2. Verde menta — aurora pulsante
      "#40E0D0", // 3. Turchese — aurora "alta atmosfera"
      "#00B7EB", // 4. Blu acqua — bordi dei pennelli aurorali
      "#9B30FF", // 5. Viola elettrico — aurora rara (azoto)
      "#FF1493", // 6. Magenta rosa — aurora rosa (rarissima)
      "#39FF14", // ritorno al verde → loop senza scalino
    ],
  });
  const breathe = useRef(new Animated.Value(0)).current;
  // Live meter value (dB) shown as debug visualization during recording
  const [meterDb, setMeterDb] = useState<number | null>(null);
  const [meterThreshold, setMeterThreshold] = useState<number | null>(null);

  // Initial load
  useEffect(() => {
    // === FIX 2026-07: caricamento RESILIENTE con timeout e retry ===
    // PRIMA: profile e timeline erano in serie senza timeout. Se la rete iOS
    // al cold start era lenta (DNS pigro), getProfile poteva bloccarsi per
    // MINUTI → la timeline non veniva mai caricata → "messaggi non caricati".
    // ORA: profile e timeline INDIPENDENTI, ciascuno con timeout 4s e retry
    // automatico. Se rete non risponde, riprova ogni 3s in background fino
    // a successo. L'app mostra UI subito, i dati arrivano appena possibile.
    let cancelled = false;

    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), ms)
        ),
      ]);

    const loadProfile = async () => {
      let attempt = 0;
      while (!cancelled) {
        try {
          const p = await withTimeout(api.getProfile(), 4000);
          if (cancelled) return;
          setProfile(p);
          // CACHE: salva il profile aggiornato sul filesystem locale
          // (cold start prossimo = UI istantanea)
          saveProfileCache(p).catch(() => {});
          const tName = (p.settings?.theme as ThemeName) || "notte";
          if (tName !== themeName) setThemeName(tName);
          if (
            typeof p.settings?.day_start_hour === "number" ||
            typeof p.settings?.night_start_hour === "number"
          ) {
            setHours(p.settings?.day_start_hour ?? 7, p.settings?.night_start_hour ?? 20);
          }
          if (p.settings?.tts_voice_id) {
            setDefaultVoiceId(p.settings.tts_voice_id);
            // Precarica il pool di filler per questa voce (one-shot, in
            // background). Fa SÌ che quando l'utente preme l'orb e finisce
            // di parlare, il primo filler suoni IMMEDIATAMENTE da cache
            // locale, senza round-trip al server.
            preloadFillerPool(
              p.settings.tts_voice_id,
              process.env.EXPO_PUBLIC_BACKEND_URL || ""
            ).catch(() => {});
          }
          if (!p.onboarded) setShowOnboarding(true);
          else if (p.settings?.input_mode !== "text") {
            prewarmMic().catch(() => {});
          }
          return; // success
        } catch (e) {
          attempt++;
          if (attempt > 30) return; // giveup dopo ~90s
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };

    const loadTimeline = async () => {
      let attempt = 0;
      while (!cancelled) {
        try {
          const t = await withTimeout(api.getTimeline(200), 5000);
          if (cancelled) return;
          setTimeline(t);
          // CACHE: salva la timeline aggiornata (esclude entries fortezza)
          saveTimelineCache(t).catch(() => {});
          return; // success
        } catch (e) {
          attempt++;
          if (attempt > 30) return; // giveup dopo ~90s
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };

    // === COLD START FAST-PATH (cache locale) ===
    // Prima del network, leggi la cache locale e popola lo stato così
    // l'utente vede SUBITO nome, sfondo e ultimi messaggi anche se il
    // backend è lento o addormentato. La race è gestita: se il network
    // torna prima della cache, vince il network e non sovrascriviamo.
    const fastPathHydrate = async () => {
      try {
        const [cachedProfile, cachedTimeline] = await Promise.all([
          loadProfileCache<Profile>(),
          loadTimelineCache<TimelineEntry>(),
        ]);
        if (cancelled) return;
        // Hydrate SOLO se non abbiamo già dati freschi dal network
        if (cachedProfile) {
          setProfile((current) => (current ? current : cachedProfile));
          const tName = (cachedProfile.settings?.theme as ThemeName) || "notte";
          setThemeName((cur) => (cur === tName ? cur : tName));
        }
        if (cachedTimeline && cachedTimeline.length > 0) {
          setTimeline((current) => (current.length > 0 ? current : cachedTimeline));
        }
      } catch {
        // ignore: cache best-effort
      }
    };

    // Lancia in PARALLELO: il timeline NON aspetta più il profile.
    // Fast-path cache parte per primo per UI istantanea.
    fastPathHydrate();
    loadProfile();
    loadTimeline();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === APP STATE LIFECYCLE ===
  // Quando l'utente mette l'app in background per un po' (telefonata,
  // home, app switcher) e poi torna, iOS spesso rilascia la sessione
  // audio. Lo stato React però rimane com'era → utente vede vecchi
  // errori ("Errore nella trascrizione" persistente) e il microfono
  // sembra "morto" perché recRef punta a un registratore ormai invalido.
  //
  // Doppio fix:
  // (A) BACKGROUND / INACTIVE → ferma subito eventuale registrazione,
  //     resetta il flag "ho interagito" così al ritorno il loop
  //     hands-free NON parte automaticamente (richiede tap esplicito).
  // (B) ACTIVE (ritorno) → pulisce errori vecchi, recRef fantasma,
  //     forza status a idle per il prossimo tap.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "inactive") {
        // App va in background: ferma TUTTO subito.
        userInteractedRef.current = false;
        if (recRef.current) {
          try { recRef.current.cancel?.(); } catch {}
          recRef.current = null;
        }
        try { SpeechMod.stop(); } catch {}
      } else if (next === "active") {
        // === FIX 2026-06-27 RESUME COLD ===
        // Quando l'app torna foreground DOPO essere stata in background
        // (anche solo 1-2 minuti), iOS sospende: AVAudioSession scollegata,
        // network reset, eventuali update in DB non sincronizzati.
        // Sintomi osservati dall'utente: "apro dopo qualche tempo e non
        // registra + schermata scrittura senza conversazione caricata".
        // Soluzione: al ritorno facciamo TRE cose chirurgiche:
        //   1. prewarmMic() → riattiva audio session iOS
        //   2. refresh timeline → niente schermata vuota
        //   3. refresh profile → cattura eventuali cambi (settings, memoria)
        setError(null);
        if (recRef.current) {
          try { recRef.current.cancel?.(); } catch {}
          recRef.current = null;
        }
        setStatus("idle");
        // Audio session warm-up (async, fire-and-forget — non blocchiamo UI).
        (async () => {
          try {
            await prewarmMic();
          } catch (e) {
            console.warn("[resume] prewarmMic failed:", e);
          }
        })();
        // Timeline + profile refresh in parallelo, non blocking.
        (async () => {
          try {
            const tl = await api.getTimeline(200);
            if (Array.isArray(tl) && tl.length > 0) {
              setTimeline((prev) => {
                // Preserva eventuali entry confessionali locali (ephemeral)
                const localConfessional = prev.filter((e) => e.confessional);
                if (localConfessional.length === 0) return tl;
                const merged = [...tl, ...localConfessional];
                merged.sort(
                  (a, b) =>
                    new Date(a.timestamp).getTime() -
                    new Date(b.timestamp).getTime()
                );
                return merged;
              });
            }
          } catch (e) {
            console.warn("[resume] timeline refresh failed:", e);
          }
        })();
        (async () => {
          try {
            const p = await api.getProfile();
            // Aggiorna solo se ID matches (evita race con onboarding)
            if (p && p.id) setProfile(p);
          } catch (e) {
            console.warn("[resume] profile refresh failed:", e);
          }
        })();
      }
    });
    return () => {
      try { sub.remove(); } catch {}
    };
  }, []);

  // === FORCE-ON dei comportamenti core (2026-05-25) ===
  // Dopo aver rimosso i 3 toggle dall'UI (AI attiva / Risposta vocale /
  // Modalità conversazione), forziamo questi 3 valori a TRUE al boot.
  // Motivo: prima si "spegnevano" da soli (default backend false, oppure
  // reset memoria li portava a false) → utente vedeva l'app sembrare
  // rotta perché AI non rispondeva, Koda muta, hands-free off.
  // Adesso sono SEMPRE TRUE: l'utente non può più sbagliare.
  useEffect(() => {
    if (!profile?.id) return;
    const s = profile.settings || ({} as any);
    const needs =
      s.ai_enabled !== true ||
      s.voice_response !== true ||
      s.conversation_mode !== true;
    if (!needs) return;
    const next = {
      ...profile,
      settings: {
        ...s,
        ai_enabled: true,
        voice_response: true,
        conversation_mode: true,
      },
    };
    setProfile(next);
    api.updateProfile({ settings: next.settings } as any).catch(() => {});
  }, [profile?.id]);


  // === KEEP SCREEN AWAKE durante conversazione attiva ===
  // Quando lo schermo iPhone si auto-spegne mentre Koda sta parlando o
  // mentre stiamo registrando, iOS interrompe l'audio session → la voce
  // viene tagliata a metà frase. Per evitarlo, teniamo lo schermo sveglio
  // SOLO quando lo stato è attivo (recording / transcribing / thinking /
  // speaking). Quando torna idle (champagne), rilasciamo il lock così la
  // batteria non si scarica e iOS torna a comportarsi normalmente.
  //
  // Tag dedicato "koda-conversation" così se in futuro vorremo altri lock
  // (es. confessionale) sono indipendenti.
  useEffect(() => {
    // expo-keep-awake è buggato su web: chiamare deactivate senza prima
    // un activate andato a buon fine throwa sync. Su mobile native funziona
    // perfettamente. Skip totale su web per evitare crash della preview.
    if (Platform.OS === "web") return;
    const TAG = "koda-conversation";
    const isActive = status === "recording" || status === "transcribing" ||
                     status === "thinking" || status === "speaking" ||
                     confessionalMode;
    try {
      if (isActive) {
        activateKeepAwakeAsync(TAG).catch(() => {});
      } else {
        try { deactivateKeepAwake(TAG); } catch {}
      }
    } catch {}
    return () => {
      try { deactivateKeepAwake(TAG); } catch {}
    };
  }, [status, confessionalMode]);

  const saveTheme = async (name: ThemeName) => {
    if (!profile) return;
    setThemeName(name);
    const next = { ...profile, settings: { ...profile.settings, theme: name } };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  // === AVATAR: Eclissi vs Specchio d'acqua (richiesta utente 2026-06) ===
  // Persistito in profile.settings.avatar. Default: "eclipse" (la
  // signature storica). "mirror" = nuovo specchio d'acqua scuro.
  const avatar: "eclipse" | "mirror" =
    (profile?.settings as any)?.avatar === "mirror" ? "mirror" : "eclipse";
  const saveAvatar = async (next: "eclipse" | "mirror") => {
    if (!profile) return;
    const updated = {
      ...profile,
      settings: { ...profile.settings, avatar: next } as any,
    };
    setProfile(updated);
    try {
      await api.updateProfile({ settings: updated.settings } as any);
    } catch {}
  };

  const saveHours = async (d: number, n: number) => {
    if (!profile) return;
    setHours(d, n);
    const next = {
      ...profile,
      settings: { ...profile.settings, day_start_hour: d, night_start_hour: n },
    };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  const saveBackground = async (value: string | null) => {
    if (!profile) return;
    const next = {
      ...profile,
      settings: { ...profile.settings, background: value } as any,
    };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  const saveBackgroundDim = async (dim: number) => {
    if (!profile) return;
    const next = {
      ...profile,
      settings: { ...profile.settings, background_dim: dim } as any,
    };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  const pickAiAvatar = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Per scegliere una foto serve il permesso galleria.");
        setTimeout(() => setError(null), 5000);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        base64: true,
        allowsEditing: true,
        aspect: [1, 1],
      });
      if (result.canceled || !result.assets?.[0]) return;
      const a = result.assets[0];
      let dataUri: string | null = null;
      if (a.base64) {
        const mime = a.mimeType || (a.uri.endsWith(".png") ? "image/png" : "image/jpeg");
        dataUri = `data:${mime};base64,${a.base64}`;
      } else if (a.uri) {
        dataUri = a.uri;
      }
      if (dataUri && profile) {
        const next = { ...profile, settings: { ...profile.settings, ai_avatar: dataUri } as any };
        setProfile(next);
        try { await api.updateProfile({ settings: next.settings } as any); } catch {}
      }
    } catch {
      setError("Non sono riuscito a caricare la foto.");
      setTimeout(() => setError(null), 4000);
    }
  };

  const removeAiAvatar = async () => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, ai_avatar: null } as any };
    setProfile(next);
    try { await api.updateProfile({ settings: next.settings } as any); } catch {}
  };

  const setBubbleColor = async (key: string) => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, bubble_color: key } as any };
    setProfile(next);
    try { await api.updateProfile({ settings: next.settings } as any); } catch {}
  };

  const setBubbleStyle = async (style: "glass" | "solid") => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, bubble_style: style } as any };
    setProfile(next);
    try { await api.updateProfile({ settings: next.settings } as any); } catch {}
  };

  const setTextSize = async (size: number) => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, text_size: size } as any };
    setProfile(next);
    try { await api.updateProfile({ settings: next.settings } as any); } catch {}
  };

  const pickBackgroundFromGallery = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Per scegliere una foto serve il permesso galleria.");
        setTimeout(() => setError(null), 5000);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.6,
        base64: true,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const a = result.assets[0];
      // Prefer base64 (works cross-platform, persisted via API). Fallback to local URI on web.
      let dataUri: string | null = null;
      if (a.base64) {
        const mime = a.mimeType || (a.uri.endsWith(".png") ? "image/png" : "image/jpeg");
        dataUri = `data:${mime};base64,${a.base64}`;
      } else if (a.uri) {
        dataUri = a.uri;
      }
      if (dataUri) {
        await saveBackground(dataUri);
      }
    } catch (e: any) {
      setError("Non sono riuscito a caricare la foto.");
      setTimeout(() => setError(null), 4000);
    }
  };

  const sendTestNotification = async () => {
    const when = new Date(Date.now() + 10000);
    const id = await scheduleAt({
      when,
      title: "🔔 Taccuino — test",
      body: "Se senti questa, le notifiche funzionano!",
    });
    if (id) {
      setError("Notifica di prova fra 10 secondi 🔔");
    } else {
      setError("Permesso notifiche negato. Abilitalo nelle impostazioni del telefono.");
    }
    setTimeout(() => setError(null), 5000);
  };

  // Gentle continuous breathing — always active, feels alive
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 2600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: 2600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  // Pulse animation for the big button
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (status === "recording" || status === "thinking" || status === "speaking") {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1.15,
            duration: 700,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 700,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    } else {
      pulse.setValue(1);
    }
    return () => {
      if (loop) loop.stop();
    };
  }, [status, pulse]);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    setTimeout(() => {
      try {
        scrollRef.current?.scrollToEnd({ animated: true });
      } catch {}
    }, 80);
  }, [timeline.length]);

  // === STATE WATCHDOG ===
  // Se la macchina a stati rimane in recording/transcribing/thinking/speaking
  // per più del massimo ragionevole, la ripristiniamo. CRITICO: in stato
  // "recording" NON scartiamo l'audio — chiamiamo stopTalk() che lo
  // processa via Whisper. Senza questa logica il watchdog faceva sembrare
  // che l'AI "non rispondesse mai" (audio buttato via).
  useEffect(() => {
    if (status === "idle") return;
    const max: Record<string, number> = {
      // 90s recording: con expo-audio (nuova architettura SharedObject) il
      // mic non si "incolla" più, quindi possiamo permettere monologhi lunghi
      // senza il timeout aggressivo di 18s che spezzava le frasi a metà.
      // 90s è abbastanza per qualsiasi turno realistico; oltre, è verosimile
      // un bug e preferiamo comunque processare l'audio raccolto piuttosto
      // che scartarlo.
      recording: 90_000,
      transcribing: 25_000, // 25s STT max
      thinking: 25_000,     // 25s LLM max (con web search)
      speaking: 60_000,     // 60s playback max (lunghi)
    };
    const ms = max[status] || 30_000;
    const t = setTimeout(async () => {
      console.warn(`[watchdog] status '${status}' stuck for ${ms}ms`);
      if (status === "recording" && recRef.current) {
        // FIX: NON scartiamo l'audio. Lo processiamo via stopTalk → Whisper.
        // L'utente avrà o una risposta vera, o un feedback "Non ti ho sentito"
        // — mai un buco di silenzio che fa pensare "l'app non funziona".
        console.warn(`[watchdog] forcing stopTalk to process audio`);
        try { await stopTalk(); } catch (e) {
          console.warn("[watchdog] stopTalk failed", e);
          setStatus("idle");
        }
        return;
      }
      // Per altri stati (transcribing/thinking/speaking) reset duro:
      try { SpeechMod.stop(); } catch {}
      const cur = recRef.current;
      if (cur) {
        try {
          await Promise.race([
            cur.stop(),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        } catch {}
        recRef.current = null;
      }
      const wasSpeaking = status === "speaking";
      setStatus("idle");
      // Mostra l'errore SOLO se siamo rimasti bloccati prima/durante l'elaborazione.
      // Se eravamo in "speaking", il TTS è già stato consegnato all'utente —
      // mostrare "si è bloccato" è un falso positivo che spaventa inutilmente.
      if (!wasSpeaking) {
        setError("Si è bloccato un attimo, riprova pure.");
      }
    }, ms);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // === THINKING SOUND (richiesta utente 2026-06) =====================
  // Quando Koda sta elaborando (transcribing/thinking) parte il jingle
  // "Gentle Pause": 4 note morbide pentatoniche con sottofondo caldo.
  // Utile se l'utente non sta guardando il telefono (altra app, schermo
  // bloccato). Si ferma appena Koda inizia a parlare o torna idle.
  //
  // RICHIESTA 2026-06 (#7) v2: in MODALITÀ SCRITTURA l'utente NON vuole
  // sentire alcun suono. Il problema era che `inputMode` può essere
  // "voice"/"text"/"both"; in "both" l'utente entra nel pannello scrittura
  // (viewMode === "reading") ma inputMode resta "both" → suono partiva.
  // Correzione: usiamo viewMode che riflette davvero LA PAGINA in cui si
  // trova l'utente. Se sta nel pannello reading/chat, niente suono.
  useEffect(() => {
    const isThinking = status === "transcribing" || status === "thinking";
    const userIsInTextScreen = viewMode === "reading" || inputMode === "text";
    if (isThinking && !userIsInTextScreen) {
      startThinkingSound();
    } else {
      stopThinkingSound();
    }
    return () => {
      stopThinkingSound();
    };
  }, [status, inputMode, viewMode]);


  const speakIfEnabled = useCallback(
    async (text: string, tone: TimelineEntry["tone"], opts?: { fromText?: boolean }) => {
      // FIX 2026-07: se la richiesta proviene dalla tastiera (input testo),
      // NON parlare. L'utente probabilmente è in un contesto dove non vuole
      // audio (notte, pubblico). Risponde solo a video.
      if (opts?.fromText) return;
      if (!profile?.settings.voice_response) {
        // PIANO A: auto-reopen del mic disabilitato. L'utente tappa per parlare.
        return;
      }
      const lang = profile?.language || "it";
      const langTag = lang === "it" ? "it-IT" : lang === "en" ? "en-US" : lang;

      // PIANO A: SEMPRE modalità sequenziale push-to-talk.
      // L'AI parla → finisce → torna idle → l'utente tappa per parlare.
      // Il conversation_mode hands-free è disabilitato (causa di freeze su iOS).
      // Arriverà nella Fase 4 con Deepgram + dev build.
      setStatus("speaking");
      await SpeechMod.speak(text, { language: langTag, tone });
      setStatus("idle");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile]
  );

  // Execute side-effects requested by the AI (e.g. schedule notifications)
  const runActions = useCallback(async (actions: Action[] | null | undefined) => {
    if (!actions || actions.length === 0) return;
    for (const a of actions) {
      try {
        if (a.type === "schedule_notification" && a.when_iso) {
          const when = new Date(a.when_iso);
          if (isNaN(when.getTime())) continue;
          const id = await scheduleAt({
            when,
            title: a.title || "Promemoria",
            body: a.body || "Hai una cosa da fare",
            id: a.identifier || undefined,
          });
          if (!id) {
            setError(
              "Non riesco a impostare la notifica: serve il permesso 🔔. Aprila dalle impostazioni del telefono."
            );
            setTimeout(() => setError(null), 6000);
          }
        }
        // === CONFIG ACTION (Coda configura se stessa via voce) ===
        else if ((a as any).type === "config") {
          const key = (a as any).key as string;
          const value = (a as any).value;
          if (!key) continue;
          // Mappa key → patch profile
          const patch: any = {};
          if (key === "ai_name" && typeof value === "string") {
            patch.ai_name = value.slice(0, 30);
          } else if (key === "ai_gender" && (value === "m" || value === "f" || value === "n")) {
            patch.ai_gender = value;
          } else if (key === "user_gender" && (value === "m" || value === "f" || value === "n")) {
            patch.user_gender = value;
          } else if (key === "user_name" && typeof value === "string") {
            patch.name = value.slice(0, 30);
          } else if (key === "brevity" && (value === "short" || value === "detailed")) {
            patch.style_preferences = { ...(profile?.style_preferences || {}), brevity: value };
          } else if (key === "no_pet_names" && typeof value === "boolean") {
            patch.style_preferences = { ...(profile?.style_preferences || {}), no_pet_names: value };
          } else if (key === "speech_speed" && (value === "slow" || value === "fast" || value === "normal")) {
            patch.style_preferences = { ...(profile?.style_preferences || {}), speech_speed: value };
          } else if (key === "tone_pref" && typeof value === "string") {
            patch.style_preferences = { ...(profile?.style_preferences || {}), tone_pref: value };
          } else if (key === "confessional" && typeof value === "boolean") {
            // Manifesto V1: nessuna Parola Segreta, ingresso libero.
            if (!value && confessionalGhostTokenRef.current) {
              api.confessionalReset(confessionalGhostTokenRef.current).catch(() => {});
              confessionalGhostTokenRef.current = null;
            }
            setConfessionalMode(value);
          } else if (key === "notifications" && typeof value === "boolean") {
            patch.settings = { ...(profile?.settings || {}), notifications_enabled: value };
            if (!value) {
              try { await cancelAllCheckins(); } catch {}
            }
          } else if (key === "checkin_morning" && typeof value === "string") {
            patch.settings = { ...(profile?.settings || {}), checkin_morning: value };
          } else if (key === "checkin_evening" && typeof value === "string") {
            patch.settings = { ...(profile?.settings || {}), checkin_evening: value };
          } else if (key === "summary_freq" && typeof value === "string") {
            patch.settings = { ...(profile?.settings || {}), summary_freq: value };
          } else if (key === "theme" && typeof value === "string") {
            // Mapping legacy: se Claude ritorna i vecchi alias inglesi,
            // li traduciamo nei nomi italiani veri usati dal ThemeProvider.
            const themeAlias: Record<string, ThemeName> = {
              dark: "notte",
              scuro: "notte",
              notte: "notte",
              light: "giorno",
              chiaro: "giorno",
              giorno: "giorno",
              zen: "sistema",
              sistema: "sistema",
              automatico: "sistema",
              auto: "sistema", // === FIX giugno 2026: "Auto" ora = sistema (segue iOS)
              "auto-orario": "sistema", // alias legacy → "sistema"
              cielo: "cielo",
              azzurro: "cielo",
              bosco: "bosco",
              verde: "bosco",
              ciliegia: "ciliegia",
              rosa: "ciliegia",
            };
            const mapped = themeAlias[value.toLowerCase()] || (value as ThemeName);
            patch.settings = { ...(profile?.settings || {}), theme: mapped };
            // CRITICO: applichiamo subito il tema al ThemeProvider locale
            // altrimenti il salvataggio nel DB non si vede mai a schermo.
            try { setThemeName(mapped as ThemeName); } catch {}
          } else if ((key === "color_recording" || key === "color_speaking" || key === "color_thinking" || key === "color_idle") && typeof value === "string") {
            // Salva il colore dello stato nella mappa profile.style_preferences.palette
            const stateKey = key.replace("color_", ""); // "recording" | "speaking" | ...
            const hex = value.startsWith("#") ? value : (NAMED_COLORS[value.toLowerCase()] || null);
            if (hex) {
              const currentPal = (profile?.style_preferences || {})?.palette || {};
              patch.style_preferences = {
                ...(profile?.style_preferences || {}),
                palette: { ...currentPal, [stateKey]: hex },
              };
            }
          } else if (key === "ghost_last" && value === true) {
            // Ghost the last user message (recent one in timeline)
            const lastUser = [...timeline].reverse().find((e) => e.role === "user");
            if (lastUser?.id && !lastUser.id.startsWith("local-")) {
              try {
                await api.ghost(lastUser.id);
                setTimeline((prev) => prev.filter((e) => e.id !== lastUser.id));
              } catch (e) { console.warn("ghost last failed", e); }
            }
          } else if (key === "ghost_topic" && typeof value === "string") {
            // Server-side topic ghost (richiede endpoint /ghost?topic=...)
            // Per ora: best-effort, rimuove dal memory_summary lato server
            try {
              await fetch(`${API_BASE}/ghost/topic`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ topic: value }),
              });
            } catch (e) { console.warn("ghost topic failed", e); }
          } else if (key === "reset_history" && value === "CONFIRMED") {
            try {
              await fetch(`${API_BASE}/reset_history`, { method: "POST" });
              setTimeline([]);
            } catch (e) { console.warn("reset history failed", e); }
          } else if (key === "list_voices" && value === true) {
            setShowVoicePicker(true);
          }
          // Applica la patch al profilo se c'è qualcosa
          if (Object.keys(patch).length > 0) {
            try {
              const updated = await api.updateProfile(patch);
              setProfile(updated);
            } catch (e) { console.warn("config patch failed", e); }
          }
        }
      } catch (e) {
        console.warn("action exec error", e);
      }
    }
  }, [profile, hasSeal, timeline]);

  // === HANDS-FREE AUTO-LISTEN LOOP ===
  // Quando hands-free è attivo e siamo in idle (Coda ha finito di parlare
  // o è appena partita l'app), riapri automaticamente il microfono dopo
  // una breve pausa di respiro (350ms). Il VAD interno chiuderà il mic
  // da solo dopo 800ms di silenzio.
  //
  // GUARDIE per NON aprire il mic:
  //   - modale di onboarding/KodaIntro/SealSetup aperto
  //   - input_mode forzato a "text"
  //   - confessionale in attesa di sblocco
  //   - registratore già attivo
  //   - error visibile (l'utente sta leggendo un feedback)
  useEffect(() => {
    if (!handsFree) return;
    // === FIRST-TAP GATE ===
    // Il loop hands-free non parte FINCHÉ l'utente non ha toccato l'orb
    // almeno una volta in questa sessione foreground. Questo elimina
    // tutta una serie di problemi di sessione audio iOS al cold-start
    // / ritorno dal background. Vedi commenti su `userInteractedRef`.
    if (!userInteractedRef.current) return;
    if (status !== "idle") return;
    if (!profile) return;
    if (showOnboarding) return;
    // CRITICAL: showColorIntro può essere `null` (in fase di caricamento da
    // SecureStore). Se attivassimo il mic in quei millisecondi, l'audio
    // session iOS andrebbe in "recording" e poi quando KodaIntro vuole
    // parlare il TTS resta muto. Aspettiamo esplicitamente `false`.
    if (showColorIntro !== false) return;
    if (tourActive) return; // niente mic durante il tour visivo
    if (showSealSetup) return;
    if (sealUnlocking) return;
    if (showSettings) return;
    if (profile.settings?.input_mode === "text") return;
    if (recRef.current) return;
    // breve pausa di respiro per evitare di registrare la coda del TTS
    // e per dare al sistema audio iOS il tempo di switchare la sessione.
    const t = setTimeout(() => {
      if (!handsFreeRef.current) return;
      if (recRef.current) return;
      // CRITICAL: re-check tourActive in closure. Senza questo, nel piccolo
      // gap fra "KodaIntro chiusa" e "tourActive=true" il setTimeout era
      // già stato schedulato e apriva il mic durante il tour.
      if (tourActiveRef.current) return;
      // Re-check status in closure
      startTalkInternal(true).catch(() => {});
    }, 450);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, handsFree, profile?.id, showOnboarding, showColorIntro, showSealSetup, sealUnlocking, showSettings, tourActive]);

  const sendText = useCallback(
    async (text: string, opts?: { fromText?: boolean }) => {
      // FIX 2026-07: se l'utente sta SCRIVENDO (input da tastiera),
      // Koda risponde anche lei SOLO IN TESTO — niente TTS.
      // Motivo: se l'utente scrive, è probabile in contesto pubblico/notte
      // dove non può/vuole parlare ad alta voce → Koda fa lo stesso.
      const fromText = !!opts?.fromText;
      const txt = text.trim();
      if (!txt) return;
      setError(null);

      // === FREEMIUM GATE DISABILITATO (richiesta utente giugno 2026) ========
      // L'utente non ha ancora collegato RevenueCat, quindi il redirect al
      // paywall lo bloccherebbe impedendogli di provare l'app. Il gate è
      // disattivato: il counter "messaggi di prova" resta visibile, ma non
      // blocca mai. Riattivare quando RevenueCat sarà integrato.
      const isFortezzaTurn = !!confessionalMode;
      // (gate al paywall volutamente rimosso)

      // === SAFETY PRE-FLIGHT (giugno 2026) ===================================
      // SOLO per chat normale (non Confessionale: in Confessionale la regola
      // è "tutto svanisce", quindi safety è gestito dentro lo stesso flusso
      // sealed con prompt injection). Per la chat normale facciamo check
      // BLOCCANTE: se rischio rilevato, NON inviamo nulla a /converse e
      // mostriamo SafetyAlert.
      if (!isFortezzaTurn) {
        try {
          const sc = await api.safetyCheck(txt, false);
          if (sc.risk_detected) {
            setSafetyResult(sc);
            setSafetyVisible(true);
            return; // STOP: niente invio a Claude, niente counter increment
          }
        } catch (e) {
          // Safety check fallisce → degradiamo gracefully (continuiamo).
          // Il prompt injection lato server.py rimane attivo come failsafe.
        }
      }

      // Optimistic: append a local pending entry.
      // CONFESSIONALE = FORTEZZA: sempre attivo quando confessional mode è ON.
      // Nessun toggle, nessuna opzione → privacy massima by design.
      const isFortezza = !!confessionalMode;
      const optimistic: TimelineEntry = {
        id: `local-${Date.now()}`,
        role: "user",
        text: txt,
        timestamp: new Date().toISOString(),
        confessional: confessionalMode || undefined,
        fortezza: isFortezza || undefined,
      };
      setTimeline((prev) => [...prev, optimistic]);
      setStatus("thinking");
      try {
        // === CONFESSIONALE FORTEZZA (Zero-Knowledge) ===
        // Se attivo: classifica emozione ON-DEVICE, manda solo il codice
        // astratto al server. Il testo grezzo non lascia mai il telefono.
        if (isFortezza) {
          try {
            // === ARCHITETTURA "DOPPIA STANZA" (2026-06) ===
            // Stanza B = Confessionale Ghost:
            //  - genera un GHOST TOKEN anonimo per la sessione (UUID locale,
            //    NON contiene l'ID utente)
            //  - manda al server il TESTO + intent_hint + intensity_hint +
            //    ghost_token (firma anonima)
            //  - il server NON salva, NON logga il contenuto, NON memorizza
            //  - Claude vede il testo per dare risposta calda e contestuale
            //    ma vede solo l'UUID anonimo (zero linkage all'identità)
            //  - all'uscita: wipe locale + token distrutto
            const intent = classifyIntent(txt);
            const { intensity } = classifyEmotion(txt);
            // Genera ghost token al primo turno della sessione (poi riusalo)
            if (!confessionalGhostTokenRef.current) {
              confessionalGhostTokenRef.current =
                `ghost-${Date.now().toString(36)}-${Math.random()
                  .toString(36)
                  .slice(2, 10)}`;
            }
            const ghostToken = confessionalGhostTokenRef.current;
            // FIX 2026-06: marca che la sessione è stata usata (per animazione)
            fortezzaUsedThisSessionRef.current = true;

            const resp = await fetch(`${API_BASE}/converse/confessional`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: txt,
                session_token: ghostToken,
                intent_hint: intent,
                intensity_hint: intensity,
                language: profile?.language || "it",
                ai_name: profile?.ai_name || "Koda",
                ai_gender: profile?.ai_gender || "f",
              }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const reply = (data.reply || "Sono qui.").trim();
            const tone = (data.tone === "calm" ? "neutral" : "warm") as TimelineEntry["tone"];
            const aiEntry: TimelineEntry = {
              id: `local-fortezza-${Date.now()}`,
              role: "ai",
              text: reply,
              timestamp: new Date().toISOString(),
              confessional: true,
              fortezza: true,
              tone,
            };
            setTimeline((prev) => [...prev, aiEntry]);
            setStatus("idle");
            // TTS solo se non sta scrivendo.
            // FIX 2026-06: TTS isolato in proprio try/catch così se la
            // sintesi vocale fallisce (rete, ElevenLabs flaky, audio
            // session iOS) NON facciamo apparire "Confessionale
            // temporaneamente non disponibile" all'utente. Il messaggio
            // è già in timeline, la conversazione è andata bene.
            if (!fromText) {
              try {
                await speakIfEnabled(reply, tone, { fromText });
              } catch (ttsErr) {
                // log silenzioso, non bloccare la UX
                console.warn("[fortezza] TTS error (non-fatal):", ttsErr);
              }
            }
          } catch (fErr: any) {
            console.warn("[fortezza] error:", fErr);
            setStatus("idle");
            // Rimuovi user optimistic — l'utente decida se riprovare
            setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
            setError("Confessionale temporaneamente non disponibile.");
            setTimeout(() => setError(null), 4000);
          }
          return; // skip vecchi flow
        }

        // DEBUG TRACE (rimuovibile): manda step al backend così possiamo
        // capire dove si rompe il flow nel build standalone (no console.log).
        // === FIX CRASH SEALED 2026-06-28 NOTTE ===
        // Le chiamate fire-and-forget a /api/dbg-trace creavano
        // contesa nel pool di connessioni iOS NSURLSession (limite ~4-6
        // connessioni per host). Quando la risposta di /converse/sealed
        // arrivava da Cloudflare con Set-Cookie HTTP/2, iOS crashava
        // NATIVAMENTE nel cookie handler PRIMA di bridgare la risposta
        // a JavaScript (per questo i catch JS non scattavano).
        // SOLUZIONE: in produzione le trace sono NO-OP. In dev restano
        // per diagnostica futura.
        const _trace = (step: string, extra?: string) => {
          if (!__DEV__) return;
          try {
            fetch(`${API_BASE}/dbg-trace`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ step, extra: extra ?? "" }),
            }).catch(() => {});
          } catch {}
        };
        // === SEALED FLOW (Zero-Knowledge Confessionale) ===
        // Se siamo in confessionale e l'utente ha impostato la Parola Segreta,
        // cifriamo il messaggio CLIENT-SIDE e chiamiamo /converse/sealed.
        if (confessionalMode && hasSeal) {
          _trace("sealed-1-start", `txt_len=${txt.length}`);
          const key = await getSessionKey({ biometric: true });
          _trace("sealed-2-key", key ? "ok" : "null");
          if (!key) {
            throw new Error("Parola Segreta non sbloccata");
          }
          const sealed = await sealText(txt, key);
          _trace("sealed-3-seal-msg", `ct_len=${sealed.ciphertext.length}`);

          // === MEMORIA CONFESSIONALE DISABILITATA TEMPORANEAMENTE ===
          // FIX CRASH TURN 2 — 2026-06-28 NOTTE:
          // Sul secondo turn del confessionale l'app crashava in fase
          // "pensa" PRIMA del POST. Cause concrete:
          //  - 14+ entry decrittate in timeline (BG task da turn 1)
          //  - audio TTS buffers ancora in RAM
          //  - audio recording buffer del turn 2
          //  - JSON.stringify priorConfessional + sealText (5-10KB)
          // Tutto insieme → iOS killa per memory pressure.
          //
          // Decisione condivisa con l'utente: "lascia perdere la memoria
          // pregressa, basta che funzioni da adesso in poi".
          // Quindi: NON carichiamo la history dal vault, NON inviamo
          // priorConfessional al backend. Ogni turn è isolato.
          // Pro: zero accumulo di stato, niente crash memory-pressure.
          // Contro: Koda non ricorda i confessional precedenti.
          //
          // In futuro: rifare lazy + paginato + senza setTimeline gigante.
          if (!confessionalHistoryLoadedRef.current) {
            confessionalHistoryLoadedRef.current = true;
            _trace("sealed-4-hist-disabled");
          }

          // Raccogli i turni confessionali precedenti (ora include anche
          // quelli appena scaricati dal backend) — Koda li riceve come
          // 'CONTESTO SIGILLATO' cifrato.
          const priorConfessional = timeline
            .filter((e) => e.confessional && e.id !== optimistic.id && e.text)
            .map((e) => ({ role: e.role, text: e.text }));
          _trace("sealed-7-prior-collected", `n=${priorConfessional.length}`);
          let history_nonce: string | undefined;
          let history_ciphertext: string | undefined;
          if (priorConfessional.length > 0) {
            try {
              const histJson = JSON.stringify(priorConfessional.slice(-20));
              _trace("sealed-8-hist-stringified", `bytes=${histJson.length}`);
              const sealedHist = await sealText(histJson, key);
              _trace("sealed-9-hist-sealed", `ct=${sealedHist.ciphertext.length}`);
              history_nonce = sealedHist.nonce;
              history_ciphertext = sealedHist.ciphertext;
            } catch (e) {
              _trace("sealed-9-hist-seal-error", String(e).slice(0, 100));
              // Se la cifratura della history fallisce, andiamo avanti
              // senza — meglio un confessionale senza memoria che un
              // errore bloccante.
              console.warn("[sealed] history encrypt failed:", e);
            }
          }
          _trace("sealed-10-about-to-post");
          let resp: { nonce: string; ciphertext: string; tone: string };
          let keyB64: string;
          try {
            keyB64 = keyToBase64(key);
            _trace("sealed-10a-key-b64-ok", `len=${keyB64.length}`);
          } catch (kbErr: any) {
            _trace("sealed-10a-key-b64-err", String(kbErr).slice(0, 100));
            setStatus("idle");
            setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
            return;
          }
          try {
            _trace("sealed-10b-pre-fetch");
            resp = await api.converseSealed(
              {
                nonce: sealed.nonce,
                ciphertext: sealed.ciphertext,
                language: profile?.language || "it",
                ai_name: profile?.ai_name || "Coda",
                ai_gender: profile?.ai_gender || "f",
                user_gender: profile?.user_gender || "n",
                history_nonce,
                history_ciphertext,
              },
              keyB64
            );
            _trace("sealed-11-resp-ok", `nonce_len=${resp.nonce?.length || 0}`);
          } catch (postErr: any) {
            _trace("sealed-11-post-error", String(postErr).slice(0, 150));
            console.warn("[sealed] POST failed:", postErr);
            setStatus("idle");
            setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
            setError("Confessionale: rete bloccata. Riprova tra un attimo.");
            setTimeout(() => setError(null), 5000);
            return;
          }
          // Decifra la risposta lato client
          const reply = unsealText({ nonce: resp.nonce, ciphertext: resp.ciphertext }, key) || "";
          // Strip audio tags per chat display (regex rapido)
          const clean = reply.replace(/\[[a-zA-Zàèéìòùç '_,/-]{1,40}\]/g, "").replace(/  +/g, " ").trim();
          const aiEntry: TimelineEntry = {
            id: `sealed-${Date.now()}`,
            role: "ai",
            text: clean || "(silenzio sigillato)",
            voice_text: reply,
            tone: (resp.tone as Tone) || "warm",
            timestamp: new Date().toISOString(),
            confessional: true,
          };
          const userEntry: TimelineEntry = {
            ...optimistic,
            id: `sealed-u-${Date.now()}`,
            confessional: true,
          };
          setTimeline((prev) => {
            const filtered = prev.filter((e) => e.id !== optimistic.id);
            return [...filtered, userEntry, aiEntry];
          });
          // FIX CRASH CONFESSIONALE 2026-06-28: il crash nativo iOS
          // avveniva ESATTAMENTE QUI — dopo il setTimeline, durante o
          // subito prima di speakIfEnabled. Probabile causa: AVAudioSession
          // ancora in modalità "recording" dal turn appena finito, e il
          // tentativo di playback TTS senza reset esplicito causava un
          // exception nativa non catchabile in JS.
          // Mitigazioni:
          //  (1) piccolo delay (150ms) per lasciar settle iOS
          //  (2) reset esplicito a modalità playback
          //  (3) wrap totale in try/catch così se TTS fallisce, l'app
          //      NON crasha — al massimo non senti la risposta vocale,
          //      ma il testo è già in timeline.
          try {
            await new Promise<void>((r) => setTimeout(r, 150));
            try {
              const { setAudioModeAsync } = await import("expo-audio");
              await setAudioModeAsync({
                allowsRecording: false,
                playsInSilentMode: true,
                shouldPlayInBackground: false,
              } as any);
            } catch {}
            await speakIfEnabled(reply, aiEntry.tone || "warm", { fromText });
          } catch (speakErr) {
            _trace("sealed-speak-error", String(speakErr).slice(0, 100));
            console.warn("[sealed] speak failed (non-fatal):", speakErr);
            setStatus("idle");
          }
          return;
        }
        // === FAST PATH (sub-2s latency) — 2026-06 ===
        // POST /api/converse-fast/start + long-poll → token MP3 statici
        // riprodotti in sequenza. iOS AVPlayer è happy (Content-Length +
        // Range). Time-to-first-audio target: 1.0-1.7s server + ~200ms rete.
        //
        // Funziona sia in normale che in confessionale-soft (ephemeral).
        // Sealed/cifrato passa per il branch sopra (mai per qui).
        const useFastPath = !fromText && (profile?.settings.voice_response !== false);
        if (useFastPath) {
          try {
            // Watchdog: se entro 25s non parte l'audio, abortiamo.
            let speakingStarted = false;
            let watchdogTriggered = false;
            const watchdog = setTimeout(() => {
              if (!speakingStarted) {
                watchdogTriggered = true;
                try { SpeechMod.stop(); } catch {}
                setStatus("idle");
                setError("Koda ci sta mettendo troppo. Riprova tra un attimo.");
                setTimeout(() => setError(null), 4000);
              }
            }, 25000);

            // Cattura immediata del meta per aggiornare la chat appena
            // arriva (di solito poco dopo il primo token audio).
            let capturedMeta: any = null;

            const result = await (async () => {
              // === FASE 1 (giugno 2026): WebSocket OPT-IN tramite env var ===
              // EXPO_PUBLIC_USE_WS_CONVERSE=true → tenta WS; altrimenti
              // HTTP polling diretto (path stabile, comportamento storico).
              //
              // Il WS è disattivato di default finché non confermiamo che
              // wss:// passa attraverso l'infra Emergent / Cloudflare in
              // produzione. Quando fallisce sotto Cloudflare, l'utente
              // aspettava il timeout intero (~25s) prima del fallback.
              //
              // Quando ON: fail-fast a 1.5s. Se entro 1.5s NON arriva
              // almeno un frame dal server, droppiamo il WS e cadiamo
              // immediatamente su HTTP poll (~1.7s totali invece di 25s).
              const useWS = String(process.env.EXPO_PUBLIC_USE_WS_CONVERSE || "").toLowerCase() === "true";
              if (useWS) {
                try {
                  const wsResult = await SpeechMod.fastConverseWS(txt, {
                    ephemeral: confessionalMode,
                    timeoutMs: 1500,
                    onAudioStart: () => {
                      speakingStarted = true;
                      clearTimeout(watchdog);
                      setStatus("speaking");
                    },
                    onMeta: (meta) => {
                      capturedMeta = meta;
                      try {
                        const userFinal: TimelineEntry = {
                          ...optimistic,
                          id: `fast-u-${Date.now()}`,
                          confessional: confessionalMode || undefined,
                        };
                        const aiEntry: TimelineEntry = {
                          id: `fast-ai-${Date.now()}`,
                          role: "ai",
                          text: stripDisplayTags(meta.reply || ""),
                          voice_text: meta.voice_text || undefined,
                          tone: (meta.tone as Tone) || "warm",
                          timestamp: new Date().toISOString(),
                          actions: meta.actions || undefined,
                          confessional: confessionalMode || undefined,
                        };
                        setTimeline((prev) => {
                          const filtered = prev.filter((e) => e.id !== optimistic.id);
                          return [...filtered, userFinal, aiEntry];
                        });
                        if (Array.isArray(meta.actions) && meta.actions.length > 0) {
                          runActions(meta.actions as any[]);
                        }
                      } catch (e) {
                        console.warn("[ws] onMeta handler error:", e);
                      }
                    },
                  });
                  if (wsResult.ok) return wsResult;
                  console.warn("[ws] failed (", wsResult.error, ") → falling back to HTTP poll");
                  if (speakingStarted) return wsResult;
                } catch (e) {
                  console.warn("[ws] exception (", String(e), ") → falling back to HTTP poll");
                }
              }
              // HTTP path (default + fallback)
              return await SpeechMod.fastConverse(txt, {
                ephemeral: confessionalMode,
                onAudioStart: () => {
                  speakingStarted = true;
                  clearTimeout(watchdog);
                  setStatus("speaking");
                },
                onMeta: (meta) => {
                  capturedMeta = meta;
                  try {
                    const userFinal: TimelineEntry = {
                      ...optimistic,
                      id: `fast-u-${Date.now()}`,
                      confessional: confessionalMode || undefined,
                    };
                    const aiEntry: TimelineEntry = {
                      id: `fast-ai-${Date.now()}`,
                      role: "ai",
                      text: stripDisplayTags(meta.reply || ""),
                      voice_text: meta.voice_text || undefined,
                      tone: (meta.tone as Tone) || "warm",
                      timestamp: new Date().toISOString(),
                      actions: meta.actions || undefined,
                      confessional: confessionalMode || undefined,
                    };
                    setTimeline((prev) => {
                      const filtered = prev.filter((e) => e.id !== optimistic.id);
                      return [...filtered, userFinal, aiEntry];
                    });
                    if (Array.isArray(meta.actions) && meta.actions.length > 0) {
                      runActions(meta.actions as any[]);
                    }
                  } catch (e) {
                    console.warn("[fast] onMeta handler error:", e);
                  }
                },
              });
            })();
            clearTimeout(watchdog);
            if (watchdogTriggered) return;
            if (!result.ok) {
              // Fast fallito — vado al flusso standard sotto.
              console.warn("[fast] failed:", result.error, "— falling back to /converse");
              setStatus("thinking");
              // Continua col blocco standard sotto.
            } else {
              // === BUG FIX 2026-06-26 ROOT CAUSE ===
              // PRIMA qui c'era `setProfile(await api.getProfile())` dopo
              // OGNI conversazione per sincronizzare counters/memory_summary
              // dal backend. CONSEGUENZA: setProfile triggera rerender →
              // inputMode (computed da profile) ricomputa → TextInput
              // rimonta perdendo il focus → tastiera si chiude. Inoltre
              // lo scroll listener riceve un evento layout-time che fa
              // snappare il pager a Page 0 (home).
              // Risultato osservato dall'utente: "l'app fa la home a modo
              // suo" + "la pagina della scrittura non scrive".
              // FIX: il profilo NON serve aggiornato dopo ogni turno.
              // Counters/memory si rileggono al prossimo boot o quando
              // l'utente apre Settings. Eliminato il refetch.
              setStatus("idle");
              // === FREEMIUM COUNTER (giugno 2026) ===
              // Incremento SOLO se NON in Confessionale (Confessionale è
              // sempre escluso dal counter — privacy/marketing first).
              if (!isFortezzaTurn) {
                api.freemiumIncrement()
                  .then((s) => setFreemium(s))
                  .catch(() => {});
              }
              return;
            }
          } catch (e: any) {
            console.warn("[fast] threw, falling back:", e);
            setStatus("thinking");
          }
        }
        // === STANDARD FLOW (fallback) ===
        // === STANDARD FLOW (con o senza ephemeral) ===
        const res = await api.converse(txt, undefined, { ephemeral: confessionalMode });
        // Replace optimistic with real, then add AI entry.
        // Se siamo in confessionale, marca le entry come `confessional`
        // così la timeline le filtra/colora correttamente.
        const taggedUser = confessionalMode
          ? { ...res.user_entry, confessional: true }
          : res.user_entry;
        const taggedAi = confessionalMode
          ? { ...res.ai_entry, confessional: true }
          : res.ai_entry;
        setTimeline((prev) => {
          const filtered = prev.filter((e) => e.id !== optimistic.id);
          return [...filtered, taggedUser, taggedAi];
        });
        setProfile(res.profile);
        // Execute any actions (notifications, etc.) requested by the AI
        runActions(taggedAi.actions || []);
        await speakIfEnabled(taggedAi.voice_text || taggedAi.text, taggedAi.tone || "neutral", { fromText });
        // === FREEMIUM COUNTER (standard flow) ===
        if (!isFortezzaTurn) {
          api.freemiumIncrement()
            .then((s) => setFreemium(s))
            .catch(() => {});
        }
      } catch (e: any) {
        const msg = String(e?.message || "");
        if (msg.includes("Parola Segreta")) {
          setError("Parola Segreta non sbloccata. Tocca il lucchetto per riprovare.");
        } else {
          setError("Ops, qualcosa non funziona. Riprova.");
        }
        setStatus("idle");
        // Remove optimistic
        setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
      }
    },
    [speakIfEnabled, runActions, confessionalMode, hasSeal, profile]
  );

  // === CODA CONSAPEVOLE ===
  // Rileva trascrizioni vuote/sospette/allucinazioni di Whisper e fa parlare
  // Coda con frasi varie invece di stallare silenziosamente.
  const emptyTurnsRef = useRef(0); // n. vuoti consecutivi nel loop conversazione
  const lastAwarenessIdx = useRef(-1);

  // Frasi varie per "non ho sentito" — ruotiamo per non sembrare un bot
  const awarenessLinesNoAudio = [
    "[gently] Scusa, non ti ho sentito bene. Puoi ripetere?",
    "[softly] Eh, non ho capito — c'è un po' di rumore qui?",
    "[warmly] Aspetta, riprova — non sono riuscita a sentirti.",
    "[thoughtful] Mmh, ho sentito solo silenzio. Dimmi pure.",
    "[gently] Ti sento appena. Avvicinati o riprova quando puoi.",
  ];
  const awarenessLinesGarbled = [
    "[thoughtful] Ho sentito qualcosa ma non chiaro — puoi ripetere?",
    "[gently] Mi sembra che ci sia rumore. Riprova quando puoi.",
    "[softly] Non sono sicura di aver capito — dimmi di nuovo?",
  ];
  const awarenessLinesPartial = (what: string) => [
    `[thoughtful] Ho sentito solo "${what}" — è quello che hai detto?`,
    `[gently] Mi è arrivato solo "${what}". Era così o ho perso qualcosa?`,
  ];
  const awarenessLoopExit = [
    "[warmly] Sono qui, ma non ti sento. Tocca quando sei pronto.",
    "[gently] Ti aspetto — tocca quando vuoi parlare.",
    "[softly] Resto in attesa. Tocca per riprendere.",
  ];

  function pickLine(lines: string[]): string {
    let idx = Math.floor(Math.random() * lines.length);
    // Evita di ripetere la stessa subito
    if (idx === lastAwarenessIdx.current && lines.length > 1) {
      idx = (idx + 1) % lines.length;
    }
    lastAwarenessIdx.current = idx;
    return lines[idx];
  }

  // Pattern noti di allucinazioni Whisper su audio rumoroso/vuoto
  // SOLO i pattern CHIARAMENTE allucinati. Tutto il resto → manda a Coda.
  const WHISPER_HALLUCINATIONS = [
    /^[\s\.,!?…]*$/,                            // solo punteggiatura/spazi
    /sottotitoli.{0,30}q-?t?-?s?-?s/i,           // "Sottotitoli e revisione a cura di Q-T-S-S"
    /sottotitoli.{0,30}cura di/i,
    /grazie per l'?\s*attenzione/i,
    /grazie per aver guardato/i,
    /^[\s]*\[\s*musica\s*\][\s]*$/i,             // SOLO [musica] da sola
    /^(\.{2,}|…+)$/,                              // solo puntini
  ];

  function classifyTranscript(txt: string): "ok" | "empty" | "garbled" | "partial" {
    const t = (txt || "").trim();
    if (!t) return "empty";
    for (const re of WHISPER_HALLUCINATIONS) {
      if (re.test(t)) return "garbled";
    }
    // SOPPRESSA la classificazione "partial" — anche 1-2 parole brevi sono
    // valide (es: "sì", "no", "okay", "ahah", "mmh sì"). Whisper trascrive
    // solo se ha sentito qualcosa di concreto, e Claude sa gestire input brevi.
    return "ok";
  }

  async function speakAwareness(text: string) {
    // Strip audio tags per chat display
    const clean = text.replace(/\[[a-zA-Zàèéìòùç '_,/-]{1,40}\]/g, "").replace(/  +/g, " ").trim();
    setTimeline((prev) => [
      ...prev,
      {
        id: `aware-${Date.now()}`,
        role: "ai",
        text: clean,
        voice_text: text,
        tone: "warm",
        timestamp: new Date().toISOString(),
      },
    ]);
    setStatus("speaking");
    try {
      await SpeechMod.speak(text, { language: "it-IT", tone: "warm" });
    } catch {}
    setStatus("idle");
  }

  // Push-to-talk (or hands-free)
  const startTalkInternal = async (autoStopOnSilence: boolean) => {
    if (status !== "idle" && status !== "speaking") return;
    setError(null);
    // Reset contatore "vuoti" quando l'utente attiva manualmente (non in loop)
    if (!convActiveRef.current) emptyTurnsRef.current = 0;
    // Unlock speech engine on first user interaction (web only)
    unlockSpeech().catch(() => {});
    try {
      // FIX 4 (RCA): controlliamo `SpeechMod.isSpeaking()` direttamente,
      // non lo stato React (che può essere stantio). Se il TTS sta
      // ancora suonando, NON dobbiamo fermarlo né cambiare l'audio
      // session: la sua naturale conclusione gestirà già la transizione.
      const ttsPlaying = SpeechMod.isSpeaking();
      if (status !== "speaking" && !ttsPlaying) {
        SpeechMod.stop();
      }
      // CRITICAL FREEZE FIX: ensure any leftover audio session is fully
      // released before starting a new recording. Without this, after a
      // few turns the recording fails to start silently and the blob
      // appears "stuck listening".
      if (Platform.OS !== "web" && status !== "speaking" && !ttsPlaying) {
        try {
          const { setAudioModeAsync } = require("expo-audio");
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
            interruptionMode: "duckOthers",
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          });
          await new Promise((r) => setTimeout(r, 30));
        } catch {}
      }
      // === COLD-START GATE (fix 2026-06: "primo messaggio perso") ===
      // RCA documentato: dopo un cold-start (swipe-up kill + riapertura),
      // se l'utente tocca SUBITO l'orb, AudioSession non è ancora
      // completamente inizializzata → il recorder cattura silenzio nei
      // primi 200-500ms → Deepgram restituisce transcript vuoto → tutto
      // si perde silenziosamente.
      // Soluzione: prima di startRecording, attendiamo SINCRONO che
      // prewarmMic() finisca. Se già pronta (campo _nativeReady), il
      // metodo restituisce immediatamente: zero costo nei turni
      // successivi.
      if (Platform.OS !== "web") {
        await prewarmMic();
      }
      const rec = await startRecording();
      recRef.current = rec;
      // Wire live meter for debug visualization
      if (rec.onMeter) {
        rec.onMeter((db: number, threshold?: number | null) => {
          if (recRef.current === rec) {
            setMeterDb(db);
            if (typeof threshold === "number") setMeterThreshold(threshold);
          }
        });
      }
      // PASSIVE LISTEN: in hands-free l'orb mostra subito "recording" appena
      // il mic si apre, così l'utente VEDE che può parlare. Il VAD continua
      // comunque a fare il suo lavoro per fermare la registrazione su
      // silenzio.
      // (Prima il design era: orb idle → recording solo dopo VAD detect.
      // L'utente non sapeva mai se l'app lo stava ascoltando. Vedi log:
      // "perché non si vede quando stai registrando".)
      if (status !== "speaking") setStatus("recording");
      // Mostra il banner "Dimmi, ti ascolto" solo la prima volta che la
      // sessione hands-free parte (al cold start o dopo riattivazione).
      // Sparisce automaticamente dopo 3s o quando l'utente parla davvero.
      // (Prima qui c'era `passiveListen` non dichiarato → ReferenceError
      //  silenziato dal try/catch che a sua volta bloccava il wiring del
      //  VAD onSilence sotto. Ora usiamo la semantica originale:
      //  "siamo in ascolto passivo hands-free" = handsFreeRef + autoStop.)
      const passiveListening = handsFreeRef.current && autoStopOnSilence;
      if (passiveListening && !firstListenShownRef.current) {
        firstListenShownRef.current = true;
        setListenBanner("Dimmi, ti ascolto");
        // auto-dismiss dopo 3.5s
        if (listenBannerTimerRef.current) clearTimeout(listenBannerTimerRef.current);
        listenBannerTimerRef.current = setTimeout(() => {
          setListenBanner(null);
        }, 3500) as any;
      }
      if (autoStopOnSilence && rec.onSilence) {
        rec.onSilence(() => {
          if (recRef.current === rec) stopTalk();
        });
        // ABSOLUTE safety net: if the analyser-based silence detection in
        // voice.ts somehow fails entirely AND its own internal hard cap
        // (60s) doesn't fire either, force-stop after 65s. This is a true
        // last-resort fallback — it should NEVER fire under normal use.
        // (Was 9s, which was way too aggressive and cut users off mid-thought.)
        setTimeout(() => {
          if (recRef.current === rec) {
            stopTalk();
          }
        }, 65000);
      }
      if (rec.onSpeechStart) {
        rec.onSpeechStart(() => {
          // BARGE-IN: user started talking — kill any AI speech immediately
          try { SpeechMod.stop(); } catch {}
          if (recRef.current === rec) setStatus("recording");
          // L'utente ha cominciato a parlare → nascondi il banner subito.
          if (listenBannerTimerRef.current) {
            clearTimeout(listenBannerTimerRef.current);
            listenBannerTimerRef.current = null;
          }
          setListenBanner(null);
        });
      }
    } catch (e) {
      setError("Microfono non disponibile. Controlla i permessi.");
      // Auto-clear dopo 4s: se l'utente riprova, non vede l'errore vecchio.
      setTimeout(() => setError(null), 4000);
    }
  };

  const startTalk = async () => {
    // HANDS-FREE: se attivo, il VAD chiude il mic da solo dopo 800ms di silenzio.
    // In modalità manuale (hands-free off) → tap-to-talk classico.
    return startTalkInternal(handsFreeRef.current);
  };

  const stopTalk = async () => {
    // Use recRef.current as single source of truth (status check would create
    // stale-closure bugs when called from the silence-detection callback)
    const current = recRef.current;
    if (!current) return;
    // FIX 2 (RCA): NON azzeriamo recRef.current PRIMA dell'await.
    // Prima nullavamo subito, ma se current.stop() lancia/blocca, la
    // sessione audio iOS resta in playAndRecord → la prossima registrazione
    // fallisce silenziosamente ("stuck recording" persistente).
    // Lo azzeriamo SOLO dopo che l'unload è andato a buon fine (o fallito
    // in modo controllato — voice.ts in tal caso forza setAudioModeAsync).
    setStatus("transcribing");
    setMeterDb(null);
    setMeterThreshold(null);
    try {
      const res = await current.stop();
      // Ora possiamo liberare il ref: l'audio session è stata rilasciata.
      if (recRef.current === current) recRef.current = null;
      // CRITICAL: switch the audio session out of "recording" mode IMMEDIATELY
      // so that the AI's TTS playback can run unhindered. Without this, on
      // iOS the session can stay in playAndRecord mode and Audio.Sound
      // playback fails silently → user hears no AI voice.
      if (Platform.OS !== "web") {
        try {
          const { setAudioModeAsync } = require("expo-audio");
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
            interruptionMode: "duckOthers",
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          });
        } catch {}
      }
      if (!res) {
        // Audio scartato dalla guardia client-side (no vera voce continua).
        // In conversation mode: contiamo il "vuoto". Dopo 4 vuoti, esci.
        if (convActiveRef.current) {
          emptyTurnsRef.current += 1;
          if (emptyTurnsRef.current >= 4) {
            // ANTI-LOOP: 4 vuoti di fila → Coda parla e esce dal loop
            setConvActive(false);
            emptyTurnsRef.current = 0;
            await speakAwareness(pickLine(awarenessLoopExit));
            return;
          }
          // Vuoto: feedback breve e riapri
          setError("Non ti ho sentito 👂");
          setTimeout(() => setError(null), 2000);
          setStatus("idle");
          if (profile?.settings?.input_mode !== "text") {
            setTimeout(() => {
              if (convActiveRef.current && !recRef.current) {
                startTalkInternal(true).catch(() => {});
              }
            }, 600);
          }
          return;
        }
        // Non in conversation mode → solo feedback breve, no parlato
        setError("Non ti ho sentito bene 👂");
        setTimeout(() => setError(null), 2500);
        setStatus("idle");
        return;
      }
      const fd = buildFormData(res);
      // Fase 4 Step 1: usiamo Deepgram Nova-3 (più veloce e accurato di Whisper).
      // Fallback automatico a /transcribe (Whisper) se Deepgram fallisce.
      let r = await fetch(`${API_BASE}/transcribe-deepgram`, {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        console.warn(`[transcribe] Deepgram failed (${r.status}), fallback to Whisper`);
        // Ricreo FormData perché il body è già stato consumato
        const fd2 = buildFormData(res);
        r = await fetch(`${API_BASE}/transcribe`, {
          method: "POST",
          body: fd2,
        });
      }
      if (!r.ok) throw new Error("transcribe");
      const data = await r.json();
      const txt = (data.text || "").trim();
      const cls = classifyTranscript(txt);
      if (cls !== "ok") {
        // === DIAGNOSTIC LOG (fix 2026-06 cold-start) ===
        console.warn(`[stopTalk] empty/garbled transcript. convActive=${convActiveRef.current}, txt="${txt}", cls=${cls}`);
        // CODA CONSAPEVOLE: spiegale all'utente cosa è successo
        if (convActiveRef.current) emptyTurnsRef.current += 1;
        let line: string;
        if (cls === "empty") line = pickLine(awarenessLinesNoAudio);
        else /* garbled */ line = pickLine(awarenessLinesGarbled);
        // Se ancora più tollerante: 4 vuoti consecutivi prima di uscire
        if (convActiveRef.current && emptyTurnsRef.current >= 4) {
          setConvActive(false);
          emptyTurnsRef.current = 0;
          await speakAwareness(pickLine(awarenessLoopExit));
          return;
        }
        // === VISIBILITÀ FIX 2026-06 ("primo messaggio perso") ===
        // Quando NON siamo in conversation mode (= primo tap manuale),
        // aggiungiamo SEMPRE una bolla visibile nella timeline con
        // l'awareness line. Così, anche se il TTS fallisce o l'utente
        // swipa via prima di ascoltare, vede comunque cosa è successo
        // nella schermata di lettura. Niente più "ho parlato ma è
        // sparito tutto nel nulla".
        if (!convActiveRef.current) {
          setTimeline((prev) => [
            ...prev,
            {
              id: `ai-empty-${Date.now()}`,
              role: "ai",
              text: line,
              tone: "calm",
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        await speakAwareness(line);
        // Se ancora in conv mode, riapri mic dopo la frase
        if (convActiveRef.current && profile?.settings?.input_mode !== "text") {
          setTimeout(() => {
            if (convActiveRef.current && !recRef.current) {
              startTalkInternal(true).catch(() => {});
            }
          }, 350);
        }
        return;
      }
      // Trascrizione OK → reset contatore vuoti e procedi
      emptyTurnsRef.current = 0;

      // === VOICE COMMAND: Hands-Free toggle ===
      // Intercettiamo qui i comandi vocali per disattivare/riattivare il
      // hands-free senza coinvolgere Claude (zero latenza, zero crediti).
      // Match flessibile italiano + inglese, con tolleranza punteggiatura.
      const lower = txt.toLowerCase().replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();
      const isDisableHF = /\b(stop|disattiv\w*|ferm\w*|spegn\w*|esci\w*|chiud\w*)\b.{0,20}\b(hands?[\s-]?free|mani[\s-]?libere|ascolto continuo|modalit[aà] vocale)\b/.test(lower)
        || /\b(modalit[aà])\s+(manuale|push[\s-]?to[\s-]?talk|tap|tocco)\b/.test(lower)
        || /\b(passa|entra|metti).{0,15}(manuale|tap|tocco)\b/.test(lower);
      const isEnableHF = /\b(attiv\w*|riattiv\w*|riprend\w*|accend\w*)\b.{0,20}\b(hands?[\s-]?free|mani[\s-]?libere|ascolto continuo|modalit[aà] vocale)\b/.test(lower)
        || /\b(modalit[aà])\s+(hands?[\s-]?free|automatica|vocale|continua)\b/.test(lower);
      if (isDisableHF && handsFreeRef.current) {
        // Disattiva hands-free, NON chiamare il backend. Coda dà conferma vocale breve.
        await setHandsFreeMode(false);
        // Frase di conferma breve, niente LLM call
        const confirm = "Va bene, sono in modalità manuale. Tocca quando vuoi parlare.";
        setTimeline((prev) => [
          ...prev,
          { id: `u-cmd-${Date.now()}`, role: "user", text: txt, timestamp: new Date().toISOString() },
          { id: `ai-cmd-${Date.now()}`, role: "ai", text: confirm, tone: "warm", timestamp: new Date().toISOString() },
        ]);
        await speakAwareness(`[gently] ${confirm}`);
        return;
      }
      if (isEnableHF && !handsFreeRef.current) {
        await setHandsFreeMode(true);
        const confirm = "Hands-free attivo. Parla pure quando vuoi.";
        setTimeline((prev) => [
          ...prev,
          { id: `u-cmd-${Date.now()}`, role: "user", text: txt, timestamp: new Date().toISOString() },
          { id: `ai-cmd-${Date.now()}`, role: "ai", text: confirm, tone: "warm", timestamp: new Date().toISOString() },
        ]);
        await speakAwareness(`[warmly] ${confirm}`);
        return;
      }

      // Send to converse
      await sendText(txt);
    } catch (e) {
      // FIX 2 (RCA): assicuriamoci che recRef sia nullato anche in caso
      // d'errore, altrimenti lo stato resta "stuck" sul prossimo tap.
      if (recRef.current === current) recRef.current = null;
      setError("Errore nella trascrizione.");
      // Auto-clear dopo 4s: prima l'errore restava visibile per sempre.
      // Quando l'utente backgroundava e foregroundava l'app, lo vedeva
      // ancora a schermo a confonderlo (vedi screenshot 2026-05-23 22:24).
      setTimeout(() => setError(null), 4000);
      setStatus("idle");
    }
  };

  const onBigButton = () => {
    // === FIRST-TAP GATE ===
    // Qualsiasi tap dell'utente sul big button marca "ho interagito in
    // questa sessione foreground". Da qui in poi, il loop hands-free
    // può ripartire da solo (vedi useEffect di auto-listen più sopra).
    // Verrà resettato a false quando l'app va in background.
    userInteractedRef.current = true;

    // While the user is RECORDING, the big button always means "stop recording
    // and send the audio" — regardless of conversation_mode. The previous
    // behavior (terminate the loop and CANCEL the recording) was confusing
    // and discarded the audio, making it look like the AI didn't hear at all.
    if (status === "recording" || recRef.current) {
      stopTalk();
      return;
    }

    // While AI is speaking/thinking AND we're in a conversation loop,
    // the big button terminates the loop (otherwise the user has no way out).
    if (convActiveRef.current && (status === "speaking" || status === "thinking")) {
      setConvActive(false);
      try { SpeechMod.stop(); } catch {}
      setStatus("idle");
      return;
    }

    if (status === "idle") {
      // Tap to start. If conversation_mode is on, turn the loop ON
      if (conversationOn) setConvActive(true);
      startTalk();
    } else if (status === "speaking") {
      // Stop AI voice and immediately start recording — single tap interrupts and listens
      SpeechMod.stop();
      setStatus("idle");
      setTimeout(() => startTalk(), 50);
    }
  };

  // Mantieni le ref del gesture composto sincronizzate con la closure
  // corrente di onBigButton e con lo stato disabled (transcribing/thinking).
  // (Rimosso: ora il long-press è gestito via header invisibile.)

  // Debounce per evitare doppio-invio quando passiamo a onPressIn (vedi
  // commento sul TouchableOpacity del send button).
  const lastSendRef = useRef<number>(0);
  const sendTextFromBox = () => {
    // Anti-doppio-tap: ignora i tentativi a meno di 300ms l'uno dall'altro.
    const now = Date.now();
    if (now - lastSendRef.current < 300) return;
    lastSendRef.current = now;
    if (!textInput.trim()) return;
    const txt = textInput;
    setTextInput("");
    Keyboard.dismiss();
    // FIX 2026-07: marca come "from text" → Koda risponde SOLO in testo,
    // niente TTS. Coerente con l'azione dell'utente che ha scelto di scrivere.
    sendText(txt, { fromText: true });
  };

  const askRecap = async () => {
    setRecapText(null);
    setShowRecap(true);
    try {
      const r = await api.recap("today");
      setRecapText(r.recap);
    } catch (e) {
      setRecapText("Non riesco a creare il sunto adesso.");
    }
  };

  const finishOnboarding = async (lang: string) => {
    try {
      const p = await api.updateProfile({ language: lang, onboarded: true } as any);
      setProfile(p);
      setShowOnboarding(false);
      // Pre-warm mic permission so first tap goes straight to recording
      prewarmMic().catch(() => {});
      // Unlock speech engine NOW (this is a user gesture; required for browser TTS)
      unlockSpeech().catch(() => {});
      // Greet
      const greeting =
        lang === "it"
          ? "Ciao. Da ora ti ascolto. Premi e parla quando vuoi."
          : lang === "en"
            ? "Hi. I'm listening from now. Press and talk anytime."
            : lang === "es"
              ? "Hola. Te escucho. Pulsa y habla cuando quieras."
              : lang === "fr"
                ? "Salut. Je t'écoute. Appuie et parle quand tu veux."
                : "Hi. Press to talk anytime.";
      const localEntry: TimelineEntry = {
        id: `welcome-${Date.now()}`,
        role: "ai",
        text: greeting,
        tone: "warm",
        timestamp: new Date().toISOString(),
      };
      setTimeline((prev) => [...prev, localEntry]);
      speakIfEnabled(greeting, "warm");
    } catch (e) {
      console.warn("onboard error", e);
    }
  };

  const resetMemory = async () => {
    try {
      await api.resetEverything();
      setTimeline([]);
      const p = await api.getProfile();
      setProfile(p);
      if (!p.onboarded) setShowOnboarding(true);
    } catch {}
    setShowSettings(false);
  };

  // === EXPORT DATI GDPR (giugno 2026) ======================================
  // Scarica TUTTI i dati dell'utente dal backend (/api/export) come JSON.
  // Web: download diretto via blob. Native: salva in cache + share sheet.
  // Le voci del Confessionale arrivano ANCORA CIFRATE (zero-knowledge).
  const [exportingData, setExportingData] = useState(false);
  const downloadMyData = async () => {
    if (exportingData) return;
    setExportingData(true);
    try {
      const r = await fetch(`${API_BASE}/export`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const jsonText = await r.text();
      const filename = `koda_dati_${new Date().toISOString().slice(0, 10)}.json`;
      if (Platform.OS === "web") {
        // @ts-ignore — DOM disponibile solo su web
        const blob = new Blob([jsonText], { type: "application/json" });
        // @ts-ignore
        const url = URL.createObjectURL(blob);
        // @ts-ignore
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        // @ts-ignore
        document.body.appendChild(a);
        a.click();
        a.remove();
        // @ts-ignore
        URL.revokeObjectURL(url);
      } else {
        const fileUri = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(fileUri, jsonText, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/json",
            dialogTitle: "I tuoi dati Koda",
          });
        } else {
          Alert.alert("Export pronto", `File salvato: ${filename}`);
        }
      }
    } catch (e) {
      console.warn("gdpr export failed", e);
      Alert.alert(
        "Export non riuscito",
        "Non sono riuscito a scaricare i tuoi dati. Controlla la connessione e riprova."
      );
    } finally {
      setExportingData(false);
    }
  };

  const toggleAi = async () => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, ai_enabled: !profile.settings.ai_enabled } };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  const toggleVoice = async () => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, voice_response: !profile.settings.voice_response } };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  const toggleConversation = async () => {
    if (!profile) return;
    const next = {
      ...profile,
      settings: { ...profile.settings, conversation_mode: !profile.settings.conversation_mode },
    };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
    // Pre-warm so first auto-listen is instant
    if (!profile.settings.conversation_mode) {
      prewarmMic().catch(() => {});
      unlockSpeech().catch(() => {});
    }
  };

  const setInputMode = async (mode: "voice" | "text" | "both") => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, input_mode: mode } };
    setProfile(next);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
    if (mode === "voice" || mode === "both") {
      // pre-warm so first tap = direct recording
      prewarmMic().catch(() => {});
    }
  };

  // Load available voices (curated + custom)
  useEffect(() => {
    (async () => {
      try {
        const v = await api.listVoices();
        setVoices(v.voices || []);
        setVoicesEnabled(v.enabled);
      } catch {}
    })();
  }, []);

  // === Proactive Check-in scheduling ===========================
  // When profile loads (or its checkin settings change), reconcile the
  // scheduled local notifications:
  //   - "off"     → cancel any pending check-in
  //   - any non-off value → Koda decide AUTONOMAMENTE: schedula mattina E sera
  //     con orari RANDOMIZZATI ogni giorno (mattina 8:00-10:30, sera 20:00-22:30).
  //
  // Il "libero arbitrio" di Koda è simulato randomizzando l'orario all'interno
  // di finestre umane plausibili → non sembra una sveglia, sembra un gesto suo.
  // The actual content is generated server-side via /checkin/generate so
  // each notification feels personal (uses memory + last messages).
  const lastCheckinSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!profile) return;
    const mode = (profile.settings as any)?.checkin_mode || "off";
    // Sig basata SOLO su mode + giorno corrente — così randomizziamo gli
    // orari ogni nuovo giorno (e non a ogni cambio settings).
    const todayKey = new Date().toISOString().slice(0, 10);
    const sig = `${mode}|${todayKey}`;
    if (lastCheckinSyncRef.current === sig) return;
    lastCheckinSyncRef.current = sig;

    // Picker di orario randomico in una finestra plausibile.
    const randomTime = (minH: number, maxH: number): string => {
      const h = minH + Math.floor(Math.random() * (maxH - minH + 1));
      const m = Math.floor(Math.random() * 60);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    };

    (async () => {
      if (mode === "off") {
        await cancelAllCheckins();
        return;
      }
      const localHour = new Date().getHours();
      // ON → Koda decide entrambi i momenti, mattina e sera, con orario random.
      const morningTime = randomTime(8, 10);   // tra 08:00 e 10:59
      const eveningTime = randomTime(20, 22);  // tra 20:00 e 22:59

      const slots: Array<["morning" | "evening", string]> = [
        ["morning", morningTime],
        ["evening", eveningTime],
      ];
      for (const [slot, hhmm] of slots) {
        try {
          const c = await api.generateCheckin(slot, localHour);
          await scheduleCheckin({
            slot,
            hhmm,
            title: c.title,
            body: c.body,
            voiceText: c.voice_text,
            tone: c.tone,
          });
        } catch (e) {
          // Don't break the app if the LLM hiccups — silently skip; it'll
          // retry next time the user opens the app or changes a setting.
        }
      }
    })();
  }, [profile?.settings?.checkin_mode, profile?.id]);

  // === Tap-on-checkin-notification handler =====================
  // When the user taps a check-in notification, the app foregrounds; we
  // pick up the payload (voice_text, tone) and have Coda speak it
  // immediately as if she's greeting the user upon entering.
  useEffect(() => {
    let mounted = true;
    const handlePayload = (payload: any) => {
      try {
        if (!mounted || !payload) return;
        if (payload.type !== "checkin") return;
        const voiceText: string = String(payload.voice_text || "").trim();
        if (!voiceText) return;
        // Slight delay so the unlock + UI are ready before TTS fires
        setTimeout(() => {
          unlockSpeech();
          SpeechMod.speak(voiceText, {
            language: profile?.language || "it-IT",
            tone: (payload.tone as Tone) || "warm",
          });
        }, 500);
      } catch {}
    };

    // Cold-start case: the app was killed and the user tapped the notif
    let cancelled = false;
    (async () => {
      try {
        // @ts-ignore — getLastNotificationResponseAsync may not exist on web
        const NotifMod = require("expo-notifications");
        const last = await NotifMod.getLastNotificationResponseAsync?.();
        if (cancelled) return;
        const data = last?.notification?.request?.content?.data;
        if (data) handlePayload(data);
      } catch {}
    })();

    // Hot case: user taps notification while app is in background
    let sub: any = null;
    try {
      // @ts-ignore
      const NotifMod = require("expo-notifications");
      sub = NotifMod.addNotificationResponseReceivedListener?.((resp: any) => {
        const data = resp?.notification?.request?.content?.data;
        if (data) handlePayload(data);
      });
    } catch {}

    return () => {
      mounted = false;
      cancelled = true;
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [profile?.language]);

  const setVoice = async (voiceId: string) => {
    if (!profile) return;
    const next = { ...profile, settings: { ...profile.settings, tts_voice_id: voiceId } };
    setProfile(next);
    setDefaultVoiceId(voiceId);
    try {
      await api.updateProfile({ settings: next.settings } as any);
    } catch {}
  };

  // When settings closes, re-prime mic recording mode so the next press of
  // the big button doesn't fail with "Microfono non disponibile" (after
  // previewing voices the audio session is in playback-only mode).
  const closeSettings = () => {
    setShowSettings(false);
    SpeechMod.stop();
    if (profile?.settings?.input_mode !== "text") {
      prewarmMic().catch(() => {});
    }
  };

  /**
   * Tap-on-AI-bubble handler: TOGGLE play/stop the AI's message via voice.
   *  - 1st tap on a bubble → start speaking that message
   *  - 2nd tap on the SAME bubble (while speaking) → stop the voice
   *  - Tap on a DIFFERENT bubble → stop current, start new
   */
  const playingMsgIdRef = useRef<string | null>(null);
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);

  const replayMessage = async (entry: TimelineEntry) => {
    if (!entry || entry.role === "user" || !entry.text) return;
    // If THIS bubble is currently playing → toggle stop
    if (playingMsgIdRef.current === entry.id) {
      SpeechMod.stop();
      playingMsgIdRef.current = null;
      setPlayingMsgId(null);
      return;
    }
    // Otherwise stop whatever's playing and start the new one
    SpeechMod.stop();
    playingMsgIdRef.current = entry.id;
    setPlayingMsgId(entry.id);
    try {
      const langTag = profile?.language === "it" ? "it-IT" : profile?.language || "it-IT";
      await unlockSpeech();
      await SpeechMod.speak(entry.voice_text || entry.text, {
        language: langTag,
        tone: (entry.tone as Tone) || "neutral",
      });
    } catch {}
    // When speech finishes naturally, clear the marker
    if (playingMsgIdRef.current === entry.id) {
      playingMsgIdRef.current = null;
      setPlayingMsgId(null);
    }
  };

  // === GHOST handler ("Dimentica il fatto, ricorda l'insegnamento")
  // Long-press su una bolla → conferma → POST /api/ghost.
  // Il backend cancella l'entry dal DB, e (se è user message significativo)
  // estrae 1 frase di insegnamento da Claude per fonderla nel memory_summary.
  // Localmente rimuoviamo subito la bolla per feedback istantaneo, e
  // ricarichiamo il profilo se è arrivato un nuovo lesson nel memory_summary.
  const ghostMessage = useCallback(async (entry: TimelineEntry) => {
    if (!entry?.id) return;
    // Optimistic UI: rimuovi subito la bolla
    setTimeline((prev) => prev.filter((e) => e.id !== entry.id));
    try {
      const res = await api.ghost(entry.id, true);
      // Se è stato preservato un insegnamento, ricarica il profilo per
      // sincronizzare il memory_summary (e mostrare confidence aggiornata).
      if (res?.lesson_preserved && profile?.id) {
        try {
          const fresh = await api.getProfile();
          setProfile(fresh);
        } catch {}
      }
    } catch (e) {
      // Rollback se il delete fallisce: ricarica timeline
      try {
        const tl = await api.getTimeline(200);
        setTimeline(tl);
      } catch {}
    }
  }, [profile?.id]);

  /**
   * Tap-on-voice-card handler: select the voice AND immediately play a short
   * preview using that voice. One gesture, no separate play button.
   */
  const selectAndPreviewVoice = async (voiceId: string, name: string) => {
    // Update selection (saves to profile, sets default)
    await setVoice(voiceId);
    // Stop any current playback and play preview with the new voice
    SpeechMod.stop();
    try {
      setVoicePreviewLoading(voiceId);
      // Make sure browser audio is unlocked (web)
      await unlockSpeech();
      await SpeechMod.speak(
        `Ciao, sono ${name}. Sarò io a parlarti, da adesso.`,
        { language: "it-IT", tone: "warm", voiceId }
      );
    } finally {
      setVoicePreviewLoading(null);
    }
  };

  const statusLabel = (() => {
    switch (status) {
      case "recording":
        return "Ti ascolto...";
      case "transcribing":
        return "Sto leggendo...";
      case "thinking":
        return "Sto pensando...";
      case "speaking":
        // In conversation mode, the mic is opened in parallel after 250ms,
        // so the user CAN interrupt by talking. Make this discoverable in
        // the UI label.
        if (convActiveRef.current && recRef.current) {
          return "Sto parlando — interrompimi pure";
        }
        return "Sto parlando...";
      default:
        return "Premi e parla";
    }
  })();

  const aiPaused = profile && !profile.settings.ai_enabled;
  const bgValue: string | null = (profile?.settings as any)?.background ?? null;
  const bgDim: number = typeof (profile?.settings as any)?.background_dim === "number"
    ? (profile?.settings as any).background_dim
    : 0.55;
  const bgPreset = bgValue && BG_PRESETS.find((p) => p.id === bgValue);
  // === Sfondo personalizzato ===
  // Il backend, per evitare di gonfiare ogni /api/profile con un base64 da
  // centinaia di KB, sostituisce il blob "data:image/...;base64,..." con un
  // breve placeholder del tipo:
  //   "@server:/api/profile/background?v=<hash>"
  // Il frontend deve quindi convertire questo placeholder in una URL HTTP
  // completa che <ImageBackground> sa caricare. L'hash cambia quando l'utente
  // carica una nuova foto → forza iOS a riscaricare l'immagine.
  const isServerBg = typeof bgValue === "string" && bgValue.startsWith("@server:");
  const isCustomImage = !!bgValue && (
    bgValue.startsWith("data:") ||
    bgValue.startsWith("file:") ||
    bgValue.startsWith("http") ||
    isServerBg
  );
  const bgUri: string | null = (() => {
    if (!bgValue) return null;
    if (isServerBg) return `${BACKEND}${bgValue.slice("@server:".length)}`;
    if (bgValue.startsWith("data:") || bgValue.startsWith("file:") || bgValue.startsWith("http")) {
      return bgValue;
    }
    return null;
  })();
  const bubbleAccent = useMemo(
    () => resolveBubbleColors((profile?.settings as any)?.bubble_color),
    [(profile?.settings as any)?.bubble_color]
  );
  // Last AI tone — used to color the Orb during "speaking" state so the
  // visual matches the emotional tone of the AI reply (warm/calm/concerned…).
  const lastAiTone: OrbTone | null = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const e = timeline[i];
      if (e.role === "ai" && e.tone) return e.tone as OrbTone;
    }
    return null;
  }, [timeline]);

  // === Orb Ambient — derives warmth, dim and time-of-day palette purely
  //     from the timeline + current hour. No persistent state needed.
  const ambient = useOrbAmbient(timeline);

  // Live scroll-peek: tracks scroll velocity so the Orb leans toward the
  // direction of recent scrolling (then gently returns to centre).
  const [scrollPeek, setScrollPeek] = useState(0);
  const lastScrollY = useRef(0);
  const scrollDecayTimer = useRef<any>(null);
  const onTimelineScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const delta = y - lastScrollY.current;
    lastScrollY.current = y;
    // Coda peeks UP when user scrolls up (looking back), DOWN when scrolling down
    setScrollPeek((prev) => {
      const next = prev * 0.6 + delta * 1.4;
      return Math.max(-100, Math.min(100, next));
    });
    if (scrollDecayTimer.current) clearTimeout(scrollDecayTimer.current);
    scrollDecayTimer.current = setTimeout(() => setScrollPeek(0), 350);
  }, []);

  // === Caveat handwritten font — used for AI replies to evoke "diary
  //     written together with a friend". User text stays system-default
  //     (more neutral, like a clean note).
  const [fontsLoaded] = useFonts({
    Caveat_400Regular,
    Caveat_500Medium,
  });
  const aiFontFamily = fontsLoaded ? "Caveat_500Medium" : undefined;
  const bubbleStyle: "glass" | "solid" =
    ((profile?.settings as any)?.bubble_style === "solid") ? "solid" : "glass";
  const textSize: number = (() => {
    const v = (profile?.settings as any)?.text_size;
    return typeof v === "number" && v >= 0.7 && v <= 1.6 ? v : 1.0;
  })();
  // Text color uniform across both user & AI bubbles, derived from theme.
  // Light themes (carta/aurora etc.) → dark text; dark themes → light text.
  const textOnBubble = theme.text;

  // === Build timeline w/ day separators ===
  // PRIVACY CONFESSIONALE: i messaggi creati durante il Confessionale (flag
  // `confessional: true`) sono VISIBILI solo quando il toggle confessionale
  // è attivo. Quando lo disattivi, scompaiono dalla schermata di testo —
  // così se qualcuno apre l'app non può leggerli. Quando lo riattivi,
  // ricompaiono colorati in violetto (vedi ChatBubble) per essere
  // immediatamente riconoscibili come "messaggi protetti".
  const timelineWithSeparators = useMemo(() => {
    const out: Array<{ kind: "sep"; key: string; label: string } | { kind: "msg"; entry: TimelineEntry } | { kind: "msg-mock"; entry: TimelineEntry; held?: boolean }> = [];
    let lastDay = "";
    for (const e of timeline) {
      // Privacy filter: nascondi le entry confessional quando il toggle è OFF.
      // === DRIFTOUT: durante l'animazione di uscita (220ms) tieni visibili
      // le entry confessional in modo che possano essere animate fuori. ===
      if (e.confessional && !confessionalMode && !confessionalExiting) continue;
      const d = new Date(e.timestamp);
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dayKey !== lastDay) {
        out.push({ kind: "sep", key: `sep-${dayKey}`, label: dayLabelFor(d) });
        lastDay = dayKey;
      }
      out.push({ kind: "msg", entry: e });
    }
    // === MESSAGGI FINTI TOUR (richiesta utente giugno 2026 round 5) ===
    // Quando il tour è attivo nella pagina di lettura, mostriamo 3 bolle
    // d'esempio realistiche così l'highlight di "tieni premuto" ha qualcosa
    // di concreto su cui appoggiarsi (e non un cerchio finto su area vuota).
    // Lo step "Tieni premuto" attiva l'animazione held sulla 2a bolla.
    if (tourActive && tourCurrentStep?.page === "reading") {
      const nowTs = new Date().toISOString();
      const heldNow = tourCurrentStep.label === "Tieni premuto";
      const mocks: TimelineEntry[] = [
        { id: "mock-tour-1", role: "user",  text: "Stanotte non ho dormito.",        timestamp: nowTs, tone: "neutral", actions: [] } as any,
        { id: "mock-tour-2", role: "ai",    text: "Mi spiace. Vuoi raccontarmi?",    timestamp: nowTs, tone: "warm",    actions: [] } as any,
        { id: "mock-tour-3", role: "user",  text: "Sì, mi sento solo ultimamente.",  timestamp: nowTs, tone: "neutral", actions: [] } as any,
      ];
      // Solo se il timeline reale è vuoto, prepende un separatore "Oggi".
      if (out.length === 0) {
        out.push({ kind: "sep", key: "sep-tour", label: "Oggi" });
      }
      for (const m of mocks) {
        out.push({ kind: "msg-mock", entry: m, held: heldNow && m.id === "mock-tour-3" });
      }
    }
    return out;
  }, [timeline, confessionalMode, confessionalExiting, tourActive, tourCurrentStep]);

  // === OLED DIM OVERLAY RIMOSSO (richiesta utente giugno 2026) =============
  // La riduzione di luminosità per risparmio energetico è stata eliminata
  // completamente: copriva lo schermo con un velo nero, era percepita come
  // un bug e non aveva un comportamento corretto. Nessun overlay, nessun
  // timer.

  // Build the screen wrapper with optional background image / gradient
  // === Aurora DISABILITATA (richiesta utente 2026-06) ===
  // Il tema "giorno" è ora STATICO color sabbia. Il layer Aurora animato
  // resta nel codice ma non viene mai mostrato. Per riattivarlo, basta
  // rimettere isAurora = theme.name === "giorno".
  const isAurora = false;
  const isLiquid = theme.name === "liquid";
  const screenInner = (
    <View
      style={[styles.screen, { backgroundColor: bgValue ? "transparent" : (isAurora ? "#000" : (isLiquid ? "#F4F1EA" : theme.bg)) }]}
    >
      {/* === LIQUID INVERSION LAYER (richiesta utente 2026-06) ===
          Sfondo bianco-latte denso che si "deforma" attorno
          all'eclissi e si lascia colorare dall'interno dal tone
          dell'eclissi. Vedi components/LiquidInversionBg.tsx. */}
      {isLiquid && !bgValue && (
        <LiquidInversionBg
          tone={lastAiTone}
          status={status}
          meterDb={meterDb}
          meterThreshold={meterThreshold}
          centerX={0.5}
          centerY={0.42}
        />
      )}
      {/* === AURORA LAYER (richiesta utente 2026-06) ===
          Quando il tema è "Aurora", uno strato Animated.View riempie
          tutto lo schermo e cicla continuamente attraverso 6 tinte
          neon vibranti (rosa shocking, viola fluo, celeste, verde
          menta, pesca, magenta). È sotto a tutto il resto e
          pointerEvents=none così non blocca i tap.
          Sopra c'è un velo scuro semi-trasparente che attenua il
          neon abbastanza da mantenere il testo bianco leggibile,
          dando l'effetto "insegne luminose attraverso una notte
          fumosa" — la tinta vibra ma non brucia la retina. */}
      {isAurora && !bgValue && (
        <>
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: auroraBg,
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              // Velo notturno: l'aurora boreale danza nel cielo nero della
              // notte polare. Velo al 45% per simulare quello scuro su cui
              // i colori dell'aurora pulsano.
              backgroundColor: "rgba(0,0,0,0.45)",
            }}
          />
        </>
      )}
      {/* Banner di conferma salvataggio — appare per ~4s dopo che KodaIntro
          si chiude, così l'utente capisce che le modifiche sono andate a
          buon fine. Posizionato in alto, sopra il flusso normale. */}
      {savedBannerVisible && (
        <View
          style={[
            styles.savedBanner,
            { top: Math.max(insets.top + 120, 170) },
          ]}
          pointerEvents="none"
        >
          <Ionicons name="checkmark-circle" size={20} color="#34D399" />
          <Text style={styles.savedBannerText}>Configurazione salvata</Text>
        </View>
      )}
      {/* Toast hands-free: conferma visuale rapida quando l'utente
          attiva/disattiva la modalità (da voce o da toggle). */}
      {handsFreeToast && (
        <View
          style={[
            styles.savedBanner,
            { top: Math.max(insets.top + 120, 170) },
          ]}
          pointerEvents="none"
        >
          <Ionicons
            name={handsFree ? "pulse" : "hand-left"}
            size={18}
            color={handsFree ? "#34D399" : "#FBBF24"}
          />
          <Text style={styles.savedBannerText}>{handsFreeToast}</Text>
        </View>
      )}
      {/* Banner "Dimmi, ti ascolto" — appare la prima volta che parte la
          sessione hands-free. Suggerisce all'utente che può iniziare a
          parlare. Sparisce automaticamente o appena il VAD rileva voce. */}
      {listenBanner && !handsFreeToast && (
        <View
          style={[
            styles.savedBanner,
            { top: Math.max(insets.top + 120, 170) },
          ]}
          pointerEvents="none"
        >
          <Ionicons name="pulse" size={18} color="#34D399" />
          <Text style={styles.savedBannerText}>{listenBanner}</Text>
        </View>
      )}
      {/* === HEADER ZEN (richiesta utente 2026-06) ===
          Riga 1 (alta, vicino al clock): icone laterali (hands-free + menu)
          Riga 2 (più in basso): toggle Confessionale
          Tutte e tre le icone restano agganciate con anchor punti distinti
          per avere LATERALI vicino al clock e CENTRO più in giù. */}
      <View
        style={[styles.header, { top: Math.max(insets.top + 28, 70), justifyContent: "space-between" }]}
        pointerEvents="box-none"
      >
        {/* Slot sinistro: toggle Hands-Free. */}
        <TouchableOpacity
          ref={handsFreeBtnRef}
          style={[styles.headerBtn, { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }]}
          onPress={() => setHandsFreeMode(!handsFree)}
          hitSlop={20}
          testID="hands-free-toggle"
          accessibilityLabel={handsFree ? "Hands-free attivo, tocca per disattivare" : "Hands-free spento, tocca per attivare"}
        >
          <Ionicons
            name={handsFree ? "pulse" : "pulse-outline"}
            size={22}
            color={handsFree ? "#34D399" : (theme.isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)")}
          />
        </TouchableOpacity>
        {/* Slot destro: menu impostazioni (preso dall'old position). */}
        <TouchableOpacity
          ref={menuBtnRef}
          style={[styles.headerBtn, { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }]}
          onPress={() => setShowSettings(true)}
          hitSlop={20}
          testID="settings-toggle"
          accessibilityLabel="Apri impostazioni"
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={22}
            color={theme.isDark ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.65)"}
          />
        </TouchableOpacity>
      </View>

      {/* === RIGA 2: TOGGLE CONFESSIONALE (centrato, più in basso) === */}
      <View
        style={[styles.confessionaleRow, { top: Math.max(insets.top + 100, 150) }]}
        pointerEvents="box-none"
      >
        <View style={styles.headerCenter} pointerEvents="box-none">
          {/* === Lucchetto Confessionale ===
              Toggle one-tap nel cuore dell'header. Quando attivo:
                - blob si scurisce (forma nucleica dark)
                - i messaggi NON vengono salvati su DB
                - la memoria di lungo periodo NON viene aggiornata
                - a sessione chiusa tutto svanisce dalla RAM */}
          <TouchableOpacity
            ref={confessionaleBtnRef}
            style={[
              styles.confessionalToggle,
              confessionalMode && styles.confessionalToggleOn,
            ]}
            onPress={async () => {
              if (!confessionalMode) {
                // ATTIVAZIONE — Manifesto V1: nessuna Parola Segreta.
                // Mostriamo la schermata d'ingresso, poi si entra liberamente.
                setShowConfessionalIntro(true);
                return;
              } else {
                // === RESET VOLONTARIO (Manifesto V1) ===
                // Niente distillazione, niente memoria di lungo termine: il
                // Confessionale non deve "definirti domani". All'uscita
                // cancelliamo FISICAMENTE il buffer di sessione sul server
                // (oltre al TTL 24h di sicurezza).
                if (confessionalGhostTokenRef.current) {
                  api.confessionalReset(confessionalGhostTokenRef.current).catch(() => {});
                  confessionalGhostTokenRef.current = null;
                }
                // === ANIMAZIONE DI CHIUSURA — DISATTIVATA (giugno 2026 v5) ===
                // L'utente non era soddisfatta né del vecchio rituale "burn"
                // né della nuova "release" sostitutiva. Per ora usciamo SENZA
                // orpelli grafici (wipe diretto e ritorno alla Home).
                // L'animazione tornerà quando avremo deciso insieme cosa
                // mostrare. La pulizia dei dati (timeline.filter, ref reset,
                // confessionalMode=false) avviene comunque qui.
                setTimeline((prev) => prev.filter((e) => !e.fortezza));
                fortezzaUsedThisSessionRef.current = false;
                confessionalGhostTokenRef.current = null;
              }
              setConfessionalMode((m) => !m);
            }}
            onLongPress={undefined}
            hitSlop={10}
            testID="confessional-toggle"
          >
            <Text
              style={[
                styles.confessionalToggleText,
                !theme.isDark && !confessionalMode && { color: "rgba(0,0,0,0.85)" },
                confessionalMode && { color: "#FF6B6B" },
              ]}
            >
              {confessionalMode ? "Confessionale" : "Confessionale"}
            </Text>
          </TouchableOpacity>
        </View>
        {/* Slot destro: icona "tre puntini" — apre le IMPOSTAZIONI complete.
            Prima apriva direttamente la presentazione KodaIntro, ma l'utente
            non aveva alcun modo di raggiungere il menu Impostazioni (tema,
            voce, notifiche, ecc.) → comportamento controintuitivo: chi tappa
            i tre puntini si aspetta un menu di opzioni, non una presentazione.
            Da Impostazioni si può comunque rivedere la presentazione (link in
            fondo) e cambiare voce (nuova riga "Voce di Koda"). */}
        {/* Settings button moved to top row (2026-06).
            Riga 1 = side icons vicino al clock; Riga 2 = Confessionale. */}
      </View>

      {/* === HORIZONTAL PAGER: Voce (zen) | Lettura (timeline) ===
          Pagina 0 = SOLO la macchia centrale grande, niente testi, come
          parlare con qualcuno guardandoti negli occhi.
          Pagina 1 = la timeline (modalità lettura) con la macchia piccola.
          Lo swipe orizzontale switch tra le due. */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={(e) => {
          // === FIX FLASH ORB DURANTE SWIPE (richiesta utente 2026-06) ===
          // Prima viewMode si aggiornava SOLO al termine del momentum
          // (onMomentumScrollEnd). Risultato: durante lo swipe da Page 0
          // a Page 1, viewMode era ancora "voice" e la bottom-bar mostrava
          // ancora l'orb piccolo per una frazione di secondo → flash visivo
          // sgradevole. Ora aggiorniamo la modalità appena passiamo la
          // metà dello schermo: l'orb scompare prima che l'utente lo veda.
          const x = e.nativeEvent.contentOffset.x;
          const w = e.nativeEvent.layoutMeasurement.width || windowWidth;
          if (w === 0) return;
          const ratio = x / w;
          const next: "voice" | "reading" = ratio > 0.35 ? "reading" : "voice";
          if (next !== viewMode) setViewMode(next);
        }}
        scrollEventThrottle={16}
        onScrollEndDrag={(e) => {
          // === SWIPE FLUIDO (giugno 2026, fix #2) ===
          // Il fix precedente forzava scrollTo() qui basandosi su x > w/2,
          // ignorando la VELOCITÀ del gesto. Risultato: uno swipe veloce
          // ma corto (intent: cambia pagina) veniva rimandato indietro.
          // Soluzione: leggi il target che iOS ha CALCOLATO DA SOLO con
          // velocità inclusa (e.nativeEvent.targetContentOffset) — è il
          // comportamento naturale di iOS pagingEnabled. Noi aggiorniamo
          // solo il viewMode, NON interferiamo con lo scroll.
          const target = e.nativeEvent.targetContentOffset?.x;
          const cur = e.nativeEvent.contentOffset.x;
          const w = e.nativeEvent.layoutMeasurement.width || windowWidth;
          if (w === 0) return;
          const ref = typeof target === "number" ? target : cur;
          const page = ref > w / 2 ? 1 : 0;
          setViewMode(page === 0 ? "voice" : "reading");
        }}
        onMomentumScrollEnd={(e) => {
          const x = e.nativeEvent.contentOffset.x;
          const w = e.nativeEvent.layoutMeasurement.width || windowWidth;
          if (w === 0) return;
          const page = Math.round(x / w);
          // Safety-net: snap SOLO se siamo realmente fuori posizione
          // (es. re-render killato il momentum). Tolleranza 4px così
          // non interferiamo con la naturale fine del momentum iOS.
          if (Math.abs(x - page * w) > 4) {
            pagerRef.current?.scrollTo({ x: page * w, y: 0, animated: true });
          }
          setViewMode(page === 0 ? "voice" : "reading");
        }}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        decelerationRate="fast"
      >
        {/* === PAGE 0: VOICE ZEN MODE ============================ */}
        {/* CORREZIONE 2026-06: rimosso il paddingTop/Bottom — la pagina
            è ora un semplice flex-center, e l'orb è davvero al centro
            geometrico dello schermo. La "scorri per leggere" è
            posizionata absolute al simmetrico dello slot Confessionale. */}
        <View style={{ width: windowWidth, flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 90 }}>
          <View style={{ alignItems: "center", justifyContent: "center", flex: 1, gap: 18, paddingHorizontal: 24 }}>
            {/* === ECLISSI NASCOSTA IN TEXT MODE (richiesta utente 2026-06) ===
                In modalità scrittura (inputMode === "text") l'utente NON
                vuole più vedere l'eclissi/orb da nessuna parte: né nella
                bottom-bar (già rimosso), né in questa Page 0 grande.
                In text-mode mostriamo solo un saluto minimale; per scrivere
                l'utente swipa alla Page 1 (reading). */}
            {inputMode !== "text" ? (
              <>
                <Pressable
                  ref={orbBtnRef}
                  onPress={onBigButton}
                  disabled={status === "transcribing" || status === "thinking"}
                  hitSlop={30}
                  style={({ pressed }) => [
                    { alignItems: "center", justifyContent: "center" },
                    pressed && { opacity: 0.85 },
                  ]}
                  testID="big-btn-voice"
                >
                  <Animated.View
                    style={{
                      transform: [
                        {
                          scale: Animated.multiply(
                            pulse,
                            breathe.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.07] })
                          ),
                        },
                      ],
                    }}
                  >
                    <EclipseOrb
                      status={status}
                      // === IDLE = SEMPRE NEUTRAL (verde menta) ===
                      // Prima rimaneva ciclamino/urgente quando Koda era idle
                      // dopo aver dato una risposta "urgent" → l'utente credeva
                      // che fosse bloccata in thinking. Ora a riposo è SEMPRE
                      // verde menta = "pronta, ti ascolto".
                      tone={
                        status === "speaking" ? "warm" :
                        status === "idle" ? null :
                        lastAiTone
                      }
                      size={Math.min(windowWidth * 0.78, 360)}
                      meterDb={meterDb}
                      meterThreshold={meterThreshold}
                    />
                </Animated.View>
                {(status === "transcribing" || status === "thinking") && (
                  <View style={styles.blobOverlay} pointerEvents="none">
                    <ActivityIndicator color="#FFFFFFEE" size="large" />
                  </View>
                )}
              </Pressable>
                <Text style={[styles.statusLabel, styles.statusLabelOnBg, { fontSize: 16, marginTop: 8 }]}>
                  {aiPaused ? "AI in pausa" : ""}
                </Text>
              </>
            ) : (
              <>
                <Text style={{ color: theme.text, fontSize: 22, fontWeight: "300", textAlign: "center", letterSpacing: 0.5 }}>
                  {profile?.name ? `Ehi ${profile.name}.` : "Sono qui."}
                </Text>
                <Text style={{ color: theme.textMuted, fontSize: 14, textAlign: "center", marginTop: 4 }}>
                  Scorri a sinistra per scrivermi.
                </Text>
              </>
            )}
            {/* Hint swipe — solo se ci sono messaggi (altrimenti non ha senso
                far promettere "scorri per leggere" se non c'è nulla da leggere) */}
            {timeline.length > 0 && inputMode !== "text" ? (
              <View ref={scrollHintRef} style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: 0.55, marginTop: 6 }}>
                <Ionicons name="chevron-back" size={14} color={theme.text} />
                <Text style={{ color: theme.text, fontSize: 12 }}>scorri per leggere</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* === PAGE 1: READING MODE (timeline) =================== */}
        <View style={{ width: windowWidth, flex: 1 }}>
      {/* Freemium counter discreto in cima alla timeline.
          Visibile solo se: utente NON abbonato AND non sta facendo
          Confessionale (per non rompere l'atmosfera). */}
      {freemium && !freemium.subscription_active && !confessionalMode ? (
        <View style={{ paddingTop: Math.max(insets.top + 6, 50), paddingBottom: 4 }}>
          <FreemiumCounter
            visible={true}
            remaining={freemium.free_messages_remaining}
            total={freemium.free_messages_limit}
          />
        </View>
      ) : null}
      {/* === TIMELINE: FlatList (refactor performance giugno 2026) ===
          Era una ScrollView che renderizzava TUTTI i messaggi → lenta e
          memory-hungry su chat lunghe. FlatList virtualizza: renderizza
          solo le righe visibili + finestra. scrollToEnd() resta identico. */}
      <FlatList
        ref={scrollRef}
        data={timelineWithSeparators}
        keyExtractor={(it) => (it.kind === "sep" ? it.key : it.entry.id)}
        renderItem={({ item: it }) =>
          it.kind === "sep" ? (
            <View style={styles.daySeparator}>
              <View style={styles.daySepLine} />
              <Text style={styles.daySepText}>{it.label}</Text>
              <View style={styles.daySepLine} />
            </View>
          ) : it.kind === "msg-mock" ? (
            // Bolla finta del tour: stesso look ma con effetto "tenuta premuta"
            // (scale 0.96 + outline + opacità lampeggiante) quando held=true.
            <View
              style={{
                transform: [{ scale: it.held ? 0.96 : 1 }],
                opacity: it.held ? 0.92 : 1,
              }}
            >
              <View
                style={
                  it.held
                    ? {
                        borderWidth: 2,
                        borderColor: "#FCD34D",
                        borderRadius: 22,
                        marginHorizontal: 8,
                      }
                    : undefined
                }
              >
                <Bubble
                  entry={it.entry as any}
                  onReplay={() => {}}
                  onGhost={() => {}}
                  aiAvatar={(profile?.settings as any)?.ai_avatar || null}
                  bubbleAccent={bubbleAccent}
                  bubbleStyle={bubbleStyle}
                  textOnBubble={textOnBubble}
                  textSize={textSize}
                  aiFontFamily={aiFontFamily}
                />
              </View>
            </View>
          ) : (
            // === Wrappa con Animated.View per il driftOut su entry confessional ===
            (() => {
              const isConfExiting = confessionalExiting && (it.entry as any).confessional;
              const translateY = confessionalDriftAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -12] });
              const opacity = confessionalDriftAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
              return (
                <Animated.View
                  style={isConfExiting ? { transform: [{ translateY }], opacity } : undefined}
                >
                  <Bubble
                    entry={it.entry}
                    onReplay={replayMessage}
                    onGhost={ghostMessage}
                    aiAvatar={(profile?.settings as any)?.ai_avatar || null}
                    bubbleAccent={bubbleAccent}
                    bubbleStyle={bubbleStyle}
                    textOnBubble={textOnBubble}
                    textSize={textSize}
                    aiFontFamily={aiFontFamily}
                  />
                </Animated.View>
              );
            })()
          )
        }
        style={styles.timeline}
        contentContainerStyle={[styles.timelineContent, { paddingTop: Math.max(insets.top + 70, 130), paddingBottom: 220 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        testID="timeline"
        onScroll={onTimelineScroll}
        scrollEventThrottle={32}
        initialNumToRender={20}
        maxToRenderPerBatch={12}
        windowSize={9}
        removeClippedSubviews={Platform.OS !== "web"}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            {/* === FIX DOPPIO ECLISSI ===
                Niente orb qui: la Page 0 ha già l'orb principale e la
                bottom bar quello tap-to-talk. Solo testo di benvenuto. */}
            <Text style={styles.emptyTitle}>
              {profile?.name ? `Ehi ${profile.name}, sono qui.` : "Sono qui."}
            </Text>
            <Text style={styles.emptyText}>
              Tutto quello che mi dici resta tra noi.{"\n"}Parla — ti ascolto.
            </Text>
          </View>
        }
        ListFooterComponent={
          /* Typing indicator a sinistra (stile WhatsApp) — SOLO mentre
             l'AI pensa o trascrive. Non durante "speaking" (il messaggio
             è già in timeline a quel punto). */
          status === "thinking" || status === "transcribing" ? (
            <View style={[styles.bubbleRow, styles.bubbleRowL]}>
              <View
                style={[
                  styles.bubbleAi,
                  {
                    // Colore "thinking" ciclamino (richiesta 2026-06 #7)
                    backgroundColor: bubbleStyle === "solid" ? "#EC4899" : "rgba(236,72,153,0.18)",
                    borderColor: "#EC4899",
                    borderWidth: bubbleStyle === "glass" ? 1 : 0,
                  },
                ]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 18 }}>
                  <TypingDot delay={0} color={bubbleStyle === "solid" ? "#FFFFFF" : "#EC4899"} />
                  <TypingDot delay={150} color={bubbleStyle === "solid" ? "#FFFFFF" : "#EC4899"} />
                  <TypingDot delay={300} color={bubbleStyle === "solid" ? "#FFFFFF" : "#EC4899"} />
                </View>
              </View>
            </View>
          ) : null
        }
      />

      {/* Bottom area: voice OR text — chosen via settings */}
      <View
        style={[
          styles.bottomBar,
          // === FIX TASTIERA (richiesta utente 2026-06) ===
          // Quando la tastiera è aperta, su iOS un absolute-bottom non si
          // alza da solo: aggiungiamo marginBottom = altezza tastiera così
          // l'utente vede sempre cosa sta scrivendo.
          { paddingBottom: Math.max(insets.bottom, 14) + (inputMode === "text" ? 0 : 28),
            marginBottom: kbHeight > 0 ? kbHeight - insets.bottom : 0 },
        ]}
      >
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {inputMode === "text" ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <View style={styles.textRow}>
              <TextInput
                value={textInput}
                onChangeText={(t) => {
                  // === FIX INVIO RAPIDO (richiesta utente 2026-06) ===
                  // Su iOS, multiline + onSubmitEditing NON scatta col
                  // tasto invio: il return semplicemente inserisce \n e
                  // chiude la tastiera. Intercettiamo manualmente il
                  // newline: appena l'utente preme invio, mandiamo il
                  // messaggio in un solo tap senza inserire la riga.
                  if (t.endsWith("\n")) {
                    const clean = t.replace(/\n+$/, "");
                    if (clean.trim()) {
                      setTextInput(clean);
                      // Usa setTimeout per garantire che lo state sia
                      // aggiornato prima dell'invio.
                      setTimeout(() => sendTextFromBox(), 0);
                    } else {
                      setTextInput(clean);
                    }
                    return;
                  }
                  setTextInput(t);
                }}
                placeholder="Scrivi qui..."
                placeholderTextColor="rgba(255,255,255,0.5)"
                style={styles.textInput}
                onSubmitEditing={sendTextFromBox}
                returnKeyType="send"
                blurOnSubmit={false}
                multiline
                testID="text-input"
              />
              {/* === SEND BUTTON FIX FINAL (2026-06) ===
                  Approccio 1 (onPress): inghiottito da iOS keyboard gesture.
                  Approccio 2 (onPressIn): stesso problema.
                  Approccio 3 (View+Responder): non sempre cattura su iOS.
                  Approccio 4 (DEFINITIVO): GHTouchableOpacity da
                  react-native-gesture-handler. Lavora a livello nativo
                  via UIGestureRecognizer prioritario, bypassa la dismiss
                  automatica della tastiera. */}
              <GHTouchableOpacity
                onPress={sendTextFromBox}
                style={[styles.sendBtn, !textInput.trim() ? { opacity: 0.4 } : styles.sendBtnActive]}
                disabled={!textInput.trim()}
                testID="send-btn"
              >
                <Ionicons name="arrow-up" size={20} color={theme.primaryText} />
              </GHTouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        ) : (
          <View style={styles.bigBtnArea}>
            {/* === ORB PICCOLO RIMOSSO COMPLETAMENTE (richiesta utente 2026-06) ===
                Prima qui c'era un secondo EclipseOrb (size 210) che agiva
                da tap-to-talk. Ma:
                - In Page 0 (voice zen) c'è già la grande eclissi → l'orb
                  piccolo era ridondante (due eclissi sovrapposte).
                - Durante lo swipe Page 0→Page 1 questo piccolo orb
                  appariva per una frazione di secondo prima di sparire,
                  creando un flash visivo sgradevole.
                Soluzione definitiva: lo eliminiamo. L'utente parla dalla
                Page 0 (orb grande = pulsante), legge/scrive dalla Page 1
                (timeline + textRow). Nessun flash possibile. */}
            {viewMode !== "reading" && aiPaused ? (
              <Text style={[styles.statusLabel, styles.statusLabelOnBg]}>AI in pausa</Text>
            ) : null}
            {/* Barra di scrittura: appare SOLO in modalità lettura (Page 1).
                Nella pagina principale (orb voce zen) l'esperienza resta
                pulita — niente UI di scrittura, solo l'eclissi. Per scrivere
                l'utente swipa verso sinistra e va nella pagina di lettura. */}
            {viewMode === "reading" && (
              <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                style={{ width: "100%", marginTop: 18 }}
              >
                <View style={styles.textRow}>
                  <TextInput
                    value={textInput}
                    onChangeText={(t) => {
                      // Invio rapido — vedi commento nel TextInput sopra.
                      if (t.endsWith("\n")) {
                        const clean = t.replace(/\n+$/, "");
                        if (clean.trim()) {
                          setTextInput(clean);
                          setTimeout(() => sendTextFromBox(), 0);
                        } else {
                          setTextInput(clean);
                        }
                        return;
                      }
                      setTextInput(t);
                    }}
                    placeholder="Scrivi qui..."
                    placeholderTextColor="rgba(255,255,255,0.5)"
                    style={styles.textInput}
                    onSubmitEditing={sendTextFromBox}
                    returnKeyType="send"
                    blurOnSubmit={false}
                    multiline
                    testID="text-input-reading"
                  />
                  <GHTouchableOpacity
                    onPress={sendTextFromBox}
                    style={[styles.sendBtn, !textInput.trim() ? { opacity: 0.4 } : styles.sendBtnActive]}
                    disabled={!textInput.trim()}
                    testID="send-btn-reading"
                  >
                    <Ionicons name="arrow-up" size={20} color={theme.primaryText} />
                  </GHTouchableOpacity>
                </View>
              </KeyboardAvoidingView>
            )}
          </View>
        )}
        </View>
        </View>
      </ScrollView>

      {/* Onboarding modal */}
      {/* OLED DIM OVERLAY rimosso (richiesta utente giugno 2026). */}

      <Modal visible={showOnboarding} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.onboardCard}>
            <View style={{ marginBottom: 8 }}>
              <AppIcon size={80} />
            </View>
            <Text style={styles.onboardTitle}>Benvenuto</Text>
            <Text style={styles.onboardText}>
              Sono il tuo Taccuino. Vivo nelle tue parole.{"\n"}
              In quale lingua preferisci parlarmi?
            </Text>
            <View style={styles.langGrid}>
              {LANGUAGES.map((l) => (
                <TouchableOpacity
                  key={l.code}
                  style={styles.langBtn}
                  onPress={() => finishOnboarding(l.code)}
                  testID={`lang-${l.code}`}
                >
                  <Text style={styles.langEmoji}>{l.emoji}</Text>
                  <Text style={styles.langLabel}>{l.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.onboardFoot}>
              Potrai cambiare lingua e impostazioni quando vuoi
            </Text>
          </View>
        </View>
      </Modal>

      {/* Settings modal */}
      <Modal
        visible={showSettings}
        transparent
        animationType="slide"
        onRequestClose={() => closeSettings()}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <View style={styles.settingsHeader}>
              <Text style={styles.settingsTitle}>Impostazioni</Text>
              <TouchableOpacity onPress={() => closeSettings()}>
                <Ionicons name="close" size={24} color={theme.text} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ paddingBottom: 6 }}
              showsVerticalScrollIndicator={true}
            >

            {/* === IDENTITÀ — L'Amico Fraterno =======================
                L'unica variabile di identità modificabile è il NOME dell'amico.
                Sesso utente + sesso AI servono per declinare aggettivi e
                participi (es. "sei stanco/a") in modo corretto. */}
            <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>Identità</Text>

            <View style={[styles.settingRow, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Come chiami la presenza</Text>
                <Text style={styles.settingHint}>
                  Il nome con cui ti rivolgi a me. Default: Coda.
                </Text>
              </View>
              <TextInput
                value={profile?.ai_name || "Coda"}
                onChangeText={(txt) => {
                  if (!profile) return;
                  setProfile({ ...profile, ai_name: txt });
                }}
                onBlur={async () => {
                  if (!profile) return;
                  const v = (profile.ai_name || "").trim();
                  const final = v.length > 0 ? v.slice(0, 24) : "Coda";
                  setProfile({ ...profile, ai_name: final });
                  try {
                    await api.updateProfile({ ai_name: final });
                  } catch {}
                }}
                placeholder="Coda"
                placeholderTextColor={theme.muted}
                style={[styles.input, { paddingVertical: 8, fontSize: 15 }]}
                maxLength={24}
                autoCapitalize="words"
              />
            </View>

            <View style={[styles.settingRow, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Tu sei…</Text>
                <Text style={styles.settingHint}>
                  Mi serve per parlarti correttamente (es. &quot;sei stanco&quot; / &quot;sei stanca&quot;).
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {([
                  { id: "m", label: "Uomo" },
                  { id: "f", label: "Donna" },
                  { id: "n", label: "Preferisco neutro" },
                ] as const).map((opt) => {
                  const active = (profile?.user_gender || "n") === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      onPress={async () => {
                        if (!profile) return;
                        setProfile({ ...profile, user_gender: opt.id });
                        try {
                          await api.updateProfile({ user_gender: opt.id });
                        } catch {}
                      }}
                      style={[
                        styles.modeBtn,
                        { paddingHorizontal: 12, paddingVertical: 8 },
                        active && { borderColor: bubbleAccent.color, backgroundColor: bubbleAccent.color + "30" },
                      ]}
                    >
                      <Text style={[styles.modeBtnText, active && { color: bubbleAccent.color, fontWeight: "700" }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={[styles.settingRow, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>{profile?.ai_name || "Coda"} è…</Text>
                <Text style={styles.settingHint}>
                  Definisce come si esprime di sé (es. &quot;sono qui per te&quot; maschile o femminile).
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {([
                  { id: "f", label: "Femmina" },
                  { id: "m", label: "Maschio" },
                  { id: "n", label: "Neutro" },
                ] as const).map((opt) => {
                  const active = (profile?.ai_gender || "f") === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      onPress={async () => {
                        if (!profile) return;
                        setProfile({ ...profile, ai_gender: opt.id });
                        try {
                          await api.updateProfile({ ai_gender: opt.id });
                        } catch {}
                      }}
                      style={[
                        styles.modeBtn,
                        { paddingHorizontal: 12, paddingVertical: 8 },
                        active && { borderColor: bubbleAccent.color, backgroundColor: bubbleAccent.color + "30" },
                      ]}
                    >
                      <Text style={[styles.modeBtnText, active && { color: bubbleAccent.color, fontWeight: "700" }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={styles.divider} />
            <Text style={styles.settingsSubtitle}>Comportamento</Text>

            {/* === TOGGLE RIMOSSI (richiesta utente 2026-05-25) ===
                Prima qui c'erano 3 toggle: "AI attiva", "Risposta vocale",
                "Modalità conversazione". Erano fonte di errore: a volte si
                spegnevano da soli (default backend false?) e l'utente non
                capiva perché l'app sembrava "rotta".
                Adesso questi 3 valori sono SEMPRE TRUE forzati al boot
                (vedi useEffect "force-on" più sotto). I comportamenti:
                  - AI sempre attiva (elabora ogni messaggio)
                  - Hands-free sempre attivo (dopo Koda parla, mic riapre)
                  - Risposta vocale: gestita automaticamente dalla modalità
                    (voce → Koda parla; scrittura → Koda solo scrive). */}

            {/* === VOCE DI KODA — RIMOSSA (richiesta utente 2026-06) ===
                Il selettore voce è stato rimosso dall'UI. Resta la
                voce di default impostata dal backend. */}

            {/* === Proactive Check-in opt-in (giugno 2026 — libero arbitrio) =
                Toggle binario: quando ON, Koda decide AUTONOMAMENTE quando
                scriverti (mattina / sera / nessuna delle due, secondo il
                contesto e il bisogno). Niente orari impostabili dall'utente:
                è una scelta di Koda, non una sveglia. */}
            <View style={[styles.settingRow, { flexDirection: "column", alignItems: "stretch", gap: 10 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>💌 Koda mi scrive</Text>
                  <Text style={styles.settingHint}>
                    Quando attivo, Koda ti scrive di sua iniziativa, quando sente
                    che sia il momento giusto. Non è una sveglia — è un gesto suo.
                  </Text>
                </View>
                <Switch
                  value={((profile?.settings as any)?.checkin_mode || "off") !== "off"}
                  onValueChange={async (on) => {
                    if (!profile) return;
                    // ON → "both" (Koda decide mattina o sera secondo necessità).
                    // OFF → "off" (nessun check-in proattivo).
                    const nextMode = on ? "both" : "off";
                    const nextSettings = { ...profile.settings, checkin_mode: nextMode } as any;
                    setProfile({ ...profile, settings: nextSettings });
                    try {
                      await api.updateProfile({ settings: nextSettings });
                    } catch {}
                  }}
                  trackColor={{ false: theme.muted + "55", true: bubbleAccent.color }}
                  thumbColor="#fff"
                />
              </View>
              <Text style={[styles.settingHint, { fontSize: 11, marginTop: 2, fontStyle: "italic" }]}>
                Notifiche locali, niente esce dal telefono se non al momento di generare la frase.
              </Text>
            </View>

            {/* === RICERCA WEB (Tavily) — toggle privacy ====================
                Quando attivo: se l'utente fa domande fattuali (meteo, notizie,
                prezzi), Koda esegue una ricerca su fonti italiane certificate
                (ANSA, Repubblica, Corriere, Wikipedia, meteo.it, ecc.) PRIMA
                di rispondere. Solo la query corrente viene inviata, nessun
                dato personale. Quando OFF: Koda usa SOLO la sua conoscenza
                statica, nessuna comunicazione esterna oltre l'LLM. MAI
                attivo nel Confessionale a prescindere dal toggle. */}
            <View style={[styles.settingRow, { flexDirection: "column", alignItems: "stretch", gap: 8, marginTop: 14 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>🌐 Ricerca web</Text>
                  <Text style={styles.settingHint}>
                    Permetti a Koda di consultare fonti certificate (ANSA,
                    Repubblica, Wikipedia, meteo.it…) per meteo, notizie e fatti
                    recenti. Nel Confessionale resta sempre spento.
                  </Text>
                </View>
                <Switch
                  value={(profile?.settings as any)?.web_search_enabled !== false}
                  onValueChange={async (on) => {
                    if (!profile) return;
                    const nextSettings = { ...profile.settings, web_search_enabled: on } as any;
                    setProfile({ ...profile, settings: nextSettings });
                    try {
                      await api.updateProfile({ settings: nextSettings });
                    } catch {}
                  }}
                  trackColor={{ false: theme.muted + "55", true: bubbleAccent.color }}
                  thumbColor="#fff"
                />
              </View>
            </View>

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Tema</Text>
            <View style={styles.themeRow}>
              {/* === FILTRO TEMI (giugno 2026 — "Auto" = orario reale) ===
                  Chiaro (giorno) + Scuro (notte) + Auto (alterna in base
                  all'ORA REALE del telefono: 7:00–20:00 chiaro, altrimenti
                  scuro). NON segue più il dark-mode di iOS. */}
              {THEME_LIST.filter((p) => p.name === "giorno" || p.name === "notte" || p.name === "auto-orario").map((p) => (
                <TouchableOpacity
                  key={p.name}
                  onPress={() => saveTheme(p.name as ThemeName)}
                  style={[
                    styles.themeBtn,
                    themeName === p.name && styles.themeBtnActive,
                  ]}
                  testID={`theme-${p.name}`}
                >
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: p.primary },
                    ]}
                  />
                  <Text style={styles.themeBtnText}>
                    {p.emoji} {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {themeName === "auto-orario" ? (
              <View style={styles.hoursRow}>
                <View style={styles.hourBox}>
                  <Text style={styles.hourLabel}>☀️ Inizio giorno</Text>
                  <View style={styles.hourCtrl}>
                    <TouchableOpacity
                      onPress={() => saveHours(Math.max(0, dayStart - 1), nightStart)}
                      style={styles.hourBtn}
                    >
                      <Ionicons name="remove" size={18} color={theme.text} />
                    </TouchableOpacity>
                    <Text
                      style={styles.hourValue}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                    >
                      {String(dayStart).padStart(2, "0")}:00
                    </Text>
                    <TouchableOpacity
                      onPress={() => saveHours(Math.min(23, dayStart + 1), nightStart)}
                      style={styles.hourBtn}
                    >
                      <Ionicons name="add" size={18} color={theme.text} />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.hourBox}>
                  <Text style={styles.hourLabel}>🌙 Inizio notte</Text>
                  <View style={styles.hourCtrl}>
                    <TouchableOpacity
                      onPress={() => saveHours(dayStart, Math.max(0, nightStart - 1))}
                      style={styles.hourBtn}
                    >
                      <Ionicons name="remove" size={18} color={theme.text} />
                    </TouchableOpacity>
                    <Text
                      style={styles.hourValue}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                    >
                      {String(nightStart).padStart(2, "0")}:00
                    </Text>
                    <TouchableOpacity
                      onPress={() => saveHours(dayStart, Math.min(23, nightStart + 1))}
                      style={styles.hourBtn}
                    >
                      <Ionicons name="add" size={18} color={theme.text} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ) : null}

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Aspetto chat</Text>
            <Text style={styles.settingsHint}>
              Scegli la dimensione del testo.
            </Text>

            {/* Personalizzazioni rimosse (richiesta utente 2026-06 #10):
                niente più colori bolle, stili glass/solid o sfondi. */}

            {/* Text size selector — 4 levels for accessibility */}
            <Text style={[styles.settingsHint, { marginTop: 14 }]}>Dimensione testo</Text>
            <View style={styles.modeRow}>
              {[
                { v: 0.85, label: "A", name: "Piccolo" },
                { v: 1.0,  label: "A", name: "Normale" },
                { v: 1.15, label: "A", name: "Grande" },
                { v: 1.35, label: "A", name: "Molto grande" },
              ].map(({ v, label, name }) => {
                const active = Math.abs(textSize - v) < 0.02;
                return (
                  <TouchableOpacity
                    key={v}
                    onPress={() => setTextSize(v)}
                    style={[
                      styles.modeBtn,
                      { flex: 1, flexDirection: "column", paddingVertical: 8 },
                      active && { borderColor: bubbleAccent.color, backgroundColor: bubbleAccent.color + "30" },
                    ]}
                    testID={`text-size-${v}`}
                  >
                    <Text
                      style={{
                        color: active ? bubbleAccent.color : theme.text,
                        fontSize: 12 * v,
                        fontWeight: "800",
                        lineHeight: 14 * v,
                      }}
                    >
                      {label}
                    </Text>
                    <Text style={[styles.modeBtnText, { fontSize: 9, marginTop: 2 }, active && { color: bubbleAccent.color }]}>
                      {name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* === STILE/COLORE BOLLE + SFONDO RIMOSSI (richiesta 2026-06 #10) ===
                L'utente vuole minimalismo Zen: niente customizzazione
                colori bolle, niente stili vetro/solido, niente upload foto
                di sfondo, niente preset di sfondo. L'app deve avere
                un'identità visiva UNICA. Resta solo: tema giorno/notte +
                dimensione testo (accessibilità). */}

            <View style={styles.divider} />

            {/* === MODALITÀ INPUT RIMOSSA (richiesta utente 2026-06) ===
                L'utente passa già da voce a scrittura tramite lo swipe tra
                le due pagine principali (home voce ↔ chat scrittura).
                Avere un toggle in Settings era ridondante e confondeva. */}
            {/* Forziamo internamente input_mode su "both" così entrambi
                i pannelli restano disponibili nel layout. */}
            {(() => {
              if (inputMode !== "both") {
                try { setInputMode("both" as any); } catch {}
              }
              return null;
            })()}

            <Text style={styles.settingsSubtitle}>Voce dell&apos;assistente</Text>
            <Text style={styles.settingsHint}>
              {voicesEnabled
                ? "Tocca per selezionare. Premi ▶ per ascoltare un'anteprima."
                : "ElevenLabs non è configurato. Userò la voce del sistema."}
            </Text>

            {/* === INDICATORE CONFIDENZA (richiesta utente 2026-06, opt B) ===
                Read-only. Mostra al volo a che fase relazionale è Koda.
                Cresce di +1 ad ogni messaggio fuori dal Confessionale.
                0-10 = appena conosciuti, 100 = confidenza totale. */}
            <View style={styles.confidenceRow} testID="confidence-indicator">
              <Text style={styles.confidenceLabel}>
                💞 Confidenza con Koda — {profile?.confidence_level ?? 0}/100 ({((): string => {
                  const lv = profile?.confidence_level ?? 0;
                  if (lv >= 100) return "totale";
                  if (lv >= 61) return "amici stretti";
                  if (lv >= 31) return "amici";
                  if (lv >= 11) return "prendiamo confidenza";
                  return "appena conosciuti";
                })()})
              </Text>
              <View style={styles.confidenceBar}>
                <View
                  style={[
                    styles.confidenceFill,
                    { width: `${Math.min(100, Math.max(0, profile?.confidence_level ?? 0))}%` },
                  ]}
                />
              </View>
              <Text style={[styles.settingsHint, { fontSize: 11, marginTop: 4, fontStyle: "italic" }]}>
                Cresce automaticamente man mano che parliamo. I messaggi del Confessionale non contano.
              </Text>
            </View>
            <View style={styles.voicesList}>
              {/* === FIX TITOLO VOCI (richiesta utente giugno 2026 #5) ===
                  Il titolo "Voce dell'assistente" era separato dalla lista
                  dall'indicatore di Confidenza in mezzo → l'utente percepiva
                  la lista come senza titolo. Aggiungiamo un sotto-titolo
                  chiaro qui sopra le card delle voci. */}
              <Text style={[styles.settingsSubtitle, { marginTop: 4, marginBottom: 6 }]}>
                🎙️ Scegli la voce di Koda
              </Text>
              {voices.map((v) => {
                const selected = profile?.settings?.tts_voice_id === v.voice_id;
                const loading = voicePreviewLoading === v.voice_id;
                return (
                  <TouchableOpacity
                    key={v.voice_id}
                    onPress={() => selectAndPreviewVoice(v.voice_id, v.name)}
                    style={[styles.voiceCard, selected && styles.voiceCardActive]}
                    testID={`voice-${v.voice_id}`}
                  >
                    <View style={styles.voiceCardLeft}>
                      <View
                        style={[
                          styles.voiceDot,
                          selected && { backgroundColor: theme.primary, borderColor: theme.primary },
                        ]}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.voiceName}>
                          {v.name}
                          <Text style={styles.voiceGender}>
                            {"  "}
                            {v.gender === "F" ? "♀" : v.gender === "M" ? "♂" : ""}
                          </Text>
                        </Text>
                        <Text style={styles.voiceDesc} numberOfLines={2}>
                          {v.description}
                        </Text>
                      </View>
                    </View>
                    {loading ? (
                      <ActivityIndicator size="small" color={theme.primary} />
                    ) : selected ? (
                      <Ionicons name="checkmark-circle" size={22} color={theme.primary} />
                    ) : (
                      <Ionicons name="volume-medium-outline" size={20} color={theme.textMuted} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.divider} />

            {/* === "Cosa sa di te" — NASCOSTO (richiesta utente 2026-06) ===
                La sezione resta nel codice ma non è più visibile nel modal.
                Per riattivarla, rimettere il blocco originale qui. */}

            <View style={styles.divider} />

            {/* === NOTIFICHE: toggle on/off (richiesta utente 2026-06) ===
                Aggiunto un interruttore semplice per abilitare/disabilitare
                le notifiche da parte di Koda. Salvato in
                profile.settings.notifications_enabled. Default: ON.
                Il pulsante "Test notifica" è stato rimosso. */}
            <Text style={styles.settingsSubtitle}>Notifiche</Text>
            <View style={[styles.settingRow, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.settingLabel}>🔔 Notifiche da Koda</Text>
                <Text style={styles.settingHint}>
                  Se le abiliti, Koda può inviarti notifiche locali (promemoria,
                  check-in). Tutto sul tuo telefono, niente esce.
                </Text>
              </View>
              <Switch
                value={(profile?.settings as any)?.notifications_enabled !== false}
                onValueChange={async (on) => {
                  if (!profile) return;
                  const nextSettings = { ...profile.settings, notifications_enabled: on } as any;
                  setProfile({ ...profile, settings: nextSettings });
                  try {
                    await api.updateProfile({ settings: nextSettings });
                  } catch {}
                }}
                trackColor={{ false: "rgba(255,255,255,0.18)", true: "#0E7C7B" }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={styles.divider} />

            {/* === SCARICA I MIEI DATI (GDPR Art. 20) ===
                Esporta profilo, conversazioni, ricordi e voci del
                Confessionale (queste ultime restano cifrate) in un JSON. */}
            <TouchableOpacity
              onPress={downloadMyData}
              disabled={exportingData}
              style={[styles.settingRow, { paddingVertical: 14 }]}
              testID="gdpr-export-btn"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>📦 Scarica i miei dati</Text>
                <Text style={styles.settingHint}>
                  Esporta tutto in un file JSON (GDPR): profilo, conversazioni,
                  ricordi. Le voci del Confessionale restano cifrate — nemmeno
                  il file le rivela.
                </Text>
              </View>
              {exportingData ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Ionicons name="download-outline" size={18} color={theme.text + "88"} />
              )}
            </TouchableOpacity>

            <View style={styles.divider} />

            <TouchableOpacity
              onPress={resetMemory}
              style={styles.dangerBtn}
              testID="reset-btn"
            >
              <Ionicons name="trash-outline" size={16} color={theme.danger} />
              <Text style={styles.dangerBtnText}>Cancella tutta la memoria</Text>
            </TouchableOpacity>
            <Text style={styles.dangerHint}>
              Reset completo: profilo, taccuino e ogni ricordo.
            </Text>

            {/* === RIVEDI PRESENTAZIONE DI KODA ===========================
                Spostato qui dal bottone tre-puntini header (che ora apre
                queste impostazioni). Resta raggiungibile per chi vuole
                rifare il setup iniziale (nome, voce, palette, ecc.). */}
            <View style={styles.divider} />
            <TouchableOpacity
              style={[styles.settingRow, { paddingVertical: 14 }]}
              onPress={() => {
                setShowSettings(false);
                setTimeout(() => { reopenKodaIntro(); }, 220);
              }}
              testID="reopen-koda-intro"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>👋 Rivedi presentazione di Koda</Text>
                <Text style={styles.settingHint}>
                  Riapre il setup iniziale: nome, voce, palette colori.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.text + "88"} />
            </TouchableOpacity>

            {/* === PROMESSA DI FERRO (revisione giugno 2026) ===
                Testo allineato a ciò che fa il backend OGGI:
                - normale: salvato su MongoDB Atlas (TLS in transito, at-rest encryption Atlas)
                  → usato solo per costruire la TUA timeline + memoria di Koda
                - confessionale: NON va nella timeline, vive in confessional_buffer
                  con TTL (auto-cancellazione) + reset endpoint a chiusura
                - ghost: rimuove l'entry dalla timeline e dai facts.
                Rimosso "cifrato" generico (era impreciso) sostituito con
                descrizione tecnica più onesta. */}
            <View style={styles.divider} />
            <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>🛡️ Promessa di Ferro</Text>
            <View style={styles.promessaBox}>
              <Text style={styles.promessaText}>
                Quello che mi dici è tra me e te. Niente pubblicità, niente vendita di dati a terzi, niente addestramento di modelli con la tua voce o i tuoi pensieri.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>💬 Modalità normale:</Text> i messaggi vengono salvati nel tuo database personale (MongoDB con cifratura at-rest), usati SOLO per costruire la tua timeline e farmi ricordare ciò che mi racconti.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>🤫 Modalità Confessionale:</Text> niente entra nella timeline. I messaggi vivono in un buffer temporaneo con auto-cancellazione e quando chiudi la sessione svaniscono dal server.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>👻 Pulsante Ghost (tieni premuto un messaggio):</Text> rimuovo l&apos;entry dalla timeline e dai facts associati. Il dato grezzo sparisce dal server.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>📤 Esporta tutto (GDPR):</Text> puoi scaricare in qualsiasi momento un archivio JSON con tutti i tuoi dati dalle impostazioni.
              </Text>
            </View>

            {/* === VERSIONE APP ===
                Footer minimale (senza expo-application per evitare
                crash su build che non l'avevano linkato nativamente).
                Mostra solo versione semantica. Per il numero build
                preciso, usare i log EAS o il timestamp installazione. */}
            <View style={{ alignItems: "center", marginTop: 24, marginBottom: 8 }}>
              <Text style={{ color: theme.text + "55", fontSize: 11, fontStyle: "italic" }}>
                Koda v{Constants.expoConfig?.version || "1.0.1"}
              </Text>
            </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Recap modal */}
      <Modal
        visible={showRecap}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRecap(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.recapCard}>
            <View style={styles.settingsHeader}>
              <Text style={styles.settingsTitle}>Sunto al volo</Text>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                {recapText ? (
                  <TouchableOpacity
                    onPress={async () => {
                      SpeechMod.stop();
                      try {
                        const lang = profile?.language === "it" ? "it-IT" : profile?.language || "it-IT";
                        await SpeechMod.speak(recapText, { language: lang, tone: "warm" });
                      } catch {}
                    }}
                    style={styles.recapPlayBtn}
                    testID="recap-play"
                  >
                    <Ionicons name="volume-high" size={18} color={theme.primaryText} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={() => { SpeechMod.stop(); setShowRecap(false); }}>
                  <Ionicons name="close" size={24} color={theme.text} />
                </TouchableOpacity>
              </View>
            </View>
            {recapText === null ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <TouchableOpacity
                onPress={async () => {
                  SpeechMod.stop();
                  try {
                    const lang = profile?.language === "it" ? "it-IT" : profile?.language || "it-IT";
                    await SpeechMod.speak(recapText, { language: lang, tone: "warm" });
                  } catch {}
                }}
                activeOpacity={0.7}
                testID="recap-text"
              >
                <Text style={styles.recapText}>{recapText}</Text>
                <Text style={styles.recapHint}>Tocca per sentirlo a voce</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* InfoModal — esempi dei comandi vocali che puoi chiedere a Coda */}
      <InfoModal
        visible={showInfo}
        onClose={() => setShowInfo(false)}
        aiName={profile?.ai_name || "Coda"}
        theme={theme}
      />

      {/* Seal Setup Modal — Parola Segreta per Confessionale Zero-Knowledge */}
      <SealSetupModal
        visible={showSealSetup}
        hasSeal={hasSeal}
        confessionalActive={confessionalMode}
        onClose={() => setShowSealSetup(false)}
        onSaved={() => {
          setHasSeal(true);
          setShowSealSetup(false);
          // Una volta impostata la parola, attiva subito il confessionale.
          setConfessionalMode(true);
        }}
        onCleared={() => {
          setHasSeal(false);
          forgetSessionKey();
          setShowSealSetup(false);
          // Se era attivo il confessionale, lascia attivo (fallback a ephemeral).
        }}
        styles={styles}
        theme={theme}
      />

      {/* Confessionale — Schermata d'ingresso (Manifesto V1).
          Niente Parola Segreta: si entra liberamente. Questa schermata fissa
          il "patto" della stanza prima di entrare. */}
      <Modal
        visible={showConfessionalIntro}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConfessionalIntro(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.88)", justifyContent: "center", alignItems: "center", padding: 28 }}>
          <View style={{ width: "100%", maxWidth: 420, backgroundColor: "#160C12", borderRadius: 24, borderWidth: 1, borderColor: "rgba(255,107,107,0.35)", padding: 28, alignItems: "center" }}>
            <Text style={{ fontSize: 40, marginBottom: 6 }}>🕯️</Text>
            <Text style={{ fontSize: 22, fontWeight: "700", color: "#FFE8E8", marginBottom: 16, letterSpacing: 0.3 }}>Il Confessionale</Text>
            <Text style={{ fontSize: 15.5, lineHeight: 24, color: "rgba(255,255,255,0.82)", textAlign: "center" }}>
              Qui non devi essere coerente con ciò che hai detto ieri.{"\n"}
              Non devi difendere una posizione.{"\n"}
              Non devi dimostrare nulla.{"\n"}
              Non devi essere la versione migliore di te stesso.{"\n"}{"\n"}
              Puoi semplicemente essere presente a ciò che senti oggi.{"\n"}
              Quello che condividi qui non verrà usato per definirti nelle conversazioni future.
            </Text>
            <TouchableOpacity
              onPress={() => { setShowConfessionalIntro(false); setConfessionalMode(true); }}
              style={{ marginTop: 24, backgroundColor: "#FF6B6B", paddingVertical: 14, paddingHorizontal: 48, borderRadius: 999 }}
              testID="confessional-enter"
            >
              <Text style={{ color: "#1A0A0F", fontWeight: "800", fontSize: 16 }}>Entra</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowConfessionalIntro(false)} style={{ marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 }}>
              <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Non ora</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* RadialGlow — alone radiale che parte dal blob (centro schermo)
          e si propaga verso i bordi. Coerente coi 3 colori del blob:
            🟡 Ambra      = idle/recording  (tocca a te / ti ascolto)
            💧 Verde acqua = thinking        (sto pensando)
            💜 Magenta    = speaking        (sto parlando io) */}
      <RadialGlow status={status as any} />

      {/* CONFESSIONALE — animazione di CHIUSURA (release / closure 2026-06 v4).
          Si attiva SEMPRE quando l'utente esce dal confessionale, sia dalla
          Home (solo Eclissi) sia dalla chat. Non è "distruzione", è "rilascio":
          respiro dell'eclissi → dissolvenza dell'ambiente → ritorno al
          presente. Durata ~1.7s. */}
      <FortezzaCloseEffect
        visible={showFortezzaWipe}
        scrimColor={theme.bg}
        orbColor="#7FE0C4"
        onComplete={() => {
          // WIPE: rimuovi tutte le voci marcate fortezza dalla timeline
          // (se non ce ne sono, è no-op — l'animazione gira comunque).
          setTimeline((prev) => prev.filter((e) => !e.fortezza));
          setShowFortezzaWipe(false);
          setConfessionalMode(false);
          // FIX 2026-06: reset del ref per la prossima sessione Fortezza
          fortezzaUsedThisSessionRef.current = false;
          // GHOST TOKEN: distruggi al wipe (Doppia Stanza 2026-06)
          confessionalGhostTokenRef.current = null;
        }}
      />

      {/* === SAFETY ALERT (giugno 2026) ====================================
          Si apre quando /api/safety/check rileva risk_detected=true.
          Mostra l'advisory di Koda + numeri italiani ufficiali cliccabili. */}
      <SafetyAlert
        visible={safetyVisible}
        result={safetyResult}
        onClose={() => {
          setSafetyVisible(false);
          setStatus("idle");
        }}
      />
    </View>
  );

  // Wrap the screen in a background image (custom upload) or gradient (preset),
  // with a dark overlay for legibility. If no background is set, just return
  // the plain inner view (uses theme.bg).
  // === SPLASH SCREEN ===
  // 4 secondi all'apertura: eclissi che respira colori + nome AI + tagline.
  // Maschera la latenza di boot e dà identità visiva all'app.
  if (showSplash) {
    return (
      <KodaSplash
        aiName={profile?.ai_name || null}
        duration={10000}
        onComplete={() => setShowSplash(false)}
      />
    );
  }
  // === KODA INTRO ===
  // Al primo avvio, e on-demand tramite l'icona ⋯ in alto a destra,
  // mostra la presentazione conversazionale di Koda PRIMA di qualsiasi
  // altra schermata. Quando l'utente la termina (o la salta), viene
  // persistito il flag `koda_intro_seen=1` in SecureStore.
  if (showColorIntro === true) {
    return (
      <KodaIntro
        voices={voiceList}
        currentVoiceId={profile?.settings?.tts_voice_id || null}
        onDone={dismissColorIntro}
        onCancel={cancelKodaIntro}
      />
    );
  }
  // Overlay bordeaux globale quando il confessionale è ATTIVO.
  // Tinge fortemente tutto lo sfondo (~40% di alpha) così l'utente capisce
  // a colpo d'occhio di trovarsi in modalità confessionale, anche durante
  // la conversazione vocale. Quando spegne il confessionale, l'overlay
  // sparisce e si torna allo sfondo normale.
  // === NEON BORDER ===
  // Bordo neon attorno allo schermo, perfettamente sincronizzato all'orb.
  // Mappatura 1:1 stato → colore (NeonBorder e EclipseOrb leggono dalla
  // stessa palette, vedi components/NeonBorder.tsx e EclipseOrb.tsx):
  //   - idle          → verde menta (#7DD3C0)
  //   - recording     → tiffany neon (#00F5D4)  [include sia manuale sia hands-free]
  //   - transcribing  → ciclamino (#EC4899)     [come thinking, l'orb usa THINK_PALETTE]
  //   - thinking      → ciclamino (#EC4899)
  //   - speaking      → viola elettrico (#BD10E0)
  //   - confessional  → scarlatto (#FF1744)
  // Priorità: confessional > stati di interazione > idle.
  const neonStatus: NeonBorderStatus = (() => {
    if (confessionalMode) return "confessional";
    if (status === "recording") return "recording";
    // Transcribing è visivamente equivalente a thinking (l'orb mostra
    // THINK_PALETTE in entrambi i casi) — il bordo lo segue.
    if (status === "transcribing" || status === "thinking") return "thinking";
    if (status === "speaking") return "speaking";
    return "idle";
  })();
  // Spessore del bordo (in pixel). Il glow vero arriva dal shadow,
  // non serve un bordo spesso: 2-4px sono perfetti.
  const neonThickness =
    neonStatus === "confessional" ? 4 :
    neonStatus === "idle" ? 2 :
    3;
  const neonBorderEl = (
    <NeonBorder status={neonStatus} thickness={neonThickness} />
  );

  // === ACTIVATION PULSE (idea 1) ===
  // Mostrato una sola volta dopo che il profilo è caricato e non c'è
  // KodaIntro/onboarding in corso. Effetto "sistema attivo" all'avvio.
  const activationPulseEl = (!activationPulseDone && profile && showColorIntro === false && !showOnboarding) ? (
    <ActivationPulse
      color="#8B5CF6"
      duration={1500}
      thickness={3}
      onComplete={() => setActivationPulseDone(true)}
    />
  ) : null;

  const confessionalTint = confessionalMode ? (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFillObject,
        { backgroundColor: "rgba(139,58,74,0.40)" },
      ]}
    />
  ) : null;

  // === TOUR OVERLAY ===
  // Stesso pattern del confessionalTint: variabile JSX da renderizzare in
  // tutti i rami finali (custom image / preset gradient / plain).
  const tourOverlay = tourActive ? (
    <KodaTour
      steps={tourSteps}
      onStepChange={(idx, step) => {
        setTourCurrentStep(step ? { idx, label: step.label, page: step.page } : null);
      }}
      // === FIX VOCE COERENTE TOUR (richiesta utente giugno 2026) ===
      // Prima usavamo solo tts_voice_id (campo legacy che KodaIntro NON
      // popola). Ora preferisco la mappatura da koda_voice (campo nuovo,
      // popolato in onboarding con "aria" o "echo") → ElevenLabs ID.
      // Fallback a tts_voice_id se koda_voice mancante.
      voiceId={(() => {
        const k = ((profile?.settings as any)?.koda_voice || "").toLowerCase();
        if (k === "aria" || k === "eco") return "tCOJUYBo86m5v7hppDc7"; // Koda Aria (femminile)
        if (k === "echo") return "dJwiFcjz9zW5Pge7G8AG"; // Koda Echo (maschile)
        return (profile?.settings as any)?.tts_voice_id || "tCOJUYBo86m5v7hppDc7";
      })()}
      onPageChange={(page) => {
        const w = tourDims.width;
        try {
          pagerRef.current?.scrollTo({
            x: page === "reading" ? w : 0,
            y: 0,
            animated: true,
          });
        } catch {}
      }}
      onComplete={() => {
        setTourActive(false);
        setTourSteps([]);
        // Riporta il pager alla pagina voce (zen) per pulizia.
        try {
          pagerRef.current?.scrollTo({ x: 0, y: 0, animated: true });
        } catch {}
      }}
    />
  ) : null;

  // === BACKGROUND PRESET/CUSTOM IMAGE DISABLED (richiesta utente 2026-06 #10) ===
  // Tutto rimosso: niente più sfondi custom, niente preset (notturno/aurora/carta).
  // L'unico "sfondo" è ora il bg del tema (giorno=bianco, notte=nero/blu).
  // Le seguenti var sono forzate sempre a null per cortocircuitare la logica
  // che renderizzava ImageBackground / LinearGradient quando bgValue era settato.
  if (isCustomImage || bgUri || bgPreset) {
    // ignorati intenzionalmente: il tema vince sempre
  }
  return (
    <View style={{ flex: 1 }}>
      {screenInner}
      {confessionalTint}
      {neonBorderEl}
      {activationPulseEl}
      {tourOverlay}
      {!tourActive && !confessionalMode ? <ProactiveOffer theme={theme} /> : null}
    </View>
  );
}

// =============== Sub components ===============

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <TouchableOpacity
      onPress={onToggle}
      style={[styles.toggle, on && styles.toggleOn]}
    >
      <View style={[styles.toggleKnob, on && styles.toggleKnobOn]} />
    </TouchableOpacity>
  );
}

// Map of preset bubble accent colors. User can pick one in Settings, or use
// any custom hex via the same field.
// Il preset "eclissi" è il colore IDENTITARIO di Koda: lo stesso viola che
// l'orb assume in stato idle/neutral (TONE_PALETTES.neutral in EclipseOrb).
// Vedere la bubble di Koda in viola identitario + l'orb in viola = unicità.
const BUBBLE_PRESETS: Record<string, { name: string; color: string; soft: string }> = {
  eclissi:      { name: "Eclissi",     color: "#8B5CF6", soft: "rgba(139,92,246,0.18)" },
  viola:        { name: "Viola",       color: "#7C3AED", soft: "rgba(124,58,237,0.18)" },
  verde_acqua:  { name: "Verde acqua", color: "#14B8A6", soft: "rgba(20,184,166,0.18)" },
  rosa:         { name: "Rosa",        color: "#EC4899", soft: "rgba(236,72,153,0.18)" },
  ambra:        { name: "Ambra",       color: "#F59E0B", soft: "rgba(245,158,11,0.18)" },
  ghiaccio:     { name: "Ghiaccio",    color: "#3B82F6", soft: "rgba(59,130,246,0.18)" },
};

function resolveBubbleColors(
  bubbleColor: string | undefined
): { color: string; soft: string } {
  // Default IDENTITARIO: il viola "eclissi" — esattamente il viola idle/
  // neutral dell'EclipseOrb. Bubble di Koda e orb si parlano visivamente.
  const key = bubbleColor || "eclissi";
  if (BUBBLE_PRESETS[key]) return BUBBLE_PRESETS[key];
  // Custom hex: derive a soft variant
  if (typeof key === "string" && key.startsWith("#")) {
    return { color: key, soft: key + "30" };
  }
  return BUBBLE_PRESETS.eclissi;
}

// === AIAvatar — round avatar shown next to AI bubbles. Uses a user-uploaded
// photo (data URI) when set, otherwise falls back to the pulsing MiniOrb.
function AIAvatar({ photo, color, size = 36 }: { photo?: string | null; color: string; size?: number }) {
  if (photo) {
    return (
      <View
        style={{
          width: size, height: size, borderRadius: 999,
          overflow: "hidden", marginRight: 8, marginBottom: 2,
          borderWidth: 1.5, borderColor: color,
          backgroundColor: "#000",
        }}
      >
        <Image source={{ uri: photo }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
      </View>
    );
  }
  return <MiniOrb color={color} />;
}

// === TypingDot — animated dot for "AI sta scrivendo" indicator
function TypingDot({ delay, color }: { delay: number; color: string }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, { toValue: 1, duration: 350, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 350, useNativeDriver: true }),
        Animated.delay(150),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [v, delay]);
  return (
    <Animated.View
      style={{
        width: 7, height: 7, borderRadius: 999, backgroundColor: color,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [2, -2] }) }],
      }}
    />
  );
}

// === MiniOrb — signature pulsing orb that brands the AI side of the chat
function MiniOrb({ color = "#7C3AED" }: { color?: string }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.6] });
  return (
    <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 8, marginBottom: 2 }}>
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          width: 32, height: 32, borderRadius: 999,
          backgroundColor: color,
          opacity: haloOpacity,
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] }) }],
          ...Platform.select({
            ios: { shadowColor: color, shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
            android: { elevation: 0 },
            default: { boxShadow: `0 0 14px ${color}` } as any,
          }),
        }}
      />
      <Animated.View
        style={{
          width: 14, height: 14, borderRadius: 999,
          backgroundColor: color,
          transform: [{ scale }],
        }}
      />
    </View>
  );
}

function Bubble({
  entry,
  onReplay,
  onGhost,
  aiAvatar,
  bubbleAccent,
  bubbleStyle,
  textOnBubble,
  textSize,
  aiFontFamily,
}: {
  entry: TimelineEntry;
  onReplay?: (e: TimelineEntry) => void;
  /** Long-press handler for "Ghost" / "Dimentica questo". */
  onGhost?: (e: TimelineEntry) => void;
  aiAvatar?: string | null;
  bubbleAccent: { color: string; soft: string };
  bubbleStyle: "glass" | "solid";
  textOnBubble: string;
  textSize: number; // scale multiplier (e.g. 0.85 / 1.0 / 1.15 / 1.35)
  /**
   * Optional handwritten font (Caveat) loaded async. When ready, AI replies
   * use it to evoke "scritto a mano da un amico", while the user's text
   * stays system-default. If not loaded yet, both fall back to system.
   */
  aiFontFamily?: string;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const isUser = entry.role === "user";
  const [showTime, setShowTime] = useState(false);

  // Compute backgrounds for both bubbles based on chosen style.
  // In SOLID mode both are opaque (block wallpaper for max readability).
  // In GLASS mode both are translucent (wallpaper shows through subtly).
  // === COLORE BUBBLE PER INTERLOCUTORE ===
  // Regola fondamentale: l'UTENTE e l'AI hanno SEMPRE colori distinti, sia
  // in modalità normale che confessionale, così "a colpo d'occhio" sai chi
  // ha parlato. In modalità "glass" l'alpha è leggermente più alta del
  // default per non confondere ambra-utente e viola-AI quando entrambe sono
  // semi-trasparenti.
  //
  // Confessionale:
  //   - utente → stesso colore familiare (theme.userBubble)
  //   - Koda   → bordeaux ceralacca (sigillo / risposta protetta)
  // Normale:
  //   - utente → theme.userBubble (colore "tuo" definito dal tema)
  //   - Koda   → bubbleAccent.color (colore impostato in Impostazioni)
  const isConfessional = !!entry.confessional;
  const confessionalColor = "#8B3A4A"; // sealing-wax burgundy
  const confessionalSoft = "#8B3A4A66"; // 40% alpha glass — più visibile
  // AI:
  const aiBg = isConfessional
    ? (bubbleStyle === "solid" ? confessionalColor : confessionalSoft)
    : (bubbleStyle === "solid" ? bubbleAccent.color : bubbleAccent.color + "66");
  // User (sempre col colore del tema, dentro e fuori confessionale):
  const userBg = bubbleStyle === "solid"
    ? theme.userBubble
    : theme.userBubble + "77"; // più saturo del precedente "55"
  const aiBorder = isConfessional ? confessionalColor : bubbleAccent.color;
  const userBorder = bubbleStyle === "solid" ? "transparent" : theme.userBubble;

  // === Diary aesthetic: each bubble is rotated by a tiny, deterministic
  //     amount derived from the entry id. Looks like the bubble was *placed*
  //     on a table, not aligned by a grid. AI tilts opposite of user so the
  //     conversation feels alternating.
  const rot = useMemo(() => {
    const seed = entry.id || entry.timestamp || "0";
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    // ±1.2° max — subtle, not gimmicky
    const base = ((h % 200) - 100) / 100; // -1..1
    const deg = base * 1.2;
    // Bias direction by role so AI vs user lean opposite ways
    return isUser ? Math.abs(deg) : -Math.abs(deg);
  }, [entry.id, entry.timestamp, isUser]);

  // Handwritten font ONLY for AI text. User text stays system (clean).
  const aiTextFontProps = aiFontFamily ? { fontFamily: aiFontFamily } : null;
  // Caveat sits visually larger at the same nominal size — bump line-height
  // a bit so descenders breathe.
  const aiTextSizeMultiplier = aiFontFamily ? 1.25 : 1;

  const wrapperPress = (cb: () => void) => ({
    onPress: cb,
    onLongPress: () => {
      // === Long-press → menu Ghost (Dimentica) o orario.
      //     Su tutte le entry permettiamo di "ghostare" il fatto: viene
      //     cancellato dal server e l'insegnamento viene preservato in
      //     memory_summary (vedi POST /api/ghost). Sull'AI consente di
      //     cancellare la sua risposta (utile per riformulare).
      if (onGhost) {
        Alert.alert(
          isUser ? "Questo messaggio" : "Risposta di Coda",
          isUser
            ? "Vuoi che dimentichi questo fatto? Cancellerò il messaggio dal server. Se ha valore, terrò solo l'insegnamento nella memoria."
            : "Vuoi cancellare questa risposta?",
          [
            { text: "Mostra orario", onPress: () => setShowTime((s) => !s) },
            {
              text: "Dimentica",
              style: "destructive",
              onPress: () => onGhost(entry),
            },
            { text: "Annulla", style: "cancel" },
          ]
        );
      } else {
        setShowTime((s) => !s);
      }
    },
    delayLongPress: 350,
  });

  return (
    <View
      style={[
        styles.bubbleRow,
        isUser ? styles.bubbleRowR : styles.bubbleRowL,
        { transform: [{ rotate: `${rot}deg` }] },
      ]}
    >
      {/* AIAvatar rimosso definitivamente (richiesta utente 2026-06): in
          text-mode l'avatar mini-orb di fianco ai messaggi di Koda non
          serve. Bilanciamento puro: messaggi Koda flush-left, messaggi
          utente flush-right, simmetria perfetta. */}
      <View style={{ maxWidth: "82%" }}>
        {isUser ? (
          <Pressable
            {...wrapperPress(() => setShowTime((s) => !s))}
            style={({ pressed }) => [
              styles.bubbleUser,
              { backgroundColor: userBg, borderColor: userBorder, borderWidth: bubbleStyle === "glass" ? 1 : 0 },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.bubbleUserText, { color: textOnBubble, fontSize: 15 * textSize, lineHeight: 21 * textSize }]}>{stripDisplayTags(entry.text || "")}</Text>
          </Pressable>
        ) : (
          <Pressable
            {...wrapperPress(() => {
              if (onReplay) onReplay(entry);
              else setShowTime((s) => !s);
            })}
            style={({ pressed }: any) => [
              styles.bubbleAi,
              { backgroundColor: aiBg, borderColor: aiBorder, borderWidth: bubbleStyle === "glass" ? 1 : 0 },
              pressed && { opacity: 0.78 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Tocca per ascoltare. Tocca di nuovo per fermare."
            testID={`replay-${entry.id}`}
          >
            <Text
              style={[
                styles.bubbleAiText,
                { color: textOnBubble, fontSize: 15 * textSize * aiTextSizeMultiplier, lineHeight: 21 * textSize * aiTextSizeMultiplier },
                aiTextFontProps,
              ]}
            >
              {stripDisplayTags(entry.text || "")}
            </Text>
            {entry.extracted?.amount ? (
              <Text style={[styles.extractMeta, { color: textOnBubble, opacity: 0.85 }]}>
                💶 {entry.extracted.amount}
                {entry.extracted.currency ? ` ${entry.extracted.currency}` : ""}
                {entry.extracted.item ? ` · ${entry.extracted.item}` : ""}
              </Text>
            ) : null}
            {entry.actions && entry.actions.length > 0 ? (
              <View style={styles.actionList}>
                {entry.actions.map((a, idx) => {
                  if (a.type !== "schedule_notification") return null;
                  const when = a.when_iso ? new Date(a.when_iso) : null;
                  const timeStr = when
                    ? when.toLocaleString([], {
                        hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit",
                      })
                    : "—";
                  return (
                    <View key={idx} style={styles.actionPill}>
                      <Text style={styles.actionEmoji}>🔔</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.actionTitle, { color: textOnBubble }]}>{a.title || "Promemoria"}</Text>
                        <Text style={[styles.actionSub, { color: textOnBubble, opacity: 0.75 }]}>
                          {a.label || timeStr}{a.body ? ` · ${a.body}` : ""}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </Pressable>
        )}
        {showTime ? (
          <Text style={[styles.bubbleTime, isUser ? { textAlign: "right" } : { textAlign: "left" }]}>
            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (t: any) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },

  // Header — ABSOLUTELY positioned, transparent. Messages scroll behind it.
  // NOTE: `top` is set INLINE in the JSX (using Math.max(insets.top + 16, 70))
  // — never put `top: 0` here, it conflicts with the inline override and
  // some RN/Expo Go versions don't merge it correctly.
  header: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 10,
    zIndex: 10,
  },
  // Riga 2 dell'header — toggle Confessionale isolato e centrato.
  // Stesso paddingHorizontal della riga 1 per allineamento verticale.
  confessionaleRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    zIndex: 10,
  },
  // Banner di conferma "Configurazione salvata ✓"
  savedBanner: {
    position: "absolute",
    alignSelf: "center",
    left: 40,
    right: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 24,
    backgroundColor: "rgba(16,185,129,0.18)",
    borderWidth: 1,
    borderColor: "rgba(52,211,153,0.5)",
    zIndex: 50,
  },
  savedBannerText: {
    color: "#A7F3D0",
    fontSize: 14,
    fontWeight: "600",
  },
  headerCenter: { flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 },
  // === Toggle Confessionale (lucchetto al centro dell'header) ===
  confessionalToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  confessionalToggleOn: {
    backgroundColor: "rgba(60,0,0,0.5)",
    borderColor: "#FCA5A5",
  },
  confessionalToggleText: {
    color: "#FFFFFFCC",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  dot: { width: 8, height: 8, borderRadius: 999, backgroundColor: t.success },
  headerTitle: {
    color: "#FFFFFF",
    fontWeight: "700",
    letterSpacing: 0.5,
    fontSize: 14,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  // Header buttons — totally transparent, no background, no border.
  // Just the icon (and label for "Sunto") with a soft text shadow for legibility.
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "transparent",
    paddingHorizontal: 4,
    paddingVertical: 6,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.6,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 1 },
      },
      android: { elevation: 0 },
      default: { textShadow: "0 1px 4px rgba(0,0,0,0.7)" } as any,
    }),
  },
  headerBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // Timeline — ScrollView extends FULL HEIGHT (no top/bottom bar squeezing it).
  timeline: { flex: 1 },
  // Top padding so first message doesn't hide under the absolute header.
  // Bottom padding handled inline (computed from insets + bottom bar height).
  timelineContent: { paddingHorizontal: 16, paddingTop: 70 },

  emptyState: {
    alignItems: "center",
    paddingHorizontal: 30,
    paddingVertical: 60,
  },
  emptyEmoji: { fontSize: 56, marginBottom: 16 },
  emptyTitle: {
    color: t.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
  },
  emptyText: {
    color: t.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },

  bubbleRow: { marginBottom: 14, flexDirection: "row", alignItems: "flex-end" },
  bubbleRowL: { justifyContent: "flex-start" },
  bubbleRowR: { justifyContent: "flex-end" },
  bubbleUser: {
    backgroundColor: t.userBubble,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 22,
    borderBottomRightRadius: 6,
    maxWidth: "100%",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 2 },
      default: { boxShadow: "0 2px 6px rgba(0,0,0,0.12)" } as any,
    }),
  },
  bubbleAi: {
    backgroundColor: t.aiBubbleBg,
    borderWidth: 1,
    borderColor: t.aiBubbleBorder,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 22,
    borderBottomLeftRadius: 6,
    maxWidth: "100%",
    ...Platform.select({
      ios: { shadowColor: t.primary, shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 1 },
      default: { boxShadow: `0 2px 10px ${t.primary}33` } as any,
    }),
  },
  bubbleUserText: { color: t.userBubbleText, fontSize: 15, lineHeight: 21, fontWeight: "500" },
  bubbleAiText: { color: t.aiBubbleText, fontSize: 15, lineHeight: 21 },
  bubbleTime: { color: t.textDim, fontSize: 10, marginTop: 4, paddingHorizontal: 4, opacity: 0.7 },

  // Day separator (Oggi / Ieri / Mercoledì 7 maggio)
  daySeparator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginVertical: 4,
  },
  daySepLine: {
    flex: 1,
    height: 1,
    backgroundColor: t.divider,
    opacity: 0.5,
  },
  daySepText: {
    color: t.textMuted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.8,
    textTransform: "lowercase",
    fontStyle: "italic",
  },

  domainPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 8,
  },
  domainEmoji: { fontSize: 11 },
  domainLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  extractMeta: {
    color: t.textMuted,
    fontSize: 12,
    marginTop: 8,
    fontWeight: "600",
  },

  actionList: { marginTop: 10, gap: 6 },
  actionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: t.primarySoftBg,
    borderColor: t.primarySoftBorder,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  actionEmoji: { fontSize: 18 },
  actionTitle: {
    color: t.primary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  actionSub: {
    color: t.textMuted,
    fontSize: 11,
    marginTop: 2,
  },

  // Bottom bar — quasi sempre trasparente per lasciare scorrere i messaggi
  // sotto; ma quando l'utente scrive, il textRow ha un suo background opaco
  // tramite styles.textRow (vedi sotto) per essere sempre leggibile.
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    backgroundColor: "transparent",
  },
  // === FIX 2026-06 (richiesta utente: "Come chiami l'amico nero, mettilo bianco") ===
  // Lo stile styles.input non era definito → TextInput "Come chiami l'amico"
  // usava il color default RN (nero) → illeggibile sul tema scuro. Aggiunto.
  input: {
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1,
    color: t.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    fontSize: 15,
  },
  errorText: { color: t.danger, fontSize: 12, textAlign: "center", marginTop: 8 },
  bigBtnArea: { alignItems: "center", paddingTop: 20, justifyContent: "center" },
  blobTap: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  blobOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    color: t.textDim,
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 18,
    letterSpacing: 0.3,
  },
  // When a custom background is set, give the status label a small dark
  // outline so it remains readable on light wallpapers.
  statusLabelOnBg: {
    color: "#FFFFFF",
    textShadowColor: "rgba(0,0,0,0.65)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  bigBtnWrap: {
    width: 200,
    height: 200,
    alignItems: "center",
    justifyContent: "center",
  },
  // Orb sits behind the mic button — pointer-events none so the button stays
  // tappable. Centered absolute fill, the Orb itself is sized via prop.
  orbBehindBtn: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // Soft neon glow underneath the button — kept tight (no big bloom anymore)
  neonGlow: {
    position: "absolute",
    width: 150,
    height: 150,
    borderRadius: 999,
    backgroundColor: t.primary,
    // Tighter shadows so the wallpaper isn't covered
    ...Platform.select({
      ios: {
        shadowColor: t.primary,
        shadowOpacity: 0.7,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 0 },
      web: {
        boxShadow: `0 0 22px 4px ${t.primary}`,
      } as any,
    }),
  },
  neonGlowSoft: {
    position: "absolute",
    width: 160,
    height: 160,
    borderRadius: 999,
    backgroundColor: t.primary,
    ...Platform.select({
      ios: {
        shadowColor: t.primary,
        shadowOpacity: 1.0,
        shadowRadius: 70,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 0 },
      web: {
        boxShadow: `0 0 90px 35px ${t.primary}`,
      } as any,
    }),
  },
  bigBtn: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: t.primary,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowColor: t.primary,
        shadowOpacity: 0.6,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 8 },
      web: {
        boxShadow: `0 0 18px 2px ${t.primary}`,
      } as any,
    }),
  },
  bigBtnRec: { backgroundColor: t.danger },
  altBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  altBtnText: { color: t.textMuted, fontSize: 12 },

  // Text input mode — banda visibile sopra tutto. Ha un proprio
  // backgroundColor opaco (pill-shape) così che, anche quando galleggia
  // sopra una timeline scrollabile, sia sempre perfettamente leggibile.
  textRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 10,
    backgroundColor: "rgba(15, 23, 42, 0.92)",
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    // Shadow: stacca visivamente la banda dallo sfondo (timeline scorre
    // sotto, ma la banda rimane "in alto" sul piano Z).
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 12,
  },
  textIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: t.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  textInput: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.18)",
    borderWidth: 1,
    color: "#FFFFFF",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    fontSize: 15,
    minHeight: 42,
    maxHeight: 100,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: t.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnActive: {
    // === FIX EVIDENZIAZIONE PULSANTE INVIO (giugno 2026 #6) ===
    // L'utente segnalava che il pulsante non si "evidenzia" quando
    // c'è del testo. Aggiungiamo un alone/ombra brillante + bordo
    // luminoso quando attivo per renderlo nettamente più visibile.
    shadowColor: t.primary,
    shadowOpacity: 0.7,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.4)",
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  onboardCard: {
    backgroundColor: t.surface,
    borderRadius: 24,
    padding: 26,
    width: "100%",
    maxWidth: 380,
    alignItems: "center",
    borderWidth: 1,
    borderColor: t.border,
  },
  onboardEmoji: { fontSize: 50, marginBottom: 8 },
  onboardTitle: {
    color: t.text,
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
  },
  onboardText: {
    color: t.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 22,
  },
  langGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 10,
    marginBottom: 18,
  },
  langBtn: {
    backgroundColor: t.primarySoftBg,
    borderColor: t.primarySoftBorder,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    alignItems: "center",
    gap: 4,
    minWidth: 92,
  },
  langEmoji: { fontSize: 22 },
  langLabel: { color: t.text, fontSize: 12, fontWeight: "600" },
  onboardFoot: { color: t.textDim, fontSize: 11, textAlign: "center" },

  settingsCard: {
    backgroundColor: t.surface,
    borderRadius: 24,
    padding: 22,
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderColor: t.border,
    maxHeight: "92%",
  },
  settingsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  settingsTitle: { color: t.text, fontSize: 18, fontWeight: "700" },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 14,
  },
  settingLabel: { color: t.text, fontSize: 14, fontWeight: "600" },
  settingHint: { color: t.textDim, fontSize: 12, marginTop: 3 },
  divider: { height: 1, backgroundColor: t.divider, marginVertical: 8 },

  settingsSubtitle: {
    color: t.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 6,
    marginBottom: 8,
  },
  settingsMemory: {
    color: t.text,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: t.surfaceAlt,
    padding: 12,
    borderRadius: 10,
    minHeight: 50,
  },
  confidenceRow: { marginTop: 14 },
  confidenceLabel: { color: t.textMuted, fontSize: 12, marginBottom: 6 },
  confidenceBar: {
    height: 6,
    borderRadius: 999,
    backgroundColor: t.surfaceAlt,
    overflow: "hidden",
  },
  confidenceFill: {
    height: "100%",
    backgroundColor: t.primary,
  },

  dangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: t.isDark ? "rgba(248,113,113,0.08)" : "#FEE2E2",
    borderColor: t.isDark ? "rgba(248,113,113,0.3)" : "#FCA5A5",
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 6,
  },
  dangerBtnText: { color: t.danger, fontWeight: "600", fontSize: 13 },
  dangerHint: {
    color: t.textDim,
    fontSize: 11,
    textAlign: "center",
    marginTop: 6,
  },
  // === Promessa di Ferro: clausola di privacy in app ===
  promessaBox: {
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    borderRadius: 14,
    padding: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "rgba(252,165,165,0.25)",
  },
  promessaText: {
    color: t.primaryText,
    fontSize: 13,
    lineHeight: 19,
    opacity: 0.92,
  },

  toggle: {
    width: 46,
    height: 28,
    borderRadius: 999,
    backgroundColor: t.surfaceAlt,
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: t.primary },
  toggleKnob: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: t.text,
  },
  toggleKnobOn: {
    backgroundColor: t.primaryText,
    transform: [{ translateX: 18 }],
  },

  modeRow: { flexDirection: "row", gap: 6, marginTop: 4 },

  // Live meter visualization (debug)
  meterWrap: {
    width: 220,
    alignItems: "center",
    marginBottom: 12,
    gap: 4,
  },
  meterBar: {
    width: "100%",
    height: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.18)",
    overflow: "hidden",
    position: "relative",
  },
  meterFill: {
    height: "100%",
    borderRadius: 999,
  },
  meterThreshold: {
    position: "absolute",
    top: -2,
    width: 2,
    height: 12,
    backgroundColor: "#FFFFFF",
    opacity: 0.9,
  },
  meterLabel: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Avatar picker (AI photo)
  avatarRow: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 8 },
  avatarPickBtn: { width: 64, height: 64, position: "relative" },
  avatarPickImg: {
    width: 64, height: 64, borderRadius: 999,
    borderWidth: 2, borderColor: t.primary,
  },
  avatarEditBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: t.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: t.surface,
  },

  // === Background picker (sfondo)
  bgRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  bgChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surfaceAlt,
  },
  bgChipPlain: {},
  bgChipUpload: {
    borderColor: t.primary,
    borderStyle: "dashed",
  },
  bgChipActive: {
    borderColor: t.primary,
    backgroundColor: t.primarySoftBg,
  },
  bgChipText: { color: t.text, fontSize: 11, fontWeight: "600" },
  bgSwatch: {
    width: 16, height: 16, borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
  bgDimRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    paddingHorizontal: 4,
  },
  bgDimLabel: { color: t.textMuted, fontSize: 12, fontWeight: "600" },
  bgDimCtrl: { flexDirection: "row", gap: 8 },
  bgDimDot: {
    width: 28, height: 28, borderRadius: 999,
    borderWidth: 1.5, borderColor: t.border,
    alignItems: "center", justifyContent: "center",
    backgroundColor: t.surfaceAlt,
  },
  bgDimDotActive: { borderColor: t.primary },
  bgDimDotInner: {
    width: 18, height: 18, borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderRadius: 14,
  },
  modeBtnActive: {
    backgroundColor: t.primary,
    borderColor: t.primary,
  },
  modeBtnText: {
    color: t.text,
    fontSize: 12,
    fontWeight: "600",
    flexShrink: 1,
  },
  modeBtnTextActive: {
    color: t.primaryText,
  },

  // Voice selector
  settingsHint: {
    color: t.textDim,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 10,
    marginTop: 2,
  },
  voicesList: {
    gap: 8,
    marginTop: 4,
  },
  voiceCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  voiceCardActive: {
    borderColor: t.primary,
    backgroundColor: t.primarySoftBg,
  },
  voiceCardLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  voiceDot: {
    width: 14,
    height: 14,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: t.border,
    backgroundColor: "transparent",
  },
  voiceName: {
    color: t.text,
    fontSize: 14,
    fontWeight: "700",
  },
  voiceGender: {
    color: t.textMuted,
    fontSize: 13,
    fontWeight: "500",
  },
  voiceDesc: {
    color: t.textDim,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  voicePlayBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.primarySoftBg,
    borderWidth: 1,
    borderColor: t.primarySoftBorder,
  },

  // Theme picker
  themeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  themeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
  },
  themeBtnActive: {
    backgroundColor: t.primarySoftBg,
    borderColor: t.primary,
  },
  themeSwatch: {
    width: 14,
    height: 14,
    borderRadius: 999,
  },
  themeBtnText: {
    color: t.text,
    fontSize: 12,
    fontWeight: "600",
  },

  hoursRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  hourBox: {
    flex: 1,
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  hourLabel: {
    color: t.textMuted,
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  hourCtrl: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  hourBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: t.primarySoftBg,
    alignItems: "center",
    justifyContent: "center",
  },
  hourValue: {
    color: t.text,
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
    textAlign: "center",
  },

  recapCard: {
    backgroundColor: t.surface,
    borderRadius: 24,
    padding: 22,
    width: "100%",
    maxWidth: 420,
    minHeight: 160,
    borderWidth: 1,
    borderColor: t.border,
  },
  recapText: { color: t.text, fontSize: 15, lineHeight: 22 },
  recapHint: { color: t.textDim, fontSize: 12, marginTop: 12, fontStyle: "italic" },
  recapPlayBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: t.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});

