# Taccuino Vivo — Product Requirements Document

## Vision
Un **micro-assistente di quartiere digitale** voice-first, che vive in una **timeline unica** dove la vita scorre. Non una chat. Una **presenza calma, empatica, che ti conosce**, che ti aiuta a tenere insieme soldi, tempo, impegni e — quando serve — a sentirti meno solo.

## Differenziatore (cosa NON è)
- **NON una chat tipo WhatsApp/ChatGPT** — niente liste di tab, niente "nuova conversazione"
- **NON un to-do app** — non si gestisce facendo tap su checkbox, si gestisce parlando
- **NON un assistente professionale freddo (Siri/Alexa)** — ha un carattere, respira, sospira, ride sommessamente, ha piccole preferenze

## Problema
Le persone hanno troppe app per gestire la vita (calendar, finanze, note, salute) e finiscono per non gestirla. Vogliono dire ad alta voce "spendi 12€ di pasta e ricordami di chiamare la mamma alle sette" e basta.

## MVP attuale (esistente, funzionante)

### Conversazione vocale continua
- **Hands-free continuous mode**: dopo il primo tap, il microfono ascolta in loop con calibrazione adattiva del rumore ambientale (sample 800ms → soglia dinamica = ambient + 12dB).
- **Barge-in**: l'utente può interrompere l'AI parlando sopra; il mic rimane aperto durante il TTS per catturare la nuova voce.
- **STT**: OpenAI Whisper via Emergent LLM Key (con prompt italiano che evita allucinazioni "sottotitoli amara.org").
- **AI**: Claude Sonnet 4.5 via Emergent LLM Key. Prompt costruito su 3 fasi relazionali (FORMALE → AMICHEVOLE → INTIMO) che si sblocca col `confidence_level`.
- **TTS**: ElevenLabs `eleven_v3` con audio tags `[warmly]`, `[sighs]`, `[whispers]`, `[laughs softly]` per emozione vera. `apply_text_normalization: "off"` per preservare disfluenze/puntini.

### Timeline unica
- Singola scroll cronologica con day separator ("Oggi", "Ieri", "Lunedì 5 maggio").
- Ogni entry ha `tone` (warm/calm/concerned/...), `domain` (soldi/tempo/spesa/...), `extracted` (importi, intent), `actions` (notifiche programmate).
- Memoria di lungo periodo (`memory_summary`) aggiornata dall'AI a ogni turn rilevante.

### Personalizzazione visiva (background, bolle, voce)
- `background`: foto da galleria (base64) o preset (`aurora`, `notturno`, `carta`, `alba`, `marmo`, `bosco`).
- `background_dim`: 0–1 overlay scuro per leggibilità.
- `bubble_style`: `glass` (frosted, lo sfondo passa) o `solid` (opaco).
- `bubble_color`: viola | verde_acqua | rosa | ambra | ghiaccio | hex.
- `ai_avatar`: foto custom utente o orb pulsante default.
- `text_size`: 0.85 | 1.0 | 1.15 | 1.35.
- `tts_voice_id`: 8 voci ElevenLabs curate IT (Matilda, Sarah, Liam, Charlie, …) + voci custom dell'utente.

### Azioni eseguibili
- `schedule_notification`: l'AI calcola `when_iso` (UTC ISO) e il client schedula via `expo-notifications`.

## Architettura

### Frontend (Expo Router)
- `app/_layout.tsx` — root layout, scaffold notifiche.
- `app/index.tsx` — schermo principale (timeline + mic + settings). **DA REFACTORING in componenti.**
- `lib/api.ts` — client API tipizzato.
- `lib/voice.ts` — registrazione audio (web `MediaRecorder` + native `expo-av`) con calibrazione adattiva.
- `lib/speech.ts` — playback ElevenLabs via URI HTTP (gestisce barge-in + range requests iOS).
- `lib/theme.ts` — temi (sistema/notte/giorno/cielo/bosco/ciliegia + auto-orario).
- `lib/notifications.ts` — wrapper `expo-notifications`.

