/**
 * Persona Test — schermata temporanea di debug.
 *
 * Elenca gli 11 turni di test conversazionale in fase AMICHEVOLE
 * (confidence_level=35) generati offline via /api/converse e TTS Cielo.
 * Ogni riga mostra prompt utente, risposta Koda, e un pulsante Play che
 * riproduce l'MP3 (voce Cielo) generato per quella risposta.
 *
 * Scopo: permettere l'ascolto reale delle 11 risposte con la stessa voce
 * che l'utente sente in produzione, per il giudizio "persona vs sistema
 * che ha scelto una modalità".
 *
 * Da rimuovere dopo la validazione.
 */
import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";

type TestRow = {
  i: number;
  prompt: string;
  response: string;
  tone: string;
  chars: number;
  clip: any; // require(...)
};

const ROWS: TestRow[] = [
  {
    i: 1,
    prompt: "Non lo so.",
    response: "Ehi, aspetta. 'Non lo so' a cosa? Dimmi un po' quello che ti passa per la testa.",
    tone: "warm",
    chars: 80,
    clip: require("../assets/persona-test/01.mp3"),
  },
  {
    i: 2,
    prompt: "Sono felicissimo cazzo.",
    response: "Eeeh, allora! Che è successo? Dimmi tutto.",
    tone: "energetic",
    chars: 42,
    clip: require("../assets/persona-test/02.mp3"),
  },
  {
    i: 3,
    prompt: "Ho litigato con mia madre.",
    response: "Uh, dopo essere felicissimo? Cos'è successo tra voi due?",
    tone: "concerned",
    chars: 56,
    clip: require("../assets/persona-test/03.mp3"),
  },
  {
    i: 4,
    prompt: "Boh.",
    response:
      "Fabio, aspetta. Una cosa bella e poi una cosa pesante con tua madre… tutto insieme. Non è facile tenere insieme questi pezzi. Vuoi provare a dirmi cosa è successo nel litigio, o è ancora tutto un po' confuso?",
    tone: "calm",
    chars: 208,
    clip: require("../assets/persona-test/04.mp3"),
  },
  {
    i: 5,
    prompt: "Sai che mi è successa una cosa assurda?",
    response: "Sì, dimmi. Sono tutta orecchi.",
    tone: "warm",
    chars: 30,
    clip: require("../assets/persona-test/05.mp3"),
  },
  {
    i: 6,
    prompt: "Non ho voglia di parlare.",
    response: "Ok. Non c'è fretta. Sono qui quando sei pronto.",
    tone: "calm",
    chars: 47,
    clip: require("../assets/persona-test/06.mp3"),
  },
  {
    i: 7,
    prompt: "Secondo te sto facendo una cazzata?",
    response:
      "Eh, non lo so ancora. Tu senti che stai facendo una cazzata, o è qualcun altro che te lo fa pensare?",
    tone: "calm",
    chars: 100,
    clip: require("../assets/persona-test/07.mp3"),
  },
  {
    i: 8,
    prompt: "Mi manca.",
    response: "Mhm. Chi ti manca, Fabio?",
    tone: "calm",
    chars: 25,
    clip: require("../assets/persona-test/08.mp3"),
  },
  {
    i: 9,
    prompt: "Guarda che giornata di merda.",
    response: "Eh, mi dispiace. Vuoi raccontarmi com'è andata?",
    tone: "concerned",
    chars: 47,
    clip: require("../assets/persona-test/09.mp3"),
  },
  {
    i: 10,
    prompt: "Ho appena conosciuto una ragazza.",
    response: "Eh, allora è successo oggi. Come vi siete conosciuti?",
    tone: "warm",
    chars: 53,
    clip: require("../assets/persona-test/10.mp3"),
  },
  {
    i: 11,
    prompt: "Lascia stare, non voglio parlarne.",
    response: "Ok, va bene. Sono qui se cambi idea, senza fretta.",
    tone: "calm",
    chars: 50,
    clip: require("../assets/persona-test/11.mp3"),
  },
];

const TONE_COLOR: Record<string, string> = {
  warm: "#F5B872",
  energetic: "#FF7A5C",
  concerned: "#8FA7C4",
  calm: "#7FB69E",
  gentle: "#B99AD1",
  playful: "#F0C34F",
  thoughtful: "#A8B5C8",
};

