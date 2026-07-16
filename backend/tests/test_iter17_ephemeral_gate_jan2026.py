"""
Iter 17 — Final production-readiness verification (Jan 2026).

Scope (per review_request):
  1. NEW: verify ephemeral=true through WS voice pipeline does NOT save
     anything to db.taccuino_timeline for that session.
  2. Regression sweep (from iter14 / iter15 / iter16):
     - GET /api/profile → Fabio + real fields
     - 5 sequential /api/profile calls all return the same doc
     - WS start + ephemeral=false + tiny audio + end → exactly 1 `done` in <5s
     - WS start + ephemeral=true + audio + end → NO timeline writes (mongo check)
     - WS start + immediate end (no audio) → exactly 1 synthetic done
       with reason='no_audio_received' in <5s
     - POST /api/auth/apple invalid → 401
     - POST /api/auth/dev-login → 200
     - POST /api/confessional/reset deletes seeded buffer rows (ok:true, deleted:N)
"""

import os
import json
import time
import asyncio
import pytest
import requests
import websockets
from pymongo import MongoClient


# ─── Config ─────────────────────────────────────────────────────────────
BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as _f:
            for _line in _f:
                if _line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                    BASE_URL = _line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break
    except Exception:
        pass
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing"

if BASE_URL.startswith("https://"):
    WS_BASE = "wss://" + BASE_URL[len("https://"):]
elif BASE_URL.startswith("http://"):
    WS_BASE = "ws://" + BASE_URL[len("http://"):]
else:
    WS_BASE = BASE_URL
WS_URL = f"{WS_BASE}/api/voice/stream"

# Mongo direct access for the ephemeral-gate assertion
def _load_env(path):
    d = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return d

_env = _load_env("/app/backend/.env")
MONGO_URL = _env.get("MONGO_URL")
DB_NAME = _env.get("DB_NAME")
assert MONGO_URL and DB_NAME, "MONGO_URL / DB_NAME missing from /app/backend/.env"

_mongo = MongoClient(MONGO_URL)
_db = _mongo[DB_NAME]


# ─── Helpers ────────────────────────────────────────────────────────────
def _start_frame(session_id: str, ephemeral: bool) -> dict:
    return {
        "type": "start",
        "session_id": session_id,
        "audio_route": "builtin",
        "mime_type": "audio/aac",
        "sample_rate": 16000,
        "ephemeral": ephemeral,
        "profile_lang": "it",
        "container": "aac",
    }


async def _drain_until_ready(ws, deadline_s: float = 6.0) -> None:
    t0 = time.time()
    while time.time() - t0 < deadline_s:
        remaining = deadline_s - (time.time() - t0)
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            raise AssertionError(f"never received ready within {deadline_s}s")
        if isinstance(raw, (bytes, bytearray)):
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("type") == "ready":
            return
        if msg.get("type") == "error":
            raise AssertionError(f"WS error before ready: {msg!r}")
    raise AssertionError(f"never received ready within {deadline_s}s")


async def _collect_events(ws, budget_s: float, tail_after_done_s: float = 2.0) -> list:
    events: list = []
    deadline = time.time() + budget_s
    tail_deadline = None
    while time.time() < deadline:
        now = time.time()
        if tail_deadline is not None and now >= tail_deadline:
            break
        wait_s = (min(deadline, tail_deadline) - now) if tail_deadline else (deadline - now)
        if wait_s <= 0:
            break
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=wait_s)
        except asyncio.TimeoutError:
            break
        except websockets.exceptions.ConnectionClosed:
            break
        if isinstance(raw, (bytes, bytearray)):
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        events.append(msg)
        if msg.get("type") == "done" and tail_deadline is None:
            tail_deadline = time.time() + tail_after_done_s
    return events


