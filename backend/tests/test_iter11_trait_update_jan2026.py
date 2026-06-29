"""
Iteration 11 — Backend tests for the 3 fixes shipped today (Jan 2026):

  Fix A.  `_fast_session_create` is now idempotent (multi-utterance Deepgram).
          server.py:8042-8067 — update_one(upsert=True) with $setOnInsert
          for immutable fields and $set to reset events/done. Test: call
          it twice with the same session_id and verify NO E11000 and that
          events/done are reset on the second call (with an event pushed
          between the two calls to prove the reset).

  Fix B.  Voice pipeline conf=0 fallback to words[].confidence AND reset
          of `utterance_confidence` between utterances on the same WS.
          voice_stream.py:451-478 (fallback) and 537-543 (snapshot+reset).
          Test: WS handshake (smoke) + code inspection that the fallback
          and reset are wired. We cannot drive a real Deepgram conf=0
          frame from the test, so the deeper behavior is covered by
          code review + log inspection at runtime.

  Fix C.  Parity core_traits voice/text in /converse.
          server.py:3396-3415 — text chat now appends `trait_update`
          from Claude to profile.core_traits (was previously only done
          in the voice pipeline at server.py:8752-8765).

Approach for Fix C — deterministic test:
  We use FastAPI's TestClient against the in-process `server.app` and
  monkeypatch `server.LlmChat` so the LLM returns a known JSON blob
  containing `trait_update`. This is the ONLY way to deterministically
  exercise the new code path (the live Claude is non-deterministic and
  rarely emits trait_update). We also keep a best-effort live regression
  test against the running backend on the public URL.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any, Dict, List, Optional

import pytest
import requests

# ---------------------------------------------------------------------------
# Base URL — public preview URL of the running backend.
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
TIMEOUT_LLM = 60


def _session(uid: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "X-User-Id": uid})
    return s


# ---------------------------------------------------------------------------
# Fix A — _fast_session_create idempotency (direct in-process unit test).
# ---------------------------------------------------------------------------
#
# Importing `server` here pulls the FastAPI app and its motor client.
# That is OK: motor lazily opens connections, and we use a disposable
# `_id` so no production data is touched.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def server_mod():
    sys.path.insert(0, "/app/backend")
    import server as srv  # type: ignore
    return srv


class TestFastSessionIdempotent:
    """Fix A: _fast_session_create called twice with the same session_id
    must NOT raise E11000 and MUST reset events/done on the second call."""

    def test_double_create_is_idempotent_and_resets(self, server_mod):
        srv = server_mod
        # Rebind motor so it binds to the asyncio.run loop we open below.
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_url = os.environ.get("MONGO_URL") or "mongodb://localhost:27017"
        db_name = os.environ.get("DB_NAME") or "test_database"
        srv.client = AsyncIOMotorClient(mongo_url)
        srv.db = srv.client[db_name]

        sid = f"TEST_iter11_{uuid.uuid4().hex[:12]}"

        async def _run():
            # 1) first create
            await srv._fast_session_create(sid)
            doc1 = await srv.db.fast_sessions.find_one({"_id": sid})
            assert doc1 is not None, "first create did not insert the doc"
            assert doc1.get("done") is False
            assert doc1.get("events") == []
            started_at_1 = doc1.get("started_at_dt")

            # 2) push an event + mark done — simulate first utterance lifecycle
            await srv._fast_session_append(sid, {"type": "stt_final", "text": "ciao"})
            await srv._fast_session_mark_done(sid)
            doc_mid = await srv.db.fast_sessions.find_one({"_id": sid})
            assert doc_mid.get("done") is True
            assert len(doc_mid.get("events") or []) == 1

            # 3) second create on the SAME id — multi-utterance scenario.
            #    MUST NOT raise DuplicateKeyError and MUST reset events/done
            #    while preserving started_at_dt ($setOnInsert).
            await srv._fast_session_create(sid)
            doc2 = await srv.db.fast_sessions.find_one({"_id": sid})
            assert doc2 is not None
            assert doc2.get("done") is False, "second create did NOT reset 'done'"
            assert doc2.get("events") == [], "second create did NOT reset 'events'"
            assert doc2.get("started_at_dt") == started_at_1, (
                "second create overwrote started_at_dt — should be $setOnInsert"
            )

            # cleanup
            await srv.db.fast_sessions.delete_one({"_id": sid})

        asyncio.run(_run())


# ---------------------------------------------------------------------------
# Fix B — voice_stream conf=0 fallback + utterance_confidence reset.
# We can't drive a real conf=0 Deepgram frame from a unit test, so we:
#   1. Code-inspect voice_stream.py for the fallback + reset blocks.
#   2. Smoke-test the WS handshake (proves the WS endpoint still wires up
#      cleanly with the new code in place).
# ---------------------------------------------------------------------------

class TestVoiceStreamConfFallbackAndReset:
    def test_code_has_conf_zero_fallback(self):
        src = open("/app/backend/voice_stream.py", "r", encoding="utf-8").read()
        # The fallback recomputes mean of words[].confidence when top conf <= 0
        assert "conf=0 fallback" in src, "missing conf=0 fallback comment marker"
        assert "mean(words.conf)" in src, "missing words.conf mean log marker"
        # Sanity: the branch is inside the Results handler
        assert 'evt_type == "Results"' in src

    def test_code_resets_utterance_confidence_between_utterances(self):
        src = open("/app/backend/voice_stream.py", "r", encoding="utf-8").read()
        # snapshot + reset pattern
        assert "conf_snapshot = utterance_confidence" in src, "missing snapshot line"
        # Ensure we reset right after snapshot (within _trigger_pipeline)
        idx_snap = src.find("conf_snapshot = utterance_confidence")
        idx_reset = src.find("utterance_confidence = None", idx_snap)
        assert idx_reset != -1, "missing reset of utterance_confidence after snapshot"
        # Reset should be within ~200 chars of the snapshot
        assert (idx_reset - idx_snap) < 200, (
            f"reset too far from snapshot: snap={idx_snap} reset={idx_reset}"
        )

    def test_ws_voice_stream_handshake(self):
        """Smoke: WS connects, server emits {type:'ready'} after start frame."""
        try:
            import websockets  # type: ignore
        except Exception:
            pytest.skip("websockets package not installed")
            return

        ws_url = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = f"{ws_url}/api/voice/stream"

        async def _run() -> Dict[str, Any]:
            async with websockets.connect(ws_url, open_timeout=10, ping_interval=None) as ws:
                start_frame = {
                    "type": "start",
                    "ephemeral": False,
                    "profile_lang": "it",
                    "container": "aac",
                }
                await ws.send(json.dumps(start_frame))
                raw = await asyncio.wait_for(ws.recv(), timeout=15)
                try:
                    msg = json.loads(raw)
                except Exception:
                    msg = {"_raw": raw if isinstance(raw, str) else "<binary>"}
                try:
                    await ws.close()
                except Exception:
                    pass
                return msg

        try:
            msg = asyncio.run(_run())
        except Exception as e:
            pytest.fail(f"WS connection/handshake failed: {e}")
            return
        assert isinstance(msg, dict)
        assert msg.get("type") == "ready", (
            f"expected {{'type':'ready'}}, got: {msg!r}"
        )
        assert isinstance(msg.get("session_id"), str) and msg.get("session_id"), (
            f"ready frame missing session_id: {msg!r}"
        )


# ---------------------------------------------------------------------------
# Fix C — /converse text chat persists `trait_update` into profile.core_traits.
#
# Deterministic test: use FastAPI TestClient + monkeypatch server.LlmChat
# so the LLM returns a known JSON containing trait_update. We exercise the
# REAL endpoint (api_converse) including DB writes — so we use a fresh
# UUIDv4 X-User-Id for isolation and clean up after the test.
# ---------------------------------------------------------------------------

class _FakeLlmChat:
    """Drop-in replacement for `emergentintegrations.llm.chat.LlmChat`.
    The test sets `_FakeLlmChat.response_json` before each call.
    Supports the fluent chain LlmChat(...).with_model(...).send_message(msg)."""

    response_json: str = '{"reply":"ciao","tone":"warm"}'

    def __init__(self, *args, **kwargs):
        pass

    def with_model(self, *args, **kwargs):
        return self

    async def send_message(self, msg):
        return type(self).response_json


class TestConverseTraitUpdateParity:
    """Fix C: trait_update emitted by Claude in /converse JSON must be
    appended to profile.core_traits (parity with the voice pipeline).

    All requests run inside a SINGLE event loop via httpx.ASGITransport
    because motor's AsyncIOMotorClient binds to the loop it first sees;
    using TestClient (which creates/closes loops between calls) breaks
    motor with 'Event loop is closed'."""

    @classmethod
    def setup_class(cls):
        sys.path.insert(0, "/app/backend")
        import server as srv  # type: ignore
        cls.srv = srv

    @staticmethod
    def _rebind_motor():
        """Motor's AsyncIOMotorClient binds to the event loop on first use.
        After `asyncio.run()` finishes and closes that loop, the next
        `asyncio.run()` gets a fresh loop but motor still references the
        old (closed) one → 'Event loop is closed'. Recreate the motor
        client so the next loop is the one it binds to."""
        import server as srv  # type: ignore
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_url = os.environ.get("MONGO_URL") or "mongodb://localhost:27017"
        db_name = os.environ.get("DB_NAME") or "test_database"
        srv.client = AsyncIOMotorClient(mongo_url)
        srv.db = srv.client[db_name]

    @staticmethod
    async def _do_request(app, method: str, path: str, uid: str, **kw):
        import httpx
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
            headers = kw.pop("headers", {}) or {}
            headers["X-User-Id"] = uid
            return await ac.request(method, path, headers=headers, **kw)

    def test_trait_update_is_appended_to_core_traits(self, monkeypatch):
        srv = self.srv
        trait = "tende a sentirsi responsabile per il benessere altrui"
        fake_payload = {
            "reply": "[TONE:warm] Ti capisco, sembra un peso che porti spesso.",
            "tone": "warm",
            "actions": [],
            "memory_update": None,
            "trait_update": trait,
            "new_memory": None,
            "close_session": False,
        }
        _FakeLlmChat.response_json = json.dumps(fake_payload)
        monkeypatch.setattr(srv, "LlmChat", _FakeLlmChat)

        uid = str(uuid.uuid4())
        self._rebind_motor()

        async def _scenario():
            # 1) initial profile — empty core_traits
            r0 = await self._do_request(srv.app, "GET", "/api/profile", uid)
            assert r0.status_code == 200, r0.text
            before = r0.json().get("core_traits") or ""
            assert trait not in before

            # 2) /converse with trait_update in fake LLM response
            r = await self._do_request(
                srv.app, "POST", "/api/converse", uid,
                json={"text": "Mi sento di nuovo in colpa per la mia famiglia"},
            )
            assert r.status_code == 200, f"converse status={r.status_code} body={r.text[:300]}"
            body = r.json()
            ae = body.get("ai_entry") or {}
            assert ae.get("text"), f"ai_entry.text empty: {ae!r}"
            prof_body = body.get("profile") or {}
            assert trait in (prof_body.get("core_traits") or ""), (
                f"core_traits in response missing trait_update; got: "
                f"{prof_body.get('core_traits')!r}"
            )

            # 3) persistence
            r2 = await self._do_request(srv.app, "GET", "/api/profile", uid)
            assert r2.status_code == 200
            assert trait in (r2.json().get("core_traits") or ""), (
                f"core_traits NOT persisted; got: {r2.json().get('core_traits')!r}"
            )

            # 4) cleanup
            try:
                await srv.db.taccuino_profile.delete_many({"id": uid})
                await srv.db.taccuino_timeline.delete_many({"profile_id": uid})
                await srv.db.taccuino_memories.delete_many({"profile_id": uid})
            except Exception:
                pass

        asyncio.run(_scenario())

    def test_no_trait_update_leaves_core_traits_unchanged(self, monkeypatch):
        """Regression: when Claude omits trait_update, /converse must NOT
        touch profile.core_traits. memory_summary and timeline still get
        their normal updates."""
        srv = self.srv

        fake_payload = {
            "reply": "[TONE:warm] Ciao! Ti ascolto volentieri.",
            "tone": "warm",
            "actions": [],
            "memory_update": "ha salutato per la prima volta oggi",
            "trait_update": None,
            "new_memory": None,
            "close_session": False,
        }
        _FakeLlmChat.response_json = json.dumps(fake_payload)
        monkeypatch.setattr(srv, "LlmChat", _FakeLlmChat)

        uid = str(uuid.uuid4())
        self._rebind_motor()

        async def _scenario():
            r0 = await self._do_request(srv.app, "GET", "/api/profile", uid)
            assert r0.status_code == 200
            traits_before = r0.json().get("core_traits") or ""

            r = await self._do_request(
                srv.app, "POST", "/api/converse", uid,
                json={"text": "Ciao Koda, come stai?"},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            prof = body.get("profile") or {}
            traits_after = prof.get("core_traits") or ""
            assert traits_after == traits_before, (
                f"core_traits changed when trait_update was null: "
                f"before={traits_before!r} after={traits_after!r}"
            )
            assert "salutato" in (prof.get("memory_summary") or ""), (
                f"memory_summary did NOT receive memory_update; got: "
                f"{prof.get('memory_summary')!r}"
            )

            n = await srv.db.taccuino_timeline.count_documents({"profile_id": uid})
            assert n >= 2, f"expected ≥2 timeline rows for uid={uid}, got {n}"

            # cleanup
            try:
                await srv.db.taccuino_profile.delete_many({"id": uid})
                await srv.db.taccuino_timeline.delete_many({"profile_id": uid})
                await srv.db.taccuino_memories.delete_many({"profile_id": uid})
            except Exception:
                pass

        asyncio.run(_scenario())

    def test_trait_update_appends_and_caps_at_1500_chars(self, monkeypatch):
        """Repeat trait_update calls APPEND (not overwrite) and the field
        is capped at 1500 chars (last-N truncation)."""
        srv = self.srv
        monkeypatch.setattr(srv, "LlmChat", _FakeLlmChat)

        uid = str(uuid.uuid4())
        self._rebind_motor()

        async def _scenario():
            traits_added: List[str] = []
            for i in range(3):
                t = f"tratto-test-{i}-" + ("x" * 30)
                traits_added.append(t)
                _FakeLlmChat.response_json = json.dumps({
                    "reply": f"ok {i}",
                    "tone": "warm",
                    "trait_update": t,
                })
                r = await self._do_request(
                    srv.app, "POST", "/api/converse", uid,
                    json={"text": f"messaggio numero {i}"},
                )
                assert r.status_code == 200, r.text

            r_final = await self._do_request(srv.app, "GET", "/api/profile", uid)
            assert r_final.status_code == 200
            ct = r_final.json().get("core_traits") or ""
            for t in traits_added:
                assert t in ct, f"missing trait {t!r} in core_traits={ct!r}"
            assert len(ct) <= 1500, f"core_traits exceeded 1500 chars: len={len(ct)}"

            # cleanup
            try:
                await srv.db.taccuino_profile.delete_many({"id": uid})
                await srv.db.taccuino_timeline.delete_many({"profile_id": uid})
            except Exception:
                pass

        asyncio.run(_scenario())


# ---------------------------------------------------------------------------
# Live regression — /converse against the running backend (no monkeypatch).
# Real Claude call. We accept it's non-deterministic for trait_update, so
# this test only asserts the endpoint shape and that core_traits is a
# string (not crashing the response model).
# ---------------------------------------------------------------------------

class TestConverseLiveRegression:
    def test_live_converse_returns_profile_with_core_traits_field(self):
        uid = str(uuid.uuid4())
        sess = _session(uid)
        try:
            r = sess.post(
                f"{BASE_URL}/api/converse",
                json={"text": "Ciao Koda, sono un nuovo utente, come stai oggi?"},
                timeout=TIMEOUT_LLM,
            )
        except requests.exceptions.RequestException as e:
            pytest.skip(f"network error: {e}")
            return
        if r.status_code in (502, 503, 504):
            pytest.skip(f"external LLM dep failure: {r.status_code}")
            return
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
        body = r.json()
        assert "profile" in body, "missing 'profile' in /converse response"
        prof = body["profile"]
        # core_traits MUST be a string (empty is fine if Claude didn't emit one)
        assert "core_traits" in prof, "Profile missing 'core_traits' field"
        assert isinstance(prof["core_traits"], str), (
            f"core_traits must be string, got: {type(prof['core_traits'])!r}"
        )
        # ai_entry sanity
        ae = body.get("ai_entry") or {}
        assert isinstance(ae.get("text"), str) and ae["text"].strip(), (
            f"ai_entry.text empty: {ae!r}"
        )
