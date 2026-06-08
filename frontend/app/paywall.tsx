/**
 * /paywall — Rotta dedicata per il paywall "Hard Paywall + Freemium Blindato".
 *
 * Strategia (giugno 2026):
 *   1. L'utente ha 3 messaggi gratuiti dopo l'onboarding
 *   2. Al 4° tentativo viene reindirizzato qui da index.tsx
 *   3. Mostriamo i 3 tier (Essential / Daily / Plus) + trial 3 giorni
 *   4. Bottoni acquisto → RevenueCat SDK (da integrare appena Fabio ci dà le chiavi)
 *   5. Restore Purchases obbligatorio per App Store review
 *
 * NOTA: SDK RevenueCat non ancora installato. Per ora i bottoni mostrano
 * un placeholder. Quando configureremo react-native-purchases, l'unico file
 * da toccare sarà questo + un nuovo lib/revenuecat.ts.
 */
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  Linking,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";
import { api } from "../lib/api";

type TierId = "essential" | "daily" | "plus";

type TierInfo = {
  id: TierId;
  name: string;
  tagline: string;
  monthlyMessages: number;
  pricePerMonth: string; // placeholder finché RC non ci dà il prezzo locale
  features: string[];
  highlighted?: boolean;
};

const TIERS: TierInfo[] = [
  {
    id: "essential",
    name: "Essenziale",
    tagline: "Per chi vuole solo l'ascolto",
    monthlyMessages: 80,
    pricePerMonth: "€4,99",
    features: [
      "80 messaggi vocali/testo al mese",
      "Voce premium (Aria o Echo)",
      "Confessionale illimitato",
      "Memoria astratta (Ricordi)",
    ],
  },
  {
    id: "daily",
    name: "Quotidiano",
    tagline: "Per accompagnarti ogni giorno",
    monthlyMessages: 250,
    pricePerMonth: "€9,99",
    features: [
      "250 messaggi al mese",
      "Voce premium (Aria o Echo)",
      "Confessionale illimitato",
      "Memoria + Voiceprint",
      "Check-in proattivi",
    ],
    highlighted: true,
  },
  {
    id: "plus",
    name: "Plus",
    tagline: "Per chi vive Koda come una pratica",
    monthlyMessages: 500,
    pricePerMonth: "€19,99",
    features: [
      "500 messaggi al mese",
      "Tutte le voci sbloccate",
      "Confessionale + Recap settimanali",
      "Memoria lunga + Voiceprint",
      "Supporto prioritario",
    ],
  },
];

const PRIVACY_URL = "https://koda-backend-production-4a34.up.railway.app/legal/privacy";
const TOS_URL = "https://koda-backend-production-4a34.up.railway.app/legal/terms";

