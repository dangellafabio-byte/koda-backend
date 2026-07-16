"""
Iter 14 — Fabio profile restore + WS voice stream + auth guards regression tests.

Context (from review_request):
Italian user Fabio reported TestFlight WS voice stream closing with code 1006.
Root cause: `updated_at` in "me" profile was stored as datetime object → Pydantic
ValidationError in get_or_create_profile() → silent except → fresh empty profile
returned. Fix applied at server.py:1600-1660 (datetime coercion before Pydantic)
and lines 5531/5546 (datetime.now(timezone.utc).isoformat() on writes). Data
repair executed on 4 corrupted profiles.

Verify:
  A) GET /api/profile → Fabio real profile (name='Fabio', total_messages=634,
     koda_voice='aria', onboarded=True, voice_locked=True)
  B) WS /api/voice/stream → accept + start-frame → {"type":"ready"} in <3s
  C) POST /api/auth/apple invalid token → HTTP 401 (not 500)
  D) POST /api/auth/google/session no session_id → HTTP 401
  E) POST /api/auth/dev-login → 200 + session_token
  F) Multiple sequential GET /api/profile → consistent Fabio (no oscillation)
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
    # Fall back to reading frontend/.env directly (protected key name)
    try:
        with open("/app/frontend/.env") as _f:
            for _line in _f:
                if _line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                    BASE_URL = _line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break
    except Exception:
        pass

assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing — cannot run tests"

# Derive WS base from HTTP base
if BASE_URL.startswith("https://"):
    WS_BASE = "wss://" + BASE_URL[len("https://"):]
elif BASE_URL.startswith("http://"):
    WS_BASE = "ws://" + BASE_URL[len("http://"):]
else:
    WS_BASE = BASE_URL


# ─────────────────────────────────────────────────────────────────────
# A) GET /api/profile — Fabio real profile
# ─────────────────────────────────────────────────────────────────────
class TestProfileFabio:
    """Verify the primary fix: /api/profile returns Fabio's real data."""

    def test_profile_returns_fabio_name(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
        data = r.json()
        assert data.get("name") == "Fabio", (
            f"BROKEN FIX — name={data.get('name')!r}, expected 'Fabio'. "
            f"Root-cause bug (datetime→ValidationError→empty profile) is STILL PRESENT."
        )

    def test_profile_total_messages_634(self):
        # NOTE (iter17): baseline was 634 at iter14 time; profile has grown
        # organically as Fabio uses the app. Use `>= 634` to match iter15/16/17.
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        assert r.status_code == 200
        data = r.json()
        tm = data.get("total_messages")
        assert isinstance(tm, int) and tm >= 634, (
            f"total_messages={tm}, expected >=634"
        )

    def test_profile_koda_voice_aria(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        data = r.json()
        assert data.get("koda_voice") == "aria", (
            f"koda_voice={data.get('koda_voice')!r}, expected 'aria'"
        )

    def test_profile_onboarded_true(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        data = r.json()
        assert data.get("onboarded") is True, (
            f"onboarded={data.get('onboarded')}, expected True"
        )

    def test_profile_voice_locked_true(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        data = r.json()
        assert data.get("voice_locked") is True, (
            f"voice_locked={data.get('voice_locked')}, expected True"
        )

    def test_profile_updated_at_is_iso_string(self):
        """Regression: updated_at must be ISO string, never datetime obj."""
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        data = r.json()
        ua = data.get("updated_at")
        assert isinstance(ua, str), f"updated_at is not str: {type(ua).__name__}={ua!r}"
        # Must be parseable as ISO
        from datetime import datetime as _dt
        try:
            _dt.fromisoformat(ua.replace("Z", "+00:00"))
        except Exception as e:
            pytest.fail(f"updated_at not ISO-parseable: {ua!r} — {e}")


# ─────────────────────────────────────────────────────────────────────
# F) Profile consistency across N sequential requests (no oscillation)
# ─────────────────────────────────────────────────────────────────────
class TestProfileConsistency:
    def test_five_sequential_profile_reads_all_return_fabio(self):
        """Repro Fabio complaint: profile flipping between real/empty."""
        names, msgs, voices = [], [], []
        for i in range(5):
            r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
            assert r.status_code == 200, f"iter#{i}: HTTP {r.status_code}"
            d = r.json()
            names.append(d.get("name"))
            msgs.append(d.get("total_messages"))
            voices.append(d.get("koda_voice"))
        # All 5 must be Fabio, aria — no oscillation allowed. total_messages
        # must be stable within the 5-call window (may be >=634 as profile grows).
        assert set(names) == {"Fabio"}, f"name oscillation: {names}"
        assert len(set(msgs)) == 1 and msgs[0] >= 634, (
            f"total_messages oscillation or below baseline: {msgs}"
        )
        assert set(voices) == {"aria"}, f"koda_voice oscillation: {voices}"


# ─────────────────────────────────────────────────────────────────────
# C/D/E) Auth endpoints — never 500 on bad input, dev-login works
# ─────────────────────────────────────────────────────────────────────
class TestAuthGuards:
    def test_apple_invalid_token_returns_401_not_500(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "not.a.real.jwt", "email": None},
            timeout=15,
        )
        assert r.status_code == 401, (
            f"expected 401, got {r.status_code}. body={r.text[:300]}"
        )
        body = r.json()
        assert "invalid apple token" in (body.get("detail") or "").lower(), (
            f"detail mismatch: {body!r}"
        )

    def test_apple_malformed_body_returns_4xx_not_500(self):
        """Extra hardening: totally bogus body still returns 4xx."""
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={},
            timeout=15,
        )
        assert 400 <= r.status_code < 500, (
            f"expected 4xx, got {r.status_code}. body={r.text[:300]}"
        )

    def test_google_session_missing_session_id_returns_401(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/google/session",
            timeout=15,
        )
        assert r.status_code == 401, (
            f"expected 401, got {r.status_code}. body={r.text[:300]}"
        )
        body = r.json()
        assert "session" in (body.get("detail") or "").lower(), (
            f"detail mismatch: {body!r}"
        )

    def test_dev_login_returns_200_with_session_token(self):
        r = requests.post(f"{BASE_URL}/api/auth/dev-login", timeout=15)
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
        data = r.json()
        assert data.get("email") == "dev@koda.local", f"email={data.get('email')!r}"
        assert isinstance(data.get("session_token"), str) and len(data["session_token"]) > 10, (
            f"session_token invalid: {data.get('session_token')!r}"
        )


# ─────────────────────────────────────────────────────────────────────
# B) WS /api/voice/stream — accept + ready in <3s
# ─────────────────────────────────────────────────────────────────────
class TestVoiceStreamWS:
    @pytest.mark.asyncio
    async def test_ws_accepts_connection_and_returns_ready(self):
        url = f"{WS_BASE}/api/voice/stream"
        start_frame = {
            "type": "start",
            "session_id": "test-iter14-fabio",
            "audio_route": "builtin",
            "mime_type": "audio/aac",
            "sample_rate": 16000,
            "ephemeral": False,
            "profile_lang": "it",
            "container": "aac",
        }
        t0 = time.time()
        try:
            async with websockets.connect(
                url,
                open_timeout=10,
                ping_interval=None,
                max_size=8 * 1024 * 1024,
            ) as ws:
                connect_ms = (time.time() - t0) * 1000
                await ws.send(json.dumps(start_frame))
                # Wait up to 3s for the "ready" frame
                got_ready = False
                session_id = None
                ready_ms = None
                deadline = time.time() + 3.0
                while time.time() < deadline:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        break
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    except asyncio.TimeoutError:
                        break
                    if isinstance(raw, (bytes, bytearray)):
                        continue
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    if msg.get("type") == "ready":
                        got_ready = True
                        session_id = msg.get("session_id")
                        ready_ms = (time.time() - t0) * 1000
                        break
                    if msg.get("type") == "error":
                        pytest.fail(
                            f"WS returned error before ready: {msg!r} "
                            f"(connect_ms={connect_ms:.0f})"
                        )
                assert got_ready, (
                    f"No 'ready' frame received within 3s "
                    f"(connect_ms={connect_ms:.0f})"
                )
                assert isinstance(session_id, str) and len(session_id) >= 8, (
                    f"session_id invalid: {session_id!r}"
                )
                assert ready_ms < 3000, f"ready took {ready_ms:.0f}ms (>3s budget)"
                # Clean close
                try:
                    await ws.send(json.dumps({"type": "end"}))
                except Exception:
                    pass
        except websockets.exceptions.InvalidStatusCode as e:
            pytest.fail(f"WS handshake failed HTTP {e.status_code} at {url}")
        except websockets.exceptions.WebSocketException as e:
            pytest.fail(f"WS error at {url}: {type(e).__name__}: {e}")

    @pytest.mark.asyncio
    async def test_ws_no_1006_close_on_immediate_connect(self):
        """Explicit repro of Fabio's TestFlight 1.0.115 bug: WS closing with
        1006 immediately after accept. Should now stay open at least until
        we send start frame + receive ready."""
        url = f"{WS_BASE}/api/voice/stream"
        try:
            async with websockets.connect(url, open_timeout=10) as ws:
                # Wait 500ms — if server crashes on accept we'd get 1006 here
                try:
                    await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass  # OK — server is idle waiting for start frame
                except websockets.exceptions.ConnectionClosed as e:
                    pytest.fail(
                        f"WS closed immediately code={e.code} reason={e.reason!r} "
                        "(this is the Fabio TestFlight 1006 bug)"
                    )
                assert ws.state.name == "OPEN", (
                    f"WS not OPEN after 500ms idle: state={ws.state.name}"
                )
        except websockets.exceptions.InvalidStatusCode as e:
            pytest.fail(f"WS handshake failed HTTP {e.status_code}")
