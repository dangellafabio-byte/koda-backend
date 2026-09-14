"""
DIAGNOSTIC v3 — Verifica caching Anthropic con PROMPT DI PRODUZIONE REALE
==========================================================================

Follow-up al chiarimento del support Emergent (mail 8 settembre):
- La soglia minima cacheable per Claude Haiku 4.5 è 4096 token, NON 2048
- I test precedenti usavano 2425 token → sotto soglia → 0/0 atteso
- Il caching FUNZIONA sulla Universal Key + config production

Questo script usa il prompt di produzione VERO (chiamando _build_fast_system_prompt
con un profilo dev) per verificare empiricamente che T1 crei cache e T2 la legga.

Non modifica server.py. Non fa deploy. Read-only.

Output: /app/backend/_debug_downloads/caching_diag_v3_production_prompt.json
"""

import os
import sys
import json
import time
import pathlib
import asyncio
from typing import Any, Dict

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

# Importa il builder reale di produzione
from server import _build_fast_system_prompt, Profile, TimelineEntry  # noqa: E402

# Costruisci un profilo di test realistico (~= profilo Fabio in produzione)
_profile = Profile(
    id="diag-test-uid",
    email="dangella.fabio@gmail.com",
    name="Fabio",
    ai_name="Coda",
    ai_gender="f",
    language="it",
    home_city="Milano",
    core_traits=(
        "Persona diretta, tecnicamente competente, ex-sviluppatore. "
        "Fa domande precise e pretende risposte precise. Bassa tolleranza "
        "per pleasantries e vaghezza. Predilige comunicazione asciutta e "
        "orientata ai fatti. Sta costruendo Ollenya come progetto principale "
        "e ha investito mesi nell'app. Empatia calibrata, no toni terapeutici."
    ),
    memory_summary=(
        "Ha rifatto build EAS ieri sera. Ha testato Lascia Andare in furgone "
        "durante un viaggio Milano-Bologna. Sta valutando il paywall v3 con "
        "ripricing 200/230/230 min. Ha chiuso ieri il fix disclaimer no-fail-open "
        "e ripricing minuti. Sta preparando il ticket support Emergent per "
        "verificare il prompt caching sulla Universal Key. Il costo TTS reale "
        "misurato è €0.021-0.024/min (dashboard ElevenLabs). Ha deciso di NON "
        "andare su Anthropic diretto ma di risolvere via proxy. Ha appena "
        "ricevuto la mail 8 settembre in cui il support ha spiegato che il "
        "caching funziona ma la soglia è 4096 non 2048."
    ),
)

# Alcuni turni recenti simulati per popolare temporal_block
_recent = [
    TimelineEntry(role="user", text="Ciao Coda, sono di nuovo qui."),
    TimelineEntry(role="assistant", text="Ciao Fabio. Come va?"),
    TimelineEntry(role="user", text="Sto sistemando il paywall. Ho i dati veri di ElevenLabs."),
    TimelineEntry(role="assistant", text="Bene. Cosa dicono i numeri?"),
]

# Costruisci il prompt reale
SYS_PROMPT = _build_fast_system_prompt(
    profile=_profile,
    recent=_recent,
    memories=None,
    trial_state="active",
    situations=None,
)
print(f"System prompt: {len(SYS_PROMPT)} chars")
try:
    import tiktoken
    _enc = tiktoken.get_encoding("cl100k_base")
    _tok_count = len(_enc.encode(SYS_PROMPT))
    print(f"System prompt: ~{_tok_count} tokens (soglia Haiku 4.5 = 4096)")
    if _tok_count < 4096:
        print("⚠️  Prompt SOTTO soglia 4096 token → cache NON si attiverà per definizione")
    else:
        print(f"✓ Prompt SOPRA soglia (headroom: {_tok_count - 4096} token)")
except ImportError:
    print("(tiktoken non disponibile, stima approssimativa)")

USER_MSG = "Ciao Coda, verifica del caching in corso — dimmi solo 'ok verificato'."

# === Cattura HTTP body via monkey-patch httpx ============================
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


async def call_claude(with_cache_control: bool, label: str) -> Dict[str, Any]:
    print(f"\n{'-'*70}\n▶ {label} (cache_control={'YES' if with_cache_control else 'NO'})\n{'-'*70}")

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
            model="openai/claude-haiku-4-5-20251001",
            messages=messages,
            api_key=EMERGENT_LLM_KEY,
            api_base="https://integrations.emergentagent.com/llm",
            max_tokens=30,
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

        body_analysis = {"cache_control_in_body": False, "body_size_chars": 0}
        if _captured["body"]:
            body_str = _captured["body"]
            body_analysis["body_size_chars"] = len(body_str)
            body_analysis["cache_control_in_body"] = "cache_control" in body_str

        result = {
            "label": label,
            "wall_ms": wall_ms,
            "usage": usage_dict,
            "body_analysis": body_analysis,
            "captured_url": _captured["url"],
        }

        cc = usage_dict.get("cache_creation_input_tokens") or 0
        cr = usage_dict.get("cache_read_input_tokens") or 0
        if cr > 0:
            status = f"✅ HIT (read={cr})"
        elif cc > 0:
            status = f"✅ MISS→CREATED (creation={cc})"
        else:
            status = "❌ NONE (caching non attivo)"

        print(f"  wall_ms          : {wall_ms}")
        print(f"  cache_control in HTTP body sent: {body_analysis.get('cache_control_in_body')}")
        print(f"  usage            : {json.dumps(usage_dict)}")
        print(f"  cache_status     : {status}")

        return result

    except Exception as e:
        print(f"  ❌ ERROR: {e!r}")
        return {"label": label, "error": repr(e)}


async def main():
    print("\n" + "="*70)
    print("KODA — Prompt Caching Diagnostic v3 (PRODUCTION PROMPT)")
    print("="*70)
    print(f"model    : openai/claude-haiku-4-5-20251001")
    print(f"api_base : https://integrations.emergentagent.com/llm")
    print(f"prompt   : REAL _build_fast_system_prompt output")

    results = []
    results.append(await call_claude(with_cache_control=True, label="T1_first_with_cache_control"))
    time.sleep(2)
    results.append(await call_claude(with_cache_control=True, label="T2_second_with_cache_control_expected_HIT"))
    time.sleep(1)
    results.append(await call_claude(with_cache_control=False, label="T3_baseline_no_cache_control"))

    out_path = "/app/backend/_debug_downloads/caching_diag_v3_production_prompt.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({
            "system_prompt_chars": len(SYS_PROMPT),
            "results": results,
        }, f, indent=2, default=str)
    print(f"\n✔ Full JSON saved to: {out_path}")

    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"{'label':<50} {'cc':<8} {'cr':<8} {'wall_ms':<8}")
    print("-"*70)
    for r in results:
        usage = r.get("usage", {}) or {}
        cc = usage.get("cache_creation_input_tokens") or 0
        cr = usage.get("cache_read_input_tokens") or 0
        wall = r.get("wall_ms", "ERR")
        print(f"{r['label']:<50} {cc:<8} {cr:<8} {wall}")
    print("="*70)


if __name__ == "__main__":
    asyncio.run(main())
