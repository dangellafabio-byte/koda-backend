# KODA — Paywall Hard-Gate Bug — Debug Package per Gemini

## Problema in 3 righe
Hard paywall implementato in Expo React Native NON SI ATTIVA sul telefono iOS dell'utente nonostante:
- Backend ritorni `has_access=false`, `profile.onboarded=true`
- L'OTA si applichi (alcune stringhe nuove appaiono)
- Build EAS preview #23 installata fresca

## Diagnosi parziale (già fatta)
Trovato bug in `index.tsx`: `showColorIntro === false` era strict ma `showColorIntro` parte come `null` async. Fix applicato:
```ts
// PRIMA (buggato):
const intrioComplete = !showOnboarding && showColorIntro === false && profile?.onboarded === true;
// DOPO (fix):
const intrioComplete = !showOnboarding && showColorIntro !== true && profile?.onboarded === true;
```
MA l'utente NON vede ancora il paywall, quindi forse il bug è altrove.

## Domande per Gemini
1. PaywallScreen è un `<Modal>` renderizzato accanto ad altri Modal (KodaIntro, Settings) — c'è conflitto z-index/visibility?
2. SubscriptionProvider è in `_layout.tsx`, PaywallScreen usa `useSubscription()` da dentro `index.tsx` (figlio di Stack) — il context arriva?
3. Ci sono early-return in index.tsx che impediscono il rendering del paywall?
4. Il check `intrioComplete` ha altri buchi?
5. Eventuali React-mismatch tra `subStatus` non caricato e re-render?

---

## FILE INTERESSATI (file completi sotto)


==================================================
## 📄 /app/frontend/app/_layout.tsx
```typescript
import React, { useEffect, useState, useRef } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { View, StyleSheet, Platform, AppState, AppStateStatus } from "react-native";
import * as Updates from "expo-updates";
import { scheduleWeeklyAppNotification } from "../lib/notifications";
import { ThemeProvider, useTheme, ThemeName } from "../lib/theme";
import { api } from "../lib/api";
import { prewarmAudio } from "../lib/speech";
import { loadProfileCache } from "../lib/localCache";
import { SubscriptionProvider } from "../lib/subscription";
import { getUserId } from "../lib/userId";

// ============================================================
// BACKEND KEEP-ALIVE 2026-06
// ============================================================
// PROBLEMA: il container preview di Emergent va in sleep dopo
// ~5 min di inattività. La prima richiesta dopo lo sleep impiega
// 60-90 secondi a tornare → l'app sembra "bloccata".
// FIX: ping leggero ogni 4 min al backend mentre l'app è in
// foreground (background lo skip-piamo per non sprecare batteria).
// ============================================================
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minuti
const KEEP_ALIVE_TIMEOUT_MS = 8000; // 8 sec timeout per il ping (best-effort)

async function pingBackend(): Promise<void> {
  try {
    const base = (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
    if (!base) return;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
    try {
      await fetch(`${base}/api/profile`, {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    // Silent. È solo "warm-up", non importa se fallisce.
  }
}

// ============================================================
// OTA AUTO-UPDATE 2026-06
// ============================================================
// PROBLEMA: expo-updates di default è lazy — scarica l'update al
// primo cold start ma lo applica solo al SECONDO. L'utente vede
// l'app "ferma" per giorni perché serve restart all'app due volte.
// FIX: al boot controlla in foreground se c'è un update.
//      Se sì, lo scarica e lo applica IMMEDIATAMENTE (reloadAsync).
//      Skip in dev (__DEV__=true) per non interferire con Metro.
// ============================================================
async function applyOtaIfAvailable(): Promise<void> {
  // In dev mode (Metro / Expo Go) Updates è disabilitato/no-op.
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (check.isAvailable) {
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew) {
        // Piccolo delay per evitare flash bianco subito al boot
        setTimeout(() => {
          Updates.reloadAsync().catch(() => {});
        }, 1500);
      }
    }
  } catch (e) {
    // Silent: network down / no update / corrupted manifest → ignora.
    console.warn("[OTA] check/apply failed:", e);
  }
}

function ThemedShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      <View style={[styles.root, { backgroundColor: theme.bg }]}>{children}</View>
    </>
  );
}

export default function RootLayout() {
  const [initialTheme, setInitialTheme] = useState<ThemeName>("sistema");
  const [dayStart, setDayStart] = useState(7);
  const [nightStart, setNightStart] = useState(20);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // === FIX 2026-07: RIMOSSO BLOCCO OTA AUTO-RELOAD ===
    // Il vecchio codice qui faceva checkForUpdateAsync() → fetchUpdateAsync()
    // → reloadAsync() al cold start. Era pensato per "forzare gli update",
    // ma in pratica:
    //   - checkForUpdateAsync() NON ha timeout → su rete lenta/DNS pigro
    //     blocca per minuti
    //   - reloadAsync() riavvia l'app → l'utente vede di nuovo l'indaco
    //   - Risultato: 5-20 minuti di "limbo" ogni cold start
    //
    // Soluzione definitiva: lasciamo che expo-updates faccia il suo lavoro
    // SILENZIOSAMENTE in background (è il comportamento di default, già
    // configurato in app.json). L'eventuale OTA verrà applicato al PROSSIMO
    // avvio dell'app, senza reload visibile, senza loop.
    // Per garantire che la build appena installata non riceva mai più
    // OTA vecchi: abbiamo bumped expo.version → nuovo runtimeVersion.

    // Pre-warm iOS/Android audio session BEFORE first TTS plays.
    // Fixes "Koda silent in first intro steps" bug on fresh native build.
    prewarmAudio().catch(() => {});

    // Pre-genera/leggi lo user UUID (X-User-Id) — usato dal multi-user
    // backend e da RevenueCat. Idempotente, salva in SecureStore.
    getUserId().catch(() => {});

    // OTA: controlla + applica eventuale update appena partito.
    applyOtaIfAvailable().catch(() => {});

    if (Platform.OS !== "web") {
      setTimeout(() => {
        scheduleWeeklyAppNotification().catch(() => {});
      }, 1500);
      // not blocking init
    }
    (async () => {
      // === FAST-PATH CACHE (2026-06) ===
      // Prima del network, leggi la cache locale e applica TEMA / orari.
      // Così l'utente al cold start salta direttamente alla home senza
      // vedere lo schermo nero di "loading" se la rete è lenta.
      try {
        const cached = await loadProfileCache<any>();
        if (cached) {
          const t = (cached.settings?.theme as ThemeName) || "sistema";
          setInitialTheme(t);
          if (typeof cached.settings?.day_start_hour === "number") setDayStart(cached.settings.day_start_hour);
          if (typeof cached.settings?.night_start_hour === "number") setNightStart(cached.settings.night_start_hour);
          // Abbiamo dati locali: sblocchiamo SUBITO l'UI. Il network
          // continuerà in parallelo per gli aggiornamenti.
          setReady(true);
        }
      } catch {
        // ignore
      }

      // === FIX 2026-06-28 SERA: timeout + retry sulla fetch profilo ===
      // PROBLEMA: in passato facevamo `await api.getProfile()` senza
      // timeout. iOS al cold start ha la rete/DNS spesso non pronti
      // → la fetch poteva restare appesa per MINUTI → l'app restava
      // nello stato `!ready` che mostra una View vuota con
      // backgroundColor #0B0F1A (indaco scuro). L'utente vedeva una
      // "versione base, app non utilizzabile" per 5-10 minuti.
      //
      // SOLUZIONE 2026-07: timeout AGGRESSIVO a 2.5s. Se in 2.5s
      // la fetch non risponde, procediamo SUBITO con i default.
      // index.tsx ha un retry-on-AppState-change che caricherà il
      // profilo appena la rete è pronta. L'importante è far vedere
      // l'app il prima possibile.
      const PROFILE_TIMEOUT_MS = 2500;
      try {
        const p = await Promise.race([
          api.getProfile(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("profile-cold-timeout")), PROFILE_TIMEOUT_MS)
          ),
        ]);
        const t = (p.settings?.theme as ThemeName) || "sistema";
        setInitialTheme(t);
        if (typeof p.settings?.day_start_hour === "number") setDayStart(p.settings.day_start_hour);
        if (typeof p.settings?.night_start_hour === "number") setNightStart(p.settings.night_start_hour);
      } catch {
        // Rete lenta / DNS non pronto / preview down: NON bloccare l'UI.
        // index.tsx farà i suoi tentativi di caricamento.
      }
      setReady(true); // SEMPRE procediamo. Mai più "limbo indaco".
    })();

    // ====================================================
    // KEEP-ALIVE 2026-06: ping ogni 4 min finché in foreground.
    // Tiene caldo il container backend di Emergent (che altrimenti
    // va in sleep dopo ~5 min di inattività → prossima richiesta
    // dell'utente sembra "bloccata" per 60-90 sec).
    // ====================================================
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let currentAppState: AppStateStatus = AppState.currentState;

    const startKeepAlive = () => {
      if (keepAliveTimer) return;
      // ping immediato (l'utente sta usando l'app ADESSO)
      pingBackend();
      keepAliveTimer = setInterval(() => {
        pingBackend();
      }, KEEP_ALIVE_INTERVAL_MS);
    };

    const stopKeepAlive = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    };

    if (currentAppState === "active") startKeepAlive();

    const sub = AppState.addEventListener("change", (next) => {
      const wasBackground = currentAppState !== "active";
      currentAppState = next;
      if (next === "active") {
        // Tornato in foreground: ping subito (potrebbe essere passato
        // tanto tempo dall'ultimo ping → backend probabilmente cold)
        if (wasBackground) pingBackend();
        startKeepAlive();
      } else {
        stopKeepAlive();
      }
    });

    return () => {
      stopKeepAlive();
      sub.remove();
    };
  }, []);

  if (!ready) {
    // Avoid theme flash: render minimal black screen until profile arrives.
    // Background nero pieno (NON indaco) così l'utente non vede mai più
    // "indaco vuoto" come fosse un bug.
    return (
      <SafeAreaProvider>
        <View style={[styles.root, { backgroundColor: "#000000" }]} />
      </SafeAreaProvider>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider
          initialName={initialTheme}
          initialDayStart={dayStart}
          initialNightStart={nightStart}
        >
          <SubscriptionProvider>
            <ThemedShell>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: "transparent" },
                  animation: "fade",
                }}
              />
            </ThemedShell>
          </SubscriptionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
```

