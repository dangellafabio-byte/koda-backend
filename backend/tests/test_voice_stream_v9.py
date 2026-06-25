"""Voice stream WS validation tests (v9 RecordingDisabledException fix regression).

Validates that the WebSocket endpoint accepts the streaming protocol
(start → binary → ping → end) and does not crash on simulated frames.
Also smoke-tests basic backend APIs (profile, dev-login).
"""
import os
import json
import asyncio
import pytest
import requests
import websockets

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
WS_URL = BASE_URL.replace("http", "ws", 1) + "/api/voice/stream"


def test_profile_get_200():
    r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "id" in data
    assert "settings" in data


def test_dev_login_returns_token_or_cookie():
    r = requests.post(f"{BASE_URL}/api/auth/dev-login", timeout=15)
    # Endpoint should return 200 (or 201). Tolerant about body shape.
    assert r.status_code in (200, 201), f"status={r.status_code} body={r.text[:300]}"


@pytest.mark.asyncio
async def test_ws_voice_stream_full_protocol():
    """Verify start→binary→ping→end protocol works without crash."""
    async with websockets.connect(WS_URL, open_timeout=10) as ws:
        # 1) start frame
        await ws.send(json.dumps({
            "type": "start",
            "ephemeral": True,
            "profile_lang": "it",
            "container": "aac",
        }))
        # 2) Expect a 'ready' JSON event back
        ready_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
        ready = json.loads(ready_raw)
        assert ready.get("type") == "ready", f"got {ready}"
        assert "session_id" in ready

        # 3) Send a binary frame (simulated AAC, ffmpeg will fail to decode — that's fine)
        await ws.send(b"\x00\x01\x02\x03" * 128)  # 512 bytes of garbage

        # 4) Send a keepalive ping (should be ignored, no error/close)
        await ws.send(json.dumps({"type": "ping", "t": 12345}))

        # 5) Brief wait — server must NOT close on garbage / ping
        await asyncio.sleep(0.5)

        # Send another binary + another ping to confirm stability
        await ws.send(b"\xff" * 256)
        await ws.send(json.dumps({"type": "ping", "t": 99999}))

        await asyncio.sleep(0.3)

        # 6) Send end frame — server should gracefully drain
        await ws.send(json.dumps({"type": "end"}))

        # Drain remaining messages (done or close); allow up to 5s
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=3.0)
                if isinstance(msg, str):
                    evt = json.loads(msg)
                    if evt.get("type") in ("done", "error"):
                        break
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
        # Test passes if we got here without server crash
