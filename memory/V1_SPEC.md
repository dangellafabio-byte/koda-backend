================================================================
KODA V1 — SPECIFICA STRUTTURALE DEFINITIVA
================================================================
Documento operativo congelato (giugno 2026).
I principi sono stabili. Le implementazioni possono evolvere.

================================================================
1. POSIZIONAMENTO
================================================================

Koda non è un chatbot generico.
Koda è uno spazio personale assistito.

Funzione:
- conservare ciò che conta
- lasciare andare ciò che non vuoi portarti dietro

Claim principale:

  "Koda.
   Per le cose che vuoi portare con te.
   Per quelle che vuoi lasciare andare."

================================================================
2. ARCHITETTURA — DUE AMBIENTI
================================================================

A. STANZA DELLO SFOGO
   Copy: "Qui puoi pensare ad alta voce senza che questo ti definisca domani."
   - Espressione libera, sfogo, presente
   - Contenuti NON alimentano memoria
   - Contenuti NON costruiscono profilo
   - Niente recupero in conversazioni future
   - Tutto confinato alla sessione

   Regola Madre del modello:
   "Questa risposta sta aiutando l'utente a esprimersi,
    o sta cercando di spiegargli chi è?"

   SE diagnostica / interpreta / etichetta / pseudo-terapia
   → SCARTARE E RIGENERARE

   Il modello DEVE: ascoltare, riflettere, evidenziare,
                   porre domande aperte, favorire espressione.
   Il modello NON DEVE: etichettare, diagnosticare,
                       definire l'identità dell'utente.

B. STANZA QUOTIDIANA
   Copy: "Qui Koda si ricorda di me e unisce i punti nel tempo."
   - Continuità, memoria, crescita
   - Memory engine attivo
   - Check-in proattivi
   - Contesto storico

================================================================
3. PRICING V1 (primi 90 giorni)
================================================================

FREE
- Stanza dello Sfogo: ILLIMITATA
- Stanza Quotidiana: memoria limitata a 3 giorni
- Voce standard

Principio: "Parlare è sempre gratuito."

PREMIUM
- Mensile: 4,99 €
- Annuale: 39,99 €
- Grandfathering attivo per utenti iniziali

Sblocca:
- Memoria completa della Stanza Quotidiana
- Continuità illimitata
- Voce premium
- Check-in proattivi
- Ricerca web
- Future funzionalità premium

Principio: "Premium non serve per parlare. Premium serve per ricordare."

================================================================
4. PAYWALL
================================================================

Titolo:    Parlare è sempre gratuito.

Testo:
La Stanza dello Sfogo resterà sempre aperta a tutti.

Koda Premium esiste per chi desidera costruire continuità nel tempo.

• Ricordare ciò che conta.
• Ritrovare i propri fili.
• Accorgersi di quanto è cambiato lungo il cammino.

================================================================
5. PRIORITÀ TECNICHE
================================================================

#1 — Audio Pipeline
   Target: 1-2 secondi percepiti tra fine parlato e inizio risposta.
   Strumenti:
   - Ottimizzazione VAD
   - Logging completo STT/LLM/TTS
   - Eventuale streaming STT (Deepgram WS)
   - Eventuale streaming TTS (ElevenLabs WS)
   - Misurazione reale dei tempi di pipeline

================================================================
6. METRICHE V1
================================================================

North Star: % utenti che tornano spontaneamente entro 48h dopo
            aver usato la Stanza dello Sfogo.

Secondaria: % utenti che personalizzano il nome di Koda.

================================================================
7. PRINCIPIO OPERATIVO FINALE
================================================================

Non correggere gli utenti. Osservali.
Se usano Koda in modo diverso da quanto previsto:
- NON è un errore.
- È un dato.

I principi sono stabili.
Le implementazioni possono cambiare.

================================================================
FINE DOCUMENTO
================================================================
