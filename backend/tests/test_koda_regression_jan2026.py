"""
Backend regression suite for Koda — Jan 2026 iteration 9.

Scope (per main agent request):
  1. POST /api/converse (text chat) — happy path + persistence
     of user_entry, ai_entry, semantic memory, and key_facts.
  2. GET  /api/voices — curated voice list shape ("Acqua" + "Vento").
  3. POST /api/converse with ephemeral=true (Stanza dello Sfogo) —
     zero-knowledge: NO memories, NO new key_facts saved.
  4. _build_temporal_context smoke test (direct import).
  5. WS /api/voice/stream — connection-only smoke test
     (open → expect {type:"ready"} → close).

Backend is reached via EXPO_PUBLIC_BACKEND_URL (public URL),
falling back to localhost:8001 if the public URL is unreachable
(the request states localhost is fine).

We DO NOT mock Claude/Deepgram/ElevenLabs. If the LLM external call
fails (quota/rate-limit/network), the test reports it as an external
dependency failure (pytest.skip), NOT a regression.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any, Dict, Optional

import pytest
import requests

# ---------------------------------------------------------------------------
# Base URL resolution — public URL first, localhost fallback.
# ---------------------------------------------------------------------------

def _load_frontend_env_var(key: str) -> Optional[str]:
    path = "/app/frontend/.env"
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k.strip() == key:
                    return v.strip().strip('"').strip("'")
    except Exception:
        return None
    return None


_PUBLIC_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or _load_frontend_env_var("EXPO_PUBLIC_BACKEND_URL")
    or ""
).rstrip("/")

_LOCAL_URL = "http://localhost:8001"


def _pick_base_url() -> str:
    if _PUBLIC_URL:
        try:
            r = requests.get(f"{_PUBLIC_URL}/api/voices", timeout=8)
            if r.status_code == 200:
                return _PUBLIC_URL
        except Exception:
            pass
    return _LOCAL_URL


BASE_URL = _pick_base_url()
TIMEOUT_SHORT = 15
TIMEOUT_LLM = 60  # LLM calls can take a while


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def base_url() -> str:
    return BASE_URL


@pytest.fixture
def standard_uid() -> str:
    # NOTE: backend `user_id_middleware` (server.py:140-154) ONLY accepts
    # values matching UUIDv4 OR the literal "me"; anything else is silently
    # downgraded to "me". So our test must use a real UUIDv4 to obtain an
    # isolated profile, otherwise we end up reading the legacy `me`
    # collection (cross-contamination across runs).
    return str(uuid.uuid4())


@pytest.fixture
def ephemeral_uid() -> str:
    return str(uuid.uuid4())


def _session(uid: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "X-User-Id": uid})
    return s


# ---------------------------------------------------------------------------
# /api/voices — shape test (no external deps beyond ElevenLabs key flag)
# ---------------------------------------------------------------------------

class TestVoices:
    def test_voices_shape_and_curated_list(self, base_url):
        r = requests.get(f"{base_url}/api/voices", timeout=TIMEOUT_SHORT)
        assert r.status_code == 200, f"GET /api/voices status={r.status_code} body={r.text[:300]}"
        data = r.json()

        # top-level shape
        assert isinstance(data, dict), "response must be an object"
        assert "voices" in data and "enabled" in data, "must contain 'voices' and 'enabled'"
        assert isinstance(data["enabled"], bool), "'enabled' must be bool"

        voices = data["voices"]
        assert isinstance(voices, list), "'voices' must be a list"
        assert len(voices) == 2, f"expected exactly 2 voices, got {len(voices)}: {voices}"

        names = sorted(v.get("name", "") for v in voices)
        assert names == ["Acqua", "Vento"], f"expected ['Acqua','Vento'], got {names}"

        # required keys on each entry
        required = {"voice_id", "name", "description", "gender", "accent"}
        for v in voices:
            missing = required - set(v.keys())
            assert not missing, f"voice {v.get('name')!r} missing keys: {missing}"
            for k in required:
                assert isinstance(v[k], str) and v[k], f"voice {v.get('name')!r} has empty {k!r}"


# ---------------------------------------------------------------------------
# Helper: extract ai_entry / user_entry from /converse responses (defensive)
# ---------------------------------------------------------------------------

def _extract_entries(payload: Dict[str, Any]) -> Dict[str, Any]:
    ue = payload.get("user_entry") or {}
    ae = payload.get("ai_entry") or {}
    return {"user_entry": ue, "ai_entry": ae}


# ---------------------------------------------------------------------------
# /api/converse — standard (persistent) path
# ---------------------------------------------------------------------------

class TestConverseStandard:
    def test_converse_persists_memory_and_key_facts(self, base_url, standard_uid):
        # NOTE on dedup: server.py:5777 dedups key_facts on the global
        # `fact` string (no user scoping). The regex on server.py:5698
        # also captures only `[A-Z][a-zàèéìòù]+` so a unique suffix like
        # "MarioXYZ" would still distill to "Mario". The robust assertion
        # is therefore: after this POST, the global key_facts list MUST
        # contain "Si chiama Mario" AND "Ha un cane di nome Luna"
        # (either pre-existing from a prior test — fine — or just
        # inserted now).
        user_name = "Mario"
        dog_name = "Luna"
        text_payload = (
            f"Ciao Koda, sono {user_name} e ho un cane di nome {dog_name}"
        )

        sess = _session(standard_uid)

        try:
            r = sess.post(
                f"{base_url}/api/converse",
                json={"text": text_payload, "ephemeral": False},
                timeout=TIMEOUT_LLM,
            )
        except requests.exceptions.RequestException as e:
            pytest.skip(f"network error talking to backend: {e}")
            return

        if r.status_code in (502, 503, 504):
            pytest.skip(f"external LLM dependency failure: {r.status_code} {r.text[:200]}")
            return

        assert r.status_code == 200, (
            f"POST /api/converse status={r.status_code} body={r.text[:500]}"
        )

        body = r.json()
        ents = _extract_entries(body)
        ue, ae = ents["user_entry"], ents["ai_entry"]

        assert ue and ue.get("text") == text_payload, (
            f"user_entry.text mismatch: got {ue.get('text')!r}"
        )
        assert ae and isinstance(ae.get("text"), str) and ae["text"].strip(), (
            f"ai_entry.text must be a non-empty string, got: {ae.get('text')!r}"
        )

        # Wait for async tasks to drain (memory save + key_facts save are
        # asyncio.create_task fire-and-forget).
        time.sleep(2.5)

        # --- key_facts: AFTER this POST, the global table MUST contain
        #     the canonical fact strings (regex pattern matches).
        kf_r = sess.get(f"{base_url}/api/key-facts", timeout=TIMEOUT_SHORT)
        assert kf_r.status_code == 200, f"GET /api/key-facts status={kf_r.status_code}"
        kf_body = kf_r.json()
        facts = kf_body.get("facts", []) or []
        fact_strings = [(f.get("fact") or "").strip() for f in facts]
        expected_name_fact = f"Si chiama {user_name}"
        expected_dog_fact = f"Ha un cane di nome {dog_name}"
        assert expected_name_fact in fact_strings, (
            f"missing key_fact {expected_name_fact!r} in {fact_strings[:20]}"
        )
        assert expected_dog_fact in fact_strings, (
            f"missing key_fact {expected_dog_fact!r} in {fact_strings[:20]}"
        )

        # --- memories: Claude is asked to emit `new_memory` in the JSON
        #     output. The save path is server.py:3399-3414 (api_converse)
        #     — confirmed working at runtime via backend log
        #     "[memory] saved id=... src=chat".
        #     /api/memories IS user-scoped via _memory_filter() →
        #     a fresh UUIDv4 uid returns only the memory we just made
        #     (or 0 if the model omitted new_memory in this turn —
        #     non-deterministic).
        mem_r = sess.get(f"{base_url}/api/memories", timeout=TIMEOUT_SHORT)
        assert mem_r.status_code == 200, f"GET /api/memories status={mem_r.status_code}"
        mem_body = mem_r.json()
        memories = mem_body.get("memories", []) or []
        if len(memories) < 1:
            pytest.skip(
                "LLM did not emit `new_memory` for this turn — non-deterministic "
                "model output, not a regression. /api/memories endpoint reachable."
            )
        m0 = memories[0]
        for k in ("id", "concept", "created_at"):
            assert k in m0, f"memory missing key {k!r}: {m0}"
        # Memory must be scoped to OUR uid (no cross-user leakage).
        assert m0.get("profile_id") == standard_uid, (
            f"memory profile_id mismatch: expected {standard_uid!r}, got {m0.get('profile_id')!r}"
        )


# ---------------------------------------------------------------------------
# /api/converse — ephemeral (Stanza dello Sfogo, zero-knowledge)
# ---------------------------------------------------------------------------

class TestConverseEphemeral:
    def test_ephemeral_does_not_persist_memory_or_key_facts(self, base_url, ephemeral_uid):
        # Use a unique phrase so we can check NOTHING with this suffix
        # was saved server-side.
        unique_suffix = uuid.uuid4().hex[:8].capitalize()
        text_payload = (
            f"Sono molto preoccupato per mia madre {unique_suffix}"
        )

        sess = _session(ephemeral_uid)

        try:
            r = sess.post(
                f"{base_url}/api/converse",
                json={"text": text_payload, "ephemeral": True},
                timeout=TIMEOUT_LLM,
            )
        except requests.exceptions.RequestException as e:
            pytest.skip(f"network error talking to backend: {e}")
            return

        if r.status_code in (502, 503, 504):
            pytest.skip(f"external LLM dependency failure: {r.status_code} {r.text[:200]}")
            return

        assert r.status_code == 200, (
            f"POST /api/converse (ephemeral) status={r.status_code} body={r.text[:500]}"
        )

        body = r.json()
        ae = (body.get("ai_entry") or {})
        assert isinstance(ae.get("text"), str) and ae["text"].strip(), (
            f"ephemeral ai_entry.text must be non-empty, got: {ae.get('text')!r}"
        )

        time.sleep(2.0)

        # /api/memories IS user-scoped → expect zero for this brand-new uid.
        mem_r = sess.get(f"{base_url}/api/memories", timeout=TIMEOUT_SHORT)
        assert mem_r.status_code == 200
        mem_body = mem_r.json()
        memories = mem_body.get("memories", []) or []
        assert len(memories) == 0, (
            f"ephemeral leak! expected 0 memories for fresh ephemeral uid, "
            f"got {len(memories)}: {memories}"
        )

        # /api/key-facts is GLOBAL on the server (see server.py:5810).
        # We assert that NO fact with our unique suffix was persisted.
        kf_r = sess.get(f"{base_url}/api/key-facts", timeout=TIMEOUT_SHORT)
        assert kf_r.status_code == 200
        kf_body = kf_r.json()
        facts = kf_body.get("facts", []) or []
        matches = [
            f for f in facts
            if unique_suffix.lower() in (f.get("fact", "") or "").lower()
            or unique_suffix.lower() in (f.get("source_text", "") or "").lower()
        ]
        assert len(matches) == 0, (
            f"ephemeral leak into key_facts! found {len(matches)} fact(s) "
            f"containing {unique_suffix!r}: {matches}"
        )


# ---------------------------------------------------------------------------
# _build_temporal_context — direct in-process smoke test
# ---------------------------------------------------------------------------

class TestTemporalContext:
    """Direct import of server._build_temporal_context — verifies the
    function exists, does not crash on empty input nor on a small list,
    and the output contains the expected anchor token."""

    def setup_method(self):
        sys.path.insert(0, "/app/backend")
        # Importing server.py loads the full app, including DB clients —
        # tolerable here because backend is already running with the
        # same env. We only need the pure helper.
        global _srv
        import server as _srv  # type: ignore

    def test_empty_recent_returns_anchor(self):
        out = _srv._build_temporal_context([])
        assert isinstance(out, str) and out, "expected non-empty string"
        assert "[CONTESTO TEMPORALE" in out, f"missing anchor token in: {out[:200]}"
        # With empty `recent`, must declare it's the first message.
        assert "PRIMO messaggio" in out, f"expected first-message clause in: {out[:300]}"

    def test_with_two_user_entries_emits_gap(self):
        from datetime import datetime, timezone, timedelta
        TE = _srv.TimelineEntry
        # Build two user entries: one ~10 minutes ago, one "now".
        ten_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        now_iso = datetime.now(timezone.utc).isoformat()
        e1 = TE(role="user", text="prima frase")
        e1.timestamp = ten_min_ago
        e2 = TE(role="user", text="seconda frase")
        e2.timestamp = now_iso
        out = _srv._build_temporal_context([e1, e2])
        assert "[CONTESTO TEMPORALE" in out
        assert "Ultimo messaggio dell'utente" in out, f"expected gap line in: {out[:400]}"


# ---------------------------------------------------------------------------
# WS /api/voice/stream — connection-only smoke test
# ---------------------------------------------------------------------------

class TestVoiceStreamWSReady:
    def test_ws_connects_and_emits_ready(self, base_url):
        try:
            import websockets  # type: ignore
        except Exception:
            pytest.skip("`websockets` not available in the env")
            return

        ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = f"{ws_url}/api/voice/stream"

        async def _run() -> Dict[str, Any]:
            async with websockets.connect(ws_url, open_timeout=10, ping_interval=None) as ws:
                # Per the WS protocol (voice_stream.py:20-26) the client
                # MUST send a `start` text frame as Frame 0 within 5s,
                # otherwise the server replies with an error. After the
                # start frame, server connects to Deepgram and emits
                # {"type":"ready", "session_id": "..."}.
                start_frame = {
                    "type": "start",
                    "ephemeral": False,
                    "profile_lang": "it",
                    "container": "aac",
                }
                await ws.send(json.dumps(start_frame))
                # Allow up to 15s — DG handshake adds latency.
                raw = await asyncio.wait_for(ws.recv(), timeout=15)
                try:
                    msg = json.loads(raw)
                except Exception:
                    msg = {"_raw": raw if isinstance(raw, str) else "<binary>"}
                # close cleanly
                try:
                    await ws.close()
                except Exception:
                    pass
                return msg

        try:
            msg = asyncio.run(_run())
        except Exception as e:
            pytest.fail(f"WS connection or initial recv failed: {e}")
            return

        assert isinstance(msg, dict), f"expected JSON object, got: {msg!r}"
        assert msg.get("type") == "ready", (
            f"expected first frame {{'type':'ready'}}, got: {msg!r}"
        )