export default function PaywallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const [selectedTier, setSelectedTier] = useState<TierId>("daily");
  const [loading, setLoading] = useState(false);
  const [used, setUsed] = useState<number | null>(null);

  useEffect(() => {
    api.freemiumStatus()
      .then((s) => setUsed(s.free_messages_used))
      .catch(() => {});
  }, []);

  const handlePurchase = async () => {
    if (loading) return;
    setLoading(true);
    try {
      // === PLACEHOLDER fino a integrazione react-native-purchases ===
      // Quando RC sarà attivo:
      //   const offerings = await Purchases.getOfferings();
      //   const pkg = offerings.current?.availablePackages.find(p => p.identifier.includes(selectedTier));
      //   const { customerInfo } = await Purchases.purchasePackage(pkg);
      //   await api.subscriptionSync({ entitlement_active: true, tier: selectedTier, ... });
      //   router.back();
      Alert.alert(
        "Pagamento non ancora attivo",
        "Il sistema di pagamento (RevenueCat) verrà attivato al prossimo build nativo. La UI è già pronta.",
        [{ text: "Ho capito", onPress: () => setLoading(false) }],
        { cancelable: false }
      );
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Pagamento non completato");
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    // === PLACEHOLDER ===
    // Quando RC sarà attivo:
    //   const customerInfo = await Purchases.restorePurchases();
    //   if (customerInfo.entitlements.active['daily_access']) router.back();
    Alert.alert(
      "Ripristino acquisti",
      "Il ripristino sarà disponibile dopo l'attivazione di RevenueCat sul prossimo build nativo."
    );
  };

  const handleClose = () => {
    // Solo back: l'utente NON può tornare alla chat senza pagare (se used >= 3 e non subscribed)
    // Per ora permettiamo back per testing. In produzione blocchermo se !subscribed.
    if (router.canGoBack()) router.back();
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 20,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 20,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Close button (in alto a destra) */}
        <View style={styles.closeRow}>
          <Pressable onPress={handleClose} hitSlop={20} accessibilityRole="button" accessibilityLabel="Chiudi">
            <Text style={[styles.closeX, { color: theme.textDim }]}>✕</Text>
          </Pressable>
        </View>

        {/* Title block */}
        <View style={styles.titleBlock}>
          <Text style={[styles.title, { color: theme.text }]}>Resta con Koda</Text>
          <Text style={[styles.subtitle, { color: theme.textDim }]}>
            {used !== null && used >= 3
              ? "Hai usato i tuoi 3 messaggi di prova. Da qui in poi, continuiamo solo se decidi che io meriti il tuo tempo davvero."
              : "Scegli il piano. Cancella quando vuoi."}
          </Text>
        </View>

        {/* Trial highlight */}
        <View style={[styles.trialBox, { borderColor: theme.primary + "55", backgroundColor: theme.primary + "10" }]}>
          <Text style={[styles.trialTitle, { color: theme.text }]}>3 giorni gratis</Text>
          <Text style={[styles.trialNote, { color: theme.textDim }]}>
            Provi senza pagare. Rinnovo automatico solo se decidi di restare. Cancelli quando vuoi in 2 tap dalle impostazioni del telefono.
          </Text>
        </View>

        {/* Tier cards */}
        <View style={{ marginTop: 24, gap: 14 }}>
          {TIERS.map((tier) => {
            const selected = selectedTier === tier.id;
            return (
              <Pressable
                key={tier.id}
                onPress={() => setSelectedTier(tier.id)}
                style={[
                  styles.tierCard,
                  {
                    borderColor: selected ? theme.primary : theme.border,
                    backgroundColor: selected ? theme.primary + "15" : theme.surface,
                  },
                  tier.highlighted && !selected && { borderColor: theme.primary + "55" },
                ]}
              >
                <View style={styles.tierHeader}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={[styles.tierName, { color: theme.text }]}>{tier.name}</Text>
                      {tier.highlighted && (
                        <View style={[styles.popularBadge, { backgroundColor: theme.primary }]}>
                          <Text style={styles.popularText}>più scelto</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.tierTagline, { color: theme.textDim }]}>{tier.tagline}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={[styles.tierPrice, { color: theme.text }]}>{tier.pricePerMonth}</Text>
                    <Text style={[styles.tierPriceUnit, { color: theme.textDim }]}>/mese</Text>
                  </View>
                </View>
                <View style={{ marginTop: 10, gap: 4 }}>
                  {tier.features.map((f, i) => (
                    <Text key={i} style={[styles.tierFeature, { color: theme.text }]}>
                      <Text style={{ color: theme.primary }}>·  </Text>
                      {f}
                    </Text>
                  ))}
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* CTA */}
        <Pressable
          onPress={handlePurchase}
          disabled={loading}
          style={[
            styles.cta,
            { backgroundColor: theme.primary, opacity: loading ? 0.6 : 1 },
          ]}
        >
          <Text style={[styles.ctaText, { color: theme.bg }]}>
            {loading ? "Apertura pagamento…" : "Inizia 3 giorni gratis"}
          </Text>
        </Pressable>
        <Text style={[styles.disclaim, { color: theme.textDim }]}>
          Poi {TIERS.find((t) => t.id === selectedTier)?.pricePerMonth}/mese. Rinnovo automatico. Cancella quando vuoi.
        </Text>

        {/* Restore */}
        <Pressable onPress={handleRestore} style={styles.restore}>
          <Text style={[styles.restoreText, { color: theme.text }]}>Ripristina acquisti</Text>
        </Pressable>

        {/* Legal */}
        <View style={styles.legalRow}>
          <Pressable onPress={() => Linking.openURL(PRIVACY_URL).catch(() => {})}>
            <Text style={[styles.legalLink, { color: theme.textDim }]}>Privacy</Text>
          </Pressable>
          <Text style={[styles.legalDot, { color: theme.textDim }]}>·</Text>
          <Pressable onPress={() => Linking.openURL(TOS_URL).catch(() => {})}>
            <Text style={[styles.legalLink, { color: theme.textDim }]}>Termini</Text>
          </Pressable>
          {Platform.OS === "ios" && (
            <>
              <Text style={[styles.legalDot, { color: theme.textDim }]}>·</Text>
              <Pressable onPress={() => Linking.openURL("https://apps.apple.com/account/subscriptions").catch(() => {})}>
                <Text style={[styles.legalLink, { color: theme.textDim }]}>Gestisci abbonamento</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 8 },
  closeX: { fontSize: 22, padding: 6 },
  titleBlock: { marginTop: 8, marginBottom: 18 },
  title: { fontSize: 30, fontWeight: "600", letterSpacing: -0.5 },
  subtitle: { fontSize: 15, lineHeight: 22, marginTop: 8 },
  trialBox: { borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 8 },
  trialTitle: { fontSize: 17, fontWeight: "600" },
  trialNote: { fontSize: 13, lineHeight: 19, marginTop: 4 },
  tierCard: { borderWidth: 1.5, borderRadius: 16, padding: 16 },
  tierHeader: { flexDirection: "row", alignItems: "flex-start" },
  tierName: { fontSize: 18, fontWeight: "600" },
  tierTagline: { fontSize: 13, marginTop: 2 },
  tierPrice: { fontSize: 20, fontWeight: "700" },
  tierPriceUnit: { fontSize: 11, marginTop: -2 },
  tierFeature: { fontSize: 14, lineHeight: 21 },
  popularBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  popularText: { color: "#000", fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  cta: { borderRadius: 16, paddingVertical: 16, alignItems: "center", marginTop: 24, minHeight: 56, justifyContent: "center" },
  ctaText: { fontSize: 16, fontWeight: "700" },
  disclaim: { fontSize: 11, textAlign: "center", marginTop: 8, lineHeight: 16 },
  restore: { marginTop: 18, alignItems: "center", padding: 10 },
  restoreText: { fontSize: 14, fontWeight: "500", textDecorationLine: "underline" },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 16, flexWrap: "wrap" },
  legalLink: { fontSize: 12, textDecorationLine: "underline" },
  legalDot: { fontSize: 12 },
});
