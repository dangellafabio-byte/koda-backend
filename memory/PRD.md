# Taccuino Vivo — Product Requirements Document

## ⚠️ Policy bloccanti da leggere PRIMA di toccare aree sensibili

Prima di lavorare su queste aree, l'agent DEVE leggere il documento di policy corrispondente:

- **Paywall / Freemium / Subscription gate** → `/app/memory/PAYWALL_POLICY.md`
  - Requisito bloccante: whitelist "unlimited users" server-side via env var
    `KODA_UNLIMITED_USERS`. Owner Fabio + sua compagna + beta tester devono
    restare sempre illimitati, altrimenti Fabio rischia di essere bloccato
    dalla sua stessa app durante i test. NON implementare paywall senza
    prima leggere quel doc.
- **Audio robustness / Bug 560557684 / AudioSession iOS** → `/app/memory/AUDIO_ROBUSTNESS_PLAN.md`
  - Storia bug + fix v60.4 + telemetria `[AUDIO_ZOMBIE_RECOVERY]` in
    produzione. Non toccare senza aver capito il quadro (Fase B ha
    cambiato il perimetro).
- **Stanza dello Sfogo / Zero-knowledge / Privacy** → `V1_SPEC.md` +
  `KODA_FULL_PACKAGE.md`. Modalità "Lascia andare" NON deve mai chiamare
  network/STT/backend. Guardia presente in `app/frontend/app/lascia-andare.tsx`.

Checkpoint stabile corrente: **`v60.4-stable`** su `koda-backend/main`
(tag annotated, ripristinabile con `git checkout v60.4-stable`).


### 🎙️ Policy Parroting — Raro e Intenzionale (Fabio, confermata 2026-09-06)
**Definizione**: Il parroting (ripresa lessicale delle parole utente da parte di Koda) è **vietato come default riflesso** e **ammesso SOLO come strumento raro e deliberato**.

**Casi d'uso ammessi**:
1. **Enfasi**: quando serve rimarcare qualcosa che l'utente ha detto ma non sembra aver colto lui stesso
2. **Momento intimo/confessionale**: ripresa calda e densa di una frase chiave per creare intensità emotiva

**Meccanismo tecnico** (dalla v65.18):
- Il modello (Claude Haiku 4.5) può usare il marker `[ECHO:on]` (o `[ECHO:intentional]`, case-insensitive) all'inizio della frase per esentarla dal filtro anti-parroting server-side.
- Il marker viene rimosso automaticamente prima del TTS.
- Vincolo di parsimonia nel system prompt: **massimo 1 volta ogni 5-6 turni**, e solo per scopo emotivo preciso.
- Il filtro anti-parroting (v65.17, doppio strato set+bigram) neutralizza ogni eco NON marcata.

**Esempi**:
- ✅ CORRETTO: utente *"Mi ha lasciato dopo dieci anni"* → Koda `[ECHO:on]Dieci anni. Dieci anni buttati così.`
- ❌ SBAGLIATO: utente *"ho perso l'autobus"* → Koda `[ECHO:on]Autobus perso, che palle.` (nessuno scopo emotivo)
- ❌ SBAGLIATO: utente *"il mio capo è furioso"* → Koda `Capo furioso, eh?` (parroting riflesso NON marcato)

**Riferimento codice**:
- Filtro: `backend/server.py::_detect_parroting` + `_antiparrot_filter_sentence`
- Marker bypass: `backend/server.py::_strip_echo_marker`
- Regole prompt: fast system prompt sezione "REGOLA ECHO — PARROTING INTENZIONALE"


### v65.34 (2026-09-08) — Confermato: HeartReveal + audio session reset OK, VAD LA Android = limite hardware
**HeartVoiceReveal Android — RISOLTO**
Log v65.34 confermano che la sequenza audio session reset (setActive(false) → 250ms → setAudioModeAsync(playback) → setActive(true)) fa partire play() correttamente. `didJustFinish` arriva nativamente dopo ~10s, CTA appare, utente ha completato micro-demo con 3 turni + closing clip + rate-limit consumato.

