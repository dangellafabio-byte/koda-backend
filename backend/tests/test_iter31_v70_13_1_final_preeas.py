"""
Iter 31 — v70.13.1 (build-v70.13.1-ptt-scrollview-fix) FINAL pre-EAS regression.

Backend: health, auth (apple/dev-login/me), profile, subscription/status,
converse (ephemeral+demo_mode → no user data written), WS /api/voice/stream client_apple.
Frontend static guards: v70.13.1 tag, pager ScrollView props, imports, eas env.
Run against Railway prod with OLLENYA_TEST_BASE_URL=https://koda-backend-production-4a34.up.railway.app
"""
import asyncio
import json
import os
import re

import pytest
import requests


def _env(key):
    v = os.environ.get(key)
    if v:
        return v
    with open("/app/frontend/.env", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"')
    return None


BASE_URL = (os.environ.get("OLLENYA_TEST_BASE_URL") or _env("EXPO_PUBLIC_BACKEND_URL")).rstrip("/")
FE = "/app/frontend"
INDEX = f"{FE}/app/index.tsx"


def _read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


# --- health -------------------------------------------------------------------
class TestHealth:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200, r.text[:200]


# --- auth (Apple native login endpoint + dev-login + me) --------------------
class TestAuth:
    def test_apple_missing_body_422(self):
        r = requests.post(f"{BASE_URL}/api/auth/apple", json={}, timeout=15)
        assert r.status_code == 422, r.text[:200]

    def test_apple_invalid_token_401(self):
        r = requests.post(f"{BASE_URL}/api/auth/apple",
                          json={"identity_token": "not.a.jwt", "email": "TEST_x@example.com"}, timeout=20)
        assert r.status_code == 401, f"{r.status_code} {r.text[:200]}"
        assert r.json().get("detail") == "invalid apple token"

    def test_apple_jwks_reachable(self):
        # backend depends on Apple JWKS for real token verification
        try:
            r = requests.get("https://appleid.apple.com/auth/keys", timeout=10)
        except requests.exceptions.RequestException:
            pytest.skip("appleid.apple.com not reachable from test container (sandbox egress)")
        assert r.status_code == 200 and r.json().get("keys")

    def test_me_unauthenticated_401(self):
        r = requests.get(f"{BASE_URL}/api/auth/me", timeout=15)
        assert r.status_code == 401

    def test_dev_login_and_me(self):
        r = requests.post(f"{BASE_URL}/api/auth/dev-login", timeout=15)
        if r.status_code == 404:
            pytest.skip("dev-login disabled on this backend")
        assert r.status_code == 200, r.text[:200]
        d = r.json()
        assert d["email"] == "dev@koda.local" and d.get("session_token")
        me = requests.get(f"{BASE_URL}/api/auth/me",
                          headers={"Authorization": f"Bearer {d['session_token']}"}, timeout=15)
        assert me.status_code == 200, me.text[:200]
        assert me.json().get("email") == "dev@koda.local"


# --- profile / subscription ----------------------------------------------------
class TestProfileSubscription:
    def test_profile(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=20)
        assert r.status_code == 200, r.text[:200]
        d = r.json()
        assert d.get("id") == "me" and isinstance(d.get("language"), str)
        assert "_id" not in d

    def test_subscription_status(self):
        r = requests.get(f"{BASE_URL}/api/subscription/status", timeout=20)
        assert r.status_code == 200, r.text[:200]
        d = r.json()
        assert "subscription_tier" in d


# --- converse (post-STT conversational turn) -----------------------------------
class TestConverse:
    def test_converse_empty_400(self):
        r = requests.post(f"{BASE_URL}/api/converse", json={"text": "   "}, timeout=20)
        assert r.status_code == 400, r.text[:200]

    def test_converse_voice_turn_ephemeral_demo(self):
        r = requests.post(f"{BASE_URL}/api/converse",
                          json={"text": "TEST_ ciao, come stai?", "ephemeral": True, "demo_mode": True,
                                "is_voice_turn": True, "audio_duration_ms": 1500}, timeout=90)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        d = r.json()
        assert d["ai_entry"].get("text", "").strip(), d["ai_entry"]
        assert d["user_entry"].get("text", "").startswith("TEST_")


# --- WS /api/voice/stream client_apple ----------------------------------------
async def _ws_first(start_frame):
    import websockets
    url = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/voice/stream"
    async with websockets.connect(url, open_timeout=10, ping_interval=None) as ws:
        await ws.send(json.dumps(start_frame))
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        try:
            await ws.send(json.dumps({"type": "end"}))
        except Exception:
            pass
        return json.loads(raw)


class TestVoiceStreamWS:
    def test_ready_client_apple(self):
        msg = asyncio.run(_ws_first({"type": "start", "ephemeral": True, "profile_lang": "it",
                                     "stt_source": "client_apple"}))
        assert msg.get("type") == "ready", msg
        assert msg.get("session_id")


# --- Frontend static guards (v70.13.1) -----------------------------------------
class TestV70131StaticGuards:
    def test_build_tag(self):
        assert 'OLLENYA_BUILD_SHORT_TAG = "build-v70.13.1-ptt-scrollview-fix"' in _read(INDEX)

    def test_pager_scrollview_props(self):
        src = _read(INDEX)
        i = src.index("ref={pagerRef}")
        block = src[i:src.index("onScroll=", i)]
        assert "canCancelContentTouches={false}" in block
        assert "delaysContentTouches" not in block

    def test_refs_declared_once(self):
        src = _read(INDEX)
        for name in ("handsFreeRef", "pttRecordingRef", "streamingSessionRef", "recRef"):
            assert len(re.findall(rf"const {name}\s*=\s*useRef", src)) == 1, name

    def test_eas_env_all_profiles(self):
        b = json.loads(_read(f"{FE}/eas.json"))["build"]
        for prof in ("preview", "production", "preview-android", "inworld-ab-ios", "inworld-ab-android"):
            env = b[prof]["env"]
            assert env.get("EXPO_PUBLIC_USE_CLIENT_STT") == "true", prof
            assert env.get("EXPO_PUBLIC_USE_WS_VOICE_STREAM") == "true", prof
