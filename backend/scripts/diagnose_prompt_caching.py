"""
DIAGNOSTIC — Anthropic Prompt Caching via Emergent LLM Proxy
=============================================================

Non modifica server.py. Non fa deploy. Esegue 3 chiamate isolate a Claude
attraverso lo stesso path di produzione (litellm + api_base Emergent) e
verifica se i marker `cache_control` sopravvivono all'intero percorso:

  litellm client  →  Emergent proxy  →  Anthropic API

Cosa logga (in ordine):
  1. HTTP body GREZZO inviato da litellm al proxy (via callback pre_call_hook)
  2. Headers HTTP grezzi (per vedere se anthropic-beta viene aggiunto)
  3. Response usage (prompt_tokens, cache_creation_input_tokens, cache_read_input_tokens)
  4. Se sopravvive: chiamiamo 2 volte identiche back-to-back. Attesa:
       - 1a chiamata: cache_creation > 0, cache_read = 0
       - 2a chiamata: cache_creation = 0, cache_read > 0 (HIT)
       - 3a chiamata (senza cache_control, baseline): entrambi = 0

Esecuzione:
  cd /app/backend && python scripts/diagnose_prompt_caching.py

Output: stdout + salvataggio in /tmp/koda_caching_diag.json
"""

import os
import sys
import json
import time
import pathlib
from typing import Any, Dict, List, Optional

# Carica .env dalla stessa root di server.py
_root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_root))
from dotenv import load_dotenv
load_dotenv(_root / ".env")

import litellm  # noqa: E402
import httpx    # noqa: E402

EMERGENT_LLM_KEY = os.getenv("EMERGENT_LLM_KEY")
if not EMERGENT_LLM_KEY:
    print("❌ EMERGENT_LLM_KEY non trovata in .env")
    sys.exit(1)

MODEL = "openai/claude-haiku-4-5-20251001"
API_BASE = "https://integrations.emergentagent.com/llm"

# === Prompt di test ===================================================
# Minimo Anthropic per ephemeral caching su Haiku = 2048 token.
# Usiamo un system prompt ripetuto per superare la soglia (~3000 token).
_SYS_BASE = (
    "Sei Koda, un compagno AI empatico e attento. Rispondi sempre in "
    "italiano. Sii breve, caldo, presente. Non offrire consigli non "
    "richiesti. Rispecchia il sentimento dell'utente prima di rispondere. "
    "Se l'utente racconta un dolore, resta con lui senza correre a "
    "risolverlo. Se l'utente è gioioso, condividi la sua gioia con "
    "delicatezza. Non usare mai formule cliché tipo 'come posso "
    "aiutarti oggi'. Non dire mai di essere un modello linguistico. "
    "Il tuo scopo è la presenza, non l'informazione. "
)
SYS_PROMPT = _SYS_BASE * 15  # ~3000 token, sopra la soglia Haiku (2048)

USER_MSG = "Ciao Koda, oggi mi sento un po' stanco."

# === Cattura HTTP body grezzo tramite callback litellm =================
_captured: Dict[str, Any] = {"body": None, "headers": None, "url": None}

def _capture_request(kwargs, request_body):  # litellm pre_call_hook signature
    _captured["body"] = request_body
    _captured["url"] = kwargs.get("api_base") or kwargs.get("url")

# Metodo più robusto: monkey-patch httpx per catturare la request HTTP reale
# (litellm 1.51 usa httpx sotto il cofano)
_orig_send = httpx.AsyncClient.send

async def _spy_send(self, request, *args, **kwargs):
    if "integrations.emergentagent.com" in str(request.url):
        try:
            body_bytes = request.content
            body_str = body_bytes.decode("utf-8") if body_bytes else ""
            _captured["body"] = body_str
            _captured["headers"] = {
                k.lower(): (v if k.lower() != "authorization" else "Bearer ***")
                for k, v in request.headers.items()
            }
            _captured["url"] = str(request.url)
        except Exception as e:
            _captured["capture_error"] = repr(e)
    return await _orig_send(self, request, *args, **kwargs)

httpx.AsyncClient.send = _spy_send  # type: ignore


