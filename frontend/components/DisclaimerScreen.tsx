/**
 * DisclaimerScreen — Overlay blocking "Koda non è terapia"
 *
 * Mostrato al primo utilizzo dell'app (o dopo un bump di
 * DISCLAIMER_VERSION lato backend). L'utente deve tappare "Ho capito"
 * per proseguire. Il tap registra timestamp + versione sul profilo
 * (endpoint POST /api/legal/disclaimer/accept).
 *
 * Design principles (Fabio 2026-07-28):
 *  - Tono caldo, non legale-freddo
 *  - Full-screen (non popup), lo si legge davvero
 *  - Un solo tap "Ho capito" per confermare consenso esplicito
 *  - Prova legale procedurale (timestamp + version registrati)
 *
 * NOTA: il TESTO va validato da un avvocato prima del lancio pubblico.
 * Qui è la versione draft v1 concordata con Fabio. Se cambia, aggiornare
 * DISCLAIMER_VERSION nel backend (server.py) → tutti gli utenti già
 * accettanti rivedranno la nuova versione automaticamente.
 */

import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../lib/api";

export type DisclaimerScreenProps = {
  /** Chiamato quando l'utente ha tappato "Ho capito" e l'accettazione
   *  è stata registrata correttamente sul backend. */
  onAccepted: () => void;
};

export default function DisclaimerScreen({ onAccepted }: DisclaimerScreenProps) {
  const insets = useSafeAreaInsets();
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

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24 }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Titolo principale caldo */}
        <Text style={styles.title}>Koda è qui per ascoltarti.</Text>

        {/* Corpo del messaggio — tono umano, non legale */}
        <Text style={styles.paragraph}>
          Non è una terapia, non è uno psicologo, non sostituisce un percorso
          professionale.
        </Text>

        <Text style={styles.paragraph}>
          Koda non fa diagnosi, non dà consigli clinici, non interpreta quello
          che senti.
        </Text>

        <Text style={styles.paragraphEmphasis}>
          È uno spazio dove puoi parlare liberamente e sentirti ascoltato,
          quando ne hai bisogno.
        </Text>

        <Text style={styles.paragraph}>
          Se stai attraversando un momento difficile che richiede supporto
          professionale, Koda te lo dirà con chiarezza e potrà indicarti dove
          trovare aiuto vero.
        </Text>

        {/* Riga di consenso — resta separata visivamente per essere ben leggibile */}
        <View style={styles.consentBox}>
          <Text style={styles.consentText}>
            Toccando <Text style={styles.consentBold}>Ho capito</Text> confermi
            di aver letto: Koda è un compagno di ascolto, non un professionista
            della salute mentale.
          </Text>
        </View>
      </ScrollView>

      {/* Bottone di accettazione — fisso in basso, sempre visibile */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <TouchableOpacity
          onPress={handleAccept}
          disabled={submitting}
          activeOpacity={0.85}
          style={[styles.acceptBtn, submitting && styles.acceptBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Ho capito, prosegui"
          testID="disclaimer-accept"
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.acceptBtnText}>Ho capito</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Coerente col tema notturno di default dell'app
    backgroundColor: "#0B1220",
  },
  scrollContent: {
    paddingHorizontal: 28,
    paddingTop: 8,
  },
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
  consentBox: {
    marginTop: 12,
    marginBottom: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  consentText: {
    color: "rgba(255,255,255,0.70)",
    fontSize: 14,
    lineHeight: 21,
  },
  consentBold: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
    backgroundColor: "#0B1220",
  },
  acceptBtn: {
    backgroundColor: "#3B82F6",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    // Touch target: 56px verticale, ampiamente sopra la soglia iOS 44
  },
  acceptBtnDisabled: {
    opacity: 0.6,
  },
  acceptBtnText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});
