"""
Test integrazione webhook RC: sequenze realistiche + no-doppi-accrediti.

NOTA SICUREZZA DB:
  Non esegue delete_many/drop sul DB di produzione. Usa un app_user_id
  dedicato (`__rc_integ_test_uid__`) e si limita a inserire/aggiornare.
  I profili di test restano orfani — innocui, filtrabili via id prefix.

Scenari:
  1. Acquisto iniziale monthly → tier=monthly, ledger creato
  2. Renewal stesso piano → ledger NON resettato (no doppio accredito)
  3. Dedup su event.id duplicato
  4. PRODUCT_CHANGE → nuovo ledger
  5. Cancellation: tier preservato
  6. Expiration: tier=None, ledger clear
"""
import os
import sys
import json
import asyncio
import urllib.request
import urllib.error
import pathlib
import uuid

from dotenv import load_dotenv
load_dotenv(dotenv_path=pathlib.Path(__file__).resolve().parent.parent / ".env", override=True)

BASE = "http://127.0.0.1:8001/api/subscription/webhook"
AUTH = os.environ.get("REVENUECAT_WEBHOOK_AUTH", "")
assert AUTH, "REVENUECAT_WEBHOOK_AUTH mancante"

# uid univoco per run, prefisso riconoscibile
TEST_UID = f"__rc_integ_test_uid__{uuid.uuid4().hex[:8]}"


def post(body, hdr=AUTH):
    req = urllib.request.Request(
        BASE, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": hdr},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def ev(eid, t, ents=("ollenya_monthly",),
       product="ollenya_monthly", exp_ms=2**40):
    return {"event": {"id": f"{TEST_UID}_{eid}", "transaction_id": f"tx_{TEST_UID}_{eid}",
                      "type": t, "app_user_id": TEST_UID, "product_id": product,
                      "entitlements": {e: {"active": True} for e in ents},
                      "expiration_at_ms": exp_ms}}


async def read_profile():
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    from motor.motor_asyncio import AsyncIOMotorClient
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ.get("DB_NAME", "test_database")]
    doc = await db.taccuino_profile.find_one({"id": TEST_UID})
    cli.close()
    return doc or {}


async def ensure_profile_exists():
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    from motor.motor_asyncio import AsyncIOMotorClient
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ.get("DB_NAME", "test_database")]
    # Solo insert se non esiste (upsert=True con $setOnInsert)
    await db.taccuino_profile.update_one(
        {"id": TEST_UID},
        {"$setOnInsert": {"id": TEST_UID, "name": "RC_IntegTest"}},
        upsert=True,
    )
    cli.close()


async def set_consumed_minutes(minutes):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    from motor.motor_asyncio import AsyncIOMotorClient
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ.get("DB_NAME", "test_database")]
    await db.taccuino_profile.update_one(
        {"id": TEST_UID}, {"$set": {"ledger_state.base_minutes_used": minutes}}
    )
    cli.close()


