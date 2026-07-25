# Sentry Integration Plan — Koda / L'Amico Fraterno

**Data creazione**: 2026-07-26
**Stato**: PLANNED (in attesa di completamento validazione fix Android v64.0)
**Decisioni utente**: confermate 26/07/2026

## Decisioni prese

| Punto | Decisione |
|---|---|
| Provider | **Sentry** (NON Crashlytics) |
| Data residency | **EU — Frankfurt** |
| Session Replay | **NO** al lancio — RICONSIDERARE più avanti dopo i primi bug reali |
| Bottone "Segnala un problema" in Impostazioni | **RESTA** — complementare (feedback qualitativo utente) |
| Timing | Integrare **DOPO** la validazione della build Android v64.0 sul device, così le eventuali regressioni sono catturate automaticamente col nuovo sistema fin da subito |

## Reminder importante

⚠️ **Session Replay**: da rivalutare dopo 2-4 settimane di raccolta bug reali via Sentry.
Se emergono bug UI difficili da riprodurre solo dai breadcrumb, attivare Session Replay
(scrubbing testo/audio utente obbligatorio per privacy).

## Piano implementazione (~2h)

### Fase 1 — Setup base (30 min)
- [ ] `yarn expo install @sentry/react-native`
- [ ] Config wizard Expo → generazione `sentry.properties` e chiavi
- [ ] Chiedere utente:
  - `SENTRY_DSN` (public, da mettere in `.env` come `EXPO_PUBLIC_SENTRY_DSN`)
  - `SENTRY_AUTH_TOKEN` (per source map upload, va in build env)
  - Nome progetto Sentry (es. `koda-mobile`)
- [ ] Init in `app/_layout.tsx` con region EU: `region: "de"` o URL Frankfurt
- [ ] Test error boundary + crash simulato → verificare arrivo dashboard

### Fase 2 — Contesto Koda (45 min)
- [ ] Agganciare `lib/diagLogger.ts` a `Sentry.addBreadcrumb()`:
  ```ts
  // Ogni push nel ring buffer diventa anche un breadcrumb Sentry
  Sentry.addBreadcrumb({
    category: "koda_diag",
    message: line,
    level: "info",
    timestamp: t / 1000,
  });
  ```
- [ ] User context (anonimizzato):
  ```ts
  Sentry.setUser({
    id: hashedProfileId,  // NON email — hash SHA256 del profile.id
    subscription_tier: profile.subscription_tier,
  });
  ```
- [ ] Tag automatici:
  - `platform`: iOS/Android
  - `device_model`: da `expo-device` (es. "Honor 90", "iPhone 13 Pro")
  - `os_version`, `app_version`, `build_number`
  - `stt_engine`: `apple_sfspeechrecognizer` | `google_speechrecognizer` | `deepgram`
  - `audio_route`: bluetooth/wired/builtin
  - `hands_free`: true/false
- [ ] Scrubbing PII in `beforeBreadcrumb`:
  - Rimuovere qualsiasi `text="..."` o `transcript="..."` di STT
  - Rimuovere qualsiasi contenuto TTS
  - Regex sanitizer: `.replace(/text="[^"]*"/g, 'text="[REDACTED]"')`

### Fase 3 — Errori business (30 min)
- [ ] `Sentry.captureException` in:
  - `lib/voiceStream.ts` — WS failure / pipeline error
  - `lib/voiceClientStt.ts` — watchdog `android_mic_silent_fail`
  - `lib/speech.ts` — TTS playback failure
  - `lib/api.ts` — errori HTTP critici (auth, freemium)
- [ ] Custom tag per filtrare rapidamente:
  - `is_huawei_honor`: derivato da device_model
  - `ws_failure_count`: da `wsFailureCountRef`
  - `close_session_pause`: bool
- [ ] Performance transactions:
  - `stt.turn` (start → speechstart)
  - `tts.first_audio` (dispatch → onAudioStart)

### Fase 4 — Privacy & config (15 min)
- [ ] `beforeSend` hook globale:
  ```ts
  beforeSend(event) {
    // Rimuovi qualsiasi transcript utente o TTS
    if (event.extra?.transcript) delete event.extra.transcript;
    // Scrubbing breadcrumbs
    event.breadcrumbs = event.breadcrumbs?.map(scrubBreadcrumb);
    return event;
  }
  ```
- [ ] Sample rate:
  - Errors: 100%
  - Performance: 20% (per non consumare il free tier)
- [ ] Environment tag: `production` / `development`
- [ ] Release tag: pull da `app.json` version + build number
- [ ] Verifica `.gitignore` include `sentry.properties` (contiene auth token)

## Chiavi/Credenziali richieste all'utente

1. **DSN pubblico** (safe in code): `EXPO_PUBLIC_SENTRY_DSN`
   → Sentry dashboard → Settings → Projects → [koda] → Client Keys (DSN)
2. **Auth Token** (SECRET, solo build env): `SENTRY_AUTH_TOKEN`
   → Sentry dashboard → Settings → Account → API → Auth Tokens
   → Scope: `project:releases`, `project:read`, `org:read`
3. **Organization slug** + **Project slug** (per source map upload)

## Preview: cosa vedrà l'utente Fabio nel dashboard

Bug tipico "mic block al 2° turno Huawei" catturerà automaticamente:
- **Titolo**: `android_mic_silent_fail` in `voiceClientStt.ts:642`
- **User**: `abc123def` (hash), tier=free, hands_free=true
- **Device**: Honor 90 Lite, Android 13, EMUI 13
- **App**: v64.0.0 (build 143)
- **STT engine**: google_speechrecognizer
- **Audio route**: builtin
- **Last 30 breadcrumbs** (con timestamp):
  - `[KODA_CLIENT_STT] speechstart` (turn 1)
  - `[KODA_CLIENT_STT] result FINAL text="[REDACTED]"`
  - `[KODA_CLIENT_STT] android audio focus cycle done in 380ms`
  - `[KODA_HF_LOOP] firing startTalkInternal(true)`
  - `[KODA_CLIENT_STT] startRecognition lang=it-IT`
  - `[KODA_CLIENT_STT] ExpoSpeechRecognitionModule.start() OK`
  - `[KODA_CLIENT_STT] MIC_WATCHDOG_TIMEOUT — speechstart never received (5s)`
- **Stack trace** (JS): frame esatto dove è partito `onError`
- **Aggregazione**: "questo errore ha colpito 47 utenti / 3 device model diversi"

Vs oggi: uno screenshot sfocato e "il mic non funziona più dopo che ho parlato una volta". 🎯

## Note tecniche

- Sentry SDK funziona anche in Expo Go per test iniziali (limitato — solo JS errors).
  Per catturare crash nativi (iOS SIGSEGV, Android JNI) serve dev-build o production build.
- Session Replay quando arriveremo: SDK aggiuntivo `@sentry/react-native/replay`,
  MOLTO importante configurare `maskAllText: true` e `maskAllImages: true` PRIMA dell'attivazione
  (privacy: contenuti Koda sono spesso intimi).
