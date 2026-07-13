# Koda OTA Debug — Context Pack for AI Assist

**Data:** 2026-07-13
**Situazione:** L'utente Fabio ha una build iOS EAS (v56, distribuita ad-hoc) installata sul suo iPhone che NON riceve gli update JavaScript pubblicati via EAS Update. Vogliamo capire perché e trovare una soluzione utilizzabile solo da iPhone (utente non ha Mac/PC).

---

## 1. Stack tecnico

- **App**: React Native / Expo mobile app
- **Backend**: FastAPI su Emergent (`https://app-finder-408.emergent.host`)
- **JS Engine**: Hermes (dalla build v56)
- **Config Plugin nativo**: `plugins/withExpoAudioVoiceProcessing.js` (patcha `AudioModule.swift` per attivare `AVAudioSession.Mode.voiceChat`)
- **Auth**: Sign in with Apple + Emergent proxy
- **Voice**: Deepgram STT (WS) + ElevenLabs TTS (WS via backend)

## 2. Config attuale (frontend/app.json)

```json
{
  "name": "Koda",
  "slug": "lamico-fraterno",
  "version": "1.0.112",
  "runtimeVersion": { "policy": "appVersion" },
  "projectId": "92cf0b6f-ee99-4fbe-8562-10cfc8a786de",
  "updates": {
    "url": "https://u.expo.dev/92cf0b6f-ee99-4fbe-8562-10cfc8a786de"
  }
}
```

## 3. Config EAS profiles (frontend/eas.json)

```json
{
  "development": {
    "channel": "development",
    "env_backend": "https://app-finder-408.preview.emergentagent.com"
  },
  "preview": {
    "channel": "preview",
    "env_backend": "https://koda-backend-production-4a34.up.railway.app"
  },
  "production": {
    "channel": "preview",   // <-- STESSO channel di preview!
    "env_backend": "https://koda-backend-production-4a34.up.railway.app"
  },
  "preview-android": {
    "channel": "preview",
    "env_backend": "https://koda-backend-production-4a34.up.railway.app"
  }
}
```

`cli.appVersionSource: "remote"`

## 4. Build v56 (installata su iPhone di Fabio)

- Distribuita ad-hoc (non App Store)
- App version mostrata in-app: `Koda v1.0.112`
- Bundle JS mostrato in Impostazioni: `bundle 2026-07-08 v1.1.0+46`
- **Non sappiamo con certezza quale channel EAS Update fosse embedded al build time** — probabilmente `preview` o `production` (che punta a preview) — ma non abbiamo modo di verificare senza rifare build o inspecting binary
- **Non sappiamo con certezza quale runtimeVersion abbia** — al momento della build v56 il repo poteva avere `runtimeVersion: { policy: "appVersion" }` (dinamico → 1.0.112) OPPURE `runtimeVersion: "1.1.0"` fisso. Git history mostra ENTRAMBI in commit successivi.

## 5. Tentativi fatti (in ordine)

### Tentativo 1
- Config repo: `runtimeVersion: "1.1.0"` fisso, `version: "1.1.0"`
- Pubblicato `eas update --channel preview` via GitHub Actions ✅ successo
- Verifica curl con `expo-runtime-version: 1.1.0` + `expo-channel-name: preview` → HTTP 200, manifest riceve `runtimeVersion: "1.1.0"`, `branchName: "preview"`
- **iPhone dopo 2 force-quit: bundle ancora `+46`, NON si aggiorna**

### Tentativo 2
- Stesso setup, provato ANCHE canali `production` e `development`
- Entrambi 404 (nessun update pubblicato lì)
- Poi pubblicato update anche su questi canali (workflow multi-channel)
- **iPhone dopo 2 force-quit: bundle ancora `+46`**

### Tentativo 3 (fix runtimeVersion — CURRENT STATE)
- Cambiato repo: `version: "1.0.112"`, `runtimeVersion: { policy: "appVersion" }`
- Ipotesi: build v56 aveva runtimeVersion 1.0.112 (perché app version era 1.0.112 e policy=appVersion)
- Modifica appena committata, non ancora pubblicata via `eas update`
- Ancora da verificare

## 6. Verifiche curl eseguite

```bash
# runtime 1.1.0 - channel preview → HTTP 200 (manifest esiste)
curl -H "expo-runtime-version: 1.1.0" \
     -H "expo-platform: ios" \
     -H "expo-channel-name: preview" \
     -H "expo-protocol-version: 1" \
     -H "expo-api-version: 1" \
     "https://u.expo.dev/92cf0b6f-ee99-4fbe-8562-10cfc8a786de"
# → HTTP 200, manifest valid, runtimeVersion "1.1.0"

# runtime 1.0.112 - channel preview → HTTP 404 (nessun update per questo rt)
curl (stessa cosa con expo-runtime-version: 1.0.112)
# → HTTP 404
```