==================================================
## 📄 /app/frontend/lib/subscription.tsx
```typescript
/**
 * Koda — Subscription Context & Paywall.
 *
 * Hard Paywall:
 *  - L'app principale è disponibile SOLO se has_access=true (trial o sub attiva)
 *  - PaywallScreen è full-screen, NON dismissibile finché non c'è acquisto
 *  - Pulsanti: Inizia trial 3gg / 3 piani / Ripristina acquisti / Privacy + ToS
 *
 * In modalità "mock" usa l'endpoint backend mock-purchase per testing.
 * Quando RevenueCat sarà collegato, sostituiremo `purchasePlan` con
 * `Purchases.purchasePackage(...)` e useremo i webhook per sync entitlement.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, API_BASE, PlanName, SubscriptionStatus } from "./api";

// ─── Constants ──────────────────────────────────────────────────────────────
export const PLAN_DETAILS = {
  essential: {
    label: "Essential",
    price: "€4,99",
    period: "mese",
    messages: 80,
    blurb: "Per chi cerca un confidente discreto.",
  },
  daily: {
    label: "Daily",
    price: "€9,99",
    period: "mese",
    messages: 250,
    blurb: "Per la conversazione di tutti i giorni.",
    highlight: true,
  },
  plus: {
    label: "Plus",
    price: "€19,99",
    period: "mese",
    messages: 500,
    blurb: "Massima libertà di espressione.",
  },
} as const;

// ─── Context ────────────────────────────────────────────────────────────────
type SubscriptionCtxValue = {
  status: SubscriptionStatus | null;
  loading: boolean;
  hasAccess: boolean;
  refresh: () => Promise<void>;
  startTrial: () => Promise<void>;
  purchasePlan: (plan: "essential" | "daily" | "plus") => Promise<void>;
  restore: () => Promise<void>;
};

const SubscriptionCtx = createContext<SubscriptionCtxValue>({
  status: null,
  loading: true,
  hasAccess: false,
  refresh: async () => {},
  startTrial: async () => {},
  purchasePlan: async () => {},
  restore: async () => {},
});

export const useSubscription = () => useContext(SubscriptionCtx);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getSubscriptionStatus();
      setStatus(s);
    } catch (e) {
      console.warn("[subscription] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const startTrial = useCallback(async () => {
    const s = await api.startTrial();
    setStatus(s);
  }, []);

  const purchasePlan = useCallback(async (plan: "essential" | "daily" | "plus") => {
    // ⚠️ MOCKED — TODO: sostituire con Purchases.purchasePackage quando
    // RevenueCat SDK sarà collegato e i prodotti saranno negli store.
    const s = await api.mockPurchase(plan);
    setStatus(s);
  }, []);

  const restore = useCallback(async () => {
    const s = await api.restorePurchases();
    setStatus(s);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      status,
      loading,
      hasAccess: !!status?.has_access,
      refresh,
      startTrial,
      purchasePlan,
      restore,
    }),
    [status, loading, refresh, startTrial, purchasePlan, restore]
  );

  return <SubscriptionCtx.Provider value={value}>{children}</SubscriptionCtx.Provider>;
}

// ─── Paywall UI ─────────────────────────────────────────────────────────────
type PaywallScreenProps = {
  visible: boolean;
  /** Se true e l'utente ha già consumato il trial, mostra solo i piani paid. */
  trialUsed?: boolean;
  /** Se passato, mostra una X in alto a destra che chiude il paywall.
   *  Quando il paywall è in "hard gate" (utente senza accesso) NON va passato
   *  → il paywall resta non-dismissibile. Quando l'utente lo apre dalle
   *  Impostazioni per "Cambiare piano", passa il callback per consentire chiusura. */
  onClose?: () => void;
};

export function PaywallScreen({ visible, trialUsed, onClose }: PaywallScreenProps) {
  const { startTrial, purchasePlan, restore, status } = useSubscription();
  const [busy, setBusy] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const canStartTrial = !!status?.can_start_trial && !trialUsed;

  const handleTrial = useCallback(async () => {
    if (busy) return;
    setBusy("trial");
    try {
      await startTrial();
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Impossibile attivare il trial.");
    } finally {
      setBusy(null);
    }
  }, [busy, startTrial]);

  const handlePurchase = useCallback(
    async (plan: "essential" | "daily" | "plus") => {
      if (busy) return;
      setBusy(plan);
      try {
        await purchasePlan(plan);
      } catch (e: any) {
        Alert.alert("Errore", e?.message || "Acquisto non riuscito.");
      } finally {
        setBusy(null);
      }
    },
    [busy, purchasePlan]
  );

  const handleRestore = useCallback(async () => {
    if (busy) return;
    setBusy("restore");
    try {
      const s = await api.restorePurchases();
      if (!s.has_access) {
        Alert.alert(
          "Nessun acquisto trovato",
          "Non abbiamo trovato sottoscrizioni precedenti per questo account."
        );
      }
      await restore();
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Ripristino non riuscito.");
    } finally {
      setBusy(null);
    }
  }, [busy, restore]);

  const openLegal = (path: "privacy" | "terms") => {
    void Linking.openURL(`${API_BASE}/legal/${path}`);
  };

  return (
    <Modal visible={visible} animationType="fade" transparent={false} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}>
        {/* Close X (solo se onClose è passato — "Cambia piano" dalle Settings) */}
        {onClose && (
          <Pressable
            onPress={onClose}
            style={[styles.closeBtn, { top: insets.top + 12 }]}
            hitSlop={16}
            disabled={!!busy}
          >
            <Text style={styles.closeBtnText}>✕</Text>
          </Pressable>
        )}
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.kicker}>IL TUO SPAZIO DI ASCOLTO</Text>
            <Text style={styles.title}>Apri la porta a Koda</Text>
            <Text style={styles.subtitle}>
              Una presenza fraterna sempre con te. Scegli come iniziare.
            </Text>
          </View>

          {/* Trial CTA */}
          {canStartTrial && (
            <Pressable
              style={({ pressed }) => [
                styles.trialCard,
                pressed && styles.cardPressed,
                busy === "trial" && styles.cardBusy,
              ]}
              onPress={handleTrial}
              disabled={!!busy}
            >
              <View style={styles.trialBadge}>
                <Text style={styles.trialBadgeText}>3 GIORNI GRATIS</Text>
              </View>
              <Text style={styles.trialTitle}>Prova Koda</Text>
              <Text style={styles.trialBlurb}>
                20 messaggi al giorno per 3 giorni — senza impegno, senza carta.
              </Text>
              {busy === "trial" ? (
                <ActivityIndicator color="#0F1A14" style={styles.trialCta} />
              ) : (
                <Text style={styles.trialCta}>Inizia ora →</Text>
              )}
            </Pressable>
          )}

          {/* Separator */}
          {canStartTrial && (
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>oppure scegli un piano</Text>
              <View style={styles.dividerLine} />
            </View>
          )}

          {/* Plan cards */}
          {(Object.keys(PLAN_DETAILS) as (keyof typeof PLAN_DETAILS)[]).map((key) => {
            const p = PLAN_DETAILS[key];
            const highlight = "highlight" in p && p.highlight;
            return (
              <Pressable
                key={key}
                style={({ pressed }) => [
                  styles.planCard,
                  highlight && styles.planCardHighlight,
                  pressed && styles.cardPressed,
                  busy === key && styles.cardBusy,
                ]}
                onPress={() => handlePurchase(key as "essential" | "daily" | "plus")}
                disabled={!!busy}
              >
                <View style={styles.planHeader}>
                  <Text style={[styles.planLabel, highlight && styles.planLabelHighlight]}>
                    {p.label}
                  </Text>
                  {highlight && (
                    <View style={styles.bestBadge}>
                      <Text style={styles.bestBadgeText}>CONSIGLIATO</Text>
                    </View>
                  )}
                </View>
                <View style={styles.priceRow}>
                  <Text style={[styles.price, highlight && styles.priceHighlight]}>
                    {p.price}
                  </Text>
                  <Text style={styles.period}>/{p.period}</Text>
                </View>
                <Text style={styles.messages}>{p.messages} messaggi al mese</Text>
                <Text style={styles.planBlurb}>{p.blurb}</Text>
                {busy === key && (
                  <ActivityIndicator
                    style={styles.planSpinner}
                    color={highlight ? "#FFFFFF" : "#0F1A14"}
                  />
                )}
              </Pressable>
            );
          })}

          {/* Restore + Legal */}
          <View style={styles.footer}>
            <Pressable onPress={handleRestore} disabled={!!busy} hitSlop={12}>
              <Text style={styles.footerLink}>
                {busy === "restore" ? "Ripristino…" : "Ripristina acquisti"}
              </Text>
            </Pressable>
            <Text style={styles.footerSep}>·</Text>
            <Pressable onPress={() => openLegal("privacy")} hitSlop={12}>
              <Text style={styles.footerLink}>Privacy</Text>
            </Pressable>
            <Text style={styles.footerSep}>·</Text>
            <Pressable onPress={() => openLegal("terms")} hitSlop={12}>
              <Text style={styles.footerLink}>Termini</Text>
            </Pressable>
          </View>

          <Text style={styles.disclaimer}>
            Le sottoscrizioni si rinnovano automaticamente al termine del periodo. Puoi
            disdirle in qualsiasi momento dalle impostazioni del tuo {Platform.OS === "ios" ? "ID Apple" : "account Google Play"}.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F4F4F2", // Pietra Zen
    paddingHorizontal: 20,
  },
  closeBtn: {
    position: "absolute",
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  closeBtnText: {
    fontSize: 18,
    color: "#1A1A1A",
    fontWeight: "500",
    lineHeight: 20,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  header: {
    alignItems: "center",
    marginTop: 8,
    marginBottom: 28,
  },
  kicker: {
    fontSize: 11,
    letterSpacing: 2.5,
    fontWeight: "600",
    color: "#6B7280",
    marginBottom: 8,
  },
  title: {
    fontSize: 30,
    fontWeight: "300",
    color: "#1A1A1A",
    textAlign: "center",
    letterSpacing: 0.3,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    color: "#4B5563",
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 8,
  },

  // Trial card
  trialCard: {
    backgroundColor: "#0F1A14",
    borderRadius: 18,
    padding: 22,
    marginBottom: 18,
  },
  trialBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#DCC9A8",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginBottom: 12,
  },
  trialBadgeText: {
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: "700",
    color: "#0F1A14",
  },
  trialTitle: {
    fontSize: 22,
    fontWeight: "500",
    color: "#FFFFFF",
    marginBottom: 6,
  },
  trialBlurb: {
    fontSize: 14,
    color: "rgba(255,255,255,0.78)",
    lineHeight: 20,
    marginBottom: 14,
  },
  trialCta: {
    color: "#DCC9A8",
    fontSize: 15,
    fontWeight: "600",
  },

  // Divider
  divider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 18,
    paddingHorizontal: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(0,0,0,0.10)",
  },
  dividerText: {
    paddingHorizontal: 12,
    fontSize: 12,
    color: "#6B7280",
    letterSpacing: 0.5,
  },

  // Plan cards
  planCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  planCardHighlight: {
    backgroundColor: "#0E7C7B",
    borderColor: "#0E7C7B",
  },
  cardPressed: {
    opacity: 0.7,
  },
  cardBusy: {
    opacity: 0.5,
  },
  planHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  planLabel: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  planLabelHighlight: {
    color: "#FFFFFF",
  },
  bestBadge: {
    backgroundColor: "#DCC9A8",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  bestBadgeText: {
    fontSize: 9,
    letterSpacing: 1.2,
    fontWeight: "700",
    color: "#0F1A14",
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 4,
  },
  price: {
    fontSize: 28,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  priceHighlight: {
    color: "#FFFFFF",
  },
  period: {
    fontSize: 14,
    color: "#6B7280",
    marginLeft: 4,
  },
  messages: {
    fontSize: 13,
    color: "#4B5563",
    fontWeight: "500",
    marginBottom: 4,
  },
  planBlurb: {
    fontSize: 13,
    color: "#6B7280",
    lineHeight: 18,
  },
  planSpinner: {
    position: "absolute",
    right: 18,
    top: 22,
  },

  // Footer
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 24,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  footerLink: {
    fontSize: 13,
    color: "#0E7C7B",
    textDecorationLine: "underline",
    paddingHorizontal: 6,
  },
  footerSep: {
    color: "#9CA3AF",
    fontSize: 13,
  },
  disclaimer: {
    fontSize: 11,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 16,
    paddingHorizontal: 12,
    marginTop: 8,
  },
});
```

