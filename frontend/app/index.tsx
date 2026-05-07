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
import { scheduleAt } from "../lib/notifications";
import { useTheme, THEME_LIST, ThemeName, Palette } from "../lib/theme";
import AppIcon from "../lib/AppIcon";

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
  { id: "aurora", name: "Aurora", colors: ["#0F0C29", "#302B63", "#24243E"] },
  { id: "notturno", name: "Notturno", colors: ["#000000", "#1A1A2E", "#16213E"] },
  { id: "carta", name: "Carta", colors: ["#F5E9D7", "#E8D5B7", "#D4B896"] },
  { id: "alba", name: "Alba", colors: ["#FF9966", "#FF5E62", "#9D50BB"] },
  { id: "marmo", name: "Marmo", colors: ["#1F1C2C", "#928DAB"] },
  { id: "bosco", name: "Bosco", colors: ["#0B3C24", "#0F5132", "#1F2937"] },
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

export default function Taccuino() {
  const insets = useSafeAreaInsets();
  const { theme, themeName, setThemeName, setHours, dayStart, nightStart } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [textInput, setTextInput] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
  const pulse = useRef(new Animated.Value(1)).current;
  const breathe = useRef(new Animated.Value(0)).current;

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

  const speakIfEnabled = useCallback(
    async (text: string, tone: TimelineEntry["tone"]) => {
      if (!profile?.settings.voice_response) {
        // Voice response disabled — but if conversation is active, still reopen mic
        if (convActiveRef.current && profile?.settings?.input_mode !== "text") {
          startTalkInternal(true).catch(() => {});
        }
        return;
      }
      const lang = profile?.language || "it";
      const langTag = lang === "it" ? "it-IT" : lang === "en" ? "en-US" : lang;

      // CONVERSATION LOOP (simplified): no parallel mic during TTS — that was
      // causing the AI's own voice to bleed into the mic and trigger silence
      // detection on the AI's voice instead of the user's. Now strictly
      // sequential: AI speaks → AI finishes → mic opens for the user.
      // Voice barge-in is replaced by tap-to-interrupt (handled in onBigButton:
      // tapping during "speaking" stops TTS and opens the mic immediately).
      if (convActiveRef.current && profile?.settings?.input_mode !== "text") {
        setStatus("speaking");
        // Speak and WAIT for it to finish before opening the mic
        await SpeechMod.speak(text, { language: langTag, tone });
        // If conversation is still active, immediately open mic for next user turn
        if (convActiveRef.current) {
          // CRITICAL: explicitly transition to "idle" before opening mic.
          // startTalkInternal has special logic that PRESERVES "speaking" status
          // (used during barge-in mode) — but we're past TTS now, so we want
          // the normal "recording" flow. Without this reset, status stays
          // stuck on "speaking" → user sees "Sto parlando" and thinks they
          // can't talk → no audio captured.
          setStatus("idle");
          // Small delay to let iOS audio session settle from playback to recording
          await new Promise((r) => setTimeout(r, 200));
          if (convActiveRef.current && !recRef.current) {
            startTalkInternal(true).catch(() => {});
          }
        }
        return;
      }

      // NORMAL (non-conversation) mode: speak then go idle
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
            // Inform user gently (probably permission denied)
            setError(
              "Non riesco a impostare la notifica: serve il permesso 🔔. Aprila dalle impostazioni del telefono."
            );
            setTimeout(() => setError(null), 6000);
          }
        }
      } catch (e) {
        console.warn("action exec error", e);
      }
    }
  }, []);

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
        const res = await api.converse(txt);
        // Replace optimistic with real, then add AI entry
        setTimeline((prev) => {
          const filtered = prev.filter((e) => e.id !== optimistic.id);
          return [...filtered, res.user_entry, res.ai_entry];
        });
        setProfile(res.profile);
        // Execute any actions (notifications, etc.) requested by the AI
        runActions(res.ai_entry.actions || []);
        await speakIfEnabled(res.ai_entry.text, res.ai_entry.tone || "neutral");
      } catch (e: any) {
        setError("Ops, qualcosa non funziona. Riprova.");
        setStatus("idle");
        // Remove optimistic
        setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
      }
    },
    [speakIfEnabled, runActions]
  );

  // Push-to-talk (or hands-free)
  const startTalkInternal = async (autoStopOnSilence: boolean) => {
    if (status !== "idle" && status !== "speaking") return;
    setError(null);
    // Unlock speech engine on first user interaction (web only)
    unlockSpeech().catch(() => {});
    try {
      // If AI is currently speaking, don't kill TTS yet — wait for the user
      // to actually start speaking before barging in.
      if (status !== "speaking") {
        SpeechMod.stop();
      }
      const rec = await startRecording();
      recRef.current = rec;
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
    const wantHandsFree = !!profile?.settings?.conversation_mode;
    return startTalkInternal(wantHandsFree);
  };

  const stopTalk = async () => {
    // Use recRef.current as single source of truth (status check would create
    // stale-closure bugs when called from the silence-detection callback)
    const current = recRef.current;
    if (!current) return;
    recRef.current = null;
    setStatus("transcribing");
    try {
      const res = await current.stop();
      // CRITICAL: switch the audio session out of "recording" mode IMMEDIATELY
      // so that the AI's TTS playback can run unhindered. Without this, on
      // iOS the session can stay in playAndRecord mode and Audio.Sound
      // playback fails silently → user hears no AI voice.
      if (Platform.OS !== "web") {
        try {
          const { Audio } = require("expo-av");
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: false,
            playsInSilentModeIOS: true,
            staysActiveInBackground: false,
            shouldDuckAndroid: true,
            playThroughEarpieceAndroid: false,
          });
        } catch {}
      }
      if (!res) {
        setStatus("idle");
        return;
      }
      const fd = buildFormData(res);
      const r = await fetch(`${API_BASE}/transcribe`, {
        method: "POST",
        body: fd,
      });
      if (!r.ok) throw new Error("transcribe");
      const data = await r.json();
      const txt = (data.text || "").trim();
      if (!txt) {
        setError("Non ho sentito nulla.");
        setStatus("idle");
        // In conversation mode, immediately re-open mic so the loop continues
        if (convActiveRef.current && profile?.settings?.input_mode !== "text") {
          setTimeout(() => {
            if (convActiveRef.current && !recRef.current) {
              startTalkInternal(true).catch(() => {});
            }
          }, 250);
        }
        return;
      }
      // Send to converse
      await sendText(txt);
    } catch (e) {
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
   * Tap-on-AI-bubble handler: re-play the AI's message text via ElevenLabs.
   * Stops any current playback first, then speaks using the user's chosen voice.
   */
  const replayMessage = async (entry: TimelineEntry) => {
    if (!entry || entry.role === "user" || !entry.text) return;
    SpeechMod.stop();
    try {
      const langTag = profile?.language === "it" ? "it-IT" : profile?.language || "it-IT";
      // Make sure audio is unlocked on web (required by Safari for play())
      await unlockSpeech();
      await SpeechMod.speak(entry.text, {
        language: langTag,
        tone: (entry.tone as Tone) || "neutral",
      });
    } catch {}
  };

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
    <View style={[styles.screen, { paddingTop: insets.top, backgroundColor: bgValue ? "transparent" : theme.bg }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={askRecap}
          testID="recap-btn"
        >
          <Ionicons name="reader-outline" size={18} color={theme.text} />
          <Text style={styles.headerBtnText}>Sunto</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={[styles.dot, aiPaused && { backgroundColor: "#94A3B8" }]} />
          <Text style={styles.headerTitle}>Taccuino</Text>
        </View>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => setShowSettings(true)}
          testID="settings-btn"
        >
          <Ionicons name="settings-outline" size={18} color={theme.text} />
        </TouchableOpacity>
      </View>

      {/* Timeline */}
      <ScrollView
        ref={scrollRef}
        style={styles.timeline}
        contentContainerStyle={[styles.timelineContent, { paddingBottom: 220 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        testID="timeline"
      >
        {timeline.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={{ marginBottom: 16 }}>
              <AppIcon size={96} />
            </View>
            <Text style={styles.emptyTitle}>Il tuo Taccuino è vuoto</Text>
            <Text style={styles.emptyText}>
              Premi il cerchio in basso e raccontami qualcosa: una spesa,
              un impegno, qualunque cosa. Ricorderò io per te.
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
              <Bubble key={it.entry.id} entry={it.entry} onReplay={replayMessage} />
            )
          )
        )}

        {status === "thinking" && (
          <View style={[styles.bubbleAi, { alignSelf: "flex-end" }]}>
            <ActivityIndicator size="small" color={theme.primary} />
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
            <Text style={styles.statusLabel}>
              {aiPaused ? "AI in pausa" : statusLabel}
            </Text>
            <View style={styles.bigBtnWrap}>
              {/* Neon glow halo underneath — breathes wider than the button */}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.neonGlow,
                  status === "recording" && { backgroundColor: "#EF4444" },
                  {
                    opacity: breathe.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.25, 0.45],
                    }),
                    transform: [
                      {
                        scale: breathe.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1.0, 1.15],
                        }),
                      },
                    ],
                  },
                ]}
              />
              {/* Secondary softer halo for added neon bleed */}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.neonGlowSoft,
                  status === "recording" && { backgroundColor: "#EF4444" },
                  {
                    opacity: breathe.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.12, 0.25],
                    }),
                    transform: [
                      {
                        scale: breathe.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1.05, 1.25],
                        }),
                      },
                    ],
                  },
                ]}
              />
              {/* The actual button — clean, no outer rings. Breathes (scale) + mic-pulse */}
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
                <Pressable
                  onPress={onBigButton}
                  disabled={status === "transcribing" || status === "thinking"}
                  style={({ pressed }) => [
                    styles.bigBtn,
                    status === "recording" && styles.bigBtnRec,
                    pressed && { opacity: 0.88 },
                  ]}
                  testID="big-btn"
                >
                  {status === "transcribing" || status === "thinking" ? (
                    <ActivityIndicator color={theme.primaryText} size="large" />
                  ) : (
                    <Ionicons
                      name={
                        status === "recording"
                          ? "stop"
                          : status === "speaking"
                            ? "volume-high"
                            : "mic"
                      }
                      size={54}
                      color={theme.primaryText}
                    />
                  )}
                </Pressable>
              </Animated.View>
            </View>
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
    </View>
  );

  // Wrap the screen in a background image (custom upload) or gradient (preset),
  // with a dark overlay for legibility. If no background is set, just return
  // the plain inner view (uses theme.bg).
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

