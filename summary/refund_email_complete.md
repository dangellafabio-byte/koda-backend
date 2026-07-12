# RICHIESTA DI RIMBORSO CREDITI EMERGENT — DOCUMENTO COMPLETO

**Destinatario:** support@emergent.sh
**Oggetto suggerito email:** `[REFUND REQUEST] Credits refund — L'Amico Fraterno (Koda) — failed iOS builds v50-v55 — feature abandoned`
**Data documento:** 2026-07-13
**Versione documento:** 1.0

---

## ⚠️ NOTA IMPORTANTE PER L'UTENTE (Fabio)

**PRIMA di inviare questa mail, compila i CAMPI DA COMPILARE segnati con `[COMPILA]` più sotto.**
Le informazioni tecniche sono già complete — servono solo i tuoi dati account, date esatte e conteggio crediti che vedi nella dashboard Emergent.

Se il supporto ti chiede altre informazioni, TUTTE le risposte tecniche sono già in questo documento — puoi copiare/incollare i blocchi rilevanti.

---

## 1. IDENTIFICAZIONE ACCOUNT E PROGETTO

### Dati account Emergent
- **Email account Emergent:** `[COMPILA — è la mail Apple relay tipo xxx@privaterelay.appleid.com, oppure la mail principale se l'hai poi collegata]`
- **Email di contatto preferita per la risposta:** `[COMPILA — se diversa dalla mail Apple, es. la tua mail personale principale]`
- **Metodo di autenticazione all'account Emergent:** **Sign in with Apple** (importante: NON email/password diretta — l'account è stato creato via Apple ID)
- **Apple ID (se richiesto per verifica):** `[COMPILA se il supporto lo chiede — è la mail iCloud collegata al tuo Apple ID]`
- **Nome completo:** `[COMPILA]`
- **Paese:** Italia
- **Dashboard Emergent link (se disponibile):** `[COMPILA — es. https://app.emergent.sh/profile o simile]`

### Nota importante sulla mail
> **L'account Emergent NON è collegato alla mia mail principale.** Quando ho fatto il primo login ho scelto "Sign in with Apple", quindi l'email registrata sul sistema Emergent è l'Apple Private Relay (`xxx@privaterelay.appleid.com`) o l'email iCloud collegata al mio Apple ID. Se non trovate l'account cercando la mia mail principale, cercatelo con `[COMPILA la mail Apple relay o iCloud]`. Se ancora non lo trovate, verificate per Apple ID di primo login.

### Dati progetto
- **Nome progetto:** L'Amico Fraterno (nome interno: **Koda**)
- **Tipo:** App mobile React Native / Expo (iOS + Android) con backend FastAPI + MongoDB
- **URL app deployata (backend):** `https://app-finder-408.emergent.host`
- **URL alternativi noti:** `wss://app-finder-408.emergent.host/api/voice/stream` (WebSocket voice), `https://app-finder-408.emergent.host/api/_version` (endpoint versione)
- **Preview URL Emergent (se applicabile):** `[COMPILA se lo trovi in dashboard]`
- **Data creazione progetto:** `[COMPILA se lo ricordi/lo trovi in dashboard]`

---

## 2. RIASSUNTO DELLA RICHIESTA IN 3 RIGHE

Ho consumato tra **5 e 6 build iOS native EAS + parecchi crediti LLM** in ~6 iterazioni consecutive (build v50 → v55) su una singola feature (pulsante audio "Modalità Telefono" per commutare fra auricolare e altoparlante iPhone). **Ogni iterazione ha peggiorato lo stato dell'app** invece di risolvere. Alla fine, dopo 5+ fallimenti, ho ordinato all'agente di **rimuovere completamente la feature** e ripristinare lo stato stabile precedente — rollback eseguito con successo il 2026-07-13.

**Chiedo il rimborso dei crediti spesi nelle iterazioni fallite v51 → v55**, in quanto imputabili a implementazione difettosa dell'agente Emergent, non a errori dell'utente.

---

## 3. STORICO DETTAGLIATO DELLE BUILD FALLITE