==================================================
## 📄 /app/frontend/lib/userId.ts
```typescript
/**
 * Koda — User ID (UUID per-device).
 *
 * Genera/legge un UUID stabile dal SecureStore, usato come:
 *  - `X-User-Id` header su tutte le richieste backend (multi-user)
 *  - `appUserID` su RevenueCat (quando attiveremo l'SDK)
 *
 * Web/SSR fallback: usa localStorage o memoria.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "koda_user_id_v1";

let _cached: string | null = null;
let _inflight: Promise<string> | null = null;

function _uuidv4(): string {
  // Implementazione semplice RFC 4122 v4 senza dipendenze esterne.
  // crypto.getRandomValues è disponibile in RN moderno (Hermes) e nei browser.
  const rnds = new Uint8Array(16);
  if (typeof (globalThis as any).crypto?.getRandomValues === "function") {
    (globalThis as any).crypto.getRandomValues(rnds);
  } else {
    for (let i = 0; i < 16; i++) rnds[i] = Math.floor(Math.random() * 256);
  }
  rnds[6] = (rnds[6] & 0x0f) | 0x40;
  rnds[8] = (rnds[8] & 0x3f) | 0x80;
  const hex = Array.from(rnds, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

async function _read(): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.localStorage) {
        return window.localStorage.getItem(KEY);
      }
      return null;
    }
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

async function _write(v: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(KEY, v);
      }
      return;
    }
    await SecureStore.setItemAsync(KEY, v);
  } catch {
    /* ignore */
  }
}

/**
 * Restituisce (o genera) lo UUID utente.
 * Thread-safe (single inflight) e cached in memoria.
 */
export async function getUserId(): Promise<string> {
  if (_cached) return _cached;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    let v = await _read();
    if (!v || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      v = _uuidv4();
      await _write(v);
    }
    _cached = v.toLowerCase();
    return _cached;
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Per debug/testing: forza un nuovo UUID e lo ritorna. */
export async function resetUserId(): Promise<string> {
  _cached = null;
  const v = _uuidv4();
  await _write(v);
  _cached = v;
  return v;
}

/** Sincrono — ritorna null se non ancora inizializzato. */
export function getUserIdSync(): string | null {
  return _cached;
}
```

==================================================
## 📄 /app/frontend/lib/api.ts
```typescript
/**
 * Taccuino Vivo — API client
 */

import { getUserId, getUserIdSync } from "./userId";

const RAILWAY_PROD = "https://koda-backend-production-4a34.up.railway.app";

const detectBackend = (): string => {
  // EXPO_PUBLIC_BACKEND_URL is set in app .env. Falls back to relative /api on web.
  const env = process.env.EXPO_PUBLIC_BACKEND_URL;
  // === HARDENED ROUTING 2026-06 ===
  // Se l'env var contiene un dominio preview Emergent (che ora non è più il
  // backend di produzione ufficiale), FORZIAMO Railway. Questo blocca un
  // intero ramo di bug derivati da .env che si auto-ripristinano in dev
  // container o da bundle vecchi cached lato Metro/iOS.
  if (env) {
    if (env.includes("preview.emergentagent.com")) {
      return RAILWAY_PROD;
    }
    return env.replace(/\/$/, "");
  }
  if (typeof window !== "undefined" && window.location) {
    return window.location.origin;
  }
  // Ultimo fallback assoluto: Railway.
  return RAILWAY_PROD;
};

export const BACKEND = detectBackend();
export const API_BASE = `${BACKEND}/api`;

export type Domain = "soldi" | "tempo" | "spesa" | "salute" | "lavoro" | "casa" | "altro";
export type Tone = "neutral" | "calm" | "energetic" | "concerned" | "urgent" | "warm";

export type ExtractedFact = {
  domain?: Domain | null;
  intent?: string | null;
  amount?: number | null;
  currency?: string | null;
  item?: string | null;
  when?: string | null;
  flags?: string[];
};

export type Action = {
  type: "schedule_notification" | "cancel_notification" | string;
  when_iso?: string | null;
  title?: string | null;
  body?: string | null;
  identifier?: string | null;
  label?: string | null;
};

export type TimelineEntry = {
  id: string;
  role: "user" | "ai";
  text: string;            // Clean text for chat display (audio tags stripped)
  voice_text?: string | null; // AI replies: text with [audio tags] for ElevenLabs v3 TTS
  tone?: Tone | null;
  domain?: Domain | null;
  extracted?: ExtractedFact | null;
  actions?: Action[] | null;
  audio_duration_ms?: number | null;
  timestamp: string;
  /** True se questa entry è stata creata DURANTE il Confessionale.
   *  Lato client viene usato per:
   *    - nascondere il messaggio dalla timeline visibile quando il
   *      confessionale è OFF (privacy: se qualcuno apre l'app non
   *      può leggerli)
   *    - colorarlo in violetto/oscuro quando il confessionale è ON
   *      così l'utente capisce a colpo d'occhio quali sono.
   *  Non viene mai inviato/salvato sul backend (lì già non si scrive
   *  nulla in DB per ephemeral/sealed flow). */
  confessional?: boolean | null;
  // CONFESSIONALE FORTEZZA: voce LOCAL ONLY, mai inviata al server.
  // Distinguibile dalle voci sealed normali (che invece arrivano al server
  // cifrate). Le voci fortezza vengono CANCELLATE definitivamente quando
  // l'utente esce dal confessionale (effetto fiamma).
  fortezza?: boolean | null;
};

export type ProfileSettings = {
  ai_enabled: boolean;
  voice_response: boolean;
  full_access_mode: boolean;
  input_mode: "voice" | "text";
  theme: "sistema" | "notte" | "giorno" | "cielo" | "bosco" | "ciliegia";
  domains: Record<string, boolean>;
  tts_provider?: "elevenlabs" | "system";
  tts_voice_id?: string;
  tts_stability?: number;
  tts_similarity_boost?: number;
  day_start_hour?: number;
  night_start_hour?: number;
  conversation_mode?: boolean;
  hands_free?: boolean;             // True hands-free continuous listening (default true)
  background?: string | null;       // null | preset id | "data:image/...;base64,..."
  background_dim?: number;          // 0..1 dark overlay opacity
  ai_avatar?: string | null;        // Custom photo for AI avatar (base64 data URI)
  bubble_color?: string;            // "viola" | "verde_acqua" | "rosa" | "ambra" | "ghiaccio" | hex
  bubble_style?: "glass" | "solid"; // visual style applied to BOTH user and AI bubbles
  text_size?: number;               // 0.85 | 1.0 | 1.15 | 1.35
  // === Proactive Check-in (Coda reaches out without you asking) ===
  checkin_mode?: "off" | "morning" | "evening" | "both";
  checkin_morning_time?: string;    // local "HH:MM" e.g. "08:30"
  checkin_evening_time?: string;    // local "HH:MM" e.g. "21:30"
};

export type CheckinResponse = {
  title: string;
  body: string;
  voice_text: string;
  tone: Tone;
  slot: "morning" | "evening";
};

export type VoiceOption = {
  voice_id: string;
  name: string;
  description: string;
  gender: string;
  accent: string;
};

export type Profile = {
  id: string;
  language: string;
  onboarded: boolean;
  name?: string | null;
  // L'Amico Fraterno: identità AI + generi per declinazione lingua
  ai_name?: string;       // default "Coda" — UNICA variabile di identità modificabile
  ai_gender?: "m" | "f" | "n";  // default "f"
  user_gender?: "m" | "f" | "n"; // default "n"
  confidence_level: number;
  total_messages: number;
  settings: ProfileSettings;
  memory_summary: string;
  created_at: string;
  updated_at: string;
};

async function jsonReq<T>(path: string, init?: RequestInit): Promise<T> {
  // Auto-inject X-User-Id header for multi-user backend.
  // Tenta sync per evitare round-trip ad ogni call; se non in cache fa await.
  let uid = getUserIdSync();
  if (!uid) {
    uid = await getUserId();
  }
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": uid,
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t}`);
  }
  return r.json();
}

