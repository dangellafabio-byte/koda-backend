/**
 * DisclaimerScreen — v67.4 (Fabio 2026-06-24)
 * -----------------------------------------------------------------------------
 * Full-screen blocking disclaimer mostrato una SOLA volta al primo accesso.
 *
 * Modifiche v67.4 (feedback Fabio dopo consulenza legale):
 *   1. Bottone "Ho capito" → "Accetta e Continua" (consenso contrattuale,
 *      non più solo presa d'atto intellettuale).
 *   2. Aggiunto blocco EMERGENZE con numeri italiani (112 + Telefono Amico/
 *      Samaritans), rimando a pronto soccorso. Hard CTA tap-to-call.
 *   3. Aggiunta ETÀ MINIMA 14+ (art. 2-quinquies D.lgs. 196/2003, GDPR).
 *   4. Link cliccabili a /legal/terms e /legal/privacy — obbligatori prima
 *      del tap "Accetta e Continua" (vincolo contrattuale).
 *   5. Esplicitata esclusione gestione emergenze/suicidio.
 *
 * ONE-TIME: una volta accettato, il backend salva timestamp + versione
 * (`DISCLAIMER_VERSION`). Finché la versione non cambia lato server, la
 * schermata NON si ripresenta ai boot successivi.
 */

import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../lib/api";
import { APP_BG_INDIGO } from "../lib/uiConstants";

export type DisclaimerScreenProps = {
  /** Chiamato quando l'utente ha tappato "Accetta e Continua" e
   *  l'accettazione è stata registrata correttamente sul backend. */
  onAccepted: () => void;
};