### Backend (FastAPI)
- `server.py` — endpoint Taccuino. **Pulito da legacy "App Compass" (maggio 2026).**
- MongoDB collections: `taccuino_profile` (singleton "me"), `taccuino_timeline`.

### Endpoint API (tutti `/api/*`)
- `GET /` — health
- `POST /transcribe` — Whisper STT con cleaning allucinazioni
- `GET|PUT|DELETE /profile` — profilo singleton
- `GET|DELETE /timeline` — timeline cronologica
- `POST /converse` — Claude conversation con prompt empatico, ritorna `user_entry`, `ai_entry` (con `voice_text` separato per TTS), `profile`
- `GET /recap?period=today|week` — riassunto Claude
- `GET /voices` — voci curate ElevenLabs
- `POST /tts` e `POST /tts/prepare` + `GET /tts/audio/{token}.mp3` — TTS ElevenLabs v3 con range requests iOS

## Stack tecnologico
- **Frontend**: Expo SDK 53, Expo Router, TypeScript, react-native-safe-area-context, expo-av (mic), expo-image-picker, expo-notifications, expo-linear-gradient, @expo/vector-icons.
- **Backend**: FastAPI, Motor (MongoDB async), emergentintegrations, ElevenLabs SDK.
- **3rd party**: OpenAI Whisper (Emergent), Claude Sonnet 4.5 (Emergent), ElevenLabs (chiave utente).

## Roadmap

### Imminente
- 🟡 **Refactoring `index.tsx`** in `components/` (ChatBubble, FloatingHeader, FloatingFooter, SettingsModal, BackgroundLayer, Orb).
- 🟡 **Orb component** — presenza visiva centrale che respira a riposo, pulsa con la voce dell'utente, diventa fonte di luce quando l'AI parla.
- 🟡 **Riconoscimento genere utente** nel prompt Claude — l'AI deve dire "sei stanca" non "sei stanco" se l'utente è donna (default dal nome, override vocale).

### Backlog
- VAD vero (es. Picovoice Cobra / Silero) per resistere a TV a 1.5m e rumori non-stazionari.
- Wake-word "Coda" (Picovoice Porcupine) per attivazione hands-free senza tap.
- Integrazioni dati: Calendar (EventKit/Google Calendar), Salute (HealthKit/Google Fit), Banca (Open Banking PSD2).
- Memoria a lungo termine queryable ("ricordi cosa ti ho detto martedì?").
- Modalità chrome gesture-based (header/footer auto-hide, riappaiono swipe).

## Principi di design
1. **Voice-first, sempre**: ogni feature deve essere usabile a mani libere.
2. **Una sola schermata**: niente nav tab. Timeline + ciò che serve in overlay.
3. **L'AI non è uno strumento, è una presenza**: respira, ha un tono, ricorda.
4. **Personalizzare una volta, poi sparisce**: il customizer non deve interrompere il flusso emotivo.
5. **Salvataggio implicito**: l'utente non "salva" mai nulla. Tutto è già lì.

---

## CHANGELOG — Sessione 13 Giugno 2026 (Koda)

8 fix richiesti dall'utente (testa su TestFlight). NOTA DEPLOY: il frontend forza le chiamate API verso Railway prod (lib/api.ts), quindi i fix backend vanno live solo dopo "Save to GitHub" → Railway redeploy; i fix frontend solo dopo "Publish" (OTA/build). Le modifiche NON appaiono su TestFlight finché non si esegue questo deploy — causa della percezione "tutto come prima".

