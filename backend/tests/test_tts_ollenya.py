"""Regression tests for /api/tts (Ollenya voice intro V3).

Verifies that:
  1. The endpoint returns binary MP3 for a valid voice_id with microdemo bypass.
  2. The endpoint returns 5xx when the client-supplied voice_id does NOT exist
     on the ElevenLabs account tied to ELEVENLABS_API_KEY.
  3. Endpoint is reachable both via local (127.0.0.1:8001) and public
     (EXPO_PUBLIC_BACKEND_URL) hosts and behavior is consistent.

RCA (2026-01, Ollenya "doesn't speak" bug):
  Frontend OllenyaIntroV3.tsx:739 hardcodes voice_id="vTgTi6iSjMPqDpAcJfju",
  which does NOT exist on the current ElevenLabs account. ElevenLabs replies
  with 404 voice_not_found; backend re-raises as HTTP 500. The frontend
  `playDynamicTTS` then silently skips playback (`if (!r.ok) advance`) —
  giving the impression that Ollenya "doesn't speak". The correct Cielo
  voice_id used everywhere else in the app is "POuqf18evoXOKIqV2Px7".
"""
import os
import pytest
import requests

LOCAL_BASE = "http://localhost:8001"
PUBLIC_BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")

# The voice_id currently hardcoded in the frontend (OllenyaIntroV3.tsx:739).
BROKEN_VOICE_ID = "vTgTi6iSjMPqDpAcJfju"
# The correct Cielo voice_id used everywhere else in the codebase.
CIELO_VOICE_ID = "POuqf18evoXOKIqV2Px7"

INTRO_TEXT = "Ciao, io sono Ollenya, e tu?"


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _payload(voice_id: str | None = None) -> dict:
    p = {"text": INTRO_TEXT, "tone": "warm", "microdemo": True}
    if voice_id is not None:
        p["voice_id"] = voice_id
    return p


class TestTTSLocal:
    """Tests against localhost:8001."""

    def test_tts_frontend_hardcoded_voice_reproduces_bug(self, api_client):
        """Reproduces the reported bug: the voice_id hardcoded in OllenyaIntroV3
        results in a non-2xx response, so the frontend blob() call is skipped
        and no audio plays."""
        r = api_client.post(f"{LOCAL_BASE}/api/tts", json=_payload(BROKEN_VOICE_ID), timeout=30)
        assert r.status_code >= 400, (
            f"Expected failure for broken voice_id, got {r.status_code}. "
            f"Body: {r.text[:400]}"
        )
        # And the reason must be voice_not_found from ElevenLabs.
        assert "voice_not_found" in r.text or "not found" in r.text.lower(), r.text[:400]

    def test_tts_cielo_voice_returns_audio(self, api_client):
        """Sanity: with the CORRECT Cielo voice_id, we get real MP3 bytes."""
        r = api_client.post(f"{LOCAL_BASE}/api/tts", json=_payload(CIELO_VOICE_ID), timeout=60)
        assert r.status_code == 200, f"HTTP {r.status_code}, body: {r.text[:400]}"
        assert r.headers.get("content-type", "").startswith("audio/"), r.headers
        assert len(r.content) > 1024, f"audio too small: {len(r.content)} bytes"
        # MP3 magic: ID3 or 0xFF 0xFB/0xFA/0xF3/0xF2 frame sync
        head = r.content[:3]
        assert head.startswith(b"ID3") or (r.content[0] == 0xFF and (r.content[1] & 0xE0) == 0xE0), (
            f"Not an MP3 payload, first bytes: {r.content[:8]!r}"
        )

    def test_tts_default_voice_returns_audio(self, api_client):
        """When no voice_id is provided the endpoint falls back to the default
        (Acqua = 6TngzmzM89jJ3Y2Yiywr) and returns audio."""
        r = api_client.post(f"{LOCAL_BASE}/api/tts", json=_payload(None), timeout=60)
        assert r.status_code == 200, f"HTTP {r.status_code}, body: {r.text[:400]}"
        assert r.headers.get("content-type", "").startswith("audio/")
        assert len(r.content) > 1024

    def test_tts_empty_text_returns_400(self, api_client):
        r = api_client.post(f"{LOCAL_BASE}/api/tts", json={"text": "", "microdemo": True}, timeout=15)
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"


@pytest.mark.skipif(not PUBLIC_BASE, reason="EXPO_PUBLIC_BACKEND_URL not set")
class TestTTSPublic:
    """Same behavior must hold when hitting the public preview URL."""

    def test_tts_broken_voice_public(self, api_client):
        r = api_client.post(f"{PUBLIC_BASE}/api/tts", json=_payload(BROKEN_VOICE_ID), timeout=45)
        assert r.status_code >= 400
        assert "voice_not_found" in r.text or "not found" in r.text.lower()

    def test_tts_cielo_voice_public(self, api_client):
        r = api_client.post(f"{PUBLIC_BASE}/api/tts", json=_payload(CIELO_VOICE_ID), timeout=60)
        assert r.status_code == 200, f"HTTP {r.status_code}, body: {r.text[:400]}"
        assert r.headers.get("content-type", "").startswith("audio/")
        assert len(r.content) > 1024