export default function DisclaimerScreen({ onAccepted }: DisclaimerScreenProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const handleAccept = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.acceptDisclaimer();
      onAccepted();
    } catch {
      setSubmitting(false);
      Alert.alert(
        "Connessione richiesta",
        "Non è stato possibile registrare l'accettazione. Verifica la connessione internet e riprova.",
        [{ text: "OK" }]
      );
    }
  };

  const onOpenTerms = useCallback(() => {
    try {
      router.push("/legal/terms");
    } catch {
      Linking.openURL("https://ollenya.com/legal/terms").catch(() => {});
    }
  }, [router]);

  const onOpenPrivacy = useCallback(() => {
    try {
      router.push("/legal/privacy");
    } catch {
      Linking.openURL("https://ollenya.com/legal/privacy").catch(() => {});
    }
  }, [router]);

  const onCallEmergency = useCallback((num: string) => {
    Linking.openURL(`tel:${num}`).catch(() => {});
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24 }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Titolo */}
        <Text style={styles.title}>Ollenya è qui per ascoltarti.</Text>

        {/* Corpo poetico v67.5 (Fabio 2026-06-24, consulenza legale) —
            posizionamento 'presenza interattiva digitale automatizzata'
            + trasparenza tecnologica. Coerente con il system prompt
            (server.py riga 2777: 'lo riporti alla vita', riga 2954-2955:
            'esci a prenderti aria'). */}
        <Text style={styles.paragraph}>
          Ollenya è una presenza progettata per ascoltarti e interagire con te.
        </Text>

        <Text style={styles.paragraph}>
          Il servizio <Text style={styles.bold}>non è una terapia, non è uno psicologo</Text> e non sostituisce in alcun modo un percorso professionale, medico o di salute mentale.
        </Text>

        <Text style={styles.paragraph}>
          Ollenya è uno <Text style={styles.bold}>spazio interattivo digitale automatizzato</Text>, pensato per offrirti un luogo in cui esprimere liberamente i tuoi pensieri e trovare un momento di ascolto. Il nostro obiettivo è accompagnarti a ritrovare un equilibrio sereno nella tua quotidianità, stimolando la consapevolezza personale all'interno e al di fuori del mondo digitale.
        </Text>

        <Text style={styles.paragraph}>
          Se stai attraversando un momento difficile che richiede supporto specialistico, l'app ti indicherà con chiarezza dove trovare aiuto reale.
        </Text>

        {/* === EMERGENZE (v67.4) =============================================
            Blocco hard: Ollenya NON è un servizio di emergenza. Numeri italiani
            + tap-to-call. Testo esplicito su autolesionismo/crisi acuta. */}
        <View style={styles.emergencyCard}>
          <View style={styles.emergencyHeader}>
            <Ionicons name="warning-outline" size={18} color="#FCA5A5" />
            <Text style={styles.emergencyTitle}>In caso di emergenza</Text>
          </View>
          <Text style={styles.emergencyBody}>
            Ollenya non è un servizio di emergenza e non monitora i messaggi in
            tempo reale. Se ti trovi in pericolo, in crisi acuta o hai pensieri
            autolesionistici, contatta subito:
          </Text>
          <View style={styles.emergencyRow}>
            <TouchableOpacity
              style={styles.emergencyBtn}
              onPress={() => onCallEmergency("112")}
              testID="disclaimer-emergency-112"
              accessibilityLabel="Chiama il 112"
            >
              <Ionicons name="call" size={14} color="#F5E6CC" />
              <Text style={styles.emergencyBtnText}>112</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.emergencyBtn}
              onPress={() => onCallEmergency("0223272327")}
              testID="disclaimer-emergency-telamico"
              accessibilityLabel="Chiama Telefono Amico"
            >
              <Ionicons name="call" size={14} color="#F5E6CC" />
              <Text style={styles.emergencyBtnText}>Telefono Amico</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.emergencyFoot}>
            Oppure rivolgiti al pronto soccorso più vicino.
          </Text>
        </View>

        {/* === ETÀ MINIMA + LINK LEGALI (v67.4) ============================== */}
        <Text style={styles.paragraph}>
          <Text style={styles.bold}>Età minima:</Text> il servizio è destinato
          a utenti di almeno 14 anni. Se hai tra i 14 e i 17 anni serve il
          consenso di un genitore o tutore.
        </Text>

        <View style={styles.linksRow}>
          <TouchableOpacity
            onPress={onOpenTerms}
            style={styles.linkBtn}
            testID="disclaimer-link-terms"
          >
            <Ionicons name="document-text-outline" size={16} color="#D4B896" />
            <Text style={styles.linkBtnText}>Termini di Servizio</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onOpenPrivacy}
            style={styles.linkBtn}
            testID="disclaimer-link-privacy"
          >
            <Ionicons name="shield-outline" size={16} color="#D4B896" />
            <Text style={styles.linkBtnText}>Privacy Policy</Text>
          </TouchableOpacity>
        </View>

        {/* Consenso contrattuale esplicito */}
        <View style={styles.consentBox}>
          <Text style={styles.consentText}>
            Toccando <Text style={styles.consentBold}>Accetta e Continua</Text>
            {" "}dichiari di aver letto e accettato i Termini di Servizio e la
            Privacy Policy, e confermi di aver compreso che Ollenya è un
            compagno di ascolto, non un professionista della salute mentale né
            un servizio di emergenza.
          </Text>
        </View>
      </ScrollView>

      {/* Bottone principale fisso in basso */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <TouchableOpacity
          onPress={handleAccept}
          disabled={submitting}
          activeOpacity={0.85}
          style={[styles.acceptBtn, submitting && styles.acceptBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Accetta e continua"
          testID="disclaimer-accept"
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.acceptBtnText}>Accetta e Continua</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: APP_BG_INDIGO },
  scrollContent: { paddingHorizontal: 28, paddingTop: 8 },
  title: {
    color: "#FFFFFF",
    fontSize: 26,
    fontWeight: "700",
    lineHeight: 34,
    marginBottom: 24,
    letterSpacing: 0.2,
  },
  paragraph: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 16,
  },
  paragraphEmphasis: {
    color: "#FFFFFF",
    fontSize: 17,
    lineHeight: 26,
    marginBottom: 16,
    fontWeight: "500",
  },
  bold: { fontWeight: "600", color: "#F5E6CC" },

  // Emergenze
  emergencyCard: {
    marginTop: 8,
    marginBottom: 20,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "rgba(239,68,68,0.10)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.35)",
  },
  emergencyHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  emergencyTitle: {
    color: "#FCA5A5",
    fontSize: 15,
    fontWeight: "700",
  },
  emergencyBody: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  emergencyRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 8,
  },
  emergencyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "rgba(239,68,68,0.22)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.5)",
  },
  emergencyBtnText: { color: "#F5E6CC", fontSize: 14, fontWeight: "700" },
  emergencyFoot: {
    color: "rgba(255,255,255,0.60)",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },

  // Link legali
  linksRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  linkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(212,184,150,0.10)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.35)",
  },
  linkBtnText: {
    color: "#D4B896",
    fontSize: 14,
    fontWeight: "600",
    textDecorationLine: "underline",
  },

  // Consenso box
  consentBox: {
    marginTop: 4,
    marginBottom: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  consentText: { color: "rgba(255,255,255,0.75)", fontSize: 14, lineHeight: 21 },
  consentBold: { color: "#FFFFFF", fontWeight: "700" },

  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
    backgroundColor: APP_BG_INDIGO,
  },
  acceptBtn: {
    backgroundColor: "#8B5CF6",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  acceptBtnDisabled: { opacity: 0.6 },
  acceptBtnText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
});
