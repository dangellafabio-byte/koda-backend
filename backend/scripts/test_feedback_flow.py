"""
test_feedback_flow.py — Fabio 2026-09-11 (v2 semplificato)

Test integrazione feedback loop v2:
  - Solo NEGATIVE feedback (nessun positive)
  - 2 categorie: wrong_content, wrong_delivery
  - Denominatore: total_events (silenzio = positivo)
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


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    server.db = db

    await db.koda_events.delete_many({})
    print("[cleanup] koda_events cleared\n")

    # Insert 6 event di varia natura
    print("[test 1] Insert 6 event...")
    combos = [
        ("Non ce la faccio più, sto crollando", "concerned", 4, "eleven_v3"),
        ("Ciao come stai?", "warm", 1, "eleven_turbo_v2_5"),
        ("Il classifier è bugged", "warm", 2, "eleven_turbo_v2_5"),
        ("Sono felice, ce l'ho fatta!", "energetic", 2, "eleven_turbo_v2_5"),
        ("Mi manca troppo", "concerned", 3, "eleven_turbo_v2_5"),
        ("Boh, uhm", "neutral", 0, "eleven_turbo_v2_5"),
    ]
    event_ids = []
    for user_text, tone, intensity, model in combos:
        e = kfb.build_event(user_text, tone, intensity, model)
        await db.koda_events.insert_one(e)
        event_ids.append(e["event_id"])
        print(f"  ✓ {e['tone_family']:<10} {e['intensity_band']:<7} {e['trigger_group']:<22}")

    # 2 feedback negativi (uno per categoria)
    print("\n[test 2] POST 2 feedback (solo negativi ammessi)...")
    for ev_id, cat in [
        (event_ids[0], "wrong_content"),
        (event_ids[2], "wrong_delivery"),
    ]:
        req = server.FeedbackSubmitRequest(
            event_id=ev_id, feedback_type="negative", feedback_category=cat,
        )
        r = await server.api_feedback_submit(req)
        print(f"  ✓ {ev_id[:8]}... negative/{cat:<20} → {r}")

    # Try positive → 400 (Pydantic rifiuta prima o validator)
    print("\n[test 3] POST 'positive' (deve fallire)...")
    try:
        req = server.FeedbackSubmitRequest(
            event_id=event_ids[1], feedback_type="positive", feedback_category="wrong_content",
        )
        await server.api_feedback_submit(req)
        print("  ✗ MANCATO 400")
    except Exception as e:
        assert "400" in str(e) or "must be one of" in str(e).lower()
        print(f"  ✓ 400 as expected: {str(e)[:80]}")

    # Try negative senza categoria → 400
    print("\n[test 4] POST 'negative' senza categoria (deve fallire)...")
    try:
        req = server.FeedbackSubmitRequest(
            event_id=event_ids[1], feedback_type="negative", feedback_category="invalid_cat",
        )
        await server.api_feedback_submit(req)
        print("  ✗ MANCATO 400")
    except Exception as e:
        print(f"  ✓ 400 as expected: {str(e)[:80]}")

    # Stats
    print("\n[test 5] GET /admin/feedback-stats...")
    stats = await server.api_admin_feedback_stats(days=7, admin_token="test_admin_token_123")
    print(f"  totals: {stats['totals']}")
    for row in stats["by_combination"][:6]:
        print(f"    {row['tone_family']:<10} {row['intensity_band']:<7} "
              f"{row['trigger_group']:<22} {row['voice_model']:<20} "
              f"total={row['total_events']} neg={row['negative_count']} "
              f"neg_rate={row['negative_rate']} conf={row['confidence_flag']} "
              f"cats={row['categories']}")
    assert stats["totals"]["total_events"] == 6
    assert stats["totals"]["negative"] == 2
    assert stats["totals"]["negative_rate"] == round(2/6, 4)

    # Purge
    print("\n[test 6] Purge unreviewed events...")
    old_bucket = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d-%H")
    await db.koda_events.update_many(
        {"feedback_type": None}, {"$set": {"created_at_bucket": old_bucket}},
    )
    r = await server.api_admin_feedback_purge(admin_token="test_admin_token_123", older_than_hours=24)
    print(f"  ✓ purge deleted={r['deleted']} (expected 4 unreviewed)")
    assert r["deleted"] == 4
    remaining = await db.koda_events.count_documents({})
    assert remaining == 2
    print(f"  ✓ remaining events: {remaining}")

    # Confidence
    print("\n[test 7] Confidence flag...")
    assert kfb.confidence_flag(35, 600) == "solid"
    assert kfb.confidence_flag(15, 200) == "weak"
    assert kfb.confidence_flag(5, 50) == "insufficient"
    print("  ✓ solid(35, 600) / weak(15, 200) / insufficient(5, 50)")

    await db.koda_events.delete_many({})
    print("\n=== TUTTI I TEST PASSATI ===")


if __name__ == "__main__":
    asyncio.run(main())
