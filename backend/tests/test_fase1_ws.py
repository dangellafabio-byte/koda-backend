"""
Fase 1 — Streaming WebSocket Pipeline tests for L'Amico Fraterno (Koda) backend.

Covers:
  - WS happy path (/api/converse-ws)
  - WS error: empty text
  - WS error: invalid JSON
  - HTTP polling fallback (/api/converse-fast/start + /poll)
  - Echo → Theo rename in /api/voice/options
  - Voice key compat: KODA_VOICES exposes both 'theo' and 'echo' → same voice_id
"""
import asyncio
import json
import os
import time

import pytest
import requests
import websockets

HTTP_BASE = os.environ.get("KODA_TEST_HTTP_BASE", "http://localhost:8001").rstrip("/")
WS_BASE = os.environ.get("KODA_TEST_WS_BASE", "ws://localhost:8001").rstrip("/")

WS_URL = f"{WS_BASE}/api/converse-ws"


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
async def _collect_ws_frames(ws, overall_timeout: float = 25.0):
    """Collect all frames until the server closes the connection or timeout.
    Returns list of (kind, payload) where kind in {'text', 'bytes'}.
    """
    frames = []
    start = time.time()
    while True:
        remaining = overall_timeout - (time.time() - start)
        if remaining <= 0:
            raise TimeoutError(f"WS overall timeout after {overall_timeout}s")
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except websockets.ConnectionClosed:
            break
        except asyncio.TimeoutError:
            raise TimeoutError(f"WS recv timeout, collected {len(frames)} frames so far")
        if isinstance(msg, (bytes, bytearray)):
            frames.append(("bytes", bytes(msg)))
        else:
            try:
                frames.append(("text", json.loads(msg)))
            except json.JSONDecodeError:
                frames.append(("text", msg))
    return frames


# ----------------------------------------------------------------------
# WS happy path
# ----------------------------------------------------------------------
class TestWebSocketHappyPath:
    @pytest.mark.asyncio
    async def test_ws_full_pipeline(self):
        t0 = time.time()
        async with websockets.connect(WS_URL, max_size=8 * 1024 * 1024) as ws:
            await ws.send(json.dumps({
                "text": "ciao, dimmi un saluto breve",
                "ephemeral": True,
                "audio_duration_ms": None,
            }))
            frames = await _collect_ws_frames(ws, overall_timeout=25.0)
        elapsed = time.time() - t0

        # --- Assertions ---
        assert elapsed < 25.0, f"WS took too long: {elapsed:.1f}s"

        text_frames = [p for k, p in frames if k == "text"]
        bytes_frames = [p for k, p in frames if k == "bytes"]

        # 1) session frame
        session_frames = [f for f in text_frames if isinstance(f, dict) and f.get("type") == "session"]
        assert len(session_frames) >= 1, f"No session frame. Frames: {text_frames}"
        assert isinstance(session_frames[0].get("session_id"), str) and len(session_frames[0]["session_id"]) >= 16

        # 2) at least one sentence + binary pair with len == audio_bytes
        # Walk frames in order and pair sentence-text with the very next binary frame.
        sentence_pairs = []
        for idx, (kind, payload) in enumerate(frames):
            if kind == "text" and isinstance(payload, dict) and payload.get("type") == "sentence":
                # next frame should be binary
                if idx + 1 < len(frames) and frames[idx + 1][0] == "bytes":
                    sentence_pairs.append((payload, frames[idx + 1][1]))
        assert len(sentence_pairs) >= 1, (
            f"No (sentence,binary) pair found. text_frames={text_frames}, "
            f"#bytes_frames={len(bytes_frames)}"
        )
        for header, audio in sentence_pairs:
            assert header.get("audio_bytes") == len(audio), (
                f"audio_bytes mismatch: header={header.get('audio_bytes')} actual={len(audio)}"
            )
            assert header.get("mime") == "audio/mpeg"
            assert isinstance(header.get("text"), str) and header["text"].strip()
            assert len(audio) > 100, "audio payload suspiciously small"

        # 3) meta frame with non-empty reply
        meta_frames = [f for f in text_frames if isinstance(f, dict) and f.get("type") == "meta"]
        assert len(meta_frames) >= 1, f"No meta frame. Frames: {text_frames}"
        assert isinstance(meta_frames[0].get("reply"), str) and meta_frames[0]["reply"].strip()

        # 4) done frame
        done_frames = [f for f in text_frames if isinstance(f, dict) and f.get("type") == "done"]
        assert len(done_frames) >= 1, f"No done frame. Frames: {text_frames}"