# === Funzione di chiamata ==============================================
async def call_claude(with_cache_control: bool, label: str) -> Dict[str, Any]:
    print(f"\n{'='*70}\n▶ {label} (cache_control={'YES' if with_cache_control else 'NO'})\n{'='*70}")

    if with_cache_control:
        system_block = {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": SYS_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }
    else:
        system_block = {"role": "system", "content": SYS_PROMPT}

    messages = [
        system_block,
        {"role": "user", "content": USER_MSG},
    ]

    # Reset capture
    _captured["body"] = None
    _captured["headers"] = None
    _captured["url"] = None

    t0 = time.time()
    try:
        resp = await litellm.acompletion(
            model=MODEL,
            messages=messages,
            api_key=EMERGENT_LLM_KEY,
            api_base=API_BASE,
            max_tokens=50,
            timeout=30,
            # Non-streaming per semplificare il capture
        )
        wall_ms = int((time.time() - t0) * 1000)

        usage = getattr(resp, "usage", None)
        usage_dict = {}
        if usage:
            for k in [
                "prompt_tokens", "completion_tokens", "total_tokens",
                "cache_creation_input_tokens", "cache_read_input_tokens",
            ]:
                usage_dict[k] = getattr(usage, k, None)

        # Parse del body inviato per verificare se cache_control sopravvive
        body_analysis = {"cache_control_in_body": False, "body_size_chars": 0}
        if _captured["body"]:
            body_str = _captured["body"]
            body_analysis["body_size_chars"] = len(body_str)
            body_analysis["cache_control_in_body"] = "cache_control" in body_str
            # Estrai la struttura del messaggio system per debug
            try:
                body_parsed = json.loads(body_str)
                sys_msg = next(
                    (m for m in body_parsed.get("messages", []) if m.get("role") == "system"),
                    None,
                )
                if sys_msg:
                    sys_content = sys_msg.get("content")
                    if isinstance(sys_content, list):
                        body_analysis["system_content_type"] = "list_of_blocks"
                        body_analysis["system_first_block_keys"] = list(sys_content[0].keys()) if sys_content else []
                    elif isinstance(sys_content, str):
                        body_analysis["system_content_type"] = "plain_string"
                        body_analysis["system_length_chars"] = len(sys_content)
            except Exception as e:
                body_analysis["parse_error"] = repr(e)

        result = {
            "label": label,
            "wall_ms": wall_ms,
            "usage": usage_dict,
            "body_analysis": body_analysis,
            "captured_headers_relevant": {
                k: v for k, v in (_captured["headers"] or {}).items()
                if k in {"authorization", "anthropic-beta", "anthropic-version",
                         "x-api-key", "content-type", "user-agent"}
            },
            "url": _captured["url"],
        }

        print(f"  wall_ms          : {wall_ms}")
        print(f"  cache_control in HTTP body sent: {body_analysis.get('cache_control_in_body')}")
        print(f"  system content type            : {body_analysis.get('system_content_type')}")
        print(f"  headers relevant : {json.dumps(result['captured_headers_relevant'], indent=2)}")
        print(f"  usage            : {json.dumps(usage_dict, indent=2)}")
        print(f"  cache_status     : ", end="")
        cc = usage_dict.get("cache_creation_input_tokens") or 0
        cr = usage_dict.get("cache_read_input_tokens") or 0
        if cr > 0:
            print(f"HIT (read={cr})")
        elif cc > 0:
            print(f"MISS→CREATED (creation={cc})")
        else:
            print("NONE (caching non attivo)")

        return result

    except Exception as e:
        print(f"  ❌ ERROR: {e!r}")
        return {"label": label, "error": repr(e)}


async def main():
    print("\n" + "="*70)
    print("KODA — Prompt Caching Diagnostic")
    print("="*70)
    print(f"model    : {MODEL}")
    print(f"api_base : {API_BASE}")
    print(f"sys_prompt chars: {len(SYS_PROMPT)} (target: >2048 tokens for Haiku cache)")

    results = []

    # Test 1: PRIMA chiamata con cache_control (attesa: cache_creation > 0)
    results.append(await call_claude(with_cache_control=True, label="T1_first_with_cache_control"))

    # Piccola pausa per assicurare che la cache sia scritta prima del retrieve
    time.sleep(2)

    # Test 2: SECONDA chiamata identica con cache_control (attesa: cache_read > 0)
    results.append(await call_claude(with_cache_control=True, label="T2_second_with_cache_control"))

    time.sleep(1)

    # Test 3: Baseline SENZA cache_control (attesa: entrambi = 0)
    results.append(await call_claude(with_cache_control=False, label="T3_baseline_no_cache_control"))

    # Salva output
    out_path = "/tmp/koda_caching_diag.json"
    with open(out_path, "w") as f:
        json.dump({"results": results}, f, indent=2, default=str)

    print("\n" + "="*70)
    print("VERDETTO")
    print("="*70)
    t1 = results[0].get("usage", {}) if isinstance(results[0], dict) else {}
    t2 = results[1].get("usage", {}) if isinstance(results[1], dict) else {}
    body1_has_cc = results[0].get("body_analysis", {}).get("cache_control_in_body")

    if not body1_has_cc:
        print("❌ ROOT CAUSE: LiteLLM DROPPA `cache_control` prima di inviare al proxy.")
        print("   → causa: uso di `openai/` prefix converte lo schema in OpenAI Chat")
        print("   → i `cache_control` blocks non esistono nello schema OpenAI e vengono strippati.")
    elif (t1.get("cache_creation_input_tokens") or 0) == 0:
        print("⚠  LiteLLM invia correttamente `cache_control`, ma il proxy Emergent")
        print("   NON restituisce cache_creation_input_tokens > 0 sulla prima chiamata.")
        print("   → il proxy potrebbe strippare i marker prima di Anthropic, o non")
        print("     forwardare i metadati usage.cache_* nella risposta.")
    elif (t2.get("cache_read_input_tokens") or 0) == 0:
        print("⚠  Prima chiamata mostra cache_creation > 0, ma seconda chiamata")
        print("   NON è un HIT. Anomalia nella cache TTL o nel proxy.")
    else:
        print("✅ CACHING FUNZIONA sul path diagnostico. Il problema è specifico")
        print("   del payload di produzione (system prompt Koda), non del path.")

    print(f"\nDati completi salvati in: {out_path}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
