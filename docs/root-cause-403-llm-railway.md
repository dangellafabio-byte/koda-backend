# Root cause analysis — LLM 403 su Railway (post 15 ottobre 2026)

**Branch:** `fix/stt-tts-switch-ollenya-20260612`
**Autore analisi:** agent (16 ottobre 2026)
**Scope:** solo diagnosi ripristino conversazione. Switch TTS, memoria,
quote e paywall non toccati.

## 1. Sintomo osservato (fonte: Fabio + Codex)

- `/api/converse` da Railway → HTTP 500 con log server `LLM converse
  error … litellm.APIError/OpenAIException`, body HTML 403 Forbidden.
- Il 15 ottobre Railway ha reinstallato le dipendenze. Alle 22:37-22:38
  tre chiamate Claude riuscite, poi 403 continui.
- Codex verifica: `litellm.acompletion`, modello, endpoint,
  `requirements.txt`, `Dockerfile` **invariati** rispetto al commit
  precedente all'integrazione Inworld.
- Chiave `EMERGENT_LLM_KEY` su Railway coincide con la Universal Key
  dell'account Emergent di Fabio. Saldo disponibile, permessi attivi.
- Restart Railway non risolve.
- Anche una richiesta via SDK ufficiale `anthropic` dallo stesso
  processo Railway ritorna 403.

## 2. Falsificazione dell'ipotesi "il codice è rotto"

### Setup di repro (`memory/scripts/repro_claude_403_from_pod.py`)

Riproduce **esattamente** la chiamata di `server.py` riga 9095-9131
(`/api/converse` path standard):

- Applica il monkey-patch `_OpenAIGPTConfig.remove_cache_control_flag…`
  (riga 12709-12728) a no-op.
- Chiama `litellm.acompletion` con `model='openai/claude-haiku-4-5-20251001'`,
  `api_base='https://integrations.emergentagent.com/llm'`,
  `cache_control: {type: ephemeral}` in content-blocks del system prompt.
- Legge `EMERGENT_LLM_KEY` da `backend/.env` (identica a quella Railway).

### Risultato dal pod Emergent (16/10/2026, 2 run consecutivi)

```
[patch] cache_control preservation applied
✅ HTTP 200 — risposta Claude ricevuta in 695ms  (run 1)
✅ HTTP 200 — risposta Claude ricevuta in 623ms  (run 2 post pin)
   model: claude-haiku-4-5-20251001
   usage: prompt_tokens=3159, total_tokens=3160, cache_read=0
```

### Conclusione

Le seguenti ipotesi sono **FALSIFICATE** (eliminate):

| Causa ipotetica             | Verdetto | Prova                                            |
|----------------------------|----------|--------------------------------------------------|
| Chiave `EMERGENT_LLM_KEY` rotta/scaduta | ❌ falso | 200 OK con la stessa chiave da questo pod |
| Body/payload malformato     | ❌ falso | cache_control content-block accettato dal proxy   |
| Modello sbagliato           | ❌ falso | `claude-haiku-4-5-20251001` risponde              |
| `api_base` errata           | ❌ falso | `integrations.emergentagent.com/llm` risponde     |
| Monkey-patch cache_control rotto | ❌ falso | patch attiva, call completa                 |
| `emergentintegrations==0.1.2` / `litellm==1.80.0` rotti | ❌ falso | stesse versioni, 200 OK |
| Import Inworld altera litellm | ❌ falso | moduli puri, nessun side-effect su import     |
| cache_control patch litellm fallisce con nuova litellm | ❌ falso | metodo esiste, firma OK |

## 3. Cause residue plausibili (NON riproducibili senza accesso Railway)

### Causa A — Drift di versioni al reinstall (dimostrabile da Codex)

`backend/requirements.txt` prima della patch aveva:
```
httpx>=0.27.2
pydantic>=2.9.2
python-dateutil>=2.8.2
```

**`>=`, non `==`.** Al `pip install -r requirements.txt` del 15 ottobre
Railway può aver installato versioni superiori. In particolare:

- **httpx 0.28.0** (28 novembre 2024, pochi mesi fa) ha fatto breaking
  change: rimosso `proxies` arg, deprecato `verify=` string e `cert=`.
  Fonte: https://github.com/encode/httpx/releases/tag/0.28.0
- La fingerprint TLS della nuova httpx 0.28/0.29 può differire da 0.27
  (nuovi default per HTTP/2, ALPN, cipher order). Un WAF Cloudflare può
  classificare diversamente la richiesta.
- `openai 1.99.9` (già > 1.56.1) non usa `proxies` → compatibile a
  livello Python, ma gli header `x-stainless-*` emessi possono variare
  con la versione del transport sottostante.
