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
- Routing nel pipeline TTS reale (fast pipeline, WS streaming) NON ancora commutato su Inworld anche con pref="inworld": l'infrastruttura è pronta, l'attivazione effettiva aspetta le nuove chiavi + confronto audio con Fabio.
- Nessuna modifica al pricing / subscription.

### Credenziali
- Chiave Inworld attualmente presente in env (ma Fabio ha indicato che quella in Railway va rigenerata); EMERGENT_LLM_KEY rigenerata ma non ancora inserita su Railway; nuove chiavi ElevenLabs/Inworld non ancora create da Fabio. **Da collezionare via `secrets__secrets_request` SOLO quando Fabio darà il via libera.**

## Known issues / backlog
- POST `/api/voice/stream` 404 fallback (P2)
- Apple Auth HTTP 500 (P3)
- Banner avviso minuti 70/80/90/100% (P2)
- Email diretta "Segnala problema" via Resend (P3)
- Paywall hook RevenueCat (P3)
- Vento disponibile su Inworld (Phase 2, serve validazione voce maschile)
- Voiceprint biometric GDPR consent flow (Phase 2)
