# Sentry Integration Plan — Koda / L'Amico Fraterno

**Data creazione**: 2026-07-26
**Stato**: ✅ **CODICE IMPLEMENTATO** — in attesa di credenziali Sentry per attivazione live
**Decisioni utente**: confermate 26/07/2026

## Decisioni prese

| Punto | Decisione |
|---|---|
| Provider | **Sentry** (NON Crashlytics) |
| Data residency | **EU — Frankfurt** |
| Session Replay | **NO** al lancio — RICONSIDERARE dopo 2-4 settimane |
| Bottone "Segnala un problema" in Impostazioni | **RESTA** — complementare (feedback qualitativo utente) |

## ✅ Implementazione COMPLETATA (2026-07-26)

### Frontend
- ✅ `@sentry/react-native@7.2.0` installato via `yarn expo install`
- ✅ `metro.config.js` aggiornato con `getSentryExpoConfig` (Debug IDs)
- ✅ `app.json` plugin `@sentry/react-native/expo` configurato
- ✅ `lib/sentry.ts` — init + helpers (`setSentryUser`, `updateSentrySessionTags`, `captureKodaError`)
- ✅ `lib/sentryPrivacy.ts` — scrubbing PII aggressive per `beforeSend` + `beforeBreadcrumb`
- ✅ `app/_layout.tsx` — `initSentry()` chiamato pre-render + `Sentry.wrap(RootLayout)`

### Backend
- ✅ `sentry-sdk==2.66.1` installato + aggiunto a `requirements.txt`
- ✅ `backend/observability.py` — init + scrubbing PII (`_before_send`, `capture_koda_exception`)
- ✅ `backend/server.py` — `init_sentry()` chiamato subito dopo `load_dotenv()`