### Contesto: cosa avevo chiesto
> "Voglio un pulsante che permetta di alternare fra auricolare (come una telefonata) e altoparlante durante la conversazione con Koda, senza rompere il loop vocale hands-free. Analoga funzione di WhatsApp/Telegram/FaceTime."

Requisito **legittimo e ragionevole**.

### Cronologia iterazioni

| Build | Data (approx) | Approccio agente | Risultato | Bug introdotti |
|---|---|---|---|---|
| **v50** | `[COMPILA data]` | Baseline stabile pre-modifica. Solo `.voiceChat` mode. | ✅ Loop vocale funzionante. | Nessuno (baseline) |
| **v51** | `[COMPILA data]` | Prima implementazione: `AsyncFunction("kodaSetAudioOutput")` iniettata in AudioModule.swift via Config Plugin. UserDefaults key `KodaAudioOverrideMode`. | ❌ Pulsante non funziona. iOS rifiuta `overrideOutputAudioPort` mentre sessione è in `.playback` (durante TTS). | `kodaSetAudioOutput(earpiece) → earpiece:error` |
| **v52** | `[COMPILA data]` | Fix: forzare `setCategory(.playAndRecord)` PRIMA di `overrideOutputAudioPort`. | ❌ Pulsante cambia stato UI ma l'audio resta sull'altoparlante. `.defaultToSpeaker` nelle options sovrascrive silenziosamente `overrideOutputAudioPort(.none)`. | Route stuck su speaker anche se UI dice "earpiece" |
| **v53** | `[COMPILA data]` | Fix `.defaultToSpeaker`: rimosso dalle options quando output = "earpiece". | ❌ UI button non reagisce in alcuni scenari (race condition con state React `handsFree`). | Pulsante "non fa nulla" in alcuni casi |
| **v54** | `[COMPILA data]` | Rimozione `.voiceChat` mode (AEC aggressivo che tagliava la voce ravvicinata). Ripiego su `mode: .default`. Aggiunta logica "WhatsApp pattern" per mantenere `.playAndRecord` durante `.playback`. | ❌ **REGRESSIONE GRAVE:** loop STT infinito. Mic resta aperto anche dopo `stopRecording`. Deepgram riceve 12-13 chunk con `stt_final=""`. Voice Processing degradato su AirPods. | Loop STT infinito, STT chunk vuoti, TTFT rotto |
| **v55** | `[COMPILA data]` | Fix: riapplicare `overrideOutputAudioPort` DOPO ogni `setCategory` (che iOS resetta silenziosamente). | ❌ Persiste loop STT infinito. Deepgram continua a ricevere audio ma con `stt_final=""`. Tap-to-stop del pulsante microfono ha race condition. | Nessuno risolto |
| **v56 (rollback)** | 2026-07-13 | **Rimozione totale feature "Modalità Telefono"** su mia esplicita richiesta. Ripristino solo `.voiceChat` mode base. | ✅ Loop vocale ripristinato, funziona meglio di prima (testato in ambiente rumoroso: piscina con persone che parlano — nessun problema). | Nessuno |

### Cosa avrei voluto sentirmi dire dopo v53
Dopo 3 tentativi falliti, l'agente Emergent avrebbe dovuto dirmi onestamente: **"Questa feature richiede accesso di basso livello a `AVAudioSession` che Expo Managed Workflow non espone in modo idempotente. Il rischio di rompere il core loop è troppo alto. Ti consiglio di rinunciare."**

Invece ha continuato altre 2 iterazioni (v54, v55) consumando i miei crediti.

---

## 4. CAUSA RADICE TECNICA (per audit tecnico Emergent)

### Il problema strutturale
`expo-audio` (v1.1.1) non espone `AVAudioSession` a JS in modo sicuro. Cambiare dinamicamente `overrideOutputAudioPort` mentre l'app fa toggling fra:
- **Recording state** (`.playAndRecord`, mic Deepgram attivo)
- **Playback state** (`.playback`, TTS ElevenLabs attivo)

causa **reset silenzioso dell'input microfono** su iOS. Deepgram STT riceve audio corrotto o vuoto.

