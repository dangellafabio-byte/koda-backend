/**
 * === "Vedi cosa Koda ricorda" (Situation Tracking Viewer, Fabio 2026-08-22) ===
 *
 * Schermata GDPR-compliant per il Situation Tracking V3.1.
 * Rispetta le invarianti core del design (spec Fabio, agosto 2026):
 *
 *   • Nessun psychological profiling: mostriamo solo entità osservate
 *     dal ledger (persone, topic, situazioni) — no scoring, no trend,
 *     no valutazioni emotive, no "diagnosi".
 *   • Opt-in strict: se il toggle è OFF, mostriamo solo un messaggio
 *     invito a riattivare (nessuna lista fantasma).
 *   • Wipe completo idempotente: bottone "Cancella tutto" chiede
 *     conferma e chiama /api/situations/wipe (funziona anche se opt-in OFF).
 *   • Azioni granulari: mute (Koda non ne parla più), archive (nascosta
 *     dalla vista principale ma non cancellata), delete (hard delete
 *     situation + evidences).
 *   • Dettaglio: tap su una situation apre bottom sheet con le ultime
 *     20 evidence (estratti brevi, source pipeline, timestamp).
 *
 * Accessibile SEMPRE (non riservato admin) — è la UI GDPR standard.
 * Il bottone "Esporta situazioni" (JSON) è separato e vive in Impostazioni,
 * visibile solo admin.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../lib/api";

type Situation = Awaited<ReturnType<typeof api.situationsList>>["situations"][number];
type SituationDetail = Awaited<ReturnType<typeof api.situationGet>>;

const ENTITY_ICON: Record<string, string> = {
  person: "👤",
  topic: "🏷️",
  situation: "🧩",
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function SituationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [items, setItems] = useState<Situation[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [detailFor, setDetailFor] = useState<SituationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.situationsList({ limit: 100, includeArchived });
      setEnabled(data.enabled);
      setItems(data.situations || []);
    } catch (e) {
      console.warn("[situations] list failed:", e);
      setEnabled(false);
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const d = await api.situationGet(id, 20);
      setDetailFor(d);
    } catch (e) {
      Alert.alert("Errore", "Impossibile aprire il dettaglio.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const toggleMute = useCallback(
    async (s: Situation) => {
      const nextMuted = !s.user_muted;
      try {
        await api.situationPatch(s.id, { user_muted: nextMuted });
        setItems((prev) =>
          prev.map((x) => (x.id === s.id ? { ...x, user_muted: nextMuted } : x))
        );
        if (detailFor?.situation.id === s.id) {
          setDetailFor({
            ...detailFor,
            situation: { ...detailFor.situation, user_muted: nextMuted },
          });
        }
      } catch (e) {
        Alert.alert("Errore", "Impossibile aggiornare.");
      }
    },
    [detailFor]
  );

  const toggleArchive = useCallback(
    async (s: Situation) => {
      const nextArchived = !s.archived_at;
      try {
        await api.situationPatch(s.id, { archived: nextArchived });
        // Se abbiamo archiviato e non stiamo mostrando archiviate → rimuovi
        if (nextArchived && !includeArchived) {
          setItems((prev) => prev.filter((x) => x.id !== s.id));
        } else {
          setItems((prev) =>
            prev.map((x) =>
              x.id === s.id
                ? {
                    ...x,
                    archived_at: nextArchived ? new Date().toISOString() : null,
                  }
                : x
            )
          );
        }
        setDetailFor(null);
      } catch (e) {
        Alert.alert("Errore", "Impossibile aggiornare.");
      }
    },
    [includeArchived]
  );

  const deleteOne = useCallback((s: Situation) => {
    Alert.alert(
      "Cancellare “" + s.title + "”?",
      "Rimuove la voce e tutte le sue tracce (evidenze). Questa azione è irreversibile.",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Cancella",
          style: "destructive",
          onPress: async () => {
            try {
              await api.situationDelete(s.id);
              setItems((prev) => prev.filter((x) => x.id !== s.id));
              setDetailFor(null);
            } catch (e) {
              Alert.alert("Errore", "Impossibile cancellare.");
            }
          },
        },
      ]
    );
  }, []);

  const wipeAll = useCallback(() => {
    Alert.alert(
      "Cancellare tutto ciò che Koda ricorda?",
      "Cancellerà tutte le voci e tutte le evidenze. Non si può annullare.",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Cancella tutto",
          style: "destructive",
          onPress: async () => {
            try {
              await api.situationsWipe();
              setItems([]);
              setDetailFor(null);
            } catch (e) {
              Alert.alert("Errore", "Impossibile cancellare.");
            }
          },
        },
      ]
    );
  }, []);

  const emptyOptIn = !enabled;
  const emptyList = !loading && enabled && items.length === 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={12}
          accessibilityLabel="Torna indietro"
          testID="situations-back"
        >
          <Ionicons name="chevron-back" size={26} color="rgba(226,232,240,0.9)" />
        </TouchableOpacity>
        <Text style={styles.title}>Cosa Koda ricorda</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Descrizione GDPR — sempre visibile */}
      <Text style={styles.subtitle}>
        Qui vedi le cose che Koda ha memorizzato dalle vostre conversazioni.
        Niente valutazioni psicologiche, niente giudizi — solo un elenco di
        persone, argomenti e situazioni che sono emersi. Puoi silenziare,
        archiviare o cancellare quello che vuoi.
      </Text>

      {/* Toggle "mostra archiviate" — visibile solo se opt-in ON e ci sono voci */}
      {enabled && (
        <View style={styles.controlsRow}>
          <TouchableOpacity
            onPress={() => setIncludeArchived((v) => !v)}
            style={[
              styles.pillBtn,
              includeArchived && styles.pillBtnActive,
            ]}
            testID="situations-toggle-archived"
          >
            <Ionicons
              name={includeArchived ? "archive" : "archive-outline"}
              size={14}
              color="rgba(226,232,240,0.9)"
            />
            <Text style={styles.pillBtnText}>
              {includeArchived ? "Includo archiviate" : "Mostra archiviate"}
            </Text>
          </TouchableOpacity>
          {items.length > 0 && (
            <TouchableOpacity
              onPress={wipeAll}
              style={[styles.pillBtn, styles.pillBtnDanger]}
              testID="situations-wipe"
            >
              <Ionicons name="trash-outline" size={14} color="#fca5a5" />
              <Text style={[styles.pillBtnText, { color: "#fca5a5" }]}>
                Cancella tutto
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Contenuto: loading / opt-in off / lista vuota / lista */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="rgba(226,232,240,0.6)" />
        </View>
      ) : emptyOptIn ? (
        <View style={styles.center}>
          <Ionicons
            name="lock-closed-outline"
            size={38}
            color="rgba(226,232,240,0.4)"
          />
          <Text style={styles.emptyTitle}>Al momento Koda non ricorda niente</Text>
          <Text style={styles.emptyBody}>
            Il tracciamento è spento. Puoi attivarlo dalle Impostazioni
            (voce “Cosa Koda ricorda”). Finché resta spento, questa lista
            resta vuota e nessuna nuova informazione viene salvata.
          </Text>
        </View>
      ) : emptyList ? (
        <View style={styles.center}>
          <Ionicons name="leaf-outline" size={38} color="rgba(226,232,240,0.4)" />
          <Text style={styles.emptyTitle}>Ancora niente da ricordare</Text>
          <Text style={styles.emptyBody}>
            Quando parlerai di persone, argomenti o situazioni ricorrenti,
            le vedrai apparire qui.
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="rgba(226,232,240,0.6)"
            />
          }
        >
          {items.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => openDetail(s.id)}
              style={({ pressed }) => [
                styles.itemCard,
                pressed && styles.itemCardPressed,
                s.user_muted && styles.itemCardMuted,
                !!s.archived_at && styles.itemCardArchived,
              ]}
              testID={`situation-item-${s.id}`}
            >
              <View style={styles.itemHeader}>
                <Text style={styles.itemIcon}>
                  {ENTITY_ICON[s.entity_type] || "•"}
                </Text>
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {s.title}
                </Text>
                <View style={styles.itemBadges}>
                  {s.user_muted && (
                    <Ionicons
                      name="volume-mute"
                      size={14}
                      color="rgba(226,232,240,0.55)"
                    />
                  )}
                  {!!s.archived_at && (
                    <Ionicons
                      name="archive"
                      size={14}
                      color="rgba(226,232,240,0.55)"
                    />
                  )}
                </View>
              </View>
              <View style={styles.itemMeta}>
                <Text style={styles.itemMetaText}>
                  {s.evidence_count === 1
                    ? "1 traccia"
                    : `${s.evidence_count} tracce`}
                </Text>
                <Text style={styles.itemMetaDot}>•</Text>
                <Text style={styles.itemMetaText}>
                  ultima: {formatDate(s.last_evidence_at)}
                </Text>
              </View>
              {s.tags && s.tags.length > 0 && (
                <View style={styles.tagRow}>
                  {s.tags.slice(0, 4).map((t) => (
                    <View key={t} style={styles.tagChip}>
                      <Text style={styles.tagText}>{t}</Text>
                    </View>
                  ))}
                </View>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Bottom sheet dettaglio */}
      <Modal
        visible={!!detailFor}
        animationType="slide"
        transparent
        onRequestClose={() => setDetailFor(null)}
      >
        <View style={styles.sheetBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => setDetailFor(null)}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            {detailLoading || !detailFor ? (
              <View style={styles.center}>
                <ActivityIndicator color="rgba(226,232,240,0.6)" />
              </View>
            ) : (
              <>
                <View style={styles.sheetHandle} />
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetIcon}>
                    {ENTITY_ICON[detailFor.situation.entity_type] || "•"}
                  </Text>
                  <Text style={styles.sheetTitle} numberOfLines={2}>
                    {detailFor.situation.title}
                  </Text>
                </View>
                <View style={styles.sheetActionRow}>
                  <TouchableOpacity
                    style={styles.sheetActionBtn}
                    onPress={() => toggleMute(detailFor.situation as Situation)}
                    testID={`situation-mute-${detailFor.situation.id}`}
                  >
                    <Ionicons
                      name={
                        detailFor.situation.user_muted
                          ? "volume-high"
                          : "volume-mute"
                      }
                      size={18}
                      color="rgba(226,232,240,0.9)"
                    />
                    <Text style={styles.sheetActionText}>
                      {detailFor.situation.user_muted ? "Riattiva" : "Silenzia"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.sheetActionBtn}
                    onPress={() => toggleArchive(detailFor.situation as Situation)}
                    testID={`situation-archive-${detailFor.situation.id}`}
                  >
                    <Ionicons
                      name={
                        detailFor.situation.archived_at
                          ? "arrow-up-circle"
                          : "archive"
                      }
                      size={18}
                      color="rgba(226,232,240,0.9)"
                    />
                    <Text style={styles.sheetActionText}>
                      {detailFor.situation.archived_at ? "Ripristina" : "Archivia"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sheetActionBtn, styles.sheetActionDanger]}
                    onPress={() => deleteOne(detailFor.situation as Situation)}
                    testID={`situation-delete-${detailFor.situation.id}`}
                  >
                    <Ionicons name="trash" size={18} color="#fca5a5" />
                    <Text style={[styles.sheetActionText, { color: "#fca5a5" }]}>
                      Cancella
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.sheetSectionTitle}>Tracce recenti</Text>
                <ScrollView
                  style={{ maxHeight: 320 }}
                  contentContainerStyle={{ paddingBottom: 16 }}
                >
                  {detailFor.evidences.length === 0 ? (
                    <Text style={styles.sheetEmpty}>
                      Nessuna traccia registrata.
                    </Text>
                  ) : (
                    detailFor.evidences.map((ev) => (
                      <View key={ev.id} style={styles.evidenceRow}>
                        <View style={styles.evidenceDot} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.evidenceExcerpt}>
                            {ev.excerpt || "(traccia senza estratto)"}
                          </Text>
                          <Text style={styles.evidenceMeta}>
                            {formatDate(ev.observed_at)} · {ev.source}
                          </Text>
                        </View>
                      </View>
                    ))
                  )}
                </ScrollView>
              </>
            )}
          </View>
        </View>
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
    marginBottom: 10,
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
  pillBtnActive: {
    backgroundColor: "rgba(139,92,246,0.15)",
    borderColor: "rgba(139,92,246,0.35)",
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
  itemCardMuted: {
    opacity: 0.55,
  },
  itemCardArchived: {
    opacity: 0.45,
    borderStyle: "dashed",
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  itemIcon: {
    fontSize: 18,
  },
  itemTitle: {
    flex: 1,
    color: "rgba(226,232,240,0.95)",
    fontSize: 15,
    fontWeight: "500",
  },
  itemBadges: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  itemMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
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
    minHeight: 280,
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
  sheetActionRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  sheetActionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
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
    fontSize: 12,
    fontWeight: "500",
  },
  sheetSectionTitle: {
    color: "rgba(226,232,240,0.55)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  sheetEmpty: {
    color: "rgba(226,232,240,0.45)",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 12,
  },
  evidenceRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 12,
  },
  evidenceDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: "rgba(139,92,246,0.6)",
    marginTop: 7,
  },
  evidenceExcerpt: {
    color: "rgba(226,232,240,0.85)",
    fontSize: 13,
    lineHeight: 19,
  },
  evidenceMeta: {
    color: "rgba(226,232,240,0.45)",
    fontSize: 11,
    marginTop: 3,
  },
});
