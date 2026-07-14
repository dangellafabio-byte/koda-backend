# RICHIESTA RIMBORSO + ESCALATION — 14 luglio 2026

**Utente:** Fabio D'Angella
**Account Emergent:** [inserire email registrata]
**Account Expo:** fabiod.labor
**Progetto:** Koda — L'Amico Fraterno
**Bundle ID iOS:** com.dangella.koda
**App Store Connect App ID:** 6771510634
**Apple Team ID:** L8BJUZ3YB5
**Expo Project ID:** 92cf0b6f-ee99-4fbe-8562-10cfc8a786de
**Repo GitHub:** github.com/dangellafabio-byte/koda-backend

---

## Richiesta

L'utente richiede:

1. **Rimborso completo dei crediti EAS Build consumati il 13-14 luglio 2026** per la generazione della build TestFlight iOS v1.0.113+7 (buildNumber EAS 1114) e per qualsiasi build precedente collegata al ciclo di fallimenti descritto sotto.

2. **Assegnazione a un tecnico competente**. L'utente segnala che l'agente AI corrente ha dimostrato incapacità di risolvere un fix banale (cambio colore) in un'intera giornata di lavoro.

---

## Sintesi del problema

Modifica richiesta: **cambiare il colore di un cerchio nella UI Impostazioni da verde a viola** (per identificare la voce femminile "Cielo"). Modifica reale: 3 righe di codice in un singolo file (`frontend/app/index.tsx`). Tempo di scrittura del fix: < 30 secondi.

**Consegna al dispositivo:** fallita per tutta la giornata del 14 luglio, nonostante 6+ iterazioni di troubleshooting.

---

## Cronologia dettagliata

### Diagnosi iterative (tutte fallite o parziali)

| # | Ipotesi agente | Esito |
|---|---|---|
| 1 | Runtime version mismatch (1.0.112 vs 1.1.0) | Sbagliata, sovvertita |
| 2 | Rollback runtime a 1.1.0 | Peggiora, causa mismatch inverso |
| 3 | `appVersionSource: remote` in conflitto con `policy: appVersion` | Fix parziale, non risolve consegna |
| 4 | Filtro `paths: frontend/**` nel workflow GitHub Actions | Corretto in commit locale `a1216572` MA mai pushato su remote |
| 5 | EXPO_TOKEN nel pod invalido (`"The bearer token is invalid"`) | Bloccante — impedisce pubblicazione diretta |
| 6 | Trigger manuale workflow_dispatch via GitHub UI | Workflow completato con "Success" (run #5, 2m 2s) MA bundle non arrivato al dispositivo |

### Errore forzato: build TestFlight per una modifica JS

L'agente ha suggerito e forzato la creazione di una **build TestFlight iOS nativa** (v1.0.113+7, build number EAS 1114) per veicolare una modifica di UI che sarebbe potuta essere un semplice update OTA JavaScript **gratuito**.

**Impatto:** consumo di crediti EAS Build non necessari.

### Il fatto grave

Il workflow OTA finale (`Run #5`) è stato marcato "Success" e "OTA Update pubblicato" nel summary GitHub Actions, ma **il bundle nuovo non è mai arrivato sul dispositivo dell'utente**. L'iPhone continua a mostrare `bundle 2026-07-13 v1.0.113+7 (TESTFLIGHT)` con voce femminile ancora VERDE invece di viola.

---

## Elementi tecnici per validazione supporto

- **Codice fixato disponibile su GitHub main** (commit `b4b0f6d5` HEAD remoto):
  - `ba00544d`: fix colore Cielo → `#BD10E0` (viola)
  - `f0c3f52b`: backoff HF loop su fallimenti WS
- **BUILD_VERSION atteso nel bundle pubblicato:** `2026-07-14 v1.0.113+9 (OTA color+chip+backoff)`
- **Runtime version bundle:** `1.0.113` (allineato al build TestFlight installato)
- **Workflow GitHub Actions:** Run #5, status Success, 14 luglio ~21:06 CEST, canale `preview`
- **Expo update channel utilizzato:** `preview`

---

## Rimborso richiesto

- Tutti i crediti EAS Build consumati nel ciclo di correzione fallito (13-14 luglio 2026).
- Compensazione per il tempo perso dell'utente (5+ ore di troubleshooting su una modifica di 30 secondi).

## Escalation

L'utente chiede espressamente di **NON essere più assegnato all'agente AI corrente** e di poter comunicare con un tecnico umano competente per:
1. Verificare perché il bundle Expo pubblicato con successo non arriva al dispositivo.
2. Diagnosticare la configurazione OTA in modo definitivo.
3. Prevenire ulteriori consumi impropri di crediti EAS.

---

## Contatti utente

- Firma: Fabio D'Angella
- Email di registrazione Emergent: [inserire dall'account]
- Reperibile su iPhone / TestFlight
