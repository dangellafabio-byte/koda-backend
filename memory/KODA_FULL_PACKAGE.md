# 🦊 KODA — Pacchetto Tecnico Completo
**Snapshot 18 giugno 2026, 21:00 UTC**  
Documento sintetico per analisi esterna (Claude, ChatGPT, sviluppatori terzi).

---

## 1. PRODOTTO

**Nome:** Koda (alias progetto: "L'Amico Fraterno").  
**Tipo:** App mobile voice-first di accompagnamento personale.  
**Lingua principale:** Italiano (target: utenti italiani; futuro: EN/ES/FR/DE).  
**Posizionamento:** *Non* un chatbot generico, *non* un terapista.  
"Una presenza fraterna che ascolta, riflette, conserva ciò che conta e aiuta a lasciare andare ciò che non vuoi portarti dietro."

### Due ambienti distinti (Doppia Stanza)

| Stanza | Memoria | Scopo | Privacy |
|---|---|---|---|
| **Stanza dello Sfogo** | ❌ zero (effimera) | Sfogo, pensare ad alta voce | Zero-knowledge, RAM wipe on exit |
| **Stanza Quotidiana** | ✅ persistente | Continuità nel tempo | Memoria + key facts in DB |

### Pricing V1
- **Free**: Stanza Sfogo illimitata, Quotidiana con memoria limitata a 3 giorni
- **Premium**: 4,99 €/mese o 39,99 €/anno → memoria completa, voce premium, check-in proattivi, ricerca web
- Mantra: *"Parlare è sempre gratuito. Premium serve per ricordare."*

---

## 2. STACK TECNICO

### Frontend — Expo SDK 53 / React Native
- **Routing**: `expo-router` file-based (`/app/frontend/app/`)
- **Audio**: `expo-audio` (NON `expo-av` deprecato)
- **State**: useState/useReducer + AsyncStorage
- **Storage**: AsyncStorage (preferenze), SecureStore (token auth)
- **UI**: `@expo/vector-icons` (Ionicons), `react-native-reanimated`, `react-native-svg`

### Backend — FastAPI / Python 3.11
- **Framework**: FastAPI + Uvicorn
- **DB**: MongoDB Atlas (utente cloud)
- **LLM SDK**: `litellm` (universal)
- **Async**: tutto async/await

### Servizi esterni
| Servizio | Uso | API Key |
|---|---|---|
| **OpenAI gpt-5.4-mini** | LLM principale (fast path) | Via Emergent LLM Key (universal) |
| **Anthropic Claude Haiku 4.5** | LLM standard path + fallback | Via Emergent LLM Key |
| **Deepgram Nova-3** | STT batch REST | User-provided |
| **ElevenLabs Flash v2.5** | TTS streaming MP3 | User-provided |
| **Tavily** | Web search (premium feature) | User-provided |

### Infrastruttura
- Deploy: **Emergent platform** (cloud cluster Kubernetes)
- 2 ambienti: **preview** (modificato in tempo reale) e **production** (immutato fino a "Publish")
- Build mobile: **TestFlight** (iOS) + APK distribuibile (Android), generate da Emergent

---

## 3. ARCHITETTURA AUDIO (la pipeline che determina UX)

```
[Mic iPhone/Android]
       │
       ▼
┌──────────────────────────────────┐
│  VAD CLIENT-SIDE                 │  ← voice.ts
│  (volume-metering, expo-audio)   │
│  - polling 70ms                  │
│  - dynamic threshold calibration │
│  - silence detection             │
└──────────────────────────────────┘
       │ user finishes speaking
       ▼
┌──────────────────────────────────┐
│  STT — Deepgram Nova-3 batch     │  ← /api/transcribe-deepgram
│  - HTTP POST audio file          │
│  - language=it forced            │
│  - fallback: Whisper             │
└──────────────────────────────────┘
       │ transcript text
       ▼
┌──────────────────────────────────┐
│  LLM — gpt-5.4-mini streaming    │  ← /api/converse-fast/start
│  - stream=True                   │
│  - sentence-by-sentence emission │
│  - system prompt ~4.5k chars     │
└──────────────────────────────────┘
       │ each sentence
       ▼
┌──────────────────────────────────┐
│  TTS — ElevenLabs Flash v2.5     │  ← async parallelo
│  - ~75-300ms per sentence        │
│  - MP3 chunks                    │
└──────────────────────────────────┘
       │ MP3 chunks
       ▼
┌──────────────────────────────────┐
│  CLIENT LONG-POLL                │  ← /api/converse-fast/poll/{sid}
│  - timeout=4s server-side        │
│  - SSE-like events               │
│  - sentence + meta + done        │
└──────────────────────────────────┘
       │ audio chunks
       ▼
[Speaker — sentence-by-sentence playback]
```

