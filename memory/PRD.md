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