- **OLED dim RIMOSSO** completamente (logica + overlay + onTouchStart) in app/index.tsx. Era percepito come bug (velo nero).
- **Pager bloccato a metà** tra pagina voce/lettura: aggiunto re-snap forzato su `onScrollEndDrag` + re-align su `onMomentumScrollEnd` (pagingEnabled lasciava il pager incastrato durante i re-render).
- **`[TONE:warm]` nelle bolle**: il tag contiene ':' e sfuggiva a `_AUDIO_TAG_RE`. Corretto `_strip_audio_tags` (backend, tutti i path) + `stripDisplayTags` difensivo client su meta.reply. Migrazione avvio già pulisce DB.
- **Freemium gate DISABILITATO** (richiesta utente, RevenueCat non ancora collegato): rimosso redirect a /paywall in index.tsx. Counter resta visibile ma non blocca. Riattivare con RevenueCat.
- **Tour guidato decentrato**: ora misura coordinate REALI degli elementi voce (handsFree, confessionale, menu, orb, hint) via `measureInWindow` (refs) invece dei calcoli a mano. buildTourSteps è async. Pagina lettura resta approssimata.
- **Paywall voci ingannevoli**: piano Plus diceva "Tutte le voci sbloccate" ma esistono solo 2 voci (Aria/Echo) per tutti → cambiato in "Voce premium (Aria o Echo)".
- **Genere utente dedotto dal nome**: nuova `_infer_user_gender(profile)` (euristica IT: -a→f, -o/-e→m, eccezioni maschili in -a). Usata nel fast prompt. Aggiunta azione config `user_gender` per override vocale (client già la gestisce).
- **Koda conosce il Confessionale**: aggiunto blocco descrittivo nel fast prompt + sealed prompt ("se ti chiede cos'è, spiega; mai 'non so cos'è'"). Verificato live.


## CHANGELOG — Sessione 11 Giugno 2026 (Koda / L'Amico Fraterno)

### Contesto
L'app è evoluta in "Koda — L'Amico Fraterno": companion vocale empatico con Confessionale zero-knowledge, Crisis Mode a doppio layer, freemium hard paywall (3 messaggi gratis). Backend in produzione su Railway, build iOS via EAS.

