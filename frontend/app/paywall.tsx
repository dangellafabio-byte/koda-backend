/**
 * /paywall — Struttura economica finale (Fabio 2026-08-11):
 *
 *   Tier 3 (Mensile / Bimestrale / Annuale) con budget MINUTI dedicati.
 *   Nessun badge "MIGLIORE" / "consigliato" — coerenza con la scelta
 *   commerciale di non spingere aggressivamente l'Annuale (piano
 *   economicamente più fragile).
 *
 *   Prezzi (congelati nel documento economico):
 *     Mensile:    19,99 €/mese   — 90 min base, no carryover
 *     Bimestrale: 35,99 €/2 mesi — 100 min base/mese, carryover 50→mese 2 (picco 150)
 *     Annuale:   209,99 €/anno   — 110 min base/mese, carryover 50+50 su 2 mesi (picco 210 ogni 3)
 *
 *   Nomi voci ("eco"/"aria"/"Acqua"/"Vento") RIMOSSI dalla UI —
 *   identificativi interni maschile/femminile (non user-facing).
 *
 * Bottoni acquisto → RevenueCat SDK (placeholder fino a integrazione).
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
import { kodaBackendHttpUrl } from "../lib/backendUrl";

type PlanId = "monthly" | "bimonthly" | "yearly";

type PlanInfo = {
  id: PlanId;
  label: string;        // es. "Mensile"
  price: string;        // es. "19,99 €"
  priceUnit: string;    // es. "/mese"
  minutesLine: string;  // breve nota su minuti/carryover
};

const PLANS: PlanInfo[] = [
  {
    id: "monthly",
    label: "Mensile",
    price: "19,99 €",
    priceUnit: "/mese",
    minutesLine: "90 minuti al mese",
  },
  {
    id: "bimonthly",
    label: "Bimestrale",
    price: "35,99 €",
    priceUnit: "/2 mesi",
    minutesLine: "100 min/mese · carryover fino a 50 min",
  },
  {
    id: "yearly",
    label: "Annuale",
    price: "209,99 €",
    priceUnit: "/anno",
    minutesLine: "110 min/mese · carryover 50 min su 2 mesi",
  },
];

// === URL Legali (Fabio 2026-07-29) ==========================================
const PRIVACY_URL = kodaBackendHttpUrl("/api/legal/privacy");
const TOS_URL = kodaBackendHttpUrl("/api/legal/terms");

export default function PaywallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  // Default: Bimestrale (piano "centrale" della strategia commerciale,
  // non spinto aggressivamente ma preselezionato per fare da anchor
  // equilibrato senza favorire l'Annuale).
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("bimonthly");
  const [loading, setLoading] = useState(false);
  const [used, setUsed] = useState<number | null>(null);
  // Flag admin/dev override — se true il paywall permette una X sempre
  // funzionante. Per utenti reali con trial expired, la X è nascosta
  // (l'enforcement bloccante è voluto).
  const [devOverride, setDevOverride] = useState<boolean>(false);
  const [trialExpired, setTrialExpired] = useState<boolean>(false);

  useEffect(() => {
    api.freemiumStatus()
      .then((s) => setUsed(s.free_messages_used))
      .catch(() => {});
    // Recupera lo stato trial per decidere se mostrare la X
    api.getTrialState()
      .then((s: any) => {
        setDevOverride(Boolean(s?.dev_override));
        setTrialExpired(s?.trial_state === "expired");
      })
      .catch(() => {});
  }, []);

  const handlePurchase = async () => {
    if (loading) return;
    setLoading(true);
    try {
      // === PLACEHOLDER fino a integrazione react-native-purchases ===
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
    Alert.alert(
      "Ripristino acquisti",
      "Il ripristino sarà disponibile dopo l'attivazione di RevenueCat sul prossimo build nativo."
    );
  };

  const handleClose = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  // La X è visibile SOLO quando: (a) utente non è in trial expired
  // (visita il paywall volontariamente), OPPURE (b) è admin con
  // dev_override attivo che sta testando. Utenti reali con trial
  // expired NON possono chiudere — è l'enforcement voluto.
  const showCloseButton = !trialExpired || devOverride;

  const selected = PLANS.find((p) => p.id === selectedPlan)!;

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 20,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Close button (in alto a destra) — nascosto per utenti reali
            in trial expired. Visibile per navigazione volontaria o dev. */}
        <View style={styles.closeRow}>
          {showCloseButton && (
            <Pressable
              onPress={handleClose}
              hitSlop={20}
              accessibilityRole="button"
              accessibilityLabel="Chiudi"
            >
              <Text style={[styles.closeX, { color: theme.textDim }]}>✕</Text>
            </Pressable>
          )}
        </View>

        {/* Titolo + claim ufficiale */}
        <View style={styles.titleBlock}>
          <Text style={[styles.title, { color: theme.text }]}>Parlare è sempre gratuito.</Text>
          <Text style={[styles.body, { color: theme.textDim }]}>
            Lascia andare resta sempre aperta a tutti.{"\n\n"}
            Koda Premium esiste per chi desidera{" "}
            <Text style={{ color: theme.text, fontWeight: "600" }}>costruire continuità nel tempo</Text>.
          </Text>
        </View>

        {/* Lista benefici Premium — nessun nome di voce esposto */}
        <View style={[styles.benefitsBox, { borderColor: theme.border, backgroundColor: theme.surface }]}>
          <Benefit theme={theme} icon="🧭" text="Ricordare ciò che conta." />
          <Benefit theme={theme} icon="🪡" text="Ritrovare i propri fili." />
          <Benefit theme={theme} icon="🌱" text="Accorgersi di quanto sei cambiato lungo il cammino." />
          <View style={[styles.benefitsDivider, { backgroundColor: theme.border }]} />
          <Text style={[styles.benefitsListTitle, { color: theme.textDim }]}>Sblocchi:</Text>
          <Text style={[styles.benefitsList, { color: theme.text }]}>
            • Memoria completa della Stanza Quotidiana{"\n"}
            • Continuità illimitata{"\n"}
            • Voce di Koda{"\n"}
            • Check-in proattivi{"\n"}
            • Ricerca web in tempo reale
          </Text>
        </View>

        {/* Plan cards — 3 tier, nessun badge fisso */}
        <View style={{ marginTop: 24, gap: 12 }}>
          {PLANS.map((plan) => {
            const isSel = selectedPlan === plan.id;
            return (
              <Pressable
                key={plan.id}
                onPress={() => setSelectedPlan(plan.id)}
                style={[
                  styles.planCard,
                  {
                    borderColor: isSel ? theme.primary : theme.border,
                    backgroundColor: isSel ? theme.primary + "15" : theme.surface,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${plan.label} ${plan.price} ${plan.priceUnit}`}
                accessibilityState={{ selected: isSel }}
              >
                <View style={styles.planHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.planLabel, { color: theme.text }]}>{plan.label}</Text>
                    <Text style={[styles.planHint, { color: theme.textDim }]}>{plan.minutesLine}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={[styles.planPrice, { color: theme.text }]}>{plan.price}</Text>
                    <Text style={[styles.planPriceUnit, { color: theme.textDim }]}>{plan.priceUnit}</Text>
                  </View>
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
            {loading ? "Apertura pagamento…" : `Resta con Koda — ${selected.price}${selected.priceUnit}`}
          </Text>
        </Pressable>
        <Text style={[styles.disclaim, { color: theme.textDim }]}>
          Rinnovo automatico. Cancella quando vuoi in 2 tap dalle impostazioni del telefono.
        </Text>

        {/* Restore */}
        <Pressable onPress={handleRestore} style={styles.restore}>
          <Text style={[styles.restoreText, { color: theme.text }]}>Ripristina acquisti</Text>
        </Pressable>

        {used !== null && used >= 3 && (
          <Text style={[styles.usedNote, { color: theme.textDim }]}>
            Hai usato i tuoi {used} messaggi di prova della Stanza Quotidiana.
            Lascia andare resta aperta.
          </Text>
        )}

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

function Benefit({ theme, icon, text }: { theme: any; icon: string; text: string }) {
  return (
    <View style={styles.benefitRow}>
      <Text style={styles.benefitIcon}>{icon}</Text>
      <Text style={[styles.benefitText, { color: theme.text }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 8, minHeight: 32 },
  closeX: { fontSize: 22, padding: 6 },
  titleBlock: { marginTop: 8, marginBottom: 16 },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5, lineHeight: 34 },
  body: { fontSize: 16, lineHeight: 24, marginTop: 14 },
  benefitsBox: { borderWidth: 1, borderRadius: 16, padding: 18, marginTop: 4 },
  benefitRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 },
  benefitIcon: { fontSize: 18, lineHeight: 24 },
  benefitText: { fontSize: 15, lineHeight: 22, flex: 1, fontWeight: "500" },
  benefitsDivider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  benefitsListTitle: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  benefitsList: { fontSize: 13.5, lineHeight: 22 },
  planCard: { borderWidth: 1.5, borderRadius: 14, padding: 14 },
  planHeader: { flexDirection: "row", alignItems: "flex-start" },
  planLabel: { fontSize: 17, fontWeight: "600" },
  planHint: { fontSize: 12.5, marginTop: 3 },
  planPrice: { fontSize: 22, fontWeight: "700" },
  planPriceUnit: { fontSize: 11, marginTop: -1 },
  cta: { borderRadius: 16, paddingVertical: 16, alignItems: "center", marginTop: 24, minHeight: 56, justifyContent: "center" },
  ctaText: { fontSize: 16, fontWeight: "700" },
  disclaim: { fontSize: 11.5, textAlign: "center", marginTop: 10, lineHeight: 17 },
  restore: { marginTop: 18, alignItems: "center", padding: 10 },
  restoreText: { fontSize: 14, fontWeight: "500", textDecorationLine: "underline" },
  usedNote: { fontSize: 12, textAlign: "center", marginTop: 16, lineHeight: 18, fontStyle: "italic" },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 18, flexWrap: "wrap" },
  legalLink: { fontSize: 12, textDecorationLine: "underline" },
  legalDot: { fontSize: 12 },
});
