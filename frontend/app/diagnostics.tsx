/**
 * Diagnostics screen — accessibile via /diagnostics (file-based routing).
 *
 * Mostra gli ultimi 500 eventi `[KODA_*]` catturati dal logger (vedi
 * `lib/diagLogger.ts`). Pensata per essere usata da utente reale:
 *   - "Copia" → copia tutto negli appunti → l'utente incolla in chat/email
 *   - "Condividi" → apre lo share sheet iOS/Android
 *   - "Pulisci" → svuota buffer (utile prima di riprodurre il bug)
 *
 * Stile minimale, monospace, niente fronzoli. È uno strumento di debug.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Share,
  Alert,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import {
  getDiagEvents,
  clearDiagEvents,
  formatDiagEventsForExport,
  type DiagEvent,
} from "../lib/diagLogger";

export default function DiagnosticsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  // Auto-refresh ogni 1s mentre la schermata è aperta. Costo trascurabile
  // (chiama getDiagEvents che è una slice del buffer).
  useEffect(() => {
    setEvents(getDiagEvents());
    const t = setInterval(() => {
      setEvents(getDiagEvents());
    }, 1000);
    return () => clearInterval(t);
  }, [refreshTick]);

  const handleCopy = useCallback(async () => {
    try {
      const txt = formatDiagEventsForExport(events);
      await Clipboard.setStringAsync(txt);
      Alert.alert("Copiato", `${events.length} eventi copiati negli appunti. Ora incollali pure nella chat o email.`);
    } catch (e) {
      Alert.alert("Errore copia", String(e));
    }
  }, [events]);

  const handleShare = useCallback(async () => {
    try {
      const txt = formatDiagEventsForExport(events);
      await Share.share({
        message: txt,
        title: "Koda diag log",
      });
    } catch (e) {
      Alert.alert("Errore condivisione", String(e));
    }
  }, [events]);

  const handleClear = useCallback(() => {
    Alert.alert(
      "Pulire il buffer?",
      "Cancellerà tutti gli eventi catturati finora. Utile prima di riprodurre un bug specifico per avere log puliti.",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Pulisci",
          style: "destructive",
          onPress: () => {
            clearDiagEvents();
            setRefreshTick((x) => x + 1);
          },
        },
      ],
    );
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Diagnostica</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.statsBar}>
        <Text style={styles.statsText}>
          {events.length} evento{events.length === 1 ? "" : "i"} catturati
        </Text>
        <Text style={styles.statsTextDim}>
          Cattura: [KODA_VAD] [KODA_TIMING] [KODA_SUMMARY]
        </Text>
      </View>

      <ScrollView
        style={styles.logScroll}
        contentContainerStyle={styles.logContent}
        showsVerticalScrollIndicator
      >
        {events.length === 0 ? (
          <Text style={styles.emptyText}>
            Nessun evento catturato.{"\n\n"}Apri il microfono o fai una conversazione, poi torna qui per vedere i log.
          </Text>
        ) : (
          events.map((ev, i) => (
            <Text
              key={`${ev.t}-${i}`}
              style={styles.logLine}
              selectable
            >
              {ev.line}
            </Text>
          ))
        )}
      </ScrollView>

      {/* === Link a Diagnostica VAD RIMOSSO (Fabio 2026-06-21) ===
          Il bottone "Diagnostica Neural VAD" è stato rimosso perché la pagina
          /diagnostics-vad importava @siteed/audio-studio + onnxruntime-react-native
          e crashava l'app su iOS dopo l'abbandono dell'approccio ONNX nativo.
          Il VAD ora gira lato server (Plan C, /api/vad/probe).
          Il file diagnostics-vad.tsx è conservato come .OLD-onnx.tsx.bak per
          riferimento futuro (eventuale migrazione TFLite). */}

      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={handleCopy}>
          <Ionicons name="copy-outline" size={18} color="#fff" />
          <Text style={styles.actionLabel}>Copia</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
          <Ionicons name="share-outline" size={18} color="#fff" />
          <Text style={styles.actionLabel}>Condividi</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={handleClear}>
          <Ionicons name="trash-outline" size={18} color="#ff8a8a" />
          <Text style={[styles.actionLabel, { color: "#ff8a8a" }]}>Pulisci</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
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
  statsBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#111",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
  },
  statsText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "500",
  },
  statsTextDim: {
    color: "#888",
    fontSize: 11,
    marginTop: 2,
  },
  // vadLinkBtn / vadLinkLabel rimossi insieme al bottone "Diagnostica Neural
  // VAD" (Fabio 2026-06-21). Mantenuti solo come reference storica nel commit.
  logScroll: {
    flex: 1,
    backgroundColor: "#000",
  },
  logContent: {
    padding: 12,
    paddingBottom: 24,
  },
  logLine: {
    color: "#aef",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 16,
    marginBottom: 4,
  },
  emptyText: {
    color: "#666",
    fontSize: 14,
    textAlign: "center",
    marginTop: 60,
    lineHeight: 22,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#222",
    backgroundColor: "#0a0a0a",
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    backgroundColor: "#222",
    borderRadius: 8,
    gap: 6,
  },
  dangerBtn: {
    backgroundColor: "#2a1414",
  },
  actionLabel: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "500",
  },
});
