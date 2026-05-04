import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { API_BASE, HistoryItem } from "../lib/api";

export default function History() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/history`);
      if (r.ok) setItems(await r.json());
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const remove = async (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await fetch(`${API_BASE}/history/${id}`, { method: "DELETE" });
  };

  const clearAll = async () => {
    const doClear = async () => {
      setItems([]);
      await fetch(`${API_BASE}/history`, { method: "DELETE" });
    };
    if (Platform.OS === "web") {
      doClear();
    } else {
      Alert.alert("Cancella cronologia", "Vuoi cancellare tutta la cronologia?", [
        { text: "Annulla", style: "cancel" },
        { text: "Cancella", style: "destructive", onPress: doClear },
      ]);
    }
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString("it-IT", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 20 }]} testID="history-screen">
      <View style={styles.header}>
        <View>
          <Text style={styles.overline}>CRONOLOGIA</Text>
          <Text style={styles.title}>Le tue ricerche</Text>
        </View>
        {items.length > 0 && (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={clearAll}
            testID="clear-history-btn"
          >
            <Ionicons name="trash-outline" size={13} color="#F87171" />
            <Text style={styles.clearBtnText}>Svuota</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#FBBF24" />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.empty} testID="history-empty">
          <View style={styles.emptyIconBubble}>
            <Ionicons name="time-outline" size={46} color="#FBBF24" />
          </View>
          <Text style={styles.emptyTitle}>Nessuna ricerca</Text>
          <Text style={styles.emptyText}>
            Le tue ricerche appariranno qui per riprenderle al volo.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor="#FBBF24"
            />
          }
          showsVerticalScrollIndicator={false}
        >
          {items.map((it) => (
            <View
              key={it.id}
              style={styles.card}
              testID={`history-item-${it.id}`}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardQuery} numberOfLines={2}>
                  "{it.query}"
                </Text>
                {it.summary ? (
                  <Text style={styles.cardSummary} numberOfLines={2}>
                    {it.summary}
                  </Text>
                ) : null}
                <View style={styles.metaRow}>
                  <View style={styles.metaPill}>
                    <Ionicons name="apps" size={11} color="#FBBF24" />
                    <Text style={styles.metaText}>{it.apps_count} app</Text>
                  </View>
                  <Text style={styles.metaDate}>
                    {formatDate(it.created_at)}
                  </Text>
                </View>
              </View>
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => {
                    router.push({
                      pathname: "/",
                      params: { q: it.query, auto: "1" },
                    });
                  }}
                  testID={`rerun-${it.id}`}
                >
                  <Ionicons name="refresh" size={14} color="#FBBF24" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => remove(it.id)}
                  testID={`delete-history-${it.id}`}
                >
                  <Ionicons name="close" size={14} color="#F87171" />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  overline: {
    color: "#FBBF24",
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "700",
  },
  title: {
    color: "#F8FAFC",
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginTop: 4,
  },
  clearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(239,68,68,0.08)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.3)",
  },
  clearBtnText: { color: "#F87171", fontWeight: "600", fontSize: 12 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  emptyIconBubble: {
    width: 100,
    height: 100,
    borderRadius: 32,
    backgroundColor: "rgba(251,191,36,0.08)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  emptyTitle: {
    color: "#F8FAFC",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptyText: {
    color: "#94A3B8",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  card: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  cardQuery: {
    color: "#F8FAFC",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  cardSummary: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(251,191,36,0.08)",
  },
  metaText: { color: "#FBBF24", fontSize: 10.5, fontWeight: "700" },
  metaDate: { color: "#64748B", fontSize: 10.5 },
  actions: { flexDirection: "column", gap: 6 },
  actionBtn: {
    width: 32,
    height: 32,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
