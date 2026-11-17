"""
Iter 23 — v70.12 (build-v70.12-ptt-release-noop) pre-EAS smoke suite.

Backend: /api/transcribe-inworld, /api/profile, WS /api/voice/stream
(deepgram + client_apple start frames).
Frontend static guards: stopTalk does not stop WS stream, orb Pressable
still uses onPressIn/onPressOut, voiceClientStt continuous == android only.
"""
import asyncio
import json
import os
import re
import uuid

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


# OLLENYA_TEST_BASE_URL lets us also hit the Railway prod backend that the
# native build actually uses (frontend/lib/backendUrl.ts hardcodes it).
BASE_URL = (os.environ.get("OLLENYA_TEST_BASE_URL") or _env("EXPO_PUBLIC_BACKEND_URL")).rstrip("/")
IS_PROD = "railway.app" in BASE_URL
WAV = "/app/backend/_blind_test_clips/73a193fc-07ce-4766-9f95-591f632dadf4.wav"
INDEX = "/app/frontend/app/index.tsx"
STT = "/app/frontend/lib/voiceClientStt.ts"


def _read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


# --- /api/transcribe-inworld ---------------------------------------------
class TestTranscribeInworld:
    def test_no_body_422(self):
        r = requests.post(f"{BASE_URL}/api/transcribe-inworld", timeout=15)
        assert r.status_code == 422, r.text[:200]

    def test_empty_file_400(self):
        r = requests.post(
            f"{BASE_URL}/api/transcribe-inworld",
            files={"audio": ("a.m4a", b"", "audio/m4a")},
            data={"language": "it"},
            timeout=15,
        )
        assert r.status_code == 400, f"{r.status_code} {r.text[:200]}"

    def test_real_wav_200_text(self):
        if not os.path.isfile(WAV):
            pytest.skip("wav asset missing")
        with open(WAV, "rb") as fh:
            r = requests.post(
                f"{BASE_URL}/api/transcribe-inworld",
                files={"audio": ("a.wav", fh, "audio/wav")},
                data={"language": "it"},
                timeout=60,
            )
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        d = r.json()
        assert d.get("provider") == "inworld"
        assert isinstance(d.get("text"), str) and d["text"].strip(), d
        assert d.get("audio_duration_s", 0) > 0


# --- /api/profile ----------------------------------------------------------
class TestProfile:
    def test_get_profile_fresh_uuid(self):
        if IS_PROD:
            pytest.skip("avoid creating junk profiles on prod DB")
        uid = str(uuid.uuid4())
        r = requests.get(f"{BASE_URL}/api/profile", headers={"X-User-Id": uid}, timeout=15)
        assert r.status_code == 200, r.text[:200]
        d = r.json()
        assert "_id" not in d
        assert isinstance(d.get("id"), str) and d["id"]
        assert isinstance(d.get("settings"), dict)
        assert d.get("ai_name")


# --- WS /api/voice/stream ---------------------------------------------------
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
    def test_ready_deepgram(self):
        msg = asyncio.run(_ws_first({"type": "start", "ephemeral": True, "profile_lang": "it", "container": "aac"}))
        assert msg.get("type") == "ready", msg
        assert msg.get("session_id")

    def test_ready_client_apple(self):
        msg = asyncio.run(_ws_first({"type": "start", "ephemeral": True, "profile_lang": "it",
                                     "stt_source": "client_apple"}))
        assert msg.get("type") == "ready", msg


# --- Frontend static guards (v70.12 PTT logic) -----------------------------
class TestFrontendStaticGuards:
    def _fn_body(self, src, name):
        start = src.index(f"const {name} = async () => {{")
        nxt = src.index("\n  const ", start + 10)
        return src[start:nxt]

    def test_stoptalk_no_stream_stop(self):
        body = self._fn_body(_read(INDEX), "stopTalk")
        assert "streamingSessionRef" not in body
        assert "current = recRef.current" in body and "if (!current) return;" in body

    def test_orb_pressable_press_in_out(self):
        src = _read(INDEX)
        assert "onPressIn={() => {" in src and "onBigButtonPressIn();" in src
        assert "onPressOut={() => {" in src and "onBigButtonPressOut();" in src
        assert "GestureDetector" not in src

    def test_continuous_android_only(self):
        src = _read(STT)
        m = re.findall(r"continuous:\s*([^,\n]+),", src)
        assert m == ['Platform.OS === "android"'], m
