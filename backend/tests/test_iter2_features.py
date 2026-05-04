"""Tests for Iteration 2 new features:
- GET /api/featured-app (weekly featured rotation)
- POST /api/transcribe (Whisper STT)
"""
import io
import os
import struct
import wave

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://app-finder-408.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    return requests.Session()


# ---------- Featured app ----------
def test_featured_app_shape(s):
    r = s.get(f"{API}/featured-app", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "week" in data and isinstance(data["week"], int)
    assert "app" in data
    app = data["app"]
    for k in ("name", "emoji", "tagline", "category", "url"):
        assert k in app and app[k], f"missing/empty field {k} -> {app}"
    assert app["url"].startswith("http")


def test_featured_app_stable_within_week(s):
    a = s.get(f"{API}/featured-app", timeout=30).json()
    b = s.get(f"{API}/featured-app", timeout=30).json()
    assert a == b


# ---------- Transcribe ----------
def _make_silent_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(seconds * rate)
        w.writeframes(struct.pack("<" + "h" * n, *([0] * n)))
    return buf.getvalue()


def test_transcribe_empty_returns_400(s):
    files = {"audio": ("empty.wav", b"", "audio/wav")}
    r = s.post(f"{API}/transcribe", files=files, data={"language": "it"}, timeout=60)
    assert r.status_code == 400, f"Expected 400 for empty, got {r.status_code}: {r.text}"


def test_transcribe_silent_wav(s):
    wav_bytes = _make_silent_wav(1.0)
    files = {"audio": ("silence.wav", wav_bytes, "audio/wav")}
    r = s.post(f"{API}/transcribe", files=files, data={"language": "it"}, timeout=120)
    # Whisper should accept the file. Either 200 with text (possibly empty) or non-500.
    assert r.status_code != 500, f"Server error on valid audio: {r.text}"
    if r.status_code == 200:
        data = r.json()
        assert "text" in data
        assert isinstance(data["text"], str)
    else:
        # Acceptable if 4xx (e.g. provider rejects too-short / silent audio); just must not be 500
        assert 400 <= r.status_code < 500


# ---------- Regression: existing endpoints still work ----------
def test_categories_still_work(s):
    r = s.get(f"{API}/categories", timeout=30)
    assert r.status_code == 200
    assert len(r.json()) == 12


def test_favorites_get_still_work(s):
    r = s.get(f"{API}/favorites", timeout=30)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_history_get_still_work(s):
    r = s.get(f"{API}/history", timeout=30)
    assert r.status_code == 200
    assert isinstance(r.json(), list)