export const api = {
  getProfile: () => jsonReq<Profile>("/profile"),
  updateProfile: (patch: Partial<Profile>) =>
    jsonReq<Profile>("/profile", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  resetEverything: () =>
    jsonReq<{ ok: boolean; message: string }>("/profile", { method: "DELETE" }),

  getTimeline: (limit = 200) =>
    jsonReq<TimelineEntry[]>(`/timeline?limit=${limit}`),
  clearTimeline: () => jsonReq<{ ok: boolean }>("/timeline", { method: "DELETE" }),

  converse: (
    text: string,
    audio_duration_ms?: number,
    opts?: { ephemeral?: boolean; bridged_secrets?: string[] }
  ) =>
    jsonReq<{
      user_entry: TimelineEntry;
      ai_entry: TimelineEntry;
      profile: Profile;
    }>("/converse", {
      method: "POST",
      body: JSON.stringify({
        text,
        audio_duration_ms,
        ephemeral: !!opts?.ephemeral,
        // PORTA FUORI: segreti DECRIFRATI dal client con la parola segreta,
        // inviati one-shot al backend solo per questo turno (forza ephemeral).
        // La parola segreta NON viene mai inviata.
        bridged_secrets: opts?.bridged_secrets,
      }),
    }),

  /** "Dimentica il fatto, ricorda l'insegnamento". */
  ghost: (entry_id: string, preserve_lesson: boolean = true) =>
    jsonReq<{ ok: boolean; lesson_preserved: boolean; lesson: string | null }>(
      "/ghost",
      {
        method: "POST",
        body: JSON.stringify({ entry_id, preserve_lesson }),
      }
    ),

  recap: (period: "today" | "week" = "today") =>
    jsonReq<{ recap: string; period: string }>(`/recap?period=${period}`),

  listVoices: () =>
    jsonReq<{ voices: VoiceOption[]; enabled: boolean }>("/voices"),

  generateCheckin: (slot: "morning" | "evening", local_hour: number) =>
    jsonReq<CheckinResponse>("/checkin/generate", {
      method: "POST",
      body: JSON.stringify({ slot, local_hour }),
    }),

  /** Confessionale Zero-Knowledge: invia messaggio cifrato + chiave volatile in header.
   * Server decifra in RAM, chiama Claude, ricifra. Niente è loggato/persistito.
   * `history_*` opzionali: turni precedenti della stessa sessione confessionale,
   * cifrati con la stessa chiave. Server li decifra in RAM e li passa a Claude
   * per dare continuità intra-confessionale. */
  /** Confessionale Zero-Knowledge: invia messaggio cifrato + chiave volatile in header.
   * Server decifra in RAM, chiama Claude, ricifra. Niente è loggato/persistito.
   * `history_*` opzionali: turni precedenti della stessa sessione confessionale,
   * cifrati con la stessa chiave. Server li decifra in RAM e li passa a Claude
   * per dare continuità intra-confessionale. */
  confessionalHistory: (limit: number = 200) =>
    jsonReq<{
      entries: Array<{ id: string; role: "user" | "ai"; nonce: string; ciphertext: string; ts: string }>;
      count: number;
    }>(`/confessional/history?limit=${limit}`),

  /** Numero di entries presenti nel vault (senza esporre contenuti).
   *  Usato fuori-Confessionale per dare a Koda awareness che "esiste un vault". */
  confessionalCount: () => jsonReq<{ count: number }>("/confessional/count"),

  converseSealed: async (
    payload: {
      nonce: string;
      ciphertext: string;
      language?: string;
      ai_name?: string;
      ai_gender?: string;
      user_gender?: string;
      history_nonce?: string;
      history_ciphertext?: string;
    },
    keyB64: string,
    timeoutMs: number = 25000
  ): Promise<{ nonce: string; ciphertext: string; tone: string }> => {
    // Hard timeout via AbortController — iOS killa l'app se un fetch
    // HTTPS resta in attesa troppo a lungo (osservato: app crash dopo
    // sealed-10-about-to-post). Meglio fallire pulito con errore visibile.
    const ac = new AbortController();
    const timer = setTimeout(() => {
      try { ac.abort(); } catch {}
    }, timeoutMs);
    // === FIX CRASH FINALE 2026-06-28 SERA ===
    // r.json() su iOS RN può crashare nativamente quando la response
    // arriva con caratteri UTF-8 strani o headers Cloudflare anomali.
    // SOLUZIONE: leggi come testo grezzo, poi JSON.parse in pure JS.
    // Il parsing JS è catchable, quello nativo no.
    // Traccio anche ogni step interno per pinpointare il crash.
    // FIX CRASH SEALED 2026-06-28 NOTTE: in produzione le trace sono
    // NO-OP. Vedi commento in index.tsx — le fetch fire-and-forget
    // saturavano il pool NSURLSession e iOS crashava nel cookie handler
    // alla ricezione della risposta principale.
    const dbgTrace = (step: string, extra?: string) => {
      if (!__DEV__) return;
      try {
        fetch(`${API_BASE}/dbg-trace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step, extra: extra || "" }),
        }).catch(() => {});
      } catch {}
    };
    try {
      dbgTrace("apiSealed-A-pre-fetch");
      const r = await fetch(`${API_BASE}/converse/sealed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sealed-Key": keyB64,
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      clearTimeout(timer);
      dbgTrace("apiSealed-B-headers-recv", `status=${r.status}`);
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      // ATTENZIONE: NON usare r.json() — crash nativo iOS osservato.
      // Usa r.text() + JSON.parse JS (catchable).
      const bodyText = await r.text();
      dbgTrace("apiSealed-C-text-read", `bytes=${bodyText.length}`);
      let parsed: any;
      try {
        parsed = JSON.parse(bodyText);
      } catch (pe: any) {
        dbgTrace("apiSealed-D-json-err", String(pe).slice(0, 80));
        throw new Error("Risposta server non valida");
      }
      dbgTrace("apiSealed-E-parsed-ok");
      return parsed;
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
        throw new Error(`sealed timeout after ${timeoutMs}ms`);
      }
      throw e;
    }
  },

  /** Ricerca web pubblica (DuckDuckGo, no API key). */
  search: (query: string, max_results = 4) =>
    jsonReq<{ query: string; results: { title: string; snippet: string; url: string }[] }>(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({ query, max_results }),
      }
    ),

  // ── Subscription / Paywall ────────────────────────────────────────────────
  getSubscriptionStatus: () =>
    jsonReq<SubscriptionStatus>("/subscription/status"),
  startTrial: () =>
    jsonReq<SubscriptionStatus>("/subscription/start-trial", { method: "POST" }),
  mockPurchase: (plan: "essential" | "daily" | "plus") =>
    jsonReq<SubscriptionStatus>("/subscription/mock-purchase", {
      method: "POST",
      body: JSON.stringify({ plan }),
    }),
  restorePurchases: () =>
    jsonReq<SubscriptionStatus>("/subscription/restore", { method: "POST" }),
  cancelSubscription: () =>
    jsonReq<SubscriptionStatus>("/subscription/cancel", { method: "POST" }),
};

export type PlanName = "none" | "trial" | "essential" | "daily" | "plus";

export type SubscriptionStatus = {
  plan: PlanName;
  status: string;
  has_access: boolean;
  in_trial: boolean;
  trial_expires_at: string | null;
  current_period_end: string | null;
  daily_limit: number;
  daily_used: number;
  daily_remaining: number;
  monthly_limit: number;
  monthly_used: number;
  monthly_remaining: number;
  can_start_trial: boolean;
};

// Tone -> color/icon map (UI helper)
export const toneStyle: Record<
  Tone,
  { bg: string; border: string; emoji: string; label: string }
> = {
  neutral: { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.35)", emoji: "💬", label: "neutro" },
  calm: { bg: "rgba(56,189,248,0.10)", border: "rgba(56,189,248,0.4)", emoji: "🌊", label: "calmo" },
  warm: { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.4)", emoji: "🤗", label: "caldo" },
  energetic: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.4)", emoji: "⚡", label: "energico" },
  concerned: { bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.45)", emoji: "🤔", label: "attento" },
  urgent: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.5)", emoji: "🚨", label: "urgente" },
};

