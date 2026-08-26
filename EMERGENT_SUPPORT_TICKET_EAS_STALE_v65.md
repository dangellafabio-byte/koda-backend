# TICKET EMERGENT SUPPORT — EAS Build genera APK STALE (v64.17 al posto di v65.0)

**User:** Fabio D'Angella (`fabiod.labor`)
**Project ID (Expo):** `92cf0b6f-ee99-4fbe-8562-10cfc8a786de`
**Slug:** `lamico-fraterno`
**Bundle:** `com.dangella.koda`
**Data:** 2026-08-26

---

## SINTOMO

Dopo 4 build Android consecutive generate dal pulsante "Publish" della piattaforma Emergent, l'APK installato sul dispositivo Android continua a mostrare la vecchia versione JS del **28 luglio 2026** (BUILD_SHORT_TAG residuo `v64.17`, versionCode 13, version 1.0.119). Il codice **v65.0** (Memory Manager, rimozione Blocco A) non appare mai — nonostante sia committato e pushato su `koda-backend/main` HEAD `771f77fe`.

---

## PROVE OGGETTIVE

### 1. Codice locale nel container `/app/frontend` — v65.0 CORRETTO ✅

```bash
$ cd /app/frontend && grep -n "KODA_BUILD_SHORT_TAG" app/index.tsx
479:  const KODA_BUILD_SHORT_TAG = "build-v65.0-blocco-a-memory-manager-android-parity";
480:  const KODA_BUILD_DATE = "2026-08-26";

$ ls -la app/memories.tsx
-rw-r--r-- 1 root root 27842 Aug 26 XX:XX app/memories.tsx  # esiste
```

### 2. Codice su remote GitHub `koda-backend/main` — v65.0 CORRETTO ✅

```bash
$ git rev-parse koda/main
771f77fee453d9480c8b725b5e5875a1c273bfe1

$ git show koda/main:frontend/app/index.tsx | grep KODA_BUILD_SHORT_TAG
479:  const KODA_BUILD_SHORT_TAG = "build-v65.0-blocco-a-memory-manager-android-parity";

$ git ls-tree koda/main frontend/app/memories.tsx
100644 blob bd113d782174a81f17480094e81fb3436cfaa93f    frontend/app/memories.tsx

# Commit critici degli ultimi 2 giorni:
771f77fe 2026-08-26 19:44:52  Auto-generated changes
a968a468 2026-08-26 19:38:51  frontend: remove INTRO orb debug overlay
45a40a6c 2026-08-26 18:47:17  frontend: Android parity — Memory Manager + BUILDTAG v65.0
196f3e22 2026-08-25 16:39:24  ## 🟢 Blocco A + Memory Manager COMPLETI
```

### 3. Configurazione `app.json` — runtimeVersion NON bumpato ⚠️

```json
{
  "version": "1.0.126",      // bumped OK
  "buildNumber": "25",        // iOS bumped OK
  "versionCode": 25,          // Android bumped OK
  "runtimeVersion": "1.0.113" // ❌ NON bumpato dal 20 luglio
}
```

### 4. **SMOKING GUN** — Stato del canale OTA `preview` su `u.expo.dev`

Ho interrogato direttamente il server manifesti EAS Update per il progetto:

```bash
$ curl -H "expo-runtime-version: 1.0.113" \
       -H "expo-platform: android" \
       -H "expo-channel-name: preview" \
       -H "expo-protocol-version: 1" \
       -H "Accept: multipart/mixed" \
       https://u.expo.dev/92cf0b6f-ee99-4fbe-8562-10cfc8a786de
```

**Response manifest** (troncato):
```json
{
  "id": "019fa86f-f946-7476-b307-892fe3486646",
  "createdAt": "2026-07-28T11:15:38.438Z",     ← 29 GIORNI FA
  "runtimeVersion": "1.0.113",
  "metadata": {
    "updateGroup": "87245a7b-34cc-46e6-8039-1a47886ae788",
    "branchName": "preview"
  },
  "extra": {
    "expoClient": {
      "version": "1.0.119",         ← due minor version indietro
      "android": { "versionCode": 13 },   ← 12 build indietro
      "ios": { "buildNumber": "13" }
    }
  }
}
```

**L'ultimo OTA update pubblicato sul channel `preview` per runtimeVersion `1.0.113` risale al 28 luglio 2026.** Da allora ci sono stati almeno **15 push su `koda-backend/main`** (verificati via `git log`) — ma **NESSUNO** di essi ha generato un nuovo OTA su Expo. Il workflow GitHub Actions `.github/workflows/eas-update.yml`, configurato per eseguire `eas update --channel preview` ad ogni push, **non produce risultati da 29 giorni**.

