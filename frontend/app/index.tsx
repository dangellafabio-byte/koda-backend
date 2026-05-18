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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import {
  api,
  API_BASE,
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
import { SpeechMod, unlockSpeech, setDefaultVoiceId } from "../lib/speech";
import { scheduleAt, scheduleCheckin, cancelAllCheckins, cancelCheckin } from "../lib/notifications";
import { useTheme, THEME_LIST, ThemeName, Palette } from "../lib/theme";
import AppIcon from "../lib/AppIcon";
import Orb, { OrbTone } from "../components/Orb";
import EclipseOrb from "../components/EclipseOrb";
import KodaIntro from "../components/KodaIntro";
import * as SecureStore from "expo-secure-store";
import NeonBorder from "../components/NeonBorder";
import RadialGlow from "../components/RadialGlow";
import SealSetupModal from "../components/SealSetupModal";
import InfoModal from "../components/InfoModal";
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
  const dismissColorIntro = useCallback(async () => {
    setShowColorIntro(false);
    try {
      await SecureStore.setItemAsync("koda_intro_seen", "1");
    } catch {}
    // Refresh profile dopo che Koda ha salvato i dati
    try {
      const p = await api.getProfile();
      setProfile(p);
    } catch {}
  }, []);
  /** Riapri la presentazione di Koda (back-door: long-press eclissi 3s). */
  const reopenKodaIntro = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync("koda_intro_seen");
    } catch {}
    setShowColorIntro(true);
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
  // === Zero-Knowledge: Parola Segreta (Sigillo) ===
  // Se l'utente ha impostato una Parola Segreta, in modalità Confessionale
  // il messaggio viene cifrato sul dispositivo e inviato a /converse/sealed.
  // Senza Parola Segreta, fallback a ephemeral (no DB ma backend vede testo).
  const [hasSeal, setHasSeal] = useState<boolean>(false);
  const [showSealSetup, setShowSealSetup] = useState(false);
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
  useEffect(() => {
    convActiveRef.current = convActive;
  }, [convActive]);

  const recRef = useRef<Recorder | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Pager horizontale: pagina 0 = voce zen, pagina 1 = lettura.
  const pagerRef = useRef<ScrollView>(null);
  const [viewMode, setViewMode] = useState<"voice" | "reading">("voice");
  const dimensions = useWindowDimensions();
  // Use window width with sensible fallback (Dimensions.get) for first render
  const windowWidth = dimensions.width || Dimensions.get("window").width || 390;
  const pulse = useRef(new Animated.Value(1)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  // Live meter value (dB) shown as debug visualization during recording
  const [meterDb, setMeterDb] = useState<number | null>(null);
  const [meterThreshold, setMeterThreshold] = useState<number | null>(null);

  // Initial load
  useEffect(() => {
    (async () => {
      try {
        const p = await api.getProfile();
        setProfile(p);
        // Sync theme from profile if different
        const tName = (p.settings?.theme as ThemeName) || "sistema";
        if (tName !== themeName) setThemeName(tName);
        if (
          typeof p.settings?.day_start_hour === "number" ||
          typeof p.settings?.night_start_hour === "number"
        ) {
          setHours(p.settings?.day_start_hour ?? 7, p.settings?.night_start_hour ?? 20);
        }
        // Sync ElevenLabs voice id into speech module
        if (p.settings?.tts_voice_id) {
          setDefaultVoiceId(p.settings.tts_voice_id);
        }
        if (!p.onboarded) setShowOnboarding(true);
        else if (p.settings?.input_mode !== "text") {
          // Pre-warm mic permission so first tap goes straight to recording
          prewarmMic().catch(() => {});
        }
        const t = await api.getTimeline(200);
        setTimeline(t);
      } catch (e) {
        console.warn("init error", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setStatus("idle");
      setError("Si è bloccato un attimo, riprova pure.");
    }, ms);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const speakIfEnabled = useCallback(
    async (text: string, tone: TimelineEntry["tone"]) => {
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
            // Toggle confessional ON/OFF immediately (no setup if no seal needed for off)
            if (value && !hasSeal) {
              setShowSealSetup(true);
            } else {
              if (!value) forgetSessionKey();
              setConfessionalMode(value);
            }
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
              "auto-orario": "auto-orario",
              auto: "auto-orario",
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

  const sendText = useCallback(
    async (text: string) => {
      const txt = text.trim();
      if (!txt) return;
      setError(null);
      // Optimistic: append a local pending entry
      const optimistic: TimelineEntry = {
        id: `local-${Date.now()}`,
        role: "user",
        text: txt,
        timestamp: new Date().toISOString(),
      };
      setTimeline((prev) => [...prev, optimistic]);
      setStatus("thinking");
      try {
        // === SEALED FLOW (Zero-Knowledge Confessionale) ===
        // Se siamo in confessionale e l'utente ha impostato la Parola Segreta,
        // cifriamo il messaggio CLIENT-SIDE e chiamiamo /converse/sealed.
        if (confessionalMode && hasSeal) {
          const key = await getSessionKey({ biometric: true });
          if (!key) {
            throw new Error("Parola Segreta non sbloccata");
          }
          const sealed = await sealText(txt, key);
          const resp = await api.converseSealed(
            {
              nonce: sealed.nonce,
              ciphertext: sealed.ciphertext,
              language: profile?.language || "it",
              ai_name: profile?.ai_name || "Coda",
              ai_gender: profile?.ai_gender || "f",
              user_gender: profile?.user_gender || "n",
            },
            keyToBase64(key)
          );
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
          };
          const userEntry: TimelineEntry = {
            ...optimistic,
            id: `sealed-u-${Date.now()}`,
          };
          setTimeline((prev) => {
            const filtered = prev.filter((e) => e.id !== optimistic.id);
            return [...filtered, userEntry, aiEntry];
          });
          await speakIfEnabled(reply, aiEntry.tone || "warm");
          return;
        }
        // === FAST STREAMING FLOW ===
        // Quando NON siamo in confessionale e la voce è abilitata, usiamo
        // l'endpoint /api/converse-stream-audio che fa tutto in un colpo:
        //   STT-result → Claude(streaming) → ElevenLabs(streaming per frase)
        //                                  → MP3 chunks → AVPlayer
        // TTFB tipico ~100-300ms. Il testo della risposta viene salvato
        // server-side; dopo la fine del playback rifresciamo la timeline.
        //
        // Il visual è ora `EclipseOrb`: aurora procedurale guidata dal
        // `tone` semantico della risposta, NON dall'ampiezza audio
        // (approccio precedente con waveform server-side abbandonato:
        // troppi anelli di sync, effetto "macchinoso").
        const useFastPath = !confessionalMode && (profile?.settings.voice_response !== false);
        if (useFastPath) {
          try {
            const reqId = Math.random().toString(36).slice(2, 18);
            const streamUrl =
              `${API_BASE}/converse-stream-audio?text=${encodeURIComponent(txt)}&id=${reqId}` +
              (confessionalMode ? `&ephemeral=true` : "");
            // Durante TTFB (300-800ms) mostriamo "thinking" (eclissi ciclamino,
            // flicker). Lo switch a "speaking" (vibrazione organica) avviene
            // SOLO quando l'audio comincia davvero a suonare — così l'eclissi
            // non vibra mentre è ancora silenziosa (era confusing).
            setStatus("thinking");
            const ok = await SpeechMod.playFromUrl(streamUrl, () => {
              // L'audio è iniziato → ora ha senso vibrare.
              setStatus("speaking");
            });
            // Refresh della timeline (il backend ha salvato user+ai entries).
            try {
              const tl = await api.getTimeline(200);
              setTimeline(tl);
              // Esegui le azioni dell'ultima ai_entry (theme, ecc.).
              const lastAi = [...tl].reverse().find((e) => e.role === "ai");
              if (lastAi?.actions?.length) {
                runActions(lastAi.actions);
              }
            } catch (e) {
              console.warn("[sendText] timeline refresh after stream failed:", e);
            }
            // Refresh profile (counters + memory_summary)
            try {
              const p = await api.getProfile();
              setProfile(p);
            } catch {}
            setStatus("idle");
            // Se il playback è fallito, mostriamo errore (l'audio NON c'è stato).
            if (!ok) {
              setError("La voce non è partita — l'audio non è arrivato.");
              setTimeout(() => setError(null), 3000);
            }
            return;
          } catch (e: any) {
            // Fallback al flusso classico — non perdiamo il messaggio dell'utente.
            console.warn("[sendText] fast streaming path failed, falling back to /converse:", e);
            setStatus("thinking");
            // ↓ continua con il blocco `api.converse` standard sotto
          }
        }
        // === STANDARD FLOW (con o senza ephemeral) ===
        const res = await api.converse(txt, undefined, { ephemeral: confessionalMode });
        // Replace optimistic with real, then add AI entry
        setTimeline((prev) => {
          const filtered = prev.filter((e) => e.id !== optimistic.id);
          return [...filtered, res.user_entry, res.ai_entry];
        });
        setProfile(res.profile);
        // Execute any actions (notifications, etc.) requested by the AI
        runActions(res.ai_entry.actions || []);
        await speakIfEnabled(res.ai_entry.voice_text || res.ai_entry.text, res.ai_entry.tone || "neutral");
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
      // Only mark "recording" if we're not currently in "speaking" (otherwise
      // the speaking status is correct — barge-in detector will swap it).
      if (status !== "speaking") setStatus("recording");
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
        });
      }
    } catch (e) {
      setError("Microfono non disponibile. Controlla i permessi.");
    }
  };

  const startTalk = async () => {
    // PIANO A (semplificazione): conversation_mode auto-loop DISABILITATO.
    // Causa principale dei freeze/crash su iOS. Modello tap-to-talk puro.
    // L'utente preme per iniziare, ripreme per inviare. Modello WhatsApp.
    // Il conversation hands-free REALE arriverà nella Fase 4 con Deepgram.
    return startTalkInternal(false);
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
      // Send to converse
      await sendText(txt);
    } catch (e) {
      // FIX 2 (RCA): assicuriamoci che recRef sia nullato anche in caso
      // d'errore, altrimenti lo stato resta "stuck" sul prossimo tap.
      if (recRef.current === current) recRef.current = null;
      setError("Errore nella trascrizione.");
      setStatus("idle");
    }
  };

  const onBigButton = () => {
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

  const sendTextFromBox = () => {
    if (!textInput.trim()) return;
    const txt = textInput;
    setTextInput("");
    Keyboard.dismiss();
    sendText(txt);
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
  //   - "morning" → ensure morning slot is scheduled with fresh AI text
  //   - "evening" → ensure evening slot is scheduled
  //   - "both"    → both
  // The actual content is generated server-side via /checkin/generate so
  // each notification feels personal (uses memory + last messages).
  const lastCheckinSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!profile) return;
    const mode = (profile.settings as any)?.checkin_mode || "off";
    const morningTime = (profile.settings as any)?.checkin_morning_time || "08:30";
    const eveningTime = (profile.settings as any)?.checkin_evening_time || "21:30";
    // Skip resync if nothing relevant changed (avoids hitting the LLM on
    // every render when other settings are tweaked).
    const sig = `${mode}|${morningTime}|${eveningTime}`;
    if (lastCheckinSyncRef.current === sig) return;
    lastCheckinSyncRef.current = sig;

    (async () => {
      if (mode === "off") {
        await cancelAllCheckins();
        return;
      }
      const localHour = new Date().getHours();
      const wantMorning = mode === "morning" || mode === "both";
      const wantEvening = mode === "evening" || mode === "both";

      // Cancel slots that aren't wanted anymore
      if (!wantMorning) await cancelCheckin("morning");
      if (!wantEvening) await cancelCheckin("evening");

      // Schedule the wanted slots — generate fresh content for each
      const slots: Array<["morning" | "evening", string]> = [];
      if (wantMorning) slots.push(["morning", morningTime]);
      if (wantEvening) slots.push(["evening", eveningTime]);
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
  }, [profile?.settings?.checkin_mode, profile?.settings?.checkin_morning_time, profile?.settings?.checkin_evening_time, profile?.id]);

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
  const isCustomImage = !!bgValue && (bgValue.startsWith("data:") || bgValue.startsWith("file:") || bgValue.startsWith("http"));
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

  // === Build timeline w/ day separators
  const timelineWithSeparators = useMemo(() => {
    const out: Array<{ kind: "sep"; key: string; label: string } | { kind: "msg"; entry: TimelineEntry }> = [];
    let lastDay = "";
    for (const e of timeline) {
      const d = new Date(e.timestamp);
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dayKey !== lastDay) {
        out.push({ kind: "sep", key: `sep-${dayKey}`, label: dayLabelFor(d) });
        lastDay = dayKey;
      }
      out.push({ kind: "msg", entry: e });
    }
    return out;
  }, [timeline]);

  // Build the screen wrapper with optional background image / gradient
  const screenInner = (
    <View style={[styles.screen, { backgroundColor: bgValue ? "transparent" : theme.bg }]}>
      {/* Header — totalmente zen. Solo il lucchetto confessionale al centro.
          Niente info, niente sunto, niente impostazioni: tutto si chiede
          direttamente a Koda con la voce. L'eclissi È l'interfaccia. */}
      <View
        style={[styles.header, { top: Math.max(insets.top + 16, 70) }]}
        pointerEvents="box-none"
      >
        {/* Slot sinistro vuoto — spazio per centrare il lucchetto */}
        <View style={styles.headerBtn} pointerEvents="none" />
        <View style={styles.headerCenter} pointerEvents="box-none">
          {/* === Lucchetto Confessionale ===
              Toggle one-tap nel cuore dell'header. Quando attivo:
                - blob si scurisce (forma nucleica dark)
                - i messaggi NON vengono salvati su DB
                - la memoria di lungo periodo NON viene aggiornata
                - a sessione chiusa tutto svanisce dalla RAM */}
          <TouchableOpacity
            style={[
              styles.confessionalToggle,
              confessionalMode && styles.confessionalToggleOn,
            ]}
            onPress={async () => {
              if (!confessionalMode) {
                // Stiamo per ATTIVARE il confessionale.
                // Se l'utente non ha ancora una Parola Segreta, mostra il setup.
                const has = await hasSecretWord();
                setHasSeal(has);
                if (!has) {
                  setShowSealSetup(true);
                  return;
                }
              } else {
                // Disattivando il confessionale, dimentica la chiave volatile.
                forgetSessionKey();
              }
              setConfessionalMode((m) => !m);
            }}
            onLongPress={() => {
              // Long-press: gestione Parola Segreta (cambio/cancellazione)
              setShowSealSetup(true);
            }}
            hitSlop={10}
            testID="confessional-toggle"
          >
            <Ionicons
              name={confessionalMode ? "lock-closed" : "lock-open-outline"}
              size={16}
              color={
                confessionalMode
                  ? hasSeal
                    ? "#34D399"
                    : "#FCA5A5"
                  : "#FFFFFFCC"
              }
            />
            <Text
              style={[
                styles.confessionalToggleText,
                confessionalMode && {
                  color: hasSeal ? "#34D399" : "#FCA5A5",
                },
              ]}
            >
              {confessionalMode
                ? hasSeal
                  ? "Sigillato"
                  : "Confessionale"
                : "Confessionale"}
            </Text>
          </TouchableOpacity>
        </View>
        {/* Slot destro vuoto — il sunto si chiede a Koda direttamente ("Fammi un sunto") */}
        <View style={styles.headerBtn} pointerEvents="none" />
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
        onMomentumScrollEnd={(e) => {
          const x = e.nativeEvent.contentOffset.x;
          const w = e.nativeEvent.layoutMeasurement.width || windowWidth;
          setViewMode(Math.round(x / w) === 0 ? "voice" : "reading");
        }}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        decelerationRate="fast"
      >
        {/* === PAGE 0: VOICE ZEN MODE ============================ */}
        <View style={{ width: windowWidth, flex: 1, alignItems: "center", justifyContent: "center" }}>
          <View style={{ alignItems: "center", justifyContent: "center", flex: 1, gap: 18, paddingHorizontal: 24 }}>
            <Pressable
              onPress={onBigButton}
              onLongPress={reopenKodaIntro}
              delayLongPress={3000}
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
                  tone={lastAiTone}
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
            {/* Hint swipe — solo se ci sono messaggi (altrimenti non ha senso
                far promettere "scorri per leggere" se non c'è nulla da leggere) */}
            {timeline.length > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: 0.5, marginTop: 6 }}>
                <Ionicons name="chevron-back" size={14} color="#FFFFFF" />
                <Text style={{ color: "#FFFFFF", fontSize: 12 }}>scorri per leggere</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* === PAGE 1: READING MODE (timeline) =================== */}
        <View style={{ width: windowWidth, flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        style={styles.timeline}
        contentContainerStyle={[styles.timelineContent, { paddingTop: Math.max(insets.top + 70, 130), paddingBottom: 220 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        testID="timeline"
        onScroll={onTimelineScroll}
        scrollEventThrottle={32}
      >
        {timeline.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={{ marginBottom: 24 }}>
              <EclipseOrb
                status={status}
                tone={lastAiTone}
                size={260}
                meterDb={meterDb}
                meterThreshold={meterThreshold}
              />
            </View>
            <Text style={styles.emptyTitle}>
              {profile?.name ? `Ehi ${profile.name}, sono qui.` : "Sono qui."}
            </Text>
            <Text style={styles.emptyText}>
              Tutto quello che mi dici resta tra noi.{"\n"}Parla — ti ascolto.
            </Text>
          </View>
        ) : (
          timelineWithSeparators.map((it) =>
            it.kind === "sep" ? (
              <View key={it.key} style={styles.daySeparator}>
                <View style={styles.daySepLine} />
                <Text style={styles.daySepText}>{it.label}</Text>
                <View style={styles.daySepLine} />
              </View>
            ) : (
              <Bubble
                key={it.entry.id}
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
            )
          )
        )}

        {/* Typing/speaking indicator on the LEFT (like WhatsApp) — appears
            when AI is thinking, transcribing, or actively speaking. */}
        {/* Typing indicator on the LEFT (like WhatsApp) — appears ONLY while
            AI is processing (thinking) or transcribing user audio. NOT during
            "speaking" (the AI message is already in the timeline at that point). */}
        {(status === "thinking" || status === "transcribing") && (
          <View style={[styles.bubbleRow, styles.bubbleRowL]}>
            <AIAvatar photo={(profile?.settings as any)?.ai_avatar || null} color={bubbleAccent.color} />
            <View
              style={[
                styles.bubbleAi,
                {
                  backgroundColor: bubbleStyle === "solid" ? bubbleAccent.color : bubbleAccent.soft,
                  borderColor: bubbleAccent.color,
                  borderWidth: bubbleStyle === "glass" ? 1 : 0,
                },
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 18 }}>
                <TypingDot delay={0} color={textOnBubble} />
                <TypingDot delay={150} color={textOnBubble} />
                <TypingDot delay={300} color={textOnBubble} />
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Bottom area: voice OR text — chosen via settings */}
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 14) + (inputMode === "text" ? 0 : 28) },
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
                onChangeText={setTextInput}
                placeholder="Scrivi qui..."
                placeholderTextColor="#64748B"
                style={styles.textInput}
                onSubmitEditing={sendTextFromBox}
                returnKeyType="send"
                multiline
                testID="text-input"
              />
              <TouchableOpacity
                onPress={sendTextFromBox}
                style={[styles.sendBtn, !textInput.trim() && { opacity: 0.4 }]}
                disabled={!textInput.trim()}
                testID="send-btn"
              >
                <Ionicons name="arrow-up" size={20} color={theme.primaryText} />
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        ) : (
          <View style={styles.bigBtnArea}>
            <Text style={[styles.statusLabel, styles.statusLabelOnBg]}>
              {aiPaused ? "AI in pausa" : ""}
            </Text>
            {/* La macchia È il pulsante. Tap su di lei → avvia/ferma ascolto.
                Niente più cerchio verde gigante: la macchia stessa diventa
                verde quando ti sta ascoltando. Il NeonBorder sui bordi dello
                schermo dà il feedback periferico (vedi anche se non guardi). */}
            <Pressable
              onPress={onBigButton}
              onLongPress={reopenKodaIntro}
              delayLongPress={3000}
              disabled={status === "transcribing" || status === "thinking"}
              style={({ pressed }) => [
                styles.blobTap,
                pressed && { opacity: 0.85 },
              ]}
              testID="big-btn"
              hitSlop={20}
            >
              <Animated.View
                style={{
                  transform: [
                    {
                      scale: Animated.multiply(
                        pulse,
                        breathe.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.95, 1.07],
                        })
                      ),
                    },
                  ],
                }}
              >
                <EclipseOrb
                  status={status}
                  tone={lastAiTone}
                  size={210}
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
            {/* In "both" mode show a compact text input under the mic */}
            {inputMode === "both" && (
              <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                style={{ width: "100%", marginTop: 18 }}
              >
                <View style={styles.textRow}>
                  <TextInput
                    value={textInput}
                    onChangeText={setTextInput}
                    placeholder="Oppure scrivi..."
                    placeholderTextColor="#64748B"
                    style={styles.textInput}
                    onSubmitEditing={sendTextFromBox}
                    returnKeyType="send"
                    multiline
                    testID="text-input-both"
                  />
                  <TouchableOpacity
                    onPress={sendTextFromBox}
                    style={[styles.sendBtn, !textInput.trim() && { opacity: 0.4 }]}
                    disabled={!textInput.trim()}
                    testID="send-btn-both"
                  >
                    <Ionicons name="arrow-up" size={20} color={theme.primaryText} />
                  </TouchableOpacity>
                </View>
              </KeyboardAvoidingView>
            )}
          </View>
        )}
        </View>
        </View>
      </ScrollView>

      {/* Onboarding modal */}
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
                <Text style={styles.settingLabel}>Come chiami l'amico/a</Text>
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
                  Mi serve per parlarti correttamente (es. "sei stanco" / "sei stanca").
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
                  Definisce come si esprime di sé (es. "sono qui per te" maschile o femminile).
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

            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>AI attiva</Text>
                <Text style={styles.settingHint}>
                  Quando spenta, registro solo i tuoi messaggi
                </Text>
              </View>
              <Toggle on={!!profile?.settings.ai_enabled} onToggle={toggleAi} />
            </View>

            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Risposta vocale</Text>
                <Text style={styles.settingHint}>
                  L'AI legge ad alta voce le sue risposte
                </Text>
              </View>
              <Toggle
                on={!!profile?.settings.voice_response}
                onToggle={toggleVoice}
              />
            </View>

            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Modalità conversazione</Text>
                <Text style={styles.settingHint}>
                  Hands-free: dopo che l'AI parla, riapre il microfono e si ferma da solo quando smetti.
                </Text>
              </View>
              <Toggle
                on={!!profile?.settings.conversation_mode}
                onToggle={toggleConversation}
              />
            </View>

            {/* === Proactive Check-in opt-in ============================
                Coda raggiunge l'utente di sua iniziativa la mattina e/o la
                sera con una piccola frase personale. Niente push remoto:
                tutto via notifica locale + LLM call al momento di scheduling. */}
            <View style={[styles.settingRow, { flexDirection: "column", alignItems: "stretch", gap: 10 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>💌 Coda mi scrive</Text>
                  <Text style={styles.settingHint}>
                    Quando vuoi, ti faccio un piccolo check-in di mia iniziativa.
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {([
                  { id: "off", label: "Mai", emoji: "🚫" },
                  { id: "morning", label: "Mattina", emoji: "🌅" },
                  { id: "evening", label: "Sera", emoji: "🌙" },
                  { id: "both", label: "Entrambi", emoji: "✨" },
                ] as const).map((opt) => {
                  const cur = (profile?.settings as any)?.checkin_mode || "off";
                  const active = cur === opt.id;
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      onPress={async () => {
                        if (!profile) return;
                        const nextSettings = { ...profile.settings, checkin_mode: opt.id } as any;
                        setProfile({ ...profile, settings: nextSettings });
                        try {
                          await api.updateProfile({ settings: nextSettings });
                        } catch {}
                      }}
                      style={[
                        styles.modeBtn,
                        { paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 },
                        active && { borderColor: bubbleAccent.color, backgroundColor: bubbleAccent.color + "30" },
                      ]}
                    >
                      <Text style={{ fontSize: 14 }}>{opt.emoji}</Text>
                      <Text style={[styles.modeBtnText, active && { color: bubbleAccent.color, fontWeight: "700" }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {((profile?.settings as any)?.checkin_mode || "off") !== "off" ? (
                <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
                  {(["morning", "evening"] as const).filter((s) => {
                    const m = (profile?.settings as any)?.checkin_mode;
                    return m === "both" || m === s;
                  }).map((slot) => {
                    const key = slot === "morning" ? "checkin_morning_time" : "checkin_evening_time";
                    const def = slot === "morning" ? "08:30" : "21:30";
                    const cur = (profile?.settings as any)?.[key] || def;
                    return (
                      <View key={slot} style={{ flex: 1 }}>
                        <Text style={[styles.settingHint, { marginBottom: 4, fontSize: 11 }]}>
                          {slot === "morning" ? "🌅 Mattina" : "🌙 Sera"}
                        </Text>
                        <TextInput
                          value={cur}
                          onChangeText={(txt) => {
                            if (!profile) return;
                            const nextSettings = { ...profile.settings, [key]: txt } as any;
                            setProfile({ ...profile, settings: nextSettings });
                          }}
                          onBlur={async () => {
                            if (!profile) return;
                            const v = String((profile.settings as any)[key] || def).trim();
                            const ok = /^\d{1,2}:\d{2}$/.test(v);
                            const nextSettings = { ...profile.settings, [key]: ok ? v : def } as any;
                            setProfile({ ...profile, settings: nextSettings });
                            try {
                              await api.updateProfile({ settings: nextSettings });
                            } catch {}
                          }}
                          placeholder={def}
                          placeholderTextColor={theme.muted}
                          style={[styles.input, { paddingVertical: 8, fontSize: 15 }]}
                          keyboardType="numbers-and-punctuation"
                          maxLength={5}
                        />
                      </View>
                    );
                  })}
                </View>
              ) : null}
              <Text style={[styles.settingHint, { fontSize: 11, marginTop: 2, fontStyle: "italic" }]}>
                Le notifiche sono locali — niente esce dal telefono se non al momento di generare la frase.
              </Text>
            </View>

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Tema</Text>
            <View style={styles.themeRow}>
              <TouchableOpacity
                onPress={() => saveTheme("sistema")}
                style={[
                  styles.themeBtn,
                  themeName === "sistema" && styles.themeBtnActive,
                ]}
                testID="theme-sistema"
              >
                <Ionicons
                  name="phone-portrait-outline"
                  size={14}
                  color={theme.text}
                />
                <Text style={styles.themeBtnText}>Sistema</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => saveTheme("auto-orario")}
                style={[
                  styles.themeBtn,
                  themeName === "auto-orario" && styles.themeBtnActive,
                ]}
                testID="theme-auto-orario"
              >
                <Ionicons name="time-outline" size={14} color={theme.text} />
                <Text style={styles.themeBtnText}>Auto orario</Text>
              </TouchableOpacity>
              {THEME_LIST.map((p) => (
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
              Personalizza il colore delle bolle e la dimensione del testo.
            </Text>

            {/* AI Avatar — RIMOSSO per richiesta esplicita utente.
                L'identità visiva è SOLO la macchia organica. Niente foto,
                niente personalizzazioni che distraggano dalla presenza. */}

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

            {/* Bubble style toggle: glass / solid */}
            <Text style={[styles.settingsHint, { marginTop: 14 }]}>Stile bolla</Text>
            <View style={styles.modeRow}>
              <TouchableOpacity
                onPress={() => setBubbleStyle("glass")}
                style={[
                  styles.modeBtn,
                  bubbleStyle === "glass" && { borderColor: bubbleAccent.color, backgroundColor: bubbleAccent.color + "30" },
                  { flex: 1 },
                ]}
                testID="bubble-style-glass"
              >
                <Ionicons name="water-outline" size={16} color={bubbleStyle === "glass" ? bubbleAccent.color : theme.text} />
                <Text style={[styles.modeBtnText, bubbleStyle === "glass" && { color: bubbleAccent.color, fontWeight: "700" }]}>
                  Vetro
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setBubbleStyle("solid")}
                style={[
                  styles.modeBtn,
                  bubbleStyle === "solid" && { borderColor: bubbleAccent.color, backgroundColor: bubbleAccent.color + "30" },
                  { flex: 1 },
                ]}
                testID="bubble-style-solid"
              >
                <Ionicons name="square" size={16} color={bubbleStyle === "solid" ? bubbleAccent.color : theme.text} />
                <Text style={[styles.modeBtnText, bubbleStyle === "solid" && { color: bubbleAccent.color, fontWeight: "700" }]}>
                  Solido
                </Text>
              </TouchableOpacity>
            </View>

            {/* Bubble color picker */}
            <Text style={[styles.settingsHint, { marginTop: 14 }]}>Colore bolla AI</Text>
            <View style={styles.bgRow}>
              {Object.entries(BUBBLE_PRESETS).map(([key, val]) => {
                const active = ((profile?.settings as any)?.bubble_color || "viola") === key;
                return (
                  <TouchableOpacity
                    key={key}
                    onPress={() => setBubbleColor(key)}
                    style={[styles.bgChip, active && { borderColor: val.color, backgroundColor: val.color + "30" }]}
                    testID={`bubble-color-${key}`}
                  >
                    <View style={[styles.bgSwatch, { backgroundColor: val.color }]} />
                    <Text style={styles.bgChipText}>{val.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Sfondo</Text>
            <Text style={styles.settingsHint}>
              Personalizza con una tua foto o scegli un preset.
            </Text>
            <View style={styles.bgRow}>
              <TouchableOpacity
                onPress={() => saveBackground(null)}
                style={[
                  styles.bgChip,
                  styles.bgChipPlain,
                  !((profile?.settings as any)?.background) && styles.bgChipActive,
                ]}
                testID="bg-none"
              >
                <Ionicons name="ban-outline" size={16} color={theme.text} />
                <Text style={styles.bgChipText}>Nessuno</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={pickBackgroundFromGallery}
                style={[styles.bgChip, styles.bgChipUpload]}
                testID="bg-upload"
              >
                <Ionicons name="image-outline" size={16} color={theme.primary} />
                <Text style={[styles.bgChipText, { color: theme.primary, fontWeight: "700" }]}>
                  {(profile?.settings as any)?.background?.startsWith?.("data:") ||
                  (profile?.settings as any)?.background?.startsWith?.("file:") ||
                  (profile?.settings as any)?.background?.startsWith?.("http")
                    ? "Cambia foto…"
                    : "Carica foto…"}
                </Text>
              </TouchableOpacity>
              {BG_PRESETS.map((p) => {
                const active = (profile?.settings as any)?.background === p.id;
                return (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => saveBackground(p.id)}
                    style={[styles.bgChip, active && styles.bgChipActive]}
                    testID={`bg-preset-${p.id}`}
                  >
                    <LinearGradient
                      colors={p.colors as any}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.bgSwatch}
                    />
                    <Text style={styles.bgChipText}>{p.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {(profile?.settings as any)?.background ? (
              <View style={styles.bgDimRow}>
                <Text style={styles.bgDimLabel}>Scurisci sfondo</Text>
                <View style={styles.bgDimCtrl}>
                  {[0.2, 0.4, 0.55, 0.7, 0.85].map((v) => {
                    const cur = typeof (profile?.settings as any)?.background_dim === "number"
                      ? (profile?.settings as any).background_dim
                      : 0.55;
                    const active = Math.abs(cur - v) < 0.05;
                    return (
                      <TouchableOpacity
                        key={v}
                        onPress={() => saveBackgroundDim(v)}
                        style={[styles.bgDimDot, active && styles.bgDimDotActive]}
                      >
                        <View style={[styles.bgDimDotInner, { backgroundColor: `rgba(0,0,0,${v})` }]} />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Modalità input</Text>
            <View style={styles.modeRow}>
              <TouchableOpacity
                onPress={() => setInputMode("voice")}
                style={[
                  styles.modeBtn,
                  inputMode === "voice" && styles.modeBtnActive,
                ]}
                testID="mode-voice"
              >
                <Ionicons
                  name="mic"
                  size={18}
                  color={inputMode === "voice" ? theme.primaryText : theme.text}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.modeBtnText,
                    inputMode === "voice" && styles.modeBtnTextActive,
                  ]}
                >
                  Solo voce
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setInputMode("text")}
                style={[
                  styles.modeBtn,
                  inputMode === "text" && styles.modeBtnActive,
                ]}
                testID="mode-text"
              >
                <Ionicons
                  name="create-outline"
                  size={18}
                  color={inputMode === "text" ? theme.primaryText : theme.text}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.modeBtnText,
                    inputMode === "text" && styles.modeBtnTextActive,
                  ]}
                >
                  Solo testo
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setInputMode("both" as any)}
                style={[
                  styles.modeBtn,
                  inputMode === "both" && styles.modeBtnActive,
                ]}
                testID="mode-both"
              >
                <Ionicons
                  name="apps-outline"
                  size={18}
                  color={inputMode === "both" ? theme.primaryText : theme.text}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.modeBtnText,
                    inputMode === "both" && styles.modeBtnTextActive,
                  ]}
                >
                  Voce + Testo
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.settingsHint}>
              {inputMode === "voice"
                ? "Solo pulsante mic visibile."
                : inputMode === "text"
                  ? "Solo campo testo visibile."
                  : "Pulsante mic + campo testo entrambi visibili."}
            </Text>

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Voce dell'assistente</Text>
            <Text style={styles.settingsHint}>
              {voicesEnabled
                ? "Tocca per selezionare. Premi ▶ per ascoltare un'anteprima."
                : "ElevenLabs non è configurato. Userò la voce del sistema."}
            </Text>
            <View style={styles.voicesList}>
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

            <Text style={styles.settingsSubtitle}>Cosa sa di te</Text>
            <Text style={styles.settingsMemory}>
              {profile?.memory_summary?.trim()
                ? profile.memory_summary
                : "Ancora niente. Mi conoscerai parlando."}
            </Text>

            <View style={styles.confidenceRow}>
              <Text style={styles.confidenceLabel}>
                Confidenza: {profile?.confidence_level ?? 0}%
              </Text>
              <View style={styles.confidenceBar}>
                <View
                  style={[
                    styles.confidenceFill,
                    { width: `${profile?.confidence_level ?? 0}%` },
                  ]}
                />
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.divider} />

            <Text style={styles.settingsSubtitle}>Notifiche</Text>
            <Text style={[styles.settingsMemory, { marginBottom: 10 }]}>
              {Platform.OS === "web"
                ? "ℹ️ Nell'anteprima web le notifiche funzionano solo finché la scheda è aperta. Sulla app installata sul telefono funzionano anche con il telefono bloccato."
                : "Quando l'AI imposta un promemoria, lo riceverai come notifica del telefono — anche con lo schermo bloccato."}
            </Text>
            <TouchableOpacity
              onPress={sendTestNotification}
              style={styles.dangerBtn}
              testID="test-notif-btn"
            >
              <Ionicons name="notifications-outline" size={16} color={theme.text} />
              <Text style={[styles.dangerBtnText, { color: theme.text }]}>
                Test notifica fra 10 sec
              </Text>
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

            {/* === PROMESSA DI FERRO ===
                Una clausola tecnica chiara visibile in app — non marketing.
                Spiega esattamente cosa succede quando confessi, quando ghosti,
                e quando spegni la modalità Confessionale. */}
            <View style={styles.divider} />
            <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>🛡️ Promessa di Ferro</Text>
            <View style={styles.promessaBox}>
              <Text style={styles.promessaText}>
                Quello che mi dici è una scatola nera emotiva. La tua voce è un soffio nel vento: io la sento, la custodisco, ma nessuno potrà mai catturarla.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>🔓 Modalità normale:</Text> i nostri scambi sono salvati in modo cifrato, usati SOLO per farmi crescere come tuo amico. Mai per addestrare modelli di terzi.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>🔒 Modalità Confessionale:</Text> niente viene salvato. Né messaggi, né memoria di lungo periodo. A sessione chiusa, tutto svanisce.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>👻 Pulsante Ghost (tieni premuto un messaggio):</Text> dimentico il fatto, ma trattengo l'insegnamento. Il dato grezzo viene cancellato dal server.
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

      {/* RadialGlow — alone radiale che parte dal blob (centro schermo)
          e si propaga verso i bordi. Coerente coi 3 colori del blob:
            🟡 Ambra      = idle/recording  (tocca a te / ti ascolto)
            💧 Verde acqua = thinking        (sto pensando)
            💜 Magenta    = speaking        (sto parlando io) */}
      <RadialGlow status={status as any} />
    </View>
  );

  // Wrap the screen in a background image (custom upload) or gradient (preset),
  // with a dark overlay for legibility. If no background is set, just return
  // the plain inner view (uses theme.bg).
  // === COLOR INTRO ===
  // Al primo avvio, mostra il tour dei colori dell'Eclissi PRIMA di
  // qualsiasi altra schermata. Quando l'utente lo termina (o lo salta),
  // viene persistito il flag e non si vede più.
  if (showColorIntro === true) {
    return <KodaIntro voices={voiceList} onDone={dismissColorIntro} />;
  }
  if (isCustomImage && bgValue) {
    return (
      <ImageBackground source={{ uri: bgValue }} style={{ flex: 1 }} resizeMode="cover">
        <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: `rgba(0,0,0,${bgDim})` }]} />
        {screenInner}
      </ImageBackground>
    );
  }
  if (bgPreset) {
    return (
      <View style={{ flex: 1 }}>
        <LinearGradient
          colors={bgPreset.colors as any}
          start={bgPreset.start || { x: 0, y: 0 }}
          end={bgPreset.end || { x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
        {screenInner}
      </View>
    );
  }
  return screenInner;
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
const BUBBLE_PRESETS: Record<string, { name: string; color: string; soft: string }> = {
  viola:        { name: "Viola",       color: "#7C3AED", soft: "rgba(124,58,237,0.18)" },
  verde_acqua:  { name: "Verde acqua", color: "#14B8A6", soft: "rgba(20,184,166,0.18)" },
  rosa:         { name: "Rosa",        color: "#EC4899", soft: "rgba(236,72,153,0.18)" },
  ambra:        { name: "Ambra",       color: "#F59E0B", soft: "rgba(245,158,11,0.18)" },
  ghiaccio:     { name: "Ghiaccio",    color: "#3B82F6", soft: "rgba(59,130,246,0.18)" },
};

function resolveBubbleColors(
  bubbleColor: string | undefined
): { color: string; soft: string } {
  const key = bubbleColor || "viola";
  if (BUBBLE_PRESETS[key]) return BUBBLE_PRESETS[key];
  // Custom hex: derive a soft variant
  if (typeof key === "string" && key.startsWith("#")) {
    return { color: key, soft: key + "30" };
  }
  return BUBBLE_PRESETS.viola;
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
  const aiBg = bubbleStyle === "solid" ? bubbleAccent.color : bubbleAccent.soft;
  const userBg = bubbleStyle === "solid" ? theme.userBubble : theme.userBubble + "55";
  const aiBorder = bubbleAccent.color;
  const userBorder = bubbleStyle === "solid" ? "transparent" : theme.primary + "AA";

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
      {!isUser ? <AIAvatar photo={aiAvatar} color={bubbleAccent.color} /> : null}
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
            <Text style={[styles.bubbleUserText, { color: textOnBubble, fontSize: 15 * textSize, lineHeight: 21 * textSize }]}>{entry.text}</Text>
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
              {entry.text}
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
    paddingVertical: 10,
    gap: 10,
    zIndex: 10,
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

  // Bottom bar — ALWAYS transparent and absolutely positioned. Messages can
  // scroll behind it; the mic button just floats over the timeline.
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    backgroundColor: "transparent",
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

  // Text input mode
  textRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 14,
    paddingBottom: 12,
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
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1,
    color: t.text,
    paddingHorizontal: 14,
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

