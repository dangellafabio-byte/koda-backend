import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
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
  Linking,
  BackHandler,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TouchableOpacity as GHTouchableOpacity } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import HandsFreeOrb from "../components/HandsFreeOrb";
import { FlashList } from "@shopify/flash-list";
import LatencyOverlay from "../components/LatencyOverlay";
import { traceStart, traceMark } from "../lib/latencyTracer";
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
import { checkHasSpeech, logGateDecision } from "../lib/silenceGate";
import { SpeechMod, unlockSpeech, setDefaultVoiceId, preloadFillerPool } from "../lib/speech";
// Rimosso import kodaAudioOutput (Modalità Telefono rollback 2026-07-13)
import { preloadOfflineClips, isOfflineNow, playRandomOfflineClip } from "../lib/offlineClips";
import { startThinkingSound, stopThinkingSound } from "../lib/thinkingSound";
import { classifyEmotion, classifyIntent, secureWipeStrings } from "../lib/emotionClassifier";
import {
  loadProfileCache,
  saveProfileCache,
  loadTimelineCache,
  saveTimelineCache,
} from "../lib/localCache";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
// import { BUILD_VERSION, BUILD_NOTES } from "../lib/buildInfo";
// ↑ Rimosso dall'UI Impostazioni pre-lancio (2026-07-24): il changelog
//   tecnico non deve trapelare in produzione. buildInfo.ts resta come
//   file di riferimento interno per debug/log, ma non è più renderizzato.
import FortezzaCloseEffect from "../components/FortezzaCloseEffect";
import { scheduleAt, scheduleCheckin, cancelAllCheckins, cancelCheckin } from "../lib/notifications";
import { useTheme, THEME_LIST, ThemeName, Palette } from "../lib/theme";
import AppIcon from "../lib/AppIcon";
import Orb, { OrbTone } from "../components/Orb";
import EclipseOrb from "../components/EclipseOrb";
import MirrorPool from "../components/MirrorPool";
import KodaIntro, { KodaIntroResult } from "../components/KodaIntro";
import KodaSplash from "../components/KodaSplash";
import TrialTestPanel from "../components/TrialTestPanel";import KodaTour, { TourStep } from "../components/KodaTour";
import DisclaimerScreen from "../components/DisclaimerScreen";
import * as ScreenDimmer from "../lib/screenDimmer";
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
import {
  loadBorderCalibration,
  saveBorderCalibration,
  resetBorderCalibration,
  ALT_IDLE_COLOR,
  DEFAULT_CALIBRATION,
  type BorderCalibration,
} from "../lib/borderCalibration";
import { useRouter } from "expo-router";
import type { SafetyCheckResult, FreemiumStatus as FreemiumStatusType } from "../lib/api";
import { useOrbAmbient } from "../lib/useOrbAmbient";
import { useRenderCounter, startFpsMonitor } from "../lib/perfDiag";
import { useFonts } from "expo-font";
// === Caveat font (Fabio 2026-06-21 v15): caricato via expo-font + file
// .ttf locali in assets/fonts/. Sostituisce @expo-google-fonts/caveat che
// era vietato dal sistema Emergent (build pipeline lo blocca). Stesso
// risultato visivo, zero dipendenza da package esterno.
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

// === VOICE → SPEAKING COLOR (2026-06) ===
// Mappa l'identità della voce scelta al colore mostrato durante "speaking".
// Il colore diventa l'identità visiva della voce: niente nomi sul selettore,
// solo cerchi colorati. Tocca = preview audio.
//
//   Acqua (femminile)  → viola elettrico  #BD10E0
//   Vento (maschile)   → cobalto vivo     #2563EB
//
// Gli stati Recording (#00F5D4 tiffany) e Thinking (#EC4899 ciclamino)
// restano FISSI per garantire la leggibilità dello stato a colpo d'occhio.
// Solo "speaking" cambia colore in base alla voce.
const VOICE_ID_ACQUA = "6TngzmzM89jJ3Y2Yiywr";
const VOICE_ID_VENTO = "ll9WG7PDTuyHwgC5MD6g";
const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7"; // 2026-07-13: nuova voce femminile ufficiale Koda

const VOICE_SPEAKING_COLORS: Record<string, string> = {
  [VOICE_ID_ACQUA]: "#BD10E0", // viola elettrico (default storico)
  [VOICE_ID_VENTO]: "#2563EB", // cobalto vivo
  [VOICE_ID_CIELO]: "#BD10E0", // viola elettrico (voce femminile Cielo — allineato a schema femminile=viola)
};

// Palette [bright, mid, deep] per l'EclipseOrb durante speaking.
// Acqua = palette warm originale (viola). Vento = palette cobalto.
const VOICE_SPEAKING_PALETTES: Record<string, [string, string, string]> = {
  [VOICE_ID_ACQUA]: ["#E9D5FF", "#BD10E0", "#7E22CE"],
  [VOICE_ID_VENTO]: ["#93BBFD", "#2563EB", "#1E3A8A"],
  [VOICE_ID_CIELO]: ["#E9D5FF", "#BD10E0", "#7E22CE"], // stessa palette viola di Acqua
};

function getVoiceSpeakingColor(voiceId: string | undefined | null): string | undefined {
  if (!voiceId) return undefined;
  return VOICE_SPEAKING_COLORS[voiceId];
}
function getVoiceSpeakingPalette(voiceId: string | undefined | null): [string, string, string] | null {
  if (!voiceId) return null;
  return VOICE_SPEAKING_PALETTES[voiceId] || null;
}

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

// === FIX #11 (2026-06-22 v8) ===
// Variante "soft" di stripDisplayTags per il PERCORSO TTS DEL REPLAY.
// Quando ri-giochi un messaggio AI già nella timeline, vogliamo che
// ElevenLabs riproduca con la STESSA prosody della prima riproduzione,
// inclusi gli audio tags `[sigh]`, `[laughs]`, `[whispered]` che il
// backend mette esplicitamente in `voice_text` (vedi server.py:1009).
// stripDisplayTags rimuoveva TUTTI i bracket tag → prosody piatta al replay.
// Questa funzione rimuove SOLO il meta-marker `[TONE:xxx]` (= nostro tag
// interno, non interpretato da ElevenLabs) preservando gli audio tags.
function stripToneMarkerOnly(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[\s*TONE\s*:\s*[a-zA-Z_\-]+\s*\]\s*/gi, "")
    .replace(/  +/g, " ")
    .trim();
}

// === FIX 2026-07-03 v45 CLIENT-SIDE (Fabio "Sentiamo dopo non chiude") ===
// Heuristica close_session lato CLIENT — defense-in-depth per quando il
// backend non ha ancora ricevuto il fix v45 (redeploy pending o problemi
// deployment Emergent). Il client, ricevendo `stt_final` con la
// trascrizione, checka se contiene un pattern di congedo inequivocabile.
// Se sì, forziamo `closeSessionPauseRef.current = true` — così il
// HF_LOOP guard blocca la ripartenza automatica del mic anche se il
// backend manda `close_session: false`.
// NOTA: la logica va lasciata in sync con `close_patterns` in
// backend/server.py (`_fast_pipeline_task`, ~riga 9385). Se aggiungi
// pattern nuovi qui, aggiungili anche là (e viceversa).
function detectCloseSessionClientSide(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const userLc = " " + text.toLowerCase().trim() + " ";
  // === FIX 2026-07-24 — false positive "ciao koda" ===
  // Alcuni pattern sono ambigui: "ciao koda" può essere APERTURA o CHIUSURA.
  // Se il testo intero è LUNGO (>4 parole con contenuto oltre al saluto),
  // è quasi certamente un'apertura ("ciao koda come stai? volevo dirti...").
  // Solo se il testo è breve (max 3-4 parole totali) consideriamo "ciao/notte
  // koda/coda" come saluto di chiusura reale.
  const wordCount = text.trim().split(/\s+/).length;
  const isShortUtterance = wordCount <= 4;
  const patterns: RegExp[] = [
    /\bci sentiamo (dopo|più tardi|poi|domani)\b/,
    /\bsentiamo (dopo|poi|domani|più tardi|dopo dai|dopo grazie)\b/,
    /\brisentiamo (dopo|poi|domani|più tardi)\b/,
    /\b(ok |va bene )?ci risentiamo\b/,
    /\ba dopo\b/,
    /\ba più tardi\b/,
    /\ba presto\b/,
    /\ba domani\b/,
    /\bci aggiorniamo\b/,
    /\bbuonanotte\b/,
    /\bbuona notte\b/,
    /\bbuona giornata\b/,
    /\bbuona serata\b/,
    /\bvado a (letto|dormire|riposare)\b/,
    /\bvado che (ho|devo)\b/,
    /\bora (vado|scappo|chiudo)\b/,
    /\bbasta per (oggi|ora|adesso)\b/,
    /\bmi fermo qui\b/,
    /\bchiudo qui\b/,
    /\bgrazie (koda|coda),? (ora )?chiudo\b/,
    /\b(ok|va bene|vabbè) (dai )?ci sentiamo\b/,
    /\bgrazie di tutto\b/,
    /\bgrazie (mille )?(davvero |per )?(tutto|ora)\b/,
    /\b(ok |va bene |vabbè )?dai ciao\b/,
    /\bora ti saluto\b/,
    /\bti saluto (koda|coda|adesso|ora)?\b/,
    /\bok basta (dai|per )?(oggi|ora|adesso)?\b/,
    /\b(ci vediamo|ci becchiamo) (dopo|domani|poi|più tardi)\b/,
    /\bstacco (ora|adesso|qui)?\b/,
    /\btelefono dopo\b/,
    /\bchiamo dopo\b/,
    /\bti richiamo\b/,
    /\bmi lasci (in pace|solo|un attimo)\b/,
    /\bok basta parlare\b/,
    /\btaci (un attimo|un po|per favore)?\b/,
  ];
  // Pattern AMBIGUI — solo se short utterance (evita false positive tipo
  // "ciao coda come stai" o "grazie coda mi hai aiutato tanto")
  const ambiguousPatterns: RegExp[] = [
    /\bciao (koda|coda)\b/,
    /\bnotte (koda|coda)\b/,
    /\barrivederci (koda|coda)?\b/,
    /\bgrazie (koda|coda)$/,
    /\bok grazie (koda|coda)?\b/,
  ];
  for (const pat of patterns) {
    if (pat.test(userLc)) return true;
  }
  if (isShortUtterance) {
    for (const pat of ambiguousPatterns) {
      if (pat.test(userLc)) return true;
    }
  }
  return false;
}



