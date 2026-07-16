"""
Iter 16 — Verify NO DUPLICATE `done` on any WS scenario.

Context (review_request Jan 2026):
After iter15 flagged a minor issue that on the happy path (real pipeline runs
and emits its own `{type:'done'}`), the cleanup block would then also emit a
*synthetic* `{type:'done', no_transcript:true}` because its guard was only
`client_alive and not pipeline_in_flight` — and by cleanup time pipeline
had finished and set `pipeline_in_flight = False`.

Main agent applied a `done_emitted` flag fix at:
  - voice_stream.py:1186  (init `done_emitted = False`)
  - voice_stream.py:1313  (`nonlocal ..., done_emitted`)
  - voice_stream.py:1443  (set `done_emitted = True` after real done emit)
  - voice_stream.py:1785  (cleanup guard now `and not done_emitted`)

Verification goals:
  1. iter15 tests still pass (`test_iter15_synthetic_done_jan2026.py` — run separately)
  2. No-audio path → EXACTLY ONE synthetic `done`, no second `done` in the
     ~2s tail after the first one arrives.
  3. Tiny-audio path → EXACTLY ONE `done`, no dupe in tail window.
  4. Happy-path attempt (send a longer speech-like PCM burst).  If DG/Whisper
     produce a real `done`, cleanup MUST NOT emit a second synthetic `done`.
     If no real pipeline runs (no speech detected on synthetic PCM), we still
     assert exactly one `done` in the overall stream.
  5. Regressions (profile, apple 401, dev-login 200).
"""

import os
import json
import time
import asyncio
import struct
import math
import pytest
import requests
import websockets


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

assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing — cannot run tests"

if BASE_URL.startswith("https://"):
    WS_BASE = "wss://" + BASE_URL[len("https://"):]
elif BASE_URL.startswith("http://"):
    WS_BASE = "ws://" + BASE_URL[len("http://"):]
else:
    WS_BASE = BASE_URL

WS_URL = f"{WS_BASE}/api/voice/stream"


def _start_frame(session_suffix: str) -> dict:
    return {
        "type": "start",
        "session_id": f"iter16-{session_suffix}",
        "audio_route": "builtin",
        "mime_type": "audio/aac",
        "sample_rate": 16000,
        "ephemeral": True,
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
            raise AssertionError(f"never received `ready` within {deadline_s}s")
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
    raise AssertionError(f"never received `ready` within {deadline_s}s")


async def _collect_all_events(ws, budget_s: float, tail_after_done_s: float = 2.5) -> list:
    """
    Collect JSON events until socket closes OR budget elapses.
    Once a `done` is seen, keep listening for `tail_after_done_s` more seconds
    to catch any duplicate `done` before returning.

    Returns list of ALL parsed JSON events (skips binary audio frames).
    """
    events: list = []
    deadline = time.time() + budget_s
    tail_deadline: float | None = None

    while time.time() < deadline:
        now = time.time()
        if tail_deadline is not None and now >= tail_deadline:
            break
        # Time we're willing to wait for the next frame
        if tail_deadline is not None:
            wait_s = min(deadline, tail_deadline) - now
        else:
            wait_s = deadline - now
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
            # Start tail window to catch any duplicate `done`
            tail_deadline = time.time() + tail_after_done_s
    return events


def _summarize(events: list) -> str:
    return ", ".join(f"{e.get('type')}" for e in events)


# ─────────────────────────────────────────────────────────────────────
# 1) No audio → EXACTLY ONE done
# ─────────────────────────────────────────────────────────────────────
class TestNoAudioExactlyOneDone:
    @pytest.mark.asyncio
    async def test_no_audio_exactly_one_done_no_duplicate(self):
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("no-audio-once")))
            await _drain_until_ready(ws)
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_all_events(ws, budget_s=15.0, tail_after_done_s=2.5)
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, (
            f"expected EXACTLY 1 done, got {len(done_events)}. "
            f"All done frames: {done_events!r}\n"
            f"Full event stream: {_summarize(events)}"
        )
        done = done_events[0]
        assert done.get("no_transcript") is True
        assert done.get("reason") == "no_audio_received"


