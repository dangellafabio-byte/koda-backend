/**
 * === "I miei ricordi" (Memory Manager, Fabio 2026-08-25) ===
 *
 * UI unificata per il Blocco C/D/E del PRD "L'Amico Fraterno":
 *
 *   Blocco C: VISUALIZZAZIONE ricordi (concept + tag + emotion + importance)
 *   Blocco D: ELIMINAZIONE (singolo ricordo o wipe totale con doppia conferma)
 *   Blocco E: EXPORT (scarica JSON completo via expo-sharing / Web download)
 *
 * Filosofia:
 *   • L'utente ha diritto di sapere COSA Koda ricorda e di cancellarlo.
 *   • Nessun profiling psicologico: solo il testo del concept + i tag.
 *   • Design parallelo a /situations (stessa palette dark, stesse pillole).
 *   • Link discreto a /situations per l'inventario delle entità aggregate.
 *
 * API backend usate (già esistenti):
 *   • GET    /api/memories?limit=200         → lista
 *   • DELETE /api/memories/{id}              → cancella singolo
 *   • DELETE /api/memories                   → wipe totale
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { api } from "../lib/api";

// Tipo semantic memory allineato all'API
type Memory = {
  id: string;
  concept: string;
  tags: string[];
  emotion?: string | null;
  importance: number;
  source: "chat";
  created_at: string;
};

// Emoji per tono emotivo (uniforme con backend)
const EMOTION_EMOJI: Record<string, string> = {
  ansia: "😰",
  tristezza: "😢",
  gioia: "😊",
  rabbia: "😠",
  paura: "😨",
  serenità: "😌",
  confusione: "😕",
  tenerezza: "🤍",
  vergogna: "😳",
  sollievo: "😮‍💨",
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("it-IT", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function importanceDots(importance: number): string {
  const n = Math.max(1, Math.min(10, Math.round(importance)));
  const filled = Math.round((n / 10) * 5);
  return "●".repeat(filled) + "○".repeat(5 - filled);
}

export default function MemoriesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [items, setItems] = useState<Memory[]>([]);
  const [detailFor, setDetailFor] = useState<Memory | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listMemories(200);
      setItems((data.memories || []) as Memory[]);
    } catch (e) {
      console.warn("[memories] list failed:", e);
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const deleteOne = useCallback((m: Memory) => {
    Alert.alert(
      "Cancellare questo ricordo?",
      m.concept.length > 100 ? m.concept.slice(0, 100) + "…" : m.concept,
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Cancella",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteMemory(m.id);
              setItems((prev) => prev.filter((x) => x.id !== m.id));
              setDetailFor(null);
            } catch (e) {
              Alert.alert("Errore", "Impossibile cancellare il ricordo.");
            }
          },
        },
      ]
    );
  }, []);

  // Wipe totale con DOPPIA conferma (design GDPR-friendly)
  const wipeAll = useCallback(() => {
    Alert.alert(
      "Cancellare TUTTI i ricordi?",
      "Koda dimenticherà tutto quello che ha imparato da voi. Questa azione è irreversibile.",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Continua",
          style: "destructive",
          onPress: () => {
            // Seconda conferma: intenzionale, non un errore di tap
            Alert.alert(
              "Sei davvero sicuro?",
              "Ultima conferma: dopo il tocco, i ricordi saranno persi per sempre.",
              [
                { text: "No, lasciali", style: "cancel" },
                {
                  text: "Sì, cancella tutto",
                  style: "destructive",
                  onPress: async () => {
                    try {
                      const r = await api.clearMemories();
                      setItems([]);
                      setDetailFor(null);
                      Alert.alert(
                        "Fatto",
                        `Cancellati ${r.deleted} ricordi.`
                      );
                    } catch (e) {
                      Alert.alert("Errore", "Impossibile cancellare.");
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  }, []);

  // Blocco E: EXPORT JSON (client-side, non serve endpoint dedicato)
  const exportJson = useCallback(async () => {
    if (items.length === 0) {
      Alert.alert(
        "Niente da esportare",
        "Non ci sono ricordi da salvare."
      );
      return;
    }
    setExporting(true);
    try {
      const payload = {
        exported_at: new Date().toISOString(),
        app: "Koda",
        source: "memories",
        count: items.length,
        memories: items,
      };
      const json = JSON.stringify(payload, null, 2);

      if (Platform.OS === "web") {
        // Web: scarica come file
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `koda-ricordi-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        // Native: scrivi in cache + Sharing
        const stamp = new Date().toISOString().slice(0, 10);
        const fileUri = FileSystem.cacheDirectory + `koda-ricordi-${stamp}.json`;
        await FileSystem.writeAsStringAsync(fileUri, json, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/json",
            dialogTitle: "Esporta ricordi di Koda",
            UTI: "public.json",
          });
        } else {
          // Fallback: RN Share con testo (senza attachment)
          await Share.share({
            message: json.slice(0, 4000),
            title: "Ricordi di Koda",
          });
        }
      }
    } catch (e) {
      console.warn("[memories] export failed:", e);
      Alert.alert("Errore", "Impossibile esportare i ricordi.");
    } finally {
      setExporting(false);
    }
  }, [items]);

  const isEmpty = !loading && items.length === 0;

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const da = new Date(a.created_at).getTime();
      const db = new Date(b.created_at).getTime();
      return db - da;
    });
  }, [items]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={12}
          accessibilityLabel="Torna indietro"
          testID="memories-back"
        >
          <Ionicons
            name="chevron-back"
            size={26}
            color="rgba(226,232,240,0.9)"
          />
        </TouchableOpacity>
        <Text style={styles.title}>I miei ricordi</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Descrizione GDPR */}
      <Text style={styles.subtitle}>
        Qui trovi tutto quello che Koda ricorda di voi due — frasi che ha estratto
        dai vostri scambi. Sono tuoi: puoi esportarli, cancellarne uno singolo,
        oppure cancellarli tutti in un colpo solo.
      </Text>

      {/* Controls */}
      {items.length > 0 && (
        <View style={styles.controlsRow}>
          <TouchableOpacity
            onPress={exportJson}
            disabled={exporting}
            style={[styles.pillBtn, exporting && { opacity: 0.5 }]}
            testID="memories-export"
          >
            {exporting ? (
              <ActivityIndicator size="small" color="rgba(226,232,240,0.9)" />
            ) : (
              <Ionicons
                name="download-outline"
                size={14}
                color="rgba(226,232,240,0.9)"
              />
            )}
            <Text style={styles.pillBtnText}>
              {exporting ? "Esporto…" : "Esporta JSON"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => router.push("/situations")}
            style={styles.pillBtn}
            testID="memories-goto-situations"
          >
            <Ionicons
              name="git-network-outline"
              size={14}
              color="rgba(226,232,240,0.9)"
            />
            <Text style={styles.pillBtnText}>Vedi situazioni</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={wipeAll}
            style={[styles.pillBtn, styles.pillBtnDanger]}
            testID="memories-wipe"
          >
            <Ionicons
              name="trash-outline"
              size={14}
              color="rgba(252,165,165,0.9)"
            />
            <Text style={[styles.pillBtnText, { color: "rgba(252,165,165,0.9)" }]}>
              Cancella tutti
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Body */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="small" color="rgba(226,232,240,0.6)" />
        </View>
      ) : isEmpty ? (
        <View style={styles.center}>
          <Ionicons
            name="leaf-outline"
            size={40}
            color="rgba(226,232,240,0.3)"
          />
          <Text style={styles.emptyTitle}>Nessun ricordo, ancora.</Text>
          <Text style={styles.emptyBody}>
            Man mano che parlate, Koda comincerà a ricordare le cose che ti
            stanno a cuore. Compariranno qui.
          </Text>
          <TouchableOpacity
            onPress={() => router.push("/situations")}
            style={[styles.pillBtn, { marginTop: 20 }]}
          >
            <Ionicons
              name="git-network-outline"
              size={14}
              color="rgba(226,232,240,0.9)"
            />
            <Text style={styles.pillBtnText}>Vedi le situazioni</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="rgba(226,232,240,0.6)"
            />
          }
          testID="memories-list"
        >
          {sortedItems.map((m) => {
            const emoji = m.emotion ? EMOTION_EMOJI[m.emotion] || "" : "";
            return (
              <Pressable
                key={m.id}
                onPress={() => setDetailFor(m)}
                style={({ pressed }) => [
                  styles.itemCard,
                  pressed && styles.itemCardPressed,
                ]}
                testID={`memory-card-${m.id}`}
              >
                <View style={styles.itemHeader}>
                  {emoji ? <Text style={styles.itemIcon}>{emoji}</Text> : null}
                  <Text style={styles.itemTitle} numberOfLines={2}>
                    {m.concept}
                  </Text>
                </View>
                <View style={styles.itemMeta}>
                  <Text style={styles.itemMetaText}>
                    {formatDate(m.created_at)}
                  </Text>
                  <Text style={styles.itemMetaDot}>·</Text>
                  <Text style={styles.itemMetaText}>
                    {importanceDots(m.importance)}
                  </Text>
                </View>
                {m.tags && m.tags.length > 0 ? (
                  <View style={styles.tagRow}>
                    {m.tags.slice(0, 6).map((t, i) => (
                      <View key={`${m.id}-tag-${i}`} style={styles.tagChip}>
                        <Text style={styles.tagText}>#{t}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Detail modal */}
      <Modal
        transparent
        visible={detailFor !== null}
        animationType="slide"
        onRequestClose={() => setDetailFor(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setDetailFor(null)}
        >
          <Pressable
            style={[
              styles.sheet,
              { paddingBottom: Math.max(20, insets.bottom + 12) },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHandle} />
            {detailFor && (
              <>
                <View style={styles.sheetHeader}>
                  {detailFor.emotion ? (
                    <Text style={styles.sheetIcon}>
                      {EMOTION_EMOJI[detailFor.emotion] || "🤍"}
                    </Text>
                  ) : (
                    <Ionicons
                      name="bookmark"
                      size={22}
                      color="rgba(196,181,253,0.9)"
                    />
                  )}
                  <Text style={styles.sheetTitle}>Ricordo</Text>
                </View>
                <ScrollView style={{ maxHeight: 240 }}>
                  <Text style={styles.detailConcept}>{detailFor.concept}</Text>
                  <Text style={styles.detailMeta}>
                    Salvato il {formatDate(detailFor.created_at)}
                    {"  ·  "}
                    Importanza {detailFor.importance}/10
                    {detailFor.emotion ? `  ·  ${detailFor.emotion}` : ""}
                  </Text>
                  {detailFor.tags && detailFor.tags.length > 0 && (
                    <View style={styles.tagRow}>
                      {detailFor.tags.map((t, i) => (
                        <View
                          key={`detail-tag-${i}`}
                          style={styles.tagChip}
                        >
                          <Text style={styles.tagText}>#{t}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </ScrollView>

                <View style={styles.sheetActionRow}>
                  <TouchableOpacity
                    style={[styles.sheetActionBtn, styles.sheetActionDanger]}
                    onPress={() => deleteOne(detailFor)}
                    testID="memory-detail-delete"
                  >
                    <Ionicons
                      name="trash-outline"
                      size={16}
                      color="rgba(252,165,165,0.9)"
                    />
                    <Text
                      style={[
                        styles.sheetActionText,
                        { color: "rgba(252,165,165,0.95)" },
                      ]}
                    >
                      Cancella
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.sheetActionBtn}
                    onPress={() => setDetailFor(null)}
                  >
                    <Ionicons
                      name="close"
                      size={16}
                      color="rgba(226,232,240,0.9)"
                    />
                    <Text style={styles.sheetActionText}>Chiudi</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0b0f1a",
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: "rgba(226,232,240,0.95)",
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  subtitle: {
    color: "rgba(226,232,240,0.65)",
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 4,
    marginTop: 4,
    marginBottom: 14,
  },
  controlsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  pillBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.15)",
    backgroundColor: "rgba(226,232,240,0.05)",
  },
  pillBtnDanger: {
    borderColor: "rgba(252,165,165,0.3)",
    backgroundColor: "rgba(252,165,165,0.05)",
  },
  pillBtnText: {
    color: "rgba(226,232,240,0.9)",
    fontSize: 12,
    fontWeight: "500",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: "rgba(226,232,240,0.85)",
    fontSize: 16,
    fontWeight: "500",
    marginTop: 12,
    textAlign: "center",
  },
  emptyBody: {
    color: "rgba(226,232,240,0.55)",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 6,
    maxWidth: 320,
  },
  list: {
    flex: 1,
  },
  itemCard: {
    backgroundColor: "rgba(226,232,240,0.05)",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.08)",
  },
  itemCardPressed: {
    backgroundColor: "rgba(226,232,240,0.09)",
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  itemIcon: {
    fontSize: 18,
  },
  itemTitle: {
    flex: 1,
    color: "rgba(226,232,240,0.95)",
    fontSize: 14.5,
    fontWeight: "500",
    lineHeight: 20,
  },
  itemMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  itemMetaText: {
    color: "rgba(226,232,240,0.5)",
    fontSize: 12,
  },
  itemMetaDot: {
    color: "rgba(226,232,240,0.4)",
    fontSize: 12,
  },
  tagRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 8,
    flexWrap: "wrap",
  },
  tagChip: {
    backgroundColor: "rgba(139,92,246,0.15)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    color: "rgba(196,181,253,0.9)",
    fontSize: 11,
    fontWeight: "500",
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#111827",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 8,
    minHeight: 220,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: "rgba(226,232,240,0.2)",
    marginBottom: 10,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  sheetIcon: {
    fontSize: 24,
  },
  sheetTitle: {
    flex: 1,
    color: "rgba(226,232,240,0.95)",
    fontSize: 18,
    fontWeight: "600",
  },
  detailConcept: {
    color: "rgba(226,232,240,0.95)",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  detailMeta: {
    color: "rgba(226,232,240,0.55)",
    fontSize: 12,
    marginBottom: 8,
  },
  sheetActionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
  },
  sheetActionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.12)",
    backgroundColor: "rgba(226,232,240,0.04)",
  },
  sheetActionDanger: {
    borderColor: "rgba(252,165,165,0.25)",
    backgroundColor: "rgba(252,165,165,0.05)",
  },
  sheetActionText: {
    color: "rgba(226,232,240,0.9)",
    fontSize: 13,
    fontWeight: "500",
  },
});