export default function PersonaTestScreen() {
  const insets = useSafeAreaInsets();
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const finishRef = useRef<any>(null);

  useEffect(() => {
    // Force speaker output (playback mode)
    (async () => {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: false,
          interruptionMode: "duckOthers",
          shouldRouteThroughEarpiece: false,
        });
      } catch {}
    })();
    return () => {
      try {
        playerRef.current?.remove?.();
      } catch {}
      if (finishRef.current) {
        try { finishRef.current.remove?.(); } catch {}
      }
    };
  }, []);

  const play = (row: TestRow) => {
    // Stop current
    try {
      playerRef.current?.remove?.();
      playerRef.current = null;
    } catch {}
    if (finishRef.current) {
      try { finishRef.current.remove?.(); } catch {}
      finishRef.current = null;
    }
    if (playingIdx === row.i) {
      // Toggle: was playing this → stop
      setPlayingIdx(null);
      return;
    }
    try {
      const player = createAudioPlayer(row.clip, { updateInterval: 200 });
      playerRef.current = player;
      setPlayingIdx(row.i);
      const sub = player.addListener("playbackStatusUpdate", (status: any) => {
        if (status?.didJustFinish) {
          try { sub.remove?.(); } catch {}
          try { player.remove?.(); } catch {}
          if (playerRef.current === player) playerRef.current = null;
          setPlayingIdx((cur) => (cur === row.i ? null : cur));
        }
      });
      finishRef.current = sub;
      player.play();
    } catch (e) {
      console.warn("[persona-test] play failed:", e);
      setPlayingIdx(null);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Persona test</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <Text style={styles.subtitle}>
          11 risposte generate offline via /api/converse in fase AMICHEVOLE
          (confidence_level=35). Voce TTS: Cielo. Turni consecutivi, stessa sessione.
        </Text>

        {ROWS.map((row) => {
          const active = playingIdx === row.i;
          return (
            <View key={row.i} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.rowNum}>{row.i.toString().padStart(2, "0")}</Text>
                <View style={[styles.toneBadge, { borderColor: TONE_COLOR[row.tone] || "#666" }]}>
                  <Text style={[styles.toneText, { color: TONE_COLOR[row.tone] || "#aaa" }]}>{row.tone}</Text>
                </View>
                <Text style={styles.charsBadge}>{row.chars}c</Text>
              </View>
              <Text style={styles.promptLabel}>Utente</Text>
              <Text style={styles.promptText}>{row.prompt}</Text>
              <Text style={styles.responseLabel}>Koda</Text>
              <Text style={styles.responseText}>{row.response}</Text>
              <TouchableOpacity
                style={[styles.playBtn, active && styles.playBtnActive]}
                onPress={() => play(row)}
                activeOpacity={0.75}
              >
                <Ionicons name={active ? "stop" : "play"} size={18} color="#fff" />
                <Text style={styles.playText}>{active ? "Stop" : "Ascolta"}</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B0B10",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a34",
  },
  title: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "600",
  },
  subtitle: {
    color: "#8b8b98",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 20,
    marginTop: 4,
  },
  card: {
    backgroundColor: "#15151d",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2a2a34",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  rowNum: {
    color: "#5f5f6c",
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    marginRight: 10,
  },
  toneBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 8,
  },
  toneText: {
    fontSize: 11,
    letterSpacing: 0.2,
  },
  charsBadge: {
    color: "#5f5f6c",
    fontSize: 11,
    marginLeft: "auto",
  },
  promptLabel: {
    color: "#5f5f6c",
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: 2,
    marginBottom: 3,
  },
  promptText: {
    color: "#c8c8d4",
    fontSize: 14,
    lineHeight: 20,
    fontStyle: "italic",
    marginBottom: 8,
  },
  responseLabel: {
    color: "#5f5f6c",
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  responseText: {
    color: "#e8e8ee",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  playBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2a2a34",
    borderRadius: 999,
    paddingVertical: 10,
    gap: 8,
  },
  playBtnActive: {
    backgroundColor: "#7A5CFF",
  },
  playText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
});