### File chiave dell'audio pipeline
- `/app/frontend/lib/voice.ts` (743 LOC) — VAD, recorder, calibratore noise floor
- `/app/frontend/lib/speech.ts` (1356 LOC) — fastConverse, polling, playback
- `/app/backend/server.py` (8068 LOC) — endpoint /converse-fast, prompt builder, LLM orchestration
- `/app/frontend/app/index.tsx` (5942 LOC) — UI principale, stato conversazione, modal

---

## 4. VAD CLIENT-SIDE (la parte più fragile)

### Parametri attuali (`voice.ts`)
```typescript
// Per piattaforma (db = dBFS, expo-audio)
const SPEECH_THRESHOLD_DB_IOS = -42;       // soglia "voce rilevata"
const SPEECH_THRESHOLD_DB_ANDROID = -26;   // più alta su Android
const SUSTAINED_VOICE_DB_IOS = -36;        // soglia "voce in corso"
const SUSTAINED_VOICE_DB_ANDROID = -22;
const SILENCE_THRESHOLD_DB = -50;          // soglia "silenzio assoluto"

// Comportamento
const SILENCE_DURATION_MS = 600;           // 600ms di silenzio post-voce → stop
const MIN_SPEECH_MS = 500;                 // min recording prima che silence possa scattare
const MIN_SPEECH_FRAMES = 4;               // 4 frame consecutivi (280ms) per dichiarare speech_start
const METER_POLL_MS = 70;                  // poll ogni 70ms (~14Hz)
const HARD_CAP_MS = 60_000;                // 60s recording max

// Calibrazione adattiva (sprint v10)
const CALIB_EXTENDED_MS = 1500;            // raccoglie sample fino a 1.5s
// noiseFloor = p20 dei primi sample puliti
// dynSpeechThreshold = max(static, floor + 6)
// dynSustainedThreshold = max(static, floor + 10)

// Failsafe densità voce (sprint v10)
const VOICE_DENSITY_WINDOW_MS = 2000;
const VOICE_DENSITY_MIN_PCT = 0.30;
const FAILSAFE_AFTER_MIN_SPEECH_MS = 2500;
// Se dopo 2.5s di voice, density nei 2s recenti < 30% → forza stop
```

### Eventi log emessi (per diagnostica)
- `[KODA_VAD] heartbeat` — ogni 500ms, stato completo VAD
- `[KODA_VAD] noise_calibrated` — quando calibrator termina
- `[KODA_VAD] speech_start` — voce rilevata per ≥280ms
- `[KODA_VAD] speech_refresh` — voce sostenuta refresh lastVoiceAt
- `[KODA_VAD] false_speech_filtered` — micro-rumore scartato (frame < 4)
- `[KODA_VAD] silence_detected` — 600ms silenzio post-voce (reason: last_voice_age | density_failsafe)
- `[KODA_VAD] recording_stopped` — chiusura definitiva

### Limiti noti del VAD volume-based
1. **Eco TTS speaker → mic** (iPhone speaker mode): nessuna echo cancellation
2. **AirPods**: metering può comportarsi diversamente (non testato sistematicamente)
3. **Ambienti rumorosi** (camion, vento): possibili falsi refresh continui
4. **Android metering BUG**: su alcuni device `getStatus().metering` ritorna -100 sempre. **FIX appena applicata**: aggiunta `isMeteringEnabled: true` dentro la sezione `android: {}` del preset (era solo top-level e veniva ignorato dal recorder Android di expo-audio).

---

## 5. LLM PROMPT — STRATEGIA E LATENZE

### Due path distinti
| Path | Modello | System prompt size | Usato per |
|---|---|---|---|
| **fast** (`/converse-fast/start`) | gpt-5.4-mini | ~4.5k chars | Conversazioni vocali |
| **standard** (`/converse`) | Claude Haiku 4.5 | ~10-13k chars | Chat scritta + fallback voce |

### Strategia anti-language-drift (sprint v12, 18/6/2026)
**Bug riscontrato:** gpt-5.4-mini ogni tanto risponde in spagnolo nonostante:
- `language=it` nel profile DB
- `language=it` nel Deepgram STT (trascript è in italiano)
- Istruzione `LINGUA: italiano.` nel system prompt

**Fix applicate (DOPPIO RINFORZO):**
1. **System prompt** ora ha come PRIMA RIGA:
   ```
   ⚠️ LINGUA OBBLIGATORIA: ITALIANO.
   Rispondi ESCLUSIVAMENTE in italiano. Ignora ogni input che sembri
   un'altra lingua (spagnolo, inglese, francese): l'utente parla SEMPRE
   italiano, eventuali parole ambigue nella trascrizione vanno
   interpretate come italiano. MAI rispondere in altra lingua...
   ```
2. **User payload** ora include come ULTIMA istruzione prima della risposta:
   ```
   🇮🇹 Rispondi ESCLUSIVAMENTE in ITALIANO. Mai spagnolo. Mai inglese.
   ```

