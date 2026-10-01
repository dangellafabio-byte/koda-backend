/**
 * app/legal/privacy.tsx — v67.4 (Fabio 2026-06-24)
 * -----------------------------------------------------------------------------
 * PLACEHOLDER — Privacy Policy GDPR.
 *
 * Documento in revisione legale. Appena restituito dallo studio, sostituire
 * SOLO il contenuto della costante `PRIVACY_PLACEHOLDER_TEXT`. Il path di
 * routing è referenziato da LegalConsentScreen, DisclaimerScreen e LoginScreen.
 */
import React from "react";
import { ScrollView, Text, View, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const PRIVACY_PLACEHOLDER_TEXT = `
Questa è una versione provvisoria dell'Informativa Privacy di Ollenya.

Il documento definitivo, redatto in conformità al Regolamento (UE) 2016/679
("GDPR") e al D.lgs. 196/2003 ss.mm.ii., è attualmente in revisione presso
lo studio legale di riferimento. Sarà pubblicato qui a revisione completata.

I contenuti che il documento tratterà:

1. TITOLARE DEL TRATTAMENTO
   Fabio D'Angella (contatti e sede da definire nel documento finale).

2. CATEGORIE DI DATI TRATTATI
   • Dati identificativi forniti al login (email, nome).
   • Contenuto delle conversazioni (testo scritto e trascrizioni audio).
   • Registrazioni vocali temporanee per il riconoscimento del parlato.
   • Metadati tecnici (device, versione app, lingua, timezone).

   ATTENZIONE: le conversazioni possono riguardare la sfera emotiva e la
   salute mentale. Tali informazioni rientrano potenzialmente nelle
   "categorie particolari di dati personali" ex art. 9 GDPR, trattate con
   garanzie rafforzate (crittografia at-rest, server UE, no profilazione).

3. FINALITÀ
   Erogare il servizio di ascolto e risposta personalizzata; conservare
   la memoria delle conversazioni passate per continuità del dialogo;
   migliorare il servizio in forma aggregata/anonima.

4. BASE GIURIDICA
   • Consenso esplicito (art. 6 §1 lett. a GDPR, art. 9 §2 lett. a).
   • Esecuzione del contratto (art. 6 §1 lett. b GDPR).

5. CONSERVAZIONE
   Dati conservati fino alla cancellazione dell'account o alla richiesta
   dell'utente. Durate specifiche definite nel documento finale.

6. DESTINATARI E TRASFERIMENTI
   • Fornitori di modelli di linguaggio e sintesi vocale (Anthropic, OpenAI,
     ElevenLabs, Deepgram), solo nella misura strettamente necessaria.
   • Server di hosting in Unione Europea.
   • Nessuna vendita di dati a terzi, nessun uso per training di modelli di
     intelligenza artificiale di terzi senza consenso esplicito.

7. DIRITTI DELL'INTERESSATO (artt. 15-22 GDPR)
   Accesso, rettifica, cancellazione ("diritto all'oblio"), limitazione,
   portabilità, opposizione, revoca del consenso in qualsiasi momento. Per
   esercitarli: privacy@ollenya.com.

8. ETÀ MINIMA
   Il servizio è destinato a utenti di almeno 14 anni (art. 2-quinquies
   D.lgs. 196/2003). Per utenti tra 14 e 17 anni serve il consenso di un
   genitore/tutore.

9. SICUREZZA
   Crittografia in transito (TLS 1.2+) e crittografia at-rest sui dati
   particolari. Autenticazione OAuth 2.0 (Google / Apple). Registro dei
   trattamenti art. 30 GDPR.

10. RECLAMI
    L'interessato ha diritto di proporre reclamo al Garante per la
    protezione dei dati personali (www.garanteprivacy.it).

Per domande sulla privacy: privacy@ollenya.com
`.trim();

export default function PrivacyScreen() {
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
        <Text style={styles.body}>{PRIVACY_PLACEHOLDER_TEXT}</Text>
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
