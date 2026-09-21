"""
Test /api/converse `demo_mode` flag (Fabio 2026-06-18, verified Jan 2026).

Scope:
  1. demo_mode=True MUST NOT leak user-specific memory (name, moto, past chats).
  2. demo_mode=True MUST NOT persist entries in taccuino_timeline.
  3. demo_mode=False (baseline) still works and may reference memory.

Note: /api/auth/login does not exist in this backend (only google/apple/dev-login).
We authenticate the "ollenya.play.review@gmail.com" identity by passing the
deterministic X-User-Id derived via _email_to_uid (sha256 UUID-like).
We seed profile.name="Fabio", memory_summary + key_facts + timeline about moto,
then verify demo_mode drops all of them from the LLM response.
"""

import os
import hashlib
import asyncio
import pytest
import requests
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

BASE_URL = (
    os.environ.get("EXPO_BACKEND_URL")
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ["EXPO_PACKAGER_PROXY_URL"]
).rstrip("/")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

TEST_EMAIL = "ollenya.play.review@gmail.com"


def _email_to_uid(email: str) -> str:
    h = hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"


TEST_UID = _email_to_uid(TEST_EMAIL)


# ---------------------------------------------------------------------------
# Seed helpers (async, via motor)
# ---------------------------------------------------------------------------
async def _seed_user_with_history():
    """Create user + profile w/ Fabio name, memory_summary about moto, key_facts
    about moto and 8 timeline entries mentioning moto."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    # 1. users
    await db.users.update_one(
        {"email": TEST_EMAIL},
        {"$set": {"email": TEST_EMAIL, "name": "Fabio"}},
        upsert=True,
    )

    # 2. profile with strong memory hints
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.taccuino_profile.update_one(
        {"id": TEST_UID},
        {
            "$set": {
                "id": TEST_UID,
                "profile_id": TEST_UID,
                "name": "Fabio",
                "language": "it",
                "ai_name": "Ollenya",
                "user_gender": "m",
                "ai_gender": "f",
                "memory_summary": (
                    "- Si chiama Fabio e ha una moto (una Ducati) di cui parla spesso\n"
                    "- Ama fare giri in moto sulle strade di montagna il weekend\n"
                    "- La sua moto è il suo modo per staccare dallo stress"
                ),
                "confidence_level": 5,
                "total_messages": 40,
                "created_at": now_iso,
                "updated_at": now_iso,
                "settings": {"ai_enabled": True, "situation_tracking_enabled": False},
            }
        },
        upsert=True,
    )

    # 3. key_facts about moto
    await db.taccuino_key_facts.delete_many({"profile_id": TEST_UID})
    kf_docs = [
        {"id": f"kf_test_1", "profile_id": TEST_UID, "fact": "Si chiama Fabio",
         "category": "identità", "source_text": "mi chiamo Fabio", "created_at": now_iso},
        {"id": f"kf_test_2", "profile_id": TEST_UID, "fact": "Ha una moto Ducati",
         "category": "hobby", "source_text": "ho una moto Ducati", "created_at": now_iso},
        {"id": f"kf_test_3", "profile_id": TEST_UID, "fact": "Ama i giri in moto",
         "category": "hobby", "source_text": "mi piace andare in moto", "created_at": now_iso},
    ]
    await db.taccuino_key_facts.insert_many(kf_docs)

    # 4. timeline seed (8 messages, all about moto)
    await db.taccuino_timeline.delete_many({"profile_id": TEST_UID})
    from uuid import uuid4
    ts_base = datetime.now(timezone.utc)
    entries = []
    for i, (role, text) in enumerate([
        ("user", "Ciao, mi chiamo Fabio e ho una moto Ducati."),
        ("ai", "Ciao Fabio, che bello sapere che sei un motociclista!"),
        ("user", "Oggi ho fatto un giro in moto stupendo sul passo dello Stelvio."),
        ("ai", "Fabio, dev'essere stato entusiasmante con la tua Ducati sui tornanti."),
        ("user", "La moto è la mia terapia contro lo stress del lavoro."),
        ("ai", "Ti capisco, Fabio. La tua moto è più di un mezzo, è libertà."),
        ("user", "Domani volevo pulire la catena della moto."),
        ("ai", "Ottima idea, Fabio. Manutenzione della Ducati sempre al top."),
    ]):
        entries.append({
            "id": str(uuid4()),
            "profile_id": TEST_UID,
            "role": role,
            "text": text,
            "timestamp": (ts_base.replace(microsecond=i * 1000)).isoformat(),
        })
    await db.taccuino_timeline.insert_many(entries)

    client.close()


async def _timeline_count():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    n = await db.taccuino_timeline.count_documents({"profile_id": TEST_UID})
    client.close()
    return n


async def _cleanup():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    await db.users.delete_one({"email": TEST_EMAIL})
    await db.taccuino_profile.delete_one({"id": TEST_UID})
    await db.taccuino_key_facts.delete_many({"profile_id": TEST_UID})
    await db.taccuino_timeline.delete_many({"profile_id": TEST_UID})
    client.close()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module", autouse=True)
def seed_and_teardown():
    asyncio.run(_seed_user_with_history())
    yield
    asyncio.run(_cleanup())


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "X-User-Id": TEST_UID,
    })
    return s


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
LEAKAGE_KEYWORDS = ["fabio", "moto", "ducati", "stelvio", "catena", "motociclista"]


def _contains_leak(text: str) -> list:
    t = (text or "").lower()
    return [kw for kw in LEAKAGE_KEYWORDS if kw in t]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestConverseDemoMode:

    def test_health_and_seed(self, api_client):
        """Sanity: backend up + seed applied."""
        r = api_client.get(f"{BASE_URL}/api/health", timeout=15)
        # some deployments don't have /health — fall back to profile
        if r.status_code == 404:
            r = api_client.get(f"{BASE_URL}/api/taccuino/profile", timeout=15)
        assert r.status_code in (200, 404), f"unexpected status {r.status_code}: {r.text[:200]}"
        n = asyncio.run(_timeline_count())
        assert n >= 8, f"seed timeline not applied, count={n}"

    def test_baseline_no_demo_mode_may_reference_memory(self, api_client):
        """
        Baseline: without demo_mode the response CAN (and usually does)
        reference the user's memory (Fabio, moto, Ducati...).
        We assert the endpoint still works. We LOG whether memory leaked.
        """
        payload = {"text": "Ciao", "is_voice_turn": False}
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r.status_code == 200, f"baseline converse failed: {r.status_code} {r.text[:400]}"
        data = r.json()
        assert "ai_entry" in data and "text" in data["ai_entry"]
        ai_text = data["ai_entry"]["text"]
        assert isinstance(ai_text, str) and len(ai_text.strip()) > 0
        leaks = _contains_leak(ai_text)
        print(f"\n[BASELINE ai_text]: {ai_text}")
        print(f"[BASELINE memory refs found]: {leaks}")
        # No hard assertion here — depends on LLM randomness. Informational.

    def test_demo_mode_true_no_memory_leak(self, api_client):
        """
        CRITICAL: demo_mode=true → response must be generic. No name, no moto.
        """
        payload = {"text": "Ciao", "is_voice_turn": False, "demo_mode": True}
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r.status_code == 200, f"demo converse failed: {r.status_code} {r.text[:400]}"
        data = r.json()
        ai_text = data["ai_entry"]["text"]
        assert isinstance(ai_text, str) and len(ai_text.strip()) > 0
        leaks = _contains_leak(ai_text)
        print(f"\n[DEMO ai_text]: {ai_text}")
        print(f"[DEMO memory refs found]: {leaks}")
        assert not leaks, (
            f"demo_mode leaked user-specific memory tokens {leaks} in AI response:\n{ai_text}"
        )

    def test_demo_mode_true_does_not_persist_to_timeline(self, api_client):
        """demo_mode=true must NOT insert into taccuino_timeline."""
        before = asyncio.run(_timeline_count())
        payload = {"text": "Ciao, come funziona?", "is_voice_turn": False, "demo_mode": True}
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r.status_code == 200
        # small sleep in case save is async (it's sync in normal path, but be safe)
        import time
        time.sleep(1.0)
        after = asyncio.run(_timeline_count())
        assert after == before, (
            f"demo_mode WROTE to timeline (before={before}, after={after}). "
            "Should be zero delta."
        )

    def test_normal_mode_does_persist_to_timeline(self, api_client):
        """Regression: without demo_mode entries ARE saved (delta ≥ 2)."""
        before = asyncio.run(_timeline_count())
        payload = {"text": "TEST_NORMAL persistence check", "is_voice_turn": False}
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r.status_code == 200
        import time
        time.sleep(1.0)
        after = asyncio.run(_timeline_count())
        assert after >= before + 2, (
            f"normal mode failed to persist user+ai entries (before={before}, after={after})"
        )

    def test_demo_mode_with_ephemeral_false_still_ephemeral(self, api_client):
        """
        demo_mode=true forces ephemeral=true even if request sends ephemeral=false.
        Verify no side effects (no timeline insert).
        """
        before = asyncio.run(_timeline_count())
        payload = {
            "text": "Ciao Ollenya",
            "is_voice_turn": False,
            "demo_mode": True,
            "ephemeral": False,   # explicit false must be overridden
        }
        r = api_client.post(f"{BASE_URL}/api/converse", json=payload, timeout=60)
        assert r.status_code == 200
        import time
        time.sleep(1.0)
        after = asyncio.run(_timeline_count())
        assert after == before, (
            f"demo_mode did NOT force ephemeral (before={before}, after={after})"
        )
