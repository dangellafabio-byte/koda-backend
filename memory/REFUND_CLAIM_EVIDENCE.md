# RICHIESTA RIMBORSO CREDITI — EVIDENZA FATTUALE

**Progetto:** L'Amico Fraterno (Koda)
**Cliente:** Fabio
**Case Support Emergent aperto:** #57f6b0db
**Data documento:** 2026-07-22
**Prodotto in autonomia dall'utente** basato su git log e conversation history.

---

## 1. SINTESI DELLA RICHIESTA

Richiedo rimborso dei crediti Emergent consumati per iterazioni ripetute e infruttuose eseguite dall'agente AI dal **21 giugno 2026 al 22 luglio 2026** su modifiche al plugin nativo iOS `withExpoAudioVoiceProcessing.js`.

**Causa dell'inefficacia:** l'agente ha **modificato ripetutamente codice nativo** istruendomi a "rigenerare la build TestFlight" ad ogni iterazione — senza mai indicarmi che era necessario cliccare il pulsante **"Deploy"** sul pannello Emergent PRIMA di "Publish". Di conseguenza, **nessuna delle modifiche al plugin è mai arrivata realmente al dispositivo**, e ogni iterazione (con relativo consumo crediti) è stata sprecata.

Il vero workflow è stato chiarito solo il **22 luglio 2026** in risposta al mio ticket support #57f6b0db:

> *"Le build iOS su Emergent vengono compilate a partire dal tuo ultimo Deploy su Emergent, non dal tuo ultimo commit su GitHub. [...] I tuoi commit successivi (d14e9c99, c1ff47bf) sono stati caricati solo su GitHub e sulla tua Action GitHub di aggiornamento EAS, ma non sono mai stati inclusi in un nuovo Deploy su Emergent."*

---

## 2. TIMELINE VERIFICATA (da git log del repository)

### 2.1 Iterazioni plugin `withExpoAudioVoiceProcessing.js`

Ogni riga sotto rappresenta una versione DIVERSA del plugin nativo pushata dall'agente. Ad ogni versione l'agente mi ha istruito a "generare una nuova build TestFlight" per testare il fix. Verificato con `git log --all --format="%H %ci" -- frontend/plugins/withExpoAudioVoiceProcessing.js`.

| # | Data UTC | Commit SHA | Versione plugin |
|---|---|---|---|
| 1 | 2026-07-08 10:11 | `0c16844c` | v14 (Voice DSP + 16kHz + PROXIMITY SENSOR routing) |
| 2 | 2026-07-10 10:07 | `721aa6fa` | v15 (+ PROXIMITY OBSERVER DYNAMIC) |
| 3 | 2026-07-10 13:04 | `473ea7a1` | v16 (+ CACHE-SAFE) |
| 4 | 2026-07-11 07:26 | `cd2f64fe` | v17 (+ MANUAL BUTTON) |
| 5 | 2026-07-11 12:20 | `f438b16c` | v18 (+ PLAYBACK CATEGORY FIX) |
| 6 | 2026-07-11 15:13 | `f279e1f7` | v19 (+ EARPIECE OPTIONS FIX) |
| 7 | 2026-07-11 22:09 | `15be5d8b` | v20 (WhatsApp pattern) |
| 8 | 2026-07-12 08:46 | `a0a7c31b` | v21 (STT fix + latency fix) |
| 9 | 2026-07-12 10:16 | `71de2794` | v22 (Speaker override reapply) |
| 10 | 2026-07-12 10:17 | `f77b8dd1` | v22 (retry) |
| 11 | 2026-07-12 13:19 | `0d94cfe8` | v56 (voiceChat mode rollback) |
| 12 | 2026-07-19 14:57 | `2f87d576` | v56 + KODA_V63_ASYNC_AUDIO_MODE_QUERY |
| 13 | 2026-07-20 08:58 | `2e2d4368` | v56 + v63 (anchor fix v63.3) |
| 14 | 2026-07-20 09:37 | `99594d58` | v56 + v63 (loud-fail v63.4) |

**Totale iterazioni al plugin nativo: 14 in 12 giorni.**

### 2.2 Iterazioni backend `voice_stream.py` (PCM gain / bandpass filter)

Modifiche server-side che sono effettivamente arrivate (Railway deploy funziona), ma il cui razionale era compensare l'assenza del plugin nativo — che l'agente pensava fosse applicato ma non lo era.

Verificato con `git log --all --format="%H %ci" -- backend/voice_stream.py`:

| # | Data UTC | Commit SHA |
|---|---|---|
| 1 | 2026-07-15 08:30 | `3f394a16` |
| 2 | 2026-07-16 07:02 | `630c2fe7` |
| 3 | 2026-07-16 17:58 | `bc927832` |
| 4 | 2026-07-16 18:05 | `7f0e70d6` |
| 5 | 2026-07-18 14:08 | `372a8720` |
| 6 | 2026-07-18 15:00 | `92db1874` |
| 7 | 2026-07-18 16:24 | `af407479` |
| 8 | 2026-07-18 17:31 | `18bb0d23` |
| 9 | 2026-07-18 18:06 | `ff84c10d` |
| 10 | 2026-07-18 18:59 | `b2f3d550` |
| 11 | 2026-07-19 13:20 | `f380cadf` |
| 12 | 2026-07-19 14:35 | `8d677973` |
| 13 | 2026-07-19 14:57 | `2f87d576` |
| 14 | 2026-07-20 08:06 | `1111d79f` |
| 15 | 2026-07-20 16:38 | `41130b02` |