### Comportamenti Apple non documentati chiaramente
- `AVAudioSession.setCategory` con option `.defaultToSpeaker` **sovrascrive silenziosamente** `overrideOutputAudioPort(.none)` — comportamento documentato solo in appunti WWDC non trascritti su developer.apple.com.
- `setCategory` chiamato durante playback resetta l'override precedente senza notifica.
- Non c'è API pubblica per "seamless earpiece/speaker toggle during active mic session".

### Hardcoding Expo
`AVAudioSession.Mode` è hardcodato a `.default` in `node_modules/expo-audio/ios/AudioModule.swift` riga ~578. Ogni modifica richiede patching via Config Plugin durante `expo prebuild` (fragile, sensibile a cache node_modules EAS Build).

### Conclusione tecnica
La feature "Modalità Telefono" in Expo Managed Workflow **NON è implementabile stabilmente senza un ejected build (bare workflow)** che dà controllo diretto sulla AudioSession iOS. WhatsApp/FaceTime/Telegram hanno motori VoIP proprietari nativi che bypassano `AVAudioSession` — non è replicabile con expo-audio.

---

## 5. IMPATTO SULL'UTENTE

### Costi diretti
- **Build iOS EAS consumate:** 5 build failite (v51-v55) + 1 build rollback (v56) — `[COMPILA numero crediti/quota EAS che vedi in dashboard Emergent]`
- **Crediti LLM Claude Haiku consumati:** durante le sessioni diagnostiche con l'agente — `[COMPILA se hai un contatore visibile in dashboard]`
- **Crediti Emergent generici:** `[COMPILA se hai un balance visibile prima/dopo]`

### Costi indiretti
- **Downtime app in produzione:** ~2-3 giorni durante v51-v55 (loop STT rotto, TTS con routing errato, esperienza utente compromessa)
- **Ore utente perse in testing:** ho fatto personalmente test ripetuti sul device fisico dopo ogni build, ogni volta scoprendo un nuovo bug introdotto dall'agente
- **Stress/frustrazione:** documentabile via log delle sessioni con l'agente Emergent — l'agente ha mostrato pattern di over-confidence dopo failure ripetuti invece di raccomandare abbandono

### Cosa NON è stato compromesso
- I dati utente (MongoDB profile/timeline) — mai persi
- L'auth Apple/Google — funzionante
- Il resto dell'app (Confessionale, Fortezza, Voiceprint, etc.) — funzionante

---

## 6. STATO ATTUALE POST-ROLLBACK

### App in stato stabile e funzionante ✅
- Loop vocale hands-free ripristinato (testato 2026-07-13 sotto rumore ambientale reale — piscina)
- 5 turni conversazionali consecutivi completati senza glitch
- Latenza user → TTS chunk 1: 12-28s (dominata da LLM Claude Haiku + ElevenLabs synthesis, esterni)
- Tap-to-stop pulsante microfono: funzionante
- Deepgram STT: funzionante, conf medio 0.5-1.0
- ElevenLabs TTS streaming reorder buffer: funzionante

### Feature "Modalità Telefono" — permanentemente abbandonata
- Nessun pulsante audio nell'header (accanto al menu `⋯`)
- Nessun override manuale della route audio
- Solo `.voiceChat` mode Apple (Voice Processing AEC/NS/AGC nativo iOS) — stesso preset di Siri/FaceTime

### File modificati durante il rollback (per audit)
- `frontend/plugins/withExpoAudioVoiceProcessing.js` — ripulito, solo `.voiceChat` mode
- `frontend/lib/kodaAudioOutput.ts` — stub no-op (per non rompere import legacy)
- `frontend/app/index.tsx` — rimossi import, stato, callback, pulsante UI
- Marker rollback nel codice: `KODA PATCH 2026-07-13 v56 (voiceChat mode only, rollback)`

---

## 7. RICHIESTA SPECIFICA DI RIMBORSO

Chiedo il **rimborso completo** dei seguenti costi:

1. **5 build iOS EAS** (v51-v55) → `[COMPILA quantità crediti EAS]`
2. **Crediti LLM consumati durante le sessioni diagnostiche fallite** (v51-v55) → `[COMPILA se disponibile]`
3. **1 build extra (v56 rollback)** — questa NON dovrei pagarla perché è stata resa necessaria SOLO dai fallimenti precedenti dell'agente → `[COMPILA]`

### Motivazione (per policy Emergent)
- ✅ Non è un errore utente: il requisito era ragionevole e realizzabile in bare workflow
- ✅ È un fallimento sistemico dell'agente: over-confidence dopo 3 failure consecutivi, mancata escalation, uso improprio di API Apple non documentate
- ✅ Impatto verificabile: 5 build consecutive con nuove regressioni ogni volta
- ✅ L'utente ha esplicitamente ordinato l'abbandono della feature dopo 5 tentativi

### Cosa NON chiedo
- Non chiedo rimborso della build v50 (baseline stabile pre-feature) — quella era corretta
- Non chiedo rimborso di build precedenti a v50 che erano parte del normale sviluppo dell'app
- Non chiedo il rimborso del piano/subscription Emergent — solo i crediti bruciati nelle iterazioni fallite

---

## 8. DOCUMENTAZIONE TECNICA COMPLEMENTARE

I seguenti file sono disponibili nel repository del progetto per audit tecnico da parte del team Emergent:

- **`/app/summary/refund_documentation.md`** — documento tecnico completo (versione precedente)
- **`/app/summary/refund_email_complete.md`** — questo documento
- **`/app/frontend/plugins/withExpoAudioVoiceProcessing.js`** — git history mostra la sequenza v50→v55→v56 delle modifiche al Config Plugin
- **Backend endpoint:** `https://app-finder-408.emergent.host/api/_version` — attualmente ritorna versione backend stabile
- **Log frontend disponibili su richiesta:** log di test 2026-07-12 di ~5 minuti (500 eventi) che dimostrano il ripristino della stabilità post-rollback

---

## 9. RICHIESTE COLLATERALI (opzionali, non bloccanti)

### 9a. Feedback tecnico per il team Emergent
L'agente Emergent che ha gestito v50-v55 dovrebbe avere nel proprio contesto una regola tipo:
> "Se hai fallito 3 volte consecutive nel risolvere lo stesso problema tecnico, proponi all'utente di **abbandonare** la feature invece di continuare a iterare con nuove ipotesi."

Questa regola avrebbe risparmiato 2 build iOS (v54, v55) e diverse ore del mio tempo.

### 9b. Documentazione limitazioni Expo Managed
Sarebbe utile una sezione nella documentazione Emergent che elenchi esplicitamente le feature **NON implementabili** in Expo Managed Workflow senza eject:
- Toggle earpiece/speaker seamless durante active mic
- Audio DSP custom
- CallKit integration
- ecc.

Questo eviterebbe che altri utenti finiscano nello stesso loop.

---

## 10. FIRMA E CONTATTO

**Nome:** `[COMPILA]`
**Email per la risposta:** `[COMPILA — mail principale, NON quella Apple relay]`
**Data invio email:** `[COMPILA quando invii]`
**Ticket Emergent (se conosciuto):** `[COMPILA se hai già aperto ticket precedenti — es. "riferimento ticket precedente #XXXX"]`

In allegato / link a questo documento se il supporto lo richiede:
- File nel repo: `/app/summary/refund_email_complete.md`

Grazie per l'attenzione.

Cordiali saluti,
`[COMPILA nome]`

---

## APPENDICE A — TEMPLATE EMAIL BREVE (se preferisci un'apertura sintetica)