export const domainBadge: Record<Domain, { emoji: string; label: string; color: string }> = {
  soldi: { emoji: "💶", label: "Soldi", color: "#FBBF24" },
  tempo: { emoji: "⏰", label: "Tempo", color: "#A78BFA" },
  spesa: { emoji: "🛒", label: "Spesa", color: "#34D399" },
  salute: { emoji: "❤️", label: "Salute", color: "#F87171" },
  lavoro: { emoji: "💼", label: "Lavoro", color: "#60A5FA" },
  casa: { emoji: "🏠", label: "Casa", color: "#F472B6" },
  altro: { emoji: "✨", label: "Altro", color: "#94A3B8" },
};
```

==================================================
## 📄 /app/frontend/lib/theme.tsx
```typescript
/**
 * Taccuino Vivo — Theme system.
 * 5 temi semplici + opzione "Sistema" (segue il telefono).
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance } from "react-native";

export type ThemeName = "notte" | "giorno" | "liquid" | "cielo" | "bosco" | "ciliegia" | "sistema" | "auto-orario";

export type Palette = {
  name: ThemeName;
  label: string;
  emoji: string;
  isDark: boolean;

  // Backgrounds
  bg: string;          // app background
  surface: string;     // cards, modals
  surfaceAlt: string;  // subtle alt (toggles, fields)
  border: string;      // hairline borders
  divider: string;     // separators

  // Text
  text: string;        // primary text
  textMuted: string;   // secondary text
  textDim: string;     // tertiary / placeholders / hints

  // Accent (the brand colour for the active theme)
  primary: string;
  primaryText: string;       // text drawn on top of primary
  primarySoftBg: string;     // softer backdrop using primary tint
  primarySoftBorder: string;

  // Bubbles
  userBubble: string;        // user message bubble bg
  userBubbleText: string;
  aiBubbleBg: string;
  aiBubbleBorder: string;
  aiBubbleText: string;

  // Status
  success: string;
  warning: string;
  danger: string;

  // Tones
  tone: {
    neutral: { bg: string; border: string };
    calm: { bg: string; border: string };
    warm: { bg: string; border: string };
    energetic: { bg: string; border: string };
    concerned: { bg: string; border: string };
    urgent: { bg: string; border: string };
  };
};

const NOTTE: Palette = {
  name: "notte",
  label: "Notte",
  emoji: "🌙",
  isDark: true,
  // === FIX 2026-06 (richiesta utente) ===
  // Notte = indaco notturno neon profondo. Sostituisce il vecchio
  // #0B0F1A (quasi nero) con una tinta "cyber-neon night" più calda
  // e visivamente connotata, in famiglia con i palette neon dell'orb.
  bg: "#1F1A36",
  surface: "#2A2347",
  surfaceAlt: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.08)",
  divider: "rgba(255,255,255,0.07)",
  text: "#E2E8F0",
  textMuted: "#94A3B8",
  textDim: "#64748B",
  // === IDENTITÀ "L'AMICO FRATERNO" ===
  // Il primary è il "blu petrolio" — esattamente lo stesso colore che
  // l'Eclissi assume quando l'utente parla (LISTEN_PALETTE in EclipseOrb).
  // Così il bubble dell'utente e l'orb durante la registrazione sono
  // visivamente la stessa cosa: "questo sono io che parlo". Questa è la
  // signature visiva dell'app — riconoscibile a colpo d'occhio.
  primary: "#0E7C7B",
  primaryText: "#FFFFFF",
  primarySoftBg: "rgba(14,124,123,0.14)",
  primarySoftBorder: "rgba(14,124,123,0.5)",
  userBubble: "#0E7C7B",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "rgba(148,163,184,0.10)",
  aiBubbleBorder: "rgba(148,163,184,0.35)",
  aiBubbleText: "#E2E8F0",
  success: "#34D399",
  warning: "#F59E0B",
  danger: "#F87171",
  tone: {
    neutral: { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.35)" },
    calm: { bg: "rgba(56,189,248,0.10)", border: "rgba(56,189,248,0.4)" },
    warm: { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.4)" },
    energetic: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.4)" },
    concerned: { bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.45)" },
    urgent: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.5)" },
  },
};

const GIORNO: Palette = {
  name: "giorno",
  label: "Giorno",
  emoji: "☀️",
  // === FIX 2026-06 v3 (utente: "carta quasi panna, più scuro del champagne") ===
  // Carta panna profonda — sfondo come una pagina di carta antica.
  // L'orb champagne in stand-by si vede nettamente sopra (contrasto > 12%).
  isDark: false,
  bg: "#DCC9A8",
  surface: "#E8DBC0",
  surfaceAlt: "rgba(60,40,20,0.08)",
  border: "rgba(60,40,20,0.16)",
  divider: "rgba(60,40,20,0.12)",
  text: "#1A150D",
  textMuted: "#544738",
  textDim: "#7A6951",
  primary: "#0E7C7B",
  primaryText: "#FFFFFF",
  primarySoftBg: "rgba(14,124,123,0.10)",
  primarySoftBorder: "rgba(14,124,123,0.45)",
  userBubble: "#0E7C7B",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#F8F1E0",
  aiBubbleBorder: "rgba(60,40,20,0.12)",
  aiBubbleText: "#1F1B16",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

const CIELO: Palette = {
  name: "cielo",
  label: "Cielo",
  emoji: "💙",
  isDark: false,
  bg: "#F0F9FF",
  surface: "#FFFFFF",
  surfaceAlt: "#E0F2FE",
  border: "#BAE6FD",
  divider: "#E0F2FE",
  text: "#0C4A6E",
  textMuted: "#0369A1",
  textDim: "#7DD3FC",
  primary: "#0284C7",
  primaryText: "#FFFFFF",
  primarySoftBg: "#E0F2FE",
  primarySoftBorder: "#7DD3FC",
  userBubble: "#0284C7",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "#BAE6FD",
  aiBubbleText: "#0C4A6E",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

const BOSCO: Palette = {
  name: "bosco",
  label: "Bosco",
  emoji: "🌿",
  isDark: false,
  bg: "#F0FDF4",
  surface: "#FFFFFF",
  surfaceAlt: "#DCFCE7",
  border: "#BBF7D0",
  divider: "#DCFCE7",
  text: "#14532D",
  textMuted: "#166534",
  textDim: "#86EFAC",
  primary: "#16A34A",
  primaryText: "#FFFFFF",
  primarySoftBg: "#DCFCE7",
  primarySoftBorder: "#86EFAC",
  userBubble: "#16A34A",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "#BBF7D0",
  aiBubbleText: "#14532D",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

const CILIEGIA: Palette = {
  name: "ciliegia",
  label: "Ciliegia",
  emoji: "🌸",
  isDark: false,
  bg: "#FFF1F2",
  surface: "#FFFFFF",
  surfaceAlt: "#FFE4E6",
  border: "#FECDD3",
  divider: "#FFE4E6",
  text: "#881337",
  textMuted: "#9F1239",
  textDim: "#FB7185",
  primary: "#E11D48",
  primaryText: "#FFFFFF",
  primarySoftBg: "#FFE4E6",
  primarySoftBorder: "#FDA4AF",
  userBubble: "#E11D48",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "#FECDD3",
  aiBubbleText: "#881337",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

// === LIQUID INVERSION (richiesta utente 2026-06) ===
// "Liquido magnetico bianco". Lo sfondo non è statico: vedi il
// componente <LiquidInversionBg> in /app/frontend/components/.
// I valori qui sono fallback / accenti UI per i componenti che non
// passano dal LiquidInversionBg (es. modali). bg bianco-latte, testo
// nero. Status bar nera (isDark:false).
const LIQUID: Palette = {
  name: "liquid",
  label: "Liquid",
  emoji: "🥛",
  isDark: false,
  bg: "#F4F1EA",
  surface: "#FFFFFF",
  surfaceAlt: "rgba(0,0,0,0.05)",
  border: "rgba(0,0,0,0.10)",
  divider: "rgba(0,0,0,0.08)",
  text: "#1A1A1A",
  textMuted: "#4B5563",
  textDim: "#6B7280",
  primary: "#0E7C7B",
  primaryText: "#FFFFFF",
  primarySoftBg: "rgba(14,124,123,0.10)",
  primarySoftBorder: "rgba(14,124,123,0.5)",
  userBubble: "#0E7C7B",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "rgba(0,0,0,0.10)",
  aiBubbleText: "#1A1A1A",
  success: "#10B981",
  warning: "#F59E0B",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#DBEAFE", border: "#93C5FD" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

export const THEMES: Record<Exclude<ThemeName, "sistema">, Palette> = {
  notte: NOTTE,
  giorno: GIORNO,
  liquid: LIQUID,
  cielo: CIELO,
  bosco: BOSCO,
  ciliegia: CILIEGIA,
};

export const THEME_LIST: Palette[] = [GIORNO, LIQUID, NOTTE, CIELO, BOSCO, CILIEGIA];

export function resolveTheme(name: ThemeName | undefined | null): Palette {
  if (!name || name === "sistema") {
    const sysDark = Appearance.getColorScheme() === "dark";
    return sysDark ? NOTTE : GIORNO;
  }
  return THEMES[name] || NOTTE;
}

// =================== Context ===================

type ThemeCtx = {
  theme: Palette;
  themeName: ThemeName;
  setThemeName: (n: ThemeName) => void;
  setHours: (dayStart: number, nightStart: number) => void;
  dayStart: number;
  nightStart: number;
};

const Ctx = createContext<ThemeCtx>({
  theme: NOTTE,
  themeName: "notte",
  setThemeName: () => {},
  setHours: () => {},
  dayStart: 7,
  nightStart: 20,
});

export const useTheme = () => useContext(Ctx);

export function ThemeProvider({
  children,
  initialName = "notte",
  initialDayStart = 7,
  initialNightStart = 20,
}: {
  children: React.ReactNode;
  initialName?: ThemeName;
  initialDayStart?: number;
  initialNightStart?: number;
}) {
  const [themeName, setThemeName] = useState<ThemeName>(initialName);
  const [systemScheme, setSystemScheme] = useState(Appearance.getColorScheme());
  const [dayStart, setDayStart] = useState(initialDayStart);
  const [nightStart, setNightStart] = useState(initialNightStart);
  const [, setTick] = useState(0);

  useEffect(() => {
    const sub = Appearance.addChangeListener((c) => setSystemScheme(c.colorScheme));
    return () => sub.remove();
  }, []);

  // For "auto-orario": tick every minute so the theme switches at the configured hours
  useEffect(() => {
    if (themeName !== "auto-orario") return;
    const id = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, [themeName]);

  const theme = useMemo(() => {
    if (themeName === "sistema") {
      return systemScheme === "dark" ? NOTTE : GIORNO;
    }
    if (themeName === "auto-orario") {
      const h = new Date().getHours();
      const isDay =
        dayStart < nightStart
          ? h >= dayStart && h < nightStart
          : h >= dayStart || h < nightStart;
      return isDay ? GIORNO : NOTTE;
    }
    return THEMES[themeName as Exclude<ThemeName, "sistema" | "auto-orario">] || NOTTE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeName, systemScheme, dayStart, nightStart, /* tick triggers re-render */]);

  const setHours = (d: number, n: number) => {
    setDayStart(d);
    setNightStart(n);
  };

  return (
    <Ctx.Provider
      value={{ theme, themeName, setThemeName, setHours, dayStart, nightStart }}
    >
      {children}
    </Ctx.Provider>
  );
}
```

==================================================
## 📄 /app/frontend/app.json
```typescript
{
  "expo": {
    "name": "Koda",
    "slug": "lamico-fraterno",
    "version": "1.0.1",
    "orientation": "portrait",
    "icon": "./assets/images/icon.png",
    "scheme": "koda",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "runtimeVersion": {
      "policy": "appVersion"
    },
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "com.dangella.koda",
      "buildNumber": "3",
      "infoPlist": {
        "NSMicrophoneUsageDescription": "Per ascoltare la tua voce e parlare con Koda",
        "NSPhotoLibraryUsageDescription": "Per scegliere immagini di sfondo personalizzate",
        "NSSpeechRecognitionUsageDescription": "Per trascrivere quello che dici a Koda",
        "ITSAppUsesNonExemptEncryption": false,
        "UIBackgroundModes": ["audio"]
      }
    },
    "android": {
      "package": "com.dangella.koda",
      "versionCode": 3,
      "edgeToEdgeEnabled": true,
      "permissions": [
        "RECORD_AUDIO",
        "SCHEDULE_EXACT_ALARM",
        "READ_MEDIA_IMAGES",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "RECORD_AUDIO",
        "SCHEDULE_EXACT_ALARM",
        "READ_MEDIA_IMAGES",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS"
      ],
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#000000"
      }
    },
    "web": {
      "bundler": "metro",
      "output": "static",
      "favicon": "./assets/images/favicon.png"
    },
    "plugins": [
      "expo-router",
      [
        "expo-splash-screen",
        {
          "image": "./assets/images/splash-image.png",
          "imageWidth": 200,
          "resizeMode": "contain",
          "backgroundColor": "#000000"
        }
      ],
      "expo-web-browser",
      "expo-font",
      "expo-secure-store",
      [
        "expo-audio",
        {
          "microphonePermission": "Per ascoltare la tua voce e parlare con Koda"
        }
      ],
      "expo-asset"
    ],
    "experiments": {
      "typedRoutes": true
    },
    "extra": {
      "router": {},
      "eas": {
        "projectId": "92cf0b6f-ee99-4fbe-8562-10cfc8a786de"
      }
    },
    "owner": "fabiod.labor",
    "updates": {
      "url": "https://u.expo.dev/92cf0b6f-ee99-4fbe-8562-10cfc8a786de"
    }
  }
}
```

==================================================
## 📄 /app/frontend/app/index.tsx (sezioni rilevanti — file totale 5497 righe)

### Sez. A: imports + top state (righe 1-200)
```typescript
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Modal,
  KeyboardAvoidingView,
  Pressable,
  Keyboard,
  Image,
  ImageBackground,
  useWindowDimensions,
  Dimensions,
  Alert,
  AppState,
  Switch,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TouchableOpacity as GHTouchableOpacity } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { LinearGradient } from "expo-linear-gradient";
