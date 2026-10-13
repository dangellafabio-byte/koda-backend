# Ollenya — payload Home esportati

File generati da `export_home_payloads.py` (import `server.py` solo in-memoria,
zero IO esterno). Ogni JSON contiene il **request body esatto** che
`_fast_pipeline_task` invia a Claude Haiku 4.5:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens_output": 320,
  "request_body": {
    "system":  [ { "type":"text", "text":"...", "cache_control":{"type":"ephemeral"} } ],
    "messages":[ { "role":"user", "content":"..." } ]
  },
  "label": "...",
  "note_cacheability": "..."
}
```

Dati fittizi — nessun campo è legato a utenti reali. Vedi
`measure_prompt_tokens_v3.py` per contare i token.

## Varianti NON incluse (rami opzionali)
- GPS iniettato nel user_payload (solo se la domanda è "dove sono/che tempo
  fa"). Aggiunge ~100-200 caratteri.
- Web search brief (solo se Tavily attivo e query real-time). Aggiunge
  tipicamente 400-800 token.
- Istruzioni "web-search disabled" (iniettate nel system quando
  l'utente ha disattivato Impostazioni → Ricerca Web).

Se servono, si possono generare con lo stesso export aggiungendo i
blocchi corrispondenti.
