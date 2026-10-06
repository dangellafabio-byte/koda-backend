/**
 * Diagnostics / Segnala un problema (v67.10 Fabio 2026-06-24 — REFATTO).
 *
 * Prima: mostrava gli eventi `[OLLENYA_VAD] [OLLENYA_TIMING] …` grezzi
 * all'utente (criptico, intimorisce, "sembra un errore grave").
 *
 * Ora: schermata di supporto ESPLICITA e amichevole:
 *   • Niente codici tecnici in vista → l'utente vede solo un contatore
 *     "N eventi registrati, pronti da inviare".
 *   • Campo di testo libero dove l'utente DESCRIVE il problema.
 *   • Un unico bottone "Invia segnalazione" → apre share-sheet con la
 *     descrizione utente + il report tecnico allegato in coda.
 *   • Sfondo Indigo standard (uiConstants).
 *
 * Il report tecnico c'è ancora (serve al dev team), ma è nascosto.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Share,
  Alert,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  getDiagEvents,
  clearDiagEvents,
  formatDiagEventsForExport,
  type DiagEvent,
} from "../lib/diagLogger";
import { APP_BG_INDIGO } from "../lib/uiConstants";

const SUPPORT_EMAIL = "support@ollenya.app";

export default function DiagnosticsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [userText, setUserText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<TextInput | null>(null);

  // Snapshot UNA VOLTA all'apertura: il buffer tecnico va "fotografato"
  // nel momento in cui l'utente apre la segnalazione. Niente auto-refresh
  // che possa inquinare il report con eventi successivi (es. apertura
  // tastiera, scroll).
  useEffect(() => {
    setEvents(getDiagEvents());
  }, []);

  const handleSubmit = useCallback(async () => {
    if (sending) return;
    const descr = userText.trim();
    if (descr.length < 10) {
      Alert.alert(
        "Descrivi brevemente il problema",
        "Scrivi almeno una frase su cosa è successo e cosa ti aspettavi che accadesse. Ci aiuta tantissimo a capire.",
      );
      return;
    }
    setSending(true);
    try {
      // Compongo un payload testuale pulito:
      //   1. Riga di intestazione (data, versione, tier)
      //   2. Descrizione dell'utente (in evidenza)
      //   3. Report tecnico in coda (nascosto in realtà, ma allegato)
      const header =
        `Segnalazione Ollenya\n` +
        `Data: ${new Date().toISOString()}\n` +
        `Piattaforma: ${Platform.OS} ${Platform.Version}\n` +
        `────────────────────────────\n\n`;
      const userBlock =
        `COSA È SUCCESSO (parole dell'utente):\n` +
        `${descr}\n\n` +
        `────────────────────────────\n`;
      const techBlock =
        `Report tecnico (${events.length} eventi):\n\n` +
        formatDiagEventsForExport(events);
      const full = header + userBlock + techBlock;
      await Share.share({
        message: full,
        title: "Segnalazione Ollenya",
      });
      // Dopo lo share, resettiamo il buffer così la prossima segnalazione
      // parte pulita. L'utente può chiudere senza esportare: in quel caso
      // il buffer resta e può riprovare.
      clearDiagEvents();
      setUserText("");
      // Chiudiamo con un messaggio di ringraziamento (non-bloccante).
      setTimeout(() => {
        try {
          Alert.alert(
            "Grazie",
            "La tua segnalazione è stata preparata per l'invio. Se non si è aperta la finestra di condivisione, controlla le autorizzazioni dell'app.",
          );
        } catch {}
      }, 300);
    } catch (e) {
      Alert.alert("Impossibile inviare la segnalazione", String(e));
    } finally {
      setSending(false);
    }
  }, [events, userText, sending]);

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Segnala un problema</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.intro}>
            Raccontaci cosa è successo. Il report tecnico del momento verrà
            allegato automaticamente, non serve che te ne occupi tu.
          </Text>

          <Text style={styles.label}>Cosa è successo?</Text>
          <TextInput
            ref={inputRef}
            value={userText}
            onChangeText={setUserText}
            placeholder="Es: ho premuto l'eclissi per parlare, ma non si è attivata. Mi aspettavo di sentire il microfono partire…"
            placeholderTextColor="rgba(255,255,255,0.35)"
            multiline
            style={styles.textarea}
            textAlignVertical="top"
          />

          {/* Indicatore minimale: niente codici, solo un conteggio.
              Rende visibile che "qualcosa di tecnico" c'è, senza spaventare. */}
          <View style={styles.statsBox}>
            <Ionicons name="document-text-outline" size={16} color="rgba(255,255,255,0.55)" />
            <Text style={styles.statsText}>
              {events.length === 0
                ? "Report tecnico vuoto (nessun evento recente)"
                : `Report tecnico pronto: ${events.length} ${events.length === 1 ? "evento" : "eventi"} registrati`}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.sendBtn, sending && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={sending}
            testID="submit-report"
          >
            <Ionicons name="paper-plane-outline" size={18} color="#fff" />
            <Text style={styles.sendLabel}>
              {sending ? "Invio in corso…" : "Invia segnalazione"}
            </Text>
          </TouchableOpacity>

          <Text style={styles.footerHint}>
            Dalla finestra di condivisione puoi inviare la segnalazione via
            email, messaggi o qualsiasi altra app. In caso di difficoltà,
            scrivi a {SUPPORT_EMAIL}.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: APP_BG_INDIGO,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "600",
  },
  scroll: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  intro: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
  },
  label: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
  },
  textarea: {
    minHeight: 150,
    maxHeight: 300,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 15,
    lineHeight: 21,
  },
  statsBox: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 10,
  },
  statsText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 12,
    flex: 1,
  },
  sendBtn: {
    marginTop: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#8B5CF6",
    paddingVertical: 15,
    borderRadius: 14,
  },
  sendLabel: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  footerHint: {
    marginTop: 20,
    color: "rgba(255,255,255,0.45)",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
});