async def main():
    print(f"[test] uid = {TEST_UID}")
    await ensure_profile_exists()
    ok_all = True

    # 1. INITIAL_PURCHASE monthly
    code, body = post(ev("1_init", "INITIAL_PURCHASE"))
    doc = await read_profile()
    c1 = (code == 200 and body.get("tier") == "monthly"
          and doc.get("subscription_active") is True
          and doc.get("subscription_tier") == "monthly"
          and isinstance(doc.get("ledger_state"), dict))
    ok_all &= c1
    print(f"  {'✓' if c1 else '✗'} INITIAL_PURCHASE monthly → ledger creato")

    # 2. Simula consumo 50 min
    await set_consumed_minutes(50.0)

    # 3. RENEWAL stesso piano → NON deve resettare base_minutes_used
    code, body = post(ev("2_renew", "RENEWAL"))
    doc = await read_profile()
    c2 = (code == 200
          and doc.get("ledger_state", {}).get("base_minutes_used") == 50.0
          and doc.get("subscription_expires_at") is not None)
    ok_all &= c2
    print(f"  {'✓' if c2 else '✗'} RENEWAL stesso piano: base_used preservato (50), expires aggiornato")

    # 4. Dedup su event.id ripetuto
    code, body = post(ev("1_init", "INITIAL_PURCHASE"))
    c3 = (code == 200 and body.get("deduped") is True)
    ok_all &= c3
    print(f"  {'✓' if c3 else '✗'} event.id ripetuto → deduped")
    # verifica ledger non toccato
    doc = await read_profile()
    c3b = (doc.get("ledger_state", {}).get("base_minutes_used") == 50.0)
    ok_all &= c3b
    print(f"  {'✓' if c3b else '✗'} dedup NON riscrive ledger")

    # 5. PRODUCT_CHANGE a annual → ledger fresh annual
    code, body = post(ev("3_chg", "PRODUCT_CHANGE", ents=("ollenya_annual",),
                          product="ollenya_annual"))
    doc = await read_profile()
    c4 = (code == 200 and doc.get("subscription_tier") == "annual"
          and doc.get("ledger_state", {}).get("plan") == "annual"
          and doc.get("ledger_state", {}).get("base_minutes_used") == 0.0)
    ok_all &= c4
    print(f"  {'✓' if c4 else '✗'} PRODUCT_CHANGE monthly→annual: nuovo ledger annual")

    # 6. CANCELLATION: resta attivo
    code, body = post(ev("4_cancel", "CANCELLATION", ents=("ollenya_annual",)))
    doc = await read_profile()
    c5 = (code == 200 and doc.get("subscription_active") is True
          and doc.get("subscription_tier") == "annual")
    ok_all &= c5
    print(f"  {'✓' if c5 else '✗'} CANCELLATION: active=True, tier preservato")

    # 7. EXPIRATION: revoca
    code, body = post(ev("5_expir", "EXPIRATION", ents=()))
    doc = await read_profile()
    c6 = (code == 200 and doc.get("subscription_active") is False
          and doc.get("subscription_tier") is None)
    ok_all &= c6
    print(f"  {'✓' if c6 else '✗'} EXPIRATION: active=False, tier=None")

    # 8. Ricreo stato: INITIAL monthly, poi BILLING_ISSUE → NON revoca
    post(ev("6_reinit", "INITIAL_PURCHASE"))
    code, body = post(ev("7_billing", "BILLING_ISSUE", ents=("ollenya_monthly",)))
    doc = await read_profile()
    c7 = (code == 200 and doc.get("subscription_active") is True
          and doc.get("subscription_tier") == "monthly")
    ok_all &= c7
    print(f"  {'✓' if c7 else '✗'} BILLING_ISSUE: NON revoca (grace period)")

    # 9. SUBSCRIPTION_PAUSED → NON revoca
    code, body = post(ev("8_paused", "SUBSCRIPTION_PAUSED", ents=("ollenya_monthly",)))
    doc = await read_profile()
    c8 = (code == 200 and doc.get("subscription_active") is True)
    ok_all &= c8
    print(f"  {'✓' if c8 else '✗'} SUBSCRIPTION_PAUSED: NON revoca")

    # 10. PRODUCT_CHANGE con effective_at_ms futuro → pending, no cambio immediato
    future_ms = 2**40  # molto futuro
    code, body = post({"event": {
        "id": f"{TEST_UID}_9_chg_future",
        "transaction_id": f"tx_{TEST_UID}_9",
        "type": "PRODUCT_CHANGE", "app_user_id": TEST_UID,
        "product_id": "ollenya_annual",
        "entitlements": {"ollenya_annual": {"active": True}},
        "expiration_at_ms": future_ms,
        "product_change_at_ms": future_ms,  # decorrenza futura
    }})
    doc = await read_profile()
    c9 = (code == 200 and doc.get("pending_tier") == "annual"
          and doc.get("subscription_tier") == "monthly")  # NON ancora cambiato
    ok_all &= c9
    print(f"  {'✓' if c9 else '✗'} PRODUCT_CHANGE downgrade/futuro: pending_tier salvato, tier corrente invariato")

    print("=" * 60)
    if ok_all:
        print("ALL OK")
        print(f"[note] profilo di test {TEST_UID} rimane nel DB come doc orfano "
              "(innocuo). Non usiamo delete_many sul DB.")
        sys.exit(0)
    else:
        print("FAILURES")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