# ----------------------------------------------------------------------
# WS error handling
# ----------------------------------------------------------------------
class TestWebSocketErrorHandling:
    @pytest.mark.asyncio
    async def test_ws_empty_text(self):
        async with websockets.connect(WS_URL) as ws:
            await ws.send(json.dumps({"text": "", "ephemeral": True}))
            frames = await _collect_ws_frames(ws, overall_timeout=8.0)

        text_frames = [p for k, p in frames if k == "text"]
        err = [f for f in text_frames if isinstance(f, dict) and f.get("type") == "error"]
        assert len(err) >= 1, f"No error frame. Got: {text_frames}"
        assert "empty" in (err[0].get("message") or "").lower(), (
            f"Unexpected error message: {err[0]}"
        )
        # Connection should be closed by server
        # (collector exits because connection closed → fine)

    @pytest.mark.asyncio
    async def test_ws_invalid_json(self):
        async with websockets.connect(WS_URL) as ws:
            await ws.send("hello")  # not JSON
            frames = await _collect_ws_frames(ws, overall_timeout=8.0)

        text_frames = [p for k, p in frames if k == "text"]
        err = [f for f in text_frames if isinstance(f, dict) and f.get("type") == "error"]
        assert len(err) >= 1, f"No error frame. Got: {text_frames}"
        msg = (err[0].get("message") or "").lower()
        assert "invalid json" in msg or "json" in msg, f"Unexpected error message: {err[0]}"


# ----------------------------------------------------------------------
# HTTP polling fallback — MUST still work
# ----------------------------------------------------------------------
class TestHttpPollingFallback:
    def test_fast_start_and_poll(self):
        r = requests.post(
            f"{HTTP_BASE}/api/converse-fast/start",
            json={"text": "prova", "ephemeral": True},
            timeout=10,
        )
        assert r.status_code == 200, f"start failed: {r.status_code} {r.text[:300]}"
        body = r.json()
        sid = body.get("session_id")
        assert sid, f"No session_id in start response: {body}"

        # Poll until done:true (or timeout total ~40s).
        since = 0
        sentence_events = []
        meta_events = []
        done = False
        t0 = time.time()
        while time.time() - t0 < 40.0:
            rp = requests.get(
                f"{HTTP_BASE}/api/converse-fast/poll/{sid}",
                params={"since": since, "timeout": 4},
                timeout=10,
            )
            assert rp.status_code == 200, f"poll failed: {rp.status_code} {rp.text[:300]}"
            pb = rp.json()
            events = pb.get("events") or []
            for ev in events:
                t = ev.get("type")
                if t == "sentence":
                    sentence_events.append(ev)
                elif t == "meta":
                    meta_events.append(ev)
            since = pb.get("next_since", since + len(events))
            if pb.get("done"):
                done = True
                break

        assert done, f"poll never returned done=true within 40s; got {len(sentence_events)} sentences, {len(meta_events)} metas"
        assert len(sentence_events) >= 1, "No sentence events in polling fallback"
        assert len(meta_events) >= 1, "No meta event in polling fallback"
        reply = (meta_events[0].get("reply") or "").strip()
        assert reply, f"Empty reply in meta event: {meta_events[0]}"


# ----------------------------------------------------------------------
# Voice options / rename
# ----------------------------------------------------------------------
class TestVoiceOptions:
    def test_voice_options_endpoint(self):
        r = requests.get(f"{HTTP_BASE}/api/voice/options", timeout=10)
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        options = body.get("options") or []
        assert isinstance(options, list) and len(options) >= 2, body
        # Find male voice option(s) — those should now be labeled 'Theo'
        # Keys should include 'theo' (and possibly 'echo' for backcompat)
        keys = {o.get("key") for o in options}
        assert "theo" in keys, f"'theo' key missing in voice/options: {keys}"
        theo_opts = [o for o in options if o.get("key") == "theo"]
        assert theo_opts, "no theo option object"
        assert theo_opts[0].get("label") == "Theo", f"Expected label 'Theo' got {theo_opts[0]}"

    def test_curated_voices_has_theo_with_correct_id(self):
        # Import the dicts directly from server.py (no public endpoint exposes them).
        import sys
        sys.path.insert(0, "/app/backend")
        from server import CURATED_VOICES, KODA_VOICES  # type: ignore
        male = [v for v in CURATED_VOICES if v.get("voice_id") == "dJwiFcjz9zW5Pge7G8AG"]
        assert male, "Male voice dJwiFcjz9zW5Pge7G8AG not in CURATED_VOICES"
        assert male[0].get("name") == "Theo", f"CURATED_VOICES male name is {male[0].get('name')}, expected Theo"

        # KODA_VOICES must accept both 'theo' and 'echo'
        assert "theo" in KODA_VOICES, "'theo' missing from KODA_VOICES"
        assert "echo" in KODA_VOICES, "'echo' alias missing from KODA_VOICES (backcompat)"
        assert KODA_VOICES["theo"]["voice_id"] == "dJwiFcjz9zW5Pge7G8AG"
        assert KODA_VOICES["echo"]["voice_id"] == "dJwiFcjz9zW5Pge7G8AG"
        # Both must label/display as Theo
        assert KODA_VOICES["theo"].get("label") == "Theo"
        assert KODA_VOICES["echo"].get("label") == "Theo"
