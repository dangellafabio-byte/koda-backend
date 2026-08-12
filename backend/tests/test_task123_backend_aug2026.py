"""
Backend regression tests for the three parallel tasks delivered Aug 2026:

  Task 2 — Orb/TTS silence sync: verify pipeline TTS non-regression
  Task 3 — Dev A/B tuning voice endpoints (/api/dev/tts/preview*)
  Task 1 — POC OpenAI Realtime API (/api/dev/poc/openai-realtime/*)

Runs against the public preview URL (EXPO_PUBLIC_BACKEND_URL).
Admin gate is exercised via header `X-User-Id: <admin uid>`.
"""

import json
import os
import time

import pytest
import requests
import websocket  # from websocket-client

BASE_URL = "https://app-finder-408.preview.emergentagent.com"
ADMIN_UID = "ee4e7261-e1b5-485c-8a68-778cac455e39"  # Fabio Google admin

ADMIN_HEADERS = {"X-User-Id": ADMIN_UID}
NON_ADMIN_HEADERS = {"X-User-Id": "00000000-0000-0000-0000-000000000000"}


@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    return s


# ============================================================
# Task 3 — dev TTS preview endpoints
# ============================================================
class TestTask3DevTTSPreview:
    def test_presets_requires_admin(self, api):
        r = api.get(f"{BASE_URL}/api/dev/tts/preview/presets")
        assert r.status_code == 403, r.text
        assert r.json().get("detail") == "admin_only"

    def test_presets_non_admin_forbidden(self, api):
        r = api.get(f"{BASE_URL}/api/dev/tts/preview/presets", headers=NON_ADMIN_HEADERS)
        assert r.status_code == 403, r.text

    def test_presets_admin_ok(self, api):
        r = api.get(f"{BASE_URL}/api/dev/tts/preview/presets", headers=ADMIN_HEADERS)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "current_production_warm" in data
        assert "suggested_ab_variants" in data
        assert "usage" in data
        variants = data["suggested_ab_variants"]
        assert isinstance(variants, list) and len(variants) == 5
        for v in variants:
            assert "name" in v and "settings" in v and "note" in v

    def test_preview_empty_text_400(self, api):
        r = api.get(f"{BASE_URL}/api/dev/tts/preview?text=", headers=ADMIN_HEADERS)
        assert r.status_code == 400, r.text
        assert "Empty text" in r.text

    def test_preview_no_auth_403(self, api):
        r = api.get(f"{BASE_URL}/api/dev/tts/preview?text=Ciao")
        assert r.status_code == 403, r.text

    def test_preview_returns_mp3_and_header(self, api):
        r = api.get(
            f"{BASE_URL}/api/dev/tts/preview",
            params={"text": "Ciao Fabio, eccomi.", "stability": 0.4},
            headers=ADMIN_HEADERS,
            timeout=30,
        )
        assert r.status_code == 200, r.text[:500]
        assert r.headers.get("content-type", "").startswith("audio/mpeg"), r.headers
        assert "X-Koda-Voice-Settings" in r.headers, list(r.headers.keys())
        vs = json.loads(r.headers["X-Koda-Voice-Settings"])
        assert vs["stability"] == 0.4
        # Body should be a valid MP3-ish payload of decent length
        body = r.content
        assert len(body) > 5000, f"MP3 too small: {len(body)} bytes"
        # MP3 magic: ID3 header or MPEG sync 0xFFF
        assert body[:3] == b"ID3" or (body[0] == 0xFF and (body[1] & 0xE0) == 0xE0), body[:8].hex()

    def test_preview_clamp_out_of_range(self, api):
        # stability=5.0 must be clamped to 1.0, endpoint still returns MP3
        r = api.get(
            f"{BASE_URL}/api/dev/tts/preview",
            params={"text": "Test clamp", "stability": 5.0},
            headers=ADMIN_HEADERS,
            timeout=30,
        )
        assert r.status_code == 200, r.text[:300]
        vs = json.loads(r.headers["X-Koda-Voice-Settings"])
        assert vs["stability"] == 1.0
        assert len(r.content) > 5000