## 7. Ipotesi che restano da testare

**A) La build v56 ha runtimeVersion 1.0.112 → serve pubblicare update con quella runtime**
- Fix applicato nel repo (app.json), ma workflow non ancora ri-triggerato dopo la modifica
- Da fare: `eas update --channel preview` con nuova config

**B) Expo Updates NON è attivato/configurato correttamente nel binary v56**
- Come verificare senza device access? Possibili sintomi: se `Updates.channel` runtime restituisce null/undefined, se `Updates.isEmbeddedLaunch === true`, ecc.
- Non abbiamo modo di leggere questi valori senza aggiornare l'app prima (circolare)

**C) Il binary v56 è "sganciato" dal projectId EAS Update corrente**
- Es. la build v56 aveva un projectId diverso in app.json embedded al build time
- Improbabile ma possibile

**D) Sistema di caching iOS aggressive**
- Fabio potrebbe aver bisogno di force-quit 3-4 volte, non 2

**E) La build v56 è una versione EAS Simulator/Development che ignora updates**
- Possibile se buildata con `--profile development` che tipicamente ha `Updates.isEnabled = false`
- MA app version 1.0.112 non è tipica di development build (di solito hanno label "dev")

## 8. Limiti dell'ambiente

- **Utente Fabio**: usa SOLO iPhone. Nessun Mac/PC. Nessun terminale.
- **Pod Emergent (l'ambiente dove opera l'agente AI)**: ARM64 Linux. Hermes distribuisce binari precompilati solo per `linux-x86_64`, `osx-x86_64`, `win-x86_64`. **Non possiamo compilare bundle Hermes localmente** dal pod. Serve GitHub Actions (Ubuntu x86_64) per `eas update`.
- **Auth**: abbiamo EXPO_TOKEN dell'utente valido (autenticato come `fabiod.labor` / `dangella.fabio@gmail.com`).
- **GitHub**: repo `github.com/dangellafabio-byte/koda-backend`, `EXPO_TOKEN` è già in GitHub Secrets, workflow `.github/workflows/eas-update.yml` esiste e funziona (5 run completati verdi finora).
- **Trigger workflow**: attualmente configurato con `on: push` + path filter `frontend/**` per auto-trigger + `workflow_dispatch` manuale.

## 9. Cosa ci serve capire

1. **Il vero blocker**: è runtimeVersion mismatch (ipotesi A) o è qualcosa di più profondo (B, C)?
2. **Come diagnosticare da iPhone**: c'è un modo di leggere `Updates.channel`, `Updates.runtimeVersion`, `Updates.isEmbeddedLaunch` dell'app v56 SENZA prima riuscire ad aggiornarla? (Es. deep link, custom URL scheme, ecc.)
3. **Se ipotesi A confermata**: dopo il ri-run del workflow con nuova config (runtimeVersion policy=appVersion → 1.0.112), dovremmo vedere l'update arrivare. Ma se non arriva, prossimi step?
4. **Piano B non-build**: esiste un modo di far scaricare l'update anche con runtimeVersion diversa? Es. Expo docs menzionano `runtimeVersion.policy: "fingerprint"` — potrebbe aiutare?
5. **Ultimissima ratio**: se nessuna soluzione OTA funziona, l'unica strada è nuova build EAS. In quel caso servirebbe una config di build "future-proof" che garantisca OTA per SEMPRE senza problemi di runtime mismatch.

## 10. File chiave del repo

- `frontend/app.json` — appena modificato (v1.0.112 + policy appVersion)
- `frontend/eas.json` — 4 profili, note: production usa channel "preview"
- `.github/workflows/eas-update.yml` — 5 run completati con successo su GitHub Actions
- `frontend/lib/buildInfo.ts` — costante `BUILD_VERSION` mostrata in Impostazioni per verifica update: attualmente `"2026-07-13 v1.1.0+58 (OTA)"` (aggiornata anche se OTA non arriva)

## 11. Log EAS Update recenti

Il canale `preview` ha ricevuto almeno 1 update con successo (HTTP 200 verificato). Il canale `production` e `development` sono ora 404 dopo `runtimeVersion` cambio (perché non ancora ripubblicati con la nuova runtimeVersion).

---

## Domanda specifica per il consulente AI

Dato tutto il context sopra, qual è la sequenza di comandi/azioni ESATTA (con tap iPhone precisi) per:
1. Rendere la build v56 iOS installata compatibile con OTA update
2. Senza rifare una nuova build EAS (costo crediti)
3. Solo da iPhone (Safari + GitHub Actions app-friendly)

Se non è tecnicamente possibile, spiegare **perché** e quali sono le alternative più economiche (in crediti EAS) per garantire OTA da qui in avanti.
