"""
test_paid_ledger_wiring.py — Fabio 2026-09-06

Test di integrazione del wiring `subscription_ledger` in server.py.
Verifica che i tier pagati vengano effettivamente addebitati (fix P0
minuti infiniti). Usa Motor async client contro il MongoDB locale.

Scenari testati:
  1. Fresh profile senza ledger → _ensure_ledger_dict crea ledger monthly.
  2. Consume 60 secondi → base_minutes_used = 1.0 min in DB.
  3. Consume abbastanza per esaurire → paid_state = "expired".
  4. Downgrade a None → ledger_state = None.
  5. Upgrade a bimonthly → nuovo ledger con plan="bimonthly".
"""
import asyncio
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

from motor.motor_asyncio import AsyncIOMotorClient
import subscription_ledger as _sub_ledger

# Importa gli helper wired
import server  # noqa

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


async def main():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    # sostituisci temporaneamente il db globale di server.py
    server.db = db

    test_id = f"test_ledger_{uuid.uuid4().hex[:8]}"
    print(f"\n=== TEST profile_id = {test_id} ===\n")

    # 1) Crea profilo di test con tier monthly (nessun ledger)
    await db.taccuino_profile.insert_one({
        "id": test_id,
        "subscription_tier": "monthly",
        "subscription_active": True,
        "minutes_used_this_month": 0.0,
    })
    print("[1] Fresh profile monthly inserito (senza ledger_state)")

    # 2) Fetch e verifica che _ensure_ledger_dict crei un ledger
    from server import Profile, _ensure_ledger_dict, _consume_paid_seconds, _compute_paid_state
    doc = await db.taccuino_profile.find_one({"id": test_id})
    p = Profile(**{k: v for k, v in doc.items() if k != "_id"})
    state = _ensure_ledger_dict(p)
    assert state is not None, "Ledger dovrebbe essere creato per monthly"
    assert state["plan"] == "monthly", f"plan errato: {state['plan']}"
    print(f"[2] _ensure_ledger_dict OK: plan={state['plan']} period_end={state['current_period_end_iso']}")

    # 3) Consume 60 secondi (1 min)
    result = await _consume_paid_seconds(p, 60.0)
    assert result is not None and result["total_consumed"] == 1.0, f"consume errato: {result}"
    doc2 = await db.taccuino_profile.find_one({"id": test_id})
    mirror = doc2.get("minutes_used_this_month", 0.0)
    ledger_used = doc2["ledger_state"]["base_minutes_used"]
    assert abs(mirror - 1.0) < 1e-6, f"mirror errato: {mirror}"
    assert abs(ledger_used - 1.0) < 1e-6, f"ledger_used errato: {ledger_used}"
    print(f"[3] Consume 60s: mirror={mirror}min ledger_used={ledger_used}min ✓")

    # 4) Consume massiccio per esaurire (200 min budget monthly)
    p2 = Profile(**{k: v for k, v in doc2.items() if k != "_id"})
    result2 = await _consume_paid_seconds(p2, 12000.0)  # 200 min
    doc3 = await db.taccuino_profile.find_one({"id": test_id})
    p3 = Profile(**{k: v for k, v in doc3.items() if k != "_id"})
    state3 = _compute_paid_state(p3)
    assert state3 == "expired", f"paid_state atteso 'expired', ricevuto '{state3}'. total_consumed={result2['total_consumed']} unfulfilled={result2['unfulfilled']}"
    print(f"[4] Dopo 201 min totali: paid_state='{state3}' unfulfilled={result2['unfulfilled']:.2f}min ✓")

    # 5) Idempotenza _ensure_ledger_dict: chiamata multiple volte non ricrea
    state_a = _ensure_ledger_dict(p3)
    state_b = _ensure_ledger_dict(p3)
    assert state_a["cycle_start_iso"] == state_b["cycle_start_iso"], "ensure_ledger non idempotente"
    print(f"[5] _ensure_ledger_dict idempotente ✓")

    # 6) Free tier → nessun ledger
    await db.taccuino_profile.update_one(
        {"id": test_id},
        {"$set": {"subscription_tier": None, "ledger_state": None}}
    )
    doc4 = await db.taccuino_profile.find_one({"id": test_id})
    p4 = Profile(**{k: v for k, v in doc4.items() if k != "_id"})
    result_free = await _consume_paid_seconds(p4, 60.0)
    assert result_free is None, f"consume_paid_seconds su free deve ritornare None, ricevuto: {result_free}"
    print("[6] Free tier: _consume_paid_seconds ritorna None ✓")

    # 7) Upgrade a bimonthly (attraverso re-init ledger)
    await db.taccuino_profile.update_one(
        {"id": test_id},
        {"$set": {"subscription_tier": "bimonthly"}}
    )
    doc5 = await db.taccuino_profile.find_one({"id": test_id})
    p5 = Profile(**{k: v for k, v in doc5.items() if k != "_id"})
    state5 = _ensure_ledger_dict(p5)
    assert state5["plan"] == "bimonthly", f"plan atteso bimonthly, got {state5['plan']}"
    print(f"[7] Upgrade a bimonthly: nuovo ledger con plan={state5['plan']} ✓")

    # Cleanup
    await db.taccuino_profile.delete_one({"id": test_id})
    print(f"\n=== TUTTI I TEST PASSATI. Profilo di test cancellato. ===\n")


if __name__ == "__main__":
    asyncio.run(main())
