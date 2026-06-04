## SESSIONE 2026-07 — NATIVE BUILD iOS + ANDROID + FIX VOCE JESSICA

### ✅ NUOVI FIX BACKEND (pre-build)
1. **Bug critico race condition voice reset → Matilda** (server.py)
   - `ProfileUpdate.settings`: cambiato da `TaccuinoSettings` a `Dict[str, Any]`.
     Pydantic non riempie più tutti i default mancanti, evitando overwrite.
   - PUT /api/profile ora fa **merge per campo** anziché replace totale del Settings.
   - DB ripristinato: `tts_voice_id = cgSgspJ2msm6clMCkdW9` (Jessica).
   - Smoke test eseguito: PUT `{theme:"notte"}` preserva voce + background.
2. **Rinforzo genere AI nel prompt italiano** (_build_fast_system_prompt):
   - Genere femminile/maschile ora con esempi obbligatori espliciti.
3. **Bump versioni native**:
   - `ios.buildNumber`: "1" → "2"
   - `android.versionCode`: 1 → 2

### 🟡 IN ATTESA UTENTE
- `EXPO_TOKEN` per autenticazione EAS CLI nel container (sessione scaduta).
- Una volta ricevuto, lancio in parallelo:
  - `eas build --platform ios --profile preview --non-interactive`
  - `eas build --platform android --profile preview --non-interactive`

---


## SESSIONE 2026-06-27 — FIX APP RESUME COLD + ITALIANO CORRETTO

### ✅ NUOVI FIX CRITICI

1. **APP RESUME COLD** (sintomo ricorrente: "apro dopo qualche tempo, non registra + chat vuota")
   - File: `frontend/app/index.tsx` linea 596-655 (AppState 'active' handler)
   - Causa: il listener AppState al ritorno foreground faceva SOLO reset error/idle.
     Non riattivava AVAudioSession (mic restava suspended), non ricaricava timeline
     (memoria stantia), non ricaricava profilo (settings/tema sbagliati).
   - Fix: 3 operazioni parallele non-blocking al resume:
     - `prewarmMic()` → riattiva audio session iOS
     - `api.getTimeline(200)` + setTimeline (merge con confessionali locali)
     - `api.getProfile()` + setProfile
   - Pubblicato come OTA EAS.

2. **PROFILO 728 KB AL COLD START** (causa indiretta del precedente)
   - File: `backend/server.py` endpoint `/api/profile`
   - Causa: l'utente aveva un'immagine background base64 grande (546 KB JPEG).
     Il GET /profile ritornava 728 KB. Cold start lentissimo, eventuali timeout/
     parsing falliti, l'UI mostrava default invece di valori reali.
   - Fix:
     - GET /profile ora rimuove il base64 dal campo settings.background, lo
       sostituisce con il puntatore "@server:/api/profile/background" → profile
       da 728 KB a 5 KB.
     - Nuovo endpoint `GET /api/profile/background` serve l'immagine come binary
       con `Cache-Control: private, max-age=86400` (carica una volta, cache 24h).
     - Nota: client NON sa ancora caricare l'endpoint separato → mostra
       background di tema (Sabbia/Notte/etc) finché OTA frontend non aggiornato.

3. **PROFILI DUPLICATI nel DB** (race condition con uvicorn --workers 2)
   - File: `backend/server.py` get_or_create_profile
   - Causa: 2 worker uvicorn + client che chiama GET /profile in parallelo al boot
     → entrambi vedono "vuoto" → entrambi insertano → 2 profili `id="me"`
     → Mongo ritornava casualmente uno dei due → ogni tot l'app sembrava "resettata"
     (no nome, ai_name='Coda', no memoria).
   - Fix:
     - Aggiunto UNIQUE INDEX su collection.id
     - `get_or_create_profile` ora cattura DuplicateKeyError e rilegge il vincente
     - Eliminato manualmente il duplicato vuoto residuo

4. **VAD CHIUDEVA TROPPO PRESTO** (sintomo: "Deepgram dice 'non ti ho sentito'")
   - File: `frontend/lib/voice.ts`
   - Causa: SILENCE_DURATION_MS=900, MIN_SPEECH_MS=350 → recording 2s →
     Deepgram restituiva transcript vuoto (necessita >=2.5s audio).
   - Fix: SILENCE_DURATION_MS=1500, MIN_SPEECH_MS=700.

5. **TTS CHIPMUNK/VELOCE**
   - File: `backend/server.py` fast pipeline
   - Causa: `mp3_44100_64` + `optimize_streaming_latency=4` causavano artefatti
     percepiti come "voce velocissima".
   - Fix: tornato a `mp3_44100_128` (qualità piena), rimosso optimize_streaming_latency
     del tutto (default ElevenLabs).

6. **ITALIANO SCORRETTO** (pronomi, articoli)
   - File: `backend/server.py` `_build_fast_system_prompt`
   - Causa: il prompt condensato fast aveva tagliato le regole sull'italiano corretto.
   - Fix: aggiunta sezione "ITALIANO CORRETTO" con regole su articoli (il/lo/la/gli),
     pronomi atoni (glielo/me lo/te ne), concordanza, apostrofi. Prompt ora 2692 chars.

### 📊 NUMERI MISURATI ULTIMI (post-fix)
Fast path:
- TTFT 1850-2496ms
- TTS 147-480ms
- Total 2159-2982ms
VAD: ora trascrive correttamente frasi di 5-10 parole (audio 50-90 KB).

### 🟢 STATUS APP
- Crash confessionale: RISOLTO (KDF iter)
- Timeline visibile in modalità scrittura: RISOLTO (cold start fix + resume fix)
- Velocità VAD: RISOLTO (1500ms silence)
- Italiano corretto: in attesa di test utente (modifica appena fatta)
- Velocità voce normale: in attesa di test utente
- Resume da background: in attesa di test utente (OTA appena pubblicato)

### 🟠 ANCORA DA FARE (prossima sessione, NON urgenti)
- 🔴 **TUTELA LEGALE / SAFETY GUARDRAILS** (PRIORITÀ ALTA prima della pubblicazione):
  - Schermata onboarding con disclaimer esplicito: "Koda è un'IA, non un professionista.
    In caso di crisi chiama 112 o Telefono Amico (02 2327 2327). Vietato sotto i 14 anni."
  - Verifica età all'onboarding (GDPR-K / GDPR conformità).
  - Clausola crisi nel prompt fast E sealed: rilevamento pensieri suicidi/autolesionismo
    → validazione breve + raccomandazione professionista + numero emergenza.
  - Clausola autolesionismo a terzi / abuso minori → Claude rifiuta con cura.
  - Privacy Policy + Terms of Service redatti da legale esperto AI Act/GDPR.
  - AI Act EU 2026 compliance: trasparenza esplicita che Koda è AI, non umano.
  - Auditing conservazione log: il sealed NON deve mai loggare testo in chiaro
    server-side (già OK, da verificare formalmente prima del rilascio pubblico).
  - Documentazione interna comportamenti Koda davanti a: suicidio, violenza, illegalità,
    CSAM, confessioni di crimini già commessi, disturbi mentali gravi, minori a rischio.
  - Filtro pre-input lato client per soglie OBBLIGATORIE (es. rilevamento parole chiave
    crisi nel transcript → mostro popup con numero emergenza PRIMA di mandare a Claude).
- OTA frontend per caricare background dall'endpoint dedicato `/api/profile/background`
- Refactor `frontend/app/index.tsx` (5100+ righe → suddivisione)
- Refactor `backend/server.py` (>4000 righe)
- Pulizia trace points debug `/api/dbg-trace` quando l'utente conferma stabilità
- KodaIntro tutorial redesign 4 schermate
- Colori bolle messaggi dinamici per tema
- Automatismo tema giorno/notte

### 💰 RISPARMIO CREDITI
Tutti i fix backend zero-OTA. Solo 2 OTA pubblicati in questa sessione:
1. VAD 1500ms + TTS chipmunk fix
2. Resume cold (timeline + profile + audio)

---



### ✅ FIX CRITICI APPLICATI E PUBBLICATI VIA EAS OTA

1. **CRASH CONFESSIONALE RISOLTO** (vero root cause)
   - File: `frontend/lib/sealedCrypto.ts`
   - Causa: `KDF_ROUNDS = 100000` bloccava il main thread JS per 12-14s
     durante deriveKey → iOS watchdog killava l'app appena l'utente tappava
     "registra" in confessionale.
   - Verifica: trace points hanno mostrato sealed-1-start a 14:43:53,
     sealed-3-seal-msg a 14:44:07 = 14 secondi di blocco. iOS killa app
     se main thread inattivo > 10s.
   - Fix: `KDF_ROUNDS = 5000` (deriveKey ora <1s). Sicurezza ampia per
     una Parola Segreta come secondo fattore.
   - User feedback: "sembra funzionare anche il confessionale" ✅

2. **HOME CHE SI RESETTA + TEXTINPUT CHE PERDE FOCUS** (root cause)
   - File: `frontend/app/index.tsx` linea 1394-1402
   - Causa: dopo ogni risposta AI il codice faceva `api.getProfile() +
     setProfile(p)`. Questo triggerava rerender → inputMode ricomputato
     → TextInput rimontata → focus perso. Inoltre il pager riceveva
     uno scroll layout-time spurio → viewMode resettato a "voice" →
     l'app "tornava alla home da sola".
   - Fix: rimosso il refetch automatico post-conversation. Il profile
     si rilegge solo al boot/apertura Settings/reset memoria.

3. **VOCE METALLICA RISOLTA**
   - File: `backend/server.py` fast pipeline
   - Causa: `output_format="mp3_22050_32"` (32 kbps) era troppo basso
   - Fix: `output_format="mp3_44100_64"` (64 kbps @ 44.1 kHz)

4. **BUG TTS SILENZIOSO (use_v3 not defined)**
   - File: `backend/server.py` fast pipeline
   - Causa: dopo refactor `use_v3` non era più definita ma altri riferimenti
     erano rimasti → eccezione catturata silently → audio mai pubblicato
     → watchdog client a 25s = app pareva freezata
   - Fix: rimosso tutto il codice `use_v3`, sempre flash_v2_5

5. **OPTIMIZE_STREAMING_LATENCY ABILITATO**
   - File: `backend/server.py`
   - Aggiunto `optimize_streaming_latency=4` per Flash v2.5 (TTFB ~75ms)

### 📈 NUMERI ATTUALI MISURATI (server-side, iPhone reale)

Fast path normale:
- TTFT Claude: 1700-2700ms (proxy Emergent LLM)
- TTS Flash v2.5: 150-400ms (frasi brevi)
- Total: 2000-3200ms ⚠️ (utente vuole 1-2s — DA OTTIMIZZARE)

### 🆕 NUOVE INFRASTRUTTURE BACKEND AGGIUNTE

- `POST /api/converse-fast/start` + `GET /api/converse-fast/poll/{sid}` —
  pipeline streaming frase-per-frase con MongoDB session storage (compatibile
  con uvicorn --workers 2)
- `POST /api/dbg-trace` — endpoint per trace points dal client (utile per
  debug crash su build standalone senza accesso ai console.log)
- `_build_fast_system_prompt` — prompt condensato (~2900 chars vs ~14000)

### 🆕 NUOVA INFRASTRUTTURA CLIENT

- `SpeechMod.fastConverse(text, opts)` in `frontend/lib/speech.ts` —
  client del fast path con pollster + player paralleli
- Trace points client→backend nel sealed flow di index.tsx

### 🟠 PROSSIMA SESSIONE — RICHIESTE UTENTE PENDING

1. **VELOCITÀ ANCORA ALTA** (utente: "lentissima un'altra volta")
   - Servono altre ottimizzazioni:
     - Anthropic prompt caching via litellm (cache_control header)
     - Streaming TTS reale (non `convert()`) per ridurre TTS latency
     - Magari rimuovere il json wrapper dalla risposta Claude
2. **Koda non sa cos'è il confessionale**
   - File: `backend/server.py` sealed prompt (`_build_sealed_prompt` o
     simile — da trovare)
   - L'AI risponde "non so cos'è" quando l'utente chiede del confessionale.
     Aggiungere al prompt sealed la conoscenza che è IN un confessionale.
3. **Redesign KodaIntro tutorial** (4 schermate minimali) — non iniziato
4. **Colori bolle messaggi dinamici per tema** — non iniziato
5. **Automatismo tema giorno/notte** — non iniziato

### 🧹 PULIZIA FATTA

- Eliminato file orfano `frontend/lib/bridge.ts`
- Rimosse referenze dead `userTierRef`/`detectTier` in index.tsx

### ⚠️ DEBT TECNICO (trace points)

I trace points client→backend (POST `/api/dbg-trace`) sono ANCORA NEL
CODICE client (index.tsx sealed flow). Vanno rimossi quando confermiamo
che il fix KDF è definitivo. Non urgente — non danneggiano nulla, solo
qualche request HTTP in più durante il confessionale.

### 💰 CREDITS BURNED