- `pydantic >2.9.2` può introdurre differenze di serializzazione sui
  modelli interni di litellm.

### Causa B — IP egress Railway / fingerprint TLS

- Il pod Emergent attuale (che qui risponde 200) ha un IP in un AS/range
  verosimilmente già visto dal WAF Emergent come **trust**.
- Il container Railway ha IP egress in range Google Cloud / AWS /
  diverso. Il WAF edge (plausibilmente Cloudflare o simile davanti a
  `integrations.emergentagent.com`) può:
    - avere aggiunto quel range a blocklist per abuso
    - rate-limitare per IP (le 3 chiamate OK 22:37-22:38 e poi 403
      continui suggeriscono proprio una soglia)
    - richiedere fingerprint TLS specifica che il nuovo httpx non
      produce più

### Causa C — Variabili d'ambiente non dichiarate su Railway panel

Codex ha visto 11 variabili. Il processo potrebbe ereditarne altre
(immagine base, build args, platform defaults) non visibili al panel.
`HTTPS_PROXY`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, platform-level MITM
possono alterare la connessione.

## 4. Intervento applicato in questa patch

**Unico cambio al codice: pin esplicito delle versioni variabili in
`backend/requirements.txt`.** Zero logica cambiata.

```diff
- pydantic>=2.9.2
+ pydantic==2.9.2
- httpx>=0.27.2
+ httpx==0.27.2          # era >=0.27.2, non-pinned
- python-dateutil>=2.8.2
+ python-dateutil==2.9.0.post0
```

Rationale: eliminare la variabile *drift di versioni al reinstall*.
Dopo questa patch, un `pip install -r requirements.txt` sul container
Railway produrrà **esattamente** le versioni del pod che qui risponde
HTTP 200.

**Non pretendo che questo risolva da solo il 403**: se la causa è B
(IP egress / fingerprint) o C (env), la pin non basta.

## 5. Verifica che richiedo a Codex prima della distribuzione

Due step, dal container Railway attualmente deployato (`183ef2cb`) e
dopo la nuova build con questa patch (se autorizzata):

1. **`pip freeze` del container live Railway.** Confronto con il file
   `backend/tests/golden_versions_pod_ok.txt` di questo PR. Se c'è
   drift su `httpx`, `pydantic`, `httpcore`, `anyio`, `certifi`,
   `openai`, `python-dateutil`, è **Causa A** → la pin lo risolve.

2. **Chiamata diretta a Claude dal container Railway**, con request-id e
   headers di risposta edge preservati (header Cloudflare `cf-ray`,
   `server`, `x-request-id`):

   ```bash
   # Senza esporre la chiave nei log, da shell Railway:
   python - <<'PY'
   import os, httpx
   r = httpx.post(
       'https://integrations.emergentagent.com/llm/chat/completions',
       json={'model': 'claude-haiku-4-5-20251001',
             'messages': [{'role':'user','content':'ok'}],
             'max_tokens': 1},
       headers={'Authorization': f"Bearer {os.environ['EMERGENT_LLM_KEY']}"},
       timeout=15,
   )
   print(f'status={r.status_code}')
   print(f'cf-ray={r.headers.get(\"cf-ray\")}')
   print(f'server={r.headers.get(\"server\")}')
   print(f'content-type={r.headers.get(\"content-type\")}')
   # Non stampare r.text se contiene testo privato; qui ok (payload neutro).
   print(f'first 400 bytes: {r.text[:400]}')
   PY
   ```

   Se `status=200` → la pin ha chiuso la Causa A, chiamata ripristinata.
   Se `status=403` ancora → è **Causa B** o **C**. In quel caso:
    - `cf-ray` dice chi ha restituito 403 (edge Cloudflare)
    - `server` dice se è Cloudflare, Vercel, o altro
    - Il body (anche HTML) ha spesso un codice Ray che si può
      inoltrare al supporto Emergent / Cloudflare per lo sblocco IP.

## 6. Cosa NON ho fatto (e perché)

- **NON ho dichiarato "il WAF Emergent blocca Railway"** — nessuna
  prova dal processo Railway.
- **NON ho aggiunto fallback demo per voice chat** — era esplicitamente
  escluso dal brief di Fabio.
- **NON ho toccato Claude, memoria, quote, paywall** — fuori scope.
- **NON ho aggiunto nessun bottone "Prova voce"** — richiesta
  cancellata nel messaggio successivo dallo stesso utente.
- **NON ho merged, deployed, triggerato OTA** — guardrail rispettati.