export default function Taccuino() {
  // === v64.14 PROFILING — conta render del root e attiva FPS monitor
  // (attivi solo con EXPO_PUBLIC_KODA_PERF_DIAG=1)
  useRenderCounter("KODA_PERF_ROOT");
  useEffect(() => {
    startFpsMonitor();
  }, []);
  const insets = useSafeAreaInsets();
  const { theme, themeName, setThemeName, setHours, dayStart, nightStart } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  // === ORB MEASURE 2026-08 (debug parity home ↔ intro) ===
  // measureInWindow ci dà le coordinate assolute dell'orb rispetto alla
  // viewport. Utente le legge sull'overlay in basso a sinistra e me le
  // riporta per calcolare l'offset esatto rispetto all'intro. NON stimare,
  // MISURARE.
  // === Rimozione debug orb-measure (Fabio 2026-08-12) ==========
  // Prima c'era un overlay in basso a sinistra che mostrava y/h/cY
  // dell'orb Home per calibrare la posizione. Non serve più: layout
  // ora è stabile. Rimosso overlay, state, callback e ref associati.

  // === DISCLAIMER blocking overlay (Fabio 2026-07-28) =========================
  // `disclaimerState`:
  //   'loading'  → chiamata /legal/disclaimer/status in corso (nascondi UI)
  //   'blocking' → utente non ha accettato (o versione diversa) → mostra overlay
  //   'accepted' → utente ha accettato la versione corrente → render app normale
  // Al boot facciamo un GET al backend per capire lo stato reale.
  // Su errore di rete assumiamo 'accepted' (fail-open): meglio mostrare l'app
  // che bloccarla se il backend non risponde — l'utente potrà accettare
  // al prossimo boot quando la connessione torna.
  const [disclaimerState, setDisclaimerState] = useState<
    "loading" | "blocking" | "accepted"
  >("loading");
  const [status, _setStatusRaw] = useState<Status>("idle");
  // === ORB SILENCE SYNC (Task 2 — Fabio 2026-08) ===
  // Toggle in tempo reale che segue i silenzi RMS della TTS di Koda.
  // `true` = sta parlando davvero → orb pulsa normale.
  // `false` = silenzio percepito (respiro/pausa) → orb smorza la pulsazione.
  // Fallback: se il server non manda `speech_timeline` questo resta `true`
  // per tutto il turno → orb comportamento attuale (nessuna regressione).
  const [speechActive, setSpeechActive] = useState<boolean>(true);
  // === FIX 2026-06-28 v32 — DIAG STATUS TRACING ===
  // Wrapper su setStatus per loggare OGNI transizione di stato con
  // timestamp + caller. Cruciale per diagnosticare il bug Android
  // "l'orb torna a idle subito senza mai mostrare thinking/speaking".
  // Il log esce nel formato:
  //   [KODA_STATUS] prev=recording → next=idle caller=finally:voiceStreamConverse t+12345ms
  // Permette di vedere ESATTAMENTE chi mette idle prematuro.
  const statusTraceStartRef = useRef<number>(Date.now());
  const statusRef = useRef<Status>("idle");
  // === Debug verbose flag (post-debug 2026-06-28) ===
  // Default false: log puliti. Si attiva via EXPO_PUBLIC_KODA_DEBUG_VERBOSE=true
  // in .env per troubleshooting (necessita rebuild).
  const KODA_DEBUG_VERBOSE =
    process.env.EXPO_PUBLIC_KODA_DEBUG_VERBOSE === "true";
  const setStatus = useCallback((next: Status, caller?: string) => {
    const prev = statusRef.current;
    if (prev !== next) {
      try {
        // Stack trace: 1 riga in produzione, 4 righe in debug verbose.
        const stack = new Error().stack || "";
        const lines = stack.split("\n")
          .slice(1, KODA_DEBUG_VERBOSE ? 6 : 3)
          .map((s) => s.trim().slice(0, 100))
          .filter((s) => s.length > 0);
        const tag = caller || (
          KODA_DEBUG_VERBOSE
            ? lines.slice(0, 4).join(" ← ")
            : (lines[1] || lines[0] || "?")
        );
        console.log(
          `[KODA_STATUS] ${prev} → ${next} t+${Date.now() - statusTraceStartRef.current}ms caller=${tag}`
        );
      } catch {}
    }
    statusRef.current = next;
    _setStatusRaw(next);
  }, [KODA_DEBUG_VERBOSE]);

  // === ORB SILENCE SYNC — reset speechActive quando Koda smette di
  // parlare. Se il turno finisce a metà (per errore/interrupt/close),
  // vogliamo comunque tornare all'orb "attivo" così il prossimo turno
  // parta pulito, non con una pulsazione smorzata residua.
  useEffect(() => {
    if (status !== "speaking" && speechActive === false) {
      setSpeechActive(true);
    }
  }, [status, speechActive]);

  // === BUILD VERSION TAG 2026-06-28 v35 ===
  // Logga una sola volta all'avvio una stringa identificativa della build.
  // Se vediamo questa riga nei log diag, sappiamo che l'APK installato
  // contiene davvero le modifiche v35 (BYPASS + TTS_STOP + TTS_LOOP +
  // AppState guard + verbose AppState log + anomaly detection).
  // Se NON vediamo questa riga, l'APK è stantio o la build non ha
  // inglobato l'ultimo commit.
  //
  // 🚨 IMPORTANTE (Fabio 2026-07-29): la costante KODA_BUILD_SHORT_TAG viene
  // usata SIA nel console.log SIA nel display in Impostazioni (~riga 6552).
  // In passato c'era una stringa hardcoded separata in Impostazioni che
  // rimaneva "v64.4-client-voice-id-ws" anche dopo aggiornamenti del vero
  // buildtag → l'utente pensava che la build non contenesse i fix mentre
  // in realtà erano dentro. Ora l'unica fonte di verità è QUI SOPRA.
  const KODA_BUILD_SHORT_TAG = "build-v64.17-radialglow-no-pulse";
  const KODA_BUILD_DATE = "2026-08-01";
  useEffect(() => {
    console.log(
      `[KODA_BUILDTAG] ${KODA_BUILD_SHORT_TAG} v64.3-voice-change-diag+railway-hardcoded+diag-card+ws-piggyback build=${KODA_BUILD_DATE} ` +
        `verbose=${KODA_DEBUG_VERBOSE} ` +
        `features=ANOMALY,STATUS,APPSTATE_GUARD,TAP_STOP_SERVER_WAIT,TAP_STOP_EARLY_REF,LONGPRESS_KILLSWITCH,MANUAL_AUDIO_OUTPUT_BUTTON_2STATE,STT_MODE_DEFAULT_V54,LATENCY_FIX_NO_SETACTIVE_TOGGLE,SPEAKER_OVERRIDE_REAPPLY_V55,BG_AUDIO_IOS,WHISPER1_FALLBACK,ANTI_HALLUCINATION_V3,PROFILE_DATETIME_COERCION_V57,SYNTHETIC_DONE_V57,AUTH_REFRESH_NO_WIPE_V57,PREVIEW_URL_V57,RAILWAY_URL_HARDCODED_V60,BANDPASS_300_3400HZ_V60,VOICECHAT_MODE_V56,KODA_GET_AUDIO_STATE_V63_3,PLUGIN_LOUD_FAIL_V63_4,ABORT_PRE_RECOGNITION_V63_5_FIX_A,MIC_ACTIVATION_GATE_V63_5_FIX_B,GPS_CACHE_FIRST_V63_7,TTS_AUDIOFOCUS_CYCLE_V63_8_FIX_C1,PRE_STT_AUDIOFOCUS_CYCLE_V63_9_FIX_C2,BREATH_REENABLED_V64_0,TAP_TO_RESET_UNIFIED_V64_0,ANDROID_MIC_WATCHDOG_V64_0,ANDROID_STT_PRE_ABORT_V64_0,KEEP_AWAKE_STABLE_SESSION_V64_0,NEONBORDER_SLOW_ANDROID_V64_1,ANDROID_CONTINUOUS_NO_BEEP_V64_1,ANDROID_SILENCE_TIMEOUT_LONGER_V64_1,ANDROID_NOSPEECH_GRACEFUL_V64_1,PREVIEW_AUDIO_FOCUS_REACQUIRE_V64_1,INTRO_VOICE_PREVIEW_FOCUS_V64_1,LASCIA_ANDARE_ORB_ALWAYS_RECORDING_V64_2,VOICE_ID_KODA_VOICE_SYNC_V64_2,DISCLAIMER_OVERLAY_V64_5,SCREEN_DIMMER_V2_FIX_V64_6,NOSPEECH_BACKOFF_V64_7,NEONBORDER_STATIC_V64_10,NEONBORDER_NO_ELEVATION_V64_11,NEONBORDER_DYNAMIC_RADIUS_V64_11,DIAGNOSTICS_SAFEAREA_XIAOMI_V64_12,NEONBORDER_INSTANT_COLOR_SYNC_V64_13,BUBBLE_MEMO_V64_14,PERF_DIAG_V64_14,SCROLLPEEK_REF_FIX_V64_15,RADIALGLOW_OFF_ANDROID_V64_16,RADIALGLOW_NO_PULSE_V64_17${KODA_DEBUG_VERBOSE ? ",BYPASS,TTS_LOOP,TTS_STOP" : ""}`
    );
  }, []);

  // === DISCLAIMER — check al boot (Fabio 2026-07-28) =========================
  // Chiama /legal/disclaimer/status per capire se mostrare l'overlay blocking.
  // Fail-open in caso di errore: se il backend è irraggiungibile mostriamo
  // comunque l'app, l'accettazione si potrà fare al prossimo boot online.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await api.getDisclaimerStatus();
        if (cancelled) return;
        setDisclaimerState(st.needs_acceptance ? "blocking" : "accepted");
      } catch (e) {
        console.warn("[DISCLAIMER] status check failed, fail-open:", e);
        if (!cancelled) setDisclaimerState("accepted");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
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
      // === SKIP-SPLASH-AFTER-INTRO (2026-08-11, Fabio) ===
      // Se l'utente arriva dall'Intro V2 (che ha appena vissuto 10 minuti di
      // esperienza identitaria), skippa il KodaSplash da 10s per non
      // interrompere la continuità. Il flag è un timestamp con TTL 60s:
      // se troppo vecchio (crash tra fine intro e boot, o normale apertura
      // dopo giorni), viene ignorato. In OGNI caso il flag viene cancellato
      // qui, così non può restare appeso oltre il primo boot successivo.
      try {
        const raw = await SecureStore.getItemAsync("koda_intro_completed_at");
        if (raw) {
          // Cancella SEMPRE (anche se ignoriamo poi il valore): garanzia
          // one-shot che sopravvive a qualsiasi race/crash.
          try { await SecureStore.deleteItemAsync("koda_intro_completed_at"); } catch {}
          const ts = parseInt(raw, 10);
          if (!Number.isNaN(ts) && Date.now() - ts < 60_000) {
            if (!cancelled) setShowSplash(false);
          }
        }
      } catch {
        // safe fallback: splash normale
      }
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
          // === FIX 2026-06-27 v18 (Android Xiaomi: Impostazioni mostra solo Acqua) ===
          // Il backend ritorna `{"voices": [...], "enabled": true}` (oggetto)
          // ma il client controllava `Array.isArray(v)` direttamente sul body
          // → il check falliva → `voiceList` restava vuoto → la UI di
          // Impostazioni mostrava solo la voce di default (Acqua) senza
          // possibilità di scegliere Vento. Ora supportiamo entrambi i
          // formati per retrocompatibilità.
          let voices: any[] = [];
          if (Array.isArray(v)) {
            voices = v;
          } else if (v && Array.isArray(v.voices)) {
            voices = v.voices;
          }
          if (!cancelled && voices.length > 0) setVoiceList(voices);
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

  // === ADMIN WHITELIST MINI-PANEL (2026-07-24 pre-paywall) ===
  // Solo l'owner (Fabio) vede la sezione admin nelle Impostazioni per
  // gestire la whitelist "unlimited". Verificato via GET /api/admin/whoami
  // al boot; is_admin=false per tutti gli altri. Vedi PAYWALL_POLICY.md.
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [adminUnlimitedList, setAdminUnlimitedList] = useState<
    Array<{ email: string; uid: string; added_by: string; added_at: string; note?: string | null }>
  >([]);
  const [adminAddEmail, setAdminAddEmail] = useState<string>("");
  const [adminAddNote, setAdminAddNote] = useState<string>("");
  const [adminBusy, setAdminBusy] = useState<boolean>(false);
  const [adminError, setAdminError] = useState<string | null>(null);
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
    const userNameRaw = (profile?.user_name || "").trim();
    // === FIX 2026-07 (utente) — niente più fallback "amico" nei testi tour ===
    // Prima usavamo `profile?.user_name || "amico"`. Se l'utente non aveva
    // ancora inserito il nome, il tour lo chiamava "amico" — sensazione
    // fredda e generica. Ora costruiamo un vocativo opzionale che si
    // aggiunge SOLO se il nome è davvero presente.
    const userName = userNameRaw || "";
    const nameVocative = userNameRaw ? `, ${userNameRaw}` : "";
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
        speech: `Questa è la modalità mani libere${nameVocative}. Quando è attiva ti ascolto io. Toccala per fermarla.`,
      },
      {
        page: "voice",
        rect: confRect,
        // === FIX 2026-07-17 — Rinomina "Stanza dello Sfogo" → "Lascia andare" ===
        // Nuovo concept "Un posto dove nessuno risponde": zero rete, VAD
        // locale, orb come feedback silenzioso.
        label: "Lascia andare",
        shape: "round",
        speech: `Lascia andare: un posto dove nessuno risponde. Quello che dici lì non viene trascritto, non esce dal tuo telefono. Sparisce nel silenzio.`,
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
        // === LABEL VUOTA (utente 2026-07) ===
        // Il "banner indicatore" al top della card tour (che mostrava
        // "Eclissi") è stato rimosso su richiesta: quando Koda dice
        // "Eccomi. Toccami per parlarti" non serve un titolo aggiuntivo
        // — la voce e la sfera bastano. KodaTour salta il render del
        // titolo se label è stringa vuota.
        label: "",
        shape: "circle",
        speech: `Eccomi. Toccami per parlarti, ritoccami per fermarmi.`,
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
        // Vedi commento sopra "Eccomi": stessa logica, banner indicatore
        // rimosso per non doppiare il messaggio vocale.
        label: "",
        shape: "circle",
        speech: userNameRaw
          ? `Ecco, è tutto. Sono qui, ${userNameRaw}.`
          : `Ecco, è tutto. Sono qui.`,
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
  // === BORDER CALIBRATION (2026-08-02, Fabio dopo bug Honor curved edges) ===
  // Alcuni schermi Android (Honor curvo, Xiaomi 4-lati curvi) hanno curve
  // fisiche che "mangiano" il NeonBorder default → utente calibra da
  // Impostazioni → Bordo. Persistito in SecureStore locale (per-device),
  // NON nel profilo cloud: è una preferenza legata alla fisica dello
  // schermo, non all'identità utente.
  const [borderCal, setBorderCal] = useState<BorderCalibration>(DEFAULT_CALIBRATION);
  useEffect(() => {
    (async () => {
      try {
        const cal = await loadBorderCalibration();
        setBorderCal(cal);
      } catch {}
    })();
  }, []);
  // === AUDIO PREWARM iOS/Android (2026-08-02, Fabio "primo istante magico") ===
  // Al mount della home, configuriamo la audio session iOS in modo che il
  // primo TTS di Koda non paghi i 100-200ms di setup iniziale. Impatta
  // direttamente la percezione delle "prime 3-5 parole" — quelle che
  // devono stregare l'utente. Idempotente, no-op se già configurato altrove.
  useEffect(() => {
    (async () => {
      try {
        const { setAudioModeAsync } = await import("expo-audio");
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          shouldPlayInBackground: false,
          interruptionMode: "duckOthers",
          interruptionModeAndroid: "duckOthers",
        });
        console.log("[HOME] audio session prewarmed (v65 first-word magic)");
      } catch (e) {
        console.warn("[HOME] audio prewarm skipped:", e);
      }
    })();
  }, []);
  // === ROLLBACK 2026-07-13 ===
  // Rimossa la "Modalità Telefono" (audioOutMode / cycleAudioOutput /
  // setKodaAudioOutput / getKodaAudioOutput). Vedi
  // /app/summary/refund_documentation.md per il razionale tecnico.
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
  // === FIX 2026-06-27 v18 (Android Xiaomi: Impostazioni mostrava solo Acqua) ===
  // Su Android, per motivi non chiari (probabilmente race condition al mount
  // o errore di fetch silenzioso), lo state `voices` restava vuoto e l'utente
  // non vedeva la scelta tra Acqua e Vento. Su iOS funzionava regolarmente.
  // Soluzione robusta: inizializziamo `voices` con il fallback hardcoded
  // delle DUE voci ufficiali (allineato a CURATED_VOICES nel backend).
  // Se poi la fetch al backend riesce, sovrascrive con la risposta server
  // (consente di aggiungere nuove voci in futuro senza ricompilare il client).
  const _DEFAULT_VOICES: VoiceOption[] = [
    { voice_id: "POuqf18evoXOKIqV2Px7", name: "Cielo", description: "La voce femminile di Koda.", gender: "femminile" as any, accent: "italiano" } as any,
    { voice_id: "ll9WG7PDTuyHwgC5MD6g", name: "Vento", description: "La voce maschile di Koda.", gender: "maschile" as any, accent: "italiano" } as any,
  ];
  const [voices, setVoices] = useState<VoiceOption[]>(_DEFAULT_VOICES);
  const [voicesEnabled, setVoicesEnabled] = useState(true);

  // === Rimosso 2026-07-09: OTA update check pulsante ===
  // Il pulsante "Controlla aggiornamenti" non funzionava sulla pipeline
  // OTA Emergent (checkForUpdateAsync non rispondeva). Stato e handler
  // rimossi completamente per pulizia.
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

  // === CLOSE SESSION PAUSE (fix regressione 2026-06-20) ===
  // Quando l'utente saluta per chiudere ("ci sentiamo dopo", "ciao Koda",
  // "buonanotte"…) il backend imposta `close_session=true` nel meta event.
  // Il client DEVE smettere di ascoltare automaticamente per NON entrare
  // nel loop "non ti sento, parla pure" anche dopo che l'utente se n'è
  // andato. Reset solo quando l'utente tappa di nuovo l'orb (intent
  // esplicito di riprendere la conversazione).
  const [closeSessionPause, setCloseSessionPause] = useState(false);
  const closeSessionPauseRef = useRef(false);
  useEffect(() => { closeSessionPauseRef.current = closeSessionPause; }, [closeSessionPause]);
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
  // === FASE 1 STREAMING (giugno 2026) ===
  // Ref alla sessione voice streaming attiva. Permette il tap-to-stop sul
  // big button anche quando il flusso voce è streaming (non c'è recRef).
  const streamingSessionRef = useRef<{ stop: () => Promise<void> } | null>(null);
  // === FIX 2026-07-11 v52 — TAP_STOP EARLY (race pre-session) ===
  // Race conosciuta: l'utente preme il big button, `setStatus("recording")`
  // fira subito, ma voiceStreamConverse (async) impiega ~1-5s ad aprire
  // la WS e chiamare onSession() → durante quel gap, streamingSessionRef
  // è ancora null. Se l'utente ri-tocca il button (tap-stop) in quella
  // finestra, il vecchio codice settava solo status=transcribing e non
  // fermava nulla — poi la sessione partiva comunque e i chunk continuavano
  // fino al termine naturale.
  //
  // FIX: pendingTapStopRef=true quando tap-stop avviene senza sessione.
  // Nel callback onSession(s), se pendingTapStopRef è true chiamiamo
  // immediatamente s.stop() e resettiamo il flag. Cosi il "graceful stop"
  // funziona anche durante l'apertura della WS.
  const pendingTapStopRef = useRef<boolean>(false);

  // === FIX 2026-07-24 v63.5 (Fix B) — mic activation gate ===
  // BUG OSSERVATO nel log Xiaomi: setStatus("recording") fira IMMEDIATAMENTE
  // in startTalkStreaming (linea ~2846), ma il microfono REALE parte solo
  // ~1s dopo (dopo setAudioModeAsync + detectAudioRoute + warmup + openWs
  // + startRecognition). In quel gap, l'orb sembra in ascolto ma il mic
  // non registra nulla; se l'utente tocca l'orb (impaziente o pensando
  // che il tap serva ad ATTIVARE), viene interpretato come stop-utente,
  // stopRequested=true, la sessione aborta prima di startRecognition
  // → nessun audio catturato. Combinato al bug HF_LOOP (Fix A), 156
  // sessioni abortite in 4s.
  //
  // Fix: teniamo traccia se il mic è REALMENTE attivo. Il callback
  // onRecognitionActive (voiceClientStt.ts, chiamato dopo
  // ExpoSpeechRecognitionModule.start() OK) lo mette a true. Un tap
  // durante status="recording" ma micReallyActiveRef=false viene
  // IGNORATO (log-only, no UI change per ora). Diventa false al termine
  // della sessione (onDone/onError/finally).
  const micReallyActiveRef = useRef<boolean>(false);

  // === FIX 2026-07-14 v56 — HF LOOP BACKOFF su WS failures consecutivi ===
  // Se il backend si riavvia o è irraggiungibile, il vecchio HF loop
  // martella all'infinito aprendo WS che si chiudono subito con code=0.
  // Ogni fallimento incrementa questo counter. Al 3° fail consecutivo
  // pausiamo il loop, mostriamo errore chiaro e aspettiamo tap manuale.
  // Il counter si azzera su qualsiasi ciclo che completa con successo
  // (result.ok=true) o su tap manuale utente.
  const wsFailureCountRef = useRef<number>(0);
  const WS_FAIL_THRESHOLD = 3;
  // === MUTEX 2026-06-28 — P0 race condition fix (handoff diag log) ===
  // Su iPhone + Android, due meccanismi di restart hands-free firavano
  // entro ~50ms l'uno dall'altro:
  //   • KODA_HF_LOOP (useEffect + setTimeout 450ms)
  //   • KODA_HF_EXPLICIT (setTimeout 500ms nel finally di voiceStream)
  // Entrambi passavano i guard (recRef=null) e chiamavano startTalkInternal
  // in parallelo → due sessioni WebSocket /api/voice/stream aperte
  // simultaneamente che si killavano a vicenda (codici 1000/1006).
  // Sintomo utente: voce si ferma dopo ~1s quando cambia voce nello Sfogo
  // o tra un turno e l'altro.
  // FIX: debounce timestamp-based 800ms sull'INGRESSO di startTalkInternal.
  // Il secondo call entro 800ms viene scartato. JS single-threaded → safe.
  // 800ms copre la finestra di parallelismo (50-100ms) con margine ampio
  // ma NON impatta gli avvii legittimi (turni successivi distano 30s+).
  const lastStartTalkAtRef = useRef<number>(0);
  // === RECORDING DURATION TRACKING (sprint giugno 2026 v11) ===
  // Catturiamo il timestamp di avvio recording così possiamo includerlo
  // nel [KODA_SUMMARY] come recording_duration_ms. Permette di distinguere
  // a colpo d'occhio: A) registrazione troppo breve (utente non parla
  // abbastanza prima della chiusura VAD); B) pipeline lenta (recording
  // ok ma backend impiega tempo). Senza questa metrica devi correlare
  // [KODA_TIMING] VOICE_END con [KODA_SUMMARY] = laborioso.
  const recordingStartedAtRef = useRef<number | null>(null);
  const lastRecordingDurationMsRef = useRef<number | null>(null);
  // === AUDIO HONESTY (Fabio 2026-06-23) ============================
  // Confidence Deepgram dell'ULTIMA trascrizione completata. Viene
  // propagata al backend nella chiamata /converse-fast/start (vedi
  // SpeechMod.fastConverse(..., sttConfidence: ...)). Se < 0.7 il
  // backend inietterà una direttiva nel prompt → Koda si comporta
  // come amico onesto: riconosce l'audio rumoroso, chiede contesto.
  const lastSttConfidenceRef = useRef<number | null>(null);
  const scrollRef = useRef<FlashList<any>>(null);
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
  // Timer per debounce del release del wake-lock (60s post-idle senza
  // nuovi turni). Vedi FIX v64.0 sul flash schermo Honor/Huawei.
  const keepAwakeReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
            // === SYNC ai_gender ← voce (2026-07-24 pre-lancio) ===
            // Rimosso il selettore esplicito "Koda è…" dalle Impostazioni:
            // il genere grammaticale di Koda è determinato univocamente
            // dalla voce scelta. Se il profilo ha ai_gender desincronizzato
            // (edge case: profilo migrato o cambio voce lato server), lo
            // riallineiamo silenziosamente qui al boot.
            //   Cielo (POuqf…Px7) → f
            //   Vento (ll9WG…MD6g) → m
            try {
              const vid = String(p.settings.tts_voice_id || "");
              const derivedGender =
                vid === "POuqf18evoXOKIqV2Px7" ? "f"
                : vid === "ll9WG7PDTuyHwgC5MD6g" ? "m"
                : null;
              if (derivedGender && p.ai_gender !== derivedGender) {
                api.updateProfile({ ai_gender: derivedGender }).catch(() => {});
              }
            } catch {}
            // FILLER RIMOSSO (giugno 2026 v6): niente più preload pool —
            // la prima frase reale arriva in ~1.5-2s, basta lo stato
            // visuale dell'orb durante l'attesa.
            // === OFFLINE CLIPS (sprint 2026-06-20) ===
            // Pre-scarica le 3 clip "sono qui, ma offline" per la voce
            // attiva. Funziona solo se il primo avvio è online. Idempotente.
            try {
              preloadOfflineClips(p.settings.tts_voice_id).catch(() => {});
            } catch {}
          }
          if (!p.onboarded) setShowOnboarding(true);
          else if (p.settings?.input_mode !== "text") {
            prewarmMic().catch(() => {});
          }
          // === GEOLOCATION ONE-SHOT (P2 Fabio 2026-06-20) ===
          // Se l'utente ha abilitato il toggle nelle Impostazioni,
          // facciamo UN getCurrentPosition + reverse-geocode → invio
          // città al backend come key_fact. Strategia:
          //  - silenzioso (no Alert se permesso negato — l'utente l'ha
          //    già scelto attivando il toggle, sa cosa fa)
          //  - non-blocking (parallelo, fire-and-forget)
          //  - una sola volta per cold-start dell'app (no watchPosition)
          if ((p.settings as any)?.geolocation_enabled === true) {
            (async () => {
              try {
                const { fetchLocationOnce } = await import("../lib/geolocation");
                const res = await fetchLocationOnce();
                console.log(`[KODA_GEO] boot result: ${JSON.stringify(res).slice(0, 200)}`);
              } catch (e) {
                console.warn("[KODA_GEO] boot fetch failed:", e);
              }
            })();
          }
          // === ADMIN WHITELIST CHECK (2026-07-24 pre-paywall) ===
          // Chiediamo al backend se l'uid corrente è admin. Se sì, il
          // mini-panel in Impostazioni diventa visibile. Silenzioso su
          // errore (utenti normali riceveranno is_admin=false comunque).
          (async () => {
            try {
              const who = await api.adminWhoAmI();
              setIsAdmin(!!who?.is_admin);
            } catch (e) {
              // Silenzioso — un errore qui non deve interrompere il boot
              setIsAdmin(false);
            }
          })();
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
      // === FIX 2026-06-28 v32 — Xiaomi/HyperOS Privacy Flicker ===
      // Su Xiaomi HyperOS l'indicatore di privacy del microfono (il dot
      // verde in alto a destra che appare quando il mic è attivo) può
      // causare brevi transizioni AppState: active → inactive → active
      // durante una sessione di registrazione. Senza guard, ogni "active"
      // ri-resetta lo status a idle e azzera userInteractedRef → l'orb
      // visivamente torna a idle dopo <1s anche se i chunk continuano a
      // essere registrati e inviati al backend.
      // Skip TUTTI gli azzeramenti se c'è una sessione streaming/recorder
      // attiva. Lo status reale è governato dal flusso voiceStreamConverse.
      const streamingAlive = !!streamingSessionRef.current;
      const recorderAlive = !!recRef.current;
      const sessionActive = streamingAlive || recorderAlive;
      // === FIX 2026-06-28 v33 — Logging AppState ===
      // Verbose (default OFF): log dettagliato con status, userInteracted, decisione.
      // Conciso (default ON): solo cambio + skip/handled.
      if (KODA_DEBUG_VERBOSE) {
        console.log(
          `[KODA_APPSTATE] next=${next} streaming=${streamingAlive} ` +
            `recorder=${recorderAlive} status=${statusRef.current} ` +
            `userInteracted=${userInteractedRef.current} ` +
            `=> ${sessionActive ? "skipped (session alive)" : "handled"}`
        );
      } else if (sessionActive) {
        // In produzione: solo i casi di skip (utili per capire flicker)
        console.log(`[KODA_APPSTATE] next=${next} skipped (session alive)`);
      }
      if (sessionActive) {
        return;
      }
      if (next === "background" || next === "inactive") {
        // App va in background: ferma TUTTO subito.
        userInteractedRef.current = false;
        // === AUTO-DIM (2026-07-28) — stop e restore brightness ==============
        // Quando l'app va in background dobbiamo ripristinare la brightness
        // originale (iOS resetta comunque da solo ma noi puliamo lo stato
        // interno per non applicare fade "fantasma" al ritorno).
        try { ScreenDimmer.stopWatching(); } catch {}
        if (recRef.current) {
          try { recRef.current.cancel?.(); } catch {}
          recRef.current = null;
        }
        try { SpeechMod.stop(); } catch {}
        // === FIX 2026-07-06 v46 (Fabio "iOS mic globale bruciato") ===
        // Rilascio ESPLICITO dell'AVAudioSession quando l'app va
        // background/inactive. Senza questo, iOS lasciava la sessione
        // audio "hot" (allowsRecording=true) → dopo il ritorno
        // foreground `prepareToRecordAsync` falliva 5/5 volte E
        // BLOCCAVA IL MIC GLOBALE del telefono (fotocamera/WhatsApp
        // non funzionavano più finché non riavviavi l'iPhone).
        // Rilascio async fire-and-forget (non blocchiamo il main
        // thread mentre l'app sta chiudendo).
        (async () => {
          try {
            const { setAudioModeAsync, setIsAudioActiveAsync } =
              (await import("expo-audio")) as any;
            // Priorità: disattivare la sessione (release del lock)
            try {
              if (typeof setIsAudioActiveAsync === "function") {
                await setIsAudioActiveAsync(false);
              }
            } catch {}
            try {
              await setAudioModeAsync({
                allowsRecording: false,
                playsInSilentMode: false,
                shouldPlayInBackground: false,
              } as any);
            } catch {}
            console.log(
              `[KODA_APPSTATE] AudioSession released (background/inactive)`
            );
          } catch (e: any) {
            console.log(
              `[KODA_APPSTATE] AudioSession release failed: ${e?.message || e}`
            );
          }
        })();
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
  // === FIX 2026-07-26 v64.0 — HONOR/HUAWEI SCREEN FLASH FIX ===
  //
  // PROBLEMA (log utente 25/07):
  //   Su Honor/Huawei (EMUI/HarmonyOS) lo schermo lampeggia ~ogni 7s
  //   durante una conversazione. Test diagnostico ha escluso breath
  //   animation, JS timers, network polling.
  //
  // ROOT CAUSE:
  //   Il vecchio useEffect chiamava activateKeepAwakeAsync /
  //   deactivateKeepAwake AD OGNI transizione di status
  //   (idle→recording→transcribing→thinking→speaking→idle). Su EMUI il
  //   ciclo del wake-lock viene gestito dal power manager di Huawei che
  //   emette un brief refresh dello schermo ad ogni riattivazione.
  //   Con 4-5 status transitions per turno, e turni ogni 5-10s in
  //   hands-free, il pattern osservato dall'utente (flash ~7s) matcha
  //   perfettamente.
  //
  // FIX:
  //   1. Attiviamo keep-awake UNA VOLTA quando la sessione diventa
  //      attiva (userInteractedRef=true, ovvero dopo il primo tap).
  //   2. NON lo disattiviamo su ogni transizione idle. Restiamo attivi
  //      per l'intera sessione foreground.
  //   3. Deactivate solo su:
  //        - App background/blur (via useFocusEffect cleanup)
  //        - Debounce di 60s post-idle SENZA nuovi turni (utente ha
  //          davvero smesso di parlare da un minuto → possiamo lasciare
  //          spegnere lo schermo).
  //   4. Su iOS resta identico al comportamento precedente perché iOS
  //      non ha il problema (AVFoundation non tocca la brightness).
  //
  // Su Android il wake-lock resta attivo continuo mentre la app è in
  // primo piano dopo il primo tap → zero cicli → zero flash.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const TAG = "koda-conversation";
    // Attiva su qualsiasi stato non-idle O sfogo attivo
    const isActive = status === "recording" || status === "transcribing" ||
                     status === "thinking" || status === "speaking" ||
                     confessionalMode;
    if (isActive) {
      // Attiva subito. Idempotente lato nativo — chiamarla mentre già
      // attivo è no-op quindi zero flash da "riattivazione".
      try {
        activateKeepAwakeAsync(TAG).catch(() => {});
      } catch {}
      // Se avevamo schedulato un release-debounce, cancellalo — l'utente
      // è tornato attivo prima dei 60s.
      if (keepAwakeReleaseTimerRef.current) {
        clearTimeout(keepAwakeReleaseTimerRef.current);
        keepAwakeReleaseTimerRef.current = null;
      }
      return;
    }
    // Idle: NON deattivare subito. Schedula un release fra 60s. Se
    // nel frattempo l'utente riparte con un nuovo turno, il release
    // viene cancellato (vedi sopra). In hands-free tra un turno e
    // l'altro passano 2-5s → non arriviamo MAI ai 60s → wake-lock
    // stabile continuo → zero flash EMUI.
    if (keepAwakeReleaseTimerRef.current) {
      clearTimeout(keepAwakeReleaseTimerRef.current);
    }
    keepAwakeReleaseTimerRef.current = setTimeout(() => {
      try {
        deactivateKeepAwake(TAG);
        console.log("[KODA_WAKELOCK] released after 60s idle debounce");
      } catch {}
      keepAwakeReleaseTimerRef.current = null;
    }, 60_000);
    return () => {
      // NB: NON deattivare qui su cleanup di dep change — la cleanup
      // funziona solo quando l'effect ri-run (che avviene tantissimo).
      // Lasciamo che il debounce/unmount se ne occupino.
    };
  }, [status, confessionalMode]);

  // Cleanup finale su unmount: rilascia il wake-lock indipendentemente
  // dal debounce timer.
  useEffect(() => {
    return () => {
      if (Platform.OS === "web") return;
      if (keepAwakeReleaseTimerRef.current) {
        clearTimeout(keepAwakeReleaseTimerRef.current);
        keepAwakeReleaseTimerRef.current = null;
      }
      try {
        deactivateKeepAwake("koda-conversation");
      } catch {}
    };
  }, []);

  // === AUTO-DIM SCHERMO durante hands-free (Fabio 2026-07-28, fix 2026-07-29) =
  // Riduce il consumo batteria/calore su iPhone durante conversazione hands-free
  // quando l'utente non sta toccando lo schermo (sta solo ascoltando/parlando).
  //
  // Regola concordata:
  //   - Trigger: `convActive` (sessione hands-free in corso). Questo è un
  //     segnale STABILE per l'intera durata della conversazione, NON cicla
  //     con lo status (recording/thinking/speaking). Prima usavamo `status`
  //     e il timer di 35s si resettava ad ogni turno → il dim non firava mai.
  //   - Dopo 35s di inattività touch → fade graduale a 50% (2s)
  //   - Al primo touch → restore rapido al 100% originale (300ms)
  //   - Su uscita hands-free (convActive=false) → restore automatico
  //   - Un solo livello di dim (50%, non ulteriori scaglioni sotto)
  //
  // Il monitoraggio del touch avviene sul View root via onStartShouldSetResponder
  // (vedi return principale) → chiama ScreenDimmer.noteInteraction() ad ogni tap.
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (convActive) {
      console.log("[KODA_DIMMER] convActive=true → startWatching");
      ScreenDimmer.startWatching().catch(() => {});
    } else {
      console.log("[KODA_DIMMER] convActive=false → stopWatching");
      ScreenDimmer.stopWatching().catch(() => {});
    }
  }, [convActive]);

  // Cleanup finale del dimmer su unmount — safety net per assicurare
  // che la brightness sia sempre restaurata, anche in caso di crash/exit.
  useEffect(() => {
    return () => {
      ScreenDimmer.stopWatching().catch(() => {});
    };
  }, []);

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

  // === FIX 2026-07-02 (Fabio) — Rimosse pickAiAvatar/removeAiAvatar (dead code) ===
  // Le funzioni erano definite ma nessun bottone UI le chiamava. Il campo
  // settings.ai_avatar era vuoto per tutti i profili in DB e il componente
  // Bubble riceveva la prop `aiAvatar` senza mai usarla internamente.
  // Se in futuro serve un avatar per Koda: NON salvare base64 nel profilo
  // (stesso problema del background). Usare asset locale + selettore preset.

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

  // === FIX 2026-07-02 (Fabio) — Rimossa feature "sfondo custom da galleria" ===
  // saveBackground / pickBackgroundFromGallery erano dead code (bottone UI
  // già rimosso). Ora gli sfondi sono solo i preset di Koda. Se in futuro
  // servisse riabilitare custom background: NON salvare base64 dentro
  // profile.settings (esplode il DB). Usare invece asset locale o upload
  // separato in blob storage.

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
  // === FIX BOUNCE LOOP (2026-06-22) ===
  // Prima usavamo animated:true con setTimeout 80ms. Risultato: durante lo
  // streaming dei messaggi (tone/content updates), più scrollToEnd animati
  // si sovrapponevano misurando height vecchie → la timeline rimbalzava
  // su/giù all'infinito. Ora:
  //   - animated:false → snap istantaneo, no intersezioni di animazione
  //   - solo se l'utente è già vicino al fondo (rispetta chi legge sopra)
  //   - re-fired anche su onContentSizeChange per messaggi che crescono
  useEffect(() => {
    // === FIX #4 FORCE SCROLL ON USER SEND (2026-06-22 v6) ===
    // Se siamo nella finestra "force scroll" (utente ha appena inviato),
    // scrolla COMUNQUE in fondo anche se l'utente era scrollato indietro.
    // Altrimenti rispetta isNearBottom (= solo scroll passivo).
    const inForceWindow = Date.now() < forceScrollUntilRef.current;
    if (!inForceWindow && !isNearBottomRef.current) return;
    const id = setTimeout(() => {
      try {
        scrollRef.current?.scrollToEnd({ animated: false });
        // Se eravamo in force-window, ora siamo certi di essere in fondo
        if (inForceWindow) {
          isNearBottomRef.current = true;
          setIsNearBottom(true);
        }
      } catch {}
    }, 30);
    return () => clearTimeout(id);
  }, [timeline.length]);

  // === FIX KEYBOARD SHIFT (2026-06-22 v4) ===
  // Quando la tastiera si apre/chiude o cambia altezza (suggerimenti,
  // emoji panel, ecc.), il paddingBottom della timeline si aggiorna ma
  // la posizione di scroll resta la stessa → l'ultimo messaggio finisce
  // dietro l'input. Re-scroll se l'utente era vicino al fondo, così
  // l'ultima bolla resta SEMPRE visibile sopra la barra di scrittura.
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const id = setTimeout(() => {
      try {
        scrollRef.current?.scrollToEnd({ animated: false });
      } catch {}
    }, 50);
    return () => clearTimeout(id);
  }, [kbHeight, bottomBarHeight]);

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
      // === FIX #5 STATUS STUCK ON THINKING (2026-06-22 v6) ===
      // Bug: dopo che Koda ha terminato la risposta, status restava su
      // "thinking" → TypingDots continuavano a pulsare → dopo 25s il
      // watchdog faceva apparire un finto errore "Si è bloccato".
      // Causa: nei due early-return sotto (fromText o voice_response off)
      // non resettavamo lo status, lasciandolo a "thinking" dal sendText.
      // Fix: marca esplicitamente idle prima di uscire.
      // FIX 2026-07: se la richiesta proviene dalla tastiera (input testo),
      // NON parlare. L'utente probabilmente è in un contesto dove non vuole
      // audio (notte, pubblico). Risponde solo a video.
      if (opts?.fromText) {
        setStatus("idle");
        return;
      }
      if (!profile?.settings.voice_response) {
        // PIANO A: auto-reopen del mic disabilitato. L'utente tappa per parlare.
        setStatus("idle");
        return;
      }
      const lang = profile?.language || "it";
      const langTag = lang === "it" ? "it-IT" : lang === "en" ? "en-US" : lang;

      // PIANO A: SEMPRE modalità sequenziale push-to-talk.
      // L'AI parla → finisce → torna idle → l'utente tappa per parlare.
      // Il conversation_mode hands-free è disabilitato (causa di freeze su iOS).
      // Arriverà nella Fase 4 con Deepgram + dev build.
      setStatus("speaking");
      traceMark("tts:request");
      await SpeechMod.speak(text, { language: langTag, tone });
      traceMark("tts:end");
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
            // === TEMA UNICO (2026-08-04) ===
            // Koda ora è dark-only. Qualsiasi comando vocale "cambia tema
            // in X" viene ignorato lato UI — salviamo comunque "notte" nel
            // profilo per idempotenza. Il ThemeProvider ha setThemeName
            // come no-op, ma manteniamo la chiamata per compatibilità.
            patch.settings = { ...(profile?.settings || {}), theme: "notte" };
            try { setThemeName("notte" as ThemeName); } catch {}
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
    // === FIX 2026-06-27 v18 (diag hands-free Android) ===
    // L'utente Xiaomi ha riportato che dopo aver pubblicato i fix di oggi,
    // hands-free NON auto-restarta dopo una risposta di Koda — bisogna
    // tappare ogni volta. Il diag log mostra gap di 5-8s fra "session ref
    // cleared" e "audio prep done", contro i ~450ms attesi.
    // Aggiungiamo log per OGNI guardia che blocca: al prossimo test
    // sappiamo subito quale flag sta impedendo il restart su Android.
    // Prefisso unico KODA_HF_GUARD così è facilmente filtrabile nel diag.
    if (!handsFree) {
      if (status === "idle") console.log("[KODA_HF_GUARD] blocked: handsFree=false");
      return;
    }
    // === FIRST-TAP GATE ===
    // Il loop hands-free non parte FINCHÉ l'utente non ha toccato l'orb
    // almeno una volta in questa sessione foreground. Questo elimina
    // tutta una serie di problemi di sessione audio iOS al cold-start
    // / ritorno dal background. Vedi commenti su `userInteractedRef`.
    if (!userInteractedRef.current) {
      if (status === "idle") console.log("[KODA_HF_GUARD] blocked: userInteractedRef=false (first-tap gate)");
      return;
    }
    if (status !== "idle") return;
    if (!profile) {
      console.log("[KODA_HF_GUARD] blocked: profile=null");
      return;
    }
    // === CLOSE SESSION PAUSE (fix regressione 2026-06-20) ===
    // L'utente ha appena salutato per chiudere ("ci sentiamo dopo", "ciao
    // Koda"…). Il backend ha settato close_session=true e il client lo ha
    // catturato. NON riaccendere il mic automaticamente. L'utente deve
    // tappare esplicitamente l'orb per riprendere. Senza questa guardia
    // il loop hands-free riapriva il mic dopo 450ms e poi mostrava
    // "non ti sento" anche se l'utente era già andato via.
    if (closeSessionPauseRef.current) {
      console.log("[KODA_HF_GUARD] blocked: closeSessionPause=true (waiting for user tap)");
      return;
    }
    if (showOnboarding) {
      console.log("[KODA_HF_GUARD] blocked: showOnboarding=true");
      return;
    }
    // CRITICAL: showColorIntro può essere `null` (in fase di caricamento da
    // SecureStore). Se attivassimo il mic in quei millisecondi, l'audio
    // session iOS andrebbe in "recording" e poi quando KodaIntro vuole
    // parlare il TTS resta muto. Aspettiamo esplicitamente `false`.
    if (showColorIntro !== false) {
      console.log(`[KODA_HF_GUARD] blocked: showColorIntro=${showColorIntro}`);
      return;
    }
    if (tourActive) {
      console.log("[KODA_HF_GUARD] blocked: tourActive=true");
      return;
    }
    if (showSealSetup) {
      console.log("[KODA_HF_GUARD] blocked: showSealSetup=true");
      return;
    }
    if (sealUnlocking) {
      console.log("[KODA_HF_GUARD] blocked: sealUnlocking=true");
      return;
    }
    if (showSettings) {
      console.log("[KODA_HF_GUARD] blocked: showSettings=true");
      return;
    }
    if (profile.settings?.input_mode === "text") {
      console.log("[KODA_HF_GUARD] blocked: input_mode=text");
      return;
    }
    if (recRef.current) {
      console.log("[KODA_HF_GUARD] blocked: recRef.current is non-null (recorder still alive?)");
      return;
    }
    // === FIX 2026-06-28 v26 — guard su streamingSessionRef ===
    // Il flusso voiceStream usa `streamingSessionRef`, NON `recRef`. Senza
    // questo check, mentre una sessione streaming era attiva l'useEffect
    // poteva firare e aprire una SECONDA WebSocket in parallelo → cascata.
    if (streamingSessionRef.current) {
      console.log("[KODA_HF_GUARD] blocked: streamingSessionRef.current is non-null (stream already active)");
      return;
    }
    // === NO-SPEECH BACKOFF LOGIC (Fabio 2026-07-29) =========================
    // Se il turno appena chiuso NON ha avuto parlato reale (no_speech
    // timeout, WS chiusa senza transcript), incrementa il counter e applica
    // il delay progressivo. Dopo 5 no_speech consecutivi, FERMA il loop
    // (richiede tap utente) — evita che il mic continui a riaprirsi per
    // ore se l'utente ha dimenticato l'app aperta (batteria + AudioSession iOS).
    let scheduleDelayMs = 450;
    const turnWasSilent = !turnHadSpeechRef.current;
    if (turnWasSilent) {
      noSpeechCountRef.current += 1;
      if (noSpeechCountRef.current >= MAX_NO_SPEECH_ATTEMPTS) {
        // Soglia raggiunta: pausiamo il loop, serve tap dell'utente
        console.log(
          `[KODA_HF_BACKOFF_NOSPEECH] ${noSpeechCountRef.current} no_speech consecutivi → STOP loop (richiede tap utente)`
        );
        setCloseSessionPause(true);
        closeSessionPauseRef.current = true;
        noSpeechCountRef.current = 0; // reset per la prossima sessione manuale
        return; // NON schedulare startTalkInternal
      }
      // Applica delay progressivo (indice = count - 1: 1° no-speech → 450ms)
      scheduleDelayMs =
        NO_SPEECH_BACKOFF_DELAYS_MS[noSpeechCountRef.current - 1] ?? 5000;
      console.log(
        `[KODA_HF_BACKOFF_NOSPEECH] no_speech #${noSpeechCountRef.current}/${MAX_NO_SPEECH_ATTEMPTS} → riapri fra ${scheduleDelayMs}ms`
      );
    }

    // Tutte le guardie superate — schedula il restart.
    console.log(`[KODA_HF_LOOP] all guards passed — scheduling startTalkInternal in ${scheduleDelayMs}ms`);
    // breve pausa di respiro per evitare di registrare la coda del TTS
    // e per dare al sistema audio iOS il tempo di switchare la sessione.
    const t = setTimeout(() => {
      if (!handsFreeRef.current) {
        console.log("[KODA_HF_LOOP] aborted in timeout: handsFreeRef=false");
        return;
      }
      if (recRef.current) {
        console.log("[KODA_HF_LOOP] aborted in timeout: recRef became non-null");
        return;
      }
      // CRITICAL: re-check tourActive in closure. Senza questo, nel piccolo
      // gap fra "KodaIntro chiusa" e "tourActive=true" il setTimeout era
      // già stato schedulato e apriva il mic durante il tour.
      if (tourActiveRef.current) {
        console.log("[KODA_HF_LOOP] aborted in timeout: tourActiveRef=true");
        return;
      }
      console.log("[KODA_HF_LOOP] firing startTalkInternal(true)");
      // Re-check status in closure
      startTalkInternal(true).catch((e) => {
        console.log(`[KODA_HF_LOOP] startTalkInternal threw: ${e?.message || e}`);
      });
    }, scheduleDelayMs);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, handsFree, profile?.id, showOnboarding, showColorIntro, showSealSetup, sealUnlocking, showSettings, tourActive]);

  // === ANDROID BACK BUTTON HANDLER (2026-06-27 v18) ===
  // Su Android l'utente può premere il tasto/gesto "back" hardware. Senza
  // gestione esplicita, il default è uscire dall'app — comportamento che
  // diventa pericoloso in tre casi:
  //   1) Stanza dello Sfogo aperta → l'utente esce per errore e perde la
  //      sessione effimera senza nemmeno un avviso. Rompe la fiducia in
  //      un prodotto che si presenta come "amico attento".
  //   2) Microfono attivo (recording/processing) → il back lascerebbe il
  //      registratore aperto in background o in stato corrotto.
  //   3) Koda sta parlando (speaking) → il TTS continua mentre l'utente
  //      pensa di aver chiuso l'app.
  // Inoltre, intercettiamo i modali aperti (Impostazioni, Onboarding,
  // SealSetup, ConfessionalIntro, Tour) e li chiudiamo invece di uscire.
  //
  // Restituire `true` = abbiamo gestito il back, NON propagare al sistema.
  // Restituire `false` = comportamento di default (chiude l'app).
  // Solo Android: su iOS questo hook è no-op (BackHandler non spara mai).
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const onBack = (): boolean => {
      // --- Tier 1: chiudi modali (priorità alta) ---
      if (showSettings) {
        setShowSettings(false);
        return true;
      }
      if (showConfessionalIntro) {
        setShowConfessionalIntro(false);
        return true;
      }
      if (showSealSetup) {
        setShowSealSetup(false);
        return true;
      }
      if (tourActive) {
        // Tour visivo: chiude il tour, non l'app
        try { setTourActive(false); } catch {}
        return true;
      }
      // Onboarding e ColorIntro: NON permettiamo di scappare via back
      // (l'utente deve completare il flow), quindi semplicemente ignoriamo.
      if (showOnboarding || showColorIntro === true) {
        return true;
      }

      // --- Tier 2: Stanza dello Sfogo attiva ---
      // Conferma esplicita prima di uscire. Se Koda sta parlando o sta
      // registrando dentro la Stanza, il back deve comunque chiedere.
      if (confessionalMode) {
        Alert.alert(
          "Uscire dalla Stanza dello Sfogo?",
          "Quello che hai detto qui non verrà salvato. Sei sicuro di voler uscire?",
          [
            { text: "Resta qui", style: "cancel" },
            {
              text: "Esci",
              style: "destructive",
              onPress: () => {
                // Ferma TTS se sta parlando
                try { SpeechMod.stop(); } catch {}
                // Aborta sessione streaming se attiva
                try {
                  if (streamingSessionRef.current) {
                    const s = streamingSessionRef.current as any;
                    streamingSessionRef.current = null;
                    try { s.abort?.().catch?.(() => {}); } catch {}
                  }
                } catch {}
                setConfessionalMode(false);
              },
            },
          ],
          { cancelable: true }
        );
        return true;
      }

      // --- Tier 3: Microfono attivo ---
      // Back durante "recording" o "processing" = STOP, non chiusura app.
      // Replica il comportamento del tap sull'orb durante registrazione.
      if (status === "recording" || status === "processing") {
        try {
          if (streamingSessionRef.current) {
            const s = streamingSessionRef.current as any;
            streamingSessionRef.current = null;
            try { s.abort?.().catch?.(() => {}); } catch {}
          }
        } catch {}
        try { SpeechMod.stop(); } catch {}
        setStatus("idle");
        return true;
      }

      // --- Tier 4: Koda sta parlando (TTS playback) ---
      // Back = fermala con grazia, ma resta nell'app.
      if (status === "speaking") {
        try { SpeechMod.stop(); } catch {}
        setStatus("idle");
        return true;
      }

      // --- Default: comportamento di sistema (esce dall'app) ---
      return false;
    };

    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => {
      try { sub.remove(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showSettings, showConfessionalIntro, showSealSetup, tourActive,
    showOnboarding, showColorIntro, confessionalMode, status,
  ]);

  const sendText = useCallback(
    async (text: string, opts?: { fromText?: boolean }) => {
      // === #9 LATENCY TRACE (2026-06-22 v8) ===
      // T0 = momento esatto in cui parte l'intento di invio.
      traceStart();
      traceMark("sendText:enter");
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

      // === OPTIMISTIC UI FIRST (Fix #10 — 2026-06-22 v8) ===
      // PRIMA mostriamo la bolla all'utente (latenza visiva = zero come
      // WhatsApp), POI facciamo il safety check in parallelo. Se la
      // safety blocca, rimuoviamo la bolla con animazione + alert.
      // Vecchio comportamento: await safety PRIMA di setTimeline → ritardo
      // visivo di 200-500ms tra il tap e l'apparizione del messaggio.
      const isFortezza = !!confessionalMode;
      const optimistic: TimelineEntry = {
        id: `local-${Date.now()}`,
        role: "user",
        text: txt,
        timestamp: new Date().toISOString(),
        confessional: confessionalMode || undefined,
        fortezza: isFortezza || undefined,
      };
      // === FIX #4 (2026-06-22 v6) ===
      // Marca l'inizio di una "force scroll window": il messaggio utente
      // E la risposta successiva (anche se tarda 10-15s) devono SEMPRE
      // far scrollare in fondo, anche se l'utente stava rileggendo i
      // messaggi vecchi. Override del check "isNearBottom" passivo.
      requestForceScroll();
      setTimeline((prev) => [...prev, optimistic]);
      setStatus("thinking");
      traceMark("optimistic_shown");

      // === SAFETY PRE-FLIGHT (post-optimistic) ===
      // SOLO per chat normale (non Confessionale: in Confessionale la regola
      // è "tutto svanisce", quindi safety è gestito dentro lo stesso flusso
      // sealed con prompt injection). Per la chat normale facciamo check
      // BLOCCANTE: se rischio rilevato, NON inviamo nulla a /converse,
      // RIMUOVIAMO la bolla optimistic e mostriamo SafetyAlert.
      if (!isFortezzaTurn) {
        try {
          traceMark("safety:request");
          const sc = await api.safetyCheck(txt, false);
          traceMark("safety:response");
          if (sc.risk_detected) {
            // Rimuovi la bolla optimistic (l'utente vedrà la sua bolla
            // sparire con il default unmount della FlashList, e subito
            // l'alert di safety prende il focus)
            setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
            setStatus("idle");
            setSafetyResult(sc);
            setSafetyVisible(true);
            return; // STOP: niente invio a Claude, niente counter increment
          }
        } catch (e) {
          // Safety check fallisce → degradiamo gracefully (continuiamo).
          // Il prompt injection lato server.py rimane attivo come failsafe.
        }
      }
      // NB: la creazione di optimistic + setTimeline è già avvenuta sopra.
      // Da qui in poi si procede col flusso di invio vero e proprio.
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
            setError("Stanza dello Sfogo temporaneamente non disponibile.");
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
            setError("Stanza dello Sfogo: rete bloccata. Riprova tra un attimo.");
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
                    sttConfidence: lastSttConfidenceRef.current ?? undefined,
                    onAudioStart: () => {
                      speakingStarted = true;
                      clearTimeout(watchdog);
                      setStatus("speaking");
                      // Reset a "attivo" quando comincia una nuova sentence.
                      setSpeechActive(true);
                    },
                    // === ORB SILENCE SYNC (Task 2, Fabio 2026-08) ===
                    // Attiva la desincronizzazione orb ↔ voce reale sui
                    // silenzi. L'evento arriva ~200-400ms dopo il
                    // `sentence`, calcolato server-side via RMS parsing
                    // del MP3. Ignoriamo update dopo `speaking` finito.
                    onSpeechActive: (active) => {
                      try { setSpeechActive(!!active); } catch {}
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
                        // === CLOSE SESSION (path WS — fix 2026-06-20) ===
                        if (meta.close_session) {
                          console.log("[KODA_CLOSE_SESSION] (ws) meta.close_session=true → pausing hands-free loop");
                          setCloseSessionPause(true);
                          closeSessionPauseRef.current = true;
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
                recordingDurationMs: lastRecordingDurationMsRef.current ?? undefined,
                sttConfidence: lastSttConfidenceRef.current ?? undefined,
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
                    // === CLOSE SESSION (fix regressione 2026-06-20) ===
                    // Backend ha rilevato un saluto di chiusura. Sospendi
                    // il loop hands-free: il prossimo `useEffect` che
                    // valuta `closeSessionPauseRef` non riaccenderà il mic.
                    // L'utente dovrà tappare l'orb per riprendere.
                    if (meta.close_session) {
                      console.log("[KODA_CLOSE_SESSION] meta.close_session=true → pausing hands-free loop");
                      setCloseSessionPause(true);
                      closeSessionPauseRef.current = true;
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
        traceMark("converse:response");
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

  // === NO-SPEECH BACKOFF (Fabio 2026-07-29) =================================
  // Se l'utente lascia l'app aperta ma smette di parlare, il loop hands-free
  // rischia di ciclare all'infinito (open mic → 5s silenzio → no_speech →
  // reopen mic → ...) consumando batteria e stressando l'AudioSession iOS
  // (osservato errore `OSStatus 560557684` dopo troppi cicli rapidi).
  //
  // SPEC (concordata con Fabio):
  //   - Contatore `noSpeechCountRef` incrementa ad ogni turno vuoto (no_speech)
  //   - Reset a 0 quando l'utente parla davvero (onUserFinal riceve testo)
  //   - Delay progressivi per riaprire il mic dopo un no_speech:
  //       1° → 450ms, 2° → 2s, 3° → 5s, 4° → 5s, 5° → 5s
  //   - Dopo 5 no_speech consecutivi → STOP: torna idle, richiede tap utente.
  //     (evita che il mic continui ad aprirsi per ore se dimentichi l'app aperta)
  //   - `turnHadSpeechRef` è il flag interno: settato a false all'apertura di
  //     ogni sessione, a true quando arriva un `onUserFinal` con testo valido.
  const NO_SPEECH_BACKOFF_DELAYS_MS = [450, 2000, 5000, 5000, 5000] as const;
  const MAX_NO_SPEECH_ATTEMPTS = 5;
  const noSpeechCountRef = useRef(0);
  const turnHadSpeechRef = useRef(false);

  // === OFFLINE CLIPS ANTI-LOOP (sprint 2026-06-20) ===
  // Conta clip offline consecutive riprodotte senza che la rete sia tornata.
  // Dopo N=3 clip consecutive l'utente ha capito che è offline → usciamo dal
  // loop hands-free per non bombardarlo di clip. Tornerà a parlare quando
  // vuole con un tap manuale dell'orb.
  const offlineClipsInRowRef = useRef(0);
  const MAX_OFFLINE_CLIPS_IN_ROW = 3;

  // Frasi varie per "non ho sentito" — ruotiamo per non sembrare un bot
  const awarenessLinesNoAudio = [
    "[gently] Scusa, non ti ho sentito bene. Puoi ripetere?",
    "[softly] Eh, non ho capito — c'è un po' di rumore qui?",
    "[warmly] Aspetta, riprova — non ho sentito bene.",
    "[thoughtful] Mmh, ho sentito solo silenzio. Dimmi pure.",
    "[gently] Ti sento appena. Avvicinati o riprova quando puoi.",
  ];
  const awarenessLinesGarbled = [
    "[thoughtful] Ho sentito qualcosa ma non chiaro — puoi ripetere?",
    "[gently] Mi sembra che ci sia rumore. Riprova quando puoi.",
    "[softly] Non ho capito bene — dimmi di nuovo?",
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

  // ============================================================
  // FASE 1 STREAMING — Voice WS opt-in (giugno 2026)
  // ============================================================
  // Quando EXPO_PUBLIC_USE_WS_VOICE_STREAM=true, l'orb attiva questa
  // pipeline al posto del flusso classico (record → upload → STT → fastConverse).
  // Vantaggi:
  //  • Endpointing intelligente Deepgram → niente VAD volumetrico (cieco
  //    su Xiaomi MIUI, ingannato dal rumore di motore nel furgone)
  //  • Latenza: niente upload-then-wait di 14s su rete mobile lenta
  //  • Cross-platform: stesso codice JS iOS+Android
  // Cambia solo la fonte audio/STT — la timeline UI, la safety, le actions,
  // e il TTS playback rimangono identici al flusso esistente.
  // ============================================================
  const startTalkStreaming = async () => {
    if (status !== "idle" && status !== "speaking") return;
    // === GUARD 2026-06-28 v26 — protezione cascata ===
    // Anche se startTalkInternal ha già fatto i suoi check, blocchiamo
    // qui in caso il chiamante salti il debounce. Sintomo visto nei log:
    // 6+ sessioni WS in apertura allo stesso ms con showSettings=true.
    if (streamingSessionRef.current) {
      console.log("[KODA_STREAM_GUARD] startTalkStreaming aborted: session already active");
      return;
    }
    setError(null);
    if (!convActiveRef.current) emptyTurnsRef.current = 0;
    unlockSpeech().catch(() => {});

    // === FIX 2026-06-24 v3 (post-troubleshoot review) ===
    // Setup audio session — DELEGA TUTTO a prewarmMic() come fa
    // startTalkInternal. Prima facevo doppia setAudioModeAsync (qui +
    // dentro chunkLoop) creando 3 chiamate sovrapposte → race condition
    // sull'AudioSession che causava il blocco silenzioso. Ora una sola
    // chiamata, dentro prewarmMic, identica al flusso esistente.
    try {
      const ttsPlaying = SpeechMod.isSpeaking();
      if (status !== "speaking" && !ttsPlaying) {
        try { SpeechMod.stop(); } catch {}
      }
      // prewarmMic gestisce permessi + setAudioModeAsync + _nativeReady
      if (Platform.OS !== "web") {
        await prewarmMic();
      }
      console.log(`[KODA_STREAM_CLIENT] audio prep done (via prewarmMic)`);
    } catch (e) {
      console.warn(`[KODA_STREAM_CLIENT] audio prep failed: ${e}`);
    }

    // Placeholder optimistic (verrà aggiornato quando arriva stt_final)
    const optimisticId = `local-stream-${Date.now()}`;
    const optimistic: TimelineEntry = {
      id: optimisticId,
      role: "user",
      text: "…",
      timestamp: new Date().toISOString(),
      confessional: confessionalMode || undefined,
    };
    requestForceScroll();
    setTimeline((prev) => [...prev, optimistic]);
    setStatus("recording");

    let capturedMeta: any = null;
    let aiEntryId: string | null = null;

    try {
      const { voiceStreamConverse } = require("../lib/speech");
      const result = await voiceStreamConverse({
        ephemeral: confessionalMode,
        profileLang: "it",
        // === FIX 2026-07-26 v64.4 — voiceId client-authoritative ===
        // Passiamo esplicitamente il voice_id corrente scelto dall'utente.
        // Il server lo usa per la TTS di questa sessione, bypassando la
        // lettura del profilo (che può avere bug di sync su iPhone).
        // Fallback: se undefined, server usa _resolve_voice_id(profile).
        voiceId: profile?.settings?.tts_voice_id || undefined,
        // === FIX 2026-06-26 v18: timeout dinamico chat vs sfogo ===
        // Allineato a STREAM_HARD_CAP_MS_* + 60s margine pipeline.
        // - chat normale: 180s + 60s = 240s
        // - Stanza dello Sfogo: 300s + 60s = 360s
        timeoutMs: confessionalMode ? 360_000 : 240_000,
        onSession: (s: any) => {
          streamingSessionRef.current = s;
          // === FIX 2026-07-24 v63.5 (Fix B) — reset mic-active gate ===
          // Nuova sessione: il mic NON è ancora attivo (parte solo dopo
          // startRecognition, ~1s più tardi). Da qui in poi ignoriamo
          // i tap sull'orb finché onRecognitionActive non arriva.
          micReallyActiveRef.current = false;
          console.log(
            `[KODA_STREAM_CLIENT] session ref ${s ? "stored" : "cleared"}`
          );
          // === FIX 2026-07-11 v52 — TAP_STOP EARLY consumption ===
          // Se l'utente ha premuto tap-stop DURANTE la fase async pre-WS
          // (mentre stream stava aprendo la connessione), onBigButton ha
          // settato pendingTapStopRef=true perché non aveva ancora la
          // sessione. Ora che l'abbiamo, fermiamo subito con stop() →
          // il server processerà l'audio già inviato e risponderà,
          // NON continuiamo a registrare chunk aggiuntivi.
          if (s && pendingTapStopRef.current) {
            pendingTapStopRef.current = false;
            console.log(
              `[KODA_STREAM_CLIENT] pendingTapStopRef consumed → calling s.stop() now`
            );
            try {
              if (typeof s.stop === "function") {
                s.stop().catch?.(() => {});
              } else if (typeof s.abort === "function") {
                s.abort().catch?.(() => {});
              }
            } catch {}
          }
        },
        onAudioStart: () => {
          setStatus("speaking");
        },
        // === FIX 2026-07-24 v63.5 (Fix B) — mic really active ===
        onRecognitionActive: () => {
          micReallyActiveRef.current = true;
          console.log(`[KODA_MIC_GATE] mic really active — tap-stop now allowed`);
        },
        onUserFinal: (userText: string, conf: number | null, _dur: number | null) => {
          // === FIX 2026-06-25 v8 ===
          // Quando Deepgram emette stt_final, il microfono di fatto si è già
          // fermato (chunkLoopActive=false dentro voiceStream.ts). Senza
          // questa transizione, l'UI rimaneva in "recording" per i ~3-5s
          // che impiega Claude a generare la risposta + TTS — l'utente
          // pensava che stesse ancora registrando.
          setStatus("thinking");
          // === NO-SPEECH BACKOFF (2026-07-29) — parlato vero → reset ===
          // L'utente ha parlato davvero (transcript non vuoto arriva qui).
          // Marca il turno come "aveva parlato" così l'HF loop NON incrementa
          // il contatore no-speech, e resetta il contatore così i prossimi
          // eventuali no_speech ripartono dal delay più corto (450ms).
          turnHadSpeechRef.current = true;
          if (noSpeechCountRef.current > 0) {
            console.log(`[KODA_HF_BACKOFF_NOSPEECH] user parlato → reset counter (era ${noSpeechCountRef.current})`);
            noSpeechCountRef.current = 0;
          }
          // Aggiorna la bolla utente col testo trascritto reale.
          setTimeline((prev) =>
            prev.map((e) =>
              e.id === optimisticId ? { ...e, text: userText } : e
            )
          );
          if (typeof conf === "number") {
            lastSttConfidenceRef.current = conf;
            console.log(
              `[KODA_STREAM_CLIENT] user_final conf=${conf.toFixed(3)} text=${JSON.stringify(userText)}`
            );
          }
          // === FIX 2026-07-03 v45 CLIENT-SIDE close_session heuristic ===
          // Se l'utente ha detto un saluto di congedo, pausiamo il HF loop
          // SUBITO — non aspettiamo `meta.close_session` dal backend
          // (che potrebbe non arrivare se il deploy non è aggiornato).
          // Questo funziona sempre appena c'è il testo trascritto.
          if (detectCloseSessionClientSide(userText)) {
            console.log(
              `[KODA_CLOSE_SESSION] (client heuristic) matched → pausing HF loop | text=${JSON.stringify(userText)}`
            );
            setCloseSessionPause(true);
            closeSessionPauseRef.current = true;
          }
        },
        onMeta: (meta: any) => {
          capturedMeta = meta;
          try {
            aiEntryId = `stream-ai-${Date.now()}`;
            const aiEntry: TimelineEntry = {
              id: aiEntryId,
              role: "ai",
              text: stripDisplayTags(meta.reply || ""),
              voice_text: meta.voice_text || undefined,
              tone: (meta.tone as Tone) || "warm",
              timestamp: new Date().toISOString(),
              actions: meta.actions || undefined,
              confessional: confessionalMode || undefined,
            };
            setTimeline((prev) => [...prev, aiEntry]);
            if (Array.isArray(meta.actions) && meta.actions.length > 0) {
              runActions(meta.actions as any[]);
            }
            if (meta.close_session) {
              console.log("[KODA_CLOSE_SESSION] (stream) meta.close_session=true → pausing hands-free loop");
              setCloseSessionPause(true);
              closeSessionPauseRef.current = true;
            }
          } catch (e) {
            console.warn("[stream] onMeta handler error:", e);
          }
        },
      });

      if (!result.ok) {
        console.warn("[stream] failed:", result.error);
        // Se la bolla utente è ancora vuota, rimuoviamo l'optimistic.
        setTimeline((prev) => prev.filter((e) => e.id !== optimisticId || (e as any).text !== "…"));

        // === FIX 2026-07-14 v56 — Backoff HF loop su WS failures consecutivi ===
        wsFailureCountRef.current += 1;
        const failN = wsFailureCountRef.current;
        console.log(`[KODA_HF_BACKOFF] WS failure #${failN}/${WS_FAIL_THRESHOLD} (err=${result.error})`);
        if (failN >= WS_FAIL_THRESHOLD) {
          console.log(`[KODA_HF_BACKOFF] threshold reached → pausing HF loop, waiting for user tap`);
          setCloseSessionPause(true);
          closeSessionPauseRef.current = true;
          setError("Connessione persa. Tocca il cerchio per riprovare.");
          setTimeout(() => setError(null), 6000);
        } else {
          setError("Connessione voce interrotta. Riprova.");
          setTimeout(() => setError(null), 4000);
        }
      } else {
        // Successo → azzera il counter dei fallimenti consecutivi
        if (wsFailureCountRef.current > 0) {
          console.log(`[KODA_HF_BACKOFF] resetting counter (was ${wsFailureCountRef.current})`);
          wsFailureCountRef.current = 0;
        }
      }
    } catch (e) {
      console.error("[stream] crash:", e);
      setError("Errore voce streaming.");
      setTimeout(() => setError(null), 4000);
    } finally {
      setStatus("idle");
      // === FIX 2026-07-24 v63.5 (Fix B) — reset mic-active gate ===
      // Sessione terminata: il mic non è più attivo. Prossima sessione
      // dovrà re-triggerare onRecognitionActive per riautorizzare i tap.
      micReallyActiveRef.current = false;
      // === FIX 2026-06-28 v26 (P0 cascata WebSocket — log diag iPhone/Android) ===
      // Il vecchio re-trigger esplicito [KODA_HF_EXPLICIT] è stato RIMOSSO.
      // Causava una CASCATA ESPONENZIALE di sessioni WebSocket:
      //   1. Sessione finisce → finally → setTimeout(500ms) re-trigger
      //   2. Nessun controllo su showSettings, streamingSessionRef, o stato
      //      reale dell'audio → re-trigger fira anche con Impostazioni aperte
      //   3. Nuovo startTalkInternal → nuova WS → se fallisce subito (es.
      //      utente in Settings, voice change), finally rifira → cascata
      //   4. Ogni iterazione: N sessioni → N finally → N retrigger → 2N sess.
      // Risultato osservato nei log: 6+ WebSocket aperte allo stesso ms.
      // Soluzione: AFFIDIAMOCI ESCLUSIVAMENTE all'useEffect [KODA_HF_LOOP],
      // che ha tutti i guard corretti (showSettings, showColorIntro,
      // tourActive, sealUnlocking, streamingSessionRef, recRef, ecc.) e
      // viene triggerato automaticamente quando status → idle.
      // Se l'utente segnala "hands-free non riparte" su qualche caso edge,
      // si affronta lì — NON con un secondo trigger parallelo.
    }
  };

  // Push-to-talk (or hands-free)
  const startTalkInternal = async (autoStopOnSilence: boolean) => {
    // === MUTEX 2026-06-28 — P0 race condition fix ===
    // KODA_HF_LOOP (useEffect+timeout 450ms) e KODA_HF_EXPLICIT (timeout 500ms
    // dentro voiceStream finally) firavano in parallelo entro ~50-100ms,
    // entrambi passavano i guard (recRef=null in entrambi i closure) e
    // aprivano due WebSocket simultanee verso /api/voice/stream → si
    // killavano a vicenda (codici 1000/1006) → la voce si fermava dopo 1s.
    // Debounce timestamp-based 800ms: il primo passa, il secondo (entro
    // 800ms) viene scartato. Tra turni reali (30s+) entrambi sono OK.
    const now = Date.now();
    const sinceLast = now - lastStartTalkAtRef.current;
    if (sinceLast < 800) {
      console.log(`[KODA_HF_LOCK] startTalkInternal debounced (${sinceLast}ms since last call) — duplicate trigger blocked`);
      return;
    }
    lastStartTalkAtRef.current = now;

    // === FIX 2026-07-11 v52 — Reset pendingTapStop su nuova sessione ===
    // Se un tap-stop precedente aveva settato il flag ma non è mai stato
    // consumato (es. voiceStreamConverse fallì prima di onSession), la
    // nuova sessione verrebbe stoppata immediatamente. Reset qui.
    pendingTapStopRef.current = false;

    // === NO-SPEECH BACKOFF (2026-07-29) — reset flag "aveva parlato" ===
    // All'inizio di ogni sessione mic, resettiamo il flag turnHadSpeechRef.
    // Se durante la sessione arriva un `onUserFinal` con testo, il flag
    // diventa true e il counter no-speech si azzera. Se invece la sessione
    // si chiude senza mai vedere parlato (es. no_speech timeout, WS chiusa
    // senza transcript), il flag resta false e l'HF loop incrementerà il
    // counter e userà il delay progressivo alla prossima riapertura.
    turnHadSpeechRef.current = false;

    // === GUARD STREAMING SESSION (2026-06-28 v26 — diag log iPhone cascata) ===
    // Se una sessione WebSocket è già attiva, non aprirne un'altra. Questo
    // catch è la difesa decisiva contro la cascata di WS osservata nei log
    // (6+ sessioni aperte allo stesso millisecondo).
    if (streamingSessionRef.current) {
      console.log("[KODA_HF_LOCK] startTalkInternal blocked: streamingSessionRef.current is non-null (stream active)");
      return;
    }

    if (status !== "idle" && status !== "speaking") return;

    // === FASE 1 STREAMING OPT-IN (env flag, giugno 2026) ===
    // === FIX 2026-06-27 v19 (Android Xiaomi: bundle OTA non propaga env) ===
    // L'utente ha verificato sperimentalmente che `EXPO_PUBLIC_USE_WS_VOICE_STREAM=true`
    // nel .env NON arriva al bundle Android via OTA update (anche dopo
    // disinstalla + reinstall). Diag log Android mostra ancora il vecchio
    // path: [KODA_VAD_TRACE], [KODA_REC_CTX], [KODA_POLL], con metering
    // db=-100 costante (bug Xiaomi MIUI) → hands-free non chiude mai.
    // Su iPhone invece l'env arriva correttamente e WS streaming funziona.
    // Soluzione pragmatica: hardcoded a true. Il flag env resta letto per
    // retrocompatibilità futura, ma il default fallback è ora `true` invece
    // di stringa vuota. Mobile (iOS+Android) usa SEMPRE WS streaming.
    const envFlag = String(process.env.EXPO_PUBLIC_USE_WS_VOICE_STREAM || "true").toLowerCase();
    const useVoiceStream = envFlag !== "false"; // default true se assente nel bundle
    // === FIX 2026-06-27 v19 DIAG ===
    // Log esplicito così nel prossimo diag log Android possiamo verificare
    // se il fallback hardcoded sta funzionando. Se vedi questa riga col
    // valore true significa che il nuovo bundle è arrivato sul device.
    console.log(`[KODA_FLAG] useVoiceStream=${useVoiceStream} (env="${process.env.EXPO_PUBLIC_USE_WS_VOICE_STREAM ?? "<missing>"}", platform=${Platform.OS})`);
    if (useVoiceStream && Platform.OS !== "web") {
      return startTalkStreaming();
    }

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
      // === RECORDING DURATION (sprint v11) ===
      // Cattura timestamp avvio per misura recording_duration_ms nel SUMMARY.
      recordingStartedAtRef.current = Date.now();
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
    // === RECORDING DURATION (sprint v11) ===
    // Capture duration at the EXACT moment of stop, before any async work.
    // Used by [KODA_SUMMARY] downstream.
    if (recordingStartedAtRef.current !== null) {
      lastRecordingDurationMsRef.current = Date.now() - recordingStartedAtRef.current;
      recordingStartedAtRef.current = null;
    }
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
      // === SILERO VAD GATE — DISATTIVATO (Fabio 2026-06-27) ============
      // Il backend /api/vad/probe è uno STUB FAIL-OPEN: ritorna sempre
      // speech_ratio=1.0 perché `services.vad_silero` non è disponibile
      // (onnxruntime bloccato dai limiti CPU/RAM del cluster Emergent).
      // Lasciare attivo il gate significava uploadare il file audio COMPLETO
      // al backend per ottenere SEMPRE "PASS" — spreco netto di 2.5-7s
      // sulla rete cellulare in furgone (misurato in log reali Fabio
      // 2026-06-23: SILERO_GATE_MS=6812 / 3071 / 2523).
      //
      // FILTRAGGIO RUMORE: ora delegato esclusivamente a:
      //   1) Voice Processing iOS / voice_communication Android (chip DSP)
      //   2) VAD volumetrico client-side in voice.ts (CALIBRATION_MS)
      // Quando/se il backend riavrà Silero attivo, bastera rimettere
      // `gate = await checkHasSpeech({...})` qui sotto. Il flag esiste.
      // ================================================================
      const SILERO_GATE_DISABLED = true; // hardcoded finché backend è stub
      const sileroGateEnabled = !SILERO_GATE_DISABLED && (profile?.settings as any)?.silero_gate_enabled !== false;
      const _kt_gate_start = Date.now();
      const gate = sileroGateEnabled
        ? await checkHasSpeech({
            uri: res.uri,
            blob: res.blob,
            mime: res.mime,
            filename: res.filename,
            threshold: 0.15,
            timeoutMs: 8000,
            enabled: true,
            durationMs: lastRecordingDurationMsRef.current ?? undefined,
            bypassIfDurationMsAbove: 20000,
          })
        : {
            hasSpeech: true as const,
            reason: "fallback-disabled" as const,
            probe: null,
            latency_ms: 0,
          };
      logGateDecision(gate);
      console.log(`[KODA_TIMING] SILERO_GATE_MS=${Date.now() - _kt_gate_start}`);

      if (!gate.hasSpeech) {
        // Silero certifica: era rumore di sottofondo, non voce. Non
        // disturbiamo l'utente con un "Non ti ho sentito" pesante —
        // semplicemente rilanciamo il listen (hands-free) o usciamo
        // (manual mode). Same path della guardia client-side "no audio".
        console.log(
          `[KODA_VAD_GATE] BLOCKED — ratio=${gate.probe?.speech_ratio.toFixed(3)} ` +
          `(threshold=0.15). Skipping STT/LLM/TTS.`
        );
        if (convActiveRef.current) {
          // Non conta come "vuoto" pieno (sappiamo che era solo rumore),
          // ma incrementiamo lo stesso il counter per evitare loop infiniti
          // in casi degeneri (microfono guasto, ambiente troppo rumoroso).
          emptyTurnsRef.current += 1;
          if (emptyTurnsRef.current >= 4) {
            setConvActive(false);
            emptyTurnsRef.current = 0;
            await speakAwareness(pickLine(awarenessLoopExit));
            return;
          }
          // Feedback breve specifico per "solo rumore"
          setError("Solo rumore, non ho sentito una voce 🤔");
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
        // Manual mode: feedback breve, niente parlato
        setError("Solo rumore, non ho sentito una voce 🤔");
        setTimeout(() => setError(null), 2500);
        setStatus("idle");
        return;
      }
      // === FINE SILERO GATE ===
      // === OFFLINE INTERCEPT (sprint 2026-06-20) ===
      // Prima di tentare STT/LLM, verifico se siamo offline. Se sì, NON
      // chiamiamo Deepgram (fallirebbe con un timeout di 30s), ma riproduco
      // una delle 3 clip offline pre-cachate. Mantiene l'illusione di
      // presenza: Koda non scompare, dice "sono qui, ma offline".
      //
      // ANTI-LOOP (Claude PM feedback 2026-06-20): dopo
      // MAX_OFFLINE_CLIPS_IN_ROW clip consecutive senza che la rete sia
      // tornata, esco dal loop hands-free. L'utente ha capito, non lo
      // bombardiamo. Riprenderà con un tap manuale.
      //
      // CASO PRIMO AVVIO OFFLINE: se le clip non sono ancora cachate
      // (l'app è stata avviata per la prima volta senza rete) NON
      // resto in loop — esco subito da hands-free e mostro banner
      // chiaro "Niente connessione — riprova quando sei online".
      try {
        if (await isOfflineNow()) {
          const voiceId = (profile?.settings as any)?.tts_voice_id || "";
          console.log("[OfflineClips] detected offline before STT — playing clip");
          setStatus("speaking");
          const played = await playRandomOfflineClip(voiceId);
          setStatus("idle");

          if (!played) {
            // Clip non disponibili (primo avvio offline). Banner persistente
            // + esci da hands-free per evitare un loop vuoto.
            console.log("[OfflineClips] no cached clips — exiting hands-free with banner");
            setConvActive(false);
            offlineClipsInRowRef.current = 0;
            setError("Niente connessione — Koda è offline. Riprova quando torni online.");
            setTimeout(() => setError(null), 4500);
            return;
          }

          // Clip riprodotta. Conta e decide se continuare il loop.
          offlineClipsInRowRef.current += 1;
          if (offlineClipsInRowRef.current >= MAX_OFFLINE_CLIPS_IN_ROW) {
            // Abbiamo già detto N volte "sono offline". Basta.
            console.log("[OfflineClips] max clips reached — exiting hands-free");
            setConvActive(false);
            offlineClipsInRowRef.current = 0;
            setError("Sei offline 📡 — tocca l'orb quando torna la connessione.");
            setTimeout(() => setError(null), 4500);
            return;
          }

          // Auto-restart hands-free per il prossimo turno.
          if (profile?.settings?.input_mode !== "text" && convActiveRef.current) {
            setTimeout(() => {
              if (convActiveRef.current && !recRef.current) {
                startTalkInternal(true).catch(() => {});
              }
            }, 800);
          }
          return;
        }
        // Siamo online — reset counter offline (utile se l'utente ha avuto
        // un mini-blackout e poi è tornato online).
        if (offlineClipsInRowRef.current > 0) {
          offlineClipsInRowRef.current = 0;
        }
      } catch (e) {
        // Se il check offline fallisce per qualunque motivo, continuiamo
        // normalmente (la rete è il caso più comune).
        console.warn("[OfflineClips] offline check failed:", e);
      }

      // === KODA TIMING (ChatGPT sprint giugno 2026) ===
      // Marker temporale per misurare upload + Deepgram. Lo log usa
      // performance.now() per precisione sub-millisecondo. Stampato come
      // "[KODA_TIMING] LABEL Xms" così è grep-abile sui log device.
      const _kt_upload_start = Date.now();
      // === P0 FIX 2026-06-27: log dimensione audio per correlare upload lenti ===
      // Permette di capire se i 44s erano dovuti a un file grande su 4G ballerino
      // (es. 500KB/s ⇒ 1MB = 2s) o a un cold-start TLS / Deepgram bloccato.
      let _kt_audio_bytes = -1;
      try {
        if (res.blob) {
          _kt_audio_bytes = res.blob.size;
        } else if (res.uri && typeof require !== "undefined") {
          // RN FileSystem path: leggi size solo se è veloce (best-effort)
          const FS = require("expo-file-system/legacy");
          const info = await FS.getInfoAsync(res.uri, { size: true });
          if (info?.exists && typeof info.size === "number") {
            _kt_audio_bytes = info.size;
          }
        }
      } catch {}
      console.log(`[KODA_TIMING] UPLOAD_START @${_kt_upload_start} audio_bytes=${_kt_audio_bytes}`);
      // Fase 4 Step 1: usiamo Deepgram Nova-3 (più veloce e accurato di Whisper).
      // Fallback automatico a /transcribe (Whisper) se Deepgram fallisce.
      // === P0 FIX 2026-06-27 (timeout 44s su cold-start Bluetooth) ===
      // Aggiungiamo client-side timeout via AbortController: se la richiesta
      // si pianta (TLS cold-start, cellular ballerino, Deepgram down), dopo
      // 12s ABORT-iamo e cadiamo in fallback Whisper. Senza questo,
      // l'utente vedeva attese di 30-44s prima di un eventuale errore.
      const _stt_controller = new AbortController();
      const _stt_timer = setTimeout(() => _stt_controller.abort(), 12000);
      let r: Response;
      try {
        r = await fetch(`${API_BASE}/transcribe-deepgram`, {
          method: "POST",
          body: fd,
          signal: _stt_controller.signal,
        });
      } catch (e: any) {
        clearTimeout(_stt_timer);
        const isAbort = e?.name === "AbortError";
        console.warn(`[transcribe] Deepgram ${isAbort ? "TIMEOUT 12s" : "network error"}: ${e?.message || e}`);
        // Fallback rapido a Whisper con nuova FormData + nuovo timeout
        const fd_fb = buildFormData(res);
        const _wh_controller = new AbortController();
        const _wh_timer = setTimeout(() => _wh_controller.abort(), 15000);
        try {
          r = await fetch(`${API_BASE}/transcribe`, {
            method: "POST",
            body: fd_fb,
            signal: _wh_controller.signal,
          });
        } finally {
          clearTimeout(_wh_timer);
        }
      } finally {
        clearTimeout(_stt_timer);
      }
      const _kt_deepgram_done = Date.now();
      console.log(`[KODA_TIMING] UPLOAD_END+DEEPGRAM_END @${_kt_deepgram_done} (upload+stt_ms=${_kt_deepgram_done - _kt_upload_start})`);
      if (!r.ok) {
        console.warn(`[transcribe] Deepgram failed (${r.status}), fallback to Whisper`);
        // Ricreo FormData perché il body è già stato consumato
        const fd2 = buildFormData(res);
        const _wh2_controller = new AbortController();
        const _wh2_timer = setTimeout(() => _wh2_controller.abort(), 15000);
        try {
          r = await fetch(`${API_BASE}/transcribe`, {
            method: "POST",
            body: fd2,
            signal: _wh2_controller.signal,
          });
        } finally {
          clearTimeout(_wh2_timer);
        }
      }
      if (!r.ok) throw new Error("transcribe");
      const data = await r.json();
      const txt = (data.text || "").trim();
      // === AUDIO HONESTY (Fabio 2026-06-23) =====================
      // Catturiamo la confidence Deepgram per propagarla al backend nella
      // chiamata /converse-fast/start. Se < 0.7 il backend inietterà una
      // direttiva nel system prompt → Koda riconosce apertamente l'audio
      // rumoroso e chiede dove si trova l'utente invece di indovinare.
      const _stt_confidence: number | null =
        typeof data?.confidence === "number" ? data.confidence : null;
      lastSttConfidenceRef.current = _stt_confidence;
      if (_stt_confidence !== null) {
        console.log(`[AUDIO_HONESTY_CLIENT] stt_confidence=${_stt_confidence.toFixed(3)}`);
      }
      // === KODA_STT CLIENT LOG (sprint giugno 2026 — RCA "Koda parla spagnolo") ===
      // Il backend logga [KODA_STT] con text+lang+confidence, MA quei log
      // sono Python (server-side) e l'utente non li vede su /diagnostics.
      // Qui logghiamo lo stesso text lato client così è copiabile dal
      // pannello diagnostics dell'app. Se vediamo:
      //   [KODA_STT_CLIENT] text="hola como estas" → Deepgram sbaglia foneticamente
      //   [KODA_STT_CLIENT] text="ciao come stai" → STT OK, problema nel prompt LLM
      console.log(`[KODA_STT_CLIENT] text=${JSON.stringify(txt)} chars=${txt.length}`);
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

    // === FIX 2026-07-26 v64.0 — TAP-TO-RESET UNIFICATO (richiesta utente) ===
    //
    // COMPORTAMENTO PRECEDENTE (v63.5+):
    //   • Tap durante `recording` → session.stop() (graceful, invia "end"
    //     al server e aspetta la risposta di Koda).
    //   • Tap durante `speaking/thinking/transcribing` → HARD_STOP (kill
    //     tutto → idle).
    //
    // PROBLEMA:
    //   1. Comportamento inconsistente (a volte reset, a volte "send").
    //   2. La gate micReallyActiveRef bloccava il tap durante startup →
    //      su Android, quando il mic si blocca al 2° turno (bug hardware
    //      Google SpeechRecognizer post-stop), l'utente non poteva
    //      MAI riprendere il controllo (visivamente "recording" ma tap
    //      ignorato per sempre).
    //
    // NUOVO COMPORTAMENTO (richiesta esplicita Fabio 26/07):
    //   • Tap durante QUALSIASI stato non-idle (recording, transcribing,
    //     thinking, speaking) → HARD_STOP totale → idle. NIENTE gate mic.
    //   • Tap durante idle → avvia nuovo turno (comportamento invariato).
    //
    //   Il tap DEVE SEMPRE funzionare come escape universale. Se il mic
    //   non è ancora attivo perché il HW è in startup, killiamo lo
    //   stesso la sessione — costa zero (WS abort è idempotente) e
    //   sblocca situazioni degenerate.
    //
    // La logica di kill è la stessa del vecchio HARD_STOP (abort WS,
    // stop recorder, stop TTS, ecc.), applicata a TUTTI gli stati.
    if (status !== "idle") {
      console.log(`[KODA_TAP_RESET] tap → hard stop | state=${status} convActive=${convActiveRef.current} micActive=${micReallyActiveRef.current}`);
      // 1) Abort streaming session (chiude WS HARD, niente "end" → niente pipeline server-side)
      if (streamingSessionRef.current) {
        const s = streamingSessionRef.current as any;
        streamingSessionRef.current = null;
        try {
          if (typeof s.abort === "function") {
            s.abort().catch?.(() => {});
          } else if (typeof s.stop === "function") {
            s.stop().catch?.(() => {});
          }
        } catch {}
      }
      // 2) Reset flag pendenti (nel caso il tap arrivi durante lo startup async)
      pendingTapStopRef.current = false;
      micReallyActiveRef.current = false;
      // 3) Stop file-based recorder se attivo (legacy non-streaming path)
      if (recRef.current) {
        try {
          const r = recRef.current as any;
          recRef.current = null;
          r.stopAndUnloadAsync?.().catch?.(() => {});
        } catch {}
      }
      // 4) Stop TTS playback in corso + cancel HTTP requests in volo
      try { SpeechMod.stop(); } catch {}
      // 5) Disabilita loop hands-free conversazionale
      setConvActive(false);
      convActiveRef.current = false;
      // 6) Blocca auto-listen post hard-stop finché l'utente non ri-tappa.
      // Vedi FIX 2026-06-26 v13 — senza questo, il HF loop rilevava
      // status="idle" e ripartiva da solo dopo 450ms ("ho schiacciato
      // il pulsante ma non fa niente"). Il tap successivo (branch idle
      // in fondo a questa funzione) resetta closeSessionPauseRef.
      setCloseSessionPause(true);
      closeSessionPauseRef.current = true;
      // 7) UI immediatamente in idle
      setStatus("idle");
      return;
    }

    // === FIRST TAP (status === "idle") ===
    // Avvia la conversazione: abilita conv mode se configurato, sblocca
    // eventuale pausa close-session, e parte la registrazione.
    if (conversationOn) setConvActive(true);
    if (closeSessionPauseRef.current) {
      console.log("[KODA_CLOSE_SESSION] user tapped — resuming hands-free loop");
      setCloseSessionPause(false);
      closeSessionPauseRef.current = false;
      // === FIX 2026-07-14 v56 — reset backoff counter on manual tap ===
      if (wsFailureCountRef.current > 0) {
        console.log(`[KODA_HF_BACKOFF] user tap → reset WS failure counter (was ${wsFailureCountRef.current})`);
        wsFailureCountRef.current = 0;
      }
    }
    // === FIX 2026-06-28 (mutex bypass) ===
    // Tap esplicito dell'utente sull'orb: resetta il debounce così se
    // l'utente vuole riavviare subito dopo un hard-stop (entro 800ms),
    // il nuovo startTalkInternal NON viene scartato. Il debounce serve
    // solo a bloccare i DUPLICATI del loop hands-free, non i tap manuali.
    lastStartTalkAtRef.current = 0;
    startTalk();
  };

  // === LONG-PRESS HARD STOP 2026-07-08 (privacy kill-switch) ===
  // Trigger: tieni premuto l'orb per ~500ms in QUALSIASI stato non-idle.
  // Effetto: silenzio totale immediato — abort WS senza processing,
  // stop TTS, disattiva conversation mode, blocca hands-free loop.
  // Use case: l'utente è nel furgone, entra qualcuno, deve far sparire
  // tutto SUBITO senza che Koda risponda a quello che ha appena detto.
  // Il tap breve invece è il "walkie-talkie stop" (chiama session.stop()).
  const onBigButtonLongPress = () => {
    userInteractedRef.current = true;
    if (status === "idle") return;
    console.log(`[KODA_HARD_STOP] long-press kill-switch state=${status}`);
    if (streamingSessionRef.current) {
      const s = streamingSessionRef.current as any;
      streamingSessionRef.current = null;
      try {
        if (typeof s.abort === "function") {
          s.abort().catch?.(() => {});
        } else if (typeof s.stop === "function") {
          s.stop().catch?.(() => {});
        }
      } catch {}
    }
    if (recRef.current) {
      try {
        const r = recRef.current as any;
        recRef.current = null;
        r.stopAndUnloadAsync?.().catch?.(() => {});
      } catch {}
    }
    try { SpeechMod.stop(); } catch {}
    setConvActive(false);
    convActiveRef.current = false;
    setCloseSessionPause(true);
    closeSessionPauseRef.current = true;
    setStatus("idle");
    // Feedback aptico (se disponibile). Su iOS/Android nativi vibra
    // brevemente per confermare all'utente che il kill switch ha agito.
    try {
      // Import lazy per non appesantire l'entry.
      const Haptics = require("expo-haptics");
      Haptics?.notificationAsync?.(Haptics.NotificationFeedbackType.Warning).catch?.(() => {});
    } catch {}
  };

  // Mantieni le ref del gesture composto sincronizzate con la closure
  // corrente di onBigButton e con lo stato disabled (transcribing/thinking).
  // (Rimosso: ora il long-press è gestito via header invisibile.)

  // Debounce per evitare doppio-invio quando passiamo a onPressIn (vedi
  // commento sul TouchableOpacity del send button).
  const lastSendRef = useRef<number>(0);
  const sendTextFromBox = (overrideText?: string) => {
    // Anti-doppio-tap: ignora i tentativi a meno di 300ms l'uno dall'altro.
    const now = Date.now();
    if (now - lastSendRef.current < 300) return;
    lastSendRef.current = now;
    // === FIX ENTER DA TASTIERA (2026-06-22 v6) ===
    // Prima leggevamo `textInput` via closure dopo un setTimeout(0). Il
    // closure ha il valore di un render OLD, e in combinazione con
    // setTextInput(clean) prima del setTimeout, su iOS multiline poteva
    // succedere che il send non partisse o partisse col valore sbagliato.
    // Ora accettiamo un override opzionale: l'handler dell'Enter passa
    // direttamente la stringa pulita, senza dipendere dallo state.
    const txt = (overrideText !== undefined ? overrideText : textInput);
    if (!txt.trim()) return;
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
    // === FIX 2026-06-30 — Doppia conferma (Fabio "rischio cliccare per sbaglio") ===
    // Prima il bottone "Cancella tutta la memoria" partiva DIRETTAMENTE al
    // wipe → un tap accidentale cancellava tutto, irreversibile. Ora
    // richiediamo DUE conferme esplicite via Alert nativi:
    //  1. "Sei sicuro?" — primo livello di consapevolezza (Annulla di default)
    //  2. "Ultima conferma: davvero tutto?" — seconda barriera, intenzione
    //     espressa due volte. Bottone distruttivo a destra, in rosso
    //     (style: "destructive" su iOS), Annulla sempre prominente a sinistra.
    // Solo dopo entrambi gli OK procediamo con resetEverything().
    // Cancel di entrambi gli Alert = nessun reset, nessun side effect.
    const doWipe = async () => {
      try {
        await api.resetEverything();
        setTimeline([]);
        const p = await api.getProfile();
        setProfile(p);
        if (!p.onboarded) setShowOnboarding(true);
      } catch {}
      setShowSettings(false);
    };

    Alert.alert(
      "Cancellare tutta la memoria?",
      "Questo eliminerà profilo, taccuino, ricordi e ogni conversazione. L'operazione è IRREVERSIBILE.",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Continua",
          style: "destructive",
          onPress: () => {
            // Seconda conferma — barriera contro il "doppio tap" accidentale.
            Alert.alert(
              "Sei davvero sicuro?",
              "Ultima conferma: tutti i tuoi dati spariranno per sempre. Tornerai alla schermata della lingua iniziale.",
              [
                { text: "No, annulla", style: "cancel" },
                {
                  text: "Sì, cancella tutto",
                  style: "destructive",
                  onPress: () => { void doWipe(); },
                },
              ],
              { cancelable: true }
            );
          },
        },
      ],
      { cancelable: true }
    );
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

  // === FIX 2026-07-08 (Settings lag) ===
  // Forziamo input_mode = "both" a livello profilo. Prima veniva fatto con
  // un IIFE dentro il render del ScrollView delle Impostazioni, che
  // chiamava setInputMode() durante il rendering → re-render loop → scroll
  // laggava pesantemente. Ora è un useEffect one-shot che parte al caricamento
  // del profile e SOLO se il valore corrente non è già "both".
  useEffect(() => {
    if (profile && profile.settings?.input_mode !== "both") {
      setInputMode("both" as any).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.settings?.input_mode]);

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

    // === FIX 2026-07-26 v64.1 — Sync koda_voice with voice choice ===
    //
    // PROBLEMA (Fabio 26/07 iPhone):
    //   Utente cambia voce da femminile (Cielo) a maschile (Vento) in
    //   Impostazioni. Il preview riproduce la voce nuova. MA nella
    //   conversazione reale la voce resta Cielo (femminile). Su tutti
    //   i device — non solo iPhone.
    //
    // ROOT CAUSE (server.py getMe migration):
    //   Al prossimo GET /profile il server esegue una sync automatica:
    //     canonical_vid = _resolve_voice_id(p)  # ← dipende SOLO da p.koda_voice
    //     if p.settings.tts_voice_id != canonical_vid:
    //         p.settings.tts_voice_id = canonical_vid   # ← SOVRASCRIVE!
    //   Perché? Storicamente la fonte di verità era koda_voice (scelto in
    //   onboarding, "lockato"). Il campo tts_voice_id doveva restarci
    //   allineato. Cambiare solo tts_voice_id lato client viene "corretto"
    //   dal server al prossimo profile fetch.
    //
    // FIX:
    //   Quando l'utente cambia voce, mandiamo AL SERVER ANCHE koda_voice
    //   ("aria" per femminile / "theo" per maschile). Così la sync legge
    //   koda_voice=theo → resolve → maschile → tts_voice_id resta maschile.
    //
    //   Mappa voice_id → koda_voice (sync con backend server.py KODA_VOICES):
    //     POuqf18evoXOKIqV2Px7 (Cielo)  → "aria"
    //     ll9WG7PDTuyHwgC5MD6g (Vento) → "theo"
    //   Per voice_id non mappati (custom / futuri) non mandiamo koda_voice
    //   e ci fidiamo che il server abbia la mappatura giusta.
    const VOICE_ID_TO_KODA_VOICE: Record<string, "aria" | "theo"> = {
      "POuqf18evoXOKIqV2Px7": "aria",  // Cielo — femminile
      "ll9WG7PDTuyHwgC5MD6g": "theo",  // Vento — maschile
    };
    const kodaVoice = VOICE_ID_TO_KODA_VOICE[voiceId];

    // === DIAG v64.2 — log traccia completa cambio voce ===
    console.log(
      `[KODA_VOICE_CHANGE] user picked voice_id=${voiceId} → mapped koda_voice=${kodaVoice || "UNMAPPED"} | ` +
      `current_profile: koda_voice=${(profile as any)?.koda_voice ?? "?"} tts_voice_id=${profile.settings?.tts_voice_id ?? "?"}`
    );

    const next = {
      ...profile,
      settings: { ...profile.settings, tts_voice_id: voiceId },
      ...(kodaVoice ? { koda_voice: kodaVoice } : {}),
    };
    setProfile(next);
    setDefaultVoiceId(voiceId);
    // === FIX 2026-06-28 v26 — chiusura sessione attiva al cambio voce ===
    // Se l'utente cambia voce mentre una sessione streaming è in volo (es.
    // nella Stanza dello Sfogo con hands-free attivo), la sessione attuale
    // sta ancora ricevendo TTS con la VECCHIA voce. Senza chiudere prima la
    // sessione, il nuovo turno si scontra col vecchio audio → conflitto.
    // Chiudiamo la sessione corrente: il prossimo restart hands-free la
    // userà la voce nuova.
    if (streamingSessionRef.current) {
      const s = streamingSessionRef.current as any;
      streamingSessionRef.current = null;
      try {
        if (typeof s.abort === "function") s.abort().catch?.(() => {});
        else if (typeof s.stop === "function") s.stop().catch?.(() => {});
      } catch {}
    }
    // === OFFLINE CLIPS — preload per la nuova voce (idempotente) ===
    try { preloadOfflineClips(voiceId).catch(() => {}); } catch {}
    try {
      const updateBody: any = {
        settings: next.settings,
        // Includi koda_voice se noto per prevenire la sync server-side che
        // altrimenti sovrascriverebbe tts_voice_id (v64.1 fix voce iPhone).
        ...(kodaVoice ? { koda_voice: kodaVoice } : {}),
      };
      console.log(
        `[KODA_VOICE_CHANGE] PUT /profile body=${JSON.stringify({
          tts_voice_id: updateBody.settings?.tts_voice_id,
          koda_voice: updateBody.koda_voice ?? null,
        })}`
      );
      const resp: any = await api.updateProfile(updateBody);
      console.log(
        `[KODA_VOICE_CHANGE] PUT /profile OK — server returned: ` +
        `koda_voice=${resp?.koda_voice ?? "?"} tts_voice_id=${resp?.settings?.tts_voice_id ?? "?"} ai_gender=${resp?.ai_gender ?? "?"}`
      );
    } catch (e: any) {
      console.log(
        `[KODA_VOICE_CHANGE] PUT /profile FAILED: ${e?.message || String(e)}`
      );
    }
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

  // === Rimosso 2026-07-09: OTA UPDATE CHECK HANDLER ===
  // Handler `checkForOtaUpdate` rimosso su richiesta utente: non funzionava
  // sulla pipeline OTA di Emergent (Updates.checkForUpdateAsync restava
  // appeso senza rispondere). Pulsante corrispondente rimosso dalla UI.

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
      // === FIX #1 + #11 REPLAY TTS (2026-06-22 v8) ===
      // Bug #1 risolto: non leggere ad alta voce "[TONE:warm]".
      // Bug #11 risolto: preservare gli audio tags ElevenLabs ([sigh],
      // [laughs], [whispered]) che il backend mette in voice_text per
      // dare prosody migliore al TTS — la prima riproduzione li usava,
      // il replay con stripDisplayTags li perdeva → prosody piatta.
      // Soluzione: stripToneMarkerOnly rimuove solo il meta-marker TONE,
      // preservando i bracket tag legittimi per ElevenLabs.
      const ttsText = stripToneMarkerOnly(entry.voice_text || entry.text);
      await SpeechMod.speak(ttsText, {
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
  /**
   * Tap-on-voice-card handler: select the voice AND immediately play a short
   * preview using that voice. One gesture, no separate play button.
   *
   * === Rimozione nomi voce dalla preview (Fabio 2026-08-12) ================
   * Prima: la preview diceva "Ciao, sono ${name}. Sarò io a parlarti..."
   * dove name = "Cielo"/"Vento". L'utente NON deve mai sentire questi nomi
   * (decisione già presa per paywall/UI, estesa qui alla preview vocale).
   * Ora: frase generica identica per entrambe le voci. L'utente riconosce
   * la voce dal SUONO, non dal nome.
   */
  const selectAndPreviewVoice = async (voiceId: string, _name: string) => {
    // Update selection (saves to profile, sets default)
    await setVoice(voiceId);
    // Stop any current playback and play preview with the new voice
    SpeechMod.stop();
    try {
      setVoicePreviewLoading(voiceId);
      // Make sure browser audio is unlocked (web)
      await unlockSpeech();
      await SpeechMod.speak(
        `Ciao. Sarò io a parlarti, da adesso.`,
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

  // === v64.15 (2026-08-01) PERF FIX — scrollPeek convertito da useState a useRef ===
  // Prima: `useState(0)` chiamato dentro onTimelineScroll (~30 volte/s).
  // Ogni setState triggerava un re-render del root Taccuino (8000 righe).
  // Il root re-render invalidava anche le Bubble (memo shallow-check falliva
  // sui callback e derivati inline creati ogni render).
  // Risultato misurato v64.14: FPS 13-20 durante scroll, 285 Bubble render/s.
  //
  // scrollPeek NON è letto da nessuna parte nel render → era dead state.
  // Convertito a useRef: i calcoli restano identici (velocity smoothing per
  // eventuale futuro utilizzo Orb-lean), ma zero re-render del root.
  const scrollPeekRef = useRef(0);
  const lastScrollY = useRef(0);
  const scrollDecayTimer = useRef<any>(null);
  // === SCROLL-TO-BOTTOM FAB STATE (Fix 2026-06-22) ===
  // Tracciamo se l'utente è vicino al fondo della timeline. Se SÌ →
  // auto-scroll sui nuovi messaggi (idempotente, animated:false → niente
  // intersezione di animazioni → niente bounce loop). Se NO → mostriamo
  // un FAB "↓" e NON forziamo lo scroll (rispettiamo l'utente che sta
  // leggendo i messaggi vecchi).
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  // === FORCE SCROLL WINDOW (Fix #4 — 2026-06-22 v6) ===
  // Quando l'utente invia un messaggio (o riceve una risposta dopo un
  // suo invio), VUOLE vedere il nuovo messaggio anche se stava
  // scrollando indietro a rileggere. Apriamo una "finestra" di 15s
  // dall'invio durante la quale ogni setTimeline forza lo scroll in
  // fondo, ignorando il check isNearBottom (che vale solo per i
  // messaggi "passivi", es. risposta inattesa quando l'utente non sta
  // scrivendo). La finestra si chiude appena status → idle.
  const forceScrollUntilRef = useRef<number>(0);
  const requestForceScroll = useCallback(() => {
    forceScrollUntilRef.current = Date.now() + 15000;
  }, []);

  // === #9 DEBUG LATENZA (Fix 2026-06-22 v8) ===
  // Overlay nascosto attivabile con 5 tap rapidi sul contatore Freemium
  // (sempre visibile in alto). Mostra la timeline T0..T_end del turno
  // corrente, utile per misurare la latenza reale nel furgone senza Mac.
  const [latencyDebugVisible, setLatencyDebugVisible] = useState(false);
  const tapCountRef = useRef(0);
  const tapFirstAtRef = useRef(0);
  const onSecretDebugTap = useCallback(() => {
    const now = Date.now();
    if (now - tapFirstAtRef.current > 2000) {
      // Reset finestra di 2s
      tapCountRef.current = 0;
      tapFirstAtRef.current = now;
    }
    tapCountRef.current += 1;
    if (tapCountRef.current >= 5) {
      tapCountRef.current = 0;
      setLatencyDebugVisible((v) => !v);
    }
  }, []);
  // === MISURAZIONE BOTTOM BAR (Fix 2026-06-22 v3) ===
  // Misuriamo l'altezza REALE della bottom bar tramite onLayout invece di
  // indovinarla. Così l'ultimo messaggio in fondo finisce ESATTAMENTE
  // sopra la barra di scrittura (niente più bolle tagliate dietro
  // l'input, come negli screen dell'utente). Default 140 = stima sicura
  // per il primo render, prima che onLayout si sia fired.
  const [bottomBarHeight, setBottomBarHeight] = useState(140);
  const onTimelineScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    const layoutH = e?.nativeEvent?.layoutMeasurement?.height ?? 0;
    const contentH = e?.nativeEvent?.contentSize?.height ?? 0;
    const delta = y - lastScrollY.current;
    lastScrollY.current = y;
    // Coda peeks UP when user scrolls up (looking back), DOWN when scrolling down.
    // v64.15: aggiorna ref invece di setState → zero re-render root
    scrollPeekRef.current = Math.max(-100, Math.min(100, scrollPeekRef.current * 0.6 + delta * 1.4));
    if (scrollDecayTimer.current) clearTimeout(scrollDecayTimer.current);
    scrollDecayTimer.current = setTimeout(() => {
      scrollPeekRef.current = 0;
    }, 350);
    // distanza dal fondo: se >120px → mostra FAB, altrimenti nascondilo.
    // isNearBottom RESTA state perché è letto nel render (mostra/nasconde FAB),
    // ma cambia raramente (solo al passaggio della soglia dei 120px).
    const distFromBottom = Math.max(0, contentH - (y + layoutH));
    const near = distFromBottom < 120;
    if (near !== isNearBottomRef.current) {
      isNearBottomRef.current = near;
      setIsNearBottom(near);
    }
  }, []);
  // Handler per scroll-to-bottom manuale (FAB tap)
  // === FIX SCROLL "A STEP" — RISOLTO ALLA RADICE (2026-06-22 v5) ===
  // Prima con FlatList: scrollToEnd raggiungeva solo l'ultimo item
  // RENDERIZZATO (initialNumToRender=20) → ogni tap caricava 10-12 items
  // → step-scrolling fastidioso.
  // Ora con FlashList: cell recycling invece di mount/unmount.
  // scrollToEnd raggiunge sempre il fondo reale in UN colpo. Niente
  // workaround multi-round, niente setTimeout — basta una chiamata.
  const scrollToBottom = useCallback((animated = true) => {
    const fl = scrollRef.current;
    if (!fl) return;
    try {
      isNearBottomRef.current = true;
      setIsNearBottom(true);
      fl.scrollToEnd({ animated });
    } catch {}
  }, []);

  // === Caveat handwritten font — used for AI replies to evoke "diary
  //     written together with a friend". User text stays system-default
  //     (more neutral, like a clean note).
  // FABIO 2026-06-21 v15: caricato via expo-font + file .ttf locali in
  // assets/fonts/ (sostituito @expo-google-fonts/caveat, vietato dal pipeline).
  const [fontsLoaded] = useFonts({
    Caveat_400Regular: require("../assets/fonts/Caveat_400Regular.ttf"),
    Caveat_500Medium: require("../assets/fonts/Caveat_500Medium.ttf"),
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

  // Build the screen wrapper. Il tema (giorno/notte/auto-orario) è
  // l'unica fonte del colore di sfondo. I vecchi override (BG_PRESETS,
  // Liquid, Aurora, immagini custom) sono stati rimossi il 2026-08-04.
  const screenInner = (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {/* === ORB MEASURE DEBUG OVERLAY — RIMOSSO (Fabio 2026-08-12) ===
          L'overlay in basso a sinistra (HOME orb y=... h=... cY=...)
          serviva a calibrare la posizione dell'orb rispetto a /intro-v2.
          Rimosso ora che layout è stabile. */}
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
          attiva/disattiva la modalità (da voce o da toggle).
          Posizione (Fabio 2026-08-12): centrato nello spazio negativo tra
          il pill "Lascia andare" (~top 150) e l'orb eclipse (~top 272) —
          non deve MAI coprire "Lascia andare" né toccare l'orb. */}
      {handsFreeToast && (
        <View
          style={[
            styles.savedBanner,
            { top: Math.max(insets.top + 195, 235) },
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
          parlare. Sparisce automaticamente o appena il VAD rileva voce.
          Stessa posizione del toast per coerenza visiva. */}
      {listenBanner && !handsFreeToast && (
        <View
          style={[
            styles.savedBanner,
            { top: Math.max(insets.top + 195, 235) },
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
        {/* Slot sinistro: toggle Hands-Free.
            Modello mentale (2026-08-12):
              - default = automatico (hands-free ON): orb piccolo fermo +
                arco verde che scorre fluido lungo il perimetro.
              - tap = passa a manuale: orb resta, l'arco sparisce.
              - tap di nuovo = torna automatico.
            L'icona è UNA sola (<HandsFreeOrb>), cambia solo il suo stato
            visivo tramite la prop `active`. */}
        <TouchableOpacity
          ref={handsFreeBtnRef}
          style={[styles.headerBtn, { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }]}
          onPress={() => setHandsFreeMode(!handsFree)}
          hitSlop={20}
          testID="hands-free-toggle"
          accessibilityLabel={handsFree ? "Modalità automatica attiva, tocca per passare a manuale" : "Modalità manuale, tocca per tornare all'automatico"}
        >
          <HandsFreeOrb active={handsFree} size={26} />
        </TouchableOpacity>
        {/* Slot destro: Menu impostazioni. Pulsante audio Modalità Telefono
            rimosso nel rollback 2026-07-13 (regressioni STT). */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
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
              // === LASCIA ANDARE (2026-07-17) ============================
              // Prima: apriva il flusso "Stanza dello Sfogo" (Confessionale
              // Zero-Knowledge con STT/LLM/TTS cifrati). Nuovo concept
              // richiesto dall'utente: "Un posto dove nessuno risponde"
              // — ZERO trascrizione, ZERO Claude, ZERO ElevenLabs, ZERO
              // rete. Solo VAD locale + orb come feedback silenzioso.
              // Il vecchio codice confessional resta dormiente in questo
              // file (rimozione rimandata al prossimo refactor per non
              // introdurre regressioni). Qui semplicemente navighiamo
              // al nuovo screen /lascia-andare.
              //
              // === 2026-07-27 — Presenza vocale in apertura/chiusura ===
              // Passiamo la voce Koda scelta dall'utente come route param
              // così la Stanza sa quale file audio pre-registrato
              // riprodurre ("Prenditi il tuo tempo" all'apertura,
              // "Grazie per averlo lasciato andare" alla chiusura).
              // Mappatura (sync con backend server.py KODA_VOICES):
              //   POuqf18evoXOKIqV2Px7 (Cielo)  → "aria"
              //   ll9WG7PDTuyHwgC5MD6g (Vento) → "theo"
              // Preferiamo koda_voice se presente (fonte di verità),
              // altrimenti derivo da tts_voice_id, altrimenti "aria" (default).
              const VID_TO_KV: Record<string, "aria" | "theo"> = {
                "POuqf18evoXOKIqV2Px7": "aria",
                "ll9WG7PDTuyHwgC5MD6g": "theo",
              };
              const kv =
                ((profile as any)?.koda_voice as string | undefined) ||
                VID_TO_KV[(profile?.settings?.tts_voice_id as string) || ""] ||
                "aria";

              // === LIVELLO 1 GUARD (Fabio 2026-08-12) =====================
              // Fonte di verità server-side: chiama /api/lascia-andare/authorize
              // PRIMA di navigare. Se non allowed o rete assente/errore
              // → DEFAULT DENY (no varchi anche gratuiti).
              // Livello 2 (mount check dentro /lascia-andare) fa da belt-and-
              // suspenders per race condition e deep-link.
              let allowed = false;
              try {
                const res = await api.authorizeLasciaAndare();
                allowed = Boolean(res?.allowed);
              } catch (e) {
                // Offline o errore → default-deny esplicito. Non aprire varchi.
                console.warn("[LasciaAndare] authorize failed (default-deny):", e);
                allowed = false;
              }

              if (!allowed) {
                Alert.alert(
                  "Lascia Andare non è disponibile",
                  "Questa stanza è riservata a chi ha un abbonamento attivo. Scegli un piano per continuare a stare con Koda.",
                  [
                    { text: "Non ora", style: "cancel" },
                    { text: "Vedi i piani", onPress: () => router.push("/paywall") },
                  ],
                );
                return;
              }

              try {
                router.push(`/lascia-andare?voice=${encodeURIComponent(kv)}`);
              } catch (e) {
                console.warn("[LasciaAndare] navigation error:", e);
              }
            }}
            onLongPress={undefined}
            hitSlop={10}
            testID="lascia-andare-toggle"
          >
            <Text
              style={[
                styles.confessionalToggleText,
                // === FIX 2026-06-28 v30 — bianco SEMPRE ===
                // L'utente ha chiesto esplicitamente: pill opaca + testo
                // bianco PIENO in ogni schermata (home + timeline) e in
                // ogni stato. Nessun override condizionale: il bianco
                // #FFFFFF deve restare costante.
              ]}
            >
              Lascia andare
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
        keyboardShouldPersistTaps="handled"
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
                  onLongPress={onBigButtonLongPress}
                  delayLongPress={500}
                  // === HARD STOP 2026-06-26: orb sempre tappabile ===
                  // Prima: disabled durante transcribing/thinking, ma l'utente
                  // ha chiesto esplicitamente di poter interrompere TUTTO in
                  // qualsiasi stato (per privacy). Ora il tap funziona sempre.
                  // === LONG-PRESS 2026-07-08 ===
                  // Tap breve = graceful stop (ho finito parlare, tocca a te).
                  // Long-press (500ms) = kill-switch privacy (silenzio totale).
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
                      speechActive={speechActive}
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
                      // === SPEAKING COLOR LEGATO ALLA VOCE (2026-06) ===
                      // Acqua = viola (palette warm originale)
                      // Vento = cobalto vivo (#2563EB)
                      // Se voiceId è null/sconosciuto → palette null → fallback al tone.
                      speakingPaletteOverride={getVoiceSpeakingPalette(
                        (profile?.settings as any)?.tts_voice_id
                      )}
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
        <TouchableOpacity
          activeOpacity={1}
          onPress={onSecretDebugTap}
          style={{ paddingTop: Math.max(insets.top + 6, 50), paddingBottom: 4 }}
        >
          <FreemiumCounter
            visible={true}
            remaining={freemium.free_messages_remaining}
            total={freemium.free_messages_limit}
          />
        </TouchableOpacity>
      ) : null}
      {/* === #9 DEBUG TAP ZONE (Fix 2026-06-22 v8) ===
          Zona invisibile 60×60 in alto a destra: 5 tap rapidi (entro 2s)
          aprono/chiudono l'overlay di debug latenza. È un fallback al
          tap sul Freemium counter (che potrebbe non essere visibile se
          l'utente è abbonato). */}
      <TouchableOpacity
        onPress={onSecretDebugTap}
        activeOpacity={1}
        style={{
          position: "absolute",
          top: Math.max(insets.top, 20),
          right: 8,
          width: 60,
          height: 60,
          zIndex: 50,
        }}
        accessibilityLabel="debug-tap-zone"
        testID="debug-tap-zone"
      />
      <LatencyOverlay
        visible={latencyDebugVisible}
        onClose={() => setLatencyDebugVisible(false)}
      />
      {/* === TIMELINE: FlashList (refactor 2026-06-22 v5) ===
          Migrato da FlatList a @shopify/flash-list per risolvere
          definitivamente i bug di virtualizzazione:
          - FAB "a step" (scrollToEnd fermava all'ultimo item renderizzato):
            FlashList ricicla le celle invece di smontarle, quindi
            scrollToEnd raggiunge sempre la fine reale in un colpo.
          - Loop di scroll dopo riapertura app (onContentSizeChange
            oscillante): niente più mount/unmount continui, niente
            oscillazioni di altezza.
          API identica a FlatList — nessuna feature visiva persa. */}
      <FlashList
        ref={scrollRef}
        data={timelineWithSeparators}
        keyExtractor={(it) => (it.kind === "sep" ? it.key : it.entry.id)}
        keyboardShouldPersistTaps="handled"
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
        getItemType={(it) =>
          it.kind === "sep" ? "sep" : it.kind === "msg-mock" ? "mock" : "msg"
        }
        contentContainerStyle={{
          paddingTop: Math.max(insets.top + 70, 130),
          // === FIX PADDING DINAMICO KEYBOARD-AWARE (2026-06-22 v4) ===
          // onLayout misura il bottomBar SOLO quando la View cambia
          // dimensione, NON quando la tastiera la sposta in alto (è solo
          // un marginBottom). Aggiungiamo kbHeight per coprire l'area
          // dietro la tastiera quando aperta — così l'ultima bolla resta
          // sempre sopra l'input qualunque sia lo stato della tastiera.
          paddingBottom: bottomBarHeight + 12
            + (kbHeight > 0 ? kbHeight - insets.bottom : 0),
          paddingHorizontal: 16,
        }}
        showsVerticalScrollIndicator={false}
        testID="timeline"
        onScroll={onTimelineScroll}
        scrollEventThrottle={32}
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

      {/* === SCROLL-TO-BOTTOM FAB (2026-06-22) ===
          Visibile SOLO quando l'utente è scrollato verso l'alto (>120px
          dal fondo). Permette di rientrare in fondo con un tap, senza
          dover scorrere manualmente la conversazione. Posizionato
          appena sopra la bottom bar, allineato a destra. */}
      {!isNearBottom && timeline.length > 0 ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.scrollFabContainer,
            {
              // === POSIZIONE FAB DINAMICA (Fix 2026-06-22 v3) ===
              // Si posiziona sempre 12px sopra la barra di scrittura
              // misurata realmente (niente più valori magici 88/132).
              bottom: bottomBarHeight + 12
                + (kbHeight > 0 ? kbHeight - insets.bottom : 0),
            },
          ]}
        >
          <GHTouchableOpacity
            onPress={() => scrollToBottom(true)}
            activeOpacity={0.85}
            style={[
              styles.scrollFab,
              {
                backgroundColor: bubbleAccent.color || theme.primary,
                borderColor: "rgba(255,255,255,0.18)",
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Scorri in basso ai messaggi recenti"
            testID="scroll-to-bottom-fab"
          >
            <Ionicons name="arrow-down" size={22} color={theme.primaryText || "#FFFFFF"} />
          </GHTouchableOpacity>
        </View>
      ) : null}

      {/* Bottom area: voice OR text — chosen via settings */}
      <View
        onLayout={(e) => {
          // === MISURAZIONE BOTTOM BAR (Fix 2026-06-22 v3) ===
          // Misuriamo l'altezza reale (input + padding + safe area + errori)
          // così il paddingBottom della FlatList è SEMPRE corretto e
          // l'ultima bolla non finisce mai dietro la barra di scrittura.
          const h = e?.nativeEvent?.layout?.height;
          if (typeof h === "number" && h > 0 && Math.abs(h - bottomBarHeight) > 2) {
            setBottomBarHeight(h);
          }
        }}
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
                      // === FIX ENTER (v6) ===
                      // Passiamo `clean` DIRETTAMENTE a sendTextFromBox
                      // come override, evitando il race condition tra
                      // setTextInput async e setTimeout 0 che leggeva il
                      // valore vecchio via closure.
                      sendTextFromBox(clean);
                    } else {
                      setTextInput("");
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
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
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
                          sendTextFromBox(clean);
                        } else {
                          setTextInput("");
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
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
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
              removeClippedSubviews={Platform.OS === "android"}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
{showSettings && (<>

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
                  { id: "n", label: "Neutro" },
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

            {/* === "Koda è…" (ai_gender) — RIMOSSO 2026-07-24 pre-lancio ===
                Prima qui c'era un selettore esplicito Femmina/Maschio/Neutro
                per il genere grammaticale di Koda. Ridondante: durante
                l'onboarding l'utente sceglie GIÀ la voce (Cielo=femminile,
                Vento=maschile), e il codice mappa la voce a ai_gender
                automaticamente (KodaIntro.tsx). Chiedere due scelte separate
                per la stessa cosa creava confusione ai primi utenti.
                Il valore ai_gender resta nel profilo, viene solo derivato
                automaticamente dalla voce, non più esposto in Impostazioni.
                (Un'eventuale opzione "Neutro" avanzata sarà aggiunta come
                impostazione nascosta se richiesto — non ora.) */}

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
                  <Text style={styles.settingLabel}>💌 Koda mi scrive quando attivo</Text>
                  <Text style={styles.settingHint}>
                    Se abilitato, Koda ti scrive di sua iniziativa, quando sente
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
              <Text style={[styles.settingHint, { fontSize: 13, marginTop: 2, fontStyle: "italic" }]}>
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
                    recenti. In Lascia andare resta sempre spento.
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

            {/* === TEMA RIMOSSO 2026-08-04 (Fabio, dati alla mano) ===
                Rimosso il selettore Chiaro/Scuro/Auto: 65-95% degli utenti
                smartphone preferisce dark; per uso emotivo serale/notturno
                (caso Koda) la preferenza sale a 87-91%. Koda ora è
                dark-only. Vedi lib/theme.tsx per la palette unica. */}

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
                { v: 1.35, label: "A", name: "XL" },
              ].map(({ v, label, name }) => {
                const active = Math.abs(textSize - v) < 0.02;
                return (
                  <TouchableOpacity
                    key={v}
                    onPress={() => setTextSize(v)}
                    style={[
                      styles.modeBtn,
                      { flex: 1, flexDirection: "column", paddingHorizontal: 4, minHeight: 56 },
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
                    <Text
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                      style={[styles.modeBtnText, { fontSize: 10, marginTop: 4, fontWeight: "600", textAlign: "center" }, active && { color: bubbleAccent.color }]}
                    >
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

            {/* === BORDO — Calibrazione utente (2026-08-02, Fabio) ============
                Su alcuni schermi curvi Android (Honor, Xiaomi 4-lati) il
                NeonBorder default si vede poco perché la curvatura fisica
                del vetro lo copre agli angoli. L'utente può calibrare
                radius/spessore/colore idle a occhio, valori persistiti
                per-device in SecureStore locale. */}
            <View style={styles.divider} />
            <Text style={styles.settingsSubtitle}>Bordo dello schermo</Text>
            <Text style={styles.settingsHint}>
              Se il bordo colorato di Koda si vede poco agli angoli del tuo
              telefono, usa questi controlli per calibrarlo.
            </Text>

            {/* Slider raggio angoli */}
            <View style={{ marginTop: 12 }}>
              <Text style={styles.settingsHint}>
                Raggio angoli: {borderCal.radius ?? "auto"}
                {borderCal.radius !== null ? " px" : " (rilevato)"}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                <TouchableOpacity
                  onPress={async () => {
                    const cur = borderCal.radius ?? 48;
                    const next: BorderCalibration = { ...borderCal, radius: Math.max(0, cur - 4) };
                    setBorderCal(next);
                    await saveBorderCalibration(next);
                  }}
                  style={[styles.modeBtn, { paddingHorizontal: 14, minHeight: 40 }]}
                  accessibilityLabel="Riduci raggio bordo"
                >
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: "600" }}>−</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, height: 6, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 3 }}>
                  <View
                    style={{
                      height: "100%",
                      width: `${Math.min(100, ((borderCal.radius ?? 48) / 70) * 100)}%`,
                      backgroundColor: bubbleAccent.color,
                      borderRadius: 3,
                    }}
                  />
                </View>
                <TouchableOpacity
                  onPress={async () => {
                    const cur = borderCal.radius ?? 48;
                    const next: BorderCalibration = { ...borderCal, radius: Math.min(70, cur + 4) };
                    setBorderCal(next);
                    await saveBorderCalibration(next);
                  }}
                  style={[styles.modeBtn, { paddingHorizontal: 14, minHeight: 40 }]}
                  accessibilityLabel="Aumenta raggio bordo"
                >
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: "600" }}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Slider spessore */}
            <View style={{ marginTop: 12 }}>
              <Text style={styles.settingsHint}>
                Spessore: {borderCal.thickness ?? "auto"}
                {borderCal.thickness !== null ? " px" : ` (auto: ${Platform.OS === "android" ? 4 : 3} px)`}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
                <TouchableOpacity
                  onPress={async () => {
                    const cur = borderCal.thickness ?? (Platform.OS === "android" ? 4 : 3);
                    const next: BorderCalibration = { ...borderCal, thickness: Math.max(2, cur - 1) };
                    setBorderCal(next);
                    await saveBorderCalibration(next);
                  }}
                  style={[styles.modeBtn, { paddingHorizontal: 14, minHeight: 40 }]}
                  accessibilityLabel="Riduci spessore bordo"
                >
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: "600" }}>−</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, height: 6, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 3 }}>
                  <View
                    style={{
                      height: "100%",
                      width: `${Math.min(100, ((borderCal.thickness ?? (Platform.OS === "android" ? 4 : 3)) / 6) * 100)}%`,
                      backgroundColor: bubbleAccent.color,
                      borderRadius: 3,
                    }}
                  />
                </View>
                <TouchableOpacity
                  onPress={async () => {
                    const cur = borderCal.thickness ?? (Platform.OS === "android" ? 4 : 3);
                    const next: BorderCalibration = { ...borderCal, thickness: Math.min(6, cur + 1) };
                    setBorderCal(next);
                    await saveBorderCalibration(next);
                  }}
                  style={[styles.modeBtn, { paddingHorizontal: 14, minHeight: 40 }]}
                  accessibilityLabel="Aumenta spessore bordo"
                >
                  <Text style={{ color: theme.text, fontSize: 18, fontWeight: "600" }}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Toggle colore idle alternativo */}
            <View style={[styles.settingRow, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Colore idle più visibile</Text>
                <Text style={styles.settingHint}>
                  Sostituisce il champagne con un azzurro chiaro. Utile su
                  schermi curvi dove il champagne si vede poco.
                </Text>
              </View>
              <Switch
                value={borderCal.useAltIdleColor}
                onValueChange={async (v) => {
                  const next: BorderCalibration = { ...borderCal, useAltIdleColor: v };
                  setBorderCal(next);
                  await saveBorderCalibration(next);
                }}
                trackColor={{ false: "#555", true: bubbleAccent.color }}
              />
            </View>

            {/* Reset a default */}
            <TouchableOpacity
              onPress={async () => {
                await resetBorderCalibration();
                setBorderCal(DEFAULT_CALIBRATION);
              }}
              style={{ marginTop: 12, alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12 }}
              accessibilityLabel="Ripristina calibrazione bordo predefinita"
            >
              <Text style={[styles.settingsHint, { textDecorationLine: "underline" }]}>
                Ripristina valori predefiniti
              </Text>
            </TouchableOpacity>

            {/* === MODALITÀ INPUT RIMOSSA (richiesta utente 2026-06) ===
                L'utente passa già da voce a scrittura tramite lo swipe tra
                le due pagine principali (home voce ↔ chat scrittura).
                Avere un toggle in Settings era ridondante e confondeva. */}
            {/* Forziamo internamente input_mode su "both" così entrambi
                i pannelli restano disponibili nel layout.
                MOVED to useEffect — chiamare setInputMode() dentro render
                causava re-render ricorrenti che laggavano lo scroll. */}

            {/* === HEADER VOCI: RIMOSSO IL VECCHIO HEADER QUI (2026-06-27 v22) ===
                Era presente un doppio header "Voce dell'assistente" + hint
                "Tocca per selezionare. Premi ▶ per ascoltare un'anteprima."
                seguito dall'indicatore Confidenza e poi da un altro header
                "🎙️ Scegli la voce di Koda" + il nuovo selettore a cerchi.
                Risultato: l'utente vedeva il vecchio titolo + testo, dava
                per scontato che la UI fosse quella, e il selettore a cerchi
                colorati restava fuori schermo. Adesso resta solo il nuovo
                header sopra i cerchi (a ~50 righe sotto). */}

            {/* === INDICATORE CONFIDENZA (richiesta utente 2026-06, opt B) ===
                Read-only. Mostra al volo a che fase relazionale è Koda.
                Cresce di +1 ad ogni messaggio fuori dalla Stanza dello Sfogo.
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
              <Text style={[styles.settingsHint, { fontSize: 13, marginTop: 4, fontStyle: "italic" }]}>
                Cresce automaticamente man mano che parliamo. I messaggi in Lascia andare non contano.
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
              {/* === NUOVO SELETTORE VOCI (2026-06) ===
                  Niente più nomi né etichette: ogni voce È il suo colore.
                  Due cerchi colorati grandi, side-by-side. Tap = preview audio
                  + selezione automatica. Il cerchio selezionato ha un anello
                  bianco e una checkmark sottile. */}
              {/* === FIX 2026-06-30 — Lock selettore voce durante stati attivi ===
                  Se l'utente cambia voce mentre Koda sta registrando,
                  pensando o parlando, la sessione streaming si scontra con
                  la nuova voce → stato corrotto / freeze. Blocchiamo i
                  bottoni quando status !== "idle" e mostriamo un hint
                  chiaro. */}
              {(() => {
                const voiceLocked = status !== "idle";
                const lockHint = (() => {
                  switch (status) {
                    case "recording":
                      return "🎙️ Aspetta che finisca di ascoltarti per cambiare voce";
                    case "transcribing":
                      return "✍️ Sto leggendo… cambierai voce tra un attimo";
                    case "thinking":
                      return "💭 Sto pensando… cambierai voce tra un attimo";
                    case "speaking":
                      return "🔊 Aspetta che finisca di parlare per cambiare voce";
                    default:
                      return "Tocca per ascoltare";
                  }
                })();
                return (
                  <>
                    <Text style={styles.voicePickerHint}>{lockHint}</Text>
                    <View style={styles.voicePickerRow}>
                      {voices.map((v) => {
                        const selected = profile?.settings?.tts_voice_id === v.voice_id;
                        const loading = voicePreviewLoading === v.voice_id;
                        const voiceColor =
                          VOICE_SPEAKING_COLORS[v.voice_id] || theme.primary;
                        return (
                          <TouchableOpacity
                            key={v.voice_id}
                            onPress={() => selectAndPreviewVoice(v.voice_id, v.name)}
                            style={[
                              styles.voiceCircleWrap,
                              voiceLocked && { opacity: 0.45 },
                            ]}
                            testID={`voice-${v.voice_id}`}
                            activeOpacity={0.75}
                            disabled={voiceLocked}
                            accessibilityState={{ disabled: voiceLocked }}
                          >
                            {/* Glow soft attorno al cerchio (più visibile se selezionato) */}
                            <View
                              style={[
                                styles.voiceCircleGlow,
                                {
                                  backgroundColor: voiceColor,
                                  opacity: selected ? 0.45 : 0.22,
                                },
                              ]}
                            />
                            {/* Cerchio principale */}
                            <View
                              style={[
                                styles.voiceCircle,
                                {
                                  backgroundColor: voiceColor,
                                  borderColor: selected ? "#FFFFFF" : "transparent",
                                  borderWidth: selected ? 3 : 0,
                                  shadowColor: voiceColor,
                                },
                              ]}
                            >
                              {loading ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                              ) : selected ? (
                                <Ionicons name="checkmark" size={28} color="#FFFFFF" />
                              ) : null}
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                );
              })()}
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

            {/* === GEOLOCATION TOGGLE (P2 Fabio 2026-06-20) ===
                Quando attivo: al boot dell'app il client chiede il
                permesso location (UNA volta) e fa una getCurrentPosition
                + reverse-geocode → invia la città al backend come key_fact
                di categoria "luogo_geo". Permette a Koda di rispondere
                a "che ore sono qui?" o "che tempo fa?" usando la città
                giusta.
                Default OFF — l'utente abilita esplicitamente per privacy.
                Strategia ONE-SHOT: nessun watchPosition, nessun tracking
                in background. Solo 1 fix per sessione foreground. */}
            <View style={[styles.settingRow, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.settingLabel}>📍 Condividi la mia città</Text>
                <Text style={styles.settingHint}>
                  Una volta sola all'avvio. Koda saprà solo la città (es. Pavia),
                  non la posizione esatta. Serve per risposte tipo "che ore sono
                  qui?". Tutto resta locale.
                </Text>
              </View>
              <Switch
                value={(profile?.settings as any)?.geolocation_enabled === true}
                onValueChange={async (on) => {
                  if (!profile) return;
                  const nextSettings = { ...profile.settings, geolocation_enabled: on } as any;
                  setProfile({ ...profile, settings: nextSettings });
                  try {
                    await api.updateProfile({ settings: nextSettings });
                  } catch {}
                  // === Trigger immediato quando l'utente attiva il toggle ===
                  // Se attiva ORA, chiediamo subito permesso + città (non
                  // serve aspettare il prossimo cold-start). Se rifiuta,
                  // il toggle resta visivamente ON nelle impostazioni ma
                  // la chiamata fallirà gentilmente al prossimo boot.
                  if (on) {
                    try {
                      const { fetchLocationOnce } = await import("../lib/geolocation");
                      const res = await fetchLocationOnce({ forceRequest: true });
                      if (res.ok) {
                        console.log(`[KODA_GEO] location attivata: ${res.city}`);
                      } else if (res.reason === "blocked") {
                        // Mostriamo un alert con bottone "Apri Impostazioni"
                        Alert.alert(
                          "Permesso bloccato",
                          "Per condividere la città devi abilitare la posizione di Koda nelle Impostazioni del telefono.",
                          [
                            { text: "Annulla", style: "cancel" },
                            { text: "Apri Impostazioni", onPress: () => Linking.openSettings() },
                          ]
                        );
                      } else if (res.reason === "denied") {
                        console.log("[KODA_GEO] permesso negato");
                      }
                    } catch (e) {
                      console.warn("[KODA_GEO] fetchLocationOnce error:", e);
                    }
                  }
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
                  ricordi. Lascia andare non finisce mai nell'export — non
                  esiste sul server.
                </Text>
              </View>
              {exportingData ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Ionicons name="download-outline" size={18} color={theme.text + "88"} />
              )}
            </TouchableOpacity>

            <View style={styles.divider} />

            {/* === CANCELLA MEMORIA — SPOSTATO IN FONDO (richiesta utente 2026-07) ===
                Prima si trovava subito dopo "Scarica i miei dati", ma
                l'utente ha chiesto di collocarlo il più in basso possibile,
                subito sopra il footer con bundle info. In questo modo il
                gesto distruttivo non è mai immediato durante la lettura
                normale delle impostazioni. */}

            {/* === RIVEDI PRESENTAZIONE DI KODA ===========================
                Spostato qui dal bottone tre-puntini header (che ora apre
                queste impostazioni). Resta raggiungibile per chi vuole
                rifare il setup iniziale (nome, voce, palette, ecc.). */}
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

            {/* === RIVEDI IL TOUR (2026-07-24 pre-lancio, punto 1) ===
                Il tour visivo 9-step NON parte più automaticamente al primo
                avvio (era troppo pesante per un pubblico TikTok: 20 step
                totali obbligatori). Ora è opt-in da qui: l'utente lo lancia
                quando ha voglia di capire l'app, oppure lo ignora e scopre
                tutto usando. Stesso codice di build/launch del percorso
                automatico originale, solo triggerato on-demand. */}
            <TouchableOpacity
              style={[styles.settingRow, { paddingVertical: 14 }]}
              onPress={async () => {
                setShowSettings(false);
                // Piccolo delay per dare tempo al modale Impostazioni di
                // chiudersi prima di misurare la UI reale (stesso motivo
                // del delay 600ms nel percorso automatico post-onboarding).
                setTimeout(async () => {
                  try {
                    const steps = await buildTourSteps();
                    setTourSteps(steps);
                    setTourActive(true);
                  } catch (e) {
                    console.warn("[tour-replay] buildTourSteps failed:", e);
                  }
                }, 350);
              }}
              testID="replay-tour-btn"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>🧭 Rivedi il tour</Text>
                <Text style={styles.settingHint}>
                  Ti mostro con dei suggerimenti come usare l&apos;eclissi, la scrittura, il Confessionale e Lascia andare.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.text + "88"} />
            </TouchableOpacity>

            {/* === LA MIA PROMESSA (revisione 2026-07, testo utente) ===
                Versione breve, calda, one-liner. Prima c'era un box con
                descrizione tecnica dettagliata di modalità normale /
                Stanza dello Sfogo / Ghost / GDPR — spostata via su
                richiesta esplicita dell'utente ("verificare se serve,
                modificare o rimuovere"). Ora resta un solo blocco: la
                promessa nuda, senza tecnicismi. */}
            <View style={styles.divider} />
            <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>🛡️ La mia promessa</Text>
            <View style={styles.promessaBox}>
              <Text style={styles.promessaText}>
                Quello che mi dici resta tra noi. Non lo vende nessuno, non lo usa nessuno per addestrare altri modelli, non esce dal nostro spazio. In Lascia andare non esce nemmeno dal tuo telefono. È tuo. È nostro.
              </Text>
            </View>

            {/* === MINI-PANEL ADMIN WHITELIST (2026-07-24, PAYWALL_POLICY) ===
                Visibile SOLO all'owner (backend risponde is_admin=true su
                /api/admin/whoami). Permette di aggiungere/rimuovere email
                dalla whitelist "unlimited" senza toccare env var Railway.
                Le email pre-seed (Fabio, Stefania) non sono rimovibili via UI. */}
            {isAdmin ? (
              <>
                <View style={styles.divider} />
                <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>
                  🔑 Admin — Whitelist unlimited
                </Text>
                <Text style={[styles.settingHint, { marginBottom: 12, paddingHorizontal: 4 }]}>
                  Email in questa lista bypassano il paywall (usa turni illimitati).
                  Le email pre-caricate (te, Stefania) non si possono togliere da qui.
                </Text>

                {/* Lista attuale con refresh */}
                <TouchableOpacity
                  style={[styles.settingRow, { paddingVertical: 10 }]}
                  onPress={async () => {
                    setAdminBusy(true);
                    setAdminError(null);
                    try {
                      const list = await api.adminUnlimitedList();
                      setAdminUnlimitedList(list);
                    } catch (e: any) {
                      setAdminError(`Caricamento fallito: ${e?.message || e}`);
                    } finally {
                      setAdminBusy(false);
                    }
                  }}
                  testID="admin-refresh-list-btn"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingLabel}>
                      {adminBusy ? "Caricamento…" : `📋 Aggiorna lista (${adminUnlimitedList.length})`}
                    </Text>
                    <Text style={styles.settingHint}>
                      Tocca per aggiornare l&apos;elenco delle email whitelisted.
                    </Text>
                  </View>
                  <Ionicons name="refresh" size={18} color={theme.text + "88"} />
                </TouchableOpacity>

                {/* Rendering della lista */}
                {adminUnlimitedList.map((entry) => {
                  const isPreseed = [
                    "dangella.fabio@gmail.com",
                    "wqm4r4jn7f@privaterelay.appleid.com",
                    "stefania.russo82@gmail.com",
                  ].includes(entry.email);
                  return (
                    <View
                      key={entry.email}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingVertical: 8,
                        paddingHorizontal: 4,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: theme.text + "18",
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: theme.text, fontSize: 13 }}>
                          {entry.email}
                        </Text>
                        {entry.note ? (
                          <Text style={{ color: theme.text + "77", fontSize: 11, marginTop: 2 }}>
                            {entry.note}
                          </Text>
                        ) : null}
                      </View>
                      {isPreseed ? (
                        <Text style={{ color: theme.text + "55", fontSize: 10, fontStyle: "italic" }}>
                          bloccata
                        </Text>
                      ) : (
                        <TouchableOpacity
                          onPress={async () => {
                            setAdminBusy(true);
                            setAdminError(null);
                            try {
                              await api.adminUnlimitedRemove(entry.email);
                              const list = await api.adminUnlimitedList();
                              setAdminUnlimitedList(list);
                            } catch (e: any) {
                              setAdminError(`Rimozione fallita: ${e?.message || e}`);
                            } finally {
                              setAdminBusy(false);
                            }
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Ionicons name="trash-outline" size={18} color={theme.danger} />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}

                {/* Form aggiungi */}
                <View style={{ marginTop: 14, gap: 8 }}>
                  <TextInput
                    value={adminAddEmail}
                    onChangeText={setAdminAddEmail}
                    placeholder="Nuova email (es. sorella@example.com)"
                    placeholderTextColor={theme.muted}
                    style={[styles.input, { paddingVertical: 10, fontSize: 14 }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                  />
                  <TextInput
                    value={adminAddNote}
                    onChangeText={setAdminAddNote}
                    placeholder="Nota (opzionale, es. Sorella / Tester alfa)"
                    placeholderTextColor={theme.muted}
                    style={[styles.input, { paddingVertical: 10, fontSize: 14 }]}
                    autoCapitalize="sentences"
                  />
                  <TouchableOpacity
                    style={{
                      backgroundColor: theme.primary,
                      paddingVertical: 12,
                      borderRadius: 10,
                      alignItems: "center",
                      opacity: adminBusy || !adminAddEmail.trim() ? 0.5 : 1,
                    }}
                    disabled={adminBusy || !adminAddEmail.trim()}
                    onPress={async () => {
                      const email = adminAddEmail.trim().toLowerCase();
                      if (!email || !email.includes("@")) return;
                      setAdminBusy(true);
                      setAdminError(null);
                      try {
                        await api.adminUnlimitedAdd(email, adminAddNote.trim() || undefined);
                        const list = await api.adminUnlimitedList();
                        setAdminUnlimitedList(list);
                        setAdminAddEmail("");
                        setAdminAddNote("");
                      } catch (e: any) {
                        setAdminError(`Aggiunta fallita: ${e?.message || e}`);
                      } finally {
                        setAdminBusy(false);
                      }
                    }}
                    testID="admin-add-email-btn"
                  >
                    <Text style={{ color: theme.primaryText, fontSize: 14, fontWeight: "600" }}>
                      {adminBusy ? "Un attimo…" : "➕ Aggiungi alla whitelist"}
                    </Text>
                  </TouchableOpacity>
                </View>

                {adminError ? (
                  <Text style={{ color: theme.danger, fontSize: 12, marginTop: 8, textAlign: "center" }}>
                    {adminError}
                  </Text>
                ) : null}

                {/* === INTRO-V2 BETA (2026-08-06, admin only) ===
                    Nuovo onboarding conversazionale in fase di validazione
                    su TestFlight. Non ancora attivo per gli utenti finali:
                    l'accesso è riservato all'owner per QA end-to-end.
                    Rimuovere dopo GA. */}
                <View style={styles.divider} />
                <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>
                  🧪 Test — Setup + Intro conversazionale
                </Text>
                <Text style={[styles.settingHint, { marginBottom: 10, paddingHorizontal: 4 }]}>
                  Prima di iniziare → Email → Microfono → dissolvenza → Intro V2.
                  Ripetibile (non scrive stato persistente durante il setup);
                  al termine dell'Intro sovrascrive nome/voce/genere come prima.
                </Text>
                <TouchableOpacity
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    backgroundColor: theme.text + "0c",
                    borderRadius: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                  onPress={() => {
                    closeSettings();
                    setTimeout(() => router.push("/setup-v2"), 200);
                  }}
                  testID="admin-open-intro-v2-btn"
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                    <Ionicons name="sparkles-outline" size={18} color={theme.text + "99"} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.text + "cc", fontSize: 14, fontWeight: "500" }}>
                        Prova nuovo Setup + Intro (beta)
                      </Text>
                      <Text style={{ color: theme.text + "66", fontSize: 11, marginTop: 2 }}>
                        Disclaimer + email + mic, poi dissolvenza in /intro-v2. Non tocca la produzione.
                      </Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.text + "66"} />
                </TouchableOpacity>

                {/* === TRIAL TEST PANEL (2026-08-11, Fabio) ===
                    5 pulsanti per simulare stati del trial senza consumare
                    7 minuti veri di TTS. Solo admin, gated dallo stesso
                    isAdmin qui sopra. Componente separato in ../components/. */}
                <TrialTestPanel visible={true} />
              </>
            ) : null}

            {/* === AIUTO / SEGNALA UN PROBLEMA (2026-07-24 pre-lancio) ===
                Reframing del vecchio bottone "Diagnostica" — stessa funzione
                tecnica sotto (raccolta log [KODA_VAD] [KODA_TIMING]
                [KODA_SUMMARY] + copia/condividi) ma presentata in modo
                comprensibile per l'utente finale. Così anche dopo il lancio
                continuiamo a ricevere diagnosi utili dagli utenti reali
                che incontrano un problema. */}
            <TouchableOpacity
              style={{
                marginTop: 16,
                paddingVertical: 12,
                paddingHorizontal: 14,
                backgroundColor: theme.text + "0c",
                borderRadius: 10,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
              onPress={() => {
                closeSettings();
                setTimeout(() => router.push("/diagnostics"), 200);
              }}
              testID="report-problem-btn"
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                <Ionicons name="help-buoy-outline" size={18} color={theme.text + "99"} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text + "cc", fontSize: 14, fontWeight: "500" }}>
                    Hai un problema? Segnala
                  </Text>
                  <Text style={{ color: theme.text + "66", fontSize: 11, marginTop: 2 }}>
                    Raccoglie un piccolo diario tecnico da inviarci per capire cos&apos;è successo.
                  </Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.text + "66"} />
            </TouchableOpacity>

            {/* === RIMOSSO 2026-07-09 su richiesta utente ===
                Il pulsante "Controlla aggiornamenti" non funzionava
                (Updates.checkForUpdateAsync non rispondeva mai su questa
                pipeline OTA). Rimosso completamente. Se serve ricontrollare
                la versione bundle, il footer sotto mostra già il numero. */}

            {/* === CANCELLA MEMORIA — POSIZIONE FINALE (2026-07, utente) ===
                Posizionato subito sopra il footer bundle info per rendere
                il gesto distruttivo l'ultimo elemento della lista. */}
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

            {/* === VERSIONE APP (pre-lancio 2026-07-24) ===
                Footer minimale user-facing. NB: il triple-tap Easter egg
                che puntava a /mockup-light è stato rimosso 2026-08-04
                insieme al mockup light-mode (tema light rimosso). */}
            <View style={{ alignItems: "center", marginTop: 24, marginBottom: 8 }}>
              <Text style={{ color: theme.text + "55", fontSize: 11, fontStyle: "italic" }}>
                Koda v{Constants.expoConfig?.version || "1.0.1"}
              </Text>
              <Text style={{ color: theme.text + "33", fontSize: 9, marginTop: 3, letterSpacing: 0.5 }}>
                {KODA_BUILD_SHORT_TAG}
              </Text>
            </View>
</>)}
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
            <Text style={{ fontSize: 22, fontWeight: "700", color: "#FFE8E8", marginBottom: 16, letterSpacing: 0.3 }}>La Stanza dello Sfogo</Text>
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
            💜 Magenta    = speaking        (sto parlando io)

          === TEST DIAGNOSTICO 2026-07-30 v64.8 — ESITO NEGATIVO ================
          Ipotesi: RadialGlow causava il flash + lentezza su Android.
          Test: disattivato RadialGlow su Android. Verdetto utente: flash
          ancora presente → RADIALGLOW ESCLUSO come causa. Ripristinato
          rendering normale su tutte le piattaforme (nessun senso lasciarlo
          disattivato se non è la causa).
          ==================================================================== */}
      {/* v64.17 (2026-08-01) — RadialGlow riscritto senza pulsazione continua.
          Il vecchio componente aveva Animated.loop useNativeDriver:false che
          crollava FPS su Android (13 fps). Test v64.16 confermò diagnosi
          (FPS 13→120 rimuovendo il componente). v64.17 rimuove SOLO la
          pulsazione (impatto visivo trascurabile su un'aura tenue), mantiene
          fade colore/opacity su cambio stato. Riabilitato su ENTRAMBE le
          piattaforme → parità visiva iOS = Android. */}
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
        // === FIX 2026-06-30 — Lock "Avanti" alla prima esecuzione (Fabio) ===
        // Se l'utente NON è ancora onboarded, è la PRIMA volta che vede
        // la presentazione → blocchiamo i tap "Avanti" mentre Koda parla
        // (deve guardarla dall'inizio alla fine). Se invece è entrato da
        // "Rivedi la Intro" nelle impostazioni (onboarded=true), libertà
        // totale di scorrimento — l'ha già vista, sa di cosa parla.
        isFirstRun={!profile?.onboarded}
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
  // Se l'utente ha calibrato un thickness custom (Impostazioni → Bordo),
  // quello ha priorità assoluta sui default per-stato.
  const neonThickness = borderCal.thickness ?? (
    neonStatus === "confessional" ? 4 :
    neonStatus === "idle" ? 2 :
    3
  );
  const neonBorderEl = (
    <NeonBorder
      status={neonStatus}
      thickness={neonThickness}
      speakingColorOverride={getVoiceSpeakingColor(
        (profile?.settings as any)?.tts_voice_id
      )}
      radiusOverride={borderCal.radius ?? undefined}
      idleColorOverride={borderCal.useAltIdleColor ? ALT_IDLE_COLOR : undefined}
    />
  );

  // === ACTIVATION PULSE — DISABILITATO (2026-06-27 v21) ===
  // L'utente ha segnalato che su Android il flash viola al boot
  // (#8B5CF6) appare ripetutamente "senza far niente" — probabilmente
  // perché Android killa l'app in background più aggressivamente
  // di iOS e ad ogni "cold start" il pulse parte di nuovo.
  // Disabilitato per stabilità visiva. La marca dell'identità Koda
  // viene già comunicata dal NeonBorder champagne perenne in idle.
  // Se si vuole riabilitare: rimettere il blocco originale qui sotto.
  const activationPulseEl: React.ReactNode = null;
  // OLD CODE (mantenuto come commento per ripristino veloce):
  // const activationPulseEl = (!activationPulseDone && profile && showColorIntro === false && !showOnboarding) ? (
  //   <ActivationPulse color="#8B5CF6" duration={1500} thickness={3} onComplete={() => setActivationPulseDone(true)} />
  // ) : null;

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
        if (k === "aria" || k === "eco") return "6TngzmzM89jJ3Y2Yiywr"; // Koda Acqua (femminile, giugno 2026 v4)
        if (k === "echo" || k === "theo") return "ll9WG7PDTuyHwgC5MD6g"; // Koda Vento (maschile, giugno 2026 v4)
        return (profile?.settings as any)?.tts_voice_id || "6TngzmzM89jJ3Y2Yiywr";
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

  return (
    <View
      style={{ flex: 1 }}
      // === AUTO-DIM SCHERMO — hook touch a livello root (2026-07-28) ===
      // onStartShouldSetResponder è un handler passivo: fired al primo
      // tocco senza consumare l'evento (ritorna false → l'evento continua
      // a propagare ai figli). Ogni volta che l'utente tocca lo schermo:
      //   - Se siamo dimmerati → ScreenDimmer.noteInteraction() fa fade UP
      //   - Reset del timer di 35s per il prossimo dim
      // No-op se ScreenDimmer non è in watching (fuori da hands-free).
      onStartShouldSetResponder={() => {
        try {
          ScreenDimmer.noteInteraction();
        } catch {}
        return false; // Non consumiamo l'evento
      }}
    >
      {screenInner}
      {confessionalTint}
      {neonBorderEl}
      {activationPulseEl}
      {tourOverlay}
      {!tourActive && !confessionalMode ? <ProactiveOffer theme={theme} /> : null}
      {/* === DISCLAIMER blocking overlay (Fabio 2026-07-28) ==================
          Uso il componente Modal nativo di React Native (non un semplice
          View absoluteFill) per garantire:
            - Copertura totale dello schermo (viene reso in una layer
              nativa separata, sopra QUALSIASI cosa nell'app inclusi
              elementi con position:absolute e z-index alti)
            - Blocco degli input sottostanti (touch pass-through impossibile)
            - Blocco del tasto Back Android (non richiediamo onRequestClose,
              così è impossibile chiudere senza tap esplicito)
          statusBarTranslucent=true su Android per estendersi sotto la barra.
          animationType="fade" per apparizione morbida.

          Bug fix precedente (Fabio 2026-07-28): l'implementazione a View
          absoluteFill lasciava trapassare pill "Lascia andare", ellipsis
          impostazioni e bottone hands-free per via del loro zIndex alto.
          Il Modal risolve alla radice perché è renderizzato in una window
          nativa separata. */}
      <Modal
        visible={disclaimerState === "blocking"}
        transparent={false}
        animationType="fade"
        statusBarTranslucent
        presentationStyle="fullScreen"
        hardwareAccelerated
        // Volutamente niente onRequestClose: l'unica via d'uscita è il
        // bottone "Ho capito", non il tasto Back Android.
      >
        <DisclaimerScreen onAccepted={() => setDisclaimerState("accepted")} />
      </Modal>
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

function BubbleImpl({
  entry,
  onReplay,
  onGhost,
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
  // === v64.14 PROFILING — conta render della Bubble (attivo solo con
  // EXPO_PUBLIC_KODA_PERF_DIAG=1). Zero overhead se disattivato.
  useRenderCounter("KODA_PERF_TIMELINE_BUBBLE");
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

// === v64.14 — React.memo wrapper con equality check custom ==================
// Bubble era ridipinta ad ogni render di MainRoot (index.tsx, 8300 righe)
// perché la sua definizione era `function Bubble(...)` senza memo. Su Android
// con thread JS più lento questo diventava un collo di bottiglia visibile
// nello scroll della timeline chat.
//
// L'equality check confronta i prop shallow — tutti primitive tranne
// `entry`, `bubbleAccent` e i callback. Per `entry` confrontiamo per
// identità di riferimento (accettabile — la timeline non muta gli entry
// esistenti, ne aggiunge di nuovi). Per `bubbleAccent` confrontiamo il
// campo `color` che è quello che cambia realmente. I callback devono
// essere stabili (useCallback lato chiamante) per beneficiare della memo.
function arePropsEqualBubble(
  prev: React.ComponentProps<typeof BubbleImpl>,
  next: React.ComponentProps<typeof BubbleImpl>,
): boolean {
  return (
    prev.entry === next.entry &&
    prev.bubbleStyle === next.bubbleStyle &&
    prev.textOnBubble === next.textOnBubble &&
    prev.textSize === next.textSize &&
    prev.aiFontFamily === next.aiFontFamily &&
    prev.bubbleAccent.color === next.bubbleAccent.color &&
    prev.bubbleAccent.soft === next.bubbleAccent.soft &&
    prev.onReplay === next.onReplay &&
    prev.onGhost === next.onGhost
  );
}

const Bubble = React.memo(BubbleImpl, arePropsEqualBubble);

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
  // === FIX 2026-06-27 v20 (richiesta utente: "rosso scarlatto") ===
  // Allineato al colore del NeonBorder "confessional" (#FF1744), per
  // coerenza visiva totale: quando l'utente attiva la Stanza, il bordo,
  // l'orb, il glow e il bottone sono tutti dello stesso identico scarlatto.
  // È il "Material Red A400" — uno scarlatto vivido, alto contrasto sia
  // sul grigio sasso del giorno sia sull'indaco notturno. Caldo, intimo,
  // immediatamente riconoscibile.
  confessionalToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    // === FIX 2026-06-28 v27 — pill SEMPRE opaca ===
    // Prima: rgba(255,23,68,0.20) → solo 20% opacità → le bolle della
    // timeline trasparivano attraverso la pill, parole sovrapposte =
    // effetto ottico pessimo (segnalato da utente). Ora maroon scuro
    // opaco al 100%: si stacca sempre dallo sfondo, indipendente dal
    // tema o dai messaggi dietro.
    backgroundColor: "#7A1F2E",
    borderWidth: 1,
    borderColor: "#FF6B7E",
  },
  confessionalToggleOn: {
    backgroundColor: "#FF1744",
    borderColor: "#FF8FA3",
  },
  confessionalToggleText: {
    // === FIX 2026-06-28 v27 — testo SEMPRE bianco ===
    // Prima: condizionale che metteva rgba(0,0,0,0.85) su tema chiaro →
    // testo quasi nero su sfondo trasparente rosso = illeggibile.
    // Ora il bg è sempre opaco (maroon o rosso brillante), il bianco
    // si legge bene in entrambi i casi.
    color: "#FFFFFF",
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
  // === SCROLL-TO-BOTTOM FAB (2026-06-22) ===
  scrollFabContainer: {
    position: "absolute",
    right: 18,
    alignItems: "flex-end",
  },
  scrollFab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
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
    // === FIX OVERLAP MESSAGGIO/INPUT (2026-07-24 pre-lancio) ===
    // Prima: rgba(15,23,42,0.92) — 92% opaco → l'ultima bolla utente
    // scorrendo dietro il campo restava leggermente visibile e "toccava"
    // il placeholder "Scrivi qui..." creando un fastidioso overlap.
    // Ora: bg TOTALMENTE OPACO → nessuna trasparenza residua, il testo
    // dell'ultima bolla non traspare più mai dietro l'input bar.
    backgroundColor: "rgb(15, 23, 42)",
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
    paddingVertical: 18,
    gap: 16,
  },
  // v57 UI polish (Fabio 2026-07-13): +size, +weight, lineHeight esplicito
  // per allineamento verticale ottimale con emoji (altrimenti su Android
  // "🌐" e "🎙️" appaiono spostate in verticale rispetto al testo latino).
  settingLabel: {
    color: t.text,
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
    includeFontPadding: false,
  },
  // Hint sotto ogni opzione: +size, +lineHeight, colore più contrastato
  // (t.text con alpha invece di textDim opaco).
  settingHint: {
    color: t.textDim,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
    opacity: 0.9,
  },
  // Separatore più marcato tra sezioni: raddoppiato margin verticale e
  // altezza per creare respiro tra IDENTITÀ / COMPORTAMENTO / TEMA.
  divider: {
    height: 1,
    backgroundColor: t.divider,
    marginVertical: 24,
    opacity: 0.7,
  },

  // Header sezione: chip con bordo accent sinistro + padding, più visibile
  // e distinto ("badge" style). Usa colore text pieno invece di textMuted.
  settingsSubtitle: {
    color: t.text,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 28,
    marginBottom: 14,
    paddingLeft: 12,
    paddingVertical: 4,
    borderLeftWidth: 3,
    borderLeftColor: t.primary,
    alignSelf: "flex-start",
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
  confidenceLabel: { color: t.textMuted, fontSize: 13, marginBottom: 6, fontWeight: "600" },
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
  dangerBtnText: { color: t.danger, fontWeight: "700", fontSize: 14 },
  dangerHint: {
    color: t.textDim,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 6,
  },
  // === Promessa di Ferro: clausola di privacy in app ===
  promessaBox: {
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    borderRadius: 14,
    padding: 16,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "rgba(252,165,165,0.25)",
  },
  promessaText: {
    color: t.primaryText,
    fontSize: 14,
    lineHeight: 22,
    opacity: 0.95,
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

  // === Background picker RIMOSSO (2026-08-04) — vedi cleanup dead code.
  //     Il tema ora determina tutto lo sfondo; niente più chip/preset/dim.

  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1.5,
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderRadius: 18,
  },
  modeBtnActive: {
    backgroundColor: t.primary,
    borderColor: t.primary,
  },
  modeBtnText: {
    color: t.text,
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 1,
  },
  modeBtnTextActive: {
    color: t.primaryText,
  },

  // Voice selector — hint sotto un header sezione (es. "Scegli la voce")
  // v57 UI polish: +fontSize, +lineHeight per leggibilità.
  settingsHint: {
    color: t.textDim,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
    marginTop: 4,
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
  // === NUOVO SELETTORE VOCI (2026-06) ===
  // Solo cerchi colorati: ogni voce È il suo colore.
  voicePickerHint: {
    color: t.textMuted,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    textAlign: "center",
    marginTop: 4,
    marginBottom: 4,
  },
  // === OTA UPDATE BUTTON (2026-06-27 v23) ===
  // Pulsante "Controlla aggiornamenti" in fondo alle Impostazioni.
  // Stile minimale, leggermente più evidente del footer versione perché
  // è un'azione, non solo testo. Bordo soft + icona + label.
  otaCheckButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surfaceAlt,
    marginTop: 18,
    marginHorizontal: 8,
    minHeight: 44,
  },
  otaCheckButtonText: {
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  voicePickerRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 48,
    paddingVertical: 20,
    paddingHorizontal: 8,
  },
  voiceCircleWrap: {
    width: 90,
    height: 90,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  voiceCircleGlow: {
    position: "absolute",
    width: 110,
    height: 110,
    borderRadius: 999,
    // boxShadow non gestito uniformemente → ci affidiamo al fill +
    // opacity. Su iOS e web il risultato è uno halo soft visibile.
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0, shadowRadius: 0 },
      android: {},
      default: {},
    }),
  },
  voiceCircle: {
    width: 78,
    height: 78,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.55,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
      default: {},
    }),
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

  // Theme picker — 3 chips (Giorno / Notte / Auto) allineati orizzontalmente
  // con spazio equo. flex:1 per riempire tutta la larghezza; testo più
  // grande (14/700) per coerenza col resto della pagina impostazioni.
  themeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  themeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    minHeight: 44,
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
    fontSize: 14,
    fontWeight: "700",
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
    fontSize: 13,
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

