# AUDIO_ROBUSTNESS_PLAN.md

**Data:** 2026-07-20
**Autore:** Agente Emergent
**Owner:** Fabio
**Stato:** DRAFT — implementazione bloccata da pipeline EAS
**Obiettivo:** Koda deve trascrivere correttamente la voce dell'utente in **qualsiasi condizione ambientale** (furgone in autostrada, bagno con ventola, città rumorosa, CarPlay, AirPods) senza costringere l'utente a urlare o a ripetersi.

---

## 1. Problema definito dall'utente (Requirement)

> "Quando smetto di parlare, Koda mi ha sentito perfettamente e risponde. In qualsiasi condizione — furgone, autostrada, bagno con ventola, ovunque. Non mi interessa la tecnologia. Mi interessa il risultato."

**Metrica di successo target:**
| Ambiente | STT accuracy attesa |
|---|---|
| Ufficio/casa silenziosa | ≥ 98% |
| Furgone motore acceso a regime | ≥ 92% |
| Furgone in autostrada | ≥ 88% |
| Bagno con ventola/rubinetto | ≥ 85% |
| CarPlay + Bluetooth | ≥ 90% |
| **Zero casi in cui utente deve ripetere/urlare** in condizioni normali |

**100% non è raggiungibile** — nessuna tecnologia esistente (Apple, Google, OpenAI, Deepgram) garantisce trascrizione perfetta in rumore estremo. Target realistico: >90% in condizioni operative normali.

---

## 2. Diagnosi dello stato attuale (2026-07-20)

### 2.1 Stack STT attivo

```
iPhone microfono
  → expo-audio AVAudioRecorder (mode=???)
    → AAC 16kHz mono 32kbps
      → WebSocket → Railway backend voice_stream.py v63.6
        → Deepgram Nova-2 STT (streaming)
          → transcript
```

### 2.2 Cause identificate dei problemi audio in ambiente rumoroso

**Causa #1 (probabile 70% del problema): Voice Processing Unit iOS non attivo**

- Il plugin `withExpoAudioVoiceProcessing.js` **ha già il codice** per attivare `AVAudioSession.Mode.voiceChat` (marker `KODA PATCH 2026-07-13 v56`).
- `.voiceChat` attiva:
  - **AEC** (Acoustic Echo Cancellation) — Apple hardware
  - **AGC** (Automatic Gain Control) — Apple hardware
  - **NS** (Noise Suppression) — Apple hardware
- Sono gli stessi filtri usati da FaceTime, WhatsApp Call, Siri, Zoom su iPhone.
- **PROBLEMA**: nel log Msg 280 il client scrive `plugin v63 NOT AVAILABLE` alla connessione WebSocket → runtime iOS non trova `kodaGetAudioSessionState()` → **la patch v56 non è stata effettivamente compilata nel binario TestFlight corrente**.
- Confermato ulteriormente dal `CASE_57f6b0db_evidence.md`: la pipeline EAS Emergent compila da commit stale (~4 ore vecchi) → i fix del plugin non arrivano al dispositivo.

**Causa #2 (probabile 20% del problema): Voice Isolation iOS 16.4+ non attivato**

- iOS 16.4 ha introdotto **Voice Isolation** — un ulteriore layer ML di soppressione ambientale specificamente ottimizzato per rumori di sfondo continui (motori, ventole, vento).
- Attivabile via `AVAudioApplication.shared.setInputMuted(false)` + `MPRemoteCommandCenter` config o via `AVAudioSession.setPrefersEchoCancelledInput(true)` (iOS 18.2+).
- **Non è nel plugin attuale**.

**Causa #3 (probabile 10% del problema): AAC bitrate 32kbps troppo basso**

- `KODA_STT_BITRATE_CHECK: ios=32000 bps`.
- Con noise cancellation attivo, 32kbps può essere sufficiente. Ma **con audio già rumoroso**, il codec AAC LC a 32kbps aggiunge distorsione percettibile su frequenze <200Hz (dove viaggia molto rumore motore) → Deepgram riceve audio con artefatti.
- Non aumentiamo il bitrate finché non abbiamo verificato il fix #1: con `.voiceChat` attivo l'audio arriva pulito e 32kbps basta.

### 2.3 Bug secondario iOS AudioSession `!act` (OSStatus 560557684)