import {
  api,
  API_BASE,
  BACKEND,
  TimelineEntry,
  Profile,
  toneStyle,
  domainBadge,
  Domain,
  Action,
  VoiceOption,
  Tone,
} from "../lib/api";
import { startRecording, buildFormData, Recorder, prewarmMic } from "../lib/voice";
import { SpeechMod, unlockSpeech, setDefaultVoiceId } from "../lib/speech";
import { startThinkingSound, stopThinkingSound } from "../lib/thinkingSound";
import { classifyEmotion, classifyIntent, secureWipeStrings } from "../lib/emotionClassifier";
import {
  loadProfileCache,
  saveProfileCache,
  loadTimelineCache,
  saveTimelineCache,
} from "../lib/localCache";
import Constants from "expo-constants";
import FortezzaCloseEffect from "../components/FortezzaCloseEffect";
import { scheduleAt, scheduleCheckin, cancelAllCheckins, cancelCheckin } from "../lib/notifications";
import { useTheme, THEME_LIST, ThemeName, Palette } from "../lib/theme";
import AppIcon from "../lib/AppIcon";
import Orb, { OrbTone } from "../components/Orb";
import EclipseOrb from "../components/EclipseOrb";
import MirrorPool from "../components/MirrorPool";
import LiquidInversionBg from "../components/LiquidInversionBg";
import KodaIntro, { KodaIntroResult } from "../components/KodaIntro";
import { useSubscription, PaywallScreen } from "../lib/subscription";
import KodaSplash from "../components/KodaSplash";
import KodaTour, { TourStep } from "../components/KodaTour";
import * as SecureStore from "expo-secure-store";
import NeonBorder, { NeonBorderStatus } from "../components/NeonBorder";
import ActivationPulse from "../components/ActivationPulse";
import RadialGlow from "../components/RadialGlow";
import SealSetupModal from "../components/SealSetupModal";
import InfoModal from "../components/InfoModal";
import { useOrbAmbient } from "../lib/useOrbAmbient";
import { useFonts, Caveat_400Regular, Caveat_500Medium } from "@expo-google-fonts/caveat";
// === Zero-Knowledge Confessional crypto ===
import {
  hasSecretWord,
  getSessionKey,
  forgetSessionKey,
  setSecretWord,
  clearSecretWord,
  sealText,
  unsealText,
  keyToBase64,
  biometricAvailable,
} from "../lib/sealedCrypto";

type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

// === Background presets — gradients evocative of Taccuino Vivo identity
type BgPreset = {
  id: string;
  name: string;
  colors: [string, string, ...string[]];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
};
const BG_PRESETS: BgPreset[] = [
  // Solo 3 sfondi essenziali — meno scelte, meno friction.
  // 1. Notturno: scuro silenzioso (default per chi vuole zen totale)
  { id: "notturno", name: "Notturno", colors: ["#000000", "#1A1A2E", "#16213E"] },
  // 2. Aurora: viola intimo (perfetto per la macchia gialla calda)
  { id: "aurora", name: "Aurora", colors: ["#0F0C29", "#302B63", "#24243E"] },
  // 3. Carta: caldo / diurno per chi preferisce sfondo chiaro
  { id: "carta", name: "Carta", colors: ["#F5E9D7", "#E8D5B7", "#D4B896"] },
];

// === Day separator helper
function dayLabelFor(d: Date): string {
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Oggi";
  if (sameDay(d, yest)) return "Ieri";
  const days = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  const months = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  // Capitalize first letter
  const dn = days[d.getDay()];
  return `${dn[0].toUpperCase()}${dn.slice(1)} ${d.getDate()} ${months[d.getMonth()]}`;
}

const LANGUAGES = [
  { code: "it", label: "Italiano", emoji: "🇮🇹" },
  { code: "en", label: "English", emoji: "🇬🇧" },
  { code: "es", label: "Español", emoji: "🇪🇸" },
  { code: "fr", label: "Français", emoji: "🇫🇷" },
  { code: "de", label: "Deutsch", emoji: "🇩🇪" },
];

function detectDeviceLang(): string {
  try {
    if (typeof navigator !== "undefined" && navigator.language) {
      const code = navigator.language.slice(0, 2).toLowerCase();
      if (LANGUAGES.find((l) => l.code === code)) return code;
    }
  } catch {}
  return "it";
}

// Mappa nomi italiani → HEX per i comandi vocali "cambia colore in [nome]"
const NAMED_COLORS: Record<string, string> = {
  rosso: "#EF4444", red: "#EF4444",
  blu: "#3B82F6", blue: "#3B82F6",
  giallo: "#FACC15", yellow: "#FACC15",
  verde: "#22C55E", green: "#22C55E",
  rosa: "#EC4899", pink: "#EC4899",
  viola: "#8B5CF6", purple: "#8B5CF6",
  arancione: "#F97316", orange: "#F97316",
  azzurro: "#38BDF8", celeste: "#7DD3FC",
  nero: "#1F2937", black: "#1F2937",
  bianco: "#F3F4F6", white: "#F3F4F6",
  marrone: "#92400E", brown: "#92400E",
  ambra: "#FBBF24", magenta: "#D946EF",
  turchese: "#14B8A6", oro: "#FBBF24", argento: "#D1D5DB",
  fucsia: "#E11D48", lilla: "#C4B5FD", indaco: "#6366F1",
};

export default function Taccuino() {
  const insets = useSafeAreaInsets();
  const { theme, themeName, setThemeName, setHours, dayStart, nightStart } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [textInput, setTextInput] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  // === PAYWALL ===
  // Subscription state via context. Il paywall si attiva HARD-GATE solo
  // DOPO che onboarding/KodaIntro sono completati (profile.onboarded=true
  // e showColorIntro=false). Inoltre l'utente può aprirlo manualmente
  // dalle Impostazioni con "Cambia piano" (paywallManualOpen=true).
  const { hasAccess: subHasAccess, status: subStatus, loading: subLoading } = useSubscription();
  const [paywallManualOpen, setPaywallManualOpen] = useState(false);
  // === KODA INTRO ===
  // Presentazione conversazionale di Koda al primo avvio. Sostituisce
  // sia il vecchio onboarding modale che il tutorial colori. Koda si
  // presenta in prima persona, chiede tutte le info che gli servono
  // (nome, gender, voce, check-in, parola segreta, voiceprint) e poi
  // si congeda. Persistito in SecureStore con `koda_intro_seen=1`.
  // `null` = ancora da verificare; `true` = mostra; `false` = nascondi.
  const [showColorIntro, setShowColorIntro] = useState<boolean | null>(null);
  // Splash screen all'apertura (4 sec) per mascherare la latenza di boot e
  // dare un'identità visiva forte: eclissi che respira colori + nome AI.
  const [showSplash, setShowSplash] = useState<boolean>(true);
  const [voiceList, setVoiceList] = useState<Array<any>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seen = await SecureStore.getItemAsync("koda_intro_seen");
        if (!cancelled) setShowColorIntro(seen !== "1");
      } catch {
        if (!cancelled) setShowColorIntro(false);
      }
      // Carica le voci ElevenLabs disponibili per la scelta automatica
