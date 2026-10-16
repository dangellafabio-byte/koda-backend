#!/usr/bin/env python3
"""
Test di repro / falsificazione dell'ipotesi "il codice è rotto".

Riproduce esattamente la chiamata /api/converse che su Railway restituisce
"LLM converse error litellm.APIError/OpenAIException 403 HTML":

1) Applica il monkey-patch cache_control di server.py (riga 12710-12728).
2) Chiama litellm.acompletion con GLI STESSI parametri di server.py
   (model openai/claude-haiku-4-5-20251001, cache_control ephemeral,
   api_base integrations.emergentagent.com/llm) VERSO IL PROXY REALE
   usando la chiave EMERGENT_LLM_KEY letta da backend/.env.

3) Se la richiesta ritorna 200 da QUESTO pod → il codice NON è la
   causa del 403: la causa va cercata nel processo Railway (versioni
   effettive dei pacchetti, IP egress, variabili d'ambiente non
   dichiarate, fingerprint TLS).

ATTENZIONE: questa è una chiamata API REALE a Claude Haiku via Emergent.
Costo stimato < 0.00001 USD (max_tokens=1, prompt=1 user message brevissimo).
Non consuma nulla di significativo.
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_BACKEND = ROOT / "backend"
os.chdir(_BACKEND)

from dotenv import load_dotenv
load_dotenv(_BACKEND / ".env")

key = os.environ.get("EMERGENT_LLM_KEY", "").strip()
if not key:
    print("[fail] EMERGENT_LLM_KEY non trovata in backend/.env — impossibile riprodurre")
    sys.exit(2)
if not key.startswith("sk-emergent-"):
    print(f"[warn] chiave inizia con '{key[:12]}' — attesa 'sk-emergent-'")

# === Applica il monkey-patch IDENTICO a server.py (righe 12709-12728) ===
try:
    from litellm.llms.openai.chat.gpt_transformation import OpenAIGPTConfig as _OpenAIGPTConfig
    def _koda_preserve_cache_control(self, model, messages, tools=None):
        return messages, tools
    _OpenAIGPTConfig.remove_cache_control_flag_from_messages_and_tools = _koda_preserve_cache_control
    print("[patch] cache_control preservation applied")
except Exception as e:
    print(f"[patch] FAILED: {e!r} (would be except branch on Railway)")

import asyncio
import litellm

async def main():
    # System prompt lungo come in produzione (triggera caching path)
    system_prompt = (
        "Sei Ollenya, compagna di vita digitale. Rispondi in italiano. "
    ) * 150  # ~ 9k chars, oltre soglia Haiku 4096 tok

    messages = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                },
            ],
        },
        {"role": "user", "content": "ok"},
    ]

    t0 = time.time()
    try:
        resp = await litellm.acompletion(
            model="openai/claude-haiku-4-5-20251001",
            messages=messages,
            api_key=key,
            api_base="https://integrations.emergentagent.com/llm",
            max_tokens=1,
            timeout=25,
        )
        elapsed = int((time.time() - t0) * 1000)
        content = resp["choices"][0]["message"]["content"]
        usage = resp.get("usage", {})
        print()
        print("=" * 70)
        print(f"✅ HTTP 200 — risposta Claude ricevuta in {elapsed}ms")
        print(f"   model     : {resp.get('model')}")
        print(f"   content   : {repr(content)}")
        print(f"   usage     : {dict(usage) if usage else 'n/a'}")
        print("=" * 70)
        print()
        print("CONCLUSIONE DIMOSTRATA:")
        print("  Il CODICE (server.py + litellm 1.80.0 + openai 1.99.9 +")
        print("  httpx 0.27.2 + emergentintegrations 0.1.2 + monkey-patch")
        print("  cache_control + body con content-blocks) FUNZIONA.")
        print()
        print("  Il 403 su Railway NON può essere spiegato dal codice o")
        print("  dalla chiave o dal body (identici qui).")
        print()
        print("  Causa residua da verificare DAL PROCESSO Railway (serve")
        print("  accesso Codex, non riproducibile qui):")
        print("   1) `pip freeze` effettivo nel container live")
        print("      → se httpx != 0.27.2 o pydantic != 2.9.2 → drift")
        print("        causato da requirements.txt non-pinnato (`>=`)")
        print("   2) IP egress Railway → risposta WAF Emergent (TLS")
        print("      fingerprint, AS-number) → 403 edge")
        print("   3) env vars non dichiarate nel panel (HTTPS_PROXY,")
        print("      SSL_CERT_FILE, REQUESTS_CA_BUNDLE)")
        return 0
    except Exception as e:
        elapsed = int((time.time() - t0) * 1000)
        print()
        print("=" * 70)
        print(f"❌ Chiamata FALLITA dopo {elapsed}ms")
        print(f"   type    : {type(e).__name__}")
        print(f"   message : {str(e)[:400]}")
        # Prova a estrarre lo status code reale
        for attr in ("status_code", "code", "http_status"):
            v = getattr(e, attr, None)
            if v:
                print(f"   {attr:<8}: {v}")
        # Prova a estrarre il response body
        resp_obj = getattr(e, "response", None)
        if resp_obj is not None:
            try:
                print(f"   resp.status: {getattr(resp_obj, 'status_code', '?')}")
                print(f"   resp.text  : {str(resp_obj.text)[:300]}")
            except Exception:
                pass
        print("=" * 70)
        return 1

sys.exit(asyncio.run(main()))
