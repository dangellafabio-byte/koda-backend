# RICHIESTA RIMBORSO CREDITI EAS — Progetto Koda (14 luglio 2026)

**Utente:** Fabio D'Angella
**Account Expo:** fabiod.labor
**Project ID:** 92cf0b6f-ee99-4fbe-8562-10cfc8a786de
**Progetto:** Koda — L'Amico Fraterno (`com.dangella.koda`)
**Data richiesta:** 14 luglio 2026

---

## Sintesi

Da giorni il sistema di distribuzione OTA (Expo Updates) tramite l'agente AI di Emergent
non funziona in modo affidabile. Per una modifica banale di UI (un singolo colore di un
cerchio: da verde a viola) è stato necessario compilare una nuova build TestFlight
nativa, consumando crediti EAS Build che l'utente non avrebbe dovuto spendere.

L'utente chiede il rimborso dei crediti EAS consumati per build che sarebbero potute
essere semplici aggiornamenti OTA JavaScript.

---

## Cronologia dei problemi (14 luglio)

### 1. Fix banale richiesto
- Voce femminile "Cielo" doveva avere il cerchio VIOLA nella UI Impostazioni.
- Modifica reale del codice: 3 righe in `frontend/app/index.tsx`.
- Tempo effettivo di scrittura del fix: < 30 secondi.

### 2. Blocco della pipeline OTA
La pipeline GitHub Actions → Expo Updates non ha consegnato il bundle aggiornato
al dispositivo dell'utente. Cause identificate a più iterazioni:

**Iterazione 1 — Runtime version mismatch**
- Build TestFlight installata: `runtimeVersion "1.1.0"`.
- Aggiornamenti pubblicati con `runtimeVersion "1.0.112"` → nessun match.

**Iterazione 2 — Runtime version invertita**
- Corretto in `"1.1.0"` ma il build TestFlight sul telefono era in realtà `1.0.112`.
- Diagnosi errata basata su ipotesi anziché dati.

**Iterazione 3 — appVersionSource conflict**
- `appVersionSource: "remote"` in `eas.json` in conflitto con `runtimeVersion policy: "appVersion"` in `app.json`.

**Iterazione 4 — Bundle Hermes non compatibile con pod ARM64 Linux**
- L'ambiente di sviluppo Emergent è ARM64 Linux, ma `eas update` richiede Hermes
  bytecode compilato → impossibile pubblicare l'OTA direttamente dall'ambiente.

**Iterazione 5 — GitHub Actions workflow `paths` filter**
- Il workflow `eas-update.yml` aveva `paths: frontend/**`.
- Il commit "Auto-generated changes" di Emergent (Publish button) modifica solo
  `.emergent/emergent.yml`, non `frontend/**` → workflow non triggerato.

**Iterazione 6 — EXPO_TOKEN scaduto/revocato**
- Il token EXPO nell'ambiente pod di Emergent (`/root/.private/eas.env`)
  risulta scaduto: risposta API `"The bearer token is invalid"`.
- L'agente ha chiesto all'utente di generare un nuovo token, cosa che
  l'utente aveva GIÀ fatto il giorno prima.

### 3. Impatto economico

L'utente è stato costretto a:
- Lanciare una nuova build EAS TestFlight nativa (**consumo crediti EAS**),
  perché un aggiornamento JavaScript OTA (che dovrebbe essere gratis) non è mai arrivato.
- Perdere ore in troubleshooting circolare.
- Ripetere passaggi manuali (Publish → force-quit → verifica footer) per
  ~5 volte senza risultato.

### 4. Stato attuale del bundle sul dispositivo

- **Native TestFlight installata:** `bundle 2026-07-13 v1.0.113+7 (TESTFLIGHT)`, `runtime 1.0.113`.
- **Codice fixato disponibile su GitHub main:** commits `ba00544d`, `f0c3f52b`, `a1216572` — non pubblicati come OTA per token scaduto.

---

## Richiesta

Chiedo il rimborso di:
- I crediti EAS Build consumati il 14 luglio per la generazione della build
  TestFlight v1.0.113+7 (buildNumber 1114 nel sistema EAS remoto).
- Eventuali crediti aggiuntivi consumati per ripubblicazioni forzate dovute
  ai fallimenti della pipeline OTA.

---

## Informazioni tecniche di supporto

- Repository GitHub: `github.com/dangellafabio-byte/koda-backend`
- Progetto Expo: `92cf0b6f-ee99-4fbe-8562-10cfc8a786de` (`@fabiod.labor/lamico-fraterno`)
- Bundle Identifier iOS: `com.dangella.koda`
- App Store Connect App ID: `6771510634`
- Team ID Apple: `L8BJUZ3YB5`
- SDK Expo: `~54.0.35`

Log completo delle iterazioni disponibile su richiesta.

---

**Firma:** Fabio D'Angella
**Contatto:** [inserire email registrata su Emergent]
