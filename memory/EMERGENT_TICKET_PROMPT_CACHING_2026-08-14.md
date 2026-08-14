# Emergent Support Ticket — Anthropic Prompt Caching via LLM Proxy

**Status**: FINAL DRAFT — approvato da Fabio 2026-08-14, pronto per invio.
**Send to**: support@emergent.sh
**Prepared by**: Neo (background agent), per Fabio D'Angella — Progetto Koda.
**Attach**: `/tmp/koda_caching_diag.json` (output completo del test diagnostico)

---

**Subject**: Richiesta chiarimento — Supporto Anthropic Prompt Caching via LLM Proxy

**Body**:

Buongiorno,

sto usando il vostro LLM proxy (`https://integrations.emergentagent.com/llm`) per chiamare Claude Haiku 4.5 tramite `litellm==1.51.0` con l'`EMERGENT_LLM_KEY` universale. La configurazione lato client segue lo schema Anthropic-native con marker `cache_control` di tipo `ephemeral` sul system prompt.

Vorrei un chiarimento sul supporto del prompt caching Anthropic attraverso il vostro proxy.

**Sintomi osservati** (test isolato, non-streaming, single-shot, 3 chiamate consecutive):

| Condizione | `cache_creation_input_tokens` | `cache_read_input_tokens` |
|---|---|---|
| 1ª chiamata con `cache_control: ephemeral` (prompt 2425 token, sopra la soglia Haiku di 2048) | **0** | 0 |
| 2ª chiamata identica back-to-back (attesa: HIT) | 0 | **0** |
| 3ª chiamata baseline senza `cache_control` (controllo) | 0 | 0 |

**Dettagli tecnici verificati lato client**:

- Il body HTTP inviato dal client al proxy contiene i marker `cache_control` (verificato via capture httpx grezzo).
- Il system content è serializzato come `list_of_blocks` in formato Anthropic-native:
  ```json
  {
    "role": "system",
    "content": [
      {"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}
    ]
  }
  ```
- Il proxy accetta il payload senza errori, la risposta arriva correttamente (~1s), i `prompt_tokens` sono coerenti (2425) su tutte e 3 le chiamate.
- Gli unici header inviati dal client sono `Content-Type: application/json` e `Authorization: Bearer <EMERGENT_LLM_KEY>` (litellm usa AsyncOpenAI SDK).

**Le mie domande**:

1. Il vostro LLM proxy supporta il prompt caching Anthropic end-to-end (inclusa la propagazione dei metadati `cache_creation_input_tokens` / `cache_read_input_tokens` nel `usage` della risposta)?
2. Se sì, quale formato di payload, header aggiuntivi o parametri di configurazione sono necessari lato client per attivarlo correttamente?
3. Se al momento non è supportato, è previsto in roadmap? In tal caso, avete una stima temporale?

Il nostro caso d'uso (app conversazionale voice-first, system prompt statico ~8k token, ~87% dei turni completati sotto 2s) beneficerebbe di ~300-500ms di risparmio sul TTFT LLM grazie al caching.

Allego l'output del test diagnostico isolato in caso sia utile per la vostra analisi interna.

Grazie per il supporto,
Fabio — Progetto Koda (L'Amico Fraterno)
