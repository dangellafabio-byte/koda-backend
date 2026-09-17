/**
 * /legal-consent — v66.3 (Fabio 2026-06-16)
 * -----------------------------------------------------------------------------
 * Prima schermata in assoluto al primo boot, PRIMA di Splash/Intro e PRIMA
 * di qualunque richiesta di permessi di sistema (mic incluso). Copre 3 cose:
 *   1. Cos'è Ollenya (in negativo: NON è terapia).
 *   2. Numeri di emergenza (SAFETY hard: 112 + Telefono Amico).
 *   3. Consenso esplicito UNICO a Termini + Privacy + registrazione voce/dati.
 *
 * Flag di completamento: SecureStore `legal_consent_at` (ISO string).
 * Il router in app/index.tsx controlla il flag: se assente → /legal-consent;
 * se presente ma intro_v3_completed_at assente → /intro-v3; altrimenti /.
 *
 * Design intenzionale:
 * - Testo asciutto, niente marketing.
 * - Bottone principale DISABILITATO fino al check del box.
 * - Link Termini/Privacy aprono le route esistenti /legal/terms e /legal/privacy.
 * - NIENTE framing "amico fraterno", "benessere", "cura" (feedback Fabio
 *   2026-06-16: zero framing terapeutico/emozionale).
 */

import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  Platform,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";

const TAG = "[LEGAL_CONSENT]";

// Link a policy pubbliche. In app le route /legal/terms e /legal/privacy
// esistono già; in caso di fallback (deep link non risolto) apriamo il web.
const TERMS_URL_WEB = "https://ollenya.com/legal/terms";
const PRIVACY_URL_WEB = "https://ollenya.com/legal/privacy";