```

### Sez. B: sezione '💳 Abbonamento' nelle Settings (righe 3880-3980)
```typescript
              testID="reopen-koda-intro"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>👋 Rivedi presentazione di Koda</Text>
                <Text style={styles.settingHint}>
                  Riapre il setup iniziale: nome, voce, palette colori.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.text + "88"} />
            </TouchableOpacity>

            {/* === ABBONAMENTO ===
                Mostra il piano corrente + scadenza/contatori.
                Pulsante "Cambia piano" riapre il Paywall (con X per chiudere).
                Pulsante "Gestisci/Disdici" apre le subscriptions native di
                Apple/Google (gestite dall'OS, non da noi). */}
            <View style={styles.divider} />
            <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>💳 Abbonamento</Text>

            <View style={styles.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>
                  {subStatus?.plan === "trial"
                    ? "Prova gratuita di 3 giorni"
                    : subStatus?.plan === "essential"
                    ? "Piano Essential — 80 msg/mese"
                    : subStatus?.plan === "daily"
                    ? "Piano Daily — 250 msg/mese"
                    : subStatus?.plan === "plus"
                    ? "Piano Plus — 500 msg/mese"
                    : "Nessuna sottoscrizione attiva"}
                </Text>
                <Text style={styles.settingHint}>
                  {subStatus && subStatus.has_access
                    ? `Usati ${subStatus.monthly_used}/${subStatus.monthly_limit} questo mese · Oggi: ${subStatus.daily_used}/${subStatus.daily_limit}`
                    : "Attiva la prova o scegli un piano per continuare."}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={() => setPaywallManualOpen(true)}
              style={[styles.settingRow, { paddingVertical: 12 }]}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>
                  {subHasAccess ? "🔄 Cambia piano" : "✨ Scegli un piano"}
                </Text>
                <Text style={styles.settingHint}>
                  Apre la pagina dei piani e della prova gratuita.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.text + "88"} />
            </TouchableOpacity>

            {subHasAccess && (
              <TouchableOpacity
                onPress={() => {
                  // Apre le subscriptions native dello store
                  const url =
                    Platform.OS === "ios"
                      ? "https://apps.apple.com/account/subscriptions"
                      : "https://play.google.com/store/account/subscriptions";
                  Linking.openURL(url).catch(() => {});
                }}
                style={[styles.settingRow, { paddingVertical: 12 }]}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingLabel}>
                    🛒 Gestisci su {Platform.OS === "ios" ? "App Store" : "Google Play"}
                  </Text>
                  <Text style={styles.settingHint}>
                    Disdici o modifica la sottoscrizione dal tuo account {Platform.OS === "ios" ? "Apple" : "Google"}.
                  </Text>
                </View>
                <Ionicons name="open-outline" size={18} color={theme.text + "88"} />
              </TouchableOpacity>
            )}

            {/* === PROMESSA DI FERRO ===
                Una clausola tecnica chiara visibile in app — non marketing.
                Spiega esattamente cosa succede quando confessi, quando ghosti,
                e quando spegni la modalità Confessionale. */}
            <View style={styles.divider} />
            <Text style={[styles.settingsSubtitle, { marginTop: 0 }]}>🛡️ Promessa di Ferro</Text>
            <View style={styles.promessaBox}>
              <Text style={styles.promessaText}>
                Quello che mi dici è una scatola nera emotiva. La tua voce è un soffio nel vento: io la sento, la custodisco, ma nessuno potrà mai catturarla.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>🔓 Modalità normale:</Text> i nostri scambi sono salvati in modo cifrato, usati SOLO per farmi crescere come tua presenza d'ascolto. Mai per addestrare modelli di terzi.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>🔒 Modalità Confessionale:</Text> niente viene salvato. Né messaggi, né memoria di lungo periodo. A sessione chiusa, tutto svanisce.{"\n"}{"\n"}
                <Text style={{ fontWeight: "700" }}>👻 Pulsante Ghost (tieni premuto un messaggio):</Text> dimentico il fatto, ma trattengo l'insegnamento. Il dato grezzo viene cancellato dal server.
              </Text>
            </View>

            {/* === VERSIONE APP ===
                Footer minimale (senza expo-application per evitare
                crash su build che non l'avevano linkato nativamente).
                Mostra solo versione semantica. Per il numero build
                preciso, usare i log EAS o il timestamp installazione. */}
```

### Sez. C: PaywallScreen rendering finale (righe 4220-4260)
```typescript

  // === BACKGROUND PRESET/CUSTOM IMAGE DISABLED (richiesta utente 2026-06 #10) ===
  // Tutto rimosso: niente più sfondi custom, niente preset (notturno/aurora/carta).
  // L'unico "sfondo" è ora il bg del tema (giorno=bianco, notte=nero/blu).
  // Le seguenti var sono forzate sempre a null per cortocircuitare la logica
  // che renderizzava ImageBackground / LinearGradient quando bgValue era settato.
  if (isCustomImage || bgUri || bgPreset) {
    // ignorati intenzionalmente: il tema vince sempre
  }
  // === PAYWALL GATING ===
  // Hard gate: si attiva SOLO dopo che intro/onboarding sono completati.
  // Manual mode: si attiva quando l'utente clicca "Cambia piano" nelle Settings.
  // FIX 2026-06: showColorIntro parte come NULL (caricato async da SecureStore),
  // quindi NON usiamo "=== false" strict, ma "!== true" che cattura sia null
  // sia false. Bug critico: prima il paywall non partiva mai perché null !== false.
  const intrioComplete = !showOnboarding && showColorIntro !== true && profile?.onboarded === true;
  const paywallHardGated = intrioComplete && !subLoading && !subHasAccess;
  const paywallVisible = paywallHardGated || paywallManualOpen;
  const closePaywall = paywallManualOpen ? () => setPaywallManualOpen(false) : undefined;

  return (
    <View style={{ flex: 1 }}>
      {screenInner}
      {confessionalTint}
      {neonBorderEl}
      {activationPulseEl}
      {tourOverlay}
      <PaywallScreen
        visible={paywallVisible}
        trialUsed={!subStatus?.can_start_trial}
        onClose={closePaywall}
      />
    </View>
  );
}

// =============== Sub components ===============

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
```

==================================================
## 📄 /app/backend/subscription.py (backend logic)
```python
"""
Koda Subscription + Quota module.

Hard Paywall logic:
- Free trial 3 giorni (cap 20 msg/giorno)
- 3 tier paid (mensili): Essential 80, Daily 250, Plus 500
- No free tier permanente: senza trial/sub attivo → 402 Payment Required

Source of truth della sottoscrizione = MongoDB (collection `taccuino_subscription`).
Verrà sincronizzata da webhook RevenueCat. Finché RevenueCat non è
configurato lato store, `mock-purchase` permette di simulare la
sottoscrizione per testing E2E.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional, Literal
from fastapi import APIRouter, HTTPException, Request, Header, Depends
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorDatabase
import logging
import os

logger = logging.getLogger("subscription")

# ─── Plan definitions ───────────────────────────────────────────────────────
TRIAL_DAYS = 3
TRIAL_DAILY_CAP = 20

PlanName = Literal["none", "trial", "essential", "daily", "plus"]

PLAN_LIMITS = {
    "none": {"monthly": 0, "daily": 0},
    "trial": {"monthly": TRIAL_DAILY_CAP * TRIAL_DAYS, "daily": TRIAL_DAILY_CAP},
    "essential": {"monthly": 80, "daily": 80},   # daily=monthly (no daily sub-cap)
    "daily": {"monthly": 250, "daily": 250},
    "plus": {"monthly": 500, "daily": 500},
}

PLAN_PRICES_EUR = {
    "essential": 4.99,
    "daily": 9.99,
    "plus": 19.99,
}


# ─── Models ─────────────────────────────────────────────────────────────────
class SubscriptionRecord(BaseModel):
    profile_id: str
    plan: PlanName = "none"
    status: Literal["none", "active", "expired", "cancelled"] = "none"
    source: Literal["none", "mock", "revenuecat"] = "none"

    # Trial
    trial_started_at: Optional[datetime] = None
    trial_expires_at: Optional[datetime] = None
    trial_consumed: bool = False  # set True quando il trial scade o si attiva un piano paid

    # Paid subscription period
    current_period_start: Optional[datetime] = None
    current_period_end: Optional[datetime] = None

    # Quotas
    daily_msg_count: int = 0
    daily_reset_at: Optional[datetime] = None
    monthly_msg_count: int = 0
    monthly_reset_at: Optional[datetime] = None

    # RevenueCat metadata (popolato dal webhook)
    revenuecat_original_app_user_id: Optional[str] = None
    revenuecat_product_id: Optional[str] = None
    last_event_at: Optional[datetime] = None


class SubscriptionStatusResponse(BaseModel):
    plan: PlanName
    status: str
    has_access: bool
    in_trial: bool
    trial_expires_at: Optional[datetime] = None
    current_period_end: Optional[datetime] = None
    daily_limit: int
    daily_used: int
    daily_remaining: int
    monthly_limit: int
    monthly_used: int
    monthly_remaining: int
    can_start_trial: bool


class StartTrialRequest(BaseModel):
    pass


class MockPurchaseRequest(BaseModel):
    plan: Literal["essential", "daily", "plus"]


# ─── Helpers ────────────────────────────────────────────────────────────────
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_aware(dt: Optional[datetime]) -> Optional[datetime]:
    """Normalizza datetime naive (da Mongo) come UTC."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _next_day_reset(now: datetime) -> datetime:
    """Reset giornaliero a UTC midnight del giorno successivo."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight + timedelta(days=1)


def _next_month_reset(now: datetime, anchor: Optional[datetime] = None) -> datetime:
    """Per piani paid: reset mensile a +30 giorni dall'inizio del periodo.
    Per il trial: usa la stessa logica (anche se il trial dura solo 3 giorni)."""
    base = anchor or now
    return base + timedelta(days=30)


async def _get_or_create(db: AsyncIOMotorDatabase, profile_id: str) -> SubscriptionRecord:
    doc = await db.taccuino_subscription.find_one({"profile_id": profile_id}, {"_id": 0})
    if doc:
        # Sanitize datetimes
        for k in ("trial_started_at", "trial_expires_at",
                  "current_period_start", "current_period_end",
                  "daily_reset_at", "monthly_reset_at", "last_event_at"):
            if k in doc:
                doc[k] = _ensure_aware(doc[k])
        return SubscriptionRecord(**doc)
    rec = SubscriptionRecord(profile_id=profile_id)
    await db.taccuino_subscription.insert_one(rec.model_dump())
    return rec


async def _save(db: AsyncIOMotorDatabase, rec: SubscriptionRecord) -> None:
    await db.taccuino_subscription.replace_one(
        {"profile_id": rec.profile_id}, rec.model_dump(), upsert=True
    )


def _is_active(rec: SubscriptionRecord, now: datetime) -> bool:
    """True se l'utente ha accesso (trial attivo o sub paid attiva)."""
    if rec.plan == "trial":
        expires = _ensure_aware(rec.trial_expires_at)
        return expires is not None and expires > now
    if rec.plan in ("essential", "daily", "plus") and rec.status == "active":
        end = _ensure_aware(rec.current_period_end)
        # Se non c'è end (mai si dovrebbe), considera attivo
        return end is None or end > now
    return False