- Osservato nel log: `chunk #2 pre-prepare refresh failed: OSStatus 560557684`.
- Errore = `kAudioSessionNotActiveError` — Apple.
- Causa: race condition tra `stop()` del chunk N e `prepareToRecordAsync()` del chunk N+1 quando la session è in transizione (background/foreground o interruzione).
- Impatto: hard-cap 180000ms → sessione zombie per 9 minuti nel log Msg 280.
- **Fix non prioritario** per lancio (raro, workaround = riapri app).

---

## 3. Architettura target — 3 strati indipendenti

### Filosofia

> Ogni strato migliora l'audio o la trascrizione **prima** di passarlo al successivo. Ogni strato può essere implementato e testato **indipendentemente**. Ogni strato può essere disattivato se causa regressioni.

### Diagramma

```
┌─────────────────────────────────────────────────────────┐
│ STRATO 1 — AUDIO CAPTURE (native iOS, hardware)         │
│  • AVAudioSession .playAndRecord + mode .voiceChat      │
│  • Voice Isolation (iOS 16.4+)                          │
│  • Preferred data source: "voice" beamforming           │
│  • sampleRate 16kHz nativo                              │
│  → OUTPUT: PCM 16kHz mono, rumore già rimosso           │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ STRATO 2 — STT PRIMARIO (SFSpeechRecognizer on-device)  │
│  • expo-speech-recognition (SFSpeechRecognizer wrapper) │
│  • locale: it-IT                                        │
│  • requiresOnDeviceRecognition: true                    │
│  → OUTPUT: testo trascritto + confidence + isPartial    │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼ (se confidence < 0.6 OR empty)
┌─────────────────────────────────────────────────────────┐
│ STRATO 3 — STT FALLBACK CLOUD (Whisper-1)              │
│  • Backend riceve solo l'audio dei chunk falliti        │
│  • OpenAI Whisper-1 via Emergent LLM Key                │
│  • Elimina progressivamente Deepgram                    │
│  → OUTPUT: testo trascritto                             │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
                   Claude Haiku → ElevenLabs (INVARIATO)
```

---

## 4. FASE A — Priorità massima, ROI massimo

**Nome:** "Voice Processing Unit + Voice Isolation attivi runtime"
**Effort:** 1-2 giorni di sviluppo + 1 build EAS
**Impact atteso:** +30-40% robustezza in ambiente rumoroso
**Rischio regressione:** BASSO — modifica isolata al plugin nativo esistente

### 4.1 Task A.1 — Verificare che il plugin `withExpoAudioVoiceProcessing` venga effettivamente applicato

**PRECONDIZIONE:** Emergent Support deve sbloccare la pipeline EAS (case `#57f6b0db`).

**Come verificare:**
1. Rigenerare build EAS con log verbose abilitati.
2. Cercare nei log Xcode/EAS Build queste stringhe (già scritte nel plugin):
   ```
   [withExpoAudioVoiceProcessing] === PLUGIN START ===
   [withExpoAudioVoiceProcessing] ✅ Voice Processing patch applied
   [withExpoAudioVoiceProcessing] ✅ AsyncFunction kodaGetAudioSessionState injected (v63.3, anchor=...)
   [withExpoAudioVoiceProcessing] === PLUGIN DONE === v63=... v56=injected_now
   ```
3. Se **manca** anche solo una di queste linee → la pipeline non applica il plugin. STOP e ridiscutere con Emergent Support.
4. Se **presenti** tutte → runtime del device, chiamare `kodaGetAudioSessionState()` da JS deve tornare `mode: "AVAudioSessionModeVoiceChat"`. Se torna `"AVAudioSessionModeDefault"` → il patch è stato compilato ma non attivato → debug del ramo `setCategory` in `expo-audio` per capire quale ramo viene eseguito.

**File di riferimento:**
- `/app/frontend/plugins/withExpoAudioVoiceProcessing.js` (righe 82-120: NEW_BLOCK)
- `/app/frontend/lib/voice.ts` (già chiama `prewarmMic()` che dovrebbe invocare il patch)

### 4.2 Task A.2 — Aggiungere Voice Isolation iOS 16.4+

**File da modificare:** `/app/frontend/plugins/withExpoAudioVoiceProcessing.js`

**Modifica al NEW_BLOCK (righe 82-120):**

Aggiungere dopo `try session.setCategory(category, mode: recordingMode)`:

