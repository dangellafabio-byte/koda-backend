/**
 * /dev-router-demo — Test Suite Build 19 (Fabio 2026-08-23)
 * =========================================================
 *
 * Schermata UNICA per validare i 5 test manuali di Build 19 senza
 * dover toccare bottoni sparsi in Impostazioni. Ogni "Esegui Test N"
 * fa tutto il setup necessario (API + SecureStore) e navigail'app
 * automaticamente allo scenario da validare.
 *
 * Persistenza: SecureStore.demo_mode="1" + demo_test_id="<n>". Il
 * componente globale DemoFloatingBar legge questi flag e mostra una
 * barra flottante su OGNI schermata con il risultato atteso e un
 * bottone rapido per tornare qui.
 *
 * Test:
 *   1. Premium boot fresh → deve vedere Intro Premium, MAI Intro V3
 *   2. Paywall dev bypass button visibile + click → /intro-premium
 *   3. Free boot fresh → deve vedere Intro V3
 *   4. Cambio tier in-session (Premium → Free) → redirect /lascia-andare
 *   5. Rete lenta (modalità aereo) → no flash di V3 durante offline
 */
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import * as Updates from "expo-updates";
import { useTheme } from "../lib/theme";
import { api } from "../lib/api";

type TestSpec = {
  id: "1" | "2" | "3" | "4" | "5";
  emoji: string;
  title: string;
  expected: string;
  hint: string;
};

const TESTS: TestSpec[] = [
  {
    id: "1",
    emoji: "🔴",
    title: "Premium boot fresh",
    expected: "Vedi Intro Premium (5 coach-mark, voce Cielo). MAI Intro V3.",
    hint:
      "L'app: setta tier=monthly, reset intro_premium_seen_at, reset intro_v3_completed_at, poi ricarica JS bundle.",
  },
  {
    id: "2",
    emoji: "🔴",
    title: "Paywall dev bypass",
    expected:
      "Vedi paywall + bottone verde '[DEV] Simula pagamento riuscito' in fondo. Tap → Intro Premium.",
    hint:
      "L'app: setta tier=null, seed trial expired, apre /paywall. Verifica che il bottone SIA visibile.",
  },
  {
    id: "3",
    emoji: "🟢",
    title: "Free boot fresh (regressione)",
    expected: "Vedi Intro V3 (sequenza narrativa lunga). Il flusso Free NON deve essersi rotto.",
    hint:
      "L'app: setta tier=null, cancella intro_v3_completed_at + intro_premium_seen_at, ricarica bundle.",
  },
  {
    id: "4",
    emoji: "🟡",
    title: "Cambio tier in-session",
    expected:
      "L'app fa: setta Premium → naviga a home → aspetta 3s → setta Free → deve rediregere a /lascia-andare entro 2s.",
    hint:
      "Nessuna azione tua richiesta. Osserva solo lo schermo per ~8 secondi totali.",
  },
  {
    id: "5",
    emoji: "🟠",
    title: "Rete lenta (manuale)",
    expected: "Durante offline: NIENTE flash di Intro V3. Quando torna la rete: Intro Premium.",
    hint:
      "L'app: setta Premium + reset flags. POI: attiva modalità aereo, tap 'Continua', poi tap 'Riattiva rete' dopo 5s.",
  },
];

const DEMO_MODE_KEY = "koda_demo_mode";
const DEMO_TEST_ID_KEY = "koda_demo_test_id";
const DEMO_TEST_STATUS_KEY = "koda_demo_test_status";

