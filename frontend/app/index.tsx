import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Keyboard,
  Animated,
  Easing,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  API_BASE,
  AppItem,
  Category,
  Favorite,
  RecommendResponse,
} from "../lib/api";
import AppCard from "../components/AppCard";
import CompareModal from "../components/CompareModal";
import { startRecording, buildFormData, Recorder } from "../lib/voice";
import { shareRecommendation } from "../lib/share";

type Featured = {
  week: number;
  app: {
    name: string;
    emoji: string;
    tagline: string;
    category: string;
    url: string;
  };
};

export default function Home() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; auto?: string }>();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RecommendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [selectedForCompare, setSelectedForCompare] = useState<AppItem[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [featured, setFeatured] = useState<Featured | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const recRef = useRef<Recorder | null>(null);

  const spin = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    loadCategories();
    loadFavorites();
  }, []);

  // Handle rerun from history: /?q=...&auto=1
  useEffect(() => {
    const q = params?.q;
    if (typeof q === "string" && q.trim()) {
      setQuery(q);
      if (params?.auto === "1") {
        submit(q, null);
      }
      router.setParams({ q: "", auto: "" } as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.q, params?.auto]);

  useEffect(() => {
    if (loading) {
      Animated.loop(
        Animated.timing(spin, {
          toValue: 1,
          duration: 2500,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      ).start();
    } else {
      spin.stopAnimation();
      spin.setValue(0);
    }
  }, [loading]);

  const loadCategories = async () => {
    try {
      const r = await fetch(`${API_BASE}/categories`);
      if (r.ok) setCategories(await r.json());
    } catch (e) {
      // silent
    }
  };

  const loadFavorites = async () => {
    try {
      const r = await fetch(`${API_BASE}/favorites`);
      if (r.ok) setFavorites(await r.json());
    } catch {}
  };

  const loadFeatured = async () => {
    try {
      const r = await fetch(`${API_BASE}/featured-app`);
      if (r.ok) setFeatured(await r.json());
    } catch {}
  };

  useEffect(() => {
    loadFeatured();
  }, []);

  const toggleRecording = async () => {
    if (transcribing) return;
    if (recording && recRef.current) {
      try {
        setRecording(false);
        setTranscribing(true);
        const res = await recRef.current.stop();
        recRef.current = null;
        if (!res) {
          setTranscribing(false);
          return;
        }
        const fd = buildFormData(res);
        const r = await fetch(`${API_BASE}/transcribe`, {
          method: "POST",
          body: fd,
        });
        if (r.ok) {
          const data = await r.json();
          const text = (data.text || "").trim();
          if (text) {
            setQuery(text);
            submit(text, selectedCategory);
          } else {
            setError("Non ho sentito nulla, riprova.");
          }
        } else {
          setError("Trascrizione non riuscita.");
        }
      } catch (e) {
        setError("Errore microfono. Controlla i permessi.");
      } finally {
        setTranscribing(false);
      }
    } else {
      try {
        setError(null);
        const rec = await startRecording();
        recRef.current = rec;
        setRecording(true);
      } catch (e) {
        setError("Microfono non disponibile. Controlla i permessi.");
      }
    }
  };

  const onShare = async () => {
    if (!result) return;
    const status = await shareRecommendation(result.query, result.summary);
    if (status === "copied") {
      setShareStatus("Link copiato!");
      setTimeout(() => setShareStatus(null), 2200);
    } else if (status === "shared") {
      setShareStatus("Condiviso ✓");
      setTimeout(() => setShareStatus(null), 2200);
    }
  };

  const submit = async (textOverride?: string, catOverride?: string | null) => {
    const q = (textOverride ?? query).trim();
    if (!q) {
      setError("Scrivi cosa vuoi fare");
      return;
    }
    Keyboard.dismiss();
    setError(null);
    setLoading(true);
    setResult(null);
    setSelectedForCompare([]);
    try {
      const r = await fetch(`${API_BASE}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          category: catOverride ?? selectedCategory,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || "Errore");
      }
      const data: RecommendResponse = await r.json();
      setResult(data);
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: 360, animated: true });
      }, 150);
    } catch (e: any) {
      setError("Oops, qualcosa è andato storto. Riprova.");
    } finally {
      setLoading(false);
    }
  };

  const onCategoryPress = (c: Category) => {
    const isSame = selectedCategory === c.id;
    const next = isSame ? null : c.id;
    setSelectedCategory(next);
    if (!isSame && !query) {
      const ex = c.examples[0] || c.name.toLowerCase();
      setQuery(ex);
      submit(ex, c.id);
    }
  };

  const isSaved = (app: AppItem) =>
    favorites.some((f) => f.app.name.toLowerCase() === app.name.toLowerCase());

  const toggleSave = async (app: AppItem) => {
    const existing = favorites.find(
      (f) => f.app.name.toLowerCase() === app.name.toLowerCase()
    );
    if (existing) {
      setFavorites((prev) => prev.filter((f) => f.id !== existing.id));
      await fetch(`${API_BASE}/favorites/${existing.id}`, { method: "DELETE" });
    } else {
      try {
        const r = await fetch(`${API_BASE}/favorites`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app, query: result?.query }),
        });
        if (r.ok) {
          const fav: Favorite = await r.json();
          setFavorites((prev) => [fav, ...prev.filter((f) => f.id !== fav.id)]);
        }
      } catch {}
    }
  };

  const toggleCompare = (app: AppItem) => {
    setSelectedForCompare((prev) => {
      const exists = prev.find((a) => a.id === app.id);
      if (exists) return prev.filter((a) => a.id !== app.id);
      if (prev.length >= 3) return prev;
      return [...prev, app];
    });
  };

  const spinInterpolate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 20, paddingBottom: 40 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        testID="home-scroll"
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <Animated.View
            style={[
              styles.logoBubble,
              { transform: [{ rotate: spinInterpolate }] },
            ]}
          >
            <Ionicons name="compass" size={26} color="#FBBF24" />
          </Animated.View>
          <View style={{ marginLeft: 12, flex: 1 }}>
            <Text style={styles.overline}>LA BUSSOLA DELLE APP</Text>
            <Text style={styles.title}>
              Dimmi cosa vuoi fare,{"\n"}
              <Text style={{ color: "#FBBF24" }}>io trovo l'app giusta.</Text>
            </Text>
          </View>
        </View>

        {/* Prompt input */}
        <View style={styles.inputCard} testID="prompt-card">
          <TextInput
            style={styles.input}
            placeholder="Es. voglio modificare un video e aggiungere sottotitoli…"
            placeholderTextColor="#64748B"
            value={query}
            onChangeText={setQuery}
            multiline
            textAlignVertical="top"
            testID="prompt-input"
          />
          <View style={styles.inputFooter}>
            <View style={styles.hintRow}>
              <Ionicons name="sparkles" size={13} color="#FBBF24" />
              <Text style={styles.hintText}>
                {recording ? "Registrazione..." : transcribing ? "Trascrivo..." : "Powered by AI · voce & testo"}
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                style={[
                  styles.micBtn,
                  recording && styles.micBtnActive,
                ]}
                onPress={toggleRecording}
                disabled={transcribing}
                testID="mic-btn"
              >
                {transcribing ? (
                  <ActivityIndicator size="small" color="#FBBF24" />
                ) : (
                  <Ionicons
                    name={recording ? "stop" : "mic"}
                    size={16}
                    color={recording ? "#020617" : "#FBBF24"}
                  />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.submitBtn, !query.trim() && { opacity: 0.5 }]}
                onPress={() => submit()}
                disabled={loading || !query.trim()}
                testID="submit-btn"
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#020617" />
                ) : (
                  <>
                    <Ionicons name="arrow-forward" size={16} color="#020617" />
                    <Text style={styles.submitBtnText}>Trova app</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
          {error ? (
            <Text style={styles.errorText} testID="error-message">
              {error}
            </Text>
          ) : null}
        </View>

        {/* Featured app of the week */}
        {!result && !loading && featured && (
          <TouchableOpacity
            style={styles.featuredCard}
            onPress={() => {
              setQuery(featured.app.tagline);
              submit(featured.app.name, null);
            }}
            testID="featured-card"
          >
            <View style={styles.featuredHeader}>
              <Text style={styles.featuredBadge}>APP DELLA SETTIMANA · W{featured.week}</Text>
            </View>
            <View style={styles.featuredBody}>
              <View style={styles.featuredIcon}>
                <Text style={{ fontSize: 32 }}>{featured.app.emoji}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.featuredName}>{featured.app.name}</Text>
                <Text style={styles.featuredTag}>{featured.app.tagline}</Text>
              </View>
              <Ionicons name="arrow-forward-circle" size={28} color="#FBBF24" />
            </View>
          </TouchableOpacity>
        )}

        {/* Categories */}
        {!result && !loading && (
          <>
            <Text style={styles.sectionTitle}>Categorie</Text>
            <Text style={styles.sectionSub}>
              Tocca una categoria per ispirarti o restringere la ricerca
            </Text>
            <View style={styles.catGrid} testID="categories-grid">
              {categories.map((c) => {
                const active = selectedCategory === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => onCategoryPress(c)}
                    style={[styles.catCard, active && styles.catCardActive]}
                    testID={`category-${c.id}`}
                  >
                    <Text style={styles.catEmoji}>{c.emoji}</Text>
                    <Text style={styles.catName}>{c.name}</Text>
                    <Text style={styles.catDesc} numberOfLines={1}>
                      {c.description}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}

        {/* Loading state */}
        {loading && (
          <View style={styles.loadingBox} testID="loading-state">
            <ActivityIndicator size="large" color="#FBBF24" />
            <Text style={styles.loadingTitle}>La bussola sta cercando…</Text>
            <Text style={styles.loadingSub}>
              Sto consultando l'AI per consigli su misura
            </Text>
          </View>
        )}

        {/* Results */}
        {result && !loading && (
          <View style={{ marginTop: 24 }} testID="results-section">
            <View style={styles.resultHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultOverline}>RISULTATI PER</Text>
                <Text style={styles.resultQuery} numberOfLines={2}>
                  "{result.query}"
                </Text>
              </View>
              <TouchableOpacity
                style={styles.newSearchBtn}
                onPress={onShare}
                testID="share-btn"
              >
                <Ionicons name="share-social" size={14} color="#FBBF24" />
                <Text style={styles.newSearchText}>
                  {shareStatus || "Condividi"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.newSearchBtn, { marginLeft: 6 }]}
                onPress={() => {
                  setResult(null);
                  setQuery("");
                  setSelectedCategory(null);
                  setSelectedForCompare([]);
                }}
                testID="new-search-btn"
              >
                <Ionicons name="refresh" size={14} color="#FBBF24" />
                <Text style={styles.newSearchText}>Nuova</Text>
              </TouchableOpacity>
            </View>

            {result.summary ? (
              <View style={styles.summaryBox}>
                <Ionicons name="bulb" size={16} color="#FBBF24" />
                <Text style={styles.summaryText}>{result.summary}</Text>
              </View>
            ) : null}

            {selectedForCompare.length >= 2 && (
              <TouchableOpacity
                style={styles.compareBar}
                onPress={() => setCompareOpen(true)}
                testID="open-compare-btn"
              >
                <Ionicons name="git-compare" size={16} color="#020617" />
                <Text style={styles.compareBarText}>
                  Confronta {selectedForCompare.length} app
                </Text>
              </TouchableOpacity>
            )}

            {result.apps.map((a) => (
              <AppCard
                key={a.id}
                app={a}
                saved={isSaved(a)}
                selected={!!selectedForCompare.find((s) => s.id === a.id)}
                onSave={() => toggleSave(a)}
                onToggleSelect={() => toggleCompare(a)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <CompareModal
        visible={compareOpen}
        apps={selectedForCompare}
        onClose={() => setCompareOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },
  scroll: { paddingHorizontal: 20 },
  headerRow: { flexDirection: "row", alignItems: "center", marginBottom: 22 },
  logoBubble: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: "rgba(251,191,36,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.3)",
  },
  overline: {
    color: "#FBBF24",
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "700",
    opacity: 0.9,
  },
  title: {
    color: "#F8FAFC",
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginTop: 4,
    lineHeight: 28,
  },
  inputCard: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 24,
    padding: 16,
  },
  input: {
    color: "#F8FAFC",
    fontSize: 15,
    minHeight: 64,
    padding: 0,
  },
  inputFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 14,
    flexWrap: "wrap",
    gap: 8,
  },
  hintRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  hintText: { color: "#94A3B8", fontSize: 11, fontWeight: "500" },
  submitBtn: {
    backgroundColor: "#FBBF24",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    gap: 6,
  },
  submitBtnText: { color: "#020617", fontWeight: "700", fontSize: 13 },
  errorText: { color: "#F87171", fontSize: 12, marginTop: 10 },
  sectionTitle: {
    color: "#F8FAFC",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 30,
    letterSpacing: -0.3,
  },
  sectionSub: { color: "#94A3B8", fontSize: 12.5, marginTop: 4, marginBottom: 16 },
  catGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12,
  },
  catCard: {
    width: "47%",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    marginBottom: 4,
  },
  catCardActive: {
    borderColor: "#FBBF24",
    backgroundColor: "rgba(251,191,36,0.08)",
  },
  catEmoji: { fontSize: 26 },
  catName: {
    color: "#F8FAFC",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 8,
  },
  catDesc: { color: "#94A3B8", fontSize: 11, marginTop: 2 },
  loadingBox: { alignItems: "center", marginTop: 40, gap: 10 },
  loadingTitle: {
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "600",
    marginTop: 8,
  },
  loadingSub: { color: "#94A3B8", fontSize: 12.5 },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  resultOverline: {
    color: "#FBBF24",
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "700",
  },
  resultQuery: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
  },
  newSearchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(251,191,36,0.1)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.3)",
  },
  newSearchText: { color: "#FBBF24", fontWeight: "600", fontSize: 12 },
  summaryBox: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "rgba(251,191,36,0.06)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.15)",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  summaryText: {
    color: "#E2E8F0",
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  compareBar: {
    backgroundColor: "#FBBF24",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 999,
    marginBottom: 14,
  },
  compareBarText: { color: "#020617", fontWeight: "700", fontSize: 14 },
  micBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(251,191,36,0.1)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
  },
  micBtnActive: {
    backgroundColor: "#FBBF24",
    borderColor: "#FBBF24",
  },
  featuredCard: {
    marginTop: 24,
    backgroundColor: "rgba(251,191,36,0.07)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.3)",
    borderRadius: 20,
    padding: 14,
  },
  featuredHeader: { marginBottom: 8 },
  featuredBadge: {
    color: "#FBBF24",
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "800",
  },
  featuredBody: { flexDirection: "row", alignItems: "center" },
  featuredIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "rgba(251,191,36,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  featuredName: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  featuredTag: { color: "#CBD5E1", fontSize: 12, marginTop: 2 },
});