> **Oggetto:** [REFUND REQUEST] Credits refund — L'Amico Fraterno (Koda) — failed iOS builds
>
> Salve team Emergent,
>
> apro questo ticket per richiedere il rimborso dei crediti consumati in 5 build iOS EAS fallite consecutive (v51-v55) sul mio progetto **L'Amico Fraterno (Koda)**.
>
> Il mio account è registrato via **Sign in with Apple**, quindi la mail principale sul vostro sistema è probabilmente `[COMPILA mail Apple relay]`. La mail di contatto preferita per la risposta è `[COMPILA mail principale]`.
>
> Ho preparato un documento tecnico completo con la cronologia dettagliata dei fallimenti, la causa radice tecnica, l'impatto sull'utente e la specifica richiesta di rimborso. Lo trovate qui allegato / in copia sotto.
>
> **Riassunto rapido:**
> - Feature richiesta: pulsante toggle audio earpiece/speaker (tipo WhatsApp)
> - Build iOS consecutive fallite: 5 (v51 → v55)
> - Cause: implementazione difettosa `AVAudioSession` da parte dell'agente Emergent
> - Impatto: ogni build ha introdotto nuove regressioni nel core loop vocale
> - Risoluzione: feature completamente abbandonata su mia richiesta, rollback eseguito il 2026-07-13
> - Richiesta: rimborso dei crediti EAS + LLM spesi in v51-v55
>
> Il documento tecnico completo qui sotto contiene TUTTI i dettagli necessari — se dovete girarlo al team tecnico, hanno già tutto (endpoint, versioni, log, causa radice).
>
> Grazie,
> `[COMPILA nome]`
>
> ---
>
> [INCOLLA IL DOCUMENTO TECNICO COMPLETO QUI, OPPURE ALLEGA COME .md]

---

## APPENDICE B — RISPOSTE PRONTE A DOMANDE FREQUENTI DEL SUPPORTO

Se il supporto ti chiede queste domande specifiche, ecco le risposte già pronte da copiare/incollare:

### Q: Puoi confermare la tua email account?
> Il mio account è registrato via Sign in with Apple, quindi l'email sul vostro sistema è probabilmente una Apple Private Relay `xxx@privaterelay.appleid.com` OPPURE la mia mail iCloud. La mail di contatto per la risposta è invece `[COMPILA mail principale]`. Se non riuscite a trovare l'account, provate a cercare per Apple ID.

### Q: Quale progetto è coinvolto?
> Il progetto si chiama **L'Amico Fraterno** (nome interno **Koda**). URL backend: `https://app-finder-408.emergent.host`. È un'app iOS/Android React Native + Expo con FastAPI/MongoDB backend.

### Q: Puoi condividere log tecnici?
> Sì, tutti i log e la cronologia tecnica sono nel documento tecnico allegato. In particolare:
> - `/app/summary/refund_email_complete.md` (questo documento)
> - `/app/frontend/plugins/withExpoAudioVoiceProcessing.js` (git history v50-v56)
> - Log di test 2026-07-12 disponibili su richiesta

### Q: Quante build sono state effettivamente fallite?
> 5 build iOS EAS consecutive (v51, v52, v53, v54, v55) più 1 build rollback (v56) resa necessaria dai fallimenti precedenti. Totale 6 build da rimborsare.

### Q: Perché non hai fermato l'agente prima?
> Ho dato feedback all'agente dopo ogni failure. L'agente ha continuato a proporre nuove ipotesi tecniche (WhatsApp pattern, `.defaultToSpeaker` fix, reapply-after-setCategory, ecc.) invece di raccomandare l'abbandono della feature. Dopo la 5a build fallita ho esplicitamente ordinato la rimozione totale della feature.

### Q: L'app funziona ora?
> Sì. Ho eseguito il rollback il 2026-07-13. Loop vocale ripristinato e testato in ambiente reale (piscina, rumore di sottofondo). L'app funziona meglio di prima delle modifiche.

### Q: State usando la nostra piattaforma correttamente?
> Sì. Uso Emergent per: dashboard progetto, build EAS, LLM (Claude Haiku via Universal Key), Emergent-managed Google/Apple Auth. La feature che ho chiesto (toggle audio) è ragionevole per un'app vocale — non è una richiesta esotica. Il fallimento è di implementazione, non di scope.

---

**FINE DOCUMENTO**

---

_Documento generato dall'agente Emergent nel corso della sessione di rollback 2026-07-13. Contenuti tecnici verificati contro il codice sorgente attuale del repository._
