import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { API_BASE, AppItem, Favorite } from "../lib/api";
import AppCard from "../components/AppCard";
import CompareModal from "../components/CompareModal";

export default function Saved() {
  const insets = useSafeAreaInsets();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AppItem[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/favorites`);
      if (r.ok) setFavorites(await r.json());
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const remove = async (fav: Favorite) => {
    setFavorites((prev) => prev.filter((f) => f.id !== fav.id));
    setSelected((prev) => prev.filter((a) => a.id !== fav.app.id));
    await fetch(`${API_BASE}/favorites/${fav.id}`, { method: "DELETE" });
  };

  const toggleCompare = (app: AppItem) => {
    setSelected((prev) => {
      const ex = prev.find((a) => a.id === app.id);
      if (ex) return prev.filter((a) => a.id !== app.id);
      if (prev.length >= 3) return prev;
      return [...prev, app];
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 20 }]} testID="saved-screen">
      <View style={styles.header}>
        <View>
          <Text style={styles.overline}>PREFERITE</Text>
          <Text style={styles.title}>Le mie app</Text>
        </View>
        <View style={styles.badge}>
          <Ionicons name="bookmark" size={13} color="#FBBF24" />
          <Text style={styles.badgeText}>{favorites.length}</Text>
        </View>
      </View>

      {selected.length >= 2 && (
        <View style={{ paddingHorizontal: 20 }}>
          <Text
            style={styles.compareLink}
            onPress={() => setCompareOpen(true)}
            testID="saved-compare-link"
          >
            Confronta {selected.length} app →
          </Text>
        </View>
      )}

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#FBBF24" />
        </View>
      ) : favorites.length === 0 ? (
        <View style={styles.empty} testID="saved-empty">
          <View style={styles.emptyIconBubble}>
            <Ionicons name="bookmark-outline" size={46} color="#FBBF24" />
          </View>
          <Text style={styles.emptyTitle}>Nessuna app salvata</Text>
          <Text style={styles.emptyText}>
            Cerca qualcosa e tocca "Salva" sulle app che ti interessano per
            ritrovarle qui.
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
          {favorites.map((f) => (
            <AppCard
              key={f.id}
              app={f.app}
              selected={!!selected.find((a) => a.id === f.app.id)}
              onToggleSelect={() => toggleCompare(f.app)}
              onRemove={() => remove(f)}
            />
          ))}
        </ScrollView>
      )}

      <CompareModal
        visible={compareOpen}
        apps={selected}
        onClose={() => setCompareOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 10,
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
  badge: {
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(251,191,36,0.08)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.2)",
  },
  badgeText: { color: "#FBBF24", fontWeight: "700", fontSize: 12 },
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
  compareLink: {
    color: "#FBBF24",
    fontWeight: "700",
    fontSize: 13,
    marginBottom: 8,
  },
});