export default function LegalConsentScreen() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onOpenTerms = useCallback(async () => {
    try {
      router.push("/legal/terms" as any);
    } catch {
      Linking.openURL(TERMS_URL_WEB).catch(() => {});
    }
  }, [router]);

  const onOpenPrivacy = useCallback(async () => {
    try {
      router.push("/legal/privacy" as any);
    } catch {
      Linking.openURL(PRIVACY_URL_WEB).catch(() => {});
    }
  }, [router]);

  const onCallEmergency = useCallback((num: string) => {
    Linking.openURL(`tel:${num}`).catch(() => {});
  }, []);

  const onAccept = useCallback(async () => {
    if (!checked || submitting) return;
    setSubmitting(true);
    try {
      await SecureStore.setItemAsync("legal_consent_at", new Date().toISOString());
      console.log(`${TAG} accepted → routing to /intro-v3`);
      router.replace("/intro-v3");
    } catch (e) {
      console.warn(`${TAG} SecureStore write failed:`, e);
      // Fail-open: procediamo comunque. Se il device non ha keychain
      // funzionante il router ricadrà su /intro-v3 al prossimo boot.
      router.replace("/intro-v3");
    }
  }, [checked, submitting, router]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0F0C1C" />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons name="information-circle-outline" size={40} color="#D4B896" />
            </View>
            <Text style={styles.title}>Prima di iniziare</Text>
          </View>

          <Text style={styles.paragraph}>
            Ollenya è un compagno digitale che ascolta e risponde.
            {"\n"}
            <Text style={styles.bold}>
              Non è terapia, non sostituisce un professionista della salute mentale, e non fornisce diagnosi né consigli medici.
            </Text>
          </Text>

          <View style={styles.emergencyCard}>
            <Text style={styles.emergencyTitle}>Se stai attraversando un momento difficile</Text>
            <Text style={styles.emergencyBody}>
              Se hai pensieri di farti del male o sei in pericolo, contatta subito:
            </Text>
            <View style={styles.emergencyRow}>
              <TouchableOpacity
                style={styles.emergencyBtn}
                onPress={() => onCallEmergency("112")}
                testID="legal-emergency-112"
                accessibilityLabel="Chiama il 112, numero unico di emergenza"
              >
                <Ionicons name="call-outline" size={16} color="#F5E6CC" />
                <Text style={styles.emergencyBtnText}>112</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.emergencyBtn}
                onPress={() => onCallEmergency("0223272327")}
                testID="legal-emergency-telamico"
                accessibilityLabel="Chiama il Telefono Amico"
              >
                <Ionicons name="call-outline" size={16} color="#F5E6CC" />
                <Text style={styles.emergencyBtnText}>Telefono Amico</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={[styles.paragraph, { marginTop: 8 }]}>
            Per farmi funzionare userò il <Text style={styles.bold}>microfono</Text>{" "}
            e alcuni <Text style={styles.bold}>dati della conversazione</Text>, come descritto nella Privacy Policy. Le conversazioni servono a personalizzare le mie risposte nel tempo — non vengono vendute e non alimentano modelli di terzi.
          </Text>
        </ScrollView>

        {/* Footer: checkbox unico + CTA */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => setChecked((v) => !v)}
            activeOpacity={0.7}
            testID="legal-checkbox"
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            accessibilityLabel="Accetto Termini e Privacy Policy"
          >
            <View style={[styles.checkBox, checked && styles.checkBoxActive]}>
              {checked ? (
                <Ionicons name="checkmark" size={16} color="#1F1A36" />
              ) : null}
            </View>
            <Text style={styles.checkText}>
              Ho letto e accetto i{" "}
              <Text style={styles.linkText} onPress={onOpenTerms}>
                Termini
              </Text>
              {" "}e la{" "}
              <Text style={styles.linkText} onPress={onOpenPrivacy}>
                Privacy Policy
              </Text>
              .
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.ctaBtn, !checked && styles.ctaBtnDisabled]}
            onPress={onAccept}
            disabled={!checked || submitting}
            activeOpacity={0.85}
            testID="legal-cta"
            accessibilityLabel="Iniziamo"
          >
            <Text style={[styles.ctaText, !checked && styles.ctaTextDisabled]}>
              {submitting ? "Un istante…" : "Iniziamo"}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0F0C1C" },
  safe: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 24,
  },
  header: {
    alignItems: "center",
    marginTop: 12,
    marginBottom: 28,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(212,184,150,0.08)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.20)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    color: "#F5E6CC",
    fontSize: 24,
    fontWeight: "600",
    letterSpacing: 0.3,
    textAlign: "center",
  },
  paragraph: {
    color: "rgba(226,232,240,0.85)",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
  },
  bold: { fontWeight: "600", color: "#F5E6CC" },
  emergencyCard: {
    marginTop: 4,
    marginBottom: 16,
    padding: 16,
    borderRadius: 14,
    backgroundColor: "rgba(239,68,68,0.10)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.30)",
  },
  emergencyTitle: {
    color: "#F5E6CC",
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 6,
  },
  emergencyBody: {
    color: "rgba(226,232,240,0.80)",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  emergencyRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  emergencyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "rgba(239,68,68,0.20)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.45)",
  },
  emergencyBtnText: {
    color: "#F5E6CC",
    fontSize: 14,
    fontWeight: "600",
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: Platform.OS === "ios" ? 8 : 20,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
    backgroundColor: "#0F0C1C",
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 14,
    paddingVertical: 4,
  },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "rgba(212,184,150,0.55)",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  checkBoxActive: {
    backgroundColor: "#D4B896",
    borderColor: "#D4B896",
  },
  checkText: {
    flex: 1,
    color: "rgba(226,232,240,0.85)",
    fontSize: 14,
    lineHeight: 20,
  },
  linkText: {
    color: "#D4B896",
    textDecorationLine: "underline",
    fontWeight: "500",
  },
  ctaBtn: {
    height: 54,
    borderRadius: 27,
    backgroundColor: "#D4B896",
    alignItems: "center",
    justifyContent: "center",
  },
  ctaBtnDisabled: {
    backgroundColor: "rgba(212,184,150,0.25)",
  },
  ctaText: {
    color: "#1F1A36",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  ctaTextDisabled: {
    color: "rgba(31,26,54,0.5)",
  },
});
