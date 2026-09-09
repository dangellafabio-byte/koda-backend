"""
DIAGNOSTIC v2 — Anthropic Prompt Caching via Emergent LLM Proxy
================================================================

Follow-up al ticket 2026-08-14 richiesto dal support Emergent (2026-09-XX).

Esegue le stesse 3 chiamate T1/T2/T3 dello script originale, ma su
DUE varianti di configurazione per isolare la variabile:

  Variant A: model prefix = "anthropic/" + api_base ORIGINALE (senza /v1)
  Variant B: model prefix = "openai/"    + api_base CON /v1 aggiunto

Output combinato: /tmp/koda_caching_diag_variants.json

Non modifica server.py. Non fa deploy.
"""

import os
import sys
import json
import time
import pathlib
import asyncio
from typing import Any, Dict, List

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

# === Prompt di test (identico allo script originale) ================
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
SYS_PROMPT = _SYS_BASE * 15
USER_MSG = "Ciao Koda, oggi mi sento un po' stanco."

# === Cattura HTTP body grezzo via monkey-patch httpx ==================
_captured: Dict[str, Any] = {"body": None, "headers": None, "url": None}
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


async def call_claude(
    model: str,
    api_base: str,
    with_cache_control: bool,
    label: str,
) -> Dict[str, Any]:
    print(f"\n{'-'*70}\n▶ {label}  |  model={model}  |  api_base={api_base}\n{'-'*70}")

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

    messages = [system_block, {"role": "user", "content": USER_MSG}]

    _captured["body"] = None
    _captured["headers"] = None
    _captured["url"] = None

    t0 = time.time()
    try:
        resp = await litellm.acompletion(
            model=model,
            messages=messages,
            api_key=EMERGENT_LLM_KEY,
            api_base=api_base,
            max_tokens=50,
            timeout=30,
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

        body_analysis: Dict[str, Any] = {
            "cache_control_in_body": False,
            "body_size_chars": 0,
        }
        if _captured["body"]:
            body_str = _captured["body"]
            body_analysis["body_size_chars"] = len(body_str)
            body_analysis["cache_control_in_body"] = "cache_control" in body_str
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
                        body_analysis["system_first_block_keys"] = (
                            list(sys_content[0].keys()) if sys_content else []
                        )
                    elif isinstance(sys_content, str):
                        body_analysis["system_content_type"] = "plain_string"
                        body_analysis["system_length_chars"] = len(sys_content)
            except Exception as e:
                body_analysis["parse_error"] = repr(e)

        result = {
            "label": label,
            "model": model,
            "api_base": api_base,
            "wall_ms": wall_ms,
            "usage": usage_dict,
            "body_analysis": body_analysis,
            "captured_headers_relevant": {
                k: v for k, v in (_captured["headers"] or {}).items()
                if k in {"authorization", "anthropic-beta", "anthropic-version",
                         "x-api-key", "content-type", "user-agent"}
            },
            "captured_url": _captured["url"],
        }

        cc = usage_dict.get("cache_creation_input_tokens") or 0
        cr = usage_dict.get("cache_read_input_tokens") or 0
        if cr > 0:
            status = f"HIT (read={cr})"
        elif cc > 0:
            status = f"MISS→CREATED (creation={cc})"
        else:
            status = "NONE (caching non attivo)"

        print(f"  wall_ms          : {wall_ms}")
        print(f"  cache_control in HTTP body sent: {body_analysis.get('cache_control_in_body')}")
        print(f"  usage            : {json.dumps(usage_dict)}")
        print(f"  cache_status     : {status}")

        return result

    except Exception as e:
        print(f"  ❌ ERROR: {e!r}")
        return {
            "label": label,
            "model": model,
            "api_base": api_base,
            "error": repr(e),
        }


async def run_variant(variant_name: str, model: str, api_base: str) -> List[Dict[str, Any]]:
    print(f"\n{'='*70}\n=== VARIANT {variant_name}\n=== model    = {model}\n=== api_base = {api_base}\n{'='*70}")
    variant_results = []
    variant_results.append(await call_claude(
        model, api_base, with_cache_control=True,
        label=f"{variant_name}_T1_first_with_cache_control",
    ))
    time.sleep(2)
    variant_results.append(await call_claude(
        model, api_base, with_cache_control=True,
        label=f"{variant_name}_T2_second_with_cache_control",
    ))
    time.sleep(1)
    variant_results.append(await call_claude(
        model, api_base, with_cache_control=False,
        label=f"{variant_name}_T3_baseline_no_cache_control",
    ))
    return variant_results


async def main():
    print("\n" + "="*70)
    print("KODA — Prompt Caching Diagnostic v2 (support-requested variants)")
    print("="*70)
    print(f"sys_prompt chars: {len(SYS_PROMPT)} (target: >2048 tokens for Haiku cache)")

    all_results: Dict[str, Any] = {
        "variants": {},
        "notes": [
            "Variant A: model prefix 'anthropic/' + api_base ORIGINAL (no /v1)",
            "Variant B: model prefix 'openai/' + api_base with /v1 appended",
        ],
    }

    # Variant A: anthropic/ + api_base originale
    variant_a = await run_variant(
        "VA",
        model="anthropic/claude-haiku-4-5-20251001",
        api_base="https://integrations.emergentagent.com/llm",
    )
    all_results["variants"]["VA_anthropic_prefix_original_base"] = variant_a

    time.sleep(3)

    # Variant B: openai/ + api_base con /v1
    variant_b = await run_variant(
        "VB",
        model="openai/claude-haiku-4-5-20251001",
        api_base="https://integrations.emergentagent.com/llm/v1",
    )
    all_results["variants"]["VB_openai_prefix_v1_base"] = variant_b

    out_path = "/app/backend/_debug_downloads/caching_diag_variants.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\n\n✔ Full JSON saved to: {out_path}")

    # Summary tabellare
    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"{'label':<50} {'cc':<6} {'cr':<6} {'wall_ms':<8}")
    print("-"*70)
    for variant_key, variant_results in all_results["variants"].items():
        for r in variant_results:
            usage = r.get("usage", {}) or {}
            cc = usage.get("cache_creation_input_tokens") or 0
            cr = usage.get("cache_read_input_tokens") or 0
            wall = r.get("wall_ms", "ERR")
            print(f"{r['label']:<50} {cc:<6} {cr:<6} {wall}")
    print("="*70)


if __name__ == "__main__":
    asyncio.run(main())
