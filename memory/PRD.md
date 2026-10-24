# Ollenya — Product Requirements (snapshot 2026-10)

## Current working item
**Re-integrate Inworld TTS alongside ElevenLabs with a user-visible "Voce di Ollenya" selector in Impostazioni** — ✅ IMPLEMENTED & TESTED (29/29 backend tests PASS).

### Scope implementato in questa sessione
1. **Backend modulare TTS providers**:
   - `backend/inworld_tts.py` — adapter puro, modello/voce/rate CONFIGURABILI via env (`INWORLD_MODEL_ID`, `INWORLD_VOICE_ID`, `INWORLD_RATE_PER_1M_CHARS_USD`, `INWORLD_DELIVERY_MODE`). `INWORLD_MODEL_LOCKED=false` di default: la telemetria segnala che il modello NON è ancora definitivo.
   - `backend/koda_tts_events.py` — telemetria TTS (collection `koda_tts_events`), privacy-by-design (mai testo, mai API key).
   - `backend/koda_tts_prefs.py` — preferenze user→(provider+voice) in `koda_tts_provider_prefs`, auth-bound.
   - `backend/koda_voice_catalog.py` — catalogo voci (Cielo/Vento) + mapping provider; Vento disponibile su Inworld SOLO se env `INWORLD_VOICE_VENTO` setato.
   - `backend/inworld_dispatcher.py` — orchestratore (streaming + non-streaming + telemetria). NIENTE fallback automatico ad ElevenLabs.
   - `backend/routes/tts_providers.py` — endpoint auth-bound:
     - `GET /api/tts/catalog` (pubblico)
     - `GET /api/tts/preferences` (auth)
     - `PUT /api/tts/preferences` (auth, PUT valida availability → 409 se voce non disponibile sul provider)
     - `DELETE /api/tts/preferences` (auth)
     - `GET /api/dev/inworld-tts-health` (DRY, no API call, no segreti esposti)

2. **Fix log token/credential redaction** (`backend/server.py` `_SensitiveQueryFilter`):
   - Maschera `*token=`, `*api_key=`, `*secret=`, `*password=` in querystring
   - Maschera `Bearer xxx` e `session_token=xxx` nei dump
   - Applicato a `uvicorn.access`, `uvicorn.error`, `uvicorn`, `fastapi` loggers
   - Fix log WS: `/api/voice/stream` non logga più l'email, solo uid[:8] mascherato.

3. **Frontend UI**:
   - `frontend/lib/ttsProviderClient.ts` — client (fetchCatalog, fetchPrefs, updatePrefs, resetPrefs, subscribePrefs, clearCache) con auth Bearer da `authToken`.
   - `frontend/components/VoiceOfOllenyaCard.tsx` — card UI "Voce di Ollenya" con selettore Provider + Voce. Voci non disponibili sul provider → DISABILITATE (opacity 0.45) con spiegazione. Nessuna selezione destinata a fallire: al cambio provider, se la voce corrente non è compatibile, scelta automatica di una voce disponibile.
   - `frontend/app/index.tsx` — card aggiunta in `settingsCards` (key=`voice_provider`) e in `OLLENYA_SETTINGS_ORDER` dopo "voice".

4. **500 minuti/mese** — invariato: il consumo si basa sulla DURATA EFFETTIVA dell'audio AI (via `_estimate_mp3_duration_seconds` o `estimate_mp3_duration_ms`), NON su stima dalla lunghezza testo. Nota nel footer della card UI.

5. **Testing**:
   - `backend/tests/test_inworld_tts_unit.py` (9 test), `test_koda_voice_catalog.py` (5 test). Testing agent ha aggiunto `test_tts_providers_integration.py` (15 test). **29/29 PASS**.

### Esplicite esclusioni dallo scope di questa fase (richiesta Fabio)
- Nessun consumo di API esterne (nessuna generazione audio reale).
- STT device NON toccato (no reattivazione Deepgram/Whisper).
- Verifica funzionamento audio reale su device → impossibile senza nuove chiavi ElevenLabs/Inworld.
- Nessuna modifica al pricing / subscription.

### Attivazione dispatcher nei percorsi vocali reali (fase 2026-10 completata)
Il dispatcher è ora **wired ai 3 percorsi TTS live**:
1. **WS `/api/voice/stream`** (hot pipeline fast): dopo l'LLM, prima di `_do_tts()` (ElevenLabs), check `_resolve_tts_pref_for_uid(current_user_id())`. Se provider=inworld → `_try_inworld_tts_bytes()`. In caso di errore (auth/timeout/voice unavailable) → log `[TTS_PROVIDER] inworld failed → chunk saltato (NO auto-fallback)`, `audio_bytes = b""`. **Nessuno switch silenzioso su ElevenLabs.**
2. **`POST/GET /api/tts/stream`**: stesso pattern; su errore Inworld → `HTTPException(503)` con detail diagnostico (`inworld_auth_missing`, `inworld_voice_unavailable`, `inworld_timeout`, …). Serve l'MP3 Inworld come StreamingResponse con header `X-TTS-Provider: inworld`.
3. **`POST /api/tts/prepare`**: stesso pattern; errore Inworld → 503, no fallback.