```swift
// === Voice Isolation (iOS 16.4+) ===
if #available(iOS 16.4, *) {
  if category == .playAndRecord {
    // AVAudioSession.setPrefersEchoCancelledInput è disponibile da iOS 18.2
    if #available(iOS 18.2, *) {
      try? session.setPrefersEchoCancelledInput(true)
    }
    // Voice Isolation via AVCaptureSession non serve — .voiceChat lo attiva
    // automaticamente su iPhone 14+ con Neural Engine. Su iPhone 13 e sotto,
    // il fallback è la standard NS di .voiceChat (comunque buona).
  }
}
```

**Perché serve:** su iPhone 14 Pro / 15 / 16 Voice Isolation è ML-based e sopprime rumore continuo (motori, ventole, aria condizionata) meglio dei filtri classici DSP di `.voiceChat`.

**Marker patch da aggiornare:** `KODA_PATCH_MARKER = "KODA PATCH 2026-07-20 v57 (voiceChat + voice-isolation)"`.

### 4.3 Task A.3 — Loud diagnostic client-side

**File da modificare:** `/app/frontend/lib/voice.ts`

Dopo `prewarmMic()`, aggiungere un log **una tantum per sessione**:

```typescript
try {
  const AudioModule = require("expo-audio").AudioModule;
  const state = await AudioModule.kodaGetAudioSessionState?.();
  if (state) {
    console.log(
      `[KODA_AUDIO_SESSION_STATE] category=${state.category} ` +
      `mode=${state.mode} sr=${state.sample_rate} ` +
      `preferred_sr=${state.preferred_sample_rate} ` +
      `input=${state.input_port_type} data_source=${state.input_data_source}`
    );
  } else {
    console.log("[KODA_AUDIO_SESSION_STATE] plugin v63 NOT AVAILABLE — build stale");
  }
} catch (e) {
  console.log("[KODA_AUDIO_SESSION_STATE] error", e);
}
```

**⚠️ REGOLA CRITICA:** questo log deve essere chiamato **DOPO** `prewarmMic()` e **PRIMA** di aprire il WebSocket, MAI durante `prepareToRecordAsync()` (causa il crash iOS visto precedentemente).

### 4.4 Criteri di accettazione Fase A

- [ ] Build EAS logga tutte le 4 linee del plugin.
- [ ] Runtime device: `kodaGetAudioSessionState()` torna `mode: "AVAudioSessionModeVoiceChat"`.
- [ ] Test in furgone motore acceso: Deepgram trascrive senza `[DIAG probe]` su almeno 8/10 frasi normali.
- [ ] Test bagno con ventola: trascrive almeno 5/10 frasi (era 0/10).
- [ ] Zero regressioni ambiente silenzioso (trascrizione perfetta come oggi).

---

## 5. FASE B — Speech Framework nativo iOS (valutare DOPO risultati Fase A)

**Nome:** "STT on-device con SFSpeechRecognizer"
**Effort:** 3-4 giorni di sviluppo + 1 build EAS
**Impact atteso:** ulteriori +10-15% robustezza + latenza -300ms + risparmio Deepgram

### 5.1 Trigger di implementazione

Implementare **SOLO SE** dopo Fase A:
- Trascrizione furgone/bagno resta < 85%
- Utente ancora costretto a ripetere

Altrimenti restare su Deepgram + Fase A (più semplice, meno superficie di bug).

### 5.2 Library

- **`expo-speech-recognition`** (community, MIT license, ben mantenuta)
- Wrapper di `SFSpeechRecognizer` iOS + `SpeechRecognizer` Android
- Supporta streaming + partial results
- Locale `it-IT` supportato on-device da iOS 13+ su iPhone 6s+
- Docs: https://github.com/jamsch/expo-speech-recognition

### 5.3 Cambio architetturale

**Prima (oggi):**
```
Client audio AAC → WebSocket → Backend → Deepgram → transcript
```

**Dopo (Fase B):**
```
Client audio → SFSpeechRecognizer on-device → transcript → WebSocket → Backend
```

**Impatto backend:**
- `voice_stream.py`: aggiungere handler per messaggi `{type: "transcript_from_client", text: "..."}` **in parallelo** al flusso audio esistente.
- Feature flag `USE_CLIENT_STT` env var (default false) per rollout progressivo.
- Deepgram resta come fallback per Android (se decidiamo di supportarlo) o per audio quality insufficiente.

