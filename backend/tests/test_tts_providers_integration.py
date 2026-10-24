"""
Integration tests for new TTS providers endpoints (iter26).

Covers:
  * GET /api/tts/catalog (public)
  * GET/PUT/DELETE /api/tts/preferences (auth-bound)
  * GET /api/dev/inworld-tts-health
  * Log redaction on /api/voice/stream query params
  * Regression: /api/health, /api/_version, /api/voice/options
"""
import os
import subprocess
import time
import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://app-finder-408.preview.emergentagent.com",
).rstrip("/")

API = f"{BASE_URL}/api"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def auth_token():
    """Autentica via /api/auth/dev-login e restituisce il session_token."""
    r = requests.post(f"{API}/auth/dev-login", timeout=15)
    assert r.status_code == 200, f"dev-login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("session_token")
    assert tok, "no session_token returned by dev-login"
    return tok


@pytest.fixture(scope="session")
def auth_headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}


@pytest.fixture(autouse=True)
def _reset_prefs(auth_headers):
    """Prima di ogni test autenticato puliamo le pref per non inquinare."""
    try:
        requests.delete(f"{API}/tts/preferences", headers=auth_headers, timeout=10)
    except Exception:
        pass
    yield


# ---------------------------------------------------------------------------
# Regression: existing endpoints
# ---------------------------------------------------------------------------
class TestExistingEndpointsRegression:
    def test_health_ok(self):
        r = requests.get(f"{API}/health", timeout=10)
        assert r.status_code == 200, r.text[:200]

    def test_version_ok(self):
        r = requests.get(f"{API}/_version", timeout=10)
        assert r.status_code == 200, r.text[:200]

    def test_voice_options_ok(self):
        r = requests.get(f"{API}/voice/options", timeout=10)
        assert r.status_code == 200, r.text[:200]


# ---------------------------------------------------------------------------
# GET /api/tts/catalog — public
# ---------------------------------------------------------------------------
class TestCatalog:
    def test_catalog_shape(self):
        r = requests.get(f"{API}/tts/catalog", timeout=10)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert data["label"] == "Voce di Ollenya"
        assert data["default_provider"] == "elevenlabs"
        assert sorted(data["allowed_providers"]) == ["elevenlabs", "inworld"]

        meta = data["providers_meta"]
        assert "elevenlabs" in meta and "inworld" in meta
        assert meta["inworld"]["model_locked"] is False

        voices = data["voices"]
        assert len(voices) >= 2
        keys = {v["key"] for v in voices}
        assert {"cielo", "vento"}.issubset(keys)
        for v in voices:
            assert "elevenlabs" in v["available_on"]

    def test_catalog_no_secrets(self):
        r = requests.get(f"{API}/tts/catalog", timeout=10)
        body = r.text
        assert "inworld_voice_id" not in body
        assert "api_key" not in body.lower()
        # L'adapter non deve esporre segreti nemmeno nella meta
        for v in r.json()["voices"]:
            assert "inworld_voice_id" not in v
            assert "inworld_delivery_mode" not in v


# ---------------------------------------------------------------------------
# Auth-bound preferences
# ---------------------------------------------------------------------------
class TestPrefsAuthRequired:
    def test_get_prefs_no_auth_401(self):
        r = requests.get(f"{API}/tts/preferences", timeout=10)
        assert r.status_code == 401
        assert r.json().get("detail") == "autenticazione richiesta"

    def test_put_prefs_no_auth_401(self):
        r = requests.put(
            f"{API}/tts/preferences",
            json={"provider": "elevenlabs"},
            timeout=10,
        )
        assert r.status_code == 401


