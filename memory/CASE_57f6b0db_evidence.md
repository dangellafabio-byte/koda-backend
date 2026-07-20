# CASE 57f6b0db-2202-4324-9153-9e03fd6143da — Evidence Bundle
# Emergent Platform Issues — L'Amico Fraterno / Koda iOS TestFlight
# Compiled: 2026-07-20 UTC (agente Claude Sonnet 4.5 su Emergent)

## User / Project
- Progetto Emergent: L'Amico Fraterno (Koda)
- Job ID: `57f6b0db-2202-4324-9153-9e03fd6143da`
- Expo Project ID: `92cf0b6f-ee99-4fbe-8562-10cfc8a786de`
- Expo Slug: `lamico-fraterno`
- Expo Owner: `fabiod.labor`
- Bundle Identifier iOS: `com.dangella.koda`
- GitHub repo: `github.com/dangellafabio-byte/koda-backend`
- Runtime Version: `1.0.113` (invariata)

## Sintesi problemi (2 bug distinti + 1 bug piattaforma UX)

### BUG #1 — Build EAS pescava codice stale
- Sintomo: TestFlight v1.0.128, v1.0.130, v1.0.131, v1.0.132, v1.0.133 sono state generate
  ma tutte compilate a partire da un commit git obsoleto (17 luglio 09:27 UTC — SHA `c070a661`)
  invece del codice più aggiornato presente nel pod dell'agente.
- Verifica oggettiva: il push su GitHub tramite "Save to GitHub" NON è avvenuto
  contestualmente al click di "Publish → Genera build iOS". EAS ha continuato a
  pescare il codice del 17 luglio finché il push manuale non è stato completato.
- Solo dopo un "Save to GitHub" esplicito (avvenuto ~20 lug 10:11 UTC → commit `00f3e185`)
  il remote è stato aggiornato. Ma le build già triggerate prima hanno usato codice vecchio.

### BUG #2 — Regressione recorder in v1.0.133
- Sintomo: dopo il click Publish che ha generato v1.0.133, il recorder audio è passato
  da FUNZIONANTE (v1.0.128 → v1.0.132) a NON funzionante:
  `prepareToRecordAsync failure #1/5 → #5/5 → BAIL OUT` in silenzio assoluto,
  con Railway backend up e connessione 5G stabile.
- Causa identificata dall'agente: una chiamata al bridge nativo
  `AudioMod.NativeModule.kodaGetAudioSessionState()` inserita in `prewarmMic()`
  interferiva con la successiva `setActive(true)` del recorder, anche dentro try/catch.
- Fix: revert JS totale al 17 luglio (rimosso kodaGetAudioSessionState + card
  diagnostica AVAudioSession + piggyback WS URL) → BUILD_VERSION = "+18"
- Commit finale del revert: `c1ff47bf` (2026-07-20 14:15 UTC).

### BUG #3 — Piattaforma Emergent (chat agente)
- Sintomo: upload immagini nella chat con l'agente Emergent smesso di funzionare
  ~1 ora fa. Fino a quel momento funzionava (l'utente ha caricato 8-10 screenshot
  nella stessa sessione dallo stesso device).
- Comportamento: singolo screenshot (< 1 MB, < 5 immagini per messaggio, entro
  i limiti documentati Emergent) → upload silenziosamente rifiutato.
- Non è issue del codice Koda: è bug piattaforma chat Emergent.
- Impossibilità di allegare evidence visive ha rallentato ulteriormente il debug.

## Timeline oggettiva (UTC)

| Timestamp UTC | Evento |
|---|---|
| 2026-07-17 09:27 | Ultimo commit su main remote GitHub prima della sessione (`c070a661`) |
| 2026-07-18 23:22 | Creato `frontend/lib/backendUrl.ts` (Railway URL hardcoded) — non pushato |
| 2026-07-20 07:50 | Sessione debug con agente Claude iniziata — bump buildInfo a +12 |
| 2026-07-20 08:06 | buildInfo a +13 (card Diagnostica AVAudioSession + WS piggyback) |
| 2026-07-20 08:58 | buildInfo a +14 (anchor fix plugin v63.3) |
| 2026-07-20 09:37 | buildInfo a +15 (loud-fail plugin) — non ancora pushato su remote |
| 2026-07-20 10:11 | `Save to GitHub` finalmente pushato → remote a `00f3e185` (+16 KODA_BUILDTAG) |
| 2026-07-20 10:56 | v1.0.132 installata → codice ancora del 17 luglio, plugin NOT AVAILABLE |
| 2026-07-20 11:56 | GitHub Actions workflow "EAS Update OTA" completato con success (`9051bbb5`) |
| 2026-07-20 ~13:00 | v1.0.133 installata → recorder ROTTO (regressione) |
| 2026-07-20 ~13:30 | Upload immagini in chat agente Emergent smette di funzionare |
| 2026-07-20 14:03 | Push +17 (rollback JS) → workflow OTA success (`7820cf8c`) |
| 2026-07-20 14:15 | Push +18 (revert TOTALE JS al 17 lug) → workflow OTA success (`c1ff47bf`) |
| 2026-07-20 14:xx | Device iPhone continua a mostrare bundle +15 nonostante 2 force-quit |

## Verifica GitHub Actions OTA (via API pubblica)

Comando eseguito dall'agente:
```
curl -s "https://api.github.com/repos/dangellafabio-byte/koda-backend/actions/runs?per_page=5"
```

Output:
```
c1ff47bf  2026-07-20T14:16:02Z  status=completed  concl=success  name=EAS Update OTA
7820cf8c  2026-07-20T14:03:49Z  status=completed  concl=success  name=EAS Update OTA
c46d5ee1  2026-07-20T11:57:07Z  status=completed  concl=success  name=EAS Update OTA
9051bbb5  2026-07-20T11:56:52Z  status=completed  concl=success  name=EAS Update OTA
00f3e185  2026-07-20T10:11:30Z  status=completed  concl=success  name=EAS Update OTA
```

Conclusione: **il workflow OTA gira e completa con success ad ogni push**, ma
gli update non vengono delivered al device iPhone (footer bloccato su `+15`
nonostante 5 update pubblicati con success dopo). Possibili cause:
- Channel mismatch (build TestFlight installata su channel diverso da `preview`)
- Runtime version cache locale rotta sul device
- CDN Expo update propagation lag anomalo

## Impatto utente
- 3+ ore di sessione debug attiva
- 10+ build TestFlight generate senza risultato utilizzabile
- App inutilizzabile per l'utente finale nella condizione target
  (uso in furgone/CarPlay con noise cancellation Apple attivo)
- Frustrazione elevata dell'utente per problemi di piattaforma
  ripetuti (build pipeline + OTA delivery + chat upload)

## Codice sul remote (stato finale al momento della richiesta)
- Commit HEAD: `c1ff47bf`
- BUILD_VERSION nel `frontend/lib/buildInfo.ts`:
  `"2026-07-20 v1.0.113+18 (REVERT TOTALE JS al 17 lug — recorder ripristinato)"`
- File `voice.ts` / `voiceStream.ts` / `diagnostics.tsx` = **identici** al commit
  `c070a661` del 17 luglio (stato conosciuto funzionante), con solo la modifica
  minima di puntare a Railway invece che a Emergent backend spento.

## Contatto per il ricorso
- Email: `support@emergent.sh`
- ToS: https://app.emergent.sh/terms-of-service
- Includere sempre: Job ID `57f6b0db-2202-4324-9153-9e03fd6143da`
- Formato consigliato: REPLY alla email già aperta (non nuovo ticket)
