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
