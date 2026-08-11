"""
Iteration 18 (Jan 2026, Fabio) — Backend regression for Paywall Trial V3.

Bug fix under test:
  1. `_apply_trial_seed` / `_increment_trial_seconds` previously wrote to
     `db.profiles/_id` (phantom collection) instead of `db.taccuino_profile/id`.
     → seed dev endpoints didn't persist.
  2. `/api/trial/state` always returned "active" for admin/unlimited users
     (whitelist bypass) → TrialWatcher polling never saw "expired".
     Fixed by introducing `trial_dev_override` flag that, when True, forces
     `_compute_trial_state()` result to be returned even for unlimited users.

We validate:
  - /api/dev/trial/seed-expired → state expired, seconds >= 420
  - /api/trial/state agrees with the seed (bypass unlimited)
  - /api/dev/trial/inspect returns raw DB state
  - /api/dev/trial/seed-closing → state closing (300 <= sec < 420)
  - /api/dev/trial/seed-window-expired → state expired (via window)
  - /api/dev/trial/reset → active, seconds=0, override=false
  - Non-admin caller → 403 on all /api/dev/trial/*
"""
import os
import pytest
import requests


BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
ADMIN_UID = "ee4e7261-e1b5-485c-8a68-778cac455e39"
NON_ADMIN_UID = "11111111-2222-3333-4444-555555555555"

DEV_ENDPOINTS_POST = [
    "/api/dev/trial/seed-expired",
    "/api/dev/trial/seed-closing",
    "/api/dev/trial/seed-window-expired",
    "/api/dev/trial/reset",
]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "X-User-Id": ADMIN_UID,
    })
    return s


@pytest.fixture(scope="module")
def non_admin_session():
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "X-User-Id": NON_ADMIN_UID,
    })
    return s


@pytest.fixture(scope="module", autouse=True)
def reset_at_end(admin_session):
    """Guarantee we leave the admin profile clean regardless of test outcome."""
    yield
    try:
        admin_session.post(f"{BASE_URL}/api/dev/trial/reset", timeout=10)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 1. Initial reset — baseline
# ---------------------------------------------------------------------------
class TestTrialInitialReset:
    def test_reset_baseline(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/dev/trial/reset", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert data["profile_id"] == ADMIN_UID
        assert data["trial_state"] == "active"
        assert data["trial_seconds_used"] == 0.0
        assert data["trial_started_at"] in (None, "")
        assert data["trial_window_started_at"] in (None, "")

    def test_state_endpoint_returns_active_after_reset(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/trial/state", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"trial_state": "active"}


# ---------------------------------------------------------------------------
# 2. seed-expired → budget path
# ---------------------------------------------------------------------------
class TestTrialSeedExpiredBudget:
    def test_seed_expired_persists_and_returns_expired(self, admin_session):
        r = admin_session.post(
            f"{BASE_URL}/api/dev/trial/seed-expired", timeout=10
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["trial_state"] == "expired"
        # 500s > 420s = 7 min budget
        assert data["trial_seconds_used"] == 500.0
        assert data["trial_started_at"] is not None

    def test_trial_state_reflects_expired_despite_unlimited(self, admin_session):
        """Il bypass unlimited DEVE essere disattivato quando
        trial_dev_override=True. Senza il fix, questo tornava 'active'."""
        r = admin_session.get(f"{BASE_URL}/api/trial/state", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"trial_state": "expired"}

    def test_inspect_matches_seed(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/dev/trial/inspect", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data["trial_state"] == "expired"
        assert data["trial_seconds_used"] == 500.0
        assert data["profile_id"] == ADMIN_UID


# ---------------------------------------------------------------------------
# 3. seed-closing → closing zone
# ---------------------------------------------------------------------------
class TestTrialSeedClosing:
    def test_seed_closing_persists(self, admin_session):
        r = admin_session.post(
            f"{BASE_URL}/api/dev/trial/seed-closing", timeout=10
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["trial_state"] == "closing"
        assert data["trial_seconds_used"] == 350.0

    def test_trial_state_returns_closing(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/trial/state", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"trial_state": "closing"}


# ---------------------------------------------------------------------------
# 4. seed-window-expired → window path
# ---------------------------------------------------------------------------
class TestTrialSeedWindowExpired:
    def test_seed_window_expired_persists(self, admin_session):
        # Reset first so trial_seconds_used = 0 → forza il ramo "finestra"
        admin_session.post(f"{BASE_URL}/api/dev/trial/reset", timeout=10)

        r = admin_session.post(
            f"{BASE_URL}/api/dev/trial/seed-window-expired", timeout=10
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["trial_state"] == "expired"
        # seconds should still be 0 (window path only)
        assert data["trial_seconds_used"] == 0.0
        assert data["trial_window_started_at"] is not None

    def test_trial_state_returns_expired_via_window(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/trial/state", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"trial_state": "expired"}


# ---------------------------------------------------------------------------
# 5. Final reset — no residuals
# ---------------------------------------------------------------------------
class TestTrialFinalReset:
    def test_reset_clears_all_trial_fields(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/dev/trial/reset", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data["trial_state"] == "active"
        assert data["trial_seconds_used"] == 0.0
        assert data["trial_started_at"] in (None, "")
        assert data["trial_window_started_at"] in (None, "")

    def test_state_endpoint_returns_active_after_final_reset(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/trial/state", timeout=10)
        assert r.status_code == 200
        # dopo il reset trial_dev_override = False → unlimited bypass torna
        # a decidere → active per admin whitelisted
        assert r.json() == {"trial_state": "active"}

    def test_inspect_reflects_clean_state(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/dev/trial/inspect", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data["trial_state"] == "active"
        assert data["trial_seconds_used"] == 0.0


# ---------------------------------------------------------------------------
# 6. Authorization — non-admin must be 403
# ---------------------------------------------------------------------------
class TestTrialDevEndpointsAdminGate:
    @pytest.mark.parametrize("path", DEV_ENDPOINTS_POST)
    def test_non_admin_post_forbidden(self, non_admin_session, path):
        r = non_admin_session.post(f"{BASE_URL}{path}", timeout=10)
        assert r.status_code == 403, (
            f"{path} returned {r.status_code}: {r.text[:200]}"
        )

    def test_non_admin_inspect_forbidden(self, non_admin_session):
        r = non_admin_session.get(
            f"{BASE_URL}/api/dev/trial/inspect", timeout=10
        )
        assert r.status_code == 403