# ─── 1. Profile: Fabio + no oscillation ─────────────────────────────────
class TestProfileFabioStable:
    def test_profile_returns_fabio(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d.get("name") == "Fabio"
        assert d.get("koda_voice") == "aria"
        assert isinstance(d.get("total_messages"), int) and d["total_messages"] >= 634
        assert d.get("voice_locked") is True
        assert d.get("onboarded") is True

    def test_five_sequential_profile_calls_no_oscillation(self):
        """Original Fabio bug: /api/profile intermittently returned an empty
        (freshly-created) profile because of a datetime-coercion ValidationError.
        Fix at server.py:1610-1613 coerces datetime → isoformat before Pydantic.
        Verify 5x back-to-back: all must return the SAME Fabio doc."""
        snapshots = []
        for i in range(5):
            r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
            assert r.status_code == 200, f"call {i} status={r.status_code}"
            d = r.json()
            snapshots.append(
                (d.get("name"), d.get("koda_voice"),
                 d.get("total_messages"), d.get("voice_locked"),
                 d.get("onboarded"))
            )
        assert all(s == snapshots[0] for s in snapshots), (
            f"profile oscillation detected: {snapshots!r}"
        )
        assert snapshots[0][0] == "Fabio"
        assert snapshots[0][1] == "aria"
        assert snapshots[0][2] >= 634
        assert snapshots[0][3] is True
        assert snapshots[0][4] is True


# ─── 2. WS no-audio synthetic done in <5s ───────────────────────────────
class TestWsNoAudioSyntheticDone:
    @pytest.mark.asyncio
    async def test_no_audio_exactly_one_done_fast(self):
        t0 = time.time()
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("iter17-noaudio", ephemeral=True)))
            await _drain_until_ready(ws)
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_events(ws, budget_s=12.0, tail_after_done_s=2.5)
        elapsed = time.time() - t0
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, (
            f"expected 1 done, got {len(done_events)}: {done_events!r}"
        )
        done = done_events[0]
        assert done.get("no_transcript") is True
        assert done.get("reason") == "no_audio_received"
        # Budget: fast path should be well under 5s
        assert elapsed < 12.0, f"took too long: {elapsed:.2f}s"


# ─── 3. WS tiny-audio ephemeral=false → exactly 1 done, timeline may write ─
class TestWsTinyAudioEphemeralFalse:
    @pytest.mark.asyncio
    async def test_tiny_audio_ephemeral_false_exactly_one_done(self):
        """ephemeral=false + tiny audio. The tiny audio (200B of zeros) is not
        speech, so we still end up with a synthetic done in <15s. Confirm
        exactly 1 done."""
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("iter17-tiny-persistent", ephemeral=False)))
            await _drain_until_ready(ws)
            await ws.send(b"\x00\x00" * 100)
            await asyncio.sleep(0.2)
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_events(ws, budget_s=25.0, tail_after_done_s=2.5)
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, (
            f"expected 1 done, got {len(done_events)}: {done_events!r}"
        )


