"""
test_feedback_flow.py — Fabio 2026-09-11

Test integrazione feedback loop:
  1. Insert event fittizio in koda_events
  2. POST /api/feedback → aggiorna
  3. Retry POST /api/feedback → 409 conflict
  4. GET /api/admin/feedback-stats → aggregation corretta
  5. POST /api/admin/feedback/purge → cancella event senza feedback
"""
import asyncio
import os
import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv()

os.environ["KODA_ADMIN_TOKEN"] = "test_admin_token_123"

import server
import koda_feedback as kfb

from motor.motor_asyncio import AsyncIOMotorClient
import httpx


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    server.db = db

    # Cleanup dai run precedenti
    await db.koda_events.delete_many({})
    print("[cleanup] koda_events cleared\n")

    # Test 1: insert diretto via koda_feedback.build_event
    print("[test 1] Insert 5 event con diverse combinazioni...")
    combos = [
        ("Non ce la faccio più, sto crollando", "concerned", 4, "eleven_v3"),
        ("Ciao come stai?", "warm", 1, "eleven_turbo_v2_5"),
        ("Il classifier è bugged", "warm", 2, "eleven_turbo_v2_5"),
        ("Sono felice, ce l'ho fatta!", "energetic", 2, "eleven_turbo_v2_5"),
        ("Mi manca troppo", "concerned", 3, "eleven_turbo_v2_5"),
    ]
    event_ids = []
    for user_text, tone, intensity, model in combos:
        e = kfb.build_event(user_text, tone, intensity, model)
        await db.koda_events.insert_one(e)
        event_ids.append(e["event_id"])
        print(f"  ✓ {e['tone_family']:<10} {e['intensity_band']:<7} {e['trigger_group']:<22} → {e['event_id'][:8]}...")

    # Test 2: POST /api/feedback (uso server.api_feedback_submit direttamente)
    print("\n[test 2] POST feedback su 3 event...")
    for ev_id, ftype, fcat in [
        (event_ids[0], "negative", "too_intense"),
        (event_ids[1], "positive", None),
        (event_ids[2], "negative", "too_cold"),
    ]:
        req = server.FeedbackSubmitRequest(event_id=ev_id, feedback_type=ftype, feedback_category=fcat)
        r = await server.api_feedback_submit(req)
        print(f"  ✓ {ev_id[:8]}... {ftype:<8} {str(fcat or '-'):<15} → {r}")

    # Test 3: retry stesso event → 409
    print("\n[test 3] Retry feedback su event già votato...")
    try:
        req = server.FeedbackSubmitRequest(event_id=event_ids[0], feedback_type="positive")
        await server.api_feedback_submit(req)
        print("  ✗ MANCATO 409")
    except Exception as e:
        assert "409" in str(e) or "already" in str(e).lower()
        print(f"  ✓ 409 as expected: {str(e)[:80]}")

    # Test 4: /admin/feedback-stats
    print("\n[test 4] GET /admin/feedback-stats...")
    stats = await server.api_admin_feedback_stats(days=7, admin_token="test_admin_token_123")
    print(f"  totals: {stats['totals']}")
    print(f"  by_combination ({len(stats['by_combination'])} rows):")
    for row in stats["by_combination"][:5]:
        print(f"    tone={row['tone_family']:<10} intensity={row['intensity_band']:<7} "
              f"trigger={row['trigger_group']:<22} model={row['voice_model']:<20} "
              f"total={row['total_events']} fb={row['total_feedback']} "
              f"neg_rate={row['negative_feedback_rate']} confidence={row['confidence_flag']}")
    assert stats["totals"]["total_events"] == 5
    assert stats["totals"]["positive"] == 1
    assert stats["totals"]["negative"] == 2
    assert stats["totals"]["feedback_rate"] == 0.6

    # Test 5: purge event senza feedback (simulo age > 24h)
    print("\n[test 5] Purge unreviewed events (older_than_hours=0)...")
    # Modifico bucket a 2 giorni fa per far scattare il purge
    old_bucket = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d-%H")
    await db.koda_events.update_many(
        {"feedback_type": None},
        {"$set": {"created_at_bucket": old_bucket}},
    )
    r = await server.api_admin_feedback_purge(admin_token="test_admin_token_123", older_than_hours=24)
    print(f"  ✓ purge deleted={r['deleted']} (expected 2 unreviewed)")
    assert r["deleted"] == 2

    # I 3 event con feedback devono restare
    remaining = await db.koda_events.count_documents({})
    assert remaining == 3, f"expected 3 events with feedback, got {remaining}"
    print(f"  ✓ remaining events: {remaining} (tutti con feedback)")

    # Cleanup
    await db.koda_events.delete_many({})
    print("\n=== TUTTI I TEST PASSATI ===")


if __name__ == "__main__":
    asyncio.run(main())