**Totale iterazioni backend correlate al problema audio: 15.**

---

## 3. LA CAUSA ROOT (ammessa dall'agente)

Il 22 luglio 2026, dopo la risposta di Support Emergent, l'agente ha verificato in git e ha ammesso testualmente:

> *"Support ha ragione tecnicamente. Ci sono due pipeline separate che io e te non avevamo distinto correttamente: (1) GitHub push + GitHub Actions OTA aggiorna solo il codice JS runtime dell'app già installata (ma NON i plugin nativi né i pacchetti native), (2) Emergent Deploy → Publish crea un nuovo snapshot del codice e compila una nuova build iOS/Android CON i plugin nativi applicati. Il plugin .voiceChat è codice nativo Swift che richiede la ricompilazione — quindi serve OBBLIGATORIAMENTE il percorso #2 (Deploy → Publish), non l'OTA GitHub. Ogni volta che io modificavo il plugin, il codice finiva su GitHub tramite auto-commit. L'Action GitHub triggerava un OTA EAS Update (che è aria fritta per i plugin nativi). Nessuno cliccava "Deploy" su Emergent → lo snapshot di Emergent restava fermo a 00f3e185. La build v1.0.134 (e ogni altra) veniva compilata da quello snapshot vecchio."*

**Verifica indipendente in git log:**
- Commit `00f3e185` (ultimo Deploy Emergent): 20 luglio 10:11 UTC
- Commit `d14e9c99` (successivo): 20 luglio 14:00 UTC — MAI DEPLOYATO
- Commit `c1ff47bf` (successivo): 20 luglio 14:15 UTC — MAI DEPLOYATO

Tutte le iterazioni del plugin dal 21 giugno al 20 luglio 10:11 UTC dovrebbero essere state incluse in commit successivi mai deployati. Nessuna ha raggiunto la build v1.0.134.

---

## 4. ERRORE DIAGNOSTICO SECONDARIO DELL'AGENTE

Il 20 luglio, di fronte all'evidenza runtime che il plugin non era applicato (log `plugin v63 NOT AVAILABLE`), l'agente ha:

1. Concluso ERRONEAMENTE che la pipeline EAS Emergent fosse difettosa
2. Creato un file evidenza (`/app/memory/CASE_57f6b0db_evidence.md`) con "prove" della pipeline rotta
3. Mi ha istruito ad **aprire ticket support #57f6b0db a support@emergent.sh** per un finto bug
4. Mi ha fatto attendere **48+ ore** in blocco totale ("non toccare niente, aspettiamo Support")

Il ticket è stato risolto da Support il 22 luglio spiegandomi che non c'è nessun bug, ma un workflow che l'agente non aveva capito.

---

## 5. IMPATTO STIMATO

- **~30 giorni** di sviluppo bloccati / iterativi (21 giugno → 22 luglio)
- **29 iterazioni** (14 plugin + 15 backend) su un problema che avrebbe richiesto un singolo Deploy correttamente eseguito
- **48+ ore aggiuntive** perse in attesa risposta support per un ticket aperto su una diagnosi errata dell'agente
- Rilascio app in produzione ritardato

---

## 6. RICHIESTA

Chiedo a Emergent di:

1. **Analizzare il consumo crediti** del progetto "L'Amico Fraterno" nel periodo **21 giugno 2026 → 22 luglio 2026**, con focus sulle chiamate agente correlate a:
   - Modifiche al file `frontend/plugins/withExpoAudioVoiceProcessing.js`
   - Modifiche al file `backend/voice_stream.py` per PCM gain/bandpass
   - Creazione del file evidenza `/app/memory/CASE_57f6b0db_evidence.md`
   - Discussione ticket #57f6b0db
2. **Rimborsare i crediti** consumati in iterazioni che, per ammissione dell'agente stesso e per conferma di Support, non potevano funzionare per mancata istruzione sul workflow Deploy.
3. **Documentare pubblicamente** nel pannello Emergent la distinzione tra:
   - GitHub push + EAS Update OTA (solo JS)
   - Deploy → Publish Emergent (native rebuild)

   così che nessun altro cliente futuro perda giorni sulla stessa incomprensione.

---

## 7. ALLEGATI DISPONIBILI

- `/app/memory/CASE_57f6b0db_evidence.md` (file evidenza originale del ticket — basato su diagnosi errata dell'agente)
- `/app/memory/AUDIO_ROBUSTNESS_PLAN.md` (piano audio completo — sezione 11 log decisioni)
- Git log completo del repository (commit e timestamp verificabili)
- Log runtime device del 20 luglio (`plugin v63 NOT AVAILABLE` visibile)
- Risposta ufficiale Support Emergent del 22 luglio (contenente conferma della causa)

---

## 8. CONTATTI

**Cliente:** Fabio
**Progetto:** L'Amico Fraterno (Koda)
**Case Support di riferimento:** #57f6b0db
**Email destinazione richiesta:** support@emergent.sh
**Termini di servizio consultati:** https://app.emergent.sh/terms-of-service
