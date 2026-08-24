"""
KODA — Iter21: In-session tier switch router bug fix (2026-01)
================================================================
Fabio's P0 bug: cambio tier IN-SESSIONE (via dev button 'Simula Premium' /
'Torna Free' in Impostazioni, o via 'DEV Bypass Paywall') non funzionava
senza restart. Il fix aggiunge keyed invalidation LOCALE al router
Free/Premium in /app/frontend/app/index.tsx e nuova funzione
resetLastDecidedKey() in lib/routerGlobalState.ts chiamata dai dev button.

Backend contract coverage:
  T1: sequenza set-tier null → monthly → bimonthly → null (+ GET /profile
      verifica persistence dopo ogni set)
  T4: auth admin gating su /dev/set-tier, /dev/intro-premium/reset,
      /intro-premium/state, /admin/whoami
"""
# Fabio Google admin UID (see /app/memory/test_credentials.md)
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
ADMIN_UID = "ee4e7261-e1b5-485c-8a68-778cac455e39"


@pytest.fixture(scope="module")
def admin_headers():
    return {"X-User-Id": ADMIN_UID, "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def anon_headers():
    return {"Content-Type": "application/json"}


# --------- TEST 4: Auth gating (admin required) ---------

class TestAuthGating:
    """/api/dev/*, /api/admin/whoami require admin auth."""

    def test_whoami_admin_returns_is_admin_true(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/whoami", headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("is_admin") is True
        assert "uid_short" in data

    def test_whoami_anon_returns_is_admin_false(self, anon_headers):
        # NB: /admin/whoami è pattern non-throwing: risponde 200 con is_admin=false
        r = requests.get(f"{BASE_URL}/api/admin/whoami", headers=anon_headers, timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data.get("is_admin") is False

    def test_set_tier_anon_forbidden(self, anon_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            json={"tier": "monthly"},
            headers=anon_headers,
            timeout=10,
        )
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text}"

    def test_intro_premium_reset_anon_forbidden(self, anon_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/intro-premium/reset",
            headers=anon_headers,
            timeout=10,
        )
        assert r.status_code in (401, 403)

    def test_intro_premium_state_admin_reachable(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/intro-premium/state", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert "seen" in data
        assert isinstance(data["seen"], bool)


# --------- TEST 1: E2E tier switch flow ---------

class TestTierSwitchFlow:
    """Sequenza completa che simula i dev button "Torna Free" / "Simula Premium"."""

    def _get_profile(self, headers):
        r = requests.get(f"{BASE_URL}/api/profile", headers=headers, timeout=10)
        assert r.status_code == 200, r.text
        return r.json()

    def _set_tier(self, headers, tier):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            json={"tier": tier},
            headers=headers,
            timeout=10,
        )
        assert r.status_code == 200, f"set-tier({tier}) failed: {r.status_code} {r.text}"
        data = r.json()
        assert data.get("ok") is True
        assert data.get("subscription_tier") == tier, f"echoed tier != {tier}: {data}"
        return data

    def test_a_set_tier_null_free(self, admin_headers):
        self._set_tier(admin_headers, None)

    def test_b_profile_reflects_free(self, admin_headers):
        p = self._get_profile(admin_headers)
        assert p.get("subscription_tier") in (None, "null", ""), (
            f"expected free (None), got {p.get('subscription_tier')}"
        )

    def test_c_set_tier_monthly(self, admin_headers):
        self._set_tier(admin_headers, "monthly")

    def test_d_profile_reflects_monthly(self, admin_headers):
        p = self._get_profile(admin_headers)
        assert p.get("subscription_tier") == "monthly"

    def test_e_set_tier_bimonthly(self, admin_headers):
        self._set_tier(admin_headers, "bimonthly")

    def test_f_profile_reflects_bimonthly(self, admin_headers):
        p = self._get_profile(admin_headers)
        assert p.get("subscription_tier") == "bimonthly"

    def test_g_reset_intro_premium(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/intro-premium/reset",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("ok") is True
        assert data.get("reset") == "intro_premium_seen_at"

    def test_h_intro_premium_state_after_reset(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/intro-premium/state", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data.get("seen") is False, (
            f"after reset expected seen=false, got {data}"
        )
        assert data.get("seen_at") is None

    def test_i_invalid_tier_rejected(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/dev/set-tier",
            json={"tier": "bogus"},
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 400, f"expected 400 for invalid tier, got {r.status_code}"

    def test_z_cleanup_restore_free(self, admin_headers):
        """teardown: torna a free per non lasciare l'admin Fabio in stato monthly."""
        self._set_tier(admin_headers, None)
        p = self._get_profile(admin_headers)
        assert p.get("subscription_tier") in (None, "", "null")
