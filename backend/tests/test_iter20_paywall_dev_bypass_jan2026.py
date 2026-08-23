"""
Iteration 20 — Sanity check backend contract per fix Build 18 (Fabio 2026-01).

Bug P0 fixato dall'agent:
  - Paywall dev bypass button MAI renderizzato perché usava
    api.getProfile().is_admin ma Profile response NON contiene is_admin.
  - Fix: usare /api/admin/whoami invece di /api/profile per admin check.

Test contract:
  T1a — GET /api/admin/whoami con admin → {is_admin:true, uid_short:str}
  T1b — GET /api/profile con admin → 200, NO 'is_admin' field (dimostra bug)
  T1c — POST /api/dev/set-tier {"tier":"bimonthly"} → {ok:true, subscription_tier}
  T1d — POST /api/dev/set-tier {"tier":null} → 200 (reset a Free)
  T1e — POST /api/dev/intro-premium/reset → {ok:true, reset:"intro_premium_seen_at"}
"""
import os
import requests
import pytest

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://app-finder-408.preview.emergentagent.com").rstrip("/")

# Admin UID whitelisted (Fabio Google — vedi /app/memory/test_credentials.md)
ADMIN_UID = "ee4e7261-e1b5-485c-8a68-778cac455e39"


@pytest.fixture(scope="module")
def admin_headers():
    return {"X-User-Id": ADMIN_UID, "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def anon_headers():
    return {"Content-Type": "application/json"}


# ============ T1a — /api/admin/whoami (admin) ============
class TestAdminWhoAmI:
    def test_whoami_admin_returns_is_admin_true(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/whoami", headers=admin_headers, timeout=15)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("is_admin") is True, f"Expected is_admin=true, got: {data}"
        assert isinstance(data.get("uid_short"), str) and len(data["uid_short"]) > 0, f"uid_short missing/empty: {data}"

    def test_whoami_anon_returns_is_admin_false(self, anon_headers):
        r = requests.get(f"{BASE_URL}/api/admin/whoami", headers=anon_headers, timeout=15)
        # Endpoint deve rispondere 200 con is_admin=false (NON 403), per non
        # rompere client non-admin che chiamano al boot.
        assert r.status_code == 200, f"Expected 200 for anon (fail-closed with is_admin:false), got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("is_admin") is False, f"Anon must get is_admin=false, got: {data}"


# ============ T1b — /api/profile (admin) manca is_admin ============
class TestProfileNoIsAdmin:
    def test_profile_response_does_not_contain_is_admin(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/profile", headers=admin_headers, timeout=15)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        data = r.json()
        # DIMOSTRA IL BUG ORIGINALE: Profile response non ha is_admin
        assert "is_admin" not in data, (
            f"REGRESSION: Profile ora contiene 'is_admin' — se questo passa, il fix "
            f"originale (usare /api/admin/whoami) non è più necessario. Data keys: {list(data.keys())}"
        )
        # Sanity: campo id esiste (siamo davvero autenticati come utente Fabio)
        assert "id" in data


# ============ T1c/d — /api/dev/set-tier ============
class TestDevSetTier:
    def test_set_tier_bimonthly(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            headers=admin_headers,
            json={"tier": "bimonthly"},
            timeout=15,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("ok") is True, f"Expected ok=true, got: {data}"
        assert data.get("subscription_tier") == "bimonthly", f"Expected tier=bimonthly, got: {data}"

    def test_set_tier_annual(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            headers=admin_headers,
            json={"tier": "annual"},
            timeout=15,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("ok") is True
        assert data.get("subscription_tier") == "annual"

    def test_set_tier_null_resets_to_free(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            headers=admin_headers,
            json={"tier": None},
            timeout=15,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("ok") is True, f"Expected ok=true on reset, got: {data}"
        # Dopo reset il tier deve essere None (Free)
        assert data.get("subscription_tier") in (None, "null"), f"Expected null tier after reset, got: {data}"

    def test_set_tier_non_admin_forbidden(self, anon_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            headers=anon_headers,
            json={"tier": "bimonthly"},
            timeout=15,
        )
        # Endpoint DEV admin-only → non-admin deve essere bloccato
        assert r.status_code in (401, 403), f"Non-admin must be blocked, got {r.status_code}: {r.text[:200]}"


# ============ T1e — /api/dev/intro-premium/reset ============
class TestDevIntroPremiumReset:
    def test_intro_premium_reset_admin(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/intro-premium/reset",
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("ok") is True, f"Expected ok=true, got: {data}"
        assert data.get("reset") == "intro_premium_seen_at", f"Expected reset field, got: {data}"

    def test_intro_premium_reset_non_admin_forbidden(self, anon_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/intro-premium/reset",
            headers=anon_headers,
            timeout=15,
        )
        assert r.status_code in (401, 403), f"Non-admin must be blocked, got {r.status_code}: {r.text[:200]}"


# ============ Integrazione: sequenza usata dal paywall handleDevBypass ============
class TestPaywallDevBypassSequence:
    """Riproduce esattamente la sequenza che il paywall.tsx handleDevBypass
    esegue quando l'admin clicca il bottone [DEV] Simula pagamento riuscito."""

    def test_full_bypass_sequence(self, admin_headers):
        # Step 1: whoami (check admin)
        r1 = requests.get(f"{BASE_URL}/api/admin/whoami", headers=admin_headers, timeout=15)
        assert r1.status_code == 200
        assert r1.json().get("is_admin") is True

        # Step 2: devSetTier (tier=bimonthly, selected default in UI)
        r2 = requests.post(f"{BASE_URL}/api/dev/set-tier", headers=admin_headers, json={"tier": "bimonthly"}, timeout=15)
        assert r2.status_code == 200
        assert r2.json().get("subscription_tier") == "bimonthly"

        # Step 3: devIntroPremiumReset
        r3 = requests.post(f"{BASE_URL}/api/dev/intro-premium/reset", headers=admin_headers, timeout=15)
        assert r3.status_code == 200
        assert r3.json().get("ok") is True

        # Cleanup: reset a Free per non lasciare l'admin in Premium
        r4 = requests.post(f"{BASE_URL}/api/dev/set-tier", headers=admin_headers, json={"tier": None}, timeout=15)
        assert r4.status_code == 200
