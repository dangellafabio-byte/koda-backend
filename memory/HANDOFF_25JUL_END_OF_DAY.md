# Handoff fine giornata 25 luglio 2026 — progetto Koda

## 📌 Contesto
Fabio (dangella.fabio@gmail.com) — sviluppo Koda app Expo, freemium
voice-first AI companion. Lingua italiana obbligatoria.

## ✅ Fix nel codice (commit fino a 36e9c9cf)

### v63.5 (commit 62060d83)
- Fix A: `stopRequested` post-openWS ora propaga onError invece di
  finto "done" → blocca cascata sessioni STT
- Fix B: `micReallyActiveRef` gate — tap orb durante startup viene
  ignorato finché mic non è realmente attivo

### v63.7 / v63.7.1 (commit 66c7b3e9 / de467fec)
- GPS cache-first (parità iOS/Android): getLastKnownPositionAsync
  prima di getCurrentPositionAsync. Timeout 3s. Elimina blocco 26s
  su MIUI/HyperOS
- fetchLocationOnce (boot) allineato con stessa strategia

### v63.8 (commit b109a913)
- Fix C1: dopo dispatchFinalToBackend, cycle AudioFocus (deactivate
  → wait 150ms → mode playback → reactivate) SOLO Android
- Risolve TTS muto post-STT su Xiaomi/MIUI

### v63.9 (commit e457fcae + fbe27b31 bump + 36e9c9cf fix syntax)
- Fix C2: cycle AudioFocus PRIMA di STT start (simmetrico a C1)
  → pulisce residui TTS intro login
- Test diagnostico breath: `KODA_BREATH_DIAGNOSTIC_DISABLE_ANDROID`
  disabilita breath solo su Android per verificare se causa flash
  schermo Honor/Huawei
- Bump versione 1.0.113→1.0.114, versionCode 7→8
- **36e9c9cf**: fix critico SyntaxError — dispatchFinalToBackend è
  ora async, aggiunto .catch() ai 3 chiamanti fire-and-forget

### Canary attuale: `build-v63.9-audio-and-breath-diag`

## ⏳ In attesa dopo il build APK v1.0.114

### 1. Test audio Fix C1 + C2 (Priorità 1)
- Voce di Koda audibile dopo aver parlato all'orb
- Nessuna cascata no-speech
- Log da cercare:
  * `pre-STT focus release step1 (deactivate) ok` (Fix C2)
  * `pre-STT focus pre-cycle done in ~100ms (Fix C2 v63.9)` (Fix C2)
  * `audio focus release step1 (deactivate) ok` (Fix C1)
  * `android audio focus cycle done in ~200ms (Fix C1 v63.8)` (Fix C1)

### 2. Test bagliore breath disabilitato (Priorità 2)
- Log al boot: `[EclipseOrb] BREATH DISABLED (test diagnostico v63.9)`
- Se flash Honor/Huawei sparisce → breath confermato colpevole
- SOLUZIONE TECNICA DA TROVARE (l'utente NON vuole modificare animazione):
  * Opzione tecnica: FLAG_HARDWARE_ACCELERATED_ANIMATIONS_BOOST
    a livello WindowManager Android
  * Alternativa: cambio da scale animation a opacity (potrebbe
    non triggerare DisplayEngine HDR adaptive)
  * Alternativa 3: setLayerType(LAYER_TYPE_HARDWARE) sulla View
    dell'orb per evitare che sia interpretato come contenuto HDR
- Da valutare dopo conferma causa

### 3. Paywall RevenueCat (Priorità 3, BLOCCATO ma sbloccabile)
- Fabio ha ottenuto le 6 credenziali RevenueCat con Claude in
  parallelo il 25/07
- Documento credenziali: cercare in /app/memory/ file relativi
  a RevenueCat/paywall inviati da Fabio nella prossima chat
- Da implementare:
  * app/paywall.tsx (UI upsell freemium)
  * Integrazione RevenueCat SDK (offerings, purchase, restore)
  * Collegamento a /api/subscriptions/sync
  * Webhook validation lato backend Railway
- Preparato in backend/server.py: skeleton webhook + endpoint sync

## 🛑 Regole comportamento (imposte dall'utente)

1. **NIENTE messaggi promozionali**. Solo comunicazione tecnica.
   L'utente ha esplicitamente segnalato più volte.
2. **NIENTE build a raffica**: un solo build APK per volta, testato
   e verificato prima di procedere. L'utente non tollera cicli di
   build/test/build/test senza risultato.
3. **PRIMA di committare fix critici**: verificare bundle Metro con
   `curl localhost:3000` — HTTP=200. Il solo lint non basta (missed
   errore async in Fix C1 v63.8).
4. **Publish → Redeploy** aggiorna solo il preview URL/OTA, NON
   l'APK. **Build Android → Genera nuova build** genera nuovo APK.
   Sono operazioni distinte.
5. **Non toccare l'animazione breath in modo permanente**: soluzione
   tecnica per bagliore deve mantenere animazione identica a iOS.
6. **Support Emergent**: se serve, l'utente NON contatta più il
   supporto. File pronto in /app/memory/EMERGENT_BUILD_TICKET.md
   con testo email precompilato.

## 📁 File importanti
- `/app/frontend/lib/voiceClientStt.ts` — voice STT client (Fix A/B/C1/C2)
- `/app/frontend/lib/speech.ts` — voice stream converse + GPS cache-first
- `/app/frontend/lib/geolocation.ts` — GPS strategy
- `/app/frontend/components/EclipseOrb.tsx` — orb + breath (test diag)
- `/app/frontend/app/index.tsx` — canary + micGate + onBigButton
- `/app/frontend/app.json` — version 1.0.114
- `/app/memory/EMERGENT_BUILD_TICKET.md` — email support pronta

## 🎯 Prossimo passo concreto
Aspettare Fabio con esito Redeploy + Build APK v1.0.114.
Se v1.0.114 installato + canary v63.9 conferma → test audio + bagliore.
Poi passiamo a paywall RevenueCat.
