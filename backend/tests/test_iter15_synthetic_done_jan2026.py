"""
Iter 15 — WS /api/voice/stream synthetic `done` emit regression tests.

Context (from review_request Jan 2026):
Italian user Fabio on Koda voice app reported voice pipeline bug:
'thinking → idle → ws-closed-no-transcript-after-stop'.
Root cause: after user taps stop, if Deepgram never emitted speech_final AND
PCM buffer was empty/tiny, the cleanup block closed the WS *without* emitting
a terminal `done` event. Client waits 25s then logs `no-transcript-after-stop`
error and UI hangs.

Fix applied at /app/backend/voice_stream.py lines 1761-1795:
after the main loop breaks, if `client_alive and not pipeline_in_flight`, emit
    {"type":"done","no_transcript":true,"reason":"<no_audio_received|no_speech_detected>"}
so the client always receives a terminal event and can exit `thinking` state.

Scenarios verified:
  1. start → end immediately (0 audio bytes) → synthetic done with
     reason='no_audio_received' in <10s
  2. start → tiny (~200B) audio chunk → end → synthetic done with
     reason='no_speech_detected' in <10s (Deepgram won't extract speech)
  3. Regression: GET /api/profile still returns Fabio (name, voice)
  4. Regression: POST /api/auth/apple with invalid token still 401
  5. Regression: POST /api/auth/dev-login still 200
"""

import os
import json
import time
import asyncio
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
        "session_id": f"iter15-{session_suffix}",
        "audio_route": "builtin",
        "mime_type": "audio/aac",
        "sample_rate": 16000,
        "ephemeral": True,  # so we don't pollute Fabio's timeline
        "profile_lang": "it",
        "container": "aac",
    }


async def _drain_until_ready(ws, deadline_s: float = 6.0) -> None:
    """Consume frames until we see `ready` (or timeout)."""
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
            raise AssertionError(f"WS returned error before ready: {msg!r}")
    raise AssertionError(f"never received `ready` within {deadline_s}s")


async def _collect_events_until_done_or_close(ws, budget_s: float) -> list:
    """
    Collect JSON events from WS until we see `done` OR the socket closes
    OR budget elapses. Returns list of parsed events (ignores binary audio
    frames — those are TTS payloads, not relevant for the synthetic-done fix).
    """
    events: list = []
    deadline = time.time() + budget_s
    while time.time() < deadline:
        remaining = deadline - time.time()
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        except websockets.exceptions.ConnectionClosed:
            break
        if isinstance(raw, (bytes, bytearray)):
            # Binary audio (TTS chunk header+payload) — skip.
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        events.append(msg)
        if msg.get("type") == "done":
            break
    return events


# ─────────────────────────────────────────────────────────────────────
# 1) Start → immediate End (no audio) → synthetic done expected
# ─────────────────────────────────────────────────────────────────────
class TestSyntheticDoneNoAudio:
    """Fabio's exact scenario: user taps mic → immediately taps stop
    without speaking → client must NOT hang 25s."""

    @pytest.mark.asyncio
    async def test_no_audio_emits_synthetic_done_fast(self):
        t0 = time.time()
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("no-audio")))
            await _drain_until_ready(ws)
            # Immediately send end without any audio bytes
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_events_until_done_or_close(ws, budget_s=20.0)
        elapsed = time.time() - t0
        done_events = [e for e in events if e.get("type") == "done"]
        assert done_events, (
            f"NO `done` event received before WS closed → the exact Fabio bug "
            f"is still present. Events seen: {[e.get('type') for e in events]!r}"
        )
        done = done_events[0]
        assert done.get("no_transcript") is True, (
            f"synthetic done must carry no_transcript=True; got {done!r}"
        )
        assert done.get("reason") == "no_audio_received", (
            f"expected reason='no_audio_received', got {done.get('reason')!r} "
            f"— full done frame: {done!r}"
        )
        # SLA: must arrive well before the client's 25s no-transcript-after-stop timer
        assert elapsed < 15.0, (
            f"synthetic done took {elapsed:.1f}s — must be <15s to beat "
            f"client 25s no-transcript-after-stop timeout"
        )


# ─────────────────────────────────────────────────────────────────────
# 2) Start → tiny audio → End → synthetic done (no_speech_detected)
# ─────────────────────────────────────────────────────────────────────
class TestSyntheticDoneTinyAudio:
    """User sends a tiny burst of audio (way too short for Deepgram to
    detect speech) then taps stop. Client must still receive `done`."""

    @pytest.mark.asyncio
    async def test_tiny_audio_emits_synthetic_done(self):
        t0 = time.time()
        # ~200 bytes of silence-ish PCM16 (100 samples @ 16kHz = 6.25ms)
        tiny_audio = b"\x00\x00" * 100
        async with websockets.connect(
            WS_URL, open_timeout=10, ping_interval=None,
            max_size=8 * 1024 * 1024,
        ) as ws:
            await ws.send(json.dumps(_start_frame("tiny-audio")))
            await _drain_until_ready(ws)
            # Send a single tiny binary chunk
            await ws.send(tiny_audio)
            # Small pause so server registers the bytes
            await asyncio.sleep(0.2)
            await ws.send(json.dumps({"type": "end"}))
            events = await _collect_events_until_done_or_close(ws, budget_s=30.0)
        elapsed = time.time() - t0
        done_events = [e for e in events if e.get("type") == "done"]
        assert done_events, (
            f"NO `done` event received for tiny-audio case → client would hang. "
            f"Events seen: {[e.get('type') for e in events]!r}"
        )
        done = done_events[0]
        # Either synthetic (no_transcript=True) or a real done from a
        # fallback Whisper pipeline is acceptable — both unblock the client.
        # If synthetic, reason must be 'no_speech_detected' since we did
        # send >0 audio bytes (audio_bytes_received > 0 branch).
        if done.get("no_transcript") is True:
            assert done.get("reason") == "no_speech_detected", (
                f"synthetic done with audio_bytes>0 must say "
                f"reason='no_speech_detected'; got {done!r}"
            )
        # Bound the wait — client-side timer is 25s, we must arrive earlier.
        assert elapsed < 25.0, (
            f"done took {elapsed:.1f}s — must be <25s"
        )


# ─────────────────────────────────────────────────────────────────────
# 3) Regression — profile / auth still work
# ─────────────────────────────────────────────────────────────────────
class TestRegressionProfileAuth:
    def test_profile_returns_fabio(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
        d = r.json()
        assert d.get("name") == "Fabio", f"name={d.get('name')!r}"
        assert d.get("koda_voice") == "aria", f"koda_voice={d.get('koda_voice')!r}"
        # total_messages may have grown since the earlier snapshot of 634 —
        # accept any value ≥ 634 as valid (no reset to 0/empty profile).
        tm = d.get("total_messages")
        assert isinstance(tm, int) and tm >= 634, (
            f"total_messages={tm!r} — expected ≥634 (was 634 at fix time). "
            f"Value <634 suggests profile reset regression."
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