Nuovi helper in `server.py`:
- `_resolve_tts_pref_for_uid(uid)` → pref provider+voice_id con cache 60s.
- `_invalidate_tts_pref_cache(uid)` → scaricata su PUT/DELETE `/api/tts/preferences`.
- `_try_inworld_tts_bytes()` → wrapper che converte tutti i `InworldTTSError` in `RuntimeError` taggato.

### Accuratezza quota 500 min — fix bytes→ms (fase 2026-10 completata)
Prima: `_estimate_mp3_duration_seconds = len(bytes) / 16000.0` (assume CBR 128 kbps).
  - OK per ElevenLabs (`mp3_44100_128`): errore ≈ 0.1%.
  - **Grave sotto-conteggio per Inworld** se emette 64 kbps CBR (**-50%**) o VBR (**-64%**).

Ora: usa `koda_tts_events.estimate_mp3_duration_ms()` (parser frame-header MPEG1/2/2.5 Layer3, gestisce ID3, VBR, CBR arbitrario). Fallback alla vecchia formula CBR 128 solo se parsing fallisce completamente. Verificato con ffmpeg contro VBR q7 → errore nuovo parser < 5%, vecchio formula > 20%.

**Nessun doppio conteggio** garantito perché:
- Il counter viene incrementato DOPO che il blob MP3 è ricevuto completo per il chunk corrente (riga 16031 `_estimate_mp3_duration_seconds(audio_bytes)`), prima di qualsiasi retry.
- `_consume_paid_seconds` / `_increment_trial_seconds` chiamati UNA volta per chunk, con la durata già calcolata. Interruzioni mid-stream → l'ultimo chunk è stato scartato → nessun addebito.
- Switch provider mid-turn: non supportato nel pipeline attuale (pref letta una volta per chunk, con cache 60s). Pref change in corso di turno NON cambia il provider del chunk corrente.

### Testing
- Suite backend originale **29/29 PASS** (`test_inworld_tts_unit.py`, `test_koda_voice_catalog.py`, `test_tts_providers_integration.py`).
- Nuove suite **10/10 PASS**:
  - `test_mp3_duration_accuracy.py` (3 test): parser frame vs CBR su MP3 reali + VBR transcodificato.
  - `test_inworld_dispatcher_wiring.py` (7 test): resolver pref, cache invalidation, no-fallback contract, catalog endpoint, health endpoint.
- Frontend testato tramite `testing_agent`: catalog carica, 4 testID presenti, provider/voice toggle funziona, nessun crash. Nota: `Alert.alert` è no-op su react-native-web (cosmetic preview-only); su iOS build nativo funziona normalmente.

### Passaggi necessari su Railway e per build native iOS/Android
**Railway (backend) — nuovo deploy richiesto per:**
- Caricare `INWORLD_API_KEY`, `ELEVENLABS_API_KEY` nuove (segrete).
- (Opzionale) `INWORLD_VOICE_CIELO`, `INWORLD_VOICE_VENTO`, `INWORLD_DELIVERY_CIELO`, `INWORLD_DELIVERY_VENTO`, `INWORLD_MODEL_ID`, `INWORLD_LANGUAGE`, `INWORLD_SPEAKING_RATE`, `INWORLD_RATE_PER_1M_CHARS_USD`, `INWORLD_MODEL_LOCKED=true` quando il modello è validato.
- Il codice applicativo è già live su `main` branch pronto al deploy. Nessuna modifica app.json/EAS richiesta.

**Build native iOS/Android — NON richiesto:**
- La UI "Voce di Ollenya" usa solo `fetch` HTTP (nessun native module nuovo).
- Nessuna nuova entitlement/permission.
- Il routing TTS avviene lato server: una volta deployato Railway, le build iOS/Android correnti (TestFlight) vedranno subito la nuova card.

### Credenziali
- Chiave Inworld attualmente presente in env preview (ma Fabio ha indicato che quella in Railway va rigenerata); EMERGENT_LLM_KEY rigenerata ma non ancora inserita su Railway; nuove chiavi ElevenLabs/Inworld non ancora create da Fabio. **Da collezionare via `secrets__secrets_request` SOLO quando Fabio darà il via libera.**

### Verifica funzionamento audio reale — IMPOSSIBILE senza nuove credenziali
Il wiring è completo e tutti i test automatici passano, MA nessun agente ha testato audio reale generato da ElevenLabs/Inworld in questa fase (le key sono revocate per policy). Fabio potrà validare l'audio solo dopo:
1. Aggiunta nuove key su Railway (via `secrets__secrets_request` quando autorizzato).
2. Deploy Railway.
3. Test su build iOS attuale (TestFlight) con la card UI già visibile.

## Known issues / backlog
- POST `/api/voice/stream` 404 fallback (P2)
- Apple Auth HTTP 500 (P3)
- Banner avviso minuti 70/80/90/100% (P2)
- Email diretta "Segnala problema" via Resend (P3)
- Paywall hook RevenueCat (P3)
- Vento disponibile su Inworld (Phase 2, serve validazione voce maschile)
- Voiceprint biometric GDPR consent flow (Phase 2)
- `Alert.alert` no-op su web preview (non impatta iOS native, solo preview UX)
