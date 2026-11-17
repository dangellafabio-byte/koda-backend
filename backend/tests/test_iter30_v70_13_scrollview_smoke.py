"""
Iter 30 — v70.13 (build-v70.13-ptt-scrollview-fix) pre-EAS smoke suite.

Backend: /api/health, /api/transcribe-inworld, WS /api/voice/stream.
Frontend static guards: the 4 v70.13 fixes + PTT stopTalk NO-OP in WS mode.
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
WAV = "/app/backend/_blind_test_clips/73a193fc-07ce-4766-9f95-591f632dadf4.wav"
FE = "/app/frontend"
INDEX = f"{FE}/app/index.tsx"
PAYWALL = f"{FE}/app/paywall.tsx"
QUOTA = f"{FE}/lib/quotaExhaustedAudio.ts"
EAS = f"{FE}/eas.json"


def _read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


# --- health ----------------------------------------------------------------
class TestHealth:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200, r.text[:200]


# --- /api/transcribe-inworld -------------------------------------------------
class TestTranscribeInworld:
    def test_no_body_422(self):
        r = requests.post(f"{BASE_URL}/api/transcribe-inworld", timeout=15)
        assert r.status_code == 422, r.text[:200]

    def test_empty_file_400(self):
        r = requests.post(f"{BASE_URL}/api/transcribe-inworld",
                          files={"audio": ("a.m4a", b"", "audio/m4a")}, data={"language": "it"}, timeout=15)
        assert r.status_code == 400, f"{r.status_code} {r.text[:200]}"

    def test_real_wav_200_text(self):
        if not os.path.isfile(WAV):
            pytest.skip("wav asset missing")
        with open(WAV, "rb") as fh:
            r = requests.post(f"{BASE_URL}/api/transcribe-inworld",
                              files={"audio": ("a.wav", fh, "audio/wav")}, data={"language": "it"}, timeout=60)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        d = r.json()
        assert d.get("provider") == "inworld"
        assert isinstance(d.get("text"), str) and d["text"].strip(), d


# --- WS /api/voice/stream ------------------------------------------------------
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


# --- Frontend static guards (v70.13 fixes) -------------------------------------
class TestV7013StaticGuards:
    def test_build_tag(self):
        assert 'OLLENYA_BUILD_SHORT_TAG = "build-v70.13-ptt-scrollview-fix"' in _read(INDEX)

    def test_pager_scrollview_props(self):
        src = _read(INDEX)
        i = src.index("ref={pagerRef}")
        block = src[i:src.index(">\n", src.index("decelerationRate", i))]
        assert "horizontal" in block
        assert "canCancelContentTouches={false}" in block
        assert "delaysContentTouches={false}" in block

    def test_paywall_import(self):
        src = _read(PAYWALL)
        assert re.search(r'^import \{ getIntroAsset \} from "\.\./lib/introAssetProvider";', src, re.M)
        assert "export function getIntroAsset" in _read(f"{FE}/lib/introAssetProvider.ts")

    def test_quota_import(self):
        assert re.search(r'^import \{ getIntroAsset \} from "\./introAssetProvider";', _read(QUOTA), re.M)

    def test_eas_env_preview_production(self):
        b = json.loads(_read(EAS))["build"]
        for prof in ("preview", "production"):
            env = b[prof]["env"]
            assert env.get("EXPO_PUBLIC_USE_CLIENT_STT") == "true", prof
            assert env.get("EXPO_PUBLIC_USE_WS_VOICE_STREAM") == "true", prof
            assert env.get("EXPO_PUBLIC_BACKEND_URL", "").startswith("https://"), prof

    def test_stoptalk_noop_ws(self):
        src = _read(INDEX)
        s = src.index("const stopTalk = async () => {")
        body = src[s:src.index("\n  const ", s + 10)]
        assert "streamingSessionRef" not in body and "stream.stop" not in body
        assert "const current = recRef.current;\n    if (!current) return;" in body
        # recRef is only ever assigned a recorder in the legacy (non-WS) path
        assert len(re.findall(r"recRef\.current = rec;", src)) == 1