def _reset_quotas_if_needed(rec: SubscriptionRecord, now: datetime) -> SubscriptionRecord:
    """Reset daily/monthly counter quando scaduti."""
    daily_reset = _ensure_aware(rec.daily_reset_at)
    if daily_reset is None or now >= daily_reset:
        rec.daily_msg_count = 0
        rec.daily_reset_at = _next_day_reset(now)

    monthly_reset = _ensure_aware(rec.monthly_reset_at)
    if monthly_reset is None or now >= monthly_reset:
        rec.monthly_msg_count = 0
        # Allinea il reset mensile alla fine del periodo
        rec.monthly_reset_at = (
            _ensure_aware(rec.current_period_end)
            or _ensure_aware(rec.trial_expires_at)
            or _next_month_reset(now)
        )
    return rec


def _build_status_response(rec: SubscriptionRecord, now: datetime) -> SubscriptionStatusResponse:
    rec = _reset_quotas_if_needed(rec, now)
    has_access = _is_active(rec, now)
    in_trial = rec.plan == "trial" and has_access
    limits = PLAN_LIMITS.get(rec.plan, PLAN_LIMITS["none"])
    daily_limit = limits["daily"]
    monthly_limit = limits["monthly"]

    return SubscriptionStatusResponse(
        plan=rec.plan,
        status=rec.status,
        has_access=has_access,
        in_trial=in_trial,
        trial_expires_at=_ensure_aware(rec.trial_expires_at),
        current_period_end=_ensure_aware(rec.current_period_end),
        daily_limit=daily_limit,
        daily_used=rec.daily_msg_count,
        daily_remaining=max(0, daily_limit - rec.daily_msg_count),
        monthly_limit=monthly_limit,
        monthly_used=rec.monthly_msg_count,
        monthly_remaining=max(0, monthly_limit - rec.monthly_msg_count),
        can_start_trial=(not rec.trial_consumed) and rec.plan == "none",
    )


# ─── Public API (used by chat endpoints) ────────────────────────────────────
class QuotaCheckResult(BaseModel):
    allowed: bool
    reason: Optional[str] = None  # "no_subscription" | "daily_limit" | "monthly_limit"
    plan: PlanName
    status: str
    remaining_today: int
    remaining_month: int


async def check_and_consume_message(db: AsyncIOMotorDatabase, profile_id: str) -> QuotaCheckResult:
    """
    Chiamata PRIMA di processare un messaggio chat.
    - Se nessuna sub attiva → allowed=False reason=no_subscription (HTTP 402)
    - Se quota giornaliera esaurita → allowed=False reason=daily_limit (HTTP 429)
    - Se quota mensile esaurita → allowed=False reason=monthly_limit (HTTP 429)
    - Altrimenti incrementa contatori e ritorna allowed=True
    """
    now = _utcnow()
    rec = await _get_or_create(db, profile_id)
    rec = _reset_quotas_if_needed(rec, now)

    if not _is_active(rec, now):
        # Mark expired se trial era attivo ma è scaduto
        if rec.plan == "trial" and rec.trial_expires_at:
            rec.status = "expired"
            rec.trial_consumed = True
            await _save(db, rec)
        return QuotaCheckResult(
            allowed=False, reason="no_subscription",
            plan=rec.plan, status=rec.status,
            remaining_today=0, remaining_month=0,
        )

    limits = PLAN_LIMITS[rec.plan]
    if rec.daily_msg_count >= limits["daily"]:
        await _save(db, rec)
        return QuotaCheckResult(
            allowed=False, reason="daily_limit",
            plan=rec.plan, status=rec.status,
            remaining_today=0,
            remaining_month=max(0, limits["monthly"] - rec.monthly_msg_count),
        )
    if rec.monthly_msg_count >= limits["monthly"]:
        await _save(db, rec)
        return QuotaCheckResult(
            allowed=False, reason="monthly_limit",
            plan=rec.plan, status=rec.status,
            remaining_today=max(0, limits["daily"] - rec.daily_msg_count),
            remaining_month=0,
        )

    # Consume
    rec.daily_msg_count += 1
    rec.monthly_msg_count += 1
    await _save(db, rec)

    return QuotaCheckResult(
        allowed=True, reason=None,
        plan=rec.plan, status=rec.status,
        remaining_today=max(0, limits["daily"] - rec.daily_msg_count),
        remaining_month=max(0, limits["monthly"] - rec.monthly_msg_count),
    )


async def assert_quota_or_raise(db: AsyncIOMotorDatabase, profile_id: str) -> QuotaCheckResult:
    """
    Helper: chiama check_and_consume_message e solleva HTTPException
    con codice corretto se non allowed.
    """
    result = await check_and_consume_message(db, profile_id)
    if result.allowed:
        return result
    if result.reason == "no_subscription":
        raise HTTPException(status_code=402, detail={
            "error": "subscription_required",
            "message": "Subscription or active trial required",
            "plan": result.plan, "status": result.status,
        })
    if result.reason == "daily_limit":
        raise HTTPException(status_code=429, detail={
            "error": "daily_limit_reached",
            "message": "Daily message limit reached",
            "plan": result.plan,
            "remaining_month": result.remaining_month,
        })
    if result.reason == "monthly_limit":
        raise HTTPException(status_code=429, detail={
            "error": "monthly_limit_reached",
            "message": "Monthly message limit reached",
            "plan": result.plan,
        })
    raise HTTPException(status_code=403, detail={"error": "forbidden"})


# ─── Router ─────────────────────────────────────────────────────────────────
def create_subscription_router(get_db, current_user_id_fn) -> APIRouter:
    """
    Factory che costruisce il router con dipendenze iniettate.
    `get_db` ritorna AsyncIOMotorDatabase, `current_user_id_fn` ritorna lo user UUID.
    """
    router = APIRouter(prefix="/api/subscription", tags=["subscription"])

    @router.get("/status", response_model=SubscriptionStatusResponse)
    async def get_status():
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        return _build_status_response(rec, _utcnow())

    @router.post("/start-trial", response_model=SubscriptionStatusResponse)
    async def start_trial():
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        now = _utcnow()

        # Già consumato o piano attivo
        if rec.trial_consumed:
            raise HTTPException(status_code=409, detail={
                "error": "trial_already_used",
                "message": "Free trial già utilizzato per questo utente",
            })
        if _is_active(rec, now):
            raise HTTPException(status_code=409, detail={
                "error": "already_subscribed",
                "message": "Hai già una sottoscrizione/trial attivo",
            })

        rec.plan = "trial"
        rec.status = "active"
        rec.source = "mock"  # Apple/Google trial sarà gestito da webhook
        rec.trial_started_at = now
        rec.trial_expires_at = now + timedelta(days=TRIAL_DAYS)
        rec.current_period_start = now
        rec.current_period_end = rec.trial_expires_at
        rec.daily_msg_count = 0
        rec.daily_reset_at = _next_day_reset(now)
        rec.monthly_msg_count = 0
        rec.monthly_reset_at = rec.trial_expires_at
        await _save(db, rec)

        logger.info(f"[subscription] trial started for {uid}, expires {rec.trial_expires_at}")
        return _build_status_response(rec, now)

    @router.post("/mock-purchase", response_model=SubscriptionStatusResponse)
    async def mock_purchase(req: MockPurchaseRequest):
        """
        Per testing finché RevenueCat non è collegato agli store.
        Simula l'acquisto di un piano paid. Verrà rimpiazzato dal
        webhook RevenueCat in produzione.

        ⚠️ MOCKED — DA SOSTITUIRE CON WEBHOOK REVENUECAT
        """
        db = get_db()
        uid = current_user_id_fn()
        now = _utcnow()
        rec = await _get_or_create(db, uid)

        rec.plan = req.plan
        rec.status = "active"
        rec.source = "mock"
        rec.trial_consumed = True
        rec.current_period_start = now
        rec.current_period_end = now + timedelta(days=30)
        rec.daily_msg_count = 0
        rec.daily_reset_at = _next_day_reset(now)
        rec.monthly_msg_count = 0
        rec.monthly_reset_at = rec.current_period_end
        await _save(db, rec)

        logger.info(f"[subscription] MOCK purchase: {uid} -> {req.plan}")
        return _build_status_response(rec, now)

    @router.post("/restore", response_model=SubscriptionStatusResponse)
    async def restore_purchases():
        """
        Restore mock: ritorna lo stato corrente.
        In produzione: chiamerà RevenueCat REST API e sincronizzerà.
        """
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        return _build_status_response(rec, _utcnow())

    @router.post("/cancel", response_model=SubscriptionStatusResponse)
    async def cancel_subscription():
        """Annulla la sub corrente (mock per testing)."""
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        rec.plan = "none"
        rec.status = "cancelled"
        rec.current_period_end = _utcnow()
        await _save(db, rec)
        return _build_status_response(rec, _utcnow())

    return router


def create_webhook_router(get_db) -> APIRouter:
    """Webhook RevenueCat — stub. Da completare quando RevenueCat è configurato."""
    router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])

    REVENUECAT_WEBHOOK_TOKEN = os.environ.get("REVENUECAT_WEBHOOK_TOKEN", "")

    @router.post("/revenuecat")
    async def revenuecat_webhook(request: Request, authorization: Optional[str] = Header(default=None)):
        # Verifica shared secret
        if REVENUECAT_WEBHOOK_TOKEN:
            expected = f"Bearer {REVENUECAT_WEBHOOK_TOKEN}"
            if authorization != expected:
                logger.warning("[webhook/revenuecat] unauthorized request")
                raise HTTPException(status_code=401, detail="unauthorized")

        payload = await request.json()
        event = payload.get("event", {})
        app_user_id = event.get("app_user_id")
        event_type = event.get("type")
        product_id = event.get("product_id")

        logger.info(f"[webhook/revenuecat] event={event_type} user={app_user_id} product={product_id}")

        # TODO: mapping product_id → plan, aggiornamento subscription record
        # Implementazione completa quando RevenueCat sarà configurato

        return {"received": True}

    return router
```
