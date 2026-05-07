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