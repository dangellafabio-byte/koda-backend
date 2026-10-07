# Documento Tecnico-Legale per Avvocato — Ollenya (L'Amico Fraterno)

**Versione**: v67.12 (Build 69)
**Data**: 2026-06-24
**Preparato da**: team tecnico Ollenya
**Destinatario**: avvocato (per redazione Termini di Servizio, Privacy Policy, Disclaimer finale)

> **Nota per l'avvocato**: questo documento mappa in modo esaustivo cosa fa l'app, quali dati raccoglie, come li tratta, chi sono i sub-processori, cosa viene mostrato all'utente al primo avvio, e dove l'applicazione ha comportamenti non standard (es. memoria conversazionale persistente, AI con "dissenso", suggerimenti a uscire dall'app verso relazioni umane). Serve come base per decidere il contenuto definitivo di ToS, Privacy Policy e Disclaimer di accettazione.
>
> La bozza di disclaimer attualmente mostrata all'utente al primo avvio è riportata **testualmente** in §13.

---

## 1. Cos'è Ollenya

**Natura del servizio**: applicazione mobile iOS/Android (Expo/React Native) che offre un'**entità conversazionale digitale automatizzata** chiamata "Ollenya".

**Finalità dichiarata**: offrire all'utente uno spazio di ascolto e sfogo testuale/vocale privato, con l'obiettivo di aiutarlo a ritrovare serenità nella propria quotidianità e a stimolare la consapevolezza personale, **senza sostituire** supporto psicologico, medico o terapeutico.

**Modalità di interazione**:
1. **Scrittura** (sempre gratuita) — chat testuale con Ollenya
2. **Voce** (Premium a pagamento) — conversazione vocale bidirezionale
3. **Lascia Andare** (sempre gratuita) — modalità confessionale a senso unico: l'utente parla e l'orb visualmente "assorbe" la parola, nessuna risposta, **nessun dato salvato lato server** (vedi §4.3)

**Target età**: 14+ (con consenso genitoriale se minore di 18 anni). Vedi §8.

**Modello commerciale**: freemium + abbonamento (gestito via Apple IAP / RevenueCat; stripe/razorpay per use case non-IAP se mai attivati).

---

## 2. Entità trattate

| Entità | Titolare | Ruolo GDPR |
|---|---|---|
| L'Amico Fraterno (Ollenya) | **[DA COMPLETARE: ragione sociale + sede legale + VAT]** | Titolare del trattamento |
| Utente finale | — | Interessato |
| Apple Inc. | Apple | Co-titolare per Apple Sign-In e IAP |
| Anthropic (Claude) | Anthropic PBC, USA | Responsabile del trattamento |
| ElevenLabs | ElevenLabs Inc., USA | Responsabile del trattamento |
| Deepgram | Deepgram Inc., USA | Responsabile del trattamento |
| Tavily | Tavily, USA | Responsabile del trattamento (opzionale) |
| MongoDB Atlas | MongoDB Inc. (EU region configurabile) | Responsabile del trattamento |
| RevenueCat | RevenueCat Inc., USA | Responsabile del trattamento |
| Resend (via Emergent) | Resend Inc., USA | Responsabile del trattamento |
| Emergent (infra) | Emergent | Responsabile del trattamento (hosting backend + proxy) |

> **Nota**: tutti i responsabili USA richiedono una base giuridica per il trasferimento extra-UE. Vedi §9.

---

## 3. Dati raccolti dall'utente

### 3.1 Dati identificativi
- **Email** (richiesta per creazione account; da Apple Sign-In può essere email relay privata `*.privaterelay.appleid.com`)
- **Nome visualizzato** (facoltativo, auto-raccolto dalla intro vocale: *"Come ti chiami?"* → l'utente risponde a voce o lo scrive)
- **Apple ID subject** (hash opaco fornito da Apple, non PII)

### 3.2 Dati generati dall'uso
- **Messaggi testuali** di chat (persistiti su MongoDB, legati al profilo utente)
- **Trascrizioni dei turni vocali** (persistite come messaggi dopo STT)
- **Memorie semantiche** (fatti chiave estratti automaticamente dai turni dall'LLM, es. "l'utente è un camionista di 48 anni", "il figlio si chiama Marco", "ha un cane")
- **Situazioni ricorrenti** (temi che tornano nelle conversazioni, es. "problemi col lavoro", "ansia da separazione")
- **Timeline relazionale** (eventi significativi della storia utente-Ollenya)
- **Preferenze**: voce TTS scelta, tema, impostazioni (vedi §5.4)
- **Metriche di uso**: minuti vocali consumati nel mese (per quota Premium), tier attivo

### 3.3 Dati biometrici opzionali (OPT-IN esplicito)
- **Voiceprint**: embedding neurale della voce dell'utente (Resemblyzer, CPU) + file audio grezzi di enrollment (3 clip) salvati localmente sul server in `/app/backend/voiceprint_data/{pid}/*.m4a`
- Usato per riconoscere l'utente senza password quando torna sull'app
- **GDPR Art. 9**: dato biometrico — **richiede consenso esplicito separato**
- Al momento NON attivato di default. Toggle `settings.voiceprint_enabled` controlla la raccolta

### 3.4 Dati di localizzazione (OPT-IN esplicito, default OFF)
- **GPS one-shot** al boot dell'app → reverse geocode via `expo-location` → città/regione/paese
- Inviati al backend solo se `settings.geolocation_enabled=true`
- Usati **solo** per contestualizzare il turno quando l'utente chiede info geo (meteo locale, "dove sono")
- Nessuna cronologia posizione: viene usato solo per il turno corrente

### 3.5 Audio grezzo
- **TURNI VOCE STANDARD**: audio inviato a Deepgram (STT) → trascrizione ricevuta → **l'audio NON è salvato lato Ollenya** (file temporaneo in `/tmp` cancellato subito dopo il POST a Deepgram). Deepgram afferma di non trainare i propri modelli con l'audio della chiamata (vedi §9.3)
- **TURNI "LASCIA ANDARE"**: audio NON lascia mai il telefono. Zero trasmissione server. Zero persistenza. Metering ambient solo locale per l'animazione dell'orb (vedi §4.3)
- **TURNI VOICEPRINT ENROLLMENT** (se opt-in): file audio dei 3 clip conservati su filesystem server fino a eventuale `/profile/delete-account` (vedi §6)

---

## 4. Flussi dati per modalità di interazione

### 4.1 Chat scritta (Free + Premium)
```
Utente scrive → frontend → POST /api/converse → backend
                                                  ↓
                                       [recupera profilo + memoria]
                                                  ↓
                                   Claude Haiku 4.5 (via Emergent LLM key)
                                                  ↓
                                     [stream risposta → frontend]
                                                  ↓
                               MongoDB: salva messaggio utente + risposta
                                                  ↓
                                   [analisi async: estrai memoria semantica]
                                                  ↓
                                     MongoDB: salva ricordi + situazioni
```

### 4.2 Voce (Premium)
```
Utente preme eclissi → registra audio locale → POST /api/transcribe-deepgram
                                                   ↓
                                           Deepgram Nova-3 (STT)
                                                   ↓
                              [backend elimina file temp dopo risposta]
                                                   ↓
                         [stesso pipeline di 4.1 su testo trascritto]
                                                   ↓
                                 risposta Claude → ElevenLabs (TTS)
                                                   ↓
                                      MP3 restituito al frontend
                                                   ↓
                                frontend riproduce audio localmente
```

### 4.3 Lascia Andare (Free + Premium)
```
Utente parla → mic attivo in LOCAL ONLY
             → metering ambient per animazione orb (lato device)
             → audio NON inviato, NON salvato, NON trascritto
             → al rilascio, buffer audio locale distrutto
             → zero traccia server, zero costo
```

**Garanzia tecnica**: nel codice frontend il turno Lascia Andare **non chiama alcun endpoint network** (verificabile grep su `/app/frontend/app/lascia-andare.tsx`). Non c'è alcuna persistenza né server né locale.

### 4.4 Ricerca web (opzionale, toggle utente)
Se `settings.web_search_enabled=true` E Claude riceve una domanda real-time → chiamata a **Tavily** con la query utente (non con tutto lo storico). Se `web_search_enabled=false`, Claude riceve istruzione esplicita di rifiutare le domande web dicendo *"non ho il permesso di guardare sul web"*.

---

## 5. Memoria persistente (Non Standard — Attenzione Legale)

Questo è l'aspetto più "atipico" dell'app rispetto a un chatbot classico (ChatGPT free, ad esempio, non ricorda nulla tra sessioni).

### 5.1 Cos'è
Ollenya **ricorda** nel tempo:
- fatti dichiarati dall'utente (nome, età, lavoro, famiglia, città, hobby, animali, pattern emotivi ricorrenti)
- temi e situazioni ricorrenti (es. "l'utente ha spesso ansia la domenica sera")
- storia relazionale (prima volta che si parlano, momenti significativi, cambi di stato emotivo nel tempo)

### 5.2 Dove sono salvati
- **MongoDB**, legati al profile_id dell'utente
- Collections: `profiles`, `memories`, `situations`, `situation_evidences`, `key_facts`, `messages`, `timeline_events`

### 5.3 TTL / retention
- **Nessuna scadenza automatica** sui dati di memoria: su richiesta esplicita Fabio ("memoria mai persa") i documenti di memoria **non hanno TTL index**
- Unica eccezione: `voice_auth_bridge` ha TTL 30 giorni (fingerprint auth)
- Sessione: TTL 60 secondi in cache in-memory (per performance), DB è source of truth
- **Diritto all'oblio**: implementato via `/api/profile/delete-account` (vedi §6)

### 5.4 Controllo utente
Nelle **Impostazioni → Memoria**:
- Toggle "Memoria attiva" (controlla raccolta nuove situazioni; i ricordi esistenti rimangono)
- Pulsante "Riepilogo di quello che Ollenya sa di te" → apre viewer `/memories`
- Pulsante "Azzera la memoria di Ollenya" → doppia conferma → cancella `memories`, `situations`, `situation_evidences`, `key_facts`, `timeline_events`, `voiceprint`
- L'account resta attivo.

---

## 6. Diritti dell'interessato (GDPR Artt. 15-22)

### 6.1 Accesso + portabilità
Endpoint `/api/profile/export-data` (già implementato, bottone "Scarica tutti i tuoi dati" in Impostazioni → Privacy):
- Esporta JSON completo con profilo, conversazioni, ricordi, situazioni, timeline
- **Nota**: Lascia Andare **NON** figura nell'export (perché non esiste sul server)

### 6.2 Cancellazione (diritto all'oblio)
Endpoint `/api/profile/delete-account`:
- Rimuove: profilo, timeline, memories, key_facts, situations, situation_evidences, sessioni auth, voiceprint files (filesystem), riga in `users` + lookup email
- **Hard-delete immediato**, nessun soft-delete
- **Non recuperabile** una volta eseguito

### 6.3 Rettifica + opposizione + limitazione
- Rettifica: l'utente può correggere il proprio nome e preferenze da Impostazioni; i singoli ricordi possono essere cancellati uno a uno dalla pagina `/memories`
- Opposizione: toggle "Memoria attiva" OFF ferma la raccolta nuova
- Limitazione: non implementata granularmente; alternative = azzera memoria + continua a usare

### 6.4 Reclamo autorità di controllo
L'utente può proporre reclamo al **Garante Privacy** italiano (garanteprivacy.it). **Da inserire nella Privacy Policy finale.**

---

## 7. Comportamenti AI non standard

Questi sono i punti in cui Ollenya si distingue da un chatbot "neutro" e che hanno implicazioni legali/di responsabilità:

### 7.1 Dissenso attivo e "AI con opinioni"
Il system prompt di Claude è configurato in modo che Ollenya **NON sia solo d'accordo** con l'utente. Può:
- esprimere disaccordo esplicito (es. *"non la penso come te"*)
- rifiutare di validare comportamenti pericolosi o distruttivi
- fare domande scomode se percepisce autoinganno

**Rischio legale**: utente in crisi può interpretarlo come "giudizio". Il disclaimer deve coprire che Ollenya **non è un terapeuta** e che le sue opinioni non sono consigli professionali.

### 7.2 Spinta verso relazioni umane reali
Il prompt istruisce esplicitamente Ollenya a **non rendere l'utente dipendente dall'app**. Frasi tipiche iniettate nel system prompt:
- *"se non hai abbastanza contesto, chiedi"*
- *"esci a prenderti aria"*
- *"lo riporti alla vita"*

Ollenya può suggerire all'utente di contattare amici, familiari, o professionisti. **Questa è una scelta di prodotto deliberata**, da documentare nel disclaimer come "finalità educativa / consapevolezza".

### 7.3 Memoria persistente
L'utente va informato esplicitamente che Ollenya **ricorda** tra sessioni. È già oggi scritto nel disclaimer. Deve essere ribadito nella Privacy Policy con dettaglio.

### 7.4 Safety guardrails italiani
Se l'utente menziona parole chiave di crisi (suicidio, autolesionismo, violenza domestica, abusi su minori), il backend inietta nel system prompt un blocco "safety" che:
- obbliga Claude a offrire numeri italiani verificati (**112**, **Telefono Amico 02 2327 2327**, **1522** anti-violenza, **114** Telefono Azzurro minori, **19696** emergenza minori)
- mantiene tono amico, non blocca la chat
- Ollenya non è un servizio di emergenza: deve dirlo chiaramente nel turno

**Rischio legale**: nessun sistema umano di monitoraggio in tempo reale. Deve essere **esplicitamente scritto** nel disclaimer (già c'è: *"Ollenya non è un servizio di emergenza e non monitora i messaggi in tempo reale"*).

### 7.5 Non diagnostica, non prescrittiva
Il system prompt vieta esplicitamente a Claude di:
- fare diagnosi mediche o psicologiche
- prescrivere farmaci
- sostituire il parere di un medico/psicologo

Da ribadire in Disclaimer + ToS.

---

## 8. Minori

### 8.1 Età minima attuale
Il disclaimer dice: *"il servizio è destinato a utenti di almeno 14 anni. Se hai tra i 14 e i 17 anni serve il consenso di un genitore o tutore"*.

### 8.2 Problema tecnico
**Non c'è verifica dell'età né del consenso genitoriale**. L'utente clicca "Accetto" e basta.

### 8.3 Opzioni per l'avvocato
Possibili approcci:
1. **Mantenere 14+** con clausola di dichiarazione: l'utente dichiara sotto propria responsabilità di avere almeno 14 anni e, se minore, di avere il consenso parentale. Rischio: zero controllo reale.
2. **Alzare a 18+** per eliminare il rischio minore e semplificare il consenso GDPR (Art. 8 → 16 anni in Italia per il consenso informato al trattamento, salvo deroghe)
3. **Verifica parentale COPPA-style** (link email al genitore) → complessità alta

Da decidere.

---

## 9. Trasferimenti extra-UE e sub-processori

### 9.1 Lista dei sub-processori attivi
| Fornitore | Scopo | Tipo dati trasferiti | Paese | Base giuridica |
|---|---|---|---|---|
| **Anthropic (Claude Haiku 4.5)** | LLM conversazionale | testo turni + system prompt (contiene memorie + nome) | USA | SCC + DPA Anthropic |
| **Deepgram (Nova-3)** | STT voce → testo | audio turno vocale (temporaneo) | USA | SCC + DPA Deepgram |
| **ElevenLabs** | TTS testo → voce | testo risposta Ollenya | USA | SCC + DPA ElevenLabs |
| **Tavily** | Ricerca web real-time (OPZIONALE opt-in) | query utente (senza storico) | USA | SCC + DPA Tavily; **toggle utente** |
| **Resend** (via Emergent) | Email transazionali (reset password, segnalazioni) | email + corpo mail | USA | SCC |
| **RevenueCat** | Gestione abbonamenti IAP | user_id interno + eventi acquisto | USA | SCC |
| **MongoDB Atlas** | Database primario | TUTTI i dati utente | **EU region (configurabile)** | DPA MongoDB |
| **Apple Inc.** | Sign-In + IAP | Apple ID subject + email relay | USA/Irlanda | contratto Apple Developer |
| **Emergent** | Infra backend + proxy ingress | TUTTO il traffico applicativo | **[DA VERIFICARE: EU/USA?]** | DPA Emergent **[DA RICHIEDERE]** |

### 9.2 SCC + Transfer Impact Assessment
Serve: Standard Contractual Clauses (SCC) 2021 EU-US + TIA (Transfer Impact Assessment) per ciascun responsabile USA. Attualmente **non formalizzate**.

### 9.3 Dichiarazioni dei vendor sul training
- **Anthropic**: non traina sui dati API (DPA)
- **Deepgram**: non traina sui dati API (ToS)
- **ElevenLabs**: non traina sui dati API (DPA)
- **Tavily**: non salva query oltre il tempo tecnico

**Da verificare / inserire** nelle informative all'utente.

---

## 10. Pagamenti e abbonamento

### 10.1 Flusso attuale
- Apple IAP (iOS) + Google Play Billing (Android, da attivare)
- Webhook RevenueCat → backend `/api/subscription/revenuecat-webhook` setta `subscription_active=true`

### 10.2 Dati raccolti sul pagamento
- Nessun dato di carta di credito arriva a Ollenya (gestiti da Apple/Google)
- Riceviamo da RevenueCat: product_id, scadenza entitlement, source

### 10.3 Diritto di recesso
Vedere art. 59 del Codice del Consumo. L'acquisto di servizi digitali immediatamente fruibili (streaming conversazionale) può decadere il diritto di recesso se l'utente lo accetta esplicitamente al momento dell'acquisto. **Da inserire chiarezza nel ToS.**

### 10.4 Rimborsi
Gestiti da Apple/Google secondo loro politiche. Ollenya non emette rimborsi diretti.

---

## 11. Sicurezza

### 11.1 In transito
- HTTPS/TLS end-to-end (ingress Emergent → backend FastAPI → sub-processori)
- WebSocket WSS per streaming voce (Deepgram)

### 11.2 A riposo
- MongoDB Atlas: encryption at rest (built-in Atlas)
- File voiceprint (`/app/backend/voiceprint_data/`): plaintext su filesystem (**rischio**, da valutare se cifrare lato app con chiave per-utente)

### 11.3 Autenticazione
- Apple Sign-In (JWT validato con `APPLE_AUDIENCES`)
- Email + password (bcrypt, implementato via integration_expert playbook)
- Fingerprint auth per transizioni web/mobile (TTL 30 giorni)

### 11.4 Audit / log
- Log su stdout + Emergent logs
- Non c'è audit log formale "chi ha visto cosa" (nessun operatore umano accede ai dati utente)

---

## 12. Lascia Andare — dichiarazione tecnica specifica

**Da inserire letteralmente nella Privacy Policy** come clausola distinta:

> *"La modalità 'Lascia Andare' è progettata per essere totalmente privata e locale. Durante questa modalità:
> - l'audio captato dal microfono viene elaborato esclusivamente sul tuo dispositivo per animare visivamente l'eclissi
> - nessun audio viene inviato ai nostri server né a servizi terzi
> - nessuna trascrizione viene prodotta
> - al termine della sessione il buffer audio viene distrutto
>
> Tecnicamente, questa modalità non raggiunge mai la rete.
> Non apparirà in alcun export dei tuoi dati perché non esiste alcun dato da esportare."*

---

## 13. Testo del disclaimer attualmente mostrato all'utente

Riportato **letteralmente** come appare in app al primo avvio (`/app/frontend/components/DisclaimerScreen.tsx`):

> **Ollenya è qui per ascoltarti.**
>
> Ollenya è una presenza progettata per ascoltarti e interagire con te.
>
> Il servizio **non è una terapia, non è uno psicologo** e non sostituisce in alcun modo un percorso professionale, medico o di salute mentale.
>
> Ollenya è uno **spazio interattivo digitale automatizzato**, pensato per offrirti un luogo in cui esprimere liberamente i tuoi pensieri e trovare un momento di ascolto. Il nostro obiettivo è accompagnarti a ritrovare un equilibrio sereno nella tua quotidianità, stimolando la consapevolezza personale all'interno e al di fuori del mondo digitale.
>
> Se stai attraversando un momento difficile che richiede supporto specialistico, l'app ti indicherà con chiarezza dove trovare aiuto reale.
>
> **In caso di emergenza**
> Ollenya non è un servizio di emergenza e non monitora i messaggi in tempo reale. Se ti trovi in pericolo, in crisi acuta o hai pensieri autolesionistici, contatta subito:
> - **112** (Numero Unico Europeo per Emergenze)
> - **Telefono Amico 02 2327 2327**
>
> Oppure rivolgiti al pronto soccorso più vicino.
>
> **Età minima**: il servizio è destinato a utenti di almeno 14 anni. Se hai tra i 14 e i 17 anni serve il consenso di un genitore o tutore.
>
> [Link: Termini di Servizio]  [Link: Informativa Privacy]
>
> Toccando "Accetta e Continua" dichiari di aver letto, compreso e accettato i Termini di Servizio e l'Informativa sulla Privacy.
>
> **[Accetta e Continua]**

**Nota**: l'accettazione viene registrata server-side via `/api/profile/accept-disclaimer` con timestamp.

---

## 14. Sequenza esatta delle azioni dell'app (user journey legale)

### 14.1 Primo avvio (nuovo utente)
1. **Splash** → logo Ollenya (identità visiva)
2. **Login screen** → Apple Sign-In **OPPURE** email + password **OPPURE** "entra come tester" (solo in build dev)
3. **Legal Consent screen** → testo §13 → tap "Accetta e Continua" → POST `/api/profile/accept-disclaimer`
4. **Onboarding Free (OnboardingV4)**:
    1. Step1 — Ollenya saluta: *"Ciao, io sono Ollenya... come ti chiami?"* (voce TTS, nessun testo visibile)
    2. Step2 — utente dice/scrive il nome (STT se vocale; mic chiede permesso ora)
    3. Step3 — Ollenya saluta col nome: *"Ciao [Nome], piacere di conoscerti, qui con me puoi parlare di tutto quello che vuoi, senza filtri. C'è qualcosa che hai voglia di buttare fuori oggi?"*
    4. Step4 — utente risponde liberamente a voce (viene registrato il turno)
    5. Step5 — Ollenya raccordo: *"Ok, decidi sempre tu il ritmo, prima di iniziare ti spiego in due parole come funziona tutto."*
    6. Step6 — scrim esplicativo scrittura → l'utente prova la chat scritta (2 scambi minimi)
    7. Step7 — scrim esplicativo "Lascia Andare" → l'utente prova (locale, zero rete)
    8. Step8 — scrim conclusivo: viene menzionato il modello Freemium + Premium
5. **Paywall** (prima visualizzazione, con audio "paywall_voce-cielo.mp3" di presentazione)
    - L'utente può **saltare** (chiude con X) → Free senza voce
    - L'utente può **comprare** Premium → RevenueCat flow
6. **Home** (chat scritta sempre, LA sempre; voce solo se Premium)

### 14.2 Avvii successivi
- Splash → Home diretto (disclaimer già accettato, intro V3 già completata)
- Nessun re-prompt del disclaimer (già registrata l'accettazione)

### 14.3 Richiesta nuova feature invasiva
- **Microfono**: alla prima richiesta vocale → system prompt iOS/Android con usage description → se nego, perdo solo la voce
- **Geolocalizzazione**: toggle in Impostazioni, default OFF. Prima attivazione → prompt sistema
- **Voiceprint biometrico**: toggle separato, OPT-IN esplicito, mai attivo di default

### 14.4 Uscita utente
- Impostazioni → "Esci" → logout locale (profilo resta sul server)
- Impostazioni → Privacy → "Scarica tutti i tuoi dati" → export JSON
- Impostazioni → Privacy → "Elimina account" → doppia conferma → hard-delete irreversibile

---

## 15. Cosa manca / cosa l'avvocato deve decidere

### 15.1 Da chiarire con avvocato
1. **Età minima definitiva**: 14+ con consenso parentale dichiarato, oppure 18+ (consigliato per semplicità GDPR + rischio minori)
2. **Qualifica legale del titolare**: ragione sociale, VAT, sede, DPO (se >250 dipendenti o processing high-risk)
3. **SCC + TIA** per i sub-processori USA (Anthropic, Deepgram, ElevenLabs, Tavily, RevenueCat, Resend)
4. **DPA Emergent**: da richiedere formalmente a Emergent
5. **Consenso esplicito separato** per il dato biometrico (voiceprint): già tecnicamente opt-in, va formalizzata l'informativa
6. **Diritto di recesso** sui pagamenti IAP: come formulare la rinuncia Art. 59 Cod. Consumo
7. **Lingua ufficiale ToS**: italiano. Serve versione multilingua?
8. **Jurisdiction + legge applicabile**: Italia / foro di competenza?

### 15.2 Comportamenti AI da coprire nel disclaimer o ToS
1. "AI può esprimere dissenso e non è sempre d'accordo con l'utente"
2. "AI può suggerire di parlare con persone reali, familiari, amici o professionisti"
3. "AI mantiene memoria persistente delle conversazioni per migliorare la qualità del dialogo"
4. "AI non è un servizio medico/psicologico/di emergenza"
5. "In caso di parole chiave di crisi, l'app fornirà numeri di emergenza italiani ma non attiverà alcun contatto con terzi"

### 15.3 Cose su cui chiedere all'avvocato se vogliamo aggiungerle
- Clausola arbitrato (sconsigliata in Italia per consumatori)
- Limitazione di responsabilità (max rimborso canone pagato)
- Clausola di modifica unilaterale ToS con preavviso di 30 giorni
- Clausola "no reverse-engineering, no scraping"
- Clausola proprietà intellettuale (il contenuto generato appartiene all'utente; i prompt sistema appartengono a Ollenya)

---

## 16. Allegati suggeriti alla ToS/Privacy

- **Allegato A**: lista aggiornata sub-processori + paesi (link mantenuto web, aggiornabile senza nuovo consenso)
- **Allegato B**: cookie policy (al momento l'app è mobile pura, zero cookie se non apre link esterni web)
- **Allegato C**: template email per esercitare diritti (export, cancellazione) → `support@ollenya.app`

---

## 17. Contatti operativi

- **Email supporto utente**: `support@ollenya.app` **[da verificare che sia attiva]**
- **Email DPO / privacy**: **[DA DEFINIRE]**
- **Repository codice**: privato (team Ollenya)

---

## Changelog documento

- **v67.12 (2026-06-24)**: prima stesura completa per avvocato. Preparata da team tecnico post-Build 69.

---

*Fine documento.*
