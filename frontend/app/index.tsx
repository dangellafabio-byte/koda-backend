import React, { useEffect, useRef, useState, useCallback } from "react";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  api,
  API_BASE,
  TimelineEntry,
  Profile,
  toneStyle,
  domainBadge,
  Domain,
} from "../lib/api";
import { startRecording, buildFormData, Recorder } from "../lib/voice";
import { SpeechMod } from "../lib/speech";

type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

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
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [textInput, setTextInput] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showText, setShowText] = useState(false); // text input mode
  const [error, setError] = useState<string | null>(null);
  const [recapText, setRecapText] = useState<string | null>(null);
  const [showRecap, setShowRecap] = useState(false);

  const recRef = useRef<Recorder | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  // Initial load
  useEffect(() => {
    (async () => {
      try {
        const p = await api.getProfile();
        setProfile(p);
        if (!p.onboarded) setShowOnboarding(true);
        const t = await api.getTimeline(200);
        setTimeline(t);
      } catch (e) {
        console.warn("init error", e);
      }
    })();
  }, []);

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
      if (!profile?.settings.voice_response) return;
      setStatus("speaking");
      const lang = profile?.language || "it";
      const langTag = lang === "it" ? "it-IT" : lang === "en" ? "en-US" : lang;
      await SpeechMod.speak(text, { language: langTag, tone });
      setStatus("idle");
    },
    [profile]
  );

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
        await speakIfEnabled(res.ai_entry.text, res.ai_entry.tone || "neutral");
      } catch (e: any) {
        setError("Ops, qualcosa non funziona. Riprova.");
        setStatus("idle");
        // Remove optimistic
        setTimeline((prev) => prev.filter((e) => e.id !== optimistic.id));
      }
    },
    [speakIfEnabled]
  );

  // Push-to-talk
  const startTalk = async () => {
    if (status !== "idle") return;
    setError(null);
    try {
      SpeechMod.stop();
      const rec = await startRecording();
      recRef.current = rec;
      setStatus("recording");
    } catch (e) {
      setError("Microfono non disponibile. Controlla i permessi.");
    }
  };

  const stopTalk = async () => {
    if (status !== "recording" || !recRef.current) return;
    setStatus("transcribing");
    try {
      const res = await recRef.current.stop();
      recRef.current = null;
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
    if (status === "idle") startTalk();
    else if (status === "recording") stopTalk();
    else if (status === "speaking") {
      SpeechMod.stop();
      setStatus("idle");
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

  const statusLabel = (() => {
    switch (status) {
      case "recording":
        return "Ti ascolto...";
      case "transcribing":
        return "Sto leggendo...";
      case "thinking":
        return "Sto pensando...";
      case "speaking":
        return "Sto parlando...";
      default:
        return "Premi e parla";
    }
  })();

  const aiPaused = profile && !profile.settings.ai_enabled;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={askRecap}
          testID="recap-btn"
        >
          <Ionicons name="reader-outline" size={18} color="#E2E8F0" />
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
          <Ionicons name="settings-outline" size={18} color="#E2E8F0" />
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
            <Text style={styles.emptyEmoji}>🪶</Text>
            <Text style={styles.emptyTitle}>Il tuo Taccuino è vuoto</Text>
            <Text style={styles.emptyText}>
              Premi il cerchio in basso e raccontami qualcosa: una spesa,
              un impegno, qualunque cosa. Ricorderò io per te.
            </Text>
          </View>
        ) : (
          timeline.map((e) => <Bubble key={e.id} entry={e} />)
        )}

        {status === "thinking" && (
          <View style={[styles.bubbleAi, { alignSelf: "flex-end" }]}>
            <ActivityIndicator size="small" color="#FBBF24" />
          </View>
        )}
      </ScrollView>

      {/* Bottom area: big button + text fallback */}
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 14) + (showText ? 0 : 28) },
        ]}
      >
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {showText ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <View style={styles.textRow}>
              <TouchableOpacity
                onPress={() => setShowText(false)}
                style={styles.textIconBtn}
              >
                <Ionicons name="mic-outline" size={20} color="#E2E8F0" />
              </TouchableOpacity>
              <TextInput
                value={textInput}
                onChangeText={setTextInput}
                placeholder="Scrivi qui se non vuoi parlare..."
                placeholderTextColor="#64748B"
                style={styles.textInput}
                onSubmitEditing={sendTextFromBox}
                returnKeyType="send"
                testID="text-input"
              />
              <TouchableOpacity
                onPress={sendTextFromBox}
                style={[styles.sendBtn, !textInput.trim() && { opacity: 0.4 }]}
                disabled={!textInput.trim()}
              >
                <Ionicons name="arrow-up" size={20} color="#0B0F1A" />
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        ) : (
          <View style={styles.bigBtnArea}>
            <Text style={styles.statusLabel}>
              {aiPaused ? "AI in pausa" : statusLabel}
            </Text>
            <Animated.View
              style={[
                styles.bigBtnRingOuter,
                { transform: [{ scale: pulse }] },
                status === "recording" && { borderColor: "#EF4444" },
              ]}
            >
              <View
                style={[
                  styles.bigBtnRingInner,
                  status === "recording" && { borderColor: "rgba(239,68,68,0.6)" },
                ]}
              >
                <Pressable
                  onPress={onBigButton}
                  disabled={status === "transcribing" || status === "thinking"}
                  style={({ pressed }) => [
                    styles.bigBtn,
                    status === "recording" && styles.bigBtnRec,
                    pressed && { opacity: 0.85 },
                  ]}
                  testID="big-btn"
                >
                  {status === "transcribing" || status === "thinking" ? (
                    <ActivityIndicator color="#0B0F1A" size="large" />
                  ) : (
                    <Ionicons
                      name={
                        status === "recording"
                          ? "stop"
                          : status === "speaking"
                            ? "volume-high"
                            : "mic"
                      }
                      size={42}
                      color="#0B0F1A"
                    />
                  )}
                </Pressable>
              </View>
            </Animated.View>
            <TouchableOpacity
              onPress={() => setShowText(true)}
              style={styles.altBtn}
              testID="alt-text-btn"
            >
              <Ionicons name="create-outline" size={14} color="#94A3B8" />
              <Text style={styles.altBtnText}>oppure scrivi</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Onboarding modal */}
      <Modal visible={showOnboarding} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.onboardCard}>
            <Text style={styles.onboardEmoji}>🪶</Text>
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
        onRequestClose={() => setShowSettings(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <View style={styles.settingsHeader}>
              <Text style={styles.settingsTitle}>Impostazioni</Text>
              <TouchableOpacity onPress={() => setShowSettings(false)}>
                <Ionicons name="close" size={24} color="#E2E8F0" />
              </TouchableOpacity>
            </View>

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

            <TouchableOpacity
              onPress={resetMemory}
              style={styles.dangerBtn}
              testID="reset-btn"
            >
              <Ionicons name="trash-outline" size={16} color="#F87171" />
              <Text style={styles.dangerBtnText}>Cancella tutta la memoria</Text>
            </TouchableOpacity>
            <Text style={styles.dangerHint}>
              Reset completo: profilo, taccuino e ogni ricordo.
            </Text>
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
              <TouchableOpacity onPress={() => setShowRecap(false)}>
                <Ionicons name="close" size={24} color="#E2E8F0" />
              </TouchableOpacity>
            </View>
            {recapText === null ? (
              <ActivityIndicator color="#FBBF24" />
            ) : (
              <Text style={styles.recapText}>{recapText}</Text>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// =============== Sub components ===============

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <TouchableOpacity
      onPress={onToggle}
      style={[styles.toggle, on && styles.toggleOn]}
    >
      <View style={[styles.toggleKnob, on && styles.toggleKnobOn]} />
    </TouchableOpacity>
  );
}

function Bubble({ entry }: { entry: TimelineEntry }) {
  const isUser = entry.role === "user";
  const tone = entry.tone || "neutral";
  const ts = toneStyle[tone];
  const dom = entry.domain ? domainBadge[entry.domain as Domain] : null;

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowR : styles.bubbleRowL]}>
      <View
        style={[
          isUser ? styles.bubbleUser : styles.bubbleAi,
          !isUser && {
            backgroundColor: ts.bg,
            borderColor: ts.border,
          },
        ]}
      >
        {!isUser && dom ? (
          <View style={[styles.domainPill, { borderColor: dom.color }]}>
            <Text style={styles.domainEmoji}>{dom.emoji}</Text>
            <Text style={[styles.domainLabel, { color: dom.color }]}>
              {dom.label}
            </Text>
          </View>
        ) : null}
        <Text style={isUser ? styles.bubbleUserText : styles.bubbleAiText}>
          {entry.text}
        </Text>
        {!isUser && entry.extracted?.amount ? (
          <Text style={styles.extractMeta}>
            💶 {entry.extracted.amount}
            {entry.extracted.currency ? ` ${entry.extracted.currency}` : ""}
            {entry.extracted.item ? ` · ${entry.extracted.item}` : ""}
          </Text>
        ) : null}
      </View>
      <Text style={styles.bubbleTime}>
        {new Date(entry.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0F1A" },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  headerCenter: { flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 999, backgroundColor: "#22D3EE" },
  headerTitle: { color: "#E2E8F0", fontWeight: "700", letterSpacing: 0.5, fontSize: 14 },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  headerBtnText: { color: "#E2E8F0", fontSize: 12, fontWeight: "600" },

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
    color: "#E2E8F0",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
  },
  emptyText: {
    color: "#94A3B8",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },

  bubbleRow: { marginBottom: 12 },
  bubbleRowL: { alignItems: "flex-start" },
  bubbleRowR: { alignItems: "flex-end" },
  bubbleUser: {
    backgroundColor: "#FBBF24",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomRightRadius: 4,
    maxWidth: "82%",
  },
  bubbleAi: {
    backgroundColor: "rgba(148,163,184,0.10)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.35)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    maxWidth: "82%",
  },
  bubbleUserText: { color: "#0B0F1A", fontSize: 15, lineHeight: 21 },
  bubbleAiText: { color: "#E2E8F0", fontSize: 15, lineHeight: 21 },
  bubbleTime: { color: "#475569", fontSize: 10, marginTop: 4, paddingHorizontal: 4 },

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
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 8,
    fontWeight: "600",
  },

  // Bottom bar
  bottomBar: {
    paddingHorizontal: 20,
    backgroundColor: "rgba(11,15,26,0.95)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.05)",
  },
  errorText: { color: "#F87171", fontSize: 12, textAlign: "center", marginTop: 8 },
  bigBtnArea: { alignItems: "center", paddingTop: 20 },
  statusLabel: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 18,
    letterSpacing: 0.3,
  },
  bigBtnRingOuter: {
    width: 132,
    height: 132,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  bigBtnRingInner: {
    width: 112,
    height: 112,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  bigBtn: {
    width: 92,
    height: 92,
    borderRadius: 999,
    backgroundColor: "#FBBF24",
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowColor: "#FBBF24",
        shadowOpacity: 0.6,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 0 },
      },
      android: { elevation: 8 },
    }),
  },
  bigBtnRec: { backgroundColor: "#EF4444" },
  altBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  altBtnText: { color: "#94A3B8", fontSize: 12 },

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
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  textInput: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    color: "#E2E8F0",
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
    backgroundColor: "#FBBF24",
    alignItems: "center",
    justifyContent: "center",
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  onboardCard: {
    backgroundColor: "#101622",
    borderRadius: 24,
    padding: 26,
    width: "100%",
    maxWidth: 380,
    alignItems: "center",
  },
  onboardEmoji: { fontSize: 50, marginBottom: 8 },
  onboardTitle: {
    color: "#E2E8F0",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
  },
  onboardText: {
    color: "#94A3B8",
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
    backgroundColor: "rgba(251,191,36,0.08)",
    borderColor: "rgba(251,191,36,0.3)",
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    alignItems: "center",
    gap: 4,
    minWidth: 92,
  },
  langEmoji: { fontSize: 22 },
  langLabel: { color: "#E2E8F0", fontSize: 12, fontWeight: "600" },
  onboardFoot: { color: "#475569", fontSize: 11, textAlign: "center" },

  settingsCard: {
    backgroundColor: "#101622",
    borderRadius: 24,
    padding: 22,
    width: "100%",
    maxWidth: 420,
  },
  settingsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  settingsTitle: { color: "#E2E8F0", fontSize: 18, fontWeight: "700" },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 14,
  },
  settingLabel: { color: "#E2E8F0", fontSize: 14, fontWeight: "600" },
  settingHint: { color: "#64748B", fontSize: 12, marginTop: 3 },
  divider: { height: 1, backgroundColor: "rgba(255,255,255,0.07)", marginVertical: 8 },

  settingsSubtitle: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 6,
    marginBottom: 8,
  },
  settingsMemory: {
    color: "#CBD5E1",
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: "rgba(255,255,255,0.04)",
    padding: 12,
    borderRadius: 10,
    minHeight: 50,
  },
  confidenceRow: { marginTop: 14 },
  confidenceLabel: { color: "#94A3B8", fontSize: 12, marginBottom: 6 },
  confidenceBar: {
    height: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  confidenceFill: {
    height: "100%",
    backgroundColor: "#FBBF24",
  },

  dangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(248,113,113,0.08)",
    borderColor: "rgba(248,113,113,0.3)",
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 6,
  },
  dangerBtnText: { color: "#F87171", fontWeight: "600", fontSize: 13 },
  dangerHint: {
    color: "#475569",
    fontSize: 11,
    textAlign: "center",
    marginTop: 6,
  },

  toggle: {
    width: 46,
    height: 28,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.1)",
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: "#FBBF24" },
  toggleKnob: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: "#E2E8F0",
  },
  toggleKnobOn: {
    backgroundColor: "#0B0F1A",
    transform: [{ translateX: 18 }],
  },

  recapCard: {
    backgroundColor: "#101622",
    borderRadius: 24,
    padding: 22,
    width: "100%",
    maxWidth: 420,
    minHeight: 160,
  },
  recapText: { color: "#E2E8F0", fontSize: 15, lineHeight: 22 },
});