### 5.4 Vincoli tecnici da conoscere

1. **Limite sessione 1 minuto:** `SFSpeechRecognitionTask` va restartato ogni 55s. Gestione via handler `SFSpeechRecognitionTaskDelegate`.
2. **Permission Info.plist:** aggiungere `NSSpeechRecognitionUsageDescription = "Koda usa il riconoscimento vocale iOS per capire cosa dici"`.
3. **`supportsOnDeviceRecognition`:** verificare runtime che sia `true` per `it-IT`. Se `false` → fallback automatico a Deepgram.
4. **Battery:** on-device STT usa Neural Engine → consumo ~15% in più rispetto a solo cattura. Accettabile.
5. **Confidence:** SFSpeechRecognizer confidence non è comparable con Deepgram — serve calibrazione (empirica).

### 5.5 Criteri di accettazione Fase B

- [ ] Trascrizione furgone/bagno ≥ 90%.
- [ ] Latenza percepita fine-utente-parla → Koda-risponde ≤ 1.5s (oggi ~2.5s).
- [ ] Fallback a Deepgram funziona se on-device fallisce.
- [ ] Costo Deepgram mensile ridotto ≥ 70%.

---

## 6. FASE C — Whisper fallback (opzionale, valutare DOPO Fase B)

**Trigger:** solo se casi limite (rumore estremo) restano problematici.

**Implementazione lato backend, zero build native:**
- Su chunk con `client_stt_confidence < 0.6` OR `empty transcript`, backend fa chiamata a **OpenAI Whisper-1** via Emergent LLM Key.
- Whisper-1 costa $0.006/min → trascurabile per casi limite.
- Whisper è meno reattivo (batch, non streaming) → latenza +500ms su chunk fallback (accettabile solo per recovery).

**File da modificare:**
- `/app/backend/voice_stream.py` — aggiungere `_whisper_recover(pcm_snapshot)` con emergentintegrations.

---

## 7. Bug secondario da fixare separatamente

### 7.1 iOS `OSStatus 560557684 (!act)` — sessione zombie

**⚠️ STATUS AGGIORNATO 2026-07-23 v60.4 — MITIGATO PER CAMBIO ARCHITETTURALE + TELEMETRIA ATTIVA**

**Storia del bug**:
Documentato originariamente nel percorso Deepgram legacy (`voiceStream.ts`), dove
il ciclo chunk N → chunk N+1 (ogni ~2-3s) esponeva ripetutamente la AudioSession
iOS a race condition durante `prepareToRecordAsync()`. Log tipico:
`[KODA_STREAM_CLIENT] chunk #2 pre-prepare refresh failed: OSStatus 560557684`.
Nel caso estremo, iOS lasciava la sessione zombie fino a 3 minuti finché
l'utente non chiudeva e riapriva l'app.

**Perché ora non è più P0**:
Il passaggio a Fase B (client_apple, `voiceClientStt.ts`) ha eliminato per
architettura il trigger dominante. `ExpoSpeechRecognitionModule` (wrapper
SFSpeechRecognizer) usa UNA sola sessione continua per turno — non c'è più
il ciclo prepare/stop ogni 2-3s. Superficie di attacco ridotta a:
- Route change mid-turno (BT connect/disconnect mentre parli)
- Interruzione sistema (Siri, chiamata)
- App backgrounded durante recording

**Cosa è stato fatto (v60.4, 2026-07-23)**:
Fix preventivo minimale in `voiceClientStt.ts`:
1. Su qualsiasi errore SFSpeechRecognizer non-benigno (esclusi `no-speech`
   e `aborted`), viene eseguito un cycle fire-and-forget di AudioSession:
   `setAudioModeAsync(allowsRecording:false)` → 300ms wait → `setAudioMode
   Async(allowsRecording:true)`. Costo zero percepito dall'utente (avviene
   DOPO che l'errore è già stato propagato).
2. Log tagged `[AUDIO_ZOMBIE_RECOVERY]` con codice errore e message → grep-
   per-grep dai log TestFlight per telemetria: se il bug si manifesta in
   produzione, sappiamo esattamente quante volte e con quali codici.
