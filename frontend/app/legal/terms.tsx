/**
 * app/legal/terms.tsx — v67.4 (Fabio 2026-06-24)
 * -----------------------------------------------------------------------------
 * PLACEHOLDER — Termini di Servizio.
 *
 * Il documento definitivo è attualmente in revisione presso lo studio legale
 * di Fabio. Appena restituito, sostituire INTEGRALMENTE il contenuto della
 * costante `TERMS_PLACEHOLDER_TEXT` qui sotto con il testo definitivo.
 *
 * ⚠️ IMPORTANTE: NON modificare la struttura di routing di questo file
 * (il path /legal/terms è referenziato da LegalConsentScreen, DisclaimerScreen
 * e LoginScreen). Toccare SOLO la costante del contenuto.
 *
 * Il link di contatto per domande legali è `legal@ollenya.com` (da confermare
 * con Fabio prima del go-live).
 */
import React from "react";
import { ScrollView, Text, View, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const TERMS_PLACEHOLDER_TEXT = `
Questo è il testo provvisorio dei Termini di Servizio di Ollenya.

Il documento definitivo, redatto in forma giuridicamente vincolante, è
attualmente in revisione presso lo studio legale di riferimento. Sarà
disponibile in questa stessa pagina a revisione completata, prima del
rilascio pubblico su App Store e Google Play.

I punti principali che il documento disciplinerà:

1. OGGETTO DEL SERVIZIO
   Ollenya è un compagno digitale di ascolto. NON è un servizio sanitario,
   NON è terapia, NON sostituisce il parere di professionisti qualificati
   della salute mentale.

2. ESCLUSIONE DI RESPONSABILITÀ
   L'utente utilizza Ollenya sotto la propria esclusiva responsabilità. Il
   produttore non risponde di scelte personali, conseguenze emotive, danni
   morali o fisici derivanti dall'interazione con il companion digitale.

3. DIVIETO DI USO IN EMERGENZE
   Ollenya non è un servizio di emergenza, non monitora i messaggi in tempo
   reale e non attiva soccorso. In caso di pericolo immediato, pensieri
   autolesionistici o crisi acuta l'utente deve rivolgersi al 112 (Numero
   Unico Emergenze) o al pronto soccorso più vicino.

4. ETÀ MINIMA
   Il servizio è destinato a utenti di almeno 14 anni. Gli utenti tra i
   14 e i 17 anni necessitano del consenso informato di un genitore o
   tutore legale.

5. NATURA DELLE RISPOSTE
   Le risposte di Ollenya sono generate da sistemi di intelligenza
   artificiale. Non costituiscono consulenza medica, psicologica, legale
   o finanziaria. Non seguire le risposte come indicazioni comportamentali
   dirette.

6. ABBONAMENTO E PAGAMENTI
   Condizioni economiche, modalità di rinnovo, recesso e rimborsi sono
   disciplinati dall'App Store / Google Play secondo i rispettivi termini
   di servizio.

7. FORO COMPETENTE
   Per qualunque controversia è competente il foro di [città da definire],
   secondo la legge italiana.

Per qualsiasi domanda legale: legal@ollenya.com
`.trim();

export default function TermsScreen() {
  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={true}
      >
        <View style={styles.draftBanner}>
          <Text style={styles.draftBannerText}>
            BOZZA PROVVISORIA — documento definitivo in revisione legale.
            Non vincolante fino alla pubblicazione della versione finale.
          </Text>
        </View>
        <Text style={styles.body}>{TERMS_PLACEHOLDER_TEXT}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0F0C1C" },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  draftBanner: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: "rgba(250, 204, 21, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(250, 204, 21, 0.40)",
    marginBottom: 20,
  },
  draftBannerText: {
    color: "#FACC15",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  body: {
    color: "rgba(226,232,240,0.90)",
    fontSize: 15,
    lineHeight: 23,
  },
});