**Lascia Andare VAD Android — LIMITE HARDWARE (non risolvibile via codice)**
Test esaustivi con 4 audioSource diversi (`voice_communication`, `mic`, default, `unprocessed`) — tutti danno metering=-100 dB costante su device Fabio. Log confermano `isRecording=true` (microfono ATTIVO) ma `st.metering` non è mai un numero valido.
Causa: `MediaRecorder.getMaxAmplitude()` non supportato/emesso da driver audio del device (bug noto expo/expo#36953). Non è patch-abile lato codice o expo-audio.
Comportamento residuo: orb LA fisso in animazione "recording" (già così da v64.1 `LASCIA_ANDARE_ORB_ALWAYS_RECORDING_V64_2`) senza modulazione VU voce. Silence-watcher hard-timeout 90s (v65.30) copre la mancata rilevazione voce.


### v65.32 (2026-09-08) — Android: HeartReveal CTA fallback + LA VAD metering
**BUG 1 — Android orb bloccato in HeartVoiceReveal**
- Segnalato Fabio 2026-09-08: su Android, dopo Lascia Andare finito, l'orb resta "bloccato" (in realtà loop breathe di `HeartVoiceReveal`), i due CTA "Ascolta la mia voce" / "Non ora grazie" non appaiono mai → utente non può uscire.
- Root cause: `expo-audio` su Android SDK 52+ ha un bug noto per cui `player.addListener("playbackStatusUpdate", onStatus)` NON emette sempre `didJustFinish` in modo affidabile → il callback che triggera `setCtaVisible(true)` non parte mai.
- Fix (`HeartVoiceReveal.tsx:172-215`): aggiunto fallback timer duration-based. Dopo `player.play()` legge `player.duration` (disponibile ~200ms dopo play) e arma un timer = `duration_sec * 1000 + 2000ms`. Se `didJustFinish` non arriva entro quel tempo, il timer forza `showCTA()`. Guardia `ctaShown` per idempotenza (qualunque dei due arriva prima vince). Log: `[KODA_HEART_REVEAL] fallback timer fired → showCTA (Android didJustFinish bypass)`.

**BUG 2 — Android VAD Lascia Andare mai attivo**
- Segnalato Fabio 2026-09-08: in Lascia Andare su Android, l'orb non reagisce mai al parlato — sembra "non mi sente".
- Root cause: `lascia-andare.tsx:775` usa `audioSource: "voice_communication"` per il recorder expo-audio. Su MOLTI device Android post-Android 12 (Samsung, Xiaomi, OnePlus) questo audioSource attiva il DSP hardware (AGC + Noise Suppression + Echo Cancellation) che NON popola il campo `metering` del recording status → sempre -100 dB → `db > SPEECH_DB` (-35) mai vero → orb mai reagisce, `lastSpeechAtRef` mai aggiornato, silence-watcher mai partito (in aggiunta al hard-timeout v65.30).
- Fix: `audioSource: "mic"` — audioSource generico Android, metering reale garantito. iOS non impattato (`audioSource` è Android-only in expo-audio).


### v65.30 (2026-09-07) — LA reveal hard-timeout fallback (rumore ambientale)
- **Segnalato Fabio 2026-09-07:** dopo 100s in Lascia Andare firstBoot=1 il silence-watcher non triggerava automaticamente heart-voice-reveal. Il tap manuale della X funzionava correttamente.
- **Root cause:** il watcher in `lascia-andare.tsx:1167-1176` richiede `silenceElapsed >= 15s` calcolato da `lastSpeechAtRef` aggiornato ogni volta che `db > SPEECH_DB (-35 dB)`. In ambiente domestico (aria condizionata, TV, traffico) il rumore di fondo supera continuamente -35 dB → `lastSpeechAtRef` aggiornato ogni 100ms → `silenceElapsed` mai >= 15s → trigger mai raggiunto.
- **Fix:** aggiunto hard-timeout fallback a 90s (`HARD_TIMEOUT_MS`). Se dopo 90s il silence-watcher non ha ancora triggerato, forza reveal indipendentemente dal VAD. Copre il caso "utente in ambiente rumoroso ma passivo". Log: `[KODA_LA_REVEAL] hard-timeout trigger — session=90.0s (VAD-independent fallback, silenceElapsed=X.Xs)`.

### v65.29 (2026-09-07) — Torna Free · v2 force_free flag (REGRESSIONE CRITICA)
- **Root cause reale del bug "va a Intro Premium invece che intro-v3":** `_UNLIMITED_PRESEED_EMAILS` in `server.py:4693` è una whitelist hardcoded che a ogni `GET /api/profile` forza `subscription_tier="unlimited"` per l'email di Fabio (owner). `devSetTier(null)` scrive tier=null nel DB, ma al prossimo getProfile la whitelist patch lo ripristina a "unlimited" → router intro-premium ridirige a `/intro-premium` invece che a `/intro-v3`.
- Il codice v65.21 aveva già creato il flag SecureStore `koda_dev_force_free_tier` che aggiunge `?force_free=1` a GET /profile (backend `server.py:3452` skippa la whitelist patch). Ma il bottone "Torna Free · v2" NON lo attivava.
- **Fix:** aggiunto `SecureStore.setItemAsync("koda_dev_force_free_tier", "1")` all'inizio del bottone, PRIMA di `getProfile()`. Log: `[DEV_SIMULATE_FREE_V2] koda_dev_force_free_tier=1 → backend whitelist patch SKIPPED`.
- **Verificato da Fabio 2026-09-07:** flusso completo funziona: Torna Free · v2 → intro-v3 → LA → tap X → heart-voice-reveal → 3 frasi microdemo → paywall ✓
- **Verificato bug tap-to-stop conversazione (v65.26+v65.27):** dopo hard-stop, il ri-tap fa ripartire mic al primo colpo. Fabio ha testato 3 volte con successo.


### v65.27 (2026-09-07) — Fix regressione tap + "Torna Free" state stale
**BUG A — Tap paralizzato dal v65.26**
- Il check `state === "restoring"` nella v65.26 poteva restare bloccato (se ScreenDimmer non usciva mai da "restoring", es. animateBrightness abortito senza onComplete) → tap-to-stop paralizzato permanentemente.
- Race condition: leggere `dimmer.state` DOPO `noteInteraction()` è fragile perché lo state è già cambiato.
- **Fix v65.27:** approccio deterministico basato su timestamp.
  - Nuovo ref `swallowNextBigButtonTapUntilRef: number`.
  - Root View onStartShouldSetResponder: PRIMA di `noteInteraction()`, legge `state`. Se `dimmed || dimming`, setta ref = `now + 500ms`.
  - `onBigButton`: se `Date.now() < swallowNextBigButtonTapUntilRef.current` → return early e consuma la window. Altrimenti procede normalmente.
  - Timing deterministico, niente dipendenza da state residuali. TTL 500ms = FADE_UP_MS (300ms) + margine.

**BUG B — "Torna Free · v2" non parte intro-v3 (state stale)**
- Il bottone cancellava SecureStore ma NON resettava `introV3State` in memoria. Il router V3 (`index.tsx:1035`) controlla `if (introV3State !== "needed") return;`. `introV3State` restava "completed" (valore letto al primo mount) → router V3 NON reindirizzava a `/intro-v3` → utente non vedeva mai la sequenza narrativa iniziale nonostante il flag SecureStore fosse stato cancellato.
- **Fix v65.27:** aggiunto `setIntroV3State("needed")` nel bottone dopo il reset SecureStore.

**BUG C — Audio session reset post hard-stop (mantenuto da v65.26)**
- `Audio.setIsAudioActiveAsync(false)` fire-and-forget alla fine del branch hard-stop. Il prossimo tap ri-attiva sessione pulita.



### v65.26 (2026-09-07) — Tap: dimmer swallow-first-tap + audio session reset post hard-stop
**BUG #1 — Dimmer non "consuma" il primo tap**
- Segnalato Fabio 2026-09-07: schermo dimmato al 50% dopo 35s inattività, il primo tap per ripristinare la luminosità veniva anche interpretato come tap-to-stop → conversazione stoppata per errore.
- Root cause: root View chiama `ScreenDimmer.noteInteraction()` in `onStartShouldSetResponder` con `return false` → l'evento propaga al bottone orb → `onBigButton` esegue hard-stop.
- Fix (`index.tsx::onBigButton`): all'inizio della funzione, se `ScreenDimmer.getDebugState().state` è `"dimmed"`, `"dimming"` o `"restoring"`, RETURN early (il restore luminosità è già stato avviato da noteInteraction al root, il tap deve essere "consumato" senza altri effetti). Il tap successivo (dimmer=watching) è tap-to-stop normale.

**BUG #2 — Conversazione non riprende dopo tap-to-stop**
- Segnalato Fabio 2026-09-07: dopo tap-to-stop, ri-tappare fa partire "recording" ma il mic non sente (3 tentativi, poi idle). Solo kill dell'app ripristina.
- Root cause: `SpeechMod.stop()` ferma il TTS ma il flag `setIsAudioActiveAsync(true)` (attivato per playback TTS) resta acceso. Al prossimo `startTalk`, `setAudioModeAsync(record)` modifica la config ma non chiama `setActive(false)→setActive(true)` → sessione iOS in stato residuale `playAndRecord` "sporco" → mic hardware non riparte davvero.
- Fix (`index.tsx::onBigButton` branch hard-stop): fire-and-forget `Audio.setIsAudioActiveAsync(false)` alla fine della sequenza di reset (dopo setStatus("idle")). Il prossimo startTalk ri-attiverà la sessione con `setActive(true)` da uno stato pulito. Log `[KODA_TAP_RESET] audio session deactivated — next tap will re-activate clean` per verifica telemetria.


### v65.25 (2026-09-07) — REGRESSIONE: "Torna Free · v2" saltava sequenza Free
- **Segnalata da Fabio 2026-09-07 sera:** premendo "Torna Free · v2" da Settings non arriva mai al paywall e il ritorno paywall→LA sembra rotto.
- **Root cause diagnosticata** in `index.tsx` (bottone `dev-simulate-free-btn`, lines 6899-6913 v65.24):
  - Cancellava dal SecureStore solo 5 chiavi legacy (`la_intro_seen`, `koda_disclaimer_seen_v2`, `koda_intro_seen`, `hint_first_scroll_seen`, `hint_write_seen`).
  - **Mancavano 3 chiavi critiche** per il flusso Free→Paywall:
    - `intro_v3_completed_at` → se presente, `lascia-andare.tsx:172` non fa redirect a `/intro-v3`, la sequenza narrativa iniziale non parte.
    - `heart_reveal_dismissed_at` → `heart-voice-reveal` non riparte più.
    - `microdemo_last_at` → se < 24h, `lascia-andare.tsx:1063-1067` fa `router.push("/paywall?variant=post-demo")` **saltando** la micro-demo delle 3 frasi Free.
  - Il codice sapeva già che vanno cancellate: stesse 3 chiavi sono cancellate correttamente in `index.tsx:4361-4364`, `index.tsx:7015-7020`, `lascia-andare.tsx:1120-1122`. Nel bottone v2 erano dimenticate → regressione introdotta con la creazione del bottone v2 (v65.22, 2026-09-06).
- **Fix v65.25:** aggiunte le 3 chiavi mancanti alla lista `secureKeys`. Log esplicito con l'elenco delle chiavi cancellate per telemetria.
- **Effetto sul ritorno paywall→LA:** `paywall.tsx:250-268` è corretto (se `isPostDemo=true` fa `router.replace("/lascia-andare")`). L'utente non tornava a LA perché in realtà non stava arrivando nemmeno al paywall in modo pulito, e il flusso era "corto-circuitato" dal rate-limit `microdemo_last_at`.


### v65.24 (2026-09-07) — MicroDemo Orb centrato (fix vero) + rollback v65.23 orb padding
- **Screenshot Fabio (22:27, v65.22)** dimostra orb `MicroDemoKoda` decentrato **verso il basso** (~90px sotto centro visivo). Indicatore "0 / 3" in fondo = `turnCount / MAX_TURNS` di MicroDemoKoda, non le 3 frasi narrative iniziali (KodaIntroV3).
- **Root cause identificato in `MicroDemoKoda.tsx`:**
  - `centerContainer.paddingTop: 90` (residuo pattern "replica home Page 0" del 2026-08-23) → sposta il centro flex di **+45px verso il basso**.
  - Spacer `<View style={{ height: 34 }}>` sotto l'orb → il centro geometrico del BLOCCO {orb + spacer} è 17px sotto il centro dell'orb → orb spinto di altri **+17px verso il basso** rispetto al centro flex.
  - Totale: orb visualmente ~62px sotto H/2.
- **Fix v65.24:** rimossi entrambi (paddingTop=0, spacer eliminato). Stessa pulizia già applicata a lascia-andare, KodaIntroV3, HeartVoiceReveal, home Page 0 in Iterazione 23 (2026-08-24). `MicroDemoKoda` era stato dimenticato.
- **Rollback padding v65.23** su `lascia-andare.tsx`, `KodaIntroV3.tsx`, `HeartVoiceReveal.tsx`: il fix generico su asimmetria safe area non era la causa dello screenshot. Ripristinato spec Fabio "orb esatto a H/2".
- **iOS OSStatus 560557684 recovery hardening** invariato da v65.23 (foreground gate, setActive(false) esplicito, retry backoff 0/500/1200ms, setActive(true) finale).

- **Android Orb decentrato in Lascia Andare / Free Intro** — root cause: `edgeToEdgeEnabled: true` estende la View sotto status/nav bar. Con safe area asimmetriche (Android 3-button: top≈24 / bottom≈48) il centro flex geometrico H/2 ≠ centro visivo. Fix: padding correttivo dinamico su `styles.center` — `paddingTop = max(0, insets.top - insets.bottom)`, `paddingBottom = max(0, insets.bottom - insets.top)`. Applicato in `lascia-andare.tsx`, `KodaIntroV3.tsx`, `HeartVoiceReveal.tsx`. Su iOS delta minore (~10-25px), effetto trascurabile.
- **iOS OSStatus 560557684 (`!act`) recovery hardening** — `performAudioSessionRecoveryCycle` in `voiceClientStt.ts`:
  1. **Foreground gate**: skip se `AppState.currentState !== "active"` (setAudioModeAsync fallisce in background con `!pri`).
  2. **Step 0 esplicito**: `setIsAudioActiveAsync(false)` prima del cambio mode. Il vecchio ciclo si limitava a `setAudioModeAsync(allowsRecording:false)` che modifica config ma non chiama `AVAudioSession.setActive(false)` — il flag resta on e la riattivazione può fallire con `!act`.
  3. **Reactivate con retry backoff** (max 3 tentativi: 0ms → 500ms → 1200ms) per gestire route switch (bluetooth dis/connect, silent switch flip, chiamata inbound conclusa da poco).
  4. **Step 3 finale**: `setIsAudioActiveAsync(true)` esplicito dopo `setAudioModeAsync` per riacquisire l'hardware focus (fix collaterale: Android duck bug in cui TTS successivo usciva muto).


### v65.13 (2026-08-28) — Tier stability fix (P0)
- Fix mid-session tier downgrade che kickava utenti whitelisted su `/lascia-andare` durante sessione voce.
- Backend: `is_user_unlimited` con static preseed check + last-resort fallback in `/api/profile` che forza `unlimited` per owner/Stefania anche se DB fallisce.
- Frontend: router blocca `router.replace` durante `convActive=true` + grace period 60s per cambi paid→free.

---

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

## CHANGELOG — Sessione 14 Giugno 2026 (Koda V1 — Block A Confessionale)

Implementato il **Blocco A** del Manifesto V1 (Confessionale ridisegnato). Verificato end-to-end sul preview + API.
- **Backend** (`/converse/confessional`): nuovo prompt manifesto — **Filtro Universale** ("aiuti a esprimersi o spieghi chi è? → scarta"), **Specchio Attivo** (no eco vuota, parte dal testo corrente), **Accettazione della contraddizione**. Verificato via curl.
- **Buffer volatile** `confessional_buffer` in chiaro + **indice TTL 24h** (continuità di sessione, cancellazione fisica). Endpoint `/confessional/reset` per reset volontario. **Zero memoria a lungo termine** (distillazione rimossa).
- **Frontend**: rimossa la **Parola Segreta** (ingresso libero); nuova **schermata d'ingresso** (🕯️ copy manifesto, Entra/Non ora); all'uscita chiama `/confessional/reset`; flusso sealed reso dormiente. Icona toggle scarlatto.
- Doc manifesto creati nella root: `decision_engine_v1.md`, `constitutional_principle.md`, `trust_metrics_framework.md`.

PROSSIMI BLOCCHI: E (rate limiting, ToS/Privacy, analytics, Decision Engine in-app).

### Block C (14 giu) — Auth Apple+Google + gate obbligatorio
- Backend: `/auth/google/session` (Emergent), `/auth/apple` (verifica JWKS, aud=com.dangella.koda), `/auth/me`, `/auth/logout` + sessioni (TTL 7gg). Verificato (401/401/200).
- Frontend: `lib/authToken.ts`, `lib/auth.tsx` (AuthProvider, Google web-redirect + native WebBrowser, Apple native), `components/LoginScreen.tsx`, gate in `_layout.tsx`. `api.ts` invia Bearer token.
- `expo-apple-authentication` installato; `app.json`: `usesAppleSignIn:true` + plugin. **Apple validabile solo su build.**
- Gate verificato sul preview (LoginScreen reso, Google attivo, Apple disabilitato su web).

### Block D (14 giu) — Tour & Presentazione allineati al manifesto
- Tour `index.tsx`: tappa Confessionale riscritta (doppia stanza: Presenza vs Continuità, niente parola segreta).
- `KodaIntro.tsx`: step 7 trasformato da "imposta parola segreta" a schermata informativa sul Confessionale (ingresso libero); voce parlata step 7 + recap aggiornati.
- `InfoModal.tsx`: verificato, nessuna copy obsoleta.

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

### Aggiornamento 14 Giugno 2026 — Finalizzazione Block E (App Hardening)
Stato Block E verificato e completato.

**Backend (già nel codice, testato ✅ in locale via curl):**
- Rate limiting in-memory per-IP sulle rotte `/api` (150 req / 60s → 429). Middleware `_rate_limit_mw` in `server.py`.
- `POST /api/analytics/track` — eventi anonimi fire-and-forget, persistiti in `analytics_events`. ✅
- Decision Engine proattivo (Manifesto V1):
  - `POST /api/decision/heartbeat` — calcola azione proattiva volatile: `OFFER_SPACE` (≥5 sessioni/24h), `OFFER_CHECKIN` (silenzio ≥6gg), `OFFER_REFLECTION` (reflection_hint), altrimenti `DO_NOTHING`. Throttle 20h, rispetto `detox_until`. ✅ (OFFER_SPACE attivato alla 5ª chiamata, OFFER_REFLECTION ok).
  - `POST /api/decision/feedback` — 3 DISMISSED/NEGATIVE consecutivi → soppressione 30gg (cool-down). ✅
  - Separa `internal_reason` (telemetria) da `user_reason` (testo umano). Collezione `decision_state` con indice `key` unico.
- Pagine legali `GET /api/legal/terms` e `/api/legal/privacy` (in `legal.py`). ✅ (HTML renderizzato).

**Frontend (COMPLETATO in questa sessione):**
- Era il pezzo MANCANTE: i metodi `analyticsTrack`/`decisionHeartbeat`/`decisionFeedback` esistevano in `lib/api.ts` ma NON erano usati dalla UI.
- Creato `components/ProactiveOffer.tsx`: al mount della schermata principale chiama `analyticsTrack("app_open")` + `decisionHeartbeat()`. Se l'azione ≠ DO_NOTHING mostra una card discreta in alto (safe-area, accent menta, animazione slide/fade) con `user_reason`, bottone "Va bene" (ACCEPTED) e chiudi (DISMISSED) → `decisionFeedback`. Auto-hide 14s. "Graceful failure": se l'endpoint non risponde (404 su Railway non ancora deployato) non appare nulla.
- Montato in `app/index.tsx` nel return principale: `{!tourActive && !confessionalMode ? <ProactiveOffer theme={theme} /> : null}`. testID: `proactive-offer-card`, `proactive-offer-text`, `proactive-offer-accept`, `proactive-offer-dismiss`.
- Lint ProactiveOffer pulito. App boot OK (nessun crash).

**⚠️ NOTE DEPLOY CRITICHE:**
- Il frontend (preview E TestFlight) punta a **Railway prod** (`detectBackend` forza Railway quando l'URL è preview Emergent). Su Railway oggi `decision/heartbeat` e `analytics/track` rispondono **404**: il Block E backend NON è ancora deployato lì.
- La card proattiva NON è testabile nel preview web (serve login Google per superare l'AuthGate + Railway senza endpoint). Sarà visibile/funzionante solo sulla **build nativa** DOPO che il backend Block E è live su Railway (push via "Save to GitHub" → deploy Railway).

### Backlog aggiornato (14 Giu 2026)
- P0: Push su GitHub + deploy backend su Railway (per attivare Block E) → poi richiesta build iOS a support@emergent.sh.
- P1: Validazione Apple Login (solo su build TestFlight reale).
- P2: Riattivare paywall RevenueCat (ora disattivato per test).
  - ⚠️ **VINCOLO OWNER (Fabio 2026-07-23)**: prima di scrivere anche una riga
    di codice paywall, leggere `/app/memory/PAYWALL_POLICY.md`. Contiene la
    lista dei requisiti bloccanti (whitelist unlimited server-side, env var
    override in dev, log `[PAYWALL_BYPASS]`, backend-only source of truth).
    Fabio ha richiesto esplicitamente che il suo account (e quello della
    compagna, e eventuali beta tester) resti sempre illimitato — la lista
    va compilata via env var `KODA_UNLIMITED_USERS` PRIMA che il paywall
    diventi live in produzione. Testare owner-bypass con 50+ turni prima
    di considerare fatto il feature.
- P2/P3: Refactor monoliti `server.py` (~7000 righe) e `index.tsx` (~5700 righe).


---

## SESSIONE 2026-06-17 — FASE 1 LATENCY OPTIMIZATION (WS Streaming)

**Goal**: ridurre il TTFT (Time To First Token audio) percepito da ~3-4s a ~1-1.5s.

### ✅ Implementato

**Backend** (`/app/backend/server.py`):
- Nuovo endpoint **WebSocket** `/api/converse-ws` (+ alias root `/converse-ws`) che pipa la fast pipeline direttamente al client.
- Wire protocol: text frame header `{type:"sentence",i,text,waveform,window_ms,audio_bytes,mime}` seguito IMMEDIATAMENTE da un binary frame con i bytes MP3 della frase. Poi `meta`, `done`.
- Pipeline refactor: `_fast_pipeline_task(emit=...)` ora accetta un callback `emit(event, audio_bytes)` che inoltra direttamente al WS bypassando il long-poll. Mongo continua a salvare per fallback.
- Rename **Echo → Theo** ovunque: `CURATED_VOICES`, `KODA_VOICES` (con alias `echo` mantenuto per back-compat con profili salvati). `/api/voice/options` deduplica gli alias.

**Frontend** (`/app/frontend/lib/speech.ts`, `/app/frontend/app/index.tsx`):
- Nuova funzione `fastConverseWS(text, opts)`: apre WS, riceve header+binary, scrive MP3 in `cacheDirectory` (native) o usa blob URL (web), suona via `expo-audio`.
- `app/index.tsx` chiama PRIMA `fastConverseWS`; se fallisce (rete instabile, server old) ripiega su `fastConverse` (HTTP poll) senza perdere il messaggio.
- Rename UI: tutte le occorrenze "Echo" → "Theo" in `KodaIntro.tsx` (M2 + voice card) e `paywall.tsx` (feature list dei 3 piani). Step 3 copy reframed: "Aria e Theo sono due timbri della stessa presenza — io resto Koda".

### 📊 Latenza misurata (real Claude + ElevenLabs)
- TTFT Claude streaming: **~520ms** (era ~900-1100ms con prompt più lungo)
- FIRST AUDIO ready: **~1080ms** end-to-end (era ~2500-3500ms su HTTP poll)
- Saving stimato: **~1.5-2s per turno** sulla percezione utente.

### ⛔ Postposto a fase successiva
- **Deepgram WS Streaming STT**: richiede di streamare l'audio mic in tempo reale dall'Expo client → servirebbe un native module custom o un workaround base64 chunking. Beneficio stimato: -300/500ms. Da pianificare separatamente.
- **Opus codec**: ElevenLabs WS endpoint supporta solo PCM/MP3 in streaming. Manteniamo MP3 44.1kHz/128k che expo-audio gestisce nativamente. Opus richiederebbe container OGG/CAF + iOS 17+ per AVPlayer. Non vale il rischio in questo iter.
- **ElevenLabs WS multistream** (text→audio tokenizzato): refactor importante; sentence-by-sentence convert() rimane (è già internamente streaming).

### 🧪 Test backend
- 6/6 PASS (`test_fase1_ws.py`): WS happy path, WS empty text, WS invalid JSON, HTTP poll fallback, Echo→Theo rename, back-compat alias.
- Frontend: validazione manuale dal device richiesta (Expo WS playback in dev/TestFlight).




---

## 🌊🌬️ Rebrand voci ufficiali (giugno 2026 v4)

### Decisione di prodotto
Koda **NON** offre una rosa di voci tra cui scegliere. L'utente sceglie **solo il genere** (maschile/femminile) in onboarding, e l'identità sonora di Koda è **una sola voce per genere**, fissa, riconoscibile.

### Voci ufficiali
- **Acqua** (`6TngzmzM89jJ3Y2Yiywr`) — voce femminile di Koda. Sostituisce la precedente "Aria" (`tCOJUYBo86m5v7hppDc7`).
- **Vento** (`ll9WG7PDTuyHwgC5MD6g`) — voce maschile di Koda. Sostituisce la precedente "Theo" (`dJwiFcjz9zW5Pge7G8AG`).

### Implementazione
**Backend** (`/app/backend/server.py`):
- `KODA_VOICES["aria"]`/`"theo"`/`"echo"` → voice_id Acqua/Vento (chiavi brand interne mantenute per retrocompat profili).
- `CURATED_VOICES` aggiornato (label "Acqua" / "Vento", descrizioni asciutte).
- `_VOICE_MIGRATION_MAP` migra automaticamente utenti esistenti al prossimo `GET /api/profile`:
  - `tCOJUYBo86m5v7hppDc7` (Aria) → `6TngzmzM89jJ3Y2Yiywr` (Acqua)
  - `dJwiFcjz9zW5Pge7G8AG` (Theo) → `ll9WG7PDTuyHwgC5MD6g` (Vento)
  - `XrExE9yKIg1WjnnlVkGX` (Matilda default) → Acqua
- Cache key `/api/voice/preview/{key}` ora include voice_id → auto-invalidazione quando la voce cambia.
- Default `Settings.tts_voice_id` e tutti i fallback aggiornati a Acqua.

**Frontend** (`KodaIntro.tsx`, `app/index.tsx`):
- `BRAND_VOICE_IDS.aria` / `echo` aggiornati.
- Voice cards M2 onboarding: titoli "Acqua" / "Vento", descrizione asciutta "La voce {femminile|maschile} di Koda."
- TTS step 3 KodaIntro: "Acqua — voce femminile — oppure Vento — voce maschile. Sono solo due timbri della stessa presenza: io resto sempre Koda."
- Tour voiceId mapping aggiornato.

### Validazione
- Backend test automatico passato: `/api/voices` → Acqua + Vento; `/api/voice/preview/aria` e `/voice/preview/theo` generano audio dai nuovi voice_id (verificato da log ElevenLabs).
- Deploy production effettuato (`app-finder-408.emergent.host`).
- Confermato funzionante in app reale dell'utente dopo publish.
---

## 2026-08-23 — Build 19: Fix P0 Router Premium/V3 + Paywall Dev Bypass

### Contesto
Build 18 aveva due bug P0 rilevati da Fabio dopo il test manuale:
1. **Bug 1**: User Premium continuava a vedere Intro V3 invece di skippare a Intro Premium (Fix A2 aveva fallito).
2. **Bug 2**: Il bottone `[DEV] Simula pagamento riuscito` nel paywall era invisibile per admin.

### Root cause identificate (audit temporale)
- **Bug 1 — race condition cache/network**: `fastPathHydrate()` legge il profilo da cache locale (SecureStore) e triggera il router V3 con `subscription_tier` STALE prima che arrivi la fetch di rete. Il ref booleano `hasRedirectedIntroV3Ref` si marca `true` al primo passaggio → quando poi arriva il network con tier=Premium, il useEffect ri-lancia MA il ref blocca l'update E siamo già stati redirected a `/intro-v3`.
- **Bug 2 — schema mismatch**: il paywall chiamava `api.getProfile()` per leggere `p?.is_admin`, ma il Pydantic `Profile` backend NON include `is_admin`. Endpoint corretto: `/api/admin/whoami` (già disponibile come `api.adminWhoAmI()`).

### Fix applicati
- **`frontend/app/index.tsx`**:
  - Nuovo state `profileHydrated: "empty" | "cache" | "network"`.
  - `fastPathHydrate` scrive `"cache"` (solo se ancora `empty`).
  - `loadProfile` scrive `"network"` dopo `setProfile(p)`.
  - `resetEverything` scrive `"network"` dopo il refetch del profilo.
  - I 3 router condizionali (KODA_ROUTER_V3, router Free/Premium, KODA_ROUTER_INTRO_PREMIUM) ora hanno guard `if (profileHydrated !== "network") return;` — decidono SOLO su dati network-fresh.
  - Router V3 e Intro Premium: nuovi ref keyed (`lastV3DecidedKeyRef`, `lastIntroPremiumDecidedKeyRef`) per gestire cambi tier in-session (coerente col router Free/Premium che già aveva questa invalidazione).

- **`frontend/app.json`**:
  - `version`: 1.0.119 → 1.0.120
  - `ios.buildNumber`: "18" → "19"
  - `android.versionCode`: 18 → 19

- **`frontend/app/paywall.tsx`**:
  - `api.getProfile()` → `api.adminWhoAmI()` per stabilire `isAdmin`.
  - Fail-closed su errore: `setIsAdmin(false)`.

### Verifica pre-build
- **Testing agent iteration 20**: 10/10 test backend contract PASS (whoami, profile senza is_admin, dev/set-tier, dev/intro-premium/reset). Code review frontend statica: fix corretto.
- **Test browser preview**: non riproducibile — `lib/backendUrl.ts` hardcoded a Railway produzione (non un problema device iOS che ignora CORS).
- **Failure mode noto per fix futuro (NON blocker)**: se il backend è irraggiungibile per >30s al boot, `profileHydrated` non diventa mai "network" e l'utente Premium resta bloccato con schermo bianco. Il retry loop di `loadProfile` prova ogni 3s → si sblocca eventualmente.

### 5 test manuali on-device pending (Fabio)
1. Premium boot fresh → deve vedere Intro Premium, MAI Intro V3.
2. Admin `/paywall` → bottone `[DEV] Simula pagamento riuscito` visibile → click → naviga a `/intro-premium` senza alert.
3. Regressione Free: user Free fresh → Intro V3 normalmente.
4. Regressione cambio tier in-session: Premium → dev panel "Torna Free" → redirect a `/lascia-andare`.
5. Rete lenta: no flash di V3 prima di correggersi.

---

## 2026-08-23 — Build 20: Test Suite unificata (fix "troppi bottoni sparsi")

### Contesto
Dopo Build 19 Fabio ha riportato: "ho visto il paywall una sola volta per sbaglio, poi mai più; troppi bottoni nelle Impostazioni, forse sono loro a rompere". Richiesta esplicita: **una demo automatica** dove l'utente interagisce solo con paywall/Intro V3/Intro Premium, zero setup manuale.

### Implementazione
1. **`app/dev-router-demo.tsx`** (NEW) — schermata unica con 5 bottoni test. Ogni bottone fa tutto il setup (`devSetTier`, `devIntroPremiumReset`, `devTrialSeedExpired`, clear SecureStore) e naviga automaticamente allo scenario. I test 1, 3, 5 usano `Updates.reloadAsync()` per simulare cold boot. Il test 4 è totalmente automatico (setta Premium → home → dopo 3s setta Free → osserva redirect).
2. **`components/DemoFloatingBar.tsx`** (NEW) — barra flottante persistente su tutte le schermate. Polla `SecureStore.koda_demo_mode` ogni 1.5s, mostra ID test + risultato atteso + route corrente + bottoni "✓ PASS · torna alla suite" e "✗ FAIL".
3. **`app/_layout.tsx`** — DemoFloatingBar montato sopra ogni schermata (zIndex 9999).
4. **`app/index.tsx`** — bottone unico prominente in cima alla sezione admin di Impostazioni: "🧪 Test Suite Build 19 — USA SOLO QUESTO" (bordo turchese, colore #00F5D4). Testo esplicito: "Ignora tutti gli altri bottoni admin qui sotto".
5. **Bump**: version 1.0.121, buildNumber 20, versionCode 20.

### Flusso utente
1. Impostazioni → tap "🧪 Test Suite Build 19" (unico bottone da toccare).
2. Sulla schermata demo, tap "Test N" (senza pensare a nulla).
3. L'app si arrangia da sola (setup + navigate o reloadAsync).
4. Utente vede la schermata target (Intro Premium / paywall / Intro V3 / lascia-andare).
5. Barra flottante in basso mostra risultato atteso.
6. Tap "✓ PASS" o "✗ FAIL" per tornare alla suite e fare il test successivo.

### Test coperti (i 5 P0)
1. Premium boot fresh → Intro Premium (MAI V3)
2. Paywall dev bypass button visibile + funzionante
3. Free boot fresh (regressione) → Intro V3
4. Cambio tier in-session (Premium → Free) → /lascia-andare (automatico, 8s totali)
5. Rete lenta (modalità aereo manuale) → no flash V3

---

## 2026-08-23 — Build 22: Cleanup verifiche + spec V3/Intro Premium + orb pixel-perfect

### Cleanup (rimosso su richiesta esplicita utente)
- `/app/frontend/app/dev-router-demo.tsx` (Test Suite)
- `/app/frontend/components/DemoFloatingBar.tsx` (barra flottante che copriva paywall)
- `/app/frontend/components/TrialTestPanel.tsx` (test trial)
- In `_layout.tsx`: rimosso import + montaggio `<DemoFloatingBar />`
- In `app/index.tsx` Impostazioni: rimosso bottone "🧪 Test Suite Build 19",
  intera sezione "💎 Test — Simula Premium" (Simula Premium / Torna Free /
  Ripeti Intro Premium), bottone "Prova nuovo Setup + Intro (beta)",
  montaggio `<TrialTestPanel visible={true} />`
- In `app/paywall.tsx`: rimosso state isAdmin + handleDevBypass +
  api.adminWhoAmI() + bottone "[DEV] Simula pagamento riuscito"

### NON toccato (utente non ha detto esplicitamente)
- diagnostics, persona-test, "Rivedi il tour", "Rivedi Intro Premium (admin)",
  whitelist admin unlimited, "Cancella tutta la memoria", endpoint backend
  /api/dev/* e /api/admin/*

### Modifiche flusso (allineamento a spec definitiva Fabio 2026-08-23)
- **PARTE 4 (nessun ring/glow su elementi che appaiono)**: rimosso ring
  pulsante attorno a HF/LA/Settings in `IntroPremium.tsx` e attorno alla
  barra scrittura in `IntroPremiumFinalStep.tsx`. Gli elementi ora
  compaiono solo con fade-in senza evidenziatore.
- **Orb pixel-perfect (posizione identica alla home in TUTTE le
  schermate)**: allineamento a wrapper home Page 0
  (`paddingTop: 90` + flex-center → centro Y = H/2 + 45):
    - `IntroPremium.tsx`: `orbCY = H * 0.46` → `orbCY = H / 2 + 45`
    - `KodaIntroV3.tsx`: `centerContainer.paddingTop 0 → 90`,
      `orbWrap.marginBottom 10 → 0`, label offset
      `ORB_SIZE/2 + 27 → ORB_SIZE/2 + 72`
    - `HeartVoiceReveal.tsx`: `centerContainer.paddingTop 0 → 90`
    - `MicroDemoKoda.tsx`: `centerContainer.paddingTop 0 → 90`
    - `lascia-andare.tsx`: `styles.center.paddingTop → 90`

### Bump
- version 1.0.123, buildNumber 22, versionCode 22

### Verifica spec definitiva (già presente prima di questa build)
- 1.1 Disclaimer ✓, 1.2 "Ciao, piacere di conoscerti..." ✓, 1.3 "Voglio
  farti conoscere una parte di me." ✓, 1.4 transizione a
  /lascia-andare?firstBoot=1 ✓, 1.5 "Questo è il mio cuore..." ✓,
  1.6 "Provalo." ✓, 1.7 X e timer stessa destinazione ✓, 1.8
  HeartVoiceReveal "Ma ho anche una voce..." ✓, 1.9a microdemo ✓,
  1.10 "Parla con Koda" rate-limit 24h ✓
- 2.1 innesco su tier valorizzato ✓, 2.2 clip "Eccomi..." + solo orb ✓,
  2.3 alert "Un attimo" / "Per parlarti serve..." ✓, 2.4 hint 5s "Toccami" ✓,
  2.5-2.9 5 coach-mark ✓, 2.6 HandsFreeOrb VERO ✓, 2.9 auto-swipe -40px ✓,
  2.10 handoff `/?intro=writing_final` ✓, 2.11 "Rispondo qui in silenzio."
  + "Adesso ci siamo. Cominciamo." ✓, 2.12 flag persist doppio ✓
- PARTE 3 router con `profileHydrated === "network"` ✓,
  skip V3 per paid ✓, keyed invalidation su cambio tier ✓
- PARTE 4 pre-prompt riutilizzabile (`ensureSpeechPermission`) ✓

## Iterazione 21 (2026-08-24) — Fix Bug Cache Tier IN-SESSIONE

### Problema
Cambio tier via dev button ("Simula Premium" / "Torna Free" / DEV Bypass Paywall)
richiedeva **restart dell'app** per prendere effetto. Il router Free/Premium
usava un `useRef` (`hasRedirectedFreeUserRef`) che, una volta settato a `true`,
non veniva mai resettato → dopo il primo redirect il router restava bloccato,
anche se il tier del profilo cambiava.

### Fix implementato
1. **Keyed invalidation locale** al router Free/Premium in `app/index.tsx`:
   nuovo ref `lastFreePremiumDecidedKeyRef` che memorizza la key `${profileId}:${tier}`.
   Se la key differisce dall'ultima decisione, `hasRedirectedFreeUserRef.current`
   viene resettato a `false` → il router ridecide con dati freschi.
2. **Dev button "Simula Premium" / "Torna Free"** ora invalidano ESPLICITAMENTE:
   - tutti e 3 i ref locali (V3, Free/Premium, Intro Premium) + rispettive keys locali
   - la key module-level via nuova funzione `resetLastDecidedKey()` in
     `lib/routerGlobalState.ts` (che NON tocca il flag splash a differenza di
     `resetRouterGlobalState()`)
   - ri-fetchano `introPremiumState` dal backend
   - persistono la cache profilo con `saveProfileCache(p)`
   - chiamano `setProfile(p)` + `setProfileHydrated("network")`
3. **DEV Bypass Paywall** (`app/paywall.tsx`) chiama `resetLastDecidedKey()`
   + `saveProfileCache(profileFresh)` così, se l'utente torna alla Home dopo
   l'Intro Premium, i router condizionali rileggono il nuovo tier.

### Test verificati (autonomi, no manual QA)
- **43/43 Jest unit router PASS** (`tests/routerDecision.test.js`), incluso
  nuovo **Scenario 8b** che riproduce esattamente il bug: `hasRedirectedFreeUser=true`
  stale + tier changed → deve redirigere grazie a keyed local invalidation.
  Scenario 8c: same key → wait (no infinite loop).
- **15/15 pytest backend PASS** (`test_iter21_tier_switch_router_jan2026.py`)
  su sequenza `/dev/set-tier` null→monthly→bimonthly→null, reset intro-premium,
  auth gating admin.
- **Code review statica**: dev buttons + paywall dev bypass verificati OK.
- **Sanity boot check**: Koda login screen carica correttamente (screenshot verificato).

## Iterazione 21b (2026-08-24 pomeriggio) — Fix v2 DETERMINISTICO

### Problema residuo
Il fix v1 (keyed invalidation + reset refs + `resetLastDecidedKey()` + `setProfile`)
dipendeva dalla catena `useEffect deps → router.replace()`. Nel runtime reale del
device questa catena ha race conditions difficili da riprodurre (batching React,
Modal Settings ancora aperto, Alert.alert overlay, ecc.) → i test unitari passavano
ma il redirect non avveniva sull'app vera. Fabio ha giustamente chiuso il caso
come "test dichiarati OK ma bug ancora presente".

### Fix v2 applicato
Approccio **deterministico**: nei dev button "Simula Premium" / "Torna Free"
la navigazione avviene DIRETTAMENTE nel handler, subito dopo che l'API
`/dev/set-tier` risponde OK e il profilo è stato aggiornato in cache.
Non ci si affida più alla catena useEffect.

- **Torna Free**: `router.replace("/lascia-andare")` chiamato direttamente.
  Marca decisione locale con `markRouterDecided(pid, null)` prima della nav
  così se Home viene remontata mentre siamo su LA non ridecide.
- **Simula Premium**: se `intro-premium seen=false` → `router.replace("/intro-premium")`.
  Altrimenti resta sulla home e marca decisione con `markRouterDecided(pid, "monthly")`.
- **Settings modal**: chiuso esplicitamente con `setShowSettings(false)` prima
  della navigazione così il Modal non sopravvive al cambio route.
- **Cache profilo** persistita via `saveProfileCache(p)` prima della nav così
  al re-mount la cache è coerente col nuovo tier.

L'useEffect router resta come fallback per altri path (RevenueCat purchase, boot),
ma i dev button ora hanno navigazione garantita.

## Iterazione 21c (2026-08-24 sera) — VERIFICA E2E BROWSER REALE

### Prova concreta ottenuta (non solo dichiarata)
Setup temporaneo per test Playwright end-to-end:
- Backend locale con `dev@koda.local` aggiunto come admin
- Frontend puntato a `localhost:8001` via env `EXPO_PUBLIC_KODA_LOCAL_TEST=1`
- CORS `allow_origins=["http://localhost:3000"]` per credentials mode
- Tutte le patch temporanee REVERTED al termine (backend a produzione,
  frontend a Railway hardcoded, env pulita)

### Sequenza verificata via Playwright
1. Boot in Home come Premium (tier=monthly) — URL `/`
2. Tap `settings-toggle` → apre modal Impostazioni
3. Scroll fino a `dev-simulate-free-btn` (visibile)
4. Click "Torna Free" → API `/dev/set-tier {tier:null}` OK
5. `router.replace("/lascia-andare")` eseguito direttamente
6. **URL DOPO click = `http://localhost:3000/lascia-andare` ✅**
7. Screen effettivamente cambia a Lascia Andare (orb eclissi + label)

Console log confermano la sequenza:
- `[KODA_ROUTER] paid user (tier=monthly) → stay` (boot iniziale)
- `[DEV_SIMULATE_FREE] → /lascia-andare` (mio log del v2 fix)

### Bonus fix collaterale
Trovato e sistemato un TDZ error pre-esistente in `app/index.tsx`:
`Cannot access 'dimensions' before initialization` — `dimensions` era
dichiarato dopo un `useEffect` che lo referenziava nel deps array.
Spostato la dichiarazione prima → red-screen risolto.

## Iterazione 22 (2026-08-24 sera) — Bug P0: Free user reach Home via LA X

### Problema
Dopo il fix routing Free → Lascia Andare (v2 verificato), Fabio ha trovato
un bug distinto: **al tap X su Lascia Andare, l'utente Free viene portato
alla Home Koda conv (Premium)** invece che al Paywall. Viola la regola
fondamentale: **un utente Free non deve MAI raggiungere la Home completa,
in nessuna circostanza. Solo Premium ci arriva.**

### Root cause
`handleExit()` in `/app/frontend/app/lascia-andare.tsx` faceva:
```
if (router.canGoBack()) router.back();
else router.replace("/");
```
In entrambi i rami il Free finiva alla Home:
- `router.back()` → il back stack ha `/` (Home) come precedente → Home
- `router.replace("/")` → Home diretta

### Fix applicato
`handleExit()` ora legge il tier dalla cache profilo locale
(`loadProfileCache` — ZERO network, ZERO violazione della zero-persistenza
di LA che riguarda registrazioni vocali, NON metadati profilo) e:
- **Free** (nessun `subscription_tier` valido) → `router.replace("/paywall?variant=post-demo")` (spec)
- **Premium** (`monthly`/`bimonthly`/`annual`/`unlimited`) → `router.back()` come prima
- **Safe default**: se cache fallisce, `goToPaywall=true` — meglio paywall a un Premium in transient error che Home a un Free (violazione spec)

### Loop LA ↔ Paywall (by design)
Free user: tap X su LA → paywall (post-demo, mostra X) → tap X paywall
→ `router.replace("/lascia-andare")` (già esistente in paywall.tsx per isPostDemo)
→ loop volontario. Free non può uscire dal "trial ecosystem" senza pagare.

### Nota sull'orb positioning (osservazione Fabio)
Fabio ha visualmente stimato che l'orb tra LA e Home appare in posizione
simile (nessun salto evidente a occhio). L'allineamento matematico
`H/2 + 28` è già in place dai fix precedenti. Non c'è /orb-check page
attualmente — se emerge un salto misurabile, la creerò come pagina
di debug pixel-precisa.

## Iterazione 23 (2026-08-24 sera) — Eclissi PIXEL-CENTRATA in tutte le modalità

### Problema
Fabio ha giustamente osservato che l'eclissi era decentrata: in alcune schermate
sopra il centro, in altre sotto, mai al centro esatto H/2. Precedenti tentativi
di "allineamento matematico H/2 + 28" avevano introdotto offset volontari per
matchare il layout della Home Page 0 (che era shiftata giù per il paddingTop:90),
ma la Home era essa stessa decentrata → si propagava l'errore.

### Fix applicato
Eclissi PIXEL-CENTRATA a H/2 in TUTTE le 6 schermate:

1. **lascia-andare.tsx**: rimosso `paddingTop: 90` + rimosso spacer 34px sotto l'orb → il flex-center puro centra l'orb (unico figlio) a H/2 esatto
2. **KodaIntroV3.tsx**: rimosso `paddingTop: 90` + spacer + micro-label `marginTop` compensato da `ORB_SIZE/2+72` → `ORB_SIZE/2+27` (rimossa la compensazione dei 45px)
3. **HeartVoiceReveal.tsx**: rimosso `paddingTop: 90`
4. **IntroPremium.tsx**: `orbCY = H/2 + 28` → `H/2` (coach-mark labels ora allineati al nuovo centro)
5. **index.tsx (Home Page 0)**: rimosso `paddingTop: 90` dal wrapper + rimosso `gap: 18` dal gruppo interno + spostato orb a essere l'unico figlio del gruppo → orb centrato per flex
6. **index.tsx (Coach-mark fallback)**: `orbCY = H * 0.46` → `H / 2` per coerenza col nuovo layout reale

### Ripristino "Scorri per scrivere"
La hint "scorri per leggere" era condizionata a `timeline.length > 0` (invisibile
per user vergine). Adesso è:
- Testo cambiato in **"scorri per scrivere"** (per esplicito richiesta Fabio)
- SEMPRE visibile (rimosso condizionale)
- Position `absolute`, `bottom: Math.max(insets.bottom + 100, 150)` → simmetrico
  rispetto al pill "Lascia andare" (che è a `top: Math.max(insets.top + 100, 150)`)
- Same offset from insets.top/insets.bottom → distanza specchio dal centro H/2

### Cosa NON è stato toccato (per esplicita priorità Fabio)
- **Evidenziatore (KodaTour teal outline circle)**: Fabio ha detto di rifarlo
  DOPO che l'eclissi sia centrata. Prossimo step.
- **Altro coach-mark**: allineamento generico ok, ma se serve ri-tuning verrà
  fatto dopo la validazione visiva.

### File modificati (per il prossimo Publish)
- `/app/frontend/app/lascia-andare.tsx`
- `/app/frontend/app/index.tsx` (Home Page 0 + coach-mark fallback)
- `/app/frontend/components/KodaIntroV3.tsx`
- `/app/frontend/components/HeartVoiceReveal.tsx`
- `/app/frontend/components/IntroPremium.tsx`

## Iterazione 24 (2026-08-24 sera) — Pulsante "Ripeti primo boot completo"

### Motivazione
Fabio ha chiesto "come rivedo tutto il flusso primo boot?". Non esisteva un
modo one-tap per resettare COMPLETAMENTE l'onboarding e ripartire da zero
(Splash → Disclaimer → V3 → HeartVoiceReveal → LA firstBoot → Home).

### Backend nuovo endpoint
`POST /api/dev/first-boot/reset` (admin-only): unset di TUTTI i flag onboarding
server-side sul profilo dell'admin corrente:
- `subscription_tier` (→ torna Free)
- `onboarded`
- `intro_premium_seen_at`
- `la_intro_seen`
- `disclaimer_accepted_at` + `disclaimer_accepted_version`
- `intro_v3_completed_at`
- `heart_voice_reveal_seen`

### Frontend nuovo pulsante
Sezione Dev Panel in Impostazioni, sotto "Ripeti Intro Premium":
**"🚀 Ripeti primo boot completo · v2"** (colore ambra per distinguerlo)

Al tap:
1. `api.devFirstBootReset()` (server)
2. Cancella SecureStore per 8 chiavi (intro V3, LA, disclaimer, ecc.)
3. `clearProfileCache()` (nuova funzione in localCache.ts, cancella file JSON)
4. `resetRouterGlobalState()` (module-level, azzera anche session splash flag)
5. Reset tutti i router refs locali
6. Alert "✓ Reset primo boot completo — Riparti ora" → `Updates.reloadAsync()`
7. Fallback in caso `reloadAsync` fallisca (web): reset state React + replace("/")

Post-reload l'app parte come cold-boot logico → rivedi TUTTO il flusso primo boot.

## Iterazione 25 (2026-08-25) — Fix WS Auth (bug situations=0 dopo test vocale)

### Root cause trovato
Il test vocale delle 7 frasi di Fabio ha rilevato: **timeline profilo Fabio = 0
entries, situations = 0**, ma memories su `profile_id="me"` = 17.

Investigazione:
- Il profilo `dangella.fabio@gmail.com` (uid=ee4e7261...) risulta `situation_tracking_enabled=true` ✅
- Le conversazioni voce sono avvenute (Fabio conferma "mi ha risposto ad ogni frase")
- Ma tutti i turni sono stati salvati su `profile_id="me"` (profilo legacy) che ha
  `situation_tracking_enabled=false` (default)

**Causa**: il WebSocket `/api/voice/stream` NON riceve il session token. Il handler
provava a risolvere l'uid via fingerprint (IP+UA) memorizzato dal middleware HTTP
recente, ma su iOS TestFlight cellulare l'IP cambia → fingerprint miss → fallback
uid="me". Situation Tracking (opt-in per-profile) resta a 0 perché è disabilitato
sul profilo "me".

### Fix backend (`server.py` @app.websocket("/api/voice/stream"))
Nuovo step di auth PRIMA del fingerprint:
1. Legge `websocket.query_params["token"]`
2. Se presente: lookup `db.sessions.find_one({session_token: qtok})` + verifica expires_at
3. Estrae email → `_email_to_uid()` → set `_current_user_id`
4. Se assente/invalido: fallback su fingerprint (v26)
5. Fallback finale: uid="me"

Applicato ANCHE all'endpoint backup `/voice/stream` per coerenza.

### Fix frontend
- `lib/voiceStream.ts` `buildWsUrl()`: accoda `?token=<session_token>` da `getAuthToken()`
- `lib/voiceClientStt.ts` stessa modifica

### Cosa succederà al prossimo Publish + kill×2
Le conversazioni voce di Fabio verranno correttamente attribuite al suo profilo
(uid=ee4e7261...). Situation Tracking pipeline vedrà `enabled=true` → scriverà
`situations` e `situation_evidences` in modo reale. Il test delle 7 frasi va
ripetuto per popolare la memoria autenticata.

### Note per audit post-Publish
Dopo che Fabio ripubblica e rifà le 7 frasi:
- Verificare `/api/situations` sul profilo Fabio → dovrebbe avere entries
- Verificare `/api/memories` sul profilo Fabio → dovrebbero comparire ricordi
- Auditare se `[TONE:paced]` è stato emesso da Claude nelle risposte

---

## 2026-08-26 — EAS STALE APK DIAGNOSIS + WORKAROUND (v65.1)

### Sintomo
Dopo commit 45a40a6c ("v65.0 Memory Manager + BUILDTAG"), Fabio ha generato 4 APK
Android consecutive dal pulsante Publish di Emergent — TUTTE mostravano ancora
il codice del 28 luglio (BUILDTAG residuo tipo v64.17). Local fs e koda/main HEAD
verificati aggiornati.

### Causa provata (interrogazione diretta u.expo.dev)
Ultimo OTA sul channel `preview` per runtimeVersion=1.0.113 + android:
- createdAt: 2026-07-28T11:15:38.438Z (29 giorni fa)
- version: 1.0.119, versionCode: 13
- updateId: 019fa86f-f946-7476-b307-892fe3486646

Da allora zero OTA nuovi pubblicati nonostante 15+ push su main.
Workflow `.github/workflows/eas-update.yml` non ha funzionato per 29 giorni.
Sospetto: EXPO_TOKEN scaduto o mancante nei GitHub Secrets.

### Fix applicato (commit 4380afe2)
1. `app.json`: `runtimeVersion` bumped `1.0.113` → `1.0.126` (allineato a version).
   Invalida OTA lookup: nuovo APK userà ESCLUSIVAMENTE il bundle embedded.
2. `app/index.tsx`: `KODA_BUILD_SHORT_TAG` = `build-v65.1-runtime-bumped-1.0.126`.
3. Footer Impostazioni: aggiunto display `rt:{runtimeVersion} · vc:{versionCode}`
   per diagnostica immediata al primo boot APK.

### Prossimo passo (utente)
Generare un nuovo APK dal pulsante Publish. Al primo avvio, in Impostazioni:
- Se footer mostra `rt:1.0.126` → problema era OTA stale → workaround riuscito.
- Se footer mostra `rt:1.0.113` → container serve snapshot vecchio → prova per Emergent Support.

Ticket completo pronto in: `/app/EMERGENT_SUPPORT_TICKET_EAS_STALE_v65.md`

---

## 2026-09-06 — RIPRICING MINUTI + DISCLAIMER NO-FAIL-OPEN (v65.35)

### Ripricing basato su costo reale ElevenLabs (Fabio dashboard, ~€0.021-0.024/min)
Nuovi budget e overage cost, margine ~44% verificato:

**`subscription_ledger.py::TIER_BASE_MINUTES`** (source of truth):
- monthly: 90 → **200**
- bimonthly: 100 → **230**
- annual: 110 → **230**

**`server.py::OVERAGE_COST_PER_MINUTE_EUR`**: 0.091 → **0.03**

**`paywall.tsx::PLANS[].minutesLine`** allineato + docstring aggiornato.

**Dead-code sync** (`server.py::TIER_MONTHLY_BUDGET/POOL_MAX/HARD_CAP`):
allineati a 200/230/230 per riferimento, con nota `DEPRECATED — see subscription_ledger.py`.

**Test ledger**: `subscription_ledger_test.py` 13/13 ✓ dopo aggiornamento assertion
(150→280, 210→330, 160→280, over-budget 200→300, ecc.).

Carryover invariato: 50 min/slot; bimonthly picco M2 = 280; annual picco M3 = 330.

### Disclaimer legale — NO fail-open silente
`app/index.tsx` — nuovo stato `network_error` + retry con backoff.

**Prima**: su errore rete → `setDisclaimerState("accepted")` silente → utente
bypassa il disclaimer legale obbligatorio. Esposizione contrattuale (Privacy Policy).

**Dopo**: 4 tentativi con backoff 0/1s/2s/4s → se tutti falliscono,
`disclaimerState = "network_error"` + Modal fullscreen bloccante con CTA "Riprova".
Guard su tutti i router (`disclaimerState !== "accepted"`) impedisce navigazione.
`useCallback` `runDisclaimerCheck` riutilizzato per il retry manuale;
token ref per invalidare retry in coda su unmount.

### Non ancora eseguito (bloccato)
- **VAD Android orb** (`@siteed/audio-studio` swap): richiesto da utente 1b,
  in attesa di conferma compatibilità Samsung One UI prima di swap.
- **Screen Dimmer**: in attesa di log `[KODA_DIMMER]` da `/diagnostics`.

---

## 2026-09-10 — CACHING ANTHROPIC FIXATO END-TO-END (v65.36)

### Root cause reale
`litellm 1.80.0` (versione fornita da `emergentintegrations==0.1.2`) strippa
incondizionatamente `cache_control` da ogni messaggio con model prefix
`openai/*` tramite `OpenAIGPTConfig.remove_cache_control_flag_from_messages_and_tools`.
Il fix upstream (`_should_preserve_cache_control_for_endpoint`, BerriAI/litellm#30387)
è arrivato in versioni successive. Fintantoché `emergentintegrations` blocca
litellm a 1.80.0, il caching resta DISABILITATO senza patch.

### Fix applicati (`server.py`)
1. **Monkey-patch** `OpenAIGPTConfig.remove_cache_control_flag_from_messages_and_tools`
   a no-op, applicato una volta al boot (~riga 10151-10193). Log
   `[KODA_CACHE_PATCH]` conferma attivazione.
2. **`_converse_stream_audio_impl`** (riga 11429): aggiunto `cache_control`
   ephemeral + `stream_options: include_usage`. Bug storico dal 5 giugno 2026
   (call site senza caching).
3. **`/converse` standard path** (riga 6846): migrato da `LlmChat` di
   `emergentintegrations` (che non espone API cache_control) a
   `litellm.acompletion` diretto con content-blocks + cache_control ephemeral.

### Verifica empirica (locale, prompt di produzione REALE 11389 token)
```
T1 first_with_cache_control:  cache_creation=11359  cache_read=0     (write ✅)
T2 second_identical_expected: cache_creation=0      cache_read=11359 (HIT ✅)
T3 baseline_no_cache_control: cache_creation=0      cache_read=0     (atteso)
```
99.7% del prompt cachato al T2. Risparmio 90.3% sull'input LLM = €0.013/min.

### Impatto pricing (rispetto a stime pre-fix)
- Mensile 200 min €19.99: margine da 43% → **~52%**
- Bimestrale 230 min €35.99: margine da 38% → **~47%**
- Annuale 230 min €209.99: margine da 37% → **~46%**

### Telemetria Esperimento D (Fabio 2026-09-10)
Aggiunti log strutturati grep-friendly su `server.py`:
- `[KODA_TIMING] USER_PAYLOAD ... user_audio_ms=<ms>` — durata audio user
- `[KODA_TTS_DUR] sid=... idx=... chunk_dur_seconds=<sec>` — durata TTS chunk

Script analisi: `/app/backend/scripts/analyze_experiment_d.py`
Uso: `railway logs --json | python scripts/analyze_experiment_d.py -`
Risponde alla domanda: "quanto TTS reale per minuto di conversazione venduta?"

### Documenti creati/aggiornati
- `/app/backend/scripts/diagnose_prompt_caching_v3_production.py` — test empirico
- `/app/backend/scripts/analyze_experiment_d.py` — analisi log traffico reale
- `/app/backend/_debug_downloads/caching_diag_v3_production_prompt.json` — prova E2E

---

## 2026-09-10 (turno autonomo) — VAD SWAP PRONTO + DIMMER DIAGNOSTIC

### A) VAD Android — libreria + hook pronti per test empirico
- **Installato** `@siteed/audio-studio@3.2.1` (successore di `@siteed/expo-audio-studio`,
  compatibile Expo SDK 54).
- **Config plugin** in `app.json` con `enableBackgroundAudio: false`,
  `enablePhoneStateHandling: false`, `enableNotifications: false`,
  `enableDeviceDetection: false` — VAD foreground-only, senza obblighi Play Store
  extra e senza permessi non necessari.
- **Hook creato**: `/app/frontend/lib/useLocalVadRecorder.ts`
  - `useAudioRecorder()` con `encoding: 'pcm_16bit'`, `enableProcessing: true`,
    `interval: 100ms`, `keepFullAnalysis: false` (memoria JS bounded 90s)
  - Callback `onAudioAnalysis` legge `dataPoints[last].rms` + `.dB` + `.silent`
  - Soglia voce: `RMS >= 0.02` (calibrare su Samsung reale)
  - Reveal automatico: 15s silenzio consecutivo O 90s totali
  - NO `onAudioStream` handler → PCM non lascia MAI il device (privacy locked)
  - Cleanup su unmount, permessi RECORD_AUDIO idempotenti
- **Pagina test**: `/app/frontend/app/vad-test.tsx` → route `/vad-test`
  - Mostra RMS/dB/orbLevel live, tempo silenzio, contatore reveal
  - Zero rete, zero dipendenze rispetto a `lascia-andare.tsx`
  - Serve per calibrare `RMS_VOICE_THRESHOLD` su Samsung PRIMA di swap definitivo

### `lascia-andare.tsx` NON toccato in questo turno
Motivazione: file è 1464 righe con logica VAD/expo-audio interconnessa. Uno
swap chirurgico richiede:
1. Calibrazione empirica di `RMS_VOICE_THRESHOLD` (turno futuro)
2. Test isolato del reveal timer via `/vad-test` (Fabio, post-build)
3. Solo dopo verifica su Samsung: swap con feature flag `EXPO_PUBLIC_VAD_ENGINE`
   e fallback a MediaRecorder in caso di regressione

### B) Classifier TTS — verificato ready-state
- Test suite `tts_intensity_classifier_test.py`: **13/13 PASSED**
- Attivazione = 1 env var Railway: `KODA_TTS_CLASSIFIER_ENABLED=1`
- Impatto atteso: 83% Turbo / 17% V3 = -40-45% costo TTS/min

### C) Screen Dimmer — diagnostica potenziata (in attesa log user)
- **Detezione no-op iOS Low Power Mode** aggiunta a `animateBrightness`:
  read-after-write ogni ~10 step, log `⚠️ NO-OP DETECTED — wrote=X but read=Y`
  se delta > 0.05. Cattura casi in cui `setBrightnessAsync` ritorna OK ma il
  sistema (Low Power / restrizioni) blocca il valore.
- **Log conversationOn** aggiunto al useEffect di `index.tsx`:
  `[KODA_DIMMER] convActive=X → startWatching (conversationOn=Y, status=Z)`
- Nota architetturale: dimmer parte SOLO se `conversationOn === true` (hands-free).
  Se Fabio testava in tap-to-talk, dimmer non parte per design. Log conferma.

### File modificati / creati
- `/app/frontend/package.json` (+`@siteed/audio-studio@3.2.1`)
- `/app/frontend/app.json` (plugin `@siteed/audio-studio` con config restrittiva)
- `/app/frontend/lib/useLocalVadRecorder.ts` (NEW — hook VAD locale)
- `/app/frontend/app/vad-test.tsx` (NEW — pagina calibrazione)
- `/app/frontend/lib/screenDimmer.ts` (detezione no-op iOS Low Power)
- `/app/frontend/app/index.tsx` (log conversationOn)

### Cosa resta a Fabio
1. **Push GitHub + generate build EAS Android** (per testare `/vad-test` su Samsung
   — Expo Go NON supporta `@siteed/audio-studio`, richiede dev build)
2. Naviga a `/vad-test` sul device Samsung → osserva se RMS varia con la voce
   - Se sì: swap in `lascia-andare.tsx` diventa low-risk (turno futuro)
   - Se no: bug hardware più profondo del previsto, servono altre opzioni
3. Deploy Railway (`git push`) per attivare fix caching (fix precedente,
   turno v65.36)
4. Attivazione classifier TTS: 1 env var Railway `KODA_TTS_CLASSIFIER_ENABLED=1`
5. Enroll Apple Small Business Program prima del primo submit
6. Copiare log `[KODA_DIMMER] heartbeat` + `⚠️ NO-OP DETECTED` da `/diagnostics`
   dopo prossima sessione hands-free per chiudere l'analisi dimmer

---

## 2026-09-10 (autonomo, blind test scaffold) — INFRASTRUTTURA PRONTA

### Deliverable pronti (bloccanti per Fabio: fonte audio Cielo)

**1. Set frasi test** — `/app/backend/scripts/blind_test_phrases.jsonc`
   - 34 frasi in 8 categorie: INTIMITY_PRESENCE (6), EMOTION_HEAVY (5),
     LONG_FORM (4), NORMAL_CONV (5), SURPRISE_LIGHTNESS (4), NAMES_NUMBERS (4),
     HARD_ITALIAN (3), COMPLEX_PROSODY (3).
   - Ogni frase con `why_this_phrase` che documenta cosa stressa.
   - Format JSONC (con commenti) per leggibilità + parser custom in backend.

**2. Backend API** — `/app/backend/routes/blind_test.py`
   - `POST /api/blind-test/session` (crea o riprende sessione tester)
   - `GET  /api/blind-test/next-pair` (prossima coppia BLIND, label A/B randomizzata 50/50)
   - `POST /api/blind-test/vote` (rating 1-10 per clip A + clip B + preferred A/B/TIE + notes)
   - `GET  /api/blind-test/audio/{clip_id}` (serve MP3/WAV, cache-none, no engine leakage)
   - `GET  /api/blind-test/results` (aggregato ADMIN-ONLY, rating medi per engine + preferenze per categoria)
   - Modello DB: `blind_test_sessions`, `blind_test_clips`, `blind_test_votes`,
     `blind_test_pair_serves` (mapping blind label→engine per sessione).
   - Router agganciato a server.py:15450+.

**3. Frontend blind test page** — `/app/frontend/app/blind-test.tsx`
   - Route: `/blind-test`
   - Flow: intake (email+nome) → play A / play B → rating 1-10 × 2 → preferenza A/B/TIE → note → next
   - Progress bar (X su 34), possibilità di riprendere con stessa email
   - Zero label engine (no "V3", no "Kyutai", no loghi) — blind integrity
   - Design coerente con `/vad-test` (sfondo scuro, colori hardcoded per pagina diagnostica)

**4. Generator script** — `/app/backend/scripts/blind_test_generator.py`
   - Modes: `--mock` (silence WAV per test flow), `--engine=A|B|all`
   - Scaffold `generate_v3_reference()` e `generate_kyutai_local()` — raise NotImplementedError con TODO chiari
   - Skip clip già generate (idempotente)
   - Registra ogni clip in `blind_test_clips` con metadata (duration, engine, filepath)

**5. Test flow E2E completato con mock clip** (silence WAV 2s):
   - Session create → next-pair blind → audio serve 200 OK → vote persisted → counter correct
   - 68 clip mock generati (34 frasi × 2 engine), DB popolato
   - Il flow funziona a livello backend+frontend. Manca solo la generazione REALE dei clip.

### Blocker per procedere (Fabio side)

**BLOCCANTE A — Fonte audio reference Cielo**
- Scenario 1 (ideale): file `.wav`/`.mp3` originale usato su ElevenLabs → upload su Emergent Object Storage o `.env: KODA_CIELO_REFERENCE_AUDIO=/path/to/file.wav`
- Scenario 2 (accettabile con caveat): generiamo io stesso 3-5 min via ElevenLabs V3 API su testo neutro come reference → uso quello per clone Kyutai. Documentato come limite metodologico
- Scenario 3 (sconsigliato): nuova registrazione voice actor → costa tempo e soldi

**BLOCCANTE B — ElevenLabs API key + voice_id Cielo**
- Serve `ELEVENLABS_API_KEY` in `.env` + `KODA_CIELO_VOICE_ID`
- Poi implemento `generate_v3_reference()` con `elevenlabs.text_to_speech.convert(model_id='eleven_v3', voice_id=...)` (stesso pattern del fast pipeline in server.py)

**BLOCCANTE C — GPU cloud per Kyutai (già autorizzato $5-10 da Fabio)**
- Modal Labs / Replicate / HuggingFace Inference Endpoints
- Serve API key + endpoint URL
- Alternativa: Kyutai su CPU container Emergent (2-4× real-time, batch offline OK per 68 clip)

**Nota critica su Kyutai TTS 1.6b Italian**:
Il modello è ottimizzato EN/FR. Sull'italiano la qualità è degradata.
Alternative da valutare in un primo A/B **interno** (Fabio+Neo su 5 frasi)
prima di reclutare tester esterni:
- Kyutai TTS 1.6b (baseline)
- MegaTTS3 (Alibaba, migliore su lingue non-EN)
- XTTS-v2 (Coqui, deprecato ma ancora forte su Italian)

Serve decidere quale motore usare come "B" prima di committare 15-20 ore
di infrastruttura. Se anche il migliore fallisce l'A/B interno preliminare,
Piano B si chiude e resta V3 come unica opzione (nessuna necessità di test esterni).

### File modificati / creati in questo turno

- `/app/backend/scripts/blind_test_phrases.jsonc` (NEW — 34 frasi)
- `/app/backend/routes/blind_test.py` (NEW — API blind test)
- `/app/backend/scripts/blind_test_generator.py` (NEW — scaffold)
- `/app/backend/server.py` (registrato router blind_test)
- `/app/frontend/app/blind-test.tsx` (NEW — pagina tester)
- `/app/backend/_blind_test_clips/*.wav` (68 mock clip per test flow)

---

## 2026-09-10 (autonomo, tri-gate protocol) — GATE 1 PRE-TEST PRONTO

### Modifiche applicate su richiesta Fabio (rev v2)

**Rating 3D** (Gate 1 e Gate 2):
- `naturalness`: suona come persona vera? 1-10
- `similarity`: è Cielo? 1-10
- `desirability`: ci parleresti a lungo? 1-10 — **METRICA CRITICA**
- API `POST /vote` aggiornata con 6 rating (3 × 2 clip) + preferenza A/B/TIE
- Aggregate `/results` calcola medie per ciascuna dimensione + wins/losses/ties
- Frontend `blind-test.tsx` con 3 blocchi rating per clip (etichettati con hint semantico)

**Engine B configurabile** via env var `KODA_BLIND_TEST_ENGINE_B`:
- Default: `kyutai_tts_local_B`
- Alternative: `megatts3_local_B`, `xtts_v2_local_B`, `cartesia_cloud_B`
- Cambio env var = automaticamente nuovo motore in test
- Le clip vecchie restano in DB, next-pair filtra sul valore corrente

**Gate 1 pre-test (5 frasi deliberate)**:
Selezione documentata in `blind_test_phrases.jsonc::meta.gate_1_pretest_phrase_ids`:
- `intimity_02`: "Ehi... va tutto bene. Sono qui." (cuore Koda)
- `emotion_02`: "Puoi piangere adesso..." (empatia senza paternalismo)
- `normal_04`: "Mmm, interessante..." ('Mmm' come test crudele)
- `prosody_02`: "Aspetta... no, no. Non intendevo quello..." (disfluenza controllata)
- `hard_it_03`: "Il ghiaccio si scioglie in fretta..." (fonetica italiana difficile)
- Ognuna con `why_this_phrase` che documenta cosa stressa

**Endpoint `/api/blind-test/gate-1-summary`** (admin only):
- Filtra voti solo su sessioni `pretest_only=True`
- Calcola medie 3D per engine A e B
- Verdetto automatico: `PASS` se `desirability_B >= 7.0 AND naturalness_B >= 6.5 AND similarity_B >= 6.0`, altrimenti `FAIL`
- Next action documentata: switch env var al motore successivo se FAIL. Se tutti e 3 falliscono → "chiudiamo il percorso locale ATTUALE (non conclude che TTS locale sia impossibile in assoluto)"

**Tri-gate protocol formalizzato**:
- Gate 1 (tecnico): Neo+Fabio su 5 frasi → merita ulteriore lavoro?
- Gate 2 (prodotto): Neo+Fabio blind test 34 frasi → è abbastanza da essere Cielo?
- Gate 3 (mercato): 5-8 tester esterni + price ladder → utenti preferiscono e pagherebbero?

**Route pubblica** `/blind-test`:
- `AuthGate` in `_layout.tsx` con whitelist `PUBLIC_ROUTES` (`/blind-test`, `/vad-test`)
- I tester esterni accedono via link diretto senza account Koda
- Verificato via screenshot: pagina intake raggiungibile senza login

### Deliverable pronti (attesa sblocco Fabio)

- `/blind-test` (frontend) — intake + rating 3D + progress bar
- `POST /api/blind-test/session` con flag `pretest_only`
- `GET /api/blind-test/gate-1-summary` (admin) — verdetto automatico
- `blind_test_generator.py --engine=B` — pluggable via env var
- `blind_test_phrases.jsonc` — 5 frasi Gate 1 documentate

### Cosa serve da te per far partire Gate 1

1. **`ELEVENLABS_API_KEY` + `KODA_CIELO_VOICE_ID`** in `.env` (bloccante hard)
2. **Autorizzazione clone-of-clone** o file audio originale Cielo (già autorizzato scenario B nell'ultima mail — reference generato via V3 API)
3. **Credenziali GPU cloud** (Modal/Replicate/HF) OPPURE conferma CPU-only 2-4h batch

Con questi 3, in ~4-6 ore consegno le 10 clip Gate 1 (5 frasi × 2 engine), tu ed io le ascoltiamo, decidiamo se Kyutai passa o va al motore successivo. Zero committment sui 68 clip finché Gate 1 non è chiuso.

### File modificati / creati in questo turno

- `/app/backend/routes/blind_test.py` (rating 3D, engine B configurabile, endpoint gate-1-summary, pretest_only flag)
- `/app/backend/scripts/blind_test_phrases.jsonc` (5 frasi Gate 1 + metadata criteri)
- `/app/backend/scripts/blind_test_generator.py` (ENGINE_B_ID via env var)
- `/app/frontend/app/blind-test.tsx` (3 rating blocks, toggle pretest_only)
- `/app/frontend/app/_layout.tsx` (PUBLIC_ROUTES whitelist per bypass AuthGate)

---

## 2026-09-10 — Fix P0 wiring paid-tier subscription_ledger

### Contesto

Prima del wiring:
- `_increment_trial_seconds` skippava esplicitamente i tier `monthly/bimonthly/annual`.
- `subscription_ledger.consume()` era ORFANO nel codice.
- Risultato: utenti paganti avevano minuti effettivi **infiniti** → perdita finanziaria illimitata su heavy user.

### Modifiche `server.py`

1. **Import** `import subscription_ledger as _sub_ledger`.
2. **Nuovo campo `Profile.ledger_state: Optional[Dict[str, Any]]`** — snapshot serializzato di `SubscriptionLedger`.
3. **3 helper aggiunti** (dopo `_increment_trial_seconds`):
   - `_ensure_ledger_dict(profile)` — crea ledger fresh se assente o plan cambiato.
   - `_consume_paid_seconds(profile, seconds)` — consuma dal ledger + persiste in DB + mirror `minutes_used_this_month`.
   - `_compute_paid_state(profile)` — enum `"active"|"warning"|"expired"`.
4. **Gate TTS** (`/api/tts`): utenti paid con `paid_state=="expired"` ricevono 402 `paid_quota_exhausted`.
5. **Accounting sites aggiornati** (HTTP `/api/tts` e WS `_converse_stream_audio_impl`):
   - Free trial → `_increment_trial_seconds` (invariato).
   - Paid tier → `_consume_paid_seconds` (nuovo).
   - Unlimited → nessun accounting.
6. **Bootstrap ledger** su `POST /api/dev/set-tier` e `POST /api/subscription/sync`:
   - Upgrade a paid → `create_ledger(plan)` fresh.
   - Downgrade a None → `ledger_state=null`.
   - Idempotente: se ledger esiste già sul piano corretto, non lo resetta.
7. **Nuovo endpoint `GET /api/subscription/status`** — ritorna `subscription_tier`, `paid_state`, `ledger_summary` (base/carryover/total_available_minutes) e `minutes_used_this_month` per la UI.

### Test verificati

Script `/app/backend/scripts/test_paid_ledger_wiring.py`:
- [1] Fresh profile → ledger creato via `_ensure_ledger_dict`.
- [2] `_ensure_ledger_dict` idempotente.
- [3] Consume 60s → `base_minutes_used=1.0` + mirror allineato.
- [4] 201 min totali su monthly (cap 200) → `paid_state="expired"`, `unfulfilled=1.0`.
- [5] Free tier → `_consume_paid_seconds` ritorna None.
- [6] Upgrade monthly→bimonthly → nuovo ledger con plan corretto.

`GET /api/subscription/status` → 200 OK (utente free): `{"subscription_tier": null, "trial_state": "active"}`.

### Grazia sul turno in corso

Coerente col pattern trial: il consume avviene DOPO la generazione TTS. Se il consume porta il ledger a `expired`, il turno corrente completa; il PROSSIMO tentativo TTS riceve 402.

### File modificati

- `/app/backend/server.py` (+~180 righe: import, campo Profile, 3 helper, gate paid, wiring accounting, bootstrap tier, endpoint status)
- `/app/backend/scripts/test_paid_ledger_wiring.py` (nuovo — regression test)

### Follow-up non fatti in questo turno

- Enforcement WS `/api/voice/stream` (attualmente solo tracking, non gate). Aggiungere quando serve blocco immediato mid-stream (raro: il consume avviene chunk-by-chunk quindi il gate al PROSSIMO turno via `/api/tts` è sufficiente).
- Webhook RC (`/subscription/webhook`) usa tier legacy (`plus/daily/essential`). Non aggiornato — mapping tier RC→interno è task separato.

## EXPERIMENT D — TTS Ratio Endpoint (2026-06)

**Obiettivo:** rispondere a "230 min di piano venduti = quanti min TTS reali?" senza dover parsare log Railway.

### Cosa è stato fatto

1. **Persistenza scalari TTS in `koda_events`** (privacy-safe: solo numeri, zero user_id, zero testo):
   - `tts_seconds` (float): somma durata di tutti i chunk TTS del turno
   - `tts_chunks_count` (int): numero di chunk sintetizzati
   - `user_audio_ms` (int|null): durata parlato utente dal payload STT

2. **Accumulo turn-level in `turn_tts_state`** (`server.py` `_fast_pipeline_task`):
   - Nuovi campi `tts_seconds_total` / `tts_chunks_count` incrementati in `_synth_and_publish` accanto al log `[KODA_TTS_DUR]` esistente.
   - Persistiti sul record `koda_events` a fine turno (line ~15540).

3. **Nuovo endpoint `GET /api/admin/tts-ratio`** (auth: `KODA_ADMIN_TOKEN`):
   - Aggrega ultimi N giorni (max 90).
   - Ritorna:
     - `totals`: events, tts_seconds, user_audio_seconds, chunks
     - `ratio_tts_over_total`: TTS/(TTS+user)
     - `avg_*_per_turn`
     - `projection.expected_tts_minutes` e `expected_tts_cost_eur` per 230 min di piano (€0.023/min ElevenLabs ref)
     - `by_voice_model`: breakdown v3/turbo/flash per capire dove va il budget

### Test verificato

Seed 30 eventi (20 turbo 10s+5s user, 10 flash 7s+4s user) → endpoint ritorna:
- Totali: 270s TTS, 140s user (410s conv)
- Ratio: 0.6585
- Projection 230 min: 151.46 min TTS = **3.48€/mese** ElevenLabs
- Breakdown turbo/flash coerente

### File modificati

- `/app/backend/server.py`: nuovi campi `turn_tts_state`, accumulo in `_synth_and_publish`, persist in `koda_events`, nuovo `@api_router.get("/admin/tts-ratio")` (line 6358).
- `/app/backend/.env`: aggiunto placeholder `KODA_ADMIN_TOKEN` (da ruotare in prod Railway).

### Note operative

- Eventi ANTECEDENTI al deploy non hanno `tts_seconds`/`user_audio_ms` → esclusi dal $match. La finestra utile di dati parte dal deploy.
- Il token admin è lo stesso di `/api/admin/feedback/stats` — riuso identità.



---

## 2026-06-16 — v66.0 Build 41

### Interventi
- **Intro V3 write_test**: Turn interattivo "test 5 frasi" tra conferma nome e handoff LA. Overlay chat testuale con counter N/5 + "Continua" post primo messaggio. Consuma quota Free reale via `/api/converse`. Auto-advance a 5.
- **Lascia Andare modal copy**: Aggiornato in "Non è una chat. È il tuo silenzio. Io non rispondo, non commento." (rimuove ambiguità "AI risponde").
- **IntroPremium (Premium onboarding) semplificato**: Rimossi `coach_la` e `coach_swipe`. Sequenza a 3 coach-mark: orb → hands-free → settings. Handoff diretto a `/` con mark-seen backend.

### Verifica
- Backend testing_agent iter 22: 6/6 pass. Endpoint intro-premium/{state,mark-seen}, converse, freemium/status contract intatti.
- QA on-device richiesta per Intro V3 (mic-gated).