function Bubble({ entry, onReplay }: { entry: TimelineEntry; onReplay?: (e: TimelineEntry) => void }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const isUser = entry.role === "user";
  const tone = (entry.tone || "neutral") as keyof typeof theme.tone;
  const ts = theme.tone[tone] || theme.tone.neutral;
  const dom = entry.domain ? domainBadge[entry.domain as Domain] : null;
  const [showTime, setShowTime] = useState(false);

  const Wrapper: any = !isUser && onReplay ? Pressable : Pressable;
  const wrapperProps: any = {
    onPress: () => {
      if (!isUser && onReplay) onReplay(entry);
      else setShowTime((s) => !s);
    },
    onLongPress: () => setShowTime((s) => !s),
    delayLongPress: 250,
    style: ({ pressed }: any) => [
      isUser ? styles.bubbleUser : styles.bubbleAi,
      !isUser && {
        backgroundColor: ts.bg,
        borderColor: ts.border,
      },
      pressed && { opacity: 0.78 },
    ],
    accessibilityRole: "button",
    accessibilityLabel: !isUser ? "Tocca per riascoltare a voce" : "Messaggio",
    testID: !isUser ? `replay-${entry.id}` : undefined,
  };

  const userBubbleColors: [string, string] = [theme.userBubble, theme.primary];

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowR : styles.bubbleRowL]}>
      {!isUser ? <MiniOrb color={theme.primary} /> : null}
      <View style={{ maxWidth: "82%" }}>
        {isUser ? (
          // User bubble: gradient with rounded tail-corner
          <Pressable
            onPress={() => setShowTime((s) => !s)}
            onLongPress={() => setShowTime((s) => !s)}
            delayLongPress={250}
            style={({ pressed }) => [pressed && { opacity: 0.85 }]}
          >
            <LinearGradient
              colors={userBubbleColors}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.bubbleUser}
            >
              <Text style={styles.bubbleUserText}>{entry.text}</Text>
            </LinearGradient>
          </Pressable>
        ) : (
          <Wrapper {...wrapperProps}>
            {dom ? (
              <View style={[styles.domainPill, { borderColor: dom.color }]}>
                <Text style={styles.domainEmoji}>{dom.emoji}</Text>
                <Text style={[styles.domainLabel, { color: dom.color }]}>
                  {dom.label}
                </Text>
              </View>
            ) : null}
            <Text style={styles.bubbleAiText}>{entry.text}</Text>
            {entry.extracted?.amount ? (
              <Text style={styles.extractMeta}>
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
                        hour: "2-digit",
                        minute: "2-digit",
                        day: "2-digit",
                        month: "2-digit",
                      })
                    : "—";
                  return (
                    <View key={idx} style={styles.actionPill}>
                      <Text style={styles.actionEmoji}>🔔</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.actionTitle}>
                          {a.title || "Promemoria"}
                        </Text>
                        <Text style={styles.actionSub}>
                          {a.label || timeStr}
                          {a.body ? ` · ${a.body}` : ""}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </Wrapper>
        )}
        {showTime ? (
          <Text style={[styles.bubbleTime, isUser ? { textAlign: "right" } : { textAlign: "left" }]}>
            {new Date(entry.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (t: any) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.bg },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  headerCenter: { flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 999, backgroundColor: t.success },
  headerTitle: { color: t.text, fontWeight: "700", letterSpacing: 0.5, fontSize: 14 },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: t.surfaceAlt,
    borderColor: t.border,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  headerBtnText: { color: t.text, fontSize: 12, fontWeight: "600" },

  // Timeline
  timeline: { flex: 1 },
  timelineContent: { paddingHorizontal: 16, paddingTop: 12 },

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

  // Bottom bar
  bottomBar: {
    paddingHorizontal: 20,
    backgroundColor: t.bg,
    borderTopWidth: 1,
    borderTopColor: t.divider,
  },
  errorText: { color: t.danger, fontSize: 12, textAlign: "center", marginTop: 8 },
  bigBtnArea: { alignItems: "center", paddingTop: 20, justifyContent: "center" },
  statusLabel: {
    color: t.textDim,
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 18,
    letterSpacing: 0.3,
  },
  bigBtnWrap: {
    width: 160,
    height: 160,
    alignItems: "center",
    justifyContent: "center",
  },
  // Soft neon glow underneath the button; absolutely positioned, breathes
  neonGlow: {
    position: "absolute",
    width: 150,
    height: 150,
    borderRadius: 999,
    backgroundColor: t.primary,
    // Use boxShadow (web) and shadowRadius (native) for sfumato/neon bleed
    ...Platform.select({
      ios: {
        shadowColor: t.primary,
        shadowOpacity: 1.0,
        shadowRadius: 45,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 0 },
      web: {
        // large colored blur for the neon fade
        boxShadow: `0 0 60px 20px ${t.primary}`,
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
    width: 130,
    height: 130,
    borderRadius: 999,
    backgroundColor: t.primary,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowColor: t.primary,
        shadowOpacity: 0.8,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 10 },
      web: {
        boxShadow: `0 0 30px 4px ${t.primary}`,
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