export default function DevRouterDemoScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [demoActive, setDemoActive] = useState<boolean>(false);
  const [currentTestId, setCurrentTestId] = useState<string | null>(null);

  useEffect(() => {
    api.adminWhoAmI()
      .then((w: any) => setIsAdmin(Boolean(w?.is_admin)))
      .catch(() => setIsAdmin(false));
    api.getProfile()
      .then((p) => setProfile(p))
      .catch(() => {});
    (async () => {
      try {
        const mode = await SecureStore.getItemAsync(DEMO_MODE_KEY);
        const tid = await SecureStore.getItemAsync(DEMO_TEST_ID_KEY);
        setDemoActive(mode === "1");
        setCurrentTestId(tid);
      } catch {}
    })();
  }, []);

  const activateDemoMode = async (testId: string) => {
    try {
      await SecureStore.setItemAsync(DEMO_MODE_KEY, "1");
      await SecureStore.setItemAsync(DEMO_TEST_ID_KEY, testId);
      await SecureStore.setItemAsync(DEMO_TEST_STATUS_KEY, "running");
    } catch (e) {
      console.warn("[demo] activateDemoMode failed:", e);
    }
  };

  const clearIntroFlags = async () => {
    try {
      await Promise.all([
        SecureStore.deleteItemAsync("intro_v3_completed_at"),
        SecureStore.deleteItemAsync("intro_premium_seen_at"),
        SecureStore.deleteItemAsync("heart_reveal_dismissed_at"),
        SecureStore.deleteItemAsync("koda_intro_seen"),
      ]);
    } catch {}
    try {
      await api.devIntroPremiumReset();
    } catch {}
  };

  const doReload = async () => {
    if (Platform.OS === "web") {
      // Web: reload della pagina
      try { (window as any).location.reload(); } catch {}
      return;
    }
    try {
      await Updates.reloadAsync();
    } catch (e: any) {
      Alert.alert(
        "Reload non disponibile",
        "Impossibile ricaricare il bundle automaticamente. Chiudi manualmente l'app (swipe up) e riaprila per completare il test.\n\nErrore: " +
          (e?.message || "sconosciuto")
      );
    }
  };

  const runTest = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      switch (id) {
        case "1": {
          // Premium boot fresh: set tier=monthly, clear intro flags, reload
          await api.devSetTier("monthly");
          await clearIntroFlags();
          await activateDemoMode("1");
          await new Promise((r) => setTimeout(r, 300));
          await doReload();
          break;
        }
        case "2": {
          // Paywall dev bypass: set free, seed expired, navigate to /paywall
          await api.devSetTier(null);
          try { await api.devTrialSeedExpired(); } catch {}
          await activateDemoMode("2");
          await new Promise((r) => setTimeout(r, 200));
          router.push("/paywall");
          break;
        }
        case "3": {
          // Free boot fresh: set free, clear intro flags, reload
          await api.devSetTier(null);
          await clearIntroFlags();
          await activateDemoMode("3");
          await new Promise((r) => setTimeout(r, 300));
          await doReload();
          break;
        }
        case "4": {
          // Cambio tier in-session: set premium, navigate home, wait 3s, set free
          await activateDemoMode("4");
          await api.devSetTier("monthly");
          await new Promise((r) => setTimeout(r, 200));
          router.replace("/");
          // Aspetta che l'app si stabilizzi sulla home, poi setta Free
          setTimeout(async () => {
            try {
              await api.devSetTier(null);
              // Forziamo un refetch del profile per triggerare il router Free/Premium
              try {
                await api.getProfile();
              } catch {}
              // Il router Free/Premium in index.tsx dovrebbe rilevare il cambio
              // tier (keyed invalidation) e ridirigere a /lascia-andare entro
              // ~1-2s. Se non lo fa, il test è fallito.
            } catch (e) {
              console.warn("[demo test 4] second-phase set free failed:", e);
            }
          }, 3000);
          break;
        }
        case "5": {
          // Rete lenta: setup Premium + reset flags, poi istruzioni
          await api.devSetTier("monthly");
          await clearIntroFlags();
          await activateDemoMode("5");
          Alert.alert(
            "Test 5 — Rete lenta",
            "Setup completato (Premium + reset flag intro).\n\nOra:\n1. Attiva MODALITÀ AEREO dal Control Center\n2. Tap OK qui sotto\n3. Aspetta 5 secondi (l'app ricaricherà)\n4. Disattiva la modalità aereo dopo 5s\n\nATTESO: non vedi flash di V3, poi appare Intro Premium.",
            [
              {
                text: "OK, ho attivato aereo",
                onPress: async () => {
                  await new Promise((r) => setTimeout(r, 300));
                  await doReload();
                },
              },
              { text: "Annulla", style: "cancel" },
            ]
          );
          break;
        }
      }
    } catch (e: any) {
      Alert.alert("Errore setup", e?.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const exitDemo = async () => {
    try {
      await SecureStore.deleteItemAsync(DEMO_MODE_KEY);
      await SecureStore.deleteItemAsync(DEMO_TEST_ID_KEY);
      await SecureStore.deleteItemAsync(DEMO_TEST_STATUS_KEY);
      await api.devSetTier(null);
      try { await api.devTrialReset(); } catch {}
      await clearIntroFlags();
    } catch {}
    Alert.alert(
      "Demo terminata",
      "Modalità test disattivata. Tier=free, trial resettato, flag intro cancellati. L'app tornerà al comportamento normale.",
      [{ text: "OK", onPress: () => router.replace("/") }]
    );
  };

  const currentTier = (profile?.subscription_tier as string | null) || "free";

  if (isAdmin === false) {
    return (
      <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top + 40 }]}>
        <Text style={[styles.title, { color: theme.text, textAlign: "center" }]}>
          Solo admin
        </Text>
        <Text style={[styles.hint, { color: theme.textDim, textAlign: "center", marginTop: 12 }]}>
          Questa schermata è riservata agli amministratori.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 20,
        }}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={20}>
            <Text style={[styles.back, { color: theme.textDim }]}>← Indietro</Text>
          </Pressable>
        </View>

        <Text style={[styles.title, { color: theme.text }]}>
          🧪 Test Suite — Build 19
        </Text>
        <Text style={[styles.subtitle, { color: theme.textDim }]}>
          Ogni test fa TUTTO il setup automaticamente. Tu osserva solo cosa appare.
        </Text>

        {/* Stato attuale */}
        <View style={[styles.stateCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.stateRow}>
            <Text style={[styles.stateLabel, { color: theme.textDim }]}>Tier attuale:</Text>
            <Text style={[styles.stateValue, { color: theme.text, fontWeight: "700" }]}>
              {currentTier}
            </Text>
          </View>
          <View style={styles.stateRow}>
            <Text style={[styles.stateLabel, { color: theme.textDim }]}>Demo mode:</Text>
            <Text style={[styles.stateValue, { color: demoActive ? "#00F5D4" : theme.textDim }]}>
              {demoActive ? `ATTIVA (Test ${currentTestId})` : "off"}
            </Text>
          </View>
        </View>

        {/* Test list */}
        {TESTS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => runTest(t.id)}
            disabled={busy !== null}
            style={[
              styles.testCard,
              {
                backgroundColor: theme.surface,
                borderColor: theme.border,
                opacity: busy && busy !== t.id ? 0.4 : 1,
              },
            ]}
          >
            <View style={styles.testHeader}>
              <Text style={styles.testEmoji}>{t.emoji}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.testTitle, { color: theme.text }]}>
                  Test {t.id}: {t.title}
                </Text>
              </View>
              {busy === t.id ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Text style={[styles.playIcon, { color: theme.primary }]}>▶</Text>
              )}
            </View>
            <Text style={[styles.testExpected, { color: theme.text }]}>
              <Text style={{ fontWeight: "700" }}>Atteso:</Text> {t.expected}
            </Text>
            <Text style={[styles.testHint, { color: theme.textDim }]}>{t.hint}</Text>
          </Pressable>
        ))}

        {/* Exit demo */}
        <Pressable onPress={exitDemo} style={[styles.exitBtn, { borderColor: theme.border }]}>
          <Text style={[styles.exitText, { color: theme.textDim }]}>
            ⏹ Termina modalità demo (reset tutto)
          </Text>
        </Pressable>

        <Text style={[styles.footer, { color: theme.textDim }]}>
          Dopo ogni test, la barra flottante in basso ti riporta qui automaticamente.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { marginBottom: 8 },
  back: { fontSize: 15 },
  title: { fontSize: 24, fontWeight: "800", marginTop: 8, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, marginTop: 6, marginBottom: 16, lineHeight: 18 },
  hint: { fontSize: 13, lineHeight: 18 },
  stateCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 18,
    gap: 6,
  },
  stateRow: { flexDirection: "row", justifyContent: "space-between" },
  stateLabel: { fontSize: 13 },
  stateValue: { fontSize: 13 },
  testCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  testHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  testEmoji: { fontSize: 22 },
  testTitle: { fontSize: 16, fontWeight: "700" },
  playIcon: { fontSize: 18, fontWeight: "800" },
  testExpected: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  testHint: { fontSize: 11.5, lineHeight: 16, fontStyle: "italic" },
  exitBtn: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    alignItems: "center",
    marginTop: 20,
  },
  exitText: { fontSize: 13 },
  footer: {
    fontSize: 11.5,
    textAlign: "center",
    marginTop: 24,
    fontStyle: "italic",
    lineHeight: 16,
  },
});
