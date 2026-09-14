/**
 * /blind-test — Pagina blind test TTS Cielo (A vs B)
 * ===================================================
 * Fabio 2026-09-10, Piano B (Kyutai-first ridotto).
 *
 * FLOW:
 *   1. Tester inserisce email + nome → POST /api/blind-test/session
 *   2. GET /api/blind-test/next-pair → riceve coppia A/B randomizzata (blind)
 *   3. Ascolta clip A e clip B, vota rating 1-10 per ciascuna + preferenza
 *   4. POST /api/blind-test/vote → salva
 *   5. Loop finché finiscono 34 frasi → screen "Grazie, completato"
 *
 * ZERO INFO SUGGESTIVE: nessuna label engine ("V3", "Kyutai"), nessun logo,
 * nessuna hint. Solo "Clip A" e "Clip B" + il testo della frase.
 *
 * Il tester può ricaricare a metà — riprende dalla frase successiva.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useAudioPlayer } from "expo-audio";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BACKEND } from "../lib/api";

type Stage = "intake" | "loading" | "voting" | "completed";

interface Pair {
  phrase_id: string;
  phrase_text: string;
  category: string;
  clip_a_url: string;
  clip_b_url: string;
  remaining: number;
  total: number;
}

async function api<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${BACKEND}${path}`;
  const resp = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${resp.status}: ${detail || resp.statusText}`);
  }
  return (await resp.json()) as T;
}

export default function BlindTestScreen() {
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<Stage>("intake");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pretestOnly, setPretestOnly] = useState(false);
  const [pair, setPair] = useState<Pair | null>(null);
  const [ratingNaturalnessA, setRatingNaturalnessA] = useState<number | null>(null);
  const [ratingNaturalnessB, setRatingNaturalnessB] = useState<number | null>(null);
  const [ratingSimilarityA, setRatingSimilarityA] = useState<number | null>(null);
  const [ratingSimilarityB, setRatingSimilarityB] = useState<number | null>(null);
  const [ratingDesirabilityA, setRatingDesirabilityA] = useState<number | null>(null);
  const [ratingDesirabilityB, setRatingDesirabilityB] = useState<number | null>(null);
  const [preferred, setPreferred] = useState<"A" | "B" | "TIE" | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [urlA, setUrlA] = useState<string>("");
  const [urlB, setUrlB] = useState<string>("");
  const playerA = useAudioPlayer(urlA || null);
  const playerB = useAudioPlayer(urlB || null);
  const activePlayerRef = useRef<"A" | "B" | null>(null);

  const loadNext = useCallback(async (sid: string) => {
    setStage("loading");
    try {
      const p = await api<Pair>(
        `/api/blind-test/next-pair?session_id=${encodeURIComponent(sid)}`
      );
      // Attach base URL to clip paths
      setPair(p);
      setUrlA(`${BACKEND}${p.clip_a_url}`);
      setUrlB(`${BACKEND}${p.clip_b_url}`);
      setRatingNaturalnessA(null);
      setRatingNaturalnessB(null);
      setRatingSimilarityA(null);
      setRatingSimilarityB(null);
      setRatingDesirabilityA(null);
      setRatingDesirabilityB(null);
      setPreferred(null);
      setNotes("");
      setStage("voting");
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("404") && msg.includes("completed")) {
        setStage("completed");
        return;
      }
      Alert.alert("Errore caricamento", msg);
      setStage("intake");
    }
  }, []);

  const onStart = async () => {
    if (!email.trim() || !email.includes("@")) {
      Alert.alert("Email richiesta", "Inserisci una email valida.");
      return;
    }
    setStage("loading");
    try {
      const r = await api<{ session_id: string; phrases_remaining: number; resumed: boolean }>(
        `/api/blind-test/session`,
        {
          method: "POST",
          body: JSON.stringify({
            tester_email: email.trim(),
            tester_name: name.trim() || undefined,
            device_info: `${navigatorLike()}`,
            pretest_only: pretestOnly,
          }),
        }
      );
      if (r.phrases_remaining <= 0) {
        setStage("completed");
        return;
      }
      setSessionId(r.session_id);
      loadNext(r.session_id);
    } catch (e: any) {
      Alert.alert("Errore inizio sessione", String(e?.message || e));
      setStage("intake");
    }
  };

  const stopAll = useCallback(() => {
    try {
      playerA.pause();
    } catch {}
    try {
      playerB.pause();
    } catch {}
    activePlayerRef.current = null;
  }, [playerA, playerB]);

  const play = (which: "A" | "B") => {
    stopAll();
    const p = which === "A" ? playerA : playerB;
    try {
      p.seekTo(0);
      p.play();
      activePlayerRef.current = which;
    } catch (e) {
      Alert.alert("Playback error", String(e));
    }
  };

  const submitVote = async () => {
    if (!sessionId || !pair) return;
    if (
      ratingNaturalnessA == null ||
      ratingNaturalnessB == null ||
      ratingSimilarityA == null ||
      ratingSimilarityB == null ||
      ratingDesirabilityA == null ||
      ratingDesirabilityB == null ||
      preferred == null
    ) {
      Alert.alert(
        "Voto incompleto",
        "Assegna un valore a tutte e 6 le valutazioni (3 per Clip A, 3 per Clip B) e scegli la preferita."
      );
      return;
    }
    setSubmitting(true);
    stopAll();
    try {
      await api(`/api/blind-test/vote`, {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          phrase_id: pair.phrase_id,
          naturalness_a: ratingNaturalnessA,
          naturalness_b: ratingNaturalnessB,
          similarity_a: ratingSimilarityA,
          similarity_b: ratingSimilarityB,
          desirability_a: ratingDesirabilityA,
          desirability_b: ratingDesirabilityB,
          preferred,
          notes: notes.trim() || undefined,
        }),
      });
      loadNext(sessionId);
    } catch (e: any) {
      Alert.alert("Errore invio voto", String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    return () => stopAll();
  }, [stopAll]);

  // ============ RENDER ============

  if (stage === "intake") {
    return (
      <ScrollView
        style={styles.wrap}
        contentContainerStyle={[styles.wrapContent, { paddingTop: insets.top + 20 }]}
      >
        <Text style={styles.title}>Blind Test Cielo</Text>
        <Text style={styles.subtitle}>
          Ci servono 10-15 minuti del tuo tempo per valutare due versioni
          della voce di Ollenya. Non ti diremo quale è quale — vogliamo il tuo
          giudizio onesto.
        </Text>
        <View style={styles.card}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="tua@email.it"
            placeholderTextColor="#525252"
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />
          <Text style={styles.label}>Nome (facoltativo)</Text>
          <TextInput
            style={styles.input}
            placeholder="Come vuoi essere chiamata/o"
            placeholderTextColor="#525252"
            value={name}
            onChangeText={setName}
          />
          {/* Toggle Gate 1 pretest — visibile solo ad admin per efficienza */}
          <TouchableOpacity
            style={styles.toggleRow}
            onPress={() => setPretestOnly((v) => !v)}
            accessibilityRole="switch"
          >
            <View
              style={[
                styles.toggleBox,
                pretestOnly && styles.toggleBoxActive,
              ]}
            >
              {pretestOnly && <Text style={styles.toggleTick}>✓</Text>}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>
                Modalità pre-test Gate 1 (solo 5 frasi)
              </Text>
              <Text style={styles.toggleHint}>
                Uso interno: valutazione tecnica veloce prima di reclutare
                tester esterni.
              </Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={onStart}>
            <Text style={styles.primaryBtnText}>Inizia</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.footer}>
          Puoi interrompere quando vuoi e riprendere in seguito con la stessa email.
        </Text>
      </ScrollView>
    );
  }

  if (stage === "loading") {
    return (
      <View style={[styles.wrap, styles.centered]}>
        <ActivityIndicator size="large" color="#60a5fa" />
      </View>
    );
  }

  if (stage === "completed") {
    return (
      <View style={[styles.wrap, styles.centered, { paddingTop: insets.top + 20 }]}>
        <Text style={styles.title}>Grazie</Text>
        <Text style={[styles.subtitle, { textAlign: "center", marginTop: 16 }]}>
          Hai completato il blind test.{"\n"}Il tuo feedback ci aiuta a decidere
          la voce definitiva di Ollenya.
        </Text>
      </View>
    );
  }

  // stage === "voting"
  if (!pair) return null;
  const progressPct = Math.round(
    ((pair.total - pair.remaining + 1) / pair.total) * 100
  );

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={[styles.wrapContent, { paddingTop: insets.top + 16 }]}
    >
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
      </View>
      <Text style={styles.progressText}>
        Frase {pair.total - pair.remaining + 1} di {pair.total} · {pair.category}
      </Text>

      <View style={styles.phraseCard}>
        <Text style={styles.phraseLabel}>Testo pronunciato</Text>
        <Text style={styles.phraseText}>{`"${pair.phrase_text}"`}</Text>
      </View>

      {/* CLIP A */}
      <View style={styles.clipCard}>
        <View style={styles.clipHeader}>
          <Text style={styles.clipLabel}>Clip A</Text>
          <TouchableOpacity
            style={styles.playBtn}
            onPress={() => play("A")}
          >
            <Text style={styles.playBtnText}>▶ Ascolta</Text>
          </TouchableOpacity>
        </View>
        <RatingBlock
          title="Naturalezza"
          hint="Suona come una persona vera? (1 = robotica, 10 = umana)"
          value={ratingNaturalnessA}
          onChange={setRatingNaturalnessA}
        />
        <RatingBlock
          title="Somiglianza a Cielo"
          hint="Riconosceresti Cielo in questa voce? (1 = un'altra persona, 10 = identica)"
          value={ratingSimilarityA}
          onChange={setRatingSimilarityA}
        />
        <RatingBlock
          title="Desiderabilità conversazione lunga"
          hint="Ci parleresti a lungo? (1 = spegnerei subito, 10 = ci passerei ore)"
          value={ratingDesirabilityA}
          onChange={setRatingDesirabilityA}
        />
      </View>

      {/* CLIP B */}
      <View style={styles.clipCard}>
        <View style={styles.clipHeader}>
          <Text style={styles.clipLabel}>Clip B</Text>
          <TouchableOpacity
            style={styles.playBtn}
            onPress={() => play("B")}
          >
            <Text style={styles.playBtnText}>▶ Ascolta</Text>
          </TouchableOpacity>
        </View>
        <RatingBlock
          title="Naturalezza"
          hint="Suona come una persona vera? (1 = robotica, 10 = umana)"
          value={ratingNaturalnessB}
          onChange={setRatingNaturalnessB}
        />
        <RatingBlock
          title="Somiglianza a Cielo"
          hint="Riconosceresti Cielo in questa voce? (1 = un'altra persona, 10 = identica)"
          value={ratingSimilarityB}
          onChange={setRatingSimilarityB}
        />
        <RatingBlock
          title="Desiderabilità conversazione lunga"
          hint="Ci parleresti a lungo? (1 = spegnerei subito, 10 = ci passerei ore)"
          value={ratingDesirabilityB}
          onChange={setRatingDesirabilityB}
        />
      </View>

      {/* PREFERENZA */}
      <View style={styles.prefCard}>
        <Text style={styles.prefLabel}>Quale preferisci per Ollenya?</Text>
        <View style={styles.prefRow}>
          {(["A", "B", "TIE"] as const).map((v) => (
            <TouchableOpacity
              key={v}
              style={[
                styles.prefBtn,
                preferred === v && styles.prefBtnActive,
              ]}
              onPress={() => setPreferred(v)}
            >
              <Text
                style={[
                  styles.prefBtnText,
                  preferred === v && styles.prefBtnTextActive,
                ]}
              >
                {v === "TIE" ? "Uguali" : v}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.notesCard}>
        <Text style={styles.notesLabel}>Note (opzionale)</Text>
        <TextInput
          style={styles.notesInput}
          placeholder="Cosa ti ha colpito? Difetti percepiti?"
          placeholderTextColor="#525252"
          value={notes}
          onChangeText={setNotes}
          multiline
          maxLength={500}
        />
      </View>

      <TouchableOpacity
        style={[styles.primaryBtn, submitting && { opacity: 0.5 }]}
        onPress={submitVote}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#0a0a0a" />
        ) : (
          <Text style={styles.primaryBtnText}>Invia voto e continua</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

function RatingBlock({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.ratingBlockTitle}>{title}</Text>
      <Text style={styles.ratingHint}>{hint}</Text>
      <RatingRow value={value} onChange={onChange} />
    </View>
  );
}

function RatingRow({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.ratingRow}>
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <TouchableOpacity
          key={n}
          style={[styles.ratingCell, value === n && styles.ratingCellActive]}
          onPress={() => onChange(n)}
        >
          <Text
            style={[
              styles.ratingCellText,
              value === n && styles.ratingCellTextActive,
            ]}
          >
            {n}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function navigatorLike(): string {
  try {
    // @ts-ignore
    return `${(globalThis as any).navigator?.userAgent || "unknown-device"}`;
  } catch {
    return "unknown-device";
  }
}

// Colori hardcoded: pagina blind test, no dependency dal theme dell'app.
const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  wrapContent: {
    paddingHorizontal: 18,
    paddingBottom: 40,
  },
  centered: {
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    color: "#ffffff",
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    color: "#a3a3a3",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
  },
  card: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
  },
  label: {
    color: "#a3a3a3",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: "#262626",
    color: "#ffffff",
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 4,
  },
  primaryBtn: {
    marginTop: 20,
    height: 52,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#0a0a0a",
    fontSize: 16,
    fontWeight: "700",
  },
  footer: {
    color: "#737373",
    fontSize: 12,
    textAlign: "center",
    marginTop: 12,
  },
  progressBar: {
    height: 4,
    backgroundColor: "#262626",
    borderRadius: 2,
    overflow: "hidden",
    marginBottom: 6,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#60a5fa",
  },
  progressText: {
    color: "#a3a3a3",
    fontSize: 12,
    textAlign: "center",
    marginBottom: 16,
  },
  phraseCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  phraseLabel: {
    color: "#a3a3a3",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  phraseText: {
    color: "#ffffff",
    fontSize: 17,
    lineHeight: 24,
    fontStyle: "italic",
  },
  clipCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 14,
  },
  clipHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  clipLabel: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "600",
  },
  playBtn: {
    height: 40,
    paddingHorizontal: 20,
    backgroundColor: "#60a5fa",
    borderRadius: 8,
    justifyContent: "center",
  },
  playBtnText: {
    color: "#0a0a0a",
    fontSize: 14,
    fontWeight: "600",
  },
  ratingHint: {
    color: "#737373",
    fontSize: 11,
    marginTop: 2,
    marginBottom: 6,
  },
  ratingBlockTitle: {
    color: "#e5e5e5",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 2,
  },
  ratingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  ratingCell: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: "#262626",
    justifyContent: "center",
    alignItems: "center",
  },
  ratingCellActive: {
    backgroundColor: "#60a5fa",
  },
  ratingCellText: {
    color: "#d4d4d4",
    fontSize: 13,
    fontWeight: "600",
  },
  ratingCellTextActive: {
    color: "#0a0a0a",
  },
  prefCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
    marginBottom: 14,
  },
  prefLabel: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "500",
    marginBottom: 12,
  },
  prefRow: {
    flexDirection: "row",
    gap: 10,
  },
  prefBtn: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    backgroundColor: "#262626",
    justifyContent: "center",
    alignItems: "center",
  },
  prefBtnActive: {
    backgroundColor: "#4ade80",
  },
  prefBtnText: {
    color: "#d4d4d4",
    fontSize: 15,
    fontWeight: "600",
  },
  prefBtnTextActive: {
    color: "#0a0a0a",
  },
  notesCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 14,
  },
  notesLabel: {
    color: "#a3a3a3",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  notesInput: {
    backgroundColor: "#262626",
    color: "#ffffff",
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 72,
    textAlignVertical: "top",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 16,
    gap: 12,
  },
  toggleBox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: "#525252",
    backgroundColor: "#0a0a0a",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 2,
  },
  toggleBoxActive: {
    backgroundColor: "#60a5fa",
    borderColor: "#60a5fa",
  },
  toggleTick: {
    color: "#0a0a0a",
    fontSize: 15,
    fontWeight: "700",
  },
  toggleLabel: {
    color: "#e5e5e5",
    fontSize: 14,
    fontWeight: "500",
  },
  toggleHint: {
    color: "#737373",
    fontSize: 12,
    marginTop: 2,
  },
});
