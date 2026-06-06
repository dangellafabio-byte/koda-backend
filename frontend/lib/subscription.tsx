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
};

export function PaywallScreen({ visible, trialUsed }: PaywallScreenProps) {
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
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.kicker}>L'AMICO FRATERNO</Text>
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