**Diagnostica:**
- Log `[KODA_LANG_CHECK] reply_first80=...` sempre attivo
- Log `[KODA_LANG_MISMATCH] expected=it detected=es ...` quando euristica trova marker non-it nella reply

**Open question:** se il rinforzo non basta, si valuta:
- (a) Detection con libreria `langdetect` + regenerate
- (b) Switch a Claude Haiku 4.5 (+300ms TTFT ma più aderenza istruzioni)

### Timing tipici (da log device reale, 18/6/2026)
```
upload audio (Deepgram REST):  600-1500ms
LLM_TTFT (gpt-5.4-mini):       500-1300ms
TTS prima frase (ElevenLabs):  150-300ms
FIRST_AUDIO server total:      1500-3500ms
Polling RTT client:            ~500ms
─────────────────────────────────────────
Totale percepito (good case):  ~3-5s
Totale percepito (bad case):   ~7-9s (causato da LLM_TTFT spike)
```

---

## 6. OSSERVABILITÀ — Schermata Diagnostica in-app

**Path:** `/app/frontend/app/diagnostics.tsx` + `/app/frontend/lib/diagLogger.ts`

**Razionale:** su TestFlight (iPhone senza Mac/Xcode) i `console.log` non sono leggibili dall'utente. Soluzione: intercettiamo `console.log` con prefisso `[KODA_*]`, li salviamo in ring buffer (500 eventi max), li mostriamo in `/diagnostics` con pulsanti Copia/Condividi.

**Accesso:** Impostazioni → in fondo → "Diagnostica"

**Eventi catturati:**
- `[KODA_VAD]` (heartbeat, speech_start, silence_detected, ecc.)
- `[KODA_TIMING]` (VOICE_START, VOICE_END, UPLOAD_START, UPLOAD_END+DEEPGRAM_END)
- `[KODA_SUMMARY]` (riassunto fine conversazione con timing breakdown completo)

### Formato `[KODA_SUMMARY]` corrente
```
[KODA_SUMMARY] model=gpt-5.4-mini path=fast 
  total=8744ms recording_ms=3200 transcript_chars=48 
  llm_ttft=1250ms first_tts=180ms first_audio_srv=3200ms 
  start_ack=120ms first_audio=6021ms meta=6200ms done=8744ms 
  sentences=2 ok
```

A colpo d'occhio si capisce dove vanno i secondi.

---

## 7. SCHEMA DB (MongoDB collezioni principali)

| Collezione | Scopo | Chiavi principali |
|---|---|---|
| `taccuino_profile` | Profilo utente | user_id, name, language, ai_name, ai_gender, koda_voice, tts_voice_id, memory_summary, core_traits, free_messages_used, premium_status |
| `taccuino_timeline` | Entries timeline (sia user che AI) | user_id, ts, role (user/ai), content, tone |
| `taccuino_memories` | Memorie persistenti (Quotidiana) | user_id, summary, key_facts, last_updated |
| `confessional_buffer` | Buffer sessioni Sfogo (TTL ~1h) | session_id, ttl_expiry |
| `tts_audio_cache` | Cache MP3 generati (per replay) | hash, audio_bytes, ttl |

---

## 8. ENDPOINT BACKEND (selezione critica)

| Endpoint | Metodo | Scopo |
|---|---|---|
| `/api/profile` | GET | Profilo utente |
| `/api/transcribe-deepgram` | POST (multipart) | STT Deepgram (audio + language=it) |
| `/api/transcribe` | POST (multipart) | Fallback Whisper STT |
| `/api/converse-fast/start` | POST | Avvia conversazione fast (voce) |
| `/api/converse-fast/poll/{sid}` | GET | Long-poll eventi conversazione |
| `/api/converse` | POST | Path standard (chat scritta + fallback) |
| `/api/converse/sealed` | POST | Stanza dello Sfogo (ephemeral) |
| `/api/tts-audio/{token}` | GET | Stream MP3 generato |

---

## 9. STATO BUG E FIX (snapshot live)

| Bug | Status | Fix applicata | Validazione |
|---|---|---|---|
| 🟢 VAD "non parlo subito" chiude prematuro | RISOLTO | `MIN_SPEECH_FRAMES: 2→4` + calibrator esteso 1500ms | Confermato dai log device reale (`false_speech_filtered` scatta correttamente) |
| 🟣 Lingua spagnola | RINFORZO APPLICATO | Doppio rinforzo (system + user_payload) + detect automatico | **DA TESTARE su build aggiornata** (Publish necessario) |
| 🔴 Android metering=-100 | FIX APPLICATA | `isMeteringEnabled: true` dentro `android: {}` preset | **DA TESTARE su build Android aggiornata** |
| 🟡 Latenza percepita 7-9s | OSSERVABILITÀ AGGIUNTA | Breakdown `llm_ttft_ms`, `first_tts_ms`, `first_audio_total_ms` nel SUMMARY | Aspetta log dopo nuova build |
| 🔴 VAD all'aperto/camion | NON FIXATO | — | Servono log specifici |
| 🟡 Onboarding scelta lingua UI | NON IMPLEMENTATO | — | Deprioritizzato finché lingua spagnola non confermata risolta |