### 5. Configurazione `eas.json` — preview → channel `preview` ✅ standard

```json
"preview": {
  "distribution": "internal",
  "autoIncrement": true,
  "credentialsSource": "local",
  "android": { "buildType": "apk" },
  "channel": "preview"
}
```

### 6. GitHub Actions workflow — configurato correttamente ma NON esegue

`.github/workflows/eas-update.yml`:
- Trigger: `push` a `main` (auto) + `workflow_dispatch` (manuale)
- Job: `eas update --channel preview` (+production +development)
- Secret richiesto: `EXPO_TOKEN`

Non ho accesso ai run logs di GitHub Actions dal container. Sospetto forte: **`EXPO_TOKEN` scaduto o mancante nei GitHub Secrets del repo**, oppure `eas update` fallisce silenziosamente da 29 giorni.

---

## INTERPRETAZIONE TECNICA

Ci sono due modi in cui il pulsante Emergent "Publish" può servire un APK:

**Ipotesi A — Pubblica solo OTA update (nessun rebuild nativo)**
- Il pulsante triggera solo `eas update`, non `eas build`.
- Se `eas update` fallisce da 29 giorni, l'ultimo bundle JS servito ai client è ancora quello del 28 luglio (v64.17).
- Gli APK già installati sui dispositivi degli utenti restano bloccati sul bundle vecchio, perché il canale non offre bundle nuovi.
- L'utente pensa di aver "generato un nuovo APK" ma in realtà ha solo tentato di pubblicare un OTA che silenziosamente fallisce.

**Ipotesi B — Esegue `eas build` completo ma con snapshot cache stale**
- Se la pipeline Emergent zippa uno snapshot del container `/app/frontend` scattato prima del 28 luglio (invece del filesystem live attuale), il bundle embedded conterrà codice v64.17.
- L'APK generato conterrà quel bundle stantio come embedded update.
- All'installazione, `expo-updates` cerca un OTA più recente su channel `preview` (runtimeVersion=1.0.113) → trova l'update del 28 luglio → è coetaneo o più recente dell'embedded → applica quello → utente vede v64.17.

**Prova incrociata**: `app.json` OTA remoto riporta `version: 1.0.119, versionCode: 13`. L'utente ci ha detto che l'APK installato mostra "v64.17". Il commit che ha portato `BUILD_SHORT_TAG` a includere `v64.17` (o comunque il codice del componente `RadialGlow.tsx v64.17`) è antecedente al 28 luglio → **compatibile con OTA del 28 luglio**.

---

## RICHIESTA A EMERGENT SUPPORT

1. **Verificare i log di run del pulsante "Publish"** per il progetto `92cf0b6f-ee99-4fbe-8562-10cfc8a786de` negli ultimi 7 giorni. Sono passati attraverso `eas build` o solo `eas update`?
2. **Verificare se la pipeline Emergent usa una cache di snapshot del container `/app/frontend`** o zippa il filesystem live al momento del click su Publish.
3. **Verificare validità dell'`EXPO_TOKEN`** configurato nel GitHub repo `dangellafabio-byte/koda-backend` per il workflow `eas-update.yml`.
4. **Fornire il commit SHA effettivamente usato** nell'ultimo build/publish Android per questo progetto — così possiamo confrontarlo con `koda/main` HEAD `771f77fe`.

Il codice sorgente è **al 100% aggiornato** sia localmente che su remote GitHub. La disfunzione è a monte, tra `git push` e artefatto finale.

---

## AZIONE DI MITIGAZIONE APPLICATA (mia)

In parallelo a questo ticket, applicherò **bump di `runtimeVersion`** da `1.0.113` a `1.0.126` (allineato a `expo.version`) per forzare il seguente comportamento:

- Il nuovo APK avrà `runtimeVersion=1.0.126`.
- `expo-updates` **non troverà** OTA compatibili con questo runtime sul channel `preview` (l'ultimo OTA è per `runtimeVersion=1.0.113`).
- L'APK userà **esclusivamente il bundle embedded**, senza mai scaricare l'OTA stantio del 28 luglio.

Se dopo questo bump l'APK generato **continua** a mostrare v64.17, la causa è confermata al 100% come **snapshot stale del container** (Ipotesi B). Se invece mostra v65.0, la causa era l'OTA stantio (Ipotesi A) e il vero problema resta comunque il workflow `eas-update.yml` che non pubblica OTA da 29 giorni.
