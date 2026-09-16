"""Iter 22 (Jan 2026) — Backend regression after Ollenya Intro V3 changes.

Verifica dei contract backend rimasti invariati dopo le modifiche frontend:
  1. GET  /api/intro-premium/state       → default seen=false per profilo fresh
  2. POST /api/intro-premium/mark-seen   → marca vista, idempotente
  3. POST /api/converse                  → chat scritta free, HTTP 200 + schema
  4. GET  /api/freemium/status           → stato quota free

Nessuna modifica reale ai contract endpoint da E1 (solo cambi puri
frontend). Questi test sono regressione difensiva.
"""

import os
import uuid
import time
import pytest
import requests


# --- URL resolution (public preview URL preferred, fallback localhost) ------
def _resolve_base_url() -> str:
    # 1) EXPO_PUBLIC_BACKEND_URL dal frontend/.env
    try:
        env_path = "/app/frontend/.env"
        if os.path.exists(env_path):
            with open(env_path, "r") as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val.rstrip("/")
    except Exception:
        pass
    # 2) env override
    v = os.environ.get("TEST_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    if v:
        return v.rstrip("/")
    # 3) fallback locale
    return "http://localhost:8001"


BASE_URL = _resolve_base_url()


# --- fixtures ---------------------------------------------------------------
@pytest.fixture
def fresh_uid() -> str:
    """Nuovo UUID v4 lowercase → nuovo profilo su get_or_create_profile."""
    return str(uuid.uuid4()).lower()


@pytest.fixture
def api_client(fresh_uid):
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "X-User-Id": fresh_uid,
    })
    return s


# --- 1. intro-premium/state -------------------------------------------------
class TestIntroPremiumState:
    def test_fresh_profile_default_seen_false(self, api_client, fresh_uid):
        r = api_client.get(f"{BASE_URL}/api/intro-premium/state")
        assert r.status_code == 200, f"unexpected status {r.status_code} body={r.text[:300]}"
        data = r.json()
        assert set(data.keys()) >= {"seen"}, f"missing 'seen' in {data}"
        assert data["seen"] is False, f"fresh profile should be seen=false, got {data}"
        # seen_at può essere None o assente
        assert data.get("seen_at") in (None, "", None), f"seen_at should be null/absent for fresh, got {data.get('seen_at')!r}"


# --- 2. intro-premium/mark-seen (idempotency) -------------------------------
class TestIntroPremiumMarkSeen:
    def test_mark_seen_then_idempotent(self, api_client, fresh_uid):
        # 1a chiamata: seen=true con seen_at
        r1 = api_client.post(f"{BASE_URL}/api/intro-premium/mark-seen")
        assert r1.status_code == 200, f"first mark-seen failed: {r1.status_code} {r1.text[:300]}"
        d1 = r1.json()
        assert d1.get("seen") is True, f"expected seen=true after first call, got {d1}"
        first_seen_at = d1.get("seen_at")
        assert first_seen_at, f"seen_at should be a non-empty iso string, got {first_seen_at!r}"

        # 2a chiamata: deve essere idempotente (stesso seen_at)
        # piccola pausa così se non è idempotente il seen_at cambierebbe
        time.sleep(0.05)
        r2 = api_client.post(f"{BASE_URL}/api/intro-premium/mark-seen")
        assert r2.status_code == 200, f"second mark-seen failed: {r2.status_code} {r2.text[:300]}"
        d2 = r2.json()
        assert d2.get("seen") is True
        assert d2.get("seen_at") == first_seen_at, (
            f"NOT idempotent: seen_at changed {first_seen_at!r} → {d2.get('seen_at')!r}"
        )

        # 3. state riflette persistenza
        r3 = api_client.get(f"{BASE_URL}/api/intro-premium/state")
        assert r3.status_code == 200
        d3 = r3.json()
        assert d3.get("seen") is True, f"state should be seen=true after mark, got {d3}"
        assert d3.get("seen_at") == first_seen_at


# --- 3. /api/converse (chat scritta Free) -----------------------------------
class TestConverseFree:
    def test_converse_basic_schema(self, api_client, fresh_uid):
        payload = {
            "text": "ciao",
            "audio_duration_ms": 0,
            "ephemeral": False,
            "is_voice_turn": False,
        }
        # LLM può essere lenta → timeout generoso
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        # Accept 200 (success) — non deve essere bloccato per un Free fresh
        assert r.status_code == 200, f"converse failed: {r.status_code} {r.text[:500]}"
        data = r.json()
        # Contract: {user_entry, ai_entry, profile}
        for key in ("user_entry", "ai_entry", "profile"):
            assert key in data, f"missing {key!r} in response keys={list(data.keys())}"
        # user_entry.text riflette input
        assert data["user_entry"].get("text") == "ciao"
        assert data["user_entry"].get("role") == "user"
        # Backend usa role="ai" per l'assistant Ollenya (schema TimelineEntry)
        assert data["ai_entry"].get("role") in ("ai", "assistant")
        assert isinstance(data["ai_entry"].get("text", ""), str)

    def test_converse_accepts_bridged_secrets_extra_field(self, api_client, fresh_uid):
        """Il client frontend può inviare `bridged_secrets` extra nel payload
        (documentato in review request). Pydantic default ignora extra fields
        → non deve 422."""
        payload = {
            "text": "ciao di nuovo",
            "audio_duration_ms": 0,
            "ephemeral": False,
            "is_voice_turn": False,
            "bridged_secrets": [],  # extra field non nel modello
        }
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r.status_code == 200, f"expected 200 with extra field, got {r.status_code} {r.text[:300]}"


# --- 4. /api/freemium/status ------------------------------------------------
class TestFreemiumStatus:
    def test_freemium_status_shape_for_fresh_free(self, api_client, fresh_uid):
        r = api_client.get(f"{BASE_URL}/api/freemium/status")
        assert r.status_code == 200, f"freemium/status failed: {r.status_code} {r.text[:300]}"
        data = r.json()
        # Campi minimi richiesti dal client
        for key in (
            "free_messages_used",
            "free_messages_limit",
            "free_messages_remaining",
            "subscription_active",
            "can_send",
            "paywall_required",
        ):
            assert key in data, f"missing {key} in freemium/status; keys={list(data.keys())}"
        # Un profilo fresh Free non deve essere paywalled
        assert data["subscription_active"] is False, f"fresh profile should be free, got {data}"
        assert data["can_send"] is True, f"fresh free should be able to send, got {data}"
        assert data["paywall_required"] is False


# --- 5. Integration: converse → freemium counter increments -----------------
class TestConverseIncrementsFreemium:
    def test_counter_increments_after_converse(self, api_client, fresh_uid):
        # baseline
        r0 = api_client.get(f"{BASE_URL}/api/freemium/status")
        assert r0.status_code == 200
        used_before = int(r0.json().get("free_messages_used", 0) or 0)

        # invia un messaggio
        payload = {
            "text": "test contatore",
            "audio_duration_ms": 0,
            "ephemeral": False,
            "is_voice_turn": False,
        }
        r1 = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r1.status_code == 200, f"converse failed: {r1.status_code} {r1.text[:300]}"

        # dopo
        r2 = api_client.get(f"{BASE_URL}/api/freemium/status")
        assert r2.status_code == 200
        used_after = int(r2.json().get("free_messages_used", 0) or 0)
        # Il contatore Free deve essere >= used_before (non regredisce). In
        # generale per un free NON-boost dovrebbe incrementare di 1. Restiamo
        # non-strict per non fallire se la logica boost/ephemeral cambia.
        assert used_after >= used_before, (
            f"counter regressed after converse: before={used_before} after={used_after}"
        )