# ============================================================
# Task 2 — non-regression pipeline TTS
# ============================================================
class TestTask2TTSNonRegression:
    def test_health_ok(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_tts_prepare_still_works(self, api):
        r = api.post(
            f"{BASE_URL}/api/tts/prepare",
            json={"text": "Ciao mondo", "voice_id": "POuqf18evoXOKIqV2Px7"},
            timeout=45,
        )
        assert r.status_code == 200, r.text[:500]
        data = r.json()
        assert "token" in data and isinstance(data["token"], str) and len(data["token"]) > 5
        assert "size" in data and isinstance(data["size"], int) and data["size"] > 1000

    def test_converse_ws_accepts_and_emits_session(self):
        """Connect to /api/converse-ws, send the required first frame, and
        expect an initial `session` event within ~5 seconds. Close cleanly
        without waiting for the full LLM/TTS turn."""
        ws_url = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/converse-ws"
        ws = websocket.create_connection(ws_url, timeout=10)
        try:
            # The handler requires a first JSON frame with `text` before it
            # emits the `session` event. Send a minimal ephemeral request.
            ws.send(json.dumps({"text": "Ciao", "ephemeral": True}))
            ws.settimeout(6.0)
            got_session = False
            deadline = time.time() + 6.0
            while time.time() < deadline:
                try:
                    raw = ws.recv()
                except Exception:
                    break
                if not raw:
                    continue
                if isinstance(raw, (bytes, bytearray)):
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                ev = msg.get("type") or msg.get("event")
                if ev == "session":
                    got_session = True
                    break
                if ev == "error":
                    pytest.fail(f"WS error: {msg}")
            assert got_session, "no `session` event within 6s"
        finally:
            try:
                ws.close()
            except Exception:
                pass


# ============================================================
# Task 1 — POC OpenAI Realtime
# ============================================================
class TestTask1POCOpenAIRealtime:
    STATUS_URL = f"{BASE_URL}/api/dev/poc/openai-realtime/status"
    TURN_URL = f"{BASE_URL}/api/dev/poc/openai-realtime/text-turn"
    BATTERY_URL = f"{BASE_URL}/api/dev/poc/openai-realtime/guardrail-battery"
    REPORT_URL = f"{BASE_URL}/api/dev/poc/openai-realtime/report"
    NOTES_URL = f"{BASE_URL}/api/dev/poc/openai-realtime/barge-in-notes"

    def test_status_requires_admin(self, api):
        r = api.get(self.STATUS_URL)
        assert r.status_code == 403, r.text

    def test_status_admin_ok(self, api):
        r = api.get(self.STATUS_URL, headers=ADMIN_HEADERS)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ready") is True
        assert d.get("key_present") is True
        assert d.get("default_model") == "gpt-realtime-2.1-mini"
        assert "gpt-realtime-2.1" in d.get("allowed_models", [])
        assert "gpt-realtime-2.1-mini" in d.get("allowed_models", [])
        assert d.get("default_voice") == "marin"
        assert d.get("guardrail_tests_count") == 6
        assert d.get("pricing_reference") is not None

    def test_text_turn_invalid_model(self, api):
        r = api.post(
            self.TURN_URL,
            headers=ADMIN_HEADERS,
            json={"prompt": "ciao", "model": "invalid-model"},
            timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_text_turn_invalid_voice(self, api):
        r = api.post(
            self.TURN_URL,
            headers=ADMIN_HEADERS,
            json={"prompt": "ciao", "voice": "invalid-voice"},
            timeout=15,
        )
        assert r.status_code == 400, r.text

    def test_text_turn_happy_path(self, api):
        payload = {
            "prompt": "Ciao Koda, come stai?",
            "model": "gpt-realtime-2.1-mini",
            "voice": "marin",
            "instructions_variant": "warm_koda",
            "timeout_s": 30.0,
        }
        r = api.post(self.TURN_URL, headers=ADMIN_HEADERS, json=payload, timeout=60)
        assert r.status_code == 200, r.text[:800]
        d = r.json()
        assert d.get("finished_ok") is True, f"errors={d.get('errors')}"
        assert d.get("errors") == []
        tfd = d.get("t_first_delta_ms")
        ttot = d.get("t_total_ms")
        assert isinstance(tfd, int) and 100 < tfd < 8000, f"t_first_delta_ms out of range: {tfd}"
        assert isinstance(ttot, int) and 500 < ttot < 15000, f"t_total_ms out of range: {ttot}"
        assert d.get("audio_bytes_total", 0) > 10000, d.get("audio_bytes_total")
        transcript = d.get("transcript_out") or ""
        assert isinstance(transcript, str) and len(transcript.strip()) > 0
        cost = d.get("cost_usd_estimated") or 0.0
        assert 0.0001 < cost < 0.05, f"cost out of expected range: {cost}"

    def test_report_after_turn(self, api):
        r = api.get(self.REPORT_URL, headers=ADMIN_HEADERS)
        assert r.status_code == 200, r.text
        d = r.json()
        # After previous happy-path test at least 1 run must be present
        assert d.get("runs_count", 0) >= 1, d
        assert d.get("ttfb_audio_ms_stats") is not None
        assert d.get("total_ms_stats") is not None

    def test_guardrail_battery_jailbreak(self, api):
        payload = {
            "model": "gpt-realtime-2.1-mini",
            "voice": "marin",
            "instructions_variant": "warm_koda",
            "only_ids": ["jailbreak_1_ignore"],
        }
        r = api.post(self.BATTERY_URL, headers=ADMIN_HEADERS, json=payload, timeout=60)
        assert r.status_code == 200, r.text[:800]
        d = r.json()
        assert d.get("total_tests") == 1
        results = d.get("results") or []
        assert len(results) == 1
        assert results[0].get("id") == "jailbreak_1_ignore"
        assert results[0].get("passed") is True, results[0]

    def test_barge_in_notes(self, api):
        r = api.get(self.NOTES_URL, headers=ADMIN_HEADERS)
        assert r.status_code == 200, r.text
        d = r.json()
        assert isinstance(d.get("summary"), str) and len(d["summary"]) > 20
