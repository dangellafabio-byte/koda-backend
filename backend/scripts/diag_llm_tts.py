#!/usr/bin/env python3
"""
Diagnostico Railway — LLM + TTS. Nessun endpoint HTTP, nessuna chiave stampata.

Uso (dentro il container Railway, terminale):
    cd /app
    python backend/scripts/diag_llm_tts.py <user_email>

Esegue:
  1. Una SINGOLA chiamata litellm.acompletion con esattamente la stessa
     configurazione usata da api_converse (model, api_base, header schema,
     cache_control content block, timeout). Zero retry.
  2. Una SINGOLA chiamata TTS attraverso il dispatcher reale di produzione
     (`_tts_provider_for_uid` → ElevenLabs o Inworld in base al pref DB
     per `user_email`). Testo breve ("Ciao"), zero retry.

Stampa UN SOLO JSON su stdout. Nessuna credenziale è letta per essere stampata.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Prepara il path come lo vede uvicorn in Railway
_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

# Il server carica .env automaticamente via dotenv in server.py. Lo imitiamo
# qui senza stampare nulla.
try:
    from dotenv import load_dotenv
    load_dotenv(_BACKEND / ".env", override=False)
except Exception:
    pass


def _mask_bool(v: str) -> bool:
    """Non ritornare mai valori, solo flag di presenza."""
    return bool((v or "").strip())


async def probe_llm() -> dict:
    """Riproduce EXACTLY la chiamata di api_converse (riga 9168-9183)."""
    import httpx
    import litellm

    out = {
        "python": sys.version.split()[0],
        "httpx": getattr(httpx, "__version__", "?"),
        "litellm": getattr(litellm, "__version__", "?"),
        "env_flags": {
            "EMERGENT_LLM_KEY_set": _mask_bool(os.environ.get("EMERGENT_LLM_KEY")),
            "HTTPS_PROXY_set": _mask_bool(os.environ.get("HTTPS_PROXY")),
            "HTTP_PROXY_set": _mask_bool(os.environ.get("HTTP_PROXY")),
            "OPENAI_API_BASE_set": _mask_bool(os.environ.get("OPENAI_API_BASE")),
            "OPENAI_BASE_URL_set": _mask_bool(os.environ.get("OPENAI_BASE_URL")),
            "LITELLM_PROXY_API_BASE_set": _mask_bool(
                os.environ.get("LITELLM_PROXY_API_BASE")
            ),
        },
    }

    # Egress IP (via api.ipify.org, servizio pubblico)
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get("https://api.ipify.org?format=json")
            out["egress_ip"] = r.json().get("ip") if r.status_code == 200 else None
    except Exception as e:
        out["egress_ip"] = f"err:{type(e).__name__}"

    key = os.environ.get("EMERGENT_LLM_KEY", "").strip()
    api_base = "https://integrations.emergentagent.com/llm"
    # Imposta tutto l'ambiente come fa server.py all'avvio
    os.environ["OPENAI_API_KEY"] = key  # litellm richiede OPENAI_API_KEY per rotta openai/

    # Stessa esatta chiamata di api_converse (zero retry: `num_retries=0`)
    t0 = time.time()
    try:
        litellm.drop_params = True
        litellm.num_retries = 0
        litellm.set_verbose = False
        resp = await litellm.acompletion(
            model="openai/claude-haiku-4-5-20251001",
            messages=[
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": "Sei un assistente. Rispondi 'pong'.",
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                },
                {"role": "user", "content": "ping"},
            ],
            api_base=api_base,
            api_key=key,
            max_tokens=5,
            timeout=20,
            num_retries=0,
        )
        out["llm_call"] = {
            "status": "ok",
            "elapsed_ms": int((time.time() - t0) * 1000),
            "sample": (resp.choices[0].message.content or "")[:60],
        }
    except Exception as e:
        # Catchiamo litellm.APIError per estrarre più dettagli
        msg = str(e)[:500]
        err_type = type(e).__name__
        # Rimuoviamo qualsiasi occorrenza accidentale di prefissi chiave
        if key:
            msg = msg.replace(key, "[REDACTED]")
            if len(key) >= 10:
                msg = msg.replace(key[:10], "[REDACTED]")
                msg = msg.replace(key[-6:], "[REDACTED]")
        out["llm_call"] = {
            "status": "fail",
            "elapsed_ms": int((time.time() - t0) * 1000),
            "error_type": err_type,
            "error_msg": msg,
            "error_is_html_403": "<title>403</title>" in msg,
        }

    # Edge diagnostico: GET root per vedere header del load balancer
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as c:
            r2 = await c.get(f"{api_base}/")
            interesting = {}
            for h in [
                "server", "via", "cf-ray", "x-google-backend",
                "x-envoy-upstream-service-time", "x-request-id",
                "x-emergent-request-id", "x-amzn-trace-id", "content-type",
            ]:
                v = r2.headers.get(h)
                if v:
                    interesting[h] = v[:200]
            out["edge_root"] = {
                "status": r2.status_code,
                "headers": interesting,
                "body_first_80": r2.text[:80],
            }
    except Exception as e:
        out["edge_root"] = {"error": f"{type(e).__name__}: {str(e)[:100]}"}

    return out


async def probe_tts(user_email: str) -> dict:
    """Esegue 1 chiamata TTS reale attraverso il dispatcher di produzione."""
    out = {"email_input": user_email}
    # Import tardivo per non caricare mongo/elevenlabs se non serve
    try:
        import server as _server  # noqa
    except Exception as e:
        out["error"] = f"import server failed: {type(e).__name__}: {str(e)[:200]}"
        return out

    email_norm = user_email.strip().lower()
    uid = _server._email_to_uid(email_norm)
    out["uid_derived"] = uid

    # Legge il pref dal DB
    try:
        doc = await _server.db[_server._koda_tts_prefs.PREFS_COLLECTION].find_one(
            {"user_id": uid}
        )
        if doc:
            doc["_id"] = str(doc.get("_id", ""))
            if "updated_at" in doc and hasattr(doc["updated_at"], "isoformat"):
                doc["updated_at"] = doc["updated_at"].isoformat()
        out["prefs_doc"] = doc
    except Exception as e:
        out["prefs_doc_error"] = f"{type(e).__name__}: {str(e)[:200]}"

    resolved = await _server._tts_provider_for_uid(uid)
    out["provider_resolved"] = resolved

    text = "Ciao"
    voice_id = "6TngzmzM89jJ3Y2Yiywr"  # Cielo female (same as frontend default)
    actual = "unknown"
    size = 0
    error = None
    t0 = time.time()
    if resolved == "inworld" and _server._INWORLD_ADAPTER_AVAILABLE:
        try:
            audio = await _server._inworld_dispatcher.generate_non_streaming(
                _server.db,
                text=text,
                user_id=uid,
                endpoint="diag_script",
                voice_id_requested=voice_id,
                tone="neutral",
            )
            actual = "inworld"
            size = len(audio) if audio else 0
        except _server._inworld_dispatcher.InworldVoiceNotAvailable as e:
            actual = "inworld_vento_guard"
            error = str(e)[:200]
        except _server._inworld_tts.InworldTTSError as e:
            actual = "inworld_error"
            error = f"{type(e).__name__}: {str(e)[:200]}"
        except Exception as e:
            actual = "inworld_unexpected"
            error = f"{type(e).__name__}: {str(e)[:200]}"
    else:
        try:
            def _sync_el():
                el = _server._get_eleven_client()
                if not el:
                    return b""
                audio = bytearray()
                for c in el.text_to_speech.convert(
                    text=text, voice_id=voice_id,
                    model_id="eleven_flash_v2_5",
                    output_format="mp3_44100_128",
                    language_code="it",
                ):
                    if c:
                        audio.extend(c)
                return bytes(audio)
            audio = await asyncio.to_thread(_sync_el)
            actual = "elevenlabs"
            size = len(audio) if audio else 0
        except Exception as e:
            actual = "elevenlabs_error"
            error = f"{type(e).__name__}: {str(e)[:200]}"

    out["provider_actual"] = actual
    out["audio_bytes"] = size
    out["elapsed_ms"] = int((time.time() - t0) * 1000)
    out["error"] = error
    out["match"] = resolved == actual
    return out


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing_arg", "hint": "python diag_llm_tts.py <email>"}, indent=2))
        sys.exit(2)
    email = sys.argv[1].strip()
    report = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    report["llm_probe"] = await probe_llm()
    report["tts_probe"] = await probe_tts(email)
    # Output single JSON, no stray prints
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