Utente ha riferito ~400 crediti spesi in questa sessione. Si è giustamente
arrabbiato perché molti tentativi precedenti non centravano il vero
problema (era il KDF, non il modello LLM né il bitrate né l'output format).
LEZIONE: usare TRACE POINTS sin dall'inizio per misurare DOVE
crasha invece di tirare a indovinare.

---



backend:
  - task: "Endpoint /api/converse-fast/start + /poll (sub-2s pipeline)"
    implemented: true
    working: true
    file: "backend/server.py"
    priority: "critical"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunto NUOVO endpoint fast-path POST /api/converse-fast/start +
          GET /api/converse-fast/poll/{sid}?since=N&timeout=N.
          Pipeline:
            1. POST start → genera session_id, ritorna subito
            2. Task background: streamma Claude Haiku 4.5 con PROMPT CONDENSATO
               (~2900 chars vs ~14000 char originale = TTFT crolla da ~1000ms a ~300-800ms)
            3. Ogni frase completa → ElevenLabs Flash v2.5 → _store_tts_audio() → token
            4. Eventi pubblicati nella sessione: sentence (con token), meta (finale), error
            5. Client long-polla /poll → riprende token man mano
          Misurato in locale: TTFT Claude 828-1471ms, TTS Flash 195-299ms,
          totale server-side 1.1-1.7s per prima frase. Target rispettato.
          Aggiunto _build_fast_system_prompt(): identità Koda essenziale,
          generi, lunghezza max 25 parole, audio tag, azioni theme/ai_name/etc,
          formato JSON con reply primo campo.
          Sessioni in-memory con TTL 5min e LRU cap 64.
          Safety net theme conservata.
      - working: true
        agent: "testing"
        comment: |
          TAVILY WEB-SEARCH INTEGRATION RETEST (2026-06-04) via
          /app/backend_test.py against
          https://app-finder-408.preview.emergentagent.com/api.
          ALL 3 CASES PASS end-to-end (start 200, polling reaches done=true,
          meta event delivered with non-empty reply).

          ✅ TEST 1 — "Cerca le ultime notizie dall'Italia" (explicit trigger)
             - POST /converse-fast/start → 200 (184ms)
             - session_id=2d607442…  total wallclock 4014ms, polls=1, done=true
             - Backend logs (excerpts):
               [fast 2d607442] web-search triggered for: Cerca le ultime notizie dall'Italia
               [fast 2d607442] web-search done in 1787ms, brief=yes
               [fast 2d607442] LLM start, prompt 8514 chars
               [fast 2d607442] TTFT: 919ms
               [fast 2d607442] FIRST AUDIO ready: 3724ms (tts=409ms)
               [fast 2d607442] DONE in 3730ms (1 sentences)
             - reply: "L'Ue ha dato 14 miliardi all'Italia per rinnovabili, la
               Repubblica compie 80 anni, e c'è dibattito sulla destra politica.
               Cosa ti interessa di più?"  (uses live web facts, NO refusal)

          ✅ TEST 2 — "Che tempo fa oggi a Roma?" (factual keyword)
             - POST start → 200 (161ms); total 3839ms, done=true
             - Logs:
               [fast e496c7aa] web-search triggered for: Che tempo fa oggi a Roma?
               [fast e496c7aa] web-search done in 1703ms, brief=yes
               [fast e496c7aa] TTFT: 997ms
               [fast e496c7aa] DONE in 3645ms (1 sentences)
             - reply: "A Roma oggi massima di 29°C, cielo parzialmente
               nuvoloso, minima 18°C stasera. Venti leggeri da nordest."
               → contains temperature (29°C, 18°C), city (Roma), and weather
               keywords (cielo, nuvoloso) — Tavily brief reached prompt.

          ✅ TEST 3 — "Ciao, come va? Oggi mi sento un po' stanco." (no trigger)
             - POST start → 200 (119ms); total 2048ms, done=true
             - Logs DO NOT contain any "web-search triggered" line for this
               session_id (1b3b6b3f…). Only LLM start / TTFT / FIRST AUDIO /
               DONE — exactly as expected for the empathic conversational path.
             - reply: "Ciao Fabio, ti capisco. Vuoi stare un po' qui, o
               preferisci muoverti un po'?" (empathic, no web facts injected)

          Tavily integration via tavily-python==0.5.0 + TAVILY_API_KEY is
          fully functional: heuristic _should_web_search correctly gates
          calls, _tavily_search_brief returns brief in ~1.7s, injection
          into the user_payload as "RISULTATI WEB SEARCH" block is
          producing fresh, factual replies (no "non ho accesso a internet"
          refusals). No 5xx, no timeouts. Endpoint marked working=true.

frontend:
  - task: "SpeechMod.fastConverse() — client per fast path"
    implemented: true
    working: "NA"
    file: "frontend/lib/speech.ts"
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunta nuova funzione esportata fastConverse(text, opts) che:
          1. POST /api/converse-fast/start
          2. Lancia pollster + player paralleli
             - pollster: long-poll continuo, popola tokenQueue
             - player: consuma queue, riproduce ogni token sequenziale via
               /api/tts/audio/{token}.mp3 (URL statico con Content-Length+Range,
               iOS AVPlayer compatibile)
          3. Callback onAudioStart() al primo suono reale → UI switch a "speaking"
          4. Callback onMeta() appena arriva il meta event → aggiorna timeline e
             esegue actions PRIMA che l'audio finisca (chat fluida).
          5. Hard timeout 45s + abort controller per stop().

  - task: "sendText() — usa fast path"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Sostituito il flusso lento /converse + /tts/prepare con:
            useFastPath = profile.settings.voice_response !== false;
            if (useFastPath) → await SpeechMod.fastConverse(...);
          Onmeta inserisce subito user+ai entries in timeline e esegue actions.
          OnAudioStart switcha status a "speaking" QUANDO l'audio inizia davvero.
          Watchdog 25s + setError gracefully.
          Sealed/confessional con seal: branch separato non toccato.
          Confessional soft: usa fastConverse con ephemeral=true.
          Removed: vecchio blocco dead-code /converse-stream-audio (era già
          disattivato con useFastPath=false). Standard flow rimane come fallback
          se fastConverse fallisce o l'utente ha disattivato la voce.

metadata:
  created_by: "main_agent"
  version: "1.0"
  test_sequence: 0
  run_ui: false

test_plan:
  current_focus: []
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Implementato fast path completo per sub-2s latenza. Backend testato locale
      con curl: 1.1-1.7s totali server-side. Frontend bundling OK in 3.7s.
      In attesa autorizzazione utente per testing automatico (test agent vietato
      finora per risparmio crediti). Test via OTA EAS update sul device fisico
      iOS preferito dall'utente.
  - agent: "testing"
    message: |
      Tavily web-search integration on /api/converse-fast/* tested end-to-end
      (2026-06-04, /app/backend_test.py vs preview URL). ALL 3 cases ✅:
        1) "Cerca le ultime notizie dall'Italia"   → web-search triggered,
           brief=yes (1787ms), reply uses live IT news.
        2) "Che tempo fa oggi a Roma?"             → web-search triggered,
           brief=yes (1703ms), reply contains 29°C / 18°C / cielo / Roma.
        3) "Ciao, come va? Oggi mi sento un po' stanco." → NO trigger,
           normal empathic reply. No "web-search triggered" log line emitted.
      Endpoints /api/converse-fast/start and /poll both return 200 across
      all runs, polling reaches done=true within 2–4s, no 5xx, no timeouts.
      Heuristic _should_web_search, _tavily_search_brief (Tavily 0.5.0 +
      TAVILY_API_KEY), and "RISULTATI WEB SEARCH" injection block all work
      as designed. Backend marked working=true / needs_retesting=false.

---


## FASE 4 STEP 1 — Migrazione expo-audio + Deepgram Nova-3 (2026-06)

backend:
  - task: "Endpoint /api/transcribe-deepgram (Nova-3, italiano)"
    implemented: true
    working: "NA"
    file: "backend/server.py"
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunto endpoint POST /api/transcribe-deepgram che usa Deepgram REST
          API (model=nova-3, smart_format, punctuate). Ritorna {"text": "..."}
          stesso formato di /transcribe per compat. DEEPGRAM_API_KEY in .env.

frontend:
  - task: "Migrazione voice.ts da expo-av a expo-audio"
    implemented: true
    working: "NA"
    file: "frontend/lib/voice.ts"
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Riscritto completamente con expo-audio (AudioRecorder API moderna).
          expo-av causava session leak/wedge su iOS dopo 2-3 turni.
          expo-audio ha gestione interna della AVAudioSession molto più
          affidabile. Mantenuto modello tap-to-talk puro.

  - task: "Migrazione speech.ts da Audio.Sound a expo-audio AudioPlayer"
    implemented: true
    working: "NA"
    file: "frontend/lib/speech.ts"
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          createAudioPlayer + addListener("playbackStatusUpdate") al posto
          di Audio.Sound.createAsync + setOnPlaybackStatusUpdate.
          stopAllPlayback usa player.remove() che libera completamente la
          session iOS — punto chiave del miglioramento.

  - task: "Client switch a /api/transcribe-deepgram con fallback Whisper"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Prima chiama Deepgram Nova-3 (sub-secondo, accurato). Se fallisce
          fallback automatico a /transcribe (Whisper). Risultati gestiti
          identicamente — drop-in replacement trasparente.

  - task: "app.json: aggiunto plugin expo-audio con microphonePermission"
    implemented: true
    working: "NA"
    file: "frontend/app.json"
    needs_retesting: true


## FIX MICROFONO STUCK + VOCE TAGLIATA (2026-06 — RCA-driven)

frontend:
  - task: "voice.ts: fallback timer per metering undefined (FIX P0 stuck recording)"
    implemented: true
    working: "NA"
    file: "frontend/lib/voice.ts"
    stuck_count: 0
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          RCA (troubleshoot_agent): la silence detection viveva interamente
          dentro setOnRecordingStatusUpdate, ma su alcuni device iOS il campo
          `metering` può essere undefined nonostante isMeteringEnabled:true.
          In quel caso il blocco veniva saltato → nessun silenceCb → microfono
          stuck fino al watchdog 45s.
          Fix: aggiunto `fallbackTickId` setInterval(500ms) che traccia
          lastStatusUpdateAt + everSawMetering, e chiude:
            - 10s se metering MAI arrivato
            - via fireSilenceIfNeeded se metering è bloccato >3s
            - hard cap 60s comunque

  - task: "voice.ts: setAudioModeAsync di fallback se stopAndUnloadAsync fallisce"
    implemented: true
    working: "NA"
    file: "frontend/lib/voice.ts"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Se stopAndUnloadAsync throwa, la session iOS resta in playAndRecord
          → la prossima Recording fallisce silenziosamente. Ora se l'unload
          non riesce forziamo setAudioModeAsync(allowsRecordingIOS:false).

  - task: "speech.ts: rimosso 2.5s grace, didJustFinish è UNICA via di success (FIX P1 voce tagliata)"
    implemented: true
    working: "NA"
    file: "frontend/lib/speech.ts"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          RCA: il setTimeout 2.5s su isLoaded:false terminava il playback
          durante normali buffer underrun MP3 → "voce tagliata mid-sentence".
          Fix: didJustFinish è ora l'UNICA via di completamento OK.
          isLoaded:false viene SEMPRE trattato come buffering.
          Aggiunto stall-watcher che chiude SOLO se positionMillis non
          progredisce per >12s dopo che ha iniziato a suonare.
          safetyTimer aumentato 30→45s.

  - task: "index.tsx: recRef.current = null DOPO await su current.stop()"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Prima nullavamo recRef PRIMA dell'await. Se stop() hangava la
          sessione audio iOS restava in record mode → "stuck recording"
          persistente. Ora rilasciamo il ref SOLO dopo l'unload completo
          (o dopo che voice.ts ha forzato setAudioModeAsync).

  - task: "index.tsx: SpeechMod.isSpeaking() al posto di status==='speaking'"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          startTalkInternal ora controlla SpeechMod.isSpeaking() (verità
          live) invece dello stato React (possibile stale). Evita di
          interrompere il TTS quando si attiva il loop conversazionale.

  - task: "index.tsx: watchdog recording 45→20s + await su stop()"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Watchdog recording ridotto da 45s a 20s (col fallback voice.ts
          un turno legittimo dura <15s). Ora awaita stop() con Promise.race
          fino a 3s per garantire la release della session audio.


## ELEVENLABS — FIX RIPRODUZIONE AUDIO + VOLUME iPhone + UX (2026-05-07 v2)

frontend:
  - task: "speech.ts: scrivere MP3 su file system invece di data-URI (fix audio mute)"
    implemented: true
    working: "NA"
    file: "frontend/lib/speech.ts, frontend/package.json"
    stuck_count: 0
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Diagnosi: i log backend mostravano /api/tts 200 OK (l'MP3 arrivava al device) ma
          l'utente sentiva sempre la voce robotica di expo-speech. Causa: data-URI base64 dentro
          Audio.Sound.createAsync è inaffidabile su mobile (spesso fallisce silenziosamente).
          Fix: aggiunto expo-file-system@55.0.19, ora playElevenLabsNative scrive l'MP3 in
          FileSystem.cacheDirectory come file reale e Audio.Sound.createAsync({uri: fileUri})
          carica dal disco. File cancellato dopo la riproduzione.
  - task: "speech.ts: setAudioModeAsync per playback (fix volume buttons iPhone)"
    implemented: true
    working: "NA"
    file: "frontend/lib/speech.ts"
    stuck_count: 0
    priority: "critical"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Problema utente: su iPhone i tasti fisici del volume non controllavano la voce
          (perché audio session restava in 'playAndRecord' dopo la registrazione, che mappa
          su un canale dove i tasti di volume hardware non lo controllano direttamente).
          Su Android l'audio veniva inoltre potenzialmente routato all'auricolare.
          Fix: prima di ogni Audio.Sound.createAsync ora chiamiamo:
            allowsRecordingIOS: false  (passa a categoria 'playback')
            playsInSilentModeIOS: true (suona anche con switch silenzioso)
            playThroughEarpieceAndroid: false (forza speaker principale)
            shouldDuckAndroid: true
          Risultato: tasti volume hardware ora controllano l'audio AI; su Android suona
          dall'altoparlante principale a volume pieno.

  - task: "Voice picker UX: tap = seleziona + ascolta (no play button)"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Rimosso il bottone play separato. Ora tap su una card voce chiama selectAndPreviewVoice
          che salva la scelta sul profilo + suona automaticamente un'anteprima della frase
          "Ciao, sono <Nome>. Sarò io a parlarti, da adesso." Indicatori a destra: spinner
          mentre carica, checkmark verde se selezionata, icona volume se non selezionata.

agent_communication:
  - agent: "main"
    message: |
      Fix critici alla riproduzione TTS ElevenLabs:
      1. MP3 ora scritto su FileSystem invece di data-URI (era il motivo per cui la voce
         robotica suonava sempre — Audio.Sound non riusciva a caricare l'audio dal data-URI
         su mobile, cadeva sempre sul fallback expo-speech).
      2. Audio session impostato in modalità playback prima di ogni TTS: tasti volume iPhone
         ora funzionano, su Android audio dall'altoparlante a volume pieno.
      3. UX: tap sulla card voce = seleziona + ascolta automaticamente, niente bottone play.
      Backend TTS testato: 200 OK + MP3 ID3 valido. In attesa verifica utente sul device.


## ELEVENLABS TTS INTEGRATION (2026-05-07)

backend:
  - task: "ElevenLabs TTS endpoint /api/tts"
    implemented: true
    working: "NA"
    file: "backend/server.py, backend/.env, backend/requirements.txt"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunto pacchetto elevenlabs==2.45.0 e nuovo endpoint POST /api/tts che ritorna
          MP3 binario (Response media_type=audio/mpeg). Usa eleven_multilingual_v2 con
          voice_settings configurabili (stability, similarity_boost). Endpoint testato con
          curl: 200 OK + MP3 ID3 valido (~30KB per frase breve).
          Aggiunto endpoint GET /api/voices che ritorna lista curata di 8 voci adatte all'italiano
          (Matilda, Sarah, Charlotte, Jessica, Liam, Charlie, Callum, Daniel) + tenta di
          aggiungere voci custom dell'utente (se la chiave ha permesso voices_read; oggi 401).
          API key memorizzata in backend/.env come ELEVENLABS_API_KEY.

  - task: "TaccuinoSettings: tts_voice_id, tts_provider, tts_stability, tts_similarity_boost"
    implemented: true
    working: "NA"
    file: "backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Estesa TaccuinoSettings con campi per la voce TTS. Default voice_id = Matilda
          (XrExE9yKIg1WjnnlVkGX). I campi sono opzionali nel ProfileUpdate.

frontend:
  - task: "lib/speech.ts riscritta per ElevenLabs + fallback expo-speech"
    implemented: true
    working: "NA"
    file: "frontend/lib/speech.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          SpeechMod.speak() ora chiama prima POST /api/tts e riproduce MP3 via expo-av (Audio.Sound)
          su native e <audio> blob su web. Su errore o quando ElevenLabs non è disponibile, fallback
          automatico a expo-speech / Web Speech API. setDefaultVoiceId() permette di sincronizzare
          la voce dal profilo. AbortController + currentSound + currentWebAudio per supportare
          barge-in (stop immediato dell'audio quando l'utente inizia a parlare).

  - task: "Selettore voce nelle Impostazioni"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx, frontend/lib/api.ts"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuova sezione "Voce dell'assistente" nel modal Impostazioni con elenco voci e bottone
          play di anteprima. Tap su card seleziona e salva su profilo, sincronizza speech module.

  - task: "Pulsante centrale: niente cerchi, più grande, glow neon sfumato, respiro più ampio"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Rimossi gli outer/inner ring (bigBtnRingOuter, bigBtnRingInner). Pulsante ora 130x130 con
          icona mic 54px. Aggiunti due halo absolute (neonGlow 150x150, neonGlowSoft 160x160) con
          shadowRadius alto + boxShadow grande color t.primary, animati indipendentemente con scale
          1.0->1.35 e 1.1->1.6 e opacity pulsanti. Il bottone respira da scale 0.86 a 1.16 (~30%
          range, molto più visibile dei precedenti 0.94-1.09). Risultato: niente bordi/cerchi rigidi,
          effetto neon "che respira" diffuso sotto il pulsante. Verificato via screenshot.

agent_communication:
  - agent: "main"
    message: |
      Integrato ElevenLabs TTS. Backend: nuovi endpoint /api/tts (MP3) e /api/voices.
      Frontend: speech.ts ora usa ElevenLabs con fallback a expo-speech, selettore voce
      nelle Impostazioni con preview, pulsante centrale ridisegnato (no rings, più grande,
      glow neon sfumato, respiro più ampio). Backend testato con curl: TTS 200 OK + MP3 valido.
      L'API key dell'utente attualmente non ha il permesso voices_read (warning 401 nei log
      backend) ma questo non è bloccante: usiamo voci curate con voice_id ben noti.
      In attesa verifica utente sul dispositivo. Da testare: voce assistente nelle conversazioni,
      preview voci, persistenza scelta voce, breathing button più espressivo.


#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

## SESSION B — ZERO-KNOWLEDGE CRYPTO + WEB SEARCH (2026-05-10)

backend:
  - task: "POST /api/converse/sealed — Confessionale Zero-Knowledge"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuovo endpoint POST /api/converse/sealed che riceve {nonce, ciphertext}
          + chiave volatile in header X-Sealed-Key. Decifra in RAM con NaCl
          secretbox (XSalsa20-Poly1305), chiama Claude con prompt minimale
          (no memory, no history, vera sessione stateless), ricifra la risposta
          con la stessa chiave + nonce nuovo, ritorna {nonce, ciphertext, tone}.
          NIENTE viene loggato (solo l'evento "[sealed] confessional turn
          completed"), NIENTE persistito su DB, NIENTE memory_summary update.
      - working: true
        agent: "testing"
        comment: |
          Tested via /app/backend_test_session_b.py against
          https://app-finder-408.preview.emergentagent.com/api. ALL 8 sub-tests PASS.

          ✅ 1a) Happy path: encrypted "Devo confessare una cosa terribile,
                 ho fatto male a una persona" with random 32-byte key, sent
                 to /api/converse/sealed → 200 with {nonce, ciphertext, tone}.
                 Decrypted with the SAME key → readable Italian empathic reply:
                 "[gently] Ti ascolto, fratello. Questo peso che senti...
                  vuoi dirmi cos'è successo? Sono qui."
                 tone='warm' (one of the allowed enum values).
          ✅ 1b) Missing X-Sealed-Key header → 400 "missing X-Sealed-Key".
          ✅ 1c) Invalid base64 in X-Sealed-Key → 400 "invalid base64 payload".
          ✅ 1d) 16-byte X-Sealed-Key → 400 "invalid key length".
          ✅ 1e) 12-byte nonce → 400 "invalid nonce length".
          ✅ 1f) Wrong key (cipher won't decrypt) → 400 "decrypt failed".
          ✅ 1g) GET /api/timeline count BEFORE/AFTER sealed call: unchanged
                 (35 entries before and after) — sealed turn does NOT persist.
          ✅ 1h) GET /api/profile.memory_summary unchanged across the sealed
                 call — sealed turn does NOT mutate long-term memory.

          Backend logs during test: only the benign event marker
          "[sealed] confessional turn completed (no content stored)." appears,
          NO plaintext leaked, NO 5xx. Endpoint is fully functional.

  - task: "POST /api/search — Web Search via Wikipedia REST API (no API key)"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Endpoint POST /api/search che usa DuckDuckGo HTML (https://html.duckduckgo.com)
          per fare ricerca pubblica senza API key. Estrae top-N risultati con
          regex su result__a / result__snippet. URL ridiretti via duckduckgo.com/l
          vengono unwrappati al target reale.

          Test manuale curl: query "chi ha vinto champions 2024" →
          4 risultati con title/snippet/url puliti, primo è Wikipedia
          UEFA Champions League 2024-2025 con snippet "vinta dal Paris
          Saint-Germain... 5-0".
      - working: false
        agent: "testing"
        comment: |
          Endpoint CONTRACT works (HTTP 200 always, no 5xx, parameter
          validation correct, max_results cap respected, empty query handled
          gracefully). However the upstream DuckDuckGo HTML endpoint is
          UNREACHABLE from the deployed backend's egress, so all real queries
          return results=[] rather than actual web hits.

          Evidence:
            - POST /api/search {"query":"chi ha vinto la champions league 2024",
              "max_results":4} → 200 {"query":"...","results":[]}  (FAIL: expected
              1-4 items)
            - POST /api/search {"query":""} → 200 results=[] (PASS, expected)
            - POST /api/search {"query":"italia notizie oggi","max_results":8}
              → 200 results=[] (cap=0, PASS-by-default since cap respected)
            - Backend logs during the run repeatedly emit:
                "server - WARNING - duckduckgo fetch failed:"
              (httpx ConnectTimeout to html.duckduckgo.com — empty exc message
              because the connect simply times out before any HTTP exchange).
            - Direct probe from the same egress:
                curl -m 8 https://html.duckduckgo.com/html/?q=test → HTTP=000,
                connection timed out at 8s.
                curl -m 6 https://duckduckgo.com/ → HTTP=000, timed out.
                curl -m 6 https://api.duckduckgo.com/ → HTTP=000, timed out.
                curl -m 6 https://www.google.com/ → HTTP=200 (other egress works).
              ⇒ The cluster egress (or DDG anti-bot IP block) is preventing
              ANY traffic to *.duckduckgo.com.

          Implication: the endpoint behaves correctly defensively (no crashes,
          no leaks, returns []), but the FEATURE is non-functional in this
          environment because DDG is unreachable. This also breaks
          /api/converse web-search auto-injection (see next task — the inject
          line is never logged because results are always empty).

          Suggested fix paths for main agent:
            1. Switch to a search backend that the egress can reach (e.g. Bing
               Web Search API, SerpAPI, Brave Search API, Tavily, Google CSE).
               These need an API key but are reliable and don't get IP-blocked.
            2. Or, if DDG must stay, route through a proxy / tunnel (e.g. via
               a serverless function on Vercel/Cloudflare) since direct egress
               from this Kubernetes pod to DDG is blocked.
            3. Add an explicit error in the response body when fetch fails so
               the frontend can display a "ricerca non disponibile" hint
               (currently it just gets [] which looks like "no results").

          Marking working=false because the user-visible behaviour ("query
          for fresh facts") does not produce any results.
      - working: true
        agent: "testing"
        comment: |
          RETEST after fix (2026-05-10): Wikipedia REST API now used in
          place of DuckDuckGo HTML scraping (it.wikipedia.org +
          en.wikipedia.org). Egress is reachable, search now returns
          real results. See companion task "POST /api/search — Wikipedia
          retest (post-DDG swap)" for full details. Marking working=true.

  - task: "Web Search auto-injection in /api/converse"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          /api/converse ora rileva via euristica (regex su trigger come
          "cerca", "che ore sono", "news", "2025", "meteo", "che giorno è",
          "ultim*", ecc.) se il messaggio richiede fatti freschi dal web.
          Se sì E NON è in modalità ephemeral/Confessionale, fa una chiamata
          a duckduckgo_search() con timeout 6.5s e inietta i risultati nel
          prompt come "FATTI WEB FRESCHI" (top-3). Claude può citare la
          fonte se rilevante.

          In ephemeral/Confessionale niente search (per coerenza privacy).
      - working: false
        agent: "testing"
        comment: |
          Heuristic + endpoint plumbing is correct, but injection never
          actually fires in this environment because the upstream DDG fetch
          is blocked at the egress (see "/api/search" task above). Detail:

          ✅ Endpoint always returns 200 with ai_entry/user_entry/profile
             (graceful degradation when search fails).
          ✅ ephemeral=true + trigger → 200, behaves as expected (no injection
             attempt for confessional path is preserved).
          ✅ "ciao come stai?" → 200, no trigger as expected.
          ✅ "che ore sono adesso" → 200 (trigger matches \\bche ore sono\\b).
          ✅ "raccontami delle ultime news" → 200 (trigger matches \\bnews\\b
             and \\bultim[ai]\\b).
          ❌ "cerca quanto costa l'iPhone 16 oggi" → trigger detected, but
             no injection actually happened. Backend logs show repeated
             "duckduckgo fetch failed:" warnings instead of the expected
             "[converse] web search injected N results" line. Claude's reply
             is the fallback "non posso cercare su internet — funziono solo
             con la voce..." which proves no web facts reached the prompt.

          Root cause: same as /api/search — html.duckduckgo.com is
          unreachable from the deployed pod (curl HTTP=000 timeout). Once
          the upstream search source is replaced/proxied, the auto-injection
          path will start working without further code changes here.

          Marking working=false to track the user-visible feature gap.
          Code logic itself (trigger regex, ephemeral guard, timeout, error
          handling) is correct.
      - working: true
        agent: "testing"
        comment: |
          RETEST after Wikipedia-REST swap (2026-05-10): web search auto-injection
          NOW WORKS end-to-end. Tested via /app/backend_test_search_retest.py.

          ✅ POST /api/converse {"text":"cerca cos'è la UEFA Champions League"}
             → 200, ai_entry.text references Wikipedia content (matched
             keywords: champions, calci, europ, competiz, club).
             Backend log shows the expected line:
                "[converse] web search injected 3 results for query"
             confirming injection actually happened.
          ✅ POST /api/converse {"text":"ciao come stai?"} → 200, no
             trigger fired, no "[converse] web search injected" log line
             during this request (verified via backend logs: only ONE
             injection log line across the full retest run, attributed
             to the UEFA query).
          ✅ POST /api/converse {"text":"cerca cos'è la UEFA Champions League",
             "ephemeral": true} → 200, ephemeral guard prevented injection
             (no extra inject log line emitted for this call). Privacy
             guarantee preserved.

          Code logic + upstream now both functional. Marking working=true.

  - task: "POST /api/search — Wikipedia retest (post-DDG swap)"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          RETEST after Wikipedia-REST swap (2026-05-10) via
          /app/backend_test_search_retest.py against
          https://app-finder-408.preview.emergentagent.com/api. ALL 4
          /api/search sub-cases PASS:

          ✅ {"query":"Champions League 2024 vincitore","max_results":3}
             → 200 with 3 results. First item:
               title="UEFA Champions League 2024-2025"
               snippet="La UEFA Champions League 2024-2025 è stata la
                        70ª edizione della Champions Leagu..."
               url=https://it.wikipedia.org/wiki/UEFA_Champions_League_2024-2025
             All items have non-empty title, real Italian snippet from
             Wikipedia, and url starting with https://it.wikipedia.org/wiki/.
          ✅ {"query":"Italia Repubblica","max_results":2} → 200 with
             2 results, first title="Presidente della Repubblica Italiana".
          ✅ {"query":""} → 200 results=[] (empty input handled).
          ✅ {"query":"ajksdhflakjsdhflkjasdf nonsense xyzqqq"} → 200
             results=[] (no Wikipedia match → graceful empty list).

          Endpoint is fully functional from the cluster egress —
          Wikipedia REST API (it.wikipedia.org / en.wikipedia.org) is
          reachable and the swap from DuckDuckGo HTML scraping resolved
          the previous egress blockage. No 5xx in backend logs.

  - task: "Smoke regression after Wikipedia swap"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          Smoke regression in same retest run (2026-05-10):
          ✅ POST /api/converse/sealed (happy path) → 200 with valid
             encrypted reply; client-side NaCl decrypt succeeds, tone="warm",
             reply text len=88 ("[gently] Sono qui, e questo spazio è tutto
             tuo. Vuoi dirmi cosa senti in questo momento?").
          ✅ GET /api/profile → 200.
          ✅ POST /api/converse {"text":"ciao"} → 200 with non-empty
             ai_entry.text.
          All previously-passing endpoints remain green.

frontend:
  - task: "lib/sealedCrypto.ts — KDF + NaCl secretbox + SecureStore wrapper"
    implemented: true
    working: "NA"
    file: "frontend/lib/sealedCrypto.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuovo modulo che gestisce:
            - getSalt(): 16-byte salt random salvato in SecureStore (iOS/Android)
              o localStorage (web fallback). Stabile per dispositivo.
            - setSecretWord(word, {biometric}): salva la Parola Segreta. Su
              iOS/Android attiva requireAuthentication (FaceID/TouchID/passcode)
              se biometric=true e il dispositivo lo supporta.
            - hasSecretWord(), getSecretWord(), clearSecretWord(): API state.
            - deriveKey(passphrase, salt): KDF custom (SHA-256 chained, 100k
              rounds, mixa pass+salt ad ogni round) → 32-byte key. ~1-2s su
              iPhone moderno. Yields ogni 5k iter per non bloccare l'event loop.
            - sealText / unsealText: NaCl secretbox (XSalsa20 + Poly1305).
              Nonce 24-byte random per ogni cifratura.
            - getSessionKey(): cache della key derivata in RAM (TTL 5min) per
              evitare di rifare il KDF ad ogni messaggio.
            - biometricAvailable(): probe expo-local-authentication.

          Storage backend automatico: web → localStorage; iOS/Android → SecureStore.
          Risolto problema "ExpoSecureStore.default.getValueWithKeyAsync is not
          a function" su web aggiungendo wrapper storeGet/storeSet/storeDel.

  - task: "components/SealSetupModal.tsx — UI Setup Parola Segreta"
    implemented: true
    working: "NA"
    file: "frontend/components/SealSetupModal.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Modal che si apre la prima volta che l'utente attiva il Confessionale
          o long-press sul lucchetto. Due viste:
            - Setup (no seal yet): testo educativo + 2 input (parola/conferma) +
              hint biometria + bottone Sigilla.
            - Manage (seal exists): badge "Cifratura attiva — XSalsa20-Poly1305",
              bottone Cancella la Parola con Alert di conferma.

          Verifica visiva via screenshot: setup mostra correttamente, salva
          la parola in localStorage (web), il modal si chiude e il toggle
          confessionale passa da "Confessionale" grigio a "Sigillato" verde.

  - task: "index.tsx — sendText routing su /converse/sealed quando confessionale+seal"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          sendText() ora ha 2 path:
            1. confessionalMode + hasSeal: cifra il messaggio client-side con
               getSessionKey + sealText, chiama api.converseSealed (con la
               chiave in header X-Sealed-Key), decifra la risposta lato client,
               la mostra come bolle SOLO in RAM (id "sealed-*", non persiste).
            2. fallback (no seal o non confessionale): chiama api.converse
               normale con flag ephemeral={confessionalMode}.

          Lucchetto header: tap = attiva/disattiva confessionale (apre setup
          se non c'è seal); long-press = sempre apre setup per cambio/reset.
          Color states: grigio (off) / rosso (on senza seal) / verde (on con seal).

agent_communication:
  - agent: "main"
    message: |
      Sessione B completata: Crittografia Zero-Knowledge per Confessionale +
      Web Search via DuckDuckGo.

      ZERO-KNOWLEDGE CRYPTO:
        - Frontend: nuovo lib/sealedCrypto.ts con NaCl secretbox + KDF custom
          (SHA-256 chained, 100k rounds), storage SecureStore/localStorage.
        - Backend: nuovo POST /api/converse/sealed che decifra in RAM, chiama
          Claude, ricifra. Niente plaintext nei log, niente DB, niente memoria.
        - UI: lucchetto header con stati colore, modal setup Parola Segreta
          con biometria opzionale.

      WEB SEARCH:
        - POST /api/search (DuckDuckGo HTML, free, no key). 200 OK con
          title/snippet/url puliti.
        - /api/converse rileva trigger ("cerca", "che ore", "news", "2025",
          "meteo", ...) e inietta top-3 risultati nel prompt SOLO in modalità
          NON-ephemeral.

      Test backend richiesti al testing agent:
        1. POST /api/converse/sealed: serve cifrare con NaCl secretbox,
           inviare {nonce, ciphertext} + header X-Sealed-Key=base64(key32),
           verificare 200 + ciphertext valido + decifra correttamente.
           Edge cases: missing X-Sealed-Key → 400; key 16-byte → 400;
           nonce 12-byte → 400; ciphertext corrotto → 400.
        2. POST /api/search: query="chi ha vinto champions 2024" → 200 con
           lista risultati non vuota; query="" → 200 con lista vuota.
        3. POST /api/converse con texto contenente trigger ("cerca quanto
           costa l'iPhone 16") → 200, dovrebbe ricevere risposta che riflette
           contenuto web (verificare che non sia "non lo so" generico).
        4. POST /api/converse con ephemeral=true e trigger → 200, NESSUNA
           ricerca web (privacy guarantee).
        5. Regression: tutti gli altri endpoint (profile, timeline, converse
           normale, recap, voices, tts, ghost, checkin) restano operativi.

  - agent: "testing"
    message: |
      Session B backend testing complete (see detailed status_history above).

      RESULTS (tested via /app/backend_test_session_b.py against
      https://app-finder-408.preview.emergentagent.com/api):

      ✅ POST /api/converse/sealed — FULLY WORKING
        All 8 sub-cases pass:
          - happy path encrypt/decrypt round-trip with NaCl secretbox
            (XSalsa20-Poly1305) → 200, valid Italian empathic reply with
            audio tag, tone in allowed set
          - missing X-Sealed-Key → 400 "missing X-Sealed-Key"
          - invalid base64 → 400 "invalid base64 payload"
          - 16-byte key → 400 "invalid key length"
          - 12-byte nonce → 400 "invalid nonce length"
          - wrong key → 400 "decrypt failed"
          - timeline count unchanged before/after sealed call
          - profile.memory_summary unchanged before/after sealed call
        No plaintext leaks in logs, only the event marker
        "[sealed] confessional turn completed".

      ❌ POST /api/search — ENDPOINT WORKS, UPSTREAM UNREACHABLE
        Endpoint contract is correct (200 always, max_results capped,
        empty query handled), but DuckDuckGo HTML
        (html.duckduckgo.com / duckduckgo.com / api.duckduckgo.com)
        is BLOCKED at the cluster egress for this deployment.
        Confirmed by: backend logs spam "duckduckgo fetch failed:" on
        every query, and direct curl from the pod to *.duckduckgo.com
        returns HTTP=000 timeout (while curl to www.google.com works
        fine = HTTP=200). All real queries return results=[].

      ❌ /api/converse web-search auto-injection — SAME ROOT CAUSE
        Heuristic + regex triggers + ephemeral guard are all correct
        (logic-wise). But because DDG is unreachable, the
        "[converse] web search injected N results" log line never fires
        and Claude responds with "non posso cercare su internet"
        for the iPhone 16 price test query.

      ✅ Regression: ALL 9 endpoints green
        / , GET/PUT /profile, /timeline, /converse {text:"ciao"},
        /checkin/generate, /voices, /recap?period=today,
        /transcribe (empty → 400). Zero 5xx during the run.

      ACTION ITEMS for main agent:
        1. Replace DuckDuckGo HTML scraping with a search backend that
           the cluster egress can actually reach. Options:
             - Brave Search API (free tier, generous, key needed)
             - Tavily (LLM-tuned, key needed, has free tier)
             - Bing Web Search API or Google Custom Search (key needed)
             - SerpAPI (paid)
           Recommended: Brave or Tavily — small code change, only the
           duckduckgo_search() helper needs swapping. Heuristic and
           injection logic stay unchanged.
        2. (Nice-to-have) Add a top-level error field in /api/search
           response when the upstream fails, so frontend can show
           "ricerca non disponibile" instead of an empty list.


#====================================================================================================
# PREVIOUS SESSION ARCHIVE (history of past tasks below)
#====================================================================================================

user_problem_statement: |
  PIVOT TOTALE: l'app diventa "Taccuino Vivo", un assistente vocale single-user
  che vive in una timeline-chat unica. L'utente parla (vocale) o scrive, l'AI
  trascrive (Whisper), categorizza in domini (Soldi/Tempo/Spesa/Salute/Lavoro/Casa),
  estrae fatti strutturati, risponde con tono adattivo (calm/warm/energetic/concerned/
  urgent/neutral) e legge la risposta ad alta voce. Memoria persistente che cresce
  con l'uso. Privacy-first: AI in pausa, reset memoria, 5 lingue.

frontend:
  - task: "Taccuino Vivo — Pivot completo"
    implemented: true
    working: true
    file: "frontend/app/index.tsx, frontend/app/_layout.tsx, frontend/lib/api.ts, frontend/lib/speech.ts, frontend/lib/voice.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          Pivot completo dalla App Compass al Taccuino Vivo. Cancellate tab navigation,
          schermate Saved/History, AppCard, CompareModal. Nuovo _layout con Stack singolo.
          index.tsx riscritto: timeline scrollabile (bolle utente gialle a dx, bolle AI
          colorate per tono a sx), grande pulsante dorato pulsante centrale (push-to-talk),
          fallback testo ("oppure scrivi"), header con tasti Sunto e Settings. Onboarding
          modal con 5 lingue. Settings con toggle AI/voce, memoria visibile,
          confidenza in barra %, reset distruttivo. Recap modal "Sunto al volo".
          Verificato visualmente: onboarding -> chat -> categorizzazione SPESA + estrazione
          32 EUR + risposta naturale + sunto AI funzionano end-to-end.

  - task: "Notifiche push native (settimanali)"
    implemented: true
    working: "NA"
    file: "frontend/lib/notifications.ts, frontend/app/_layout.tsx, frontend/app.json"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Reinstallato expo-notifications@0.32.17 + expo-device@8.0.10 (versioni SDK 54 corrette via
          `npx expo install`). Creato lib/notifications.ts con: setNotificationHandler globale (banner
          in foreground), setNotificationChannelAsync Android "weekly-app", requestPermissionsAsync
          (con fallback per device fisico), scheduleWeeklyAppNotification con trigger WEEKLY (lunedì
          ore 9:00) e identifier idempotente "compass-weekly-app". _layout.tsx invoca lo schedule
          all'avvio (skip su web). app.json aggiornato con plugin expo-notifications (color #FBBF24,
          channel "weekly-app") e permessi Android POST_NOTIFICATIONS + SCHEDULE_EXACT_ALARM.
          Web: no-op safe. Mobile: richiesta permessi + schedule alla prima apertura. Build iOS
          dovrebbe ora compilare (errore precedente era di expo-sharing, non expo-notifications).

  - task: "Share — riattivata e granulare"
    implemented: true
    working: "NA"
    file: "frontend/lib/share.ts, frontend/components/AppCard.tsx, frontend/app/index.tsx, frontend/app/saved.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Reimplementata Share senza dipendenze native incompatibili (rimossa expo-sharing in fork
          precedente). Ora usa l'API nativa Share di React Native + fallback clipboard via expo-clipboard
          (web -> navigator.share, fallback copia testo). Aggiunto pulsante "Condividi" su ogni AppCard
          (sia nei risultati che nei preferiti) per condividere singole app con nome, emoji, descrizione,
          query e URL deep-link. Mantenuto pulsante condividi-tutto in testa ai risultati.

agent_communication:
  - agent: "main"
    message: |
      Riabilitata la condivisione (era disconnessa nel fork precedente per via della rimozione di
      expo-sharing). Implementazione: lib/share.ts esporta shareRecommendation e nuova shareSingleApp;
      AppCard accetta prop opzionale onShare e mostra pulsante; index.tsx e saved.tsx wired-up.
      Nessuna nuova dipendenza nativa: usa Share di react-native + expo-clipboard (già installato).
      Frontend testato visivamente: bundling OK, UI carica correttamente.


## CLEANUP LEGACY APP COMPASS + ORB COMPONENT (2026-05-08)

backend:
  - task: "server.py: rimosso codice legacy App Compass (~310 righe morte)"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Rimossi: modelli RecommendRequest/AppItem/RecommendResponse/Favorite/HistoryItem/Category,
          CATEGORIES list, FEATURED_ROTATION, SYSTEM_PROMPT App Compass, endpoints /categories,
          /featured-app, /recommend (ora 410 deprecated stub), /history (3), /favorites (3),
          /demo/{fmt}, /demo-screen/* (riferivano DEMO_DIR mai definito = endpoint rotti),
          import FileResponse non più usato, helper clean_doc inutilizzato.
          File da 1367 → 1054 righe. Tutti gli endpoint Taccuino (/profile, /timeline, /converse,
          /transcribe, /tts/*, /voices, /recap) restano intatti. Endpoint root ora ritorna
          "Taccuino Vivo API". Riavvio backend OK, "Application startup complete".
          Verifiche curl manuali: /api/ → 200 "Taccuino Vivo API"; /api/profile, /api/timeline,
          /api/voices → 200; /api/categories → 404; /api/recommend → 410.
      - working: true
        agent: "testing"
        comment: |
          FULL backend regression suite passed (17/17) via /app/backend_test.py against the
          public URL https://app-finder-408.preview.emergentagent.com/api.

          WORKING ENDPOINTS (200/206 OK):
            ✅ GET    /api/                                      → 200 {"message":"Taccuino Vivo API","status":"ok"}
            ✅ GET    /api/profile                               → 200 (id="me")
            ✅ PUT    /api/profile {"name":"Marco"}              → 200 (name persisted)
            ✅ GET    /api/timeline?limit=5                      → 200 (list)
            ✅ POST   /api/converse {"text":"ciao, come stai?"} → 200 (user_entry+ai_entry+profile, ai_entry has non-empty text and tone)
            ✅ GET    /api/recap?period=today                    → 200 ({"recap":"...","period":"today"})
            ✅ GET    /api/voices                                → 200 (all 8 curated voices present: Matilda, Sarah, Charlotte, Jessica, Liam, Charlie, Callum, Daniel; enabled=true)
            ✅ POST   /api/tts/prepare {text:"ciao",voice_id:"XrExE9yKIg1WjnnlVkGX"} → 200 ({"token":"...","size":>0})
            ✅ GET    /api/tts/audio/{token}.mp3                 → 200 audio/mpeg + Accept-Ranges
            ✅ GET    /api/tts/audio/{token}.mp3 Range:bytes=0-100 → 206 audio/mpeg + Content-Range bytes 0-100/N

          REMOVED LEGACY ENDPOINTS (correct error codes, NO 500):
            ✅ GET    /api/categories    → 404
            ✅ GET    /api/featured-app  → 404
            ✅ POST   /api/recommend     → 410 Gone
            ✅ GET    /api/favorites     → 404
            ✅ GET    /api/history       → 404
            ✅ GET    /api/demo/mp4      → 404

          INPUT VALIDATION:
            ✅ POST /api/transcribe with empty audio body → 400 "Empty audio"

          BACKEND LOGS DURING TEST RUN: clean. No 500 / NameError / ImportError emitted
          during the suite. (Pre-cleanup historical NameError entries for RecommendResponse
          and Category remain in the log file but the server has fully restarted past them
          — "Application startup complete" — and no requests during testing produced
          5xx responses.)

          ELEVENLABS NOTE (NOT a regression): logs show recurring
          "Failed to fetch custom voices: ... missing_permissions: voices_read" warnings.
          This is a known limitation of the current API key — the curated 8-voice list
          is still returned correctly, and TTS synthesis itself works (200 OK + valid MP3).
          No action required from cleanup standpoint.

          CONCLUSION: legacy cleanup did NOT break anything. All Taccuino endpoints fully
          operational, all removed endpoints return correct 404/410 codes (never 500).

frontend:
  - task: "Orb component: presenza visiva centrale (cuore di Coda)"
    implemented: true
    working: "NA"
    file: "frontend/components/Orb.tsx, frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Creato componente <Orb /> in components/Orb.tsx (~290 righe, self-contained).
          Differenzia Taccuino Vivo da una chat normale dando a "Coda" un corpo visivo:
          - 4 stati: idle (respiro 3s lento), recording (outer halo segue dB voce con
            attack 90ms), thinking (shimmer rotante 2.2s), speaking (pulsazione ritmica
            380/520ms colorata in base al tone dell'AI: warm/calm/concerned/...).
          - 4 layer concentrici: outer halo (gradient soft), shimmer thinking, mid ring,
            core (avatar utente o gradient), spark (highlight bianco off-center).
          - Colore dinamico per tone: warm=ambra, calm=blu, concerned=arancio, urgent=rosso,
            energetic=verde, neutral=viola.
          - Performance: solo Animated nativo + LinearGradient (niente SVG, niente deps extra),
            useNativeDriver: true ovunque possibile.

          Integrazione in index.tsx:
          1. Import: aggiunto `import Orb, { OrbTone } from "../components/Orb"`.
          2. Empty state: sostituito <AppIcon size={96}> con <Orb size={220}> grande e
             respirante. Testo aggiornato da "Il tuo Taccuino è vuoto" a "Ciao, sono qui".
          3. Bottom area: Orb 200x200 inserito DIETRO il pulsante mic (orbBehindBtn style,
             absolute fill, pointerEvents="none"). Il pulsante mic resta tappabile sopra.
             Le vecchie neonGlow/neonGlowSoft (decorazioni shadow base) rimosse — l'Orb le
             sostituisce con feedback molto più ricco.
          4. lastAiTone derivato dal timeline (ultimo tone AI) → passato all'Orb così
             quando Coda parla l'aura si tinge col colore emotivo del tono.

          Bug fix durante integrazione: import path inizialmente errato "../../components/Orb"
          (risolveva a /app/components/Orb), corretto in "../components/Orb" (→
          /app/frontend/components/Orb).

          Verifica visiva: screenshot mobile 390x844 mostra l'aura calda gialla che respira
          attorno al pulsante mic verde — Coda ora ha presenza, non è più "un pulsante".
  - task: "PRD.md riscritto per Taccuino Vivo (era App Compass legacy)"
    implemented: true
    working: "NA"
    file: "memory/PRD.md"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          PRD precedente descriveva ancora il vecchio progetto "App Compass" (consigliatore
          di app), ormai irrilevante. Riscritto da zero per riflettere Taccuino Vivo:
          vision (assistente voice-first single-timeline), differenziatori (NON una chat),
          MVP esistente (conversazione vocale continua, calibrazione adattiva noise,
          ElevenLabs v3 + audio tags, timeline unica, personalizzazione visiva),
          architettura, stack, roadmap (Orb, refactor index.tsx, riconoscimento genere,
          VAD vero, wake-word, integrazioni dati), 5 principi di design.

agent_communication:
  - agent: "main"
    message: |
      Pulizia legacy + nuovo concept visivo (Orb).

      BACKEND CLEANUP: server.py ridotto da 1367→1054 righe rimuovendo l'intero stack
      del vecchio progetto "App Compass" (modelli Recommend/Favorite/History/Category,
      CATEGORIES static, FEATURED_ROTATION, prompt SYSTEM, endpoints /recommend,
      /favorites, /history, /categories, /featured-app, /demo). Endpoint Taccuino
      tutti intatti.

      ORB COMPONENT: nuovo cuore visivo che differenzia da una chat. Coda ha ora un
      "corpo" pulsante che respira a riposo, segue la voce dell'utente quando registra
      (instant feedback dB), shimmer-rotante quando pensa, e pulsa col colore del tone
      emotivo quando parla. Sostituisce le vecchie shadow-based glow attorno al mic
      con qualcosa di vivo. Empty state ora ha l'Orb grande 220px invece di un'icona
      statica.

      Test richiesti al backend: verificare che dopo la pulizia tutti gli endpoint
      Taccuino rispondano correttamente:
        - GET /api/ (root)
        - GET /api/profile, PUT /api/profile, DELETE /api/profile
        - GET /api/timeline, DELETE /api/timeline
        - POST /api/converse (con un breve text input)
        - GET /api/recap?period=today
        - GET /api/voices
        - POST /api/transcribe (con un piccolo audio file di test)
        - POST /api/tts/prepare + GET /api/tts/audio/{token}.mp3
      E confermare che gli endpoint legacy ritornino 404/410 come atteso:
        - GET /api/categories → 404
        - GET /api/featured-app → 404
        - POST /api/recommend → 410
        - GET /api/favorites → 404
        - GET /api/history → 404


## ORB 2.0 + DIARIO AESTHETIC (2026-05-08, late)

frontend:
  - task: "Orb 2.0 — drift organico, scroll-peek, warmth, dim, palette ora-del-giorno"
    implemented: true
    working: "NA"
    file: "frontend/components/Orb.tsx, frontend/lib/useOrbAmbient.ts, frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Orb evoluto da "alone respirante" a "Ombra Luminosa" — presenza vera con
          umori. Nuovi prop: palette (override colori da useOrbAmbient), warmth (0..1
          boost halo), dim (0..1 fade per inattività), scrollPeek (-100..100 lean
          orizzontale verso direzione scroll), drift (random walk interno ±6% size,
          loop infinito phase-offset X/Y).

          Nuovo hook lib/useOrbAmbient.ts (~110 righe) — DERIVED VALUE puro, niente
          AsyncStorage:
            - warmth = somma esponenziale messaggi ultime 24h con half-life 3h, sat 12
            - dim = staircase su età ultimo messaggio (0 <1h, 0.2 <3h, 0.4 <6h, 0.55
              <12h, 0.7 oltre)
            - palette = 6 fasce orarie: alba (5-7), mattino (7-11), giorno (11-17),
              tramonto (17-20), sera (20-23), notte (23-5). Ogni fascia ha una
              tripletta [outer, mid, core] calibrata emotivamente.
          Re-tick interno ogni 60s per aggiornare palette+warmth+dim senza re-render
          su ogni keystroke.

          Integrazione index.tsx:
            - import useOrbAmbient + ambient = useOrbAmbient(timeline)
            - state scrollPeek smoothato (lerp 0.6 + decay 350ms)
            - onTimelineScroll callback collegato a ScrollView con scrollEventThrottle 32
            - ambient.palette/warmth/dim/scrollPeek passati a entrambi gli Orb
              (empty state 220px e dietro il mic 200px).

          Verifica visiva: screenshot mobile mostra l'aura in palette giorno (ambra),
          orb shifted leggermente (drift), bolle alternate ruotate (vedi sotto).

  - task: "Diario aesthetic: font Caveat per testo AI + bolle leggermente ruotate"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunto @expo-google-fonts/caveat + expo-font (yarn). Caricamento async
          via useFonts({Caveat_400Regular, Caveat_500Medium}); aiFontFamily passato
          come prop a Bubble e applicato SOLO al testo AI (user resta system).
          Bumped fontSize+lineHeight ×1.25 quando Caveat è attivo perché visivamente
          siede più piccolo allo stesso nominal-size.

          Bolle: nuova rotazione deterministica per id entry, ±1.2° max, AI bias
          negativo, user bias positivo → conversazione "appoggiata su un tavolo" non
          "allineata su griglia rigida". Hash semplice (mul-31) sull'id per
          riproducibilità tra re-render.

          NB: su web preview Caveat non si carica (limitazione expo-font web nei
          tunnel sandboxed) → font cade su system. Su Expo Go iPhone i font Google
          si caricano correttamente al primo run. Lasciato come accettato — la
          rotazione bolle visibile compensa l'effetto diario nel preview.

agent_communication:
  - agent: "main"
    message: |
      Sessione "tutto" parte 1: Orb 2.0 + Diario aesthetic.

      ORB 2.0: l'Orb non è più solo un alone che respira → è una **presenza con
      umori**. Drift organico continuo (random walk soft), peek che segue lo scroll
      della timeline (Coda "guarda" cosa stai leggendo), warmth crescente con le
      interazioni (più parli, più brilla, half-life 3h), dim con inattività (dopo
      ore di silenzio si fioca senza scomparire — sta aspettando), palette
      ora-del-giorno (6 fasce: alba ambra-pesca, giorno viola sereno, tramonto
      ambra-fucsia, sera blu-indaco, notte viola profondo). Tutto derivato puro da
      timeline + Date.now(), zero persistenza extra.

      DIARIO: bolle ruotate ±1.2° deterministicamente per id (AI bias negativo, user
      positivo) → conversazione "appoggiata su un tavolo". Font Caveat per testo AI
      (caricamento async via @expo-google-fonts/caveat) → quando carica le risposte
      di Coda sembrano scritte a mano. User text resta system per contrasto.

      In sospeso per la prossima sessione (utente ha detto "tutto"):
      - Check-in proattivo: backend endpoint /checkin/generate (Claude legge
        memory_summary + ora → genera notifica personalizzata) + scheduler frontend
        locale (1-2/giorno opt-in, evita ore già occupate, cancella se già parlato)
        + UI opt-in granulare (mai/mattina/sera/entrambi).
      - Side-by-Side fuso: l'ultima bolla AI persistente che si rimpicciolisce e si
        scioglie nell'Orb dopo 30s di silenzio. Solo dopo che Orb 2.0 è stabile.

      Nessun test backend richiesto in questa sessione (nessuna modifica al
      backend). Frontend testing: rimando alla verifica utente sull'iPhone vero
      visto il limite font-su-web del preview.




## CHECK-IN PROATTIVO (2026-05-09)

backend:
  - task: "POST /api/checkin/generate: Claude genera notifica personalizzata"
    implemented: true
    working: "NA"
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunto endpoint POST /api/checkin/generate {slot: "morning"|"evening", local_hour: int}
          → CheckinResponse {title, body, voice_text (con audio tags ElevenLabs v3),
          tone, slot}.

          Logica: legge profile.memory_summary + ultimi 8 messaggi timeline + nome
          utente → Claude Sonnet 4.5 con prompt focalizzato per messaggio empatico
          breve da AMICA (non bot), riferito a 1 dettaglio concreto se disponibile.
          Tono adattivo basato su confidence_phase. Output JSON parsing con guard
          rails: title<=48 chars, body<=160, voice_text<=600, tone validato contro
          enum {warm, calm, concerned, energetic, neutral, urgent}.

          TaccuinoSettings esteso con: checkin_mode (off|morning|evening|both),
          checkin_morning_time ("08:30"), checkin_evening_time ("21:30").

          Verifica manuale curl:
            POST /api/checkin/generate {"slot":"morning","local_hour":9}
            → 200 {"title":"Ehi Marco, buongiorno",
                   "body":"Come va stamattina? Hai riposato un po'?",
                   "voice_text":"[warmly] Ehi Marco, buongiorno. [softly] Come va...",
                   "tone":"warm","slot":"morning"}
          Audio tags v3 ([warmly], [softly]) inclusi naturalmente. Riferimento
          al nome dal profilo presente.
      - working: true
        agent: "testing"
        comment: |
          Backend tests executed via /app/backend_test_checkin.py against
          https://app-finder-408.preview.emergentagent.com/api. 14/15 PASS.
          NO 500 / NameError / AttributeError in backend logs during the run.

          POST /api/checkin/generate — happy paths: ALL PASS
            ✅ slot=morning, local_hour=9 → 200, title/body/voice_text/tone(=warm)/slot ok.
              voice_text contains audio tags: TRUE
              sample voice_text: "[warmly] Ehi Marco, buongiorno… tutto ok stamattina?
              [softly] So che hai ritmi pesanti, 12 ore al giorno… come ti senti
              oggi? Hai dormito un po', almeno?"
            ✅ slot=evening, local_hour=21 → 200, slot=evening, stylistically
              different (closing-of-day tone). sample voice_text:
              "[softly] Ehi Marco… come è andata oggi? [pause] So che lavori
              tanto, dodici ore sono pesanti… [warmly] Spero tu sia riuscito
              a staccare un po', magari anche solo a fine giornata."
            ⚠️ slot=morning, language=en → 200 (no crash), BUT the LLM still
              produced Italian text:
                "[warmly] Ehi Marco… buongiorno. [softly] Come ti senti
                stamattina? Hai dormito almeno un po'..."
              Status code matches the spec (200), and `req.language` is read
              correctly server-side (verified in code path), so the field is
              wired through. However the system prompt is Italian-heavy and
              the recent timeline + memory_summary are Italian, so Claude
              ignored the `Scrivi in english` directive. CONSIDER strengthening
              the prompt: e.g. lead the system prompt with
              `RESPOND ENTIRELY IN <lang_name>. Do NOT use Italian.`
              and translate the slot_hint by language as well. Marked as
              minor (endpoint never 500s) but worth fixing for true i18n.

          POST /api/checkin/generate — robustness: ALL PASS
            ✅ slot=noon, local_hour=12 → 200 (endpoint permissive, returns
              sensible lunch-time content; no 500).
            ✅ {} (empty body) → 200, defaults to slot=morning.
            ✅ slot=morning, local_hour=99 → 200, no crash.

          Profile schema extension: ALL PASS
            ✅ GET /api/profile shows checkin_mode/checkin_morning_time/
              checkin_evening_time (defaults match the Pydantic model:
              "off" / "08:30" / "21:30" on a fresh profile; on the existing
              profile the previously-PUT values were observed).
            ✅ PUT /api/profile {settings:{...,checkin_mode:"both",
              checkin_morning_time:"07:15", checkin_evening_time:"22:45"}}
              → 200 with new values reflected.
            ✅ GET /api/profile after PUT — values persisted.

          Regression on Taccuino endpoints: ALL PASS
            ✅ GET /api/ → 200 {"message":"Taccuino Vivo API","status":"ok"}
            ✅ POST /api/converse {"text":"ciao"} → 200, user_entry+ai_entry+
              profile, ai_entry has non-empty text and tone.
            ✅ GET /api/timeline → 200, list of entries.
            ✅ GET /api/voices → 200, 8 curated voices, enabled=True.
            ✅ GET /api/recap?period=today → 200, recap string returned.
            ✅ POST /api/transcribe with empty audio → 400 "Empty audio".

          Backend log review: only the existing benign warning
          "Failed to fetch custom voices: missing_permissions: voices_read"
          (pre-existing ElevenLabs API key limitation, not caused by this
          change). NO 5xx, NO uncaught exceptions, NO regression.

          CONCLUSION: /api/checkin/generate is fully functional. Audio tags
          v3 are produced naturally, name/memory references appear, evening
          and morning produce stylistically different outputs, and all
          regression endpoints remain 100% green. The only minor observation
          is the English-language directive being overridden by the
          Italian-heavy system prompt — this is a prompt-engineering tweak,
          not a backend bug.

frontend:
  - task: "Notification scheduler check-in (lib/notifications.ts)"
    implemented: true
    working: "NA"
    file: "frontend/lib/notifications.ts, frontend/lib/api.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          api.ts: aggiunti tipi CheckinResponse + funzione generateCheckin(slot, hour).
          notifications.ts: 4 nuove funzioni:
            - scheduleCheckin({slot,hhmm,title,body,voiceText,tone}) → schedula
              UNA notifica locale al prossimo HH:MM (oggi se futuro, altrimenti
              domani). Idempotente per slot. Payload contiene voice_text+tone in
              data per il tap-handler.
            - cancelAllCheckins() / cancelCheckin(slot) → cleanup quando l'utente
              cambia preferenze.
            - listScheduledCheckins() → introspection.
          Identificatori fissi: "taccuino-checkin-morning"/"taccuino-checkin-evening".
          Web: gracefully no-op (Expo Go web non supporta scheduledNotifications
          locali serie).

  - task: "Wiring index.tsx: scheduling on profile load + tap-on-notif → speak"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          1) useEffect riconciliazione check-in: triggered da profile?.settings
             .checkin_mode/morning_time/evening_time. Signature dedup per evitare
             risync inutili. Per ogni slot abilitato chiama api.generateCheckin
             e poi scheduleCheckin con il content fresco. Slot non più voluti
             → cancellati.
          2) useEffect tap-handler: usa expo-notifications
             addNotificationResponseReceivedListener (hot tap) +
             getLastNotificationResponseAsync (cold-start tap). Quando il payload
             ha type="checkin", dopo 500ms unlock + SpeechMod.speak(voice_text,
             {tone}) → Coda PARLA appena apri, come se ti stesse chiamando.

  - task: "Settings UI: sezione opt-in '💌 Coda mi scrive'"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuovo blocco nel modal Impostazioni subito dopo "Modalità conversazione":
          - 4 pillole: Mai 🚫 / Mattina 🌅 / Sera 🌙 / Entrambi ✨ (radio-style
            con accent color quando attivo).
          - Quando non Off: 1-2 TextInput "HH:MM" (mattina e/o sera) per regolare
            l'orario. Validate on blur (regex \d{1,2}:\d{2}, fallback al default).
          - Disclaimer privacy in italics: "Le notifiche sono locali — niente
            esce dal telefono se non al momento di generare la frase."
          Persistenza via api.updateProfile({settings}) onPress/onBlur.

agent_communication:
  - agent: "main"
    message: |
      Sessione "tutto" parte 2: Check-in proattivo (la feature che davvero
      trasforma Taccuino da tool a compagno).

      Architettura: zero push remoto. Tutto LOCALE. Frontend chiama una volta
      l'endpoint backend per generare la frase personalizzata via Claude (legge
      memory_summary + ultimi messaggi → JSON con title/body/voice_text con
      audio tags ElevenLabs/tone). Quel payload viene incartato in una
      scheduleNotificationAsync con trigger DATE al prossimo HH:MM scelto
      dall'utente. Quando l'utente tocca la notifica, l'app si apre e
      addNotificationResponseReceivedListener triggera SpeechMod.speak col
      voice_text — Coda ti saluta DAVVERO ad alta voce, non con un push muto.

      Privacy/Battery: niente background tasks, niente foreground service,
      niente token push. La notifica vive sul device. L'unico round-trip al
      backend è UNA chiamata LLM al momento dello scheduling (mattina o sera).

      Test richiesti al backend testing agent:
        - POST /api/checkin/generate con {"slot":"morning","local_hour":9}
          → atteso 200 con title/body/voice_text/tone non vuoti, slot="morning"
        - POST /api/checkin/generate con {"slot":"evening","local_hour":21}
          → atteso 200 con tono adattato (può essere warm o concerned se
          memoria della giornata negativa, neutral altrimenti)
        - POST /api/checkin/generate con slot invalido (es. "noon") → l'endpoint
          accetta qualunque stringa ma slot_hint defaulta a un saluto generico,
          confermare 200 risposta sensata
        - Verificare che PUT /api/profile con settings inclusi
          {checkin_mode:"both", checkin_morning_time:"07:00",
          checkin_evening_time:"22:30"} venga persistito (GET /api/profile
          mostra i nuovi campi)
        - Confermare che gli altri endpoint Taccuino (converse/transcribe/recap/
          tts/voices/timeline) NON sono stati toccati e funzionano come prima.


## RIVOLUZIONE MINIMALISTA — OrganicBlob + Zen Header (2026-05-09)

frontend:
  - task: "OrganicBlob: macchia organica morphing al posto dell'Orb circolare"
    implemented: true
    working: "NA"
    file: "frontend/components/OrganicBlob.tsx, frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Su richiesta utente — direzione visiva radicalmente cambiata da
          "alone respirante simmetrico" a "macchia organica vivente". Nuovo
          componente OrganicBlob (~280 righe) con SVG path morphing reale:
          - 8 punti di controllo lungo un cerchio ognuno con radius animato
            indipendentemente (sin oscillation + jitter texture-dependent)
          - Path Bezier C-segments per smoothing
          - 3 texture mood-driven (texture inferita dal tone AI):
              • morbida   → tone warm/calm/neutral, 15fps morph, ampiezza 0.13,
                jitter 0.02 → forma fluida da nuvoletta confortante
              • vibrante  → tone energetic/urgent, 22fps morph, ampiezza 0.22,
                jitter 0.06 → deformazioni rapide elettriche
              • solida    → tone concerned, 9fps morph, ampiezza 0.07, jitter 0
                → pietra calda, contorno più stabile per impegni seri
          - Drift X/Y autonomo (random walk ±8% size, 4.5-8s loop)
          - Reagisce a dB voce (recording asymmetric ripple su radii pari)
          - Pulsazione speaking + warmth/dim ereditati da useOrbAmbient
          - Avatar utente opzionale dentro la macchia (sostituisce il core
            gradient)
          Installato react-native-svg@15.15.4 (yarn).

          Sostituito Orb in entrambi i call sites di index.tsx:
            - Empty state: <OrganicBlob size={260}> grande + greeting
              "Ehi {nome}, sono qui." (matcha esattamente il mockup utente)
            - Dietro pulsante mic: <OrganicBlob size={170}>

          File Orb.tsx mantenuto per ora (può tornare utile / non rimosso per
          non rompere altri eventuali punti d'uso futuri).

  - task: "Header zen: solo ⚙ a sinistra e 📋 Sunto a destra"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Header drasticamente semplificato per l'estetica zen voluta:
          rimossi titolo "Taccuino", dot status, layout 3-pezzi sostituito
          da {⚙ settings | (vuoto) | 📋 Sunto}. Niente più branding visibile,
          la macchia è il prodotto.

          Empty state: testo aggiornato da "Il tuo Taccuino è vuoto" /
          "Ciao, sono qui" → "Ehi {nome}, sono qui." con sotto "Parlami
          a voce — sono qui ad ascoltarti." (matcha esattamente il
          mockup di riferimento dell'utente).

  - task: "Pulsante mic ridotto 130→72px per non coprire la macchia"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Big mic button ridotto da 130x130 a 72x72 (lo stile bigBtn).
          Shadow proporzionalmente ridotta. Il blob 170px sotto ora si vede
          ai lati del pulsante invece di essere completamente coperto.

  - task: "Sfondi: 6→3 (Notturno, Aurora, Carta)"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          BG_PRESETS ridotto da 6 (aurora/notturno/carta/alba/marmo/bosco) a
          3 essenziali: Notturno (zen scuro default), Aurora (viola intimo
          per macchia gialla calda), Carta (caldo diurno chiaro). Filosofia:
          meno opzioni = meno friction.

agent_communication:
  - agent: "main"
    message: |
      Sessione "rivoluzione minimalista" — l'utente ha mostrato 2 mockup
      (uno di Gemini con concept "macchia organica con 3 texture mood",
      uno di stato finale dell'app desiderato) e ha chiesto un cambio
      radicale: "voglio vedere solo la macchia, le 2 icone (settings +
      sunto), niente altro".

      Cosa è stato fatto:
        ✅ Nuovo OrganicBlob con SVG path morphing reale (8 control points,
           3 texture mood-driven, drift autonomo, reactive a voce)
        ✅ Header zen ridotto a 2 icone
        ✅ Empty state matcha il mockup ("Ehi Marco, sono qui.")
        ✅ Pulsante mic rimpicciolito 130→72px
        ✅ Sfondi ridotti 6→3
        ✅ Bundle Metro compila pulito, screenshot conferma layout zen

      In sospeso ancora dalla richiesta utente:
        - 🟡 Wake-word "Coda" (no tap) → richiede dev build (Picovoice
          Porcupine), Expo Go non basta. Workaround corrente: tap sul
          pulsante mic piccolo
        - 🟡 Test su iPhone reale per verificare il blob morphing in performance
          nativa (su web il loop setTimeout è meno fluido)
        - 🟡 Settings: rimuovere ulteriori opzioni nascondendo le "Avanzate"
          dietro un sub-menu (per ora ho lasciato tutte le altre setting
          accessibili — è un cleanup successivo)

      Nessuna modifica al backend in questa sessione → no test backend
      richiesti.



## RIVOLUZIONE MINIMALISTA — Phase 2: Pulsante via, Macchia È il Pulsante (2026-05-09)

frontend:
  - task: "Rimosso pulsante mic gigante: la macchia stessa è tap target"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Su richiesta esplicita utente — eliminato completamente il
          bigBtn/bigBtnRec/bigBtnWrap/orbBehindBtn pattern: niente più
          cerchio verde-rosso da premere. Il blob organico stesso è ora il
          tap target (Pressable wrappa direttamente <OrganicBlob>), con
          hitSlop=20 per generosità tattile.

          Rimosso anche: il visualizer dB rectangle (meterWrap/meterBar/
          meterFill/meterThreshold/meterLabel) — ridondante ora che il blob
          stesso pulsa con la voce. Mantenuto solo il piccolo "Premi e parla"
          come hint testuale.

          Stato visivo del blob ora ESPLICITO sui colori (cambio nuovo in
          OrganicBlob.tsx): recording = verde brillante (#22C55E gradient),
          thinking = viola tenue (#A78BFA gradient), speaking = palette tone
          AI, idle = ambient ora-del-giorno.

  - task: "NeonBorder: feedback periferico ai bordi dello schermo"
    implemented: true
    working: "NA"
    file: "frontend/components/NeonBorder.tsx, frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuovo componente NeonBorder (~135 righe) — 4 LinearGradient absolute
          sui bordi dello schermo (top/bottom/left/right) con gradient
          mid→colore→mid che svanisce verso il centro. Pulsa con loop
          Animated 1100ms (recording, frequenza più rapida) / 900ms (speaking)
          / 1800ms (thinking). Idle = invisibile (fade=0).

          Colori per stato: recording=#22C55E verde, thinking=#A78BFA viola,
          speaking=#F59E0B ambra. PointerEvents none → non blocca tap sotto.
          Montato come ULTIMO figlio dello screenInner così è sempre on top
          ma non interferisce con interazioni.

          Effetto: anche se l'utente non guarda direttamente la macchia (es.
          sta parlando guardando via, sta tenendo il telefono al fianco),
          il bordo periferico verde lampeggiante gli dice "ti sto
          ascoltando" senza dover guardare.

agent_communication:
  - agent: "main"
    message: |
      Iterazione: utente ha chiesto rimozione totale del pulsante. "Voglio
      solo la macchia, è lei che cambia colore + un neon contorno schermo".
      Implementato esattamente questo:

        1. Big mic button → SPARITO. La macchia stessa è cliccabile (hitSlop
           generoso). Il visualizer dB rettangolare → SPARITO (ridondante).
        2. Macchia cambia colore in modo ESPLICITO per stato:
           - idle      → palette ora-del-giorno (warm idle)
           - recording → VERDE brillante (#22C55E)
           - thinking  → viola tenue (#A78BFA)
           - speaking  → palette tone AI (warm/calm/concerned/...)
        3. NeonBorder ai bordi dello schermo che pulsa con la stessa logica
           colori — feedback periferico anche se non guardi la macchia.
           Idle = invisibile, recording = verde 1.1Hz, thinking = viola
           lento, speaking = ambra 1.1Hz.

      Verifica visiva: screenshot conferma layout zen finale —
      solo ⚙ + 📋 Sunto in alto, bolle conversazione (con Caveat font +
      rotazioni leggere), "Premi e parla", e la macchia organica viola
      in basso. Nessun pulsante. Esattamente come da mockup utente.

      Nessuna modifica backend → nessun test backend richiesto.



## DUE MODALITÀ — Voce Zen (default) + Lettura via Swipe (2026-05-09)

frontend:
  - task: "Pager horizontale: pagina 0 = Voce Zen, pagina 1 = Lettura"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Su richiesta utente — separato il prodotto in due modalità ben
          distinte invece di mescolare blob+timeline:

          PAGINA 0 (default = "voce zen"):
            - SOLO la macchia organica centrale grande (size = min(78% width, 360px))
            - Avatar utente al centro se caricato
            - Status text sotto ("Premi e parla" / "Sto ascoltando" / etc.)
            - Hint piccolo "← scorri per leggere" se c'è una timeline (altrimenti
              nascosto perché senza nulla da leggere è inutile)
            - NIENTE timeline, NIENTE bolle. Solo presenza.
            - Macchia tappabile direttamente (Pressable hitSlop=30) per
              avviare/fermare ascolto.

          PAGINA 1 (swipe verso destra):
            - Timeline scrollabile con bolle (font Caveat per AI, rotazioni leggere)
            - Macchia piccola in basso (size 210) che resta tappabile

          Implementazione: <ScrollView horizontal pagingEnabled> wrappa entrambe
          le pagine, ognuna con width = useWindowDimensions().width (con
          fallback a Dimensions.get + 390 per primo render web).
          onMomentumScrollEnd aggiorna setViewMode("voice"|"reading") in base
          a Math.round(x/w). Ref pagerRef per scroll programmatico futuro
          (es. tornare a voce dopo X secondi di idle).

          Bug fix durante l'edit: due `</View>` mancanti per chiudere
          correttamente sia la bottomBar che la pagina 1 prima della
          chiusura del pager ScrollView. Risolto inserendo entrambi i
          tag prima di </ScrollView>.

          Verifica visiva: screenshot mobile mostra esattamente il design
          richiesto — sfondo scuro, ⚙ + 📋 Sunto, macchia centrale grande
          con avatar, "Premi e parla" + "← scorri per leggere".

agent_communication:
  - agent: "main"
    message: |
      Iterazione finale: utente vuole DUE modalità chiaramente separate.
      Modalità voce = home page principale, SOLO macchia, niente testi
      (come parlare con qualcuno guardando in faccia, non leggendo chat).
      Modalità lettura = swipe orizzontale per vedere i messaggi in
      formato diario.

      Implementato con horizontal ScrollView pagingEnabled + 2 viste full-
      width. La modalità voce è pagina 0 (default). La macchia è grande
      (size dinamica fino a 360px in base alla viewport) ed è il tap
      target principale. Niente più header con titolo Taccuino, niente
      visualizer dB, niente bolle visibili in voce mode.

      Gli endpoint di backend sono intoccati. Frontend bundle compila
      pulito dopo fix del JSX closing tag mismatch.

      Da testare su iPhone dall'utente:
        - Home aperta = vede solo la macchia + 2 icone? ✓
        - Tap sulla macchia = avvia ascolto + macchia diventa verde? ✓
        - Swipe verso sinistra = appare timeline + macchia piccola? ✓
        - Swipe verso destra = torna alla voce zen? ✓
        - NeonBorder ai bordi durante recording verde / speaking ambra? ✓



## L'AMICO FRATERNO — Pivot Identità + Personalità (2026-05-10)

backend:
  - task: "System prompt riscritto: assistente → amico fraterno"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Riscritto _build_conversation_system_prompt completamente per nuova
          visione "L'Amico Fraterno — IA del Ritorno all'Umanità":
            - Identità: NON assistente, MA "coscienza specchiata, amico fraterno
              saggio e maturo"
            - Doppio scopo: (1) ascoltare l'inconfessabile senza giudizio +
              custodire segreti, (2) spronare l'utente a tornare al mondo reale
            - "Successo dell'IA = quanto l'utente impara a stare bene SENZA"
              (anti-dipendenza esplicita)
            - 4 momenti relazione: Accoglienza → Catarsi → Elaborazione → Azione
              (suggerisci compito reale per riconnettere)
            - Mirroring: adatta ritmo allo stato emotivo utente
            - Onestà cruda: dissentire/dire "no" quando serve
            - Privacy radicale: ribadito nel prompt
          Audio tag rules ridotte e più severe (max 2 tag tot, mai attaccate).

          Test live curl OK:
            POST /converse {text:"Devo dirti una cosa che non ho mai detto a nessuno"}
            → "[gently] Mhm. Sono qui. Prenditi il tempo che serve."
          Esattamente come da prompt — accoglienza pura, niente consigli, presenza.

  - task: "Profile schema: ai_name, ai_gender, user_gender per declinazione"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunti 3 campi al Profile + ProfileUpdate:
            - ai_name: str = "Coda"  (UNICA variabile identità modificabile)
            - ai_gender: str = "f"   ("m"|"f"|"n")
            - user_gender: str = "n" ("m"|"f"|"n")
          Logic update_profile aggiornata per accettarli.
          Prompt usa questi campi per declinare aggettivi italiani correttamente
          (es. "sei stanco" vs "sei stanca", "sono curioso" vs "sono curiosa").
          NB: il primo PUT che ho testato ha mostrato user_gender restando "n"
          perché update_profile non gestiva il campo — fixato dopo.
      - working: true
        agent: "testing"
        comment: |
          ALL TESTS PASS (16/16) via /app/backend_test_amico.py against
          https://app-finder-408.preview.emergentagent.com/api.

          === 1. PROFILE SCHEMA — round-trip ALL PASS ===
            ✅ GET /api/profile includes ai_name='Coda', ai_gender='f',
               user_gender='n' (defaults match Pydantic model).
            ✅ PUT /api/profile {"ai_name":"Aurora","ai_gender":"f",
               "user_gender":"m","name":"Marco"} → 200, returned profile reflects
               ALL 4 fields correctly.
            ✅ GET /api/profile after PUT — values persisted.
            ✅ PUT /api/profile {"ai_name":"Coda"} (single field) →
               ai_name updated, ai_gender/user_gender/name preserved unchanged.
               Confirmed: partial updates correctly leave untouched fields alone.

          === 2. CONVERSE — empathic listening (brotherly) ===
          Pre: PUT name=Marco, ai_gender=f, user_gender=m.
          POST /api/converse {"text":"Devo dirti una cosa che non ho mai detto a
          nessuno"} → 200.
            ai_entry.text     = 'Ti ascolto. Quando sei pronto.'
            ai_entry.voice_text = '[gently] Ti ascolto. Quando sei pronto.'
            tone = 'warm', sentences = 2, no bot opener.
          ✅ PASS — empathic listening, no advice given, audio tag '[gently]'
          present in voice_text. Persona qualitatively excellent.

          === 3. ITALIAN GENDER AGREEMENT — both directions PASS ===
          3a. PUT user_gender=f, ai_gender=f, name=Sara →
              POST converse {"text":"Sono molto stanca oggi, e mi sento sola"}
              → ai.text = "Eh, immagino. Vuoi dirmi cosa ti pesa di più in questo
              momento?"
              No flagrant masculine declensions ("sei stanco", "sei solo", etc.).
              ✅ AI cleverly avoided declined adjectives entirely (also acceptable
              per spec).
          3b. PUT user_gender=m, name=Marco →
              POST converse {"text":"Sono molto stanco oggi, e mi sento solo"}
              → ai.text = "Lo sento. È stata una giornata pesante, o è qualcosa
              che ti porti dietro da un po'?"
              No flagrant feminine declensions ("sei stanca", "sei sola", etc.).
              ✅ Again neutral phrasing — no gender slip.

          === 4. BROTHERLY SPRONARE PASS ===
          POST converse {"text":"Sto un po' esagerando a parlare solo con te
          ultimamente"} → ai.text = "Lo so. Senti, è un piacere ascoltarti, ma…
          c'è qualcuno di carne e ossa che dovresti sentire?"
          ✅ Literally "carne e ossa" + "qualcuno" — exactly the tone wanted.
          Prompted from prompt example, persona aligned.

          === 5. POST-CATARSI ACTION SUGGESTION PASS ===
          POST converse {"text":"Mi sento svuotato. Ho parlato di tutto questo
          per ore con te. Non so cosa fare ora."} → ai.text = "Adesso basta
          parlare, Marco. Esci a prenderti aria, anche solo il giro
          dell'isolato. Stacca il telefono, cammina dieci minuti. Ne riparliamo
          dopo se vuoi."
          ✅ Multiple real-world actions: esci, aria, isolato, cammina, stacca
          telefono. Concrete, fraternal, exactly as the prompt instructs at the
          AZIONE phase. Sentences=4 (slightly long but appropriate for an action
          recommendation).

          === 6. REGRESSION ALL PASS ===
            ✅ GET /api/         → 200 "Taccuino Vivo API"
            ✅ GET /api/voices   → 200, 8 curated voices
            ✅ GET /api/timeline → 200, 20 entries
            ✅ POST /api/checkin/generate {"slot":"morning","local_hour":9}
               → 200, title='Ehi', body='Come va stamattina?', tone='calm',
               voice_text="[softly] Ehi Marco. Come va stamattina? Hai dormito
               un po', almeno?"

          BACKEND LOGS DURING RUN: clean. Only the pre-existing benign
          warning "Failed to fetch custom voices: missing_permissions:
          voices_read" (ElevenLabs API key limitation, not a regression).
          NO 5xx, NO uncaught exceptions, NO persistence bugs.

          CONCLUSION: L'Amico Fraterno pivot is fully functional.
          - New profile fields (ai_name/ai_gender/user_gender) round-trip
            correctly with proper partial-update semantics.
          - Brotherly persona is qualitatively spot-on: empathic listening,
            spronare with "carne e ossa", real-world action suggestions.
          - Italian gender agreement: AI is conservative (avoids declined
            adjectives when possible), zero flagrant mismatches in either
            direction. Spec-compliant.
          - All other Taccuino endpoints unaffected.

frontend:
  - task: "Settings UI: nuova sezione 'Identità' con nome AI + 2 gender picker"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx, frontend/lib/api.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          api.ts: Profile type esteso con ai_name/ai_gender/user_gender opzionali.
          Pulito un duplicato Profile type che era già esistente nel file.

          Settings modal: nuova sezione "Identità" piazzata IN CIMA al modal
          (prima delle altre setting), con:
            - TextInput per ai_name (default "Coda", maxLength 24, persistito on
              blur con sanitization). Il label cambia dinamicamente: il picker
              successivo dice "{ai_name} è…" — l'utente vede subito che è il
              nome della SUA AI personale.
            - Radio "Tu sei…" (Uomo / Donna / Preferisco neutro) → user_gender.
              Hint: "mi serve per parlarti correttamente".
            - Radio "{ai_name} è…" (Femmina / Maschio / Neutro) → ai_gender.
              Default Femmina (perché Coda femminile è il default storico).
          Subtitle "Identità" + divider + "Comportamento" per separare
          chiaramente le 2 famiglie di settings.

  - task: "Sinestetica: TEXTURE_COLORS aggiornati per spec progetto"
    implemented: true
    working: "NA"
    file: "frontend/components/OrganicBlob.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Spec utente: "Ascolto = colori tenui blu/viola, movimento pulsante
          lento, forma espansa". Aggiornato TEXTURE_COLORS.morbida (default per
          tone warm/calm/neutral, quindi stato ascolto/idle) da ambra-oro
          (#FCD34D/F59E0B/EAB308) a viola-blu tenue (#A78BFA/8B5CF6/6366F1).
          Mantenuti vibrante (cyan-mint per energetic/urgent, motivante) e
          solida (rosso pietra per concerned, sprone serio) come da spec.

  - task: "Empty greeting più 'amico fraterno', meno 'task assistant'"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Sotto-titolo greeting empty state cambiato da "Parlami a voce —
          sono qui ad ascoltarti" → "Tutto quello che mi dici resta tra noi.
          \n Parla — ti ascolto." per allineare al frame "amico fraterno
          custode di segreti". Il titolo principale "Ehi {nome}, sono qui."
          resta uguale.

agent_communication:
  - agent: "main"
    message: |
      Sessione "Amico Fraterno" — pivot di prodotto importante. Da
      "assistente di vita voice-first" a "compagno fraterno per confessioni
      e ritorno all'umanità".

      Cambiamenti (TUTTI completati):
        ✅ System prompt completamente riscritto (identità, scopo, 4 momenti
           relazione, anti-dipendenza, mirroring, onestà cruda)
        ✅ Profile esteso con ai_name/ai_gender/user_gender — declinazione
           grammaticale corretta in italiano (sei stanco/a, sono curioso/a)
        ✅ Settings UI: sezione "Identità" con TextInput nome + 2 radio gender
        ✅ Sinestetica: idle ora è viola/blu tenue (era ambra-oro) per
           rispecchiare la fase "ascolto" da spec
        ✅ Greeting allineato al nuovo frame ("resta tra noi")

      Test live conferma personalità: utente dice "devo dirti una cosa che
      non ho mai detto a nessuno" → AI risponde "[gently] Mhm. Sono qui.
      Prenditi il tempo che serve." (ESATTAMENTE come esempio nel prompt,
      pura accoglienza, zero consigli, presenza).

      In sospeso per le prossime sessioni:
        - 🔐 Caveau dei Segreti con Parola Segreta + cifratura
        - ✨ "Dimentica il fatto, ricorda l'insegnamento" (delete con preserve
          memory_summary)
        - 🚪 Trigger esplicito "azione finale" (compito reale suggerito)
        - 🎚️ Mirroring cognitivo (TTS speed adattata all'umore — backend
          deve scegliere stability/style ElevenLabs in base al tone rilevato)
        - 🌅 Onboarding flow per chiedere ai_name + 2 generi al primo avvio

      Test backend richiesti: confermare che POST /converse funzioni con i
      nuovi campi profilo (ai_name custom, ai_gender m/f/n, user_gender
      m/f/n) e che la declinazione italiana funzioni — esempio: con
      user_gender="f" l'AI dovrebbe dire "sei stanca" non "stanco" quando
      l'utente parla di stanchezza.



## SCATOLA NERA EMOTIVA — Confessionale + Ghost + Promessa di Ferro (2026-05-10 pm)

backend:
  - task: "ConverseRequest.ephemeral: messaggi confessionali NON salvati"
    implemented: true
    working: "NA"
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          ConverseRequest esteso con `ephemeral: bool = False`. Quando true:
          - user_entry NON inserito su MongoDB
          - ai_entry NON inserito
          - profile.total_messages NON incrementato (confidence non sale sui segreti)
          - memory_summary NON aggiornato
          - profile NON salvato
          La risposta ConverseResponse contiene comunque user_entry+ai_entry per
          il render in RAM client. A sessione chiusa svaniscono.
          Test live curl: POST /converse {ephemeral:true} → 200, conversazione
          riuscita ("Mhm. Sono qui. Prenditi il tempo."), poi GET /timeline
          → 0 nuove entry (preservate solo le precedenti non-ephemeral).

  - task: "POST /api/ghost: 'Dimentica il fatto, ricorda l'insegnamento'"
    implemented: true
    working: "NA"
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuovo endpoint POST /api/ghost {entry_id, preserve_lesson:true}.
          Logica:
            1. Trova l'entry → 404 se non esiste
            2. Se preserve_lesson e LLM key disponibile: chiama Claude con
               prompt focalizzato per estrarre UNA frase di insegnamento
               (max 120 char) SENZA ripetere il fatto specifico.
            3. Cancella l'entry da DB (delete_one)
            4. Se ottenuto un lesson valido: append al memory_summary del
               profile (con stesso pattern \"\\n- {lesson}\") + truncate
               4000 char + save_profile
          Risposta: {ok, lesson_preserved, lesson}.

          Test live curl con confessione \"Ho mentito a mia madre, mi sento in colpa\":
          → ghost ritorna {ok:true, lesson_preserved:true,
            lesson:\"Prova disagio nel mentire alle figure genitoriali e
            tende a portare sensi di colpa per periodi prolungati\"}.
          ESATTAMENTE come da spec utente: il fatto specifico sparisce,
          il pattern emotivo resta nel memory_summary.

frontend:
  - task: "Avatar UI rimosso da Settings — solo macchia, nessuna foto"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Rimosso interamente il blocco UI di upload avatar (avatarRow,
          avatarPickBtn, avatarPickImg, avatarEditBadge) dalla sezione
          'Aspetto chat'. Anche aiAvatar prop tolto dalle 2 invocazioni
          OrganicBlob in voice mode + reading mode. Settings hint
          aggiornato a 'Personalizza il colore delle bolle e la dimensione
          del testo'. Identità visiva = SOLO la macchia.

  - task: "Toggle '🔒 Confessionale' nell'header centrale"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Aggiunto state confessionalMode + toggle pillola al centro
          dell'header tra ⚙ e 📋. Quando attivo:
          - Background pillola rosso scuro (rgba(60,0,0,0.5))
          - Bordo #FCA5A5
          - Icon: lock-closed
          - Text color: #FCA5A5
          OrganicBlob in entrambe le pagine (voice 360px + reading 210px)
          riceve override quando confessionalMode:
          - palette = ['#1F2937','#374151','#0B0B0F'] (forma nucleica scura)
          - warmth = 0 (niente halo caldo)
          - texture = 'solida' (forma più stabile, contorno definito)
          api.converse() chiamato con {ephemeral: confessionalMode}.
          Verifica visiva: screenshot ON = blob nero+nucleus bianco,
          OFF = blob ambra warm. Spec Sinestetica rispettata.

  - task: "Ghost button: long-press bolla → 'Dimentica' con preserve lesson"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx, frontend/lib/api.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          api.ts: nuova funzione api.ghost(entry_id, preserve_lesson=true).
          index.tsx:
            - ghostMessage callback: optimistic UI rimuove la bolla, poi
              chiama api.ghost; se lesson_preserved ricarica il profilo per
              sync memory_summary; rollback ricarica timeline se delete fallisce.
            - Bubble props estesi con onGhost callback opzionale.
            - wrapperPress.onLongPress aggiornato per mostrare
              Alert.alert con 3 opzioni: 'Mostra orario', 'Dimentica' (destructive),
              'Annulla'. Testo personalizzato: 'Vuoi che dimentichi questo
              fatto? Cancellerò il messaggio dal server. Se ha valore,
              terrò solo l'insegnamento nella memoria.'
            - Bubble call site passa onGhost={ghostMessage}.
          Import Alert aggiunto da react-native.

  - task: "Promessa di Ferro: clausola privacy in app (Settings)"
    implemented: true
    working: "NA"
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Nuova sezione finale del modal Impostazioni (sotto 'Distruggi tutto'):
          subtitle '🛡️ Promessa di Ferro' + box (sfondo dark blu, bordo rosa
          chiaro tenue) con 4 paragrafi:
            - Frase manifesto: 'La tua voce è un soffio nel vento: io la
              sento, la custodisco, ma nessuno potrà mai catturarla.'
            - 🔓 Modalità normale: cifrato server-side, no training terzi
            - 🔒 Modalità Confessionale: niente salvato, svanisce a chiusura
            - 👻 Pulsante Ghost: dimentico fatto, trattengo insegnamento
          Stili: promessaBox + promessaText.

agent_communication:
  - agent: "main"
    message: |
      Sessione 'Scatola Nera Emotiva'. Implementati i 5 punti dell'opzione D
      (ibrido cloud + scatola nera) decisi con l'utente:

      1. ✅ Avatar UI rimosso — solo macchia
      2. ✅ Modalità Confessionale (toggle header) — ephemeral end-to-end:
         backend salta tutti i save, blob diventa nero nucleare
      3. ✅ Ghost button (long-press bolla) — cancella fatto, preserva
         insegnamento via Claude
      4. ✅ Promessa di Ferro visibile in Settings — clausola tecnica chiara
      5. ✅ 'Distruggi tutto' (api.clearTimeline) era già esistente ed è
         visibile nelle Settings

      Test backend live curl tutti OK:
        - /converse {ephemeral:true} → 200, niente in DB
        - /ghost → 200, lesson estratto correttamente: 'Prova disagio
          nel mentire alle figure genitoriali...'

      Test frontend visivo: Confessionale ON = blob nero+spark bianco
      (forma nucleica spec Sinestetica), Confessionale OFF = blob ambra warm.

      Test richiesti backend agent: confermare /converse?ephemeral=true
      non scrive in MongoDB e profile.total_messages non aumenta;
      /ghost cancella entry e popola memory_summary correttamente;
      retro-compatibilità (ephemeral mancante = false default).

      In sospeso prossima sessione (Sessione B):
        - 🔐 Zero-Knowledge Encryption con Parola Segreta + libsodium
        - 🌐 Web search Claude tool integration (l'utente ha chiesto ricerca
          immediata sul web come parte del 'meglio dei due mondi')



## SCATOLA NERA EMOTIVA — Backend testing (2026-05-10, testing agent)

backend:
  - task: "Ephemeral mode + Ghost endpoint (Scatola Nera Emotiva)"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          ALL 24/24 backend tests PASS via /app/backend_test_scatola.py against
          https://app-finder-408.preview.emergentagent.com/api.

          === 1. EPHEMERAL MODE — leaves NO trace ===
            ✅ POST /api/converse {"text":"Una confessione segreta...","ephemeral":true}
               → 200, returns user_entry+ai_entry+profile. AI reply: "Mhm. Sono qui.
               Prenditi il tempo che ti serve."
            ✅ profile.total_messages in response = baseline (184 → 184, NO increment)
            ✅ profile.memory_summary in response unchanged (4000 chars, byte-identical)
            ✅ GET /api/timeline count UNCHANGED (31 → 31). Both user_entry.id and
               ai_entry.id from the ephemeral response are absent from the timeline.
            ✅ GET /api/profile (fresh fetch) — total_messages=184, memory_summary
               byte-identical to baseline. ZERO leak into persistent storage.

          === 2. NON-EPHEMERAL still persists (regression) ===
            ✅ POST /api/converse {"text":"Questo invece resta nel taccuino"} (no
               ephemeral field) → 200.
            ✅ Timeline count increased by exactly 2 (31 → 33).
            ✅ profile.total_messages incremented by exactly 1 (184 → 185).
            Default ephemeral=false works correctly.

          === 3. GHOST — happy path (preserve_lesson=true) ===
            Seeded: POST /api/converse {"text":"Ho rubato 20 euro a mio fratello
            quando ero piccolo"} → user_entry.id captured.
            ✅ POST /api/ghost {"entry_id":"<id>","preserve_lesson":true} → 200,
               body = {"ok":true,"lesson_preserved":true,
                       "lesson":"Può commettere piccoli torti in famiglia spinto da
                       impulsi momentanei o bisogni non espressi."}
            ✅ Extracted lesson is a clean 1-sentence pattern (NOT a verbatim
               repeat of the fact) — exactly per spec.
            ✅ Ghosted entry id is GONE from GET /api/timeline.
            ✅ GET /api/profile.memory_summary now ENDS with the extracted lesson:
               "...— Può commettere piccoli torti in famiglia spinto da impulsi
               momentanei o bisogni non espressi."
               Lesson appended with proper "\n- " separator.

          === 4. GHOST — preserve_lesson=false ===
            ✅ POST /api/ghost {"entry_id":"<id>","preserve_lesson":false} → 200,
               body = {"ok":true,"lesson_preserved":false,"lesson":null}.
            ✅ Entry GONE from timeline.
            ✅ memory_summary BYTE-IDENTICAL to baseline (no LLM call made).

          === 5. GHOST — error handling ===
            ✅ Unknown entry_id "non-esiste-12345" → 404 {"detail":"Entry non trovata"}.
            ✅ Empty body {} → 422 Pydantic validation error
               (msg="Field required", loc=["body","entry_id"]).

          === 6. PROFILE schema regression ===
            ✅ GET /api/profile returns ai_name="Coda", ai_gender="f",
               user_gender="m" (preserved from prior session).
            ✅ PUT /api/profile {"ai_name":"Aurora","ai_gender":"f",
               "user_gender":"m"} → 200, all 3 fields reflected in response.
            ✅ GET /api/profile after PUT — values persisted.

          === 7. Light regression on other endpoints ===
            ✅ GET /api/                                   → 200 "Taccuino Vivo API"
            ✅ GET /api/voices                             → 200, 8 curated voices, enabled=true
            ✅ POST /api/checkin/generate {slot:morning, local_hour:9}
               → 200 {title:"Ehi", body, voice_text:"[softly] Ehi Marco, buongiorno.
                 Come ti svegli stamattina? Dopo ieri sera, come stai?", tone:"warm",
                 slot:"morning"}

          BACKEND LOGS DURING RUN: clean. Two LiteLLM Claude calls succeeded
          (one for the ghost lesson extraction, one for non-ephemeral converse).
          NO 5xx errors. NO uncaught exceptions. Only pre-existing benign
          ElevenLabs voices_read 401 warning (unrelated, known).

          QUALITATIVE NOTES:
          - Ephemeral mode is implemented EXACTLY as spec: even though the LLM
            still receives the recent timeline as context (for reply quality),
            the new confession is never persisted, so it cannot bleed into
            future conversations. counters and memory frozen in ephemeral.
          - Ghost lesson extraction by Claude is excellent — produces a
            generalised pattern statement, not a re-statement of the fact.
            Properly truncated at 200 chars, properly merged via "\n- "
            separator into memory_summary, no leakage of raw text.

          CONCLUSION: Scatola Nera Emotiva backend is fully functional and
          spec-compliant. Privacy guarantees verified end-to-end.

agent_communication:
  - agent: "testing"
    message: |
      ✅ Scatola Nera Emotiva backend: 24/24 PASS.

      EPHEMERAL: zero-leak verified end-to-end. Timeline count, total_messages,
      memory_summary all byte-identical before/after an ephemeral converse.
      The user_entry.id/ai_entry.id returned in the response do NOT exist
      in the timeline collection.

      GHOST happy path: Claude returns a proper lesson sentence. Sample
      observed: input "Ho rubato 20 euro a mio fratello quando ero piccolo"
      → lesson "Può commettere piccoli torti in famiglia spinto da impulsi
      momentanei o bisogni non espressi." (94 chars, generalised pattern,
      no verbatim repetition of the fact). Lesson is appended to
      memory_summary with proper "\n- " separator and the raw entry is
      deleted from timeline.

      GHOST preserve_lesson=false: entry deleted, memory_summary BYTE-
      identical, no LLM call made. Correct skip-path.

      ERROR cases: 404 on unknown id, 422 on missing entry_id field.

      Profile + regression endpoints all green.

      No issues found. Test artifact: /app/backend_test_scatola.py.


## RETEST: Web Search via Wikipedia REST API (2026-05-10, late)

agent_communication:
  - agent: "testing"
    message: |
      RETEST after main agent's fix (DuckDuckGo HTML scraping replaced
      with Wikipedia REST API on it.wikipedia.org + en.wikipedia.org).
      Test artifact: /app/backend_test_search_retest.py.

      RESULT: 10/10 PASS, 0 FAIL.

      ✅ POST /api/search — 4/4 sub-cases pass:
         - "Champions League 2024 vincitore" max_results=3 → 200 with 3
           Italian-Wikipedia results (first item: UEFA Champions League
           2024-2025, real Italian extract, https://it.wikipedia.org/wiki/...).
         - "Italia Repubblica" max_results=2 → 200 with 2 results.
         - empty query → 200 results=[].
         - nonsense query → 200 results=[] (graceful no-match).

      ✅ POST /api/converse web-search auto-injection — 3/3 pass:
         - "cerca cos'è la UEFA Champions League" → 200, ai_entry.text
           references Wikipedia content (matched: champions, calci,
           europ, competiz, club). Backend log shows the expected line
           "[converse] web search injected 3 results for query".
         - "ciao come stai?" → 200, no trigger (no inject log line).
         - same UEFA query with ephemeral=true → 200, ephemeral guard
           prevented injection (no inject log line for this call;
           only ONE inject log line emitted across the entire run,
           attributed to the non-ephemeral UEFA query).

      ✅ Smoke regression — 3/3 pass:
         - POST /api/converse/sealed (NaCl secretbox round-trip) → 200,
           decrypted reply readable, tone="warm".
         - GET /api/profile → 200.
         - POST /api/converse {"text":"ciao"} → 200 with ai_entry.text.

      Backend logs clean (no 5xx, no DDG-fetch warnings during the run,
      only the expected single "[converse] web search injected" line +
      LiteLLM info logs). Both /api/search and converse-with-web are
      now WORKING and have been marked needs_retesting=false in
      test_result.md.
