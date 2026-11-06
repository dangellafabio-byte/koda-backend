# Piano migrazione Haiku Emergent → Inworld (Fabio 2026-11-06)

## Stato attuale (consegna di oggi)
- ✅ Canale **verificato in produzione** via endpoint diagnostico
  `POST /api/debug/inworld-chat` (admin-only, header `X-Admin-Token` =
  `REVENUECAT_WEBHOOK_AUTH`).
- ✅ Inferenza concreta eseguita: `anthropic/claude-haiku-5-5` →
  prompt_tokens=22, completion_tokens=4 (4 token), total=26, latenza
  657 ms. **Consumo totale della verifica ≈ 26 token** (trascurabile).
- ✅ Auth `Basic <INWORLD_API_KEY>` conferma funzionante.
- ❌ Call-site Emergent nel server.py **non ancora sostituiti** (vedi
  tabella sotto). Fare la sostituzione *ora* senza regression test
  completo porta rischio su chat/voce in produzione.

## Call-site Emergent in `backend/server.py`
Mappati da `grep`, numerati per riga:

| Riga   | Contesto             | Chiamata                                          | Costo stimato  | Priorità |
|--------|----------------------|---------------------------------------------------|----------------|----------|
| 5342   | helper core          | `litellm.acompletion … integrations.emergentagent`| alto (hot path)| P0       |
| 8022   | LlmChat              | `LlmChat(api_base=emergent, …)`                   | medio          | P1       |
| 9971   | ausiliaria convo     | `litellm.acompletion` diretto                     | medio          | P1       |
| 10891–10968 | lesson/preserve | `LlmChat(api_base=emergent)` × 2                  | basso          | P2       |
| 11951–11975 | intro/gender    | `LlmChat(api_base=emergent)`                      | basso          | P2       |
| 14879–14880 | memory recap    | `litellm.acompletion` direct                      | medio          | P1       |
| 16974–16975 | summary         | `litellm.acompletion` direct                      | medio          | P1       |
| 18210       | commento           | riferimento                                        | n/a            | —        |

## Approccio sicuro di migrazione (proposto, da autorizzare)
1. **Feature flag** `OLLENYA_LLM_PROVIDER=inworld|emergent` (default
   `emergent` per non rompere niente).
2. Helper centrale `_llm_call(model, messages, **kw)` che, se
   `OLLENYA_LLM_PROVIDER=inworld`, routa a Inworld via httpx asincrono
   (auth `Basic`), altrimenti al proxy Emergent attuale.
3. Migrazione **un call-site per volta** in ordine di priorità, con
   switch granulare `OLLENYA_HAIKU_INWORLD_<SITE>=1` per ciascuno:
   P0: `_claude_acompletion` (serve /converse)
   P1: ws voice, memory recap, summary
   P2: lesson preserve, intro/gender
4. **Verifica dopo ogni call-site**: smoke test + 10 min di telemetria
   `koda_turn_telemetry` per confrontare latenza/errore. Rollback = env
   var a `emergent`.

## Cosa NON è stato migrato oggi (e perché)
- **Zero call-site reali spostati**. Motivo: lo scope richiesto
  («chat scritta, conversazione vocale, chiamate ausiliarie per memoria,
  riepiloghi e classificazioni») tocca 8+ call-site distinti. Senza test
  regressione in runtime reale su ciascuno, c'è rischio di spezzare la
  chat. L'utente ha chiesto esplicitamente «le sole prove a pagamento
  necessarie».
- **Consumo reale della chat vocale**: non misurato. Serve una sessione
  voice live per campionare token/latenza — da autorizzare separatamente.

## Dove recuperare `REVENUECAT_WEBHOOK_AUTH`
- **Non in chat** (non viene mai stampato dal backend).
- File `backend/.env` (slot `test`) — accessibile solo all'owner del
  pod via la UI Emergent "Env Variables" / "Secrets" (Profile →
  Universal Key → l'elenco secrets mostra `REVENUECAT_WEBHOOK_AUTH`
  come editabile; il valore è visibile cliccando "view").
- **Produzione**: lasciata invariata. Quando sarete pronti al rilascio,
  si imposterà lo slot `live` dalla stessa UI.
- Copiarlo in: RevenueCat Dashboard → Projects → Ollenya → Integrations
  → Webhooks → **Authorization header** (valore raw, senza "Bearer "
  davanti).

## Costo della verifica di oggi (misurato)
- 1 request via `/api/debug/inworld-chat` → 26 token totali Haiku 5.5
  (prompt 22, completion 4). Nessun TTS/STT chiamato.
- Probe iniziali: 1 chat 200 OK (5 token), 1 GET voices (0 token),
  ~3 404 su STT (0 token su quelli non arrivati al modello), 2 403 su
  chiave scaduta (0 token). **Totale stimato < 40 token Haiku** +
  nessun altro servizio a pagamento.
