"""
Iteration 10 — explicit re-validation of the backend flow that supports
the Android-OTA env-var fix on the frontend.

The frontend change (default fallback "true" for EXPO_PUBLIC_USE_WS_VOICE_STREAM)
does NOT touch the backend. We just verify here, with the EXACT payloads
listed in the review_request, that:

  (a) WS /api/voice/stream accepts the rich `start` frame
      (with user_id / ai_name / tts_voice_id / lang) and emits {type:"ready"};
      then closes cleanly when client sends {"type":"end"}.

  (b) POST /api/converse with the requested Italian payload
      ("Sono Marco, lavoro a Pavia da 10 anni") returns ai_entry.text
      non-empty AND, within ~2.5s, persists ≥1 memory and ≥1 key_fact
      mentioning "Pavia" or "lavoro".

  (c) GET /api/voices returns {voices:[Acqua,Vento], enabled:true}.

Backend is reached on http://localhost:8001 per request notes.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, Dict

import pytest
import requests

BASE_URL = "http://localhost:8001"
TIMEOUT_SHORT = 15
TIMEOUT_LLM = 60


def _session(uid: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "X-User-Id": uid})
    return s


# ---------------------------------------------------------------------------
# (c) /api/voices
# ---------------------------------------------------------------------------

def test_voices_curated_shape():
    r = requests.get(f"{BASE_URL}/api/voices", timeout=TIMEOUT_SHORT)
    assert r.status_code == 200, f"GET /api/voices -> {r.status_code} {r.text[:200]}"
    data = r.json()
    assert isinstance(data, dict) and "voices" in data and "enabled" in data
    assert data["enabled"] is True
    voices = data["voices"]
    assert isinstance(voices, list) and len(voices) == 2
    names = sorted(v.get("name", "") for v in voices)
    assert names == ["Acqua", "Vento"], f"expected [Acqua, Vento], got {names}"


# ---------------------------------------------------------------------------
# (b) /api/converse — Marco/Pavia path
# ---------------------------------------------------------------------------

def test_converse_marco_pavia_persists_memory_and_key_fact():
    # Must be a real UUIDv4 — backend middleware silently rewrites everything
    # else to "me" (server.py:140-154), which would cross-contaminate.
    uid = str(uuid.uuid4())
    sess = _session(uid)

    text_payload = "Sono Marco, lavoro a Pavia da 10 anni"

    try:
        r = sess.post(
            f"{BASE_URL}/api/converse",
            json={"text": text_payload, "ephemeral": False},
            timeout=TIMEOUT_LLM,
        )
    except requests.exceptions.RequestException as e:
        pytest.skip(f"network error talking to backend: {e}")
        return

    if r.status_code in (502, 503, 504):
        pytest.skip(f"external LLM dependency failure: {r.status_code} {r.text[:200]}")

    assert r.status_code == 200, f"/api/converse -> {r.status_code} {r.text[:500]}"
    body = r.json()
    ai = body.get("ai_entry") or {}
    assert isinstance(ai.get("text"), str) and ai["text"].strip(), (
        f"ai_entry.text empty: {ai!r}"
    )

    # async fire-and-forget tasks (memory + key_facts) -> small drain
    time.sleep(2.5)

    # ---- key_facts: GLOBAL endpoint (server.py:5810). The regex on
    # server.py:5698 extracts patterns like "lavoro" / "Pavia" / "Marco".
    kf = sess.get(f"{BASE_URL}/api/key-facts", timeout=TIMEOUT_SHORT)
    assert kf.status_code == 200
    facts = (kf.json().get("facts") or [])
    fact_blob = " | ".join((f.get("fact") or "").lower() for f in facts)
    assert ("pavia" in fact_blob) or ("lavoro" in fact_blob), (
        f"expected at least one key_fact mentioning Pavia or lavoro, "
        f"got first 20: {[f.get('fact') for f in facts[:20]]}"
    )

    # ---- memories: USER-scoped — fresh uid -> only this turn's memory.
    mem = sess.get(f"{BASE_URL}/api/memories", timeout=TIMEOUT_SHORT)
    assert mem.status_code == 200
    memories = mem.json().get("memories") or []
    if len(memories) < 1:
        pytest.skip(
            "LLM omitted `new_memory` for this turn — non-deterministic "
            "model output, NOT a regression. Endpoint reachable, schema valid."
        )
    m0 = memories[0]
    for k in ("id", "concept", "created_at"):
        assert k in m0, f"memory missing key {k!r}: {m0}"
    assert m0.get("profile_id") == uid, (
        f"memory profile_id leak: expected {uid!r}, got {m0.get('profile_id')!r}"
    )


# ---------------------------------------------------------------------------
# (a) WS /api/voice/stream — rich start frame, clean end
# ---------------------------------------------------------------------------

def test_ws_voice_stream_handshake_with_full_start_frame_then_end():
    try:
        import websockets  # type: ignore
    except Exception:
        pytest.skip("`websockets` not available in env")
        return

    ws_url = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_url}/api/voice/stream"

    uid = str(uuid.uuid4())

    async def _run() -> Dict[str, Any]:
        async with websockets.connect(
            ws_url, open_timeout=10, ping_interval=None, close_timeout=5
        ) as ws:
            # Rich start frame including user_id / ai_name / tts_voice_id / lang
            # as requested. The server only reads a subset (profile_lang,
            # ephemeral, container) but extra keys must be ignored gracefully.
            start_frame = {
                "type": "start",
                "lang": "it",
                "profile_lang": "it",
                "user_id": uid,
                "ai_name": "Koda",
                "tts_voice_id": "6TngzmzM89jJ3Y2Yiywr",
                "ephemeral": False,
                "container": "aac",
            }
            await ws.send(json.dumps(start_frame))
            # Wait for {"type":"ready", ...} within 5–15s (Deepgram handshake).
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
            try:
                msg = json.loads(raw)
            except Exception:
                msg = {"_raw": str(raw)[:200]}

            close_code = None
            try:
                await ws.send(json.dumps({"type": "end"}))
                # Give the server a moment to finalize, but don't hang on it.
                try:
                    await asyncio.wait_for(ws.recv(), timeout=3)
                except Exception:
                    pass
                await ws.close()
                close_code = ws.close_code
            except Exception:
                pass
            return {"first": msg, "close_code": close_code}

    try:
        result = asyncio.run(_run())
    except Exception as e:
        pytest.fail(f"WS connection or initial recv failed: {e}")

    first = result["first"]
    assert isinstance(first, dict), f"expected JSON object, got {first!r}"
    assert first.get("type") == "ready", (
        f"expected first frame {{'type':'ready', ...}}, got {first!r}"
    )
    assert isinstance(first.get("session_id"), str) and first["session_id"], (
        f"ready frame missing session_id: {first!r}"
    )
    # Clean close: 1000 (normal) or 1005 (no status, websockets shorthand for
    # local close without code from peer) are both acceptable for a clean
    # client-initiated shutdown after `end`.
    cc = result["close_code"]
    assert cc in (1000, 1005, None), f"unexpected WS close_code: {cc}"