### Feature attive
- 📊 Errori: sample rate **100%**
- 📈 Performance: sample rate **20%**
- 🔒 Privacy: `beforeSend` + `beforeBreadcrumb` scrubbano transcript, TTS, testo utente
- 🏷️ Tag automatici: `platform`, `app_version`, `build_number`, `expo_go`, `stt_engine`, `audio_route`, `subscription_tier`, `hands_free`
- 🚫 Session Replay: **NON attivo** (privacy)
- 🌐 Region: EU (enforced dal DSN dell'org EU quando l'utente creerà l'account)

## 🔑 Credenziali richieste all'utente Fabio

### Setup account Sentry (una volta sola)

1. Andare su **sentry.io** → **Sign up** (usa email che vuoi tenere separata dai personali)
2. **CRITICO — Al momento della creazione dell'organizzazione, selezionare "European Union (EU)" nel dropdown "Data Storage Location"**.
   - Sentry NON permette di cambiare region dopo creazione — se scegli US per errore, devi rifare da zero.
3. Nome organizzazione consigliato: `lamico-fraterno` (o simile — sarà l'`org slug`)
4. Creare **2 progetti**:
   - Nome: `koda-mobile` → Piattaforma: **React Native**
   - Nome: `koda-backend` → Piattaforma: **Python** (poi seleziona FastAPI)

### Credenziali da fornirmi

Dopo aver creato l'account:

1. **DSN Frontend (`koda-mobile`)**
   - Percorso: Settings → Projects → `koda-mobile` → Client Keys (DSN)
   - Formato: `https://<key>@o<orgId>.ingest.de.sentry.io/<projectId>`
   - Uso: env var `EXPO_PUBLIC_SENTRY_DSN` in `.env` frontend
2. **DSN Backend (`koda-backend`)**
   - Percorso: Settings → Projects → `koda-backend` → Client Keys (DSN)
   - Uso: env var `SENTRY_DSN_BACKEND` su Railway (Variables)
3. **Auth Token** (per source map upload)
   - Percorso: User Settings → Auth Tokens → Create New Token
   - Scopes richiesti: `project:releases`, `project:read`, `org:read`
   - Uso: EAS secret `SENTRY_AUTH_TOKEN` (impostato una volta su Expo dashboard)
   - ⚠️ **MAI committare in git** — solo EAS secret
4. **Org slug** — es. `lamico-fraterno` (visibile nell'URL Sentry: `sentry.io/organizations/<slug>/`)
5. **Project slug frontend** — es. `koda-mobile`
6. **Project slug backend** — es. `koda-backend`

## 📋 Steps per attivazione (quando Fabio fornisce credenziali)

1. Fabio mi passa i 4 valori (2 DSN + auth token + eventualmente org/project slug se diversi dai default)
2. Io:
   - Aggiungo `EXPO_PUBLIC_SENTRY_DSN=<value>` a `frontend/.env`
   - Aggiorno `app.json` con org/project slug corretti (se diversi dai placeholder)
   - Istruisco Fabio ad aggiungere:
     - `SENTRY_DSN_BACKEND` come variable su Railway
     - `SENTRY_AUTH_TOKEN` come EAS secret via Expo dashboard
3. Fabio fa **Redeploy backend** su Railway + **Publish Redeploy** + **Genera build iOS/Android**
4. Verifica: bottone "Test Sentry" in dev genera evento visibile nel dashboard entro 30s

## 🧪 Come testare che Sentry funzioni

Ho aggiunto un helper `triggerSentryTestError()` in `lib/sentry.ts`. Per usarlo:
- Aggiungerlo temporaneamente a un bottone nella schermata dev/admin
- Premere → deve apparire in dashboard Sentry entro 30 secondi
- Verificare stack trace leggibile (grazie ai source maps con Debug IDs)

## 🔒 Privacy: cosa NON arriverà mai a Sentry

Le funzioni di scrubbing rimuovono automaticamente:
- **Transcript STT** (chiavi contenenti `transcript`, `stt_text`, `utterance`)
- **Contenuti TTS** (chiavi contenenti `tts_content`, `tts_text`, `sentence`)
- **Testo utente** (`user_text`, `user_input`, `prompt`, `content`, `koda_reply`)
- **Dialoghi** (`dialogue`, `conversation`, `message_text`)
- **PII utente** (`email`, `username`, `name`, `ip_address`, `phone`, `address`)
- **Stringhe > 200 caratteri** in qualsiasi campo (safety cap)
- **Categorie breadcrumb intere**: `stt.*`, `tts.*`, `chat.*`, `conversation.*`, `koda_diag.*`

Se il scrubber stesso fallisce → l'evento viene **droppato** (fail-closed per privacy).

## 📊 Cosa vedrà Fabio nel dashboard Sentry

Esempio: bug "mic block al 2° turno Huawei" catturerà automaticamente:
- **Titolo**: `android_mic_silent_fail` in `voiceClientStt.ts:642`
- **User**: `abc123def` (hash), `subscription_tier=free`, `hands_free=true`
- **Device**: iOS 17.4 / Android 13, `platform=ios|android`
- **App**: v1.0.119 (build 13)
- **Tag session**: `stt_engine=apple_sfspeechrecognizer`, `audio_route=builtin`
- **Last 30 breadcrumbs** (con timestamp), MA con transcript sostituiti da `[scrubbed]`
- **Stack trace JS** (grazie a source maps) — frame esatto dove è partito l'errore
- **Aggregazione**: "questo errore ha colpito 47 utenti / 3 device diversi"

## 🔮 Prossimi step opzionali (futuro)

1. **Session Replay** (post-lancio): SDK aggiuntivo con `maskAllText: true`, sample <5%
2. **Custom performance transactions**: `stt.turn`, `tts.first_audio` per misurare latenza
3. **Aggancio diagLogger → Sentry breadcrumbs** (già preparato architettuvra — basta aggiungere `Sentry.addBreadcrumb` in `diagLogger.ts`)
4. **User Feedback widget** integrato per "Segnala un problema" → arriva su Sentry con contesto crash