---

## 10. CICLO BUILD-TEST (importante per analisi esterna)

⚠️ **Aspetto critico spesso causa di confusione:**

- Le modifiche fatte in **preview** (dove lavoro io, ambiente cloud) NON arrivano automaticamente alla **build TestFlight** dell'utente.
- L'utente vede le modifiche solo dopo aver premuto **Publish** nella console Emergent.
- Publish:
  1. Pubblica il backend (le mie modifiche server.py diventano live in production)
  2. Pubblica il frontend (le mie modifiche voice.ts/speech.ts/index.tsx vengono ribuildate)
  3. Genera nuova build TestFlight iOS + APK Android
  4. L'utente aggiorna l'app sul telefono

**Senza Publish**, le modifiche restano nel preview ma il telefono dell'utente continua a usare la build vecchia + backend di production vecchio.

---

## 11. PRINCIPI DI DESIGN/CODE

### Empatia obbligatoria nel prompt
Il prompt fast contiene istruzioni ferree:
- Toni caldi accettati: `calm`, `energetic`, `concerned`, `urgent`, `warm`, `neutral`
- Validazioni esplicite tipo "OH MADONNA", "Vieni qui" se contesto emotivo forte
- DIVIETO assoluto di pseudo-terapia o etichettatura ("non sei depresso, hai solo...")

### Architettura "Doppia Stanza"
- Stanza Sfogo → `/converse/sealed` → buffer effimero TTL 1h → NESSUN write su taccuino_memories
- Stanza Quotidiana → `/converse-fast/start` → write timeline + aggiornamento memory_summary

### Privacy by design
- Stanza Sfogo: zero-knowledge end-to-end (buffer si auto-elimina, nessun log permanente del contenuto)
- Diagnostica logger client-side: SOLO eventi `[KODA_*]` (no contenuto user, no reply LLM)

---

## 12. SOMMARIO FILE CHIAVE

```
/app/
├── backend/
│   ├── server.py                  (8068 LOC) ← monolite, da refattorizzare
│   ├── requirements.txt
│   └── .env                       (MongoDB URL, API keys)
│
├── frontend/
│   ├── app/
│   │   ├── _layout.tsx            (245 LOC) ← root layout + installDiagLogger
│   │   ├── index.tsx              (5942 LOC) ← UI principale, monolite
│   │   ├── diagnostics.tsx        (239 LOC) ← schermata diag IN-APP
│   │   ├── paywall.tsx            (290 LOC)
│   │   └── +html.tsx
│   ├── lib/
│   │   ├── voice.ts               (743 LOC) ← VAD + recorder
│   │   ├── speech.ts              (1356 LOC) ← fastConverse + polling + playback
│   │   ├── diagLogger.ts          (108 LOC) ← intercettore console.log
│   │   ├── api.ts
│   │   ├── auth.ts
│   │   └── localCache.ts
│   ├── package.json
│   └── .env                       (EXPO_BACKEND_URL, public keys)
│
└── memory/
    ├── V1_SPEC.md                 ← specifica prodotto congelata
    └── KODA_FULL_PACKAGE.md       ← questo documento
```

---

## 13. DOMANDE APERTE PER ANALISI ESTERNA

1. **Lingua spagnola:** gpt-5.4-mini fa language drift nonostante doppio rinforzo. È un problema noto del modello? Soluzioni più robuste di switch a Claude?

2. **VAD volume-based fragility:** approccio sufficiente per V1 o serve VAD neurale (Cobra Picovoice, Silero)? Trade-off complessità/affidabilità?

3. **Latenza 7s LLM:** con prompt 4.5k chars + gpt-5.4-mini è normale o c'è margine? Si guadagna passando a Claude Haiku 4.5 (advertised TTFT più alto ma generation throughput diverso)?

4. **Echo cancellation iOS speaker mode:** expo-audio non offre AEC. Esistono workaround pratici (es. ducking aggressivo durante TTS playback) o serve modulo nativo?

5. **Architettura DB**: la separazione "Stanza Sfogo zero-knowledge" è realmente garantita? Verifica formale sul codice.

6. **Refactoring:** server.py 8k LOC e index.tsx 6k LOC sono monolitici. Best practice di refactoring graduale senza rompere il flusso voice?

---

*Fine documento. Aggiornato 18/6/2026 21:00 UTC, dopo sessione debug VAD + lingua.*