3. Nessuna modifica al retry loop (non c'è più — un singolo error chiude
   il turno immediatamente, l'utente ri-tap → nuovo turno da stato pulito).

**Test in furgone confermato (Fabio, 2026-07-23)**:
Sessione conversazione >4 minuti, decine di turni, argomento personale
complesso. Zero canned fallback, zero errori audio, memoria del contesto
perfetta. Il bug non si è manifestato.

**Criterio di chiusura definitiva**:
Se in 2 settimane di uso reale il tag `[AUDIO_ZOMBIE_RECOVERY]` non compare
mai nei log TestFlight → bug definitivamente morto per cambio architetturale,
il codice v60.4 può essere rimosso in favore di una versione più snella.
Se compare almeno una volta → analizzare il codice errore, valutare se
serve un cycle profilattico all'inizio di ogni `start()` (Opzione C).

**Priorità**: RISOLTO (via architettura + telemetria attiva). Nessun blocco per lancio.

---

## 8. Timeline realistica (post-sblocco pipeline)

| Milestone | Effort | Dipendenze |
|---|---|---|
| M0: Sblocco pipeline EAS Emergent | ??? | Support ticket `#57f6b0db` |
| M1: Verifica Fase A.1 (plugin applicato) | 1h | M0 |
| M2: Implementazione Fase A.2 + A.3 | 4h | M0 |
| M3: Build EAS + test furgone/bagno Fase A | 1 giorno | M2 |
| **DECISION POINT: Fase A sufficiente?** | — | M3 |
| M4: Fase B (se serve) | 3-4 giorni | M3 |
| M5: Fase C (se serve) | 1 giorno | M4 |

**Tempo totale se Fase A basta:** ~2 giorni post-sblocco pipeline.
**Tempo totale se serve Fase B:** ~1 settimana post-sblocco pipeline.

---

## 9. Cosa NON fare

- ❌ **NON** rimuovere il PCM gain al backend prima di aver testato Fase A. È già stato revertato — lasciare `voice_stream.py v63.6`.
- ❌ **NON** attivare `voiceChat` runtime da JS (non funziona — `expo-audio` non espone API).
- ❌ **NON** aumentare bitrate AAC prima di verificare fix Strato 1.
- ❌ **NON** modificare architettura WebSocket / streaming — funziona.
- ❌ **NON** modificare frontend/backend fino a sblocco pipeline (perché non arriva al device).

---

## 10. Riferimenti tecnici

- Apple: [Voice Processing IO Unit](https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_voiceprocessingio)
- Apple: [AVAudioSession.Mode.voiceChat](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode/1616455-voicechat)
- Apple: [SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- Apple: [Voice Isolation on iOS](https://support.apple.com/guide/iphone/mic-modes-iphb71f9b898/ios)
- `expo-speech-recognition`: https://github.com/jamsch/expo-speech-recognition
- Deepgram Nova-2 noise handling: https://developers.deepgram.com/docs/models-overview
- OpenAI Whisper-1: https://platform.openai.com/docs/guides/speech-to-text
- Config plugin corrente: `/app/frontend/plugins/withExpoAudioVoiceProcessing.js`
- Case Emergent Support: `/app/memory/CASE_57f6b0db_evidence.md`

---

## 11. Log delle decisioni

| Data | Decisione | Motivo |
|---|---|---|
| 2026-07-20 | Approvato piano 3-fasi, priorità Fase A | Utente vuole risultato, non tecnologia. Fase A ha ROI massimo. |
| 2026-07-20 | Nessuna modifica al codice ora | Pipeline EAS bloccata — cambi non arrivano al device. |
| 2026-07-20 | Fase B/C solo se Fase A insufficiente | Minimizzare superficie di rischio pre-lancio. |
| 2026-07-20 | PCM gain resta OFF (voice_stream.py v63.6) | Risolto solo "devo urlare", NON il problema di fondo. |
| 2026-07-20 (update PM) | ⚠️ **Correzione stato**: audio NON risolto | Test mattutino conferma: Koda continua a non sentire. Il test di ieri sera era condizione fortunata, non risoluzione. |
| 2026-07-20 (update PM) | Valutare Fase B (Speech Framework Apple) come primo intervento | Se il rumore rende Deepgram inutilizzabile anche con `.voiceChat` attivo, la soluzione più affidabile è STT on-device Apple. Utente ha esplicitamente chiesto di considerarlo. |
| 2026-07-20 (update PM) | Zero modifiche fino a sblocco pipeline | Confermato dall'utente. Attendere risposta support@emergent.sh. |