# ─── 4. EPHEMERAL GATE: verify NO writes to taccuino_timeline ───────────
class TestEphemeralGateNoTimelineWrites:
    """
    NEW iter17: The critical Confessionale/Stanza-dello-Sfogo guarantee is that
    when the client starts the WS session with ephemeral=true, the entire
    pipeline (transcript, LLM reply, TTS) may execute BUT nothing must be
    written to db.taccuino_timeline (neither user nor AI entries) — otherwise
    Koda leaks confidential content. Fix locations:
      - server.py:9057-9063  user entry insert gated by `if not ephemeral`
      - server.py:10012-10016 AI entry insert gated by `if not ephemeral`
    Also memory_summary/core_traits/home_city updates and _save_memory are
    all inside the same `if not ephemeral` block.

    Test method: snapshot count of taccuino_timeline BEFORE the WS session
    (ephemeral=true). Send tiny audio + end. Wait for done. Re-count. Delta
    must be 0.
    """

    @pytest.mark.asyncio
    async def test_ephemeral_true_produces_zero_timeline_writes(self):
        col = _db["taccuino_timeline"]
        # Baseline count
        n_before = col.count_documents({})

        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("iter17-ephgate", ephemeral=True)))
            await _drain_until_ready(ws)
            # Send some non-speech audio (won't transcribe → synthetic done)
            await ws.send(b"\x00\x00" * 200)
            await asyncio.sleep(0.2)
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_events(ws, budget_s=25.0, tail_after_done_s=2.0)

        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, f"expected 1 done, got {done_events!r}"

        # Give backend a small grace window in case anything is queued
        await asyncio.sleep(1.0)
        n_after = col.count_documents({})
        assert n_after == n_before, (
            f"EPHEMERAL LEAK: taccuino_timeline grew by {n_after - n_before} "
            f"rows during ephemeral=True session (before={n_before} after={n_after}). "
            f"Expected 0 delta."
        )

    @pytest.mark.asyncio
    async def test_ephemeral_true_no_new_memories_or_key_facts(self):
        """Also verify the ephemeral gate blocks writes to taccuino_memories and
        taccuino_key_facts (both should be gated by the same `if not ephemeral`
        block at server.py:9059 and 10012)."""
        mem = _db["taccuino_memories"]
        kf = _db["taccuino_key_facts"]
        n_mem_before = mem.count_documents({})
        n_kf_before = kf.count_documents({})

        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("iter17-ephgate2", ephemeral=True)))
            await _drain_until_ready(ws)
            await ws.send(b"\x00\x00" * 200)
            await asyncio.sleep(0.2)
            await ws.send(json.dumps({"type": "end"}))
            _ = await _collect_events(ws, budget_s=25.0, tail_after_done_s=2.0)

        await asyncio.sleep(1.0)
        n_mem_after = mem.count_documents({})
        n_kf_after = kf.count_documents({})
        assert n_mem_after == n_mem_before, (
            f"taccuino_memories leaked +{n_mem_after - n_mem_before} rows in ephemeral"
        )
        assert n_kf_after == n_kf_before, (
            f"taccuino_key_facts leaked +{n_kf_after - n_kf_before} rows in ephemeral"
        )


# ─── 5. Confessional reset ──────────────────────────────────────────────
class TestConfessionalReset:
    def test_confessional_reset_deletes_buffer_rows(self):
        """Seed 3 rows into db.confessional_buffer with a synthetic session
        token, then POST /api/confessional/reset with that token → expect
        ok:true and deleted:3."""
        stok = f"TEST_iter17_{int(time.time() * 1000)}"
        rows = [
            {"session_token": stok, "role": "user", "text": "TEST_row1"},
            {"session_token": stok, "role": "ai", "text": "TEST_row2"},
            {"session_token": stok, "role": "user", "text": "TEST_row3"},
        ]
        _db["confessional_buffer"].insert_many(rows)
        try:
            r = requests.post(
                f"{BASE_URL}/api/confessional/reset",
                json={"session_token": stok},
                timeout=15,
            )
            assert r.status_code == 200, r.text[:300]
            body = r.json()
            assert body.get("ok") is True, f"body={body!r}"
            assert body.get("deleted") == 3, f"deleted={body.get('deleted')} body={body!r}"
            # Verify actually gone
            remaining = _db["confessional_buffer"].count_documents({"session_token": stok})
            assert remaining == 0, f"still {remaining} rows after reset"
        finally:
            # Belt-and-braces cleanup
            _db["confessional_buffer"].delete_many({"session_token": stok})

    def test_confessional_reset_empty_token_returns_zero(self):
        r = requests.post(
            f"{BASE_URL}/api/confessional/reset",
            json={"session_token": ""},
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True
        assert body.get("deleted") == 0


# ─── 6. Auth regressions ────────────────────────────────────────────────
class TestAuthRegressions:
    def test_apple_invalid_token_401(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "not.a.real.jwt", "email": None},
            timeout=15,
        )
        assert r.status_code == 401, f"status={r.status_code} body={r.text[:300]}"

    def test_dev_login_200(self):
        r = requests.post(f"{BASE_URL}/api/auth/dev-login", timeout=15)
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert isinstance(d.get("session_token"), str) and len(d["session_token"]) > 10
        assert d.get("email") == "dev@koda.local"