# ─────────────────────────────────────────────────────────────────────
# 2) Tiny audio → EXACTLY ONE done
# ─────────────────────────────────────────────────────────────────────
class TestTinyAudioExactlyOneDone:
    @pytest.mark.asyncio
    async def test_tiny_audio_exactly_one_done_no_duplicate(self):
        tiny_audio = b"\x00\x00" * 100
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("tiny-once")))
            await _drain_until_ready(ws)
            await ws.send(tiny_audio)
            await asyncio.sleep(0.2)
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_all_events(ws, budget_s=30.0, tail_after_done_s=2.5)
        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, (
            f"expected EXACTLY 1 done, got {len(done_events)}. "
            f"All done frames: {done_events!r}\n"
            f"Full event stream: {_summarize(events)}"
        )


# ─────────────────────────────────────────────────────────────────────
# 3) Longer PCM burst (~1s of 400Hz tone) → attempt to trigger pipeline
#     → verify no duplicate `done` (real + synthetic).
# ─────────────────────────────────────────────────────────────────────
class TestLongerAudioNoDuplicateDone:
    """
    Send ~1s of PCM16 audio (a 400Hz tone) — Deepgram is unlikely to
    transcribe a pure tone as words, so more often than not this will still
    fall through to synthetic done.  BUT the important assertion is that
    regardless of whether a real pipeline `done` was emitted or the
    synthetic one fired, we NEVER see two `done`s.
    """

    def _make_tone_pcm16(self, duration_s: float = 1.0, hz: int = 400, sr: int = 16000) -> bytes:
        n = int(duration_s * sr)
        out = bytearray()
        amp = 8000
        for i in range(n):
            v = int(amp * math.sin(2 * math.pi * hz * i / sr))
            out += struct.pack("<h", v)
        return bytes(out)

    @pytest.mark.asyncio
    async def test_longer_audio_no_duplicate_done(self):
        audio = self._make_tone_pcm16(duration_s=1.0, hz=400)
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("longer-audio")))
            await _drain_until_ready(ws)
            # Send in 4 chunks of 250ms to simulate streaming
            chunk = len(audio) // 4
            for i in range(4):
                await ws.send(audio[i * chunk:(i + 1) * chunk])
                await asyncio.sleep(0.1)
            await ws.send(json.dumps({"type": "end"}))
            # Longer budget: real pipeline can take 10-20s (Whisper + LLM + TTS)
            events = await _collect_all_events(ws, budget_s=45.0, tail_after_done_s=3.0)

        done_events = [e for e in events if e.get("type") == "done"]
        assert len(done_events) == 1, (
            f"DUPLICATE DONE detected — expected exactly 1, got {len(done_events)}. "
            f"All done frames: {done_events!r}\n"
            f"Full event stream: {_summarize(events)}"
        )
        # Diagnostic: log which flavor of done we got (synthetic vs real)
        done = done_events[0]
        flavor = "synthetic" if done.get("no_transcript") is True else "real"
        print(
            f"\n[iter16-longer] done flavor={flavor} "
            f"reason={done.get('reason')!r} "
            f"stream_len={len(events)} types={_summarize(events)}"
        )


# ─────────────────────────────────────────────────────────────────────
# 4) Regressions
# ─────────────────────────────────────────────────────────────────────
class TestRegressionProfileAuth:
    def test_profile_returns_fabio(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
        d = r.json()
        assert d.get("name") == "Fabio", f"name={d.get('name')!r}"
        assert d.get("koda_voice") == "aria", f"koda_voice={d.get('koda_voice')!r}"
        tm = d.get("total_messages")
        assert isinstance(tm, int) and tm >= 634, (
            f"total_messages={tm!r} — expected ≥634"
        )
        assert d.get("onboarded") is True
        assert d.get("voice_locked") is True

    def test_apple_invalid_token_returns_401(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "not.a.real.jwt", "email": None},
            timeout=15,
        )
        assert r.status_code == 401, (
            f"expected 401, got {r.status_code}. body={r.text[:300]}"
        )

    def test_dev_login_returns_200(self):
        r = requests.post(f"{BASE_URL}/api/auth/dev-login", timeout=15)
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
        d = r.json()
        assert isinstance(d.get("session_token"), str) and len(d["session_token"]) > 10
        assert d.get("email") == "dev@koda.local"