### Blocker infrastruttura (P0 — in mano a Emergent Support)
- Build iOS EAS fallisce con `git rev-parse --show-toplevel exit 128` dentro il container `eas-builder-base:2025101601` (workspace non inizializzato come repo git). NON risolvibile lato codice. Certificato Apple OK (rigenerato dall'utente). Email di escalation inviata a support@emergent.sh con Job ID. In attesa di risposta.

### Implementato in questa sessione (testato ✅)
1. **Time-decay memoria** (`_load_relevant_memories` in server.py): sostituito bonus recency a gradini (7gg/30gg) con decadimento esponenziale continuo `2.0 * exp(-age_days/30)`. Oggi=+2.0, 30gg=+0.74, 90gg=+0.10. Ricordi vecchi ad alta importanza restano raggiungibili. Test: /app/backend/tests/test_decay_and_export.py (3/3 passati).
2. **Endpoint GDPR export** `GET /api/export`: esporta profilo + timeline + ricordi + key_facts + entries Confessionale (ancora cifrate, zero-knowledge) come JSON scaricabile (Content-Disposition attachment). User-scoped via X-User-Id. Testato con curl (nuovo utente e legacy "me") + regressione su /profile, /freemium/status, /memories, /timeline — tutto 200.

### NOTA DEPLOY
Le modifiche sono nel workspace Emergent. Arriveranno in produzione (Railway) al prossimo push via "Save to GitHub".

### Backlog aggiornato
- P0: risoluzione build iOS EAS (attesa Emergent Support)
- P1: RevenueCat SDK (attende chiavi API utente + build nativa funzionante)
- P2: Refactor chat ScrollView → FlatList
- P2: Overlay dim 10s per OLED
- P3: Refactor monoliti server.py (~6800 righe) e index.tsx (~5500 righe)
- expo-notifications disabilitato (serve setup nativo google-services.json)

### Aggiornamento 11 Giugno 2026 — pomeriggio
3. **Bottone "Scarica i miei dati" (GDPR)** nel modal Impostazioni (`index.tsx`, testID `gdpr-export-btn`, sopra "Cancella tutta la memoria"): chiama `GET /api/export`. Web: download diretto blob. Native: salva in cache (`expo-file-system/legacy`) + share sheet (`expo-sharing`, installato). Verificato visivamente nel preview web.
   - NOTA: nel preview il click dà errore perché il frontend ha routing forzato verso Railway prod (`detectBackend` in lib/api.ts) che non ha ancora `/api/export`. Funzionerà al prossimo deploy Railway (push via Save to GitHub).
   - NOTA TECNICA: `expo-sharing` è un nuovo modulo nativo → incluso automaticamente nella prossima build EAS iOS/Android.
   - Fix infra locale: cache Metro stale impediva il reload del bundle web — risolto con `rm -rf .metro-cache + restart expo`.

### Aggiornamento 11 Giugno 2026 — sera (batch "fai tutto")
4. **Pagina legale Privacy aggiornata** (`legal.py`): diritto di Accesso e Portabilità (artt. 15+20) ora cita l'export in-app "Scarica i miei dati"; data documento → 11 giugno 2026. Verificata con curl.
5. **Refactor chat ScrollView → FlatList** (`index.tsx`): timeline virtualizzata (initialNumToRender 20, windowSize 9, removeClippedSubviews su native). ListEmptyComponent = welcome, ListFooterComponent = typing indicator. `scrollRef` ora `FlatList<any>`, `scrollToEnd` invariato. Verificato rendering messaggi reali in preview.
6. **Overlay dim OLED** (`index.tsx`): dopo 10s senza tocchi in modalità voce, velo nero 92% (fade 1.4s); qualsiasi tocco lo dissolve (150ms). Disattivo con modali aperti o input testo. testID `oled-dim-overlay`. Testato E2E con Playwright (appare a ~10s, sparisce al tocco).

### ⚠️ Problema ambiente noto (solo preview Emergent, NON tocca produzione)
Il watcher di Metro NON rileva le modifiche ai file: dopo ogni batch di edit frontend serve `rm -rf /app/frontend/.metro-cache/* && sudo supervisorctl restart expo` per vedere le novità nel preview web.

### Nota osservata (pre-esistente, non bloccante)
Alcune vecchie entry timeline (6 giugno) mostrano il prefisso grezzo `[TONE:warm]` nel testo — dati storici salvati prima del fix di pulizia lato backend. Eventualmente bonificabili con uno script una-tantum sul DB.

### Aggiornamento 11 Giugno 2026 — notte
7. **Tema Giorno v5 "Grigio Oro"** (`lib/theme.tsx`): v6 "più grigio" su richiesta utente: grigio neutro vero (#DBDBD9 bg, #E9E9E7 surface, testi #262623), alone champagne dell Orb come unico calore. Pensato per sposare il bagliore oro/champagne dell'Orb. Primary resta petrolio #0E7C7B. Verificato visivamente (tema attivato temporaneamente su prod e RIPRISTINATO a "notte").
8. **Splash cross-fade continuo v4** (`components/KodaSplash.tsx`): eliminato lo "stacco tra colore e colore". Root cause: il reset crossOp.setValue(0) avveniva 1-2 frame prima dell'aggiornamento di curIdx → flash della palette vecchia. Ora 4 cerchi sempre montati + un solo Animated.Value prog (0→4, loop lineare) con opacity triangolari cicliche interpolate: niente reset, niente setState nel loop = zero stacchi per costruzione. Verificato visivamente (blend petrolio→ciclamino a metà fade).

9. **Bonifica tag [TONE:x]** (`server.py`): migrazione idempotente all'avvio (`_cleanup_tone_tags` nello startup event) che rimuove i prefissi grezzi `[TONE:warm]` ecc. da `text` e `voice_text` in `taccuino_timeline`. Testata in locale: 3 voci sporche → 0, log "[startup] bonifica TONE tags: 3 voci timeline ripulite". Sui dati reali (Atlas) girerà da sola al primo avvio dopo il deploy Railway.