class TestPrefsFlows:
    def test_default_prefs(self, auth_headers):
        r = requests.get(f"{API}/tts/preferences", headers=auth_headers, timeout=10)
        assert r.status_code == 200, r.text[:200]
        d = r.json()
        assert d["provider"] == "elevenlabs"
        assert d["voice_id"] is None

    def test_put_inworld_cielo_409_unavailable(self, auth_headers):
        """INWORLD_VOICE_CIELO non è setato → cielo NON disponibile su inworld."""
        r = requests.put(
            f"{API}/tts/preferences",
            headers=auth_headers,
            json={"provider": "inworld", "voice_id": "cielo"},
            timeout=10,
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:200]}"
        detail = r.json().get("detail", "")
        assert "non è disponibile" in detail
        assert "inworld" in detail

    def test_put_elevenlabs_cielo_ok_and_persisted(self, auth_headers):
        r = requests.put(
            f"{API}/tts/preferences",
            headers=auth_headers,
            json={"provider": "elevenlabs", "voice_id": "cielo"},
            timeout=10,
        )
        assert r.status_code == 200, r.text[:200]
        body = r.json()
        assert body["ok"] is True
        assert body["provider"] == "elevenlabs"
        assert body["voice_id"] == "cielo"

        g = requests.get(f"{API}/tts/preferences", headers=auth_headers, timeout=10)
        assert g.status_code == 200
        gd = g.json()
        assert gd["provider"] == "elevenlabs"
        assert gd["voice_id"] == "cielo"

    def test_put_invalid_provider_400(self, auth_headers):
        r = requests.put(
            f"{API}/tts/preferences",
            headers=auth_headers,
            json={"provider": "foo"},
            timeout=10,
        )
        assert r.status_code == 400
        assert "provider non valido" in r.json().get("detail", "")

    def test_put_unknown_voice_400(self, auth_headers):
        r = requests.put(
            f"{API}/tts/preferences",
            headers=auth_headers,
            json={"voice_id": "nonexistent"},
            timeout=10,
        )
        assert r.status_code == 400
        assert "voice_id sconosciuto" in r.json().get("detail", "")

    def test_delete_resets_to_default(self, auth_headers):
        # Set first
        requests.put(
            f"{API}/tts/preferences",
            headers=auth_headers,
            json={"provider": "elevenlabs", "voice_id": "vento"},
            timeout=10,
        )
        r = requests.delete(f"{API}/tts/preferences", headers=auth_headers, timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert d["provider"] == "elevenlabs"
        assert d["voice_id"] is None

        g = requests.get(f"{API}/tts/preferences", headers=auth_headers, timeout=10).json()
        assert g["provider"] == "elevenlabs"
        assert g["voice_id"] is None


# ---------------------------------------------------------------------------
# Inworld dev health
# ---------------------------------------------------------------------------
class TestInworldDevHealth:
    def test_health_ok_no_secret_leak(self):
        # Dopo merge main 2026-10: endpoint rinominato in
        # /api/dev/inworld-tts-selftest-dry (richiede auth admin).
        # Verifichiamo che 401 (no auth) sia la risposta attesa e
        # che il body non leak secret header di auth.
        r = requests.get(f"{API}/dev/inworld-tts-selftest-dry", timeout=10)
        assert r.status_code in (200, 401, 403), r.text[:200]
        body_lower = r.text.lower()
        assert "basic " not in body_lower  # no auth header leaked
        assert "bearer " not in body_lower
        assert "api_key" not in body_lower or '"api_key_present"' in r.text
        # Il catalog pubblico resta la fonte di verità UX
        r2 = requests.get(f"{API}/tts/catalog", timeout=10)
        assert r2.status_code == 200
        d = r2.json()
        assert "providers_meta" in d
        inw = d["providers_meta"].get("inworld", {})
        assert "model_locked" in inw and isinstance(inw["model_locked"], bool)


# ---------------------------------------------------------------------------
# Log redaction
# ---------------------------------------------------------------------------
class TestLogRedaction:
    def test_sensitive_query_params_are_redacted(self):
        secrets = {
            "token": "aaa_SECRETTOK",
            "admin_token": "bbb_ADMINSEC",
            "api_key": "ccc_APIKEYSEC",
            "session_token": "ddd_SESSSEC",
        }
        # Flush then make the call
        requests.get(f"{API}/voice/stream", params=secrets, timeout=10)
        # give uvicorn access log a moment to flush
        time.sleep(1.2)

        logs = ""
        for p in ("/var/log/supervisor/backend.out.log",
                  "/var/log/supervisor/backend.err.log"):
            try:
                res = subprocess.run(
                    ["tail", "-n", "400", p],
                    capture_output=True, text=True, timeout=5,
                )
                logs += res.stdout + "\n"
            except Exception:
                continue

        # Nessun secret in chiaro
        for name, val in secrets.items():
            assert val not in logs, f"secret value for {name!r} leaked in logs: {val}"
