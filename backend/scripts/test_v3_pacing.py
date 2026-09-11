"""
test_v3_pacing.py — Fabio 2026-09-11

Test integrazione pacing V3 giornaliero:
  - Reset automatico su cambio data
  - Downgrade silente quando budget esaurito
  - Telemetria intensity_hist coerente
  - Idempotenza persistenza DB
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

os.environ["KODA_TTS_V3_DAILY_BUDGET"] = "3"  # budget piccolo per test

import server
from tts_intensity_classifier import classify

from motor.motor_asyncio import AsyncIOMotorClient


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    server.db = db

    test_id = f"test_pacing_{uuid.uuid4().hex[:8]}"
    print(f"\n=== TEST profile_id = {test_id} (budget=3) ===\n")

    await db.taccuino_profile.insert_one({
        "id": test_id,
        "subscription_tier": "monthly",
    })

    # Frase crisi acuta → V3
    crisis_text = "Fabio, aspetta. Sei ancora lì? Mi dici cosa stai provando?"
    dec_v3 = classify(crisis_text, "concerned")
    assert dec_v3.use_v3, f"Expected V3 for crisis, got {dec_v3.model_id}"
    print(f"[classifier] crisis text → V3 intensity={dec_v3.intensity} reason={dec_v3.reason}")

    # Frase normale → Turbo
    normal_text = "Ciao Fabio, sto bene, e tu?"
    dec_turbo = classify(normal_text, "warm")
    assert not dec_turbo.use_v3, f"Expected Turbo for normal, got {dec_turbo.model_id}"
    print(f"[classifier] normal text → Turbo intensity={dec_turbo.intensity}")

    # Simulate 5 crisis turns → dovremmo vedere 3 V3 + 2 downgrade paced
    print("\n[test] simulo 5 crisis turns con budget=3...")
    for i in range(5):
        doc = await db.taccuino_profile.find_one({"id": test_id})
        p = server.Profile(**{k: v for k, v in doc.items() if k != "_id"})
        final_model, final_reason, tele = await server._gate_v3_daily_budget(p, dec_v3)
        exp_v3 = i < 3
        marker = "V3" if final_model == "eleven_v3" else "Turbo"
        print(f"  turn {i+1}: model={marker:<5} reason={final_reason:<30} "
              f"v3={tele['v3_used']}/{tele['v3_budget']} downgrades={tele['downgrades_paced']}")
        if exp_v3:
            assert final_model == "eleven_v3", f"turn {i+1}: expected V3, got {final_model}"
        else:
            assert final_model == "eleven_turbo_v2_5", f"turn {i+1}: expected Turbo downgrade"
            assert "paced_downgrade" in final_reason

    doc = await db.taccuino_profile.find_one({"id": test_id})
    state = doc["daily_v3_state"]
    assert state["v3_turns_used"] == 3
    assert state["downgrades_paced"] == 2
    assert state["turbo_turns"] == 2, f"turbo_turns should be 2 (from downgrades), got {state['turbo_turns']}"
    assert state["intensity_hist"][4] == 5  # tutte 5 crisi = intensity 4
    print(f"\n[state after 5 crisis] {state}")

    # Simulo 3 normal turns → tutti Turbo, aumenta turbo_turns, intensity_hist[1]+3
    print("\n[test] simulo 3 normal turns (tone=warm)...")
    for i in range(3):
        doc = await db.taccuino_profile.find_one({"id": test_id})
        p = server.Profile(**{k: v for k, v in doc.items() if k != "_id"})
        final_model, final_reason, tele = await server._gate_v3_daily_budget(p, dec_turbo)
        assert final_model == "eleven_turbo_v2_5"
        assert "paced_downgrade" not in final_reason
    doc = await db.taccuino_profile.find_one({"id": test_id})
    state = doc["daily_v3_state"]
    assert state["turbo_turns"] == 5, f"expected 2+3=5, got {state['turbo_turns']}"
    assert state["intensity_hist"][1] == 3
    print(f"[state after 3 normal] turbo_turns={state['turbo_turns']} hist={state['intensity_hist']}")

    # Test reset su cambio data (simulato: modifico date_iso in DB a ieri)
    print("\n[test] simulo cambio data (ieri → oggi)...")
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    state["date_iso"] = yesterday
    await db.taccuino_profile.update_one(
        {"id": test_id}, {"$set": {"daily_v3_state": state}}
    )
    doc = await db.taccuino_profile.find_one({"id": test_id})
    p = server.Profile(**{k: v for k, v in doc.items() if k != "_id"})
    final_model, final_reason, tele = await server._gate_v3_daily_budget(p, dec_v3)
    # Il nuovo giorno resetta → budget pieno, V3 disponibile
    assert final_model == "eleven_v3", "dopo reset dovrebbe essere V3"
    assert tele["v3_used"] == 1, f"expected 1 dopo reset, got {tele['v3_used']}"
    print(f"[state after reset] v3_used={tele['v3_used']}/{tele['v3_budget']} (reset da ieri)")

    # Cleanup
    await db.taccuino_profile.delete_one({"id": test_id})
    print(f"\n=== TUTTI I TEST PASSATI. Cleanup ok. ===\n")


if __name__ == "__main__":
    asyncio.run(main())
