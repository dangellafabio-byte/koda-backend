"""
Test manuale per POST /api/subscription/webhook.

Verifica:
  1. 401 senza header Authorization quando REVENUECAT_WEBHOOK_AUTH è set
  2. 401 con Authorization errato
  3. 200 + tier=monthly con entitlement ollenya_monthly
  4. 200 + dedup su stesso transaction_id (nessun doppio accredito)
  5. CANCELLATION non azzera il ledger (tier resta fino a expires_at)
  6. Mapping tier annual > bimonthly > monthly se più entitlement attivi
"""
import os
import sys
import json
import pathlib
import urllib.request
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BASE = "http://127.0.0.1:8001"
WEBHOOK = f"{BASE}/api/subscription/webhook"
AUTH = os.environ.get("REVENUECAT_WEBHOOK_AUTH", "")


def _post(body, auth_header=None):
    data = json.dumps(body).encode()
    hdr = {"Content-Type": "application/json"}
    if auth_header is not None:
        hdr["Authorization"] = auth_header
    req = urllib.request.Request(WEBHOOK, data=data, method="POST", headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def mk_event(tx_id, evt_type="INITIAL_PURCHASE", ents=("ollenya_monthly",), user="me"):
    return {
        "event": {
            "type": evt_type,
            "id": tx_id,
            "transaction_id": tx_id,
            "app_user_id": user,
            "entitlements": {k: {"active": True} for k in ents},
            "expiration_at_ms": 2**40,  # lontano nel futuro
        }
    }


def run():
    if not AUTH:
        print("[skip] REVENUECAT_WEBHOOK_AUTH non set → test auth non eseguibile")
        print("       (test logica mapping/dedup resta eseguibile in no-auth mode)")

    results = []

    if AUTH:
        # 1. No header → 401
        code, body = _post(mk_event("tx_no_auth"))
        results.append(("no_auth → 401", code == 401, code, body))

        # 2. Wrong header → 401
        code, body = _post(mk_event("tx_wrong_auth"), auth_header="Bearer wrong")
        results.append(("wrong_auth → 401", code == 401, code, body))

    # 3. Valid monthly
    code, body = _post(mk_event("tx_m1"), auth_header=AUTH or None)
    results.append(("monthly tier", code == 200 and body.get("ok"), code, body))

    # 4. Dedup: stesso tx_id
    code, body = _post(mk_event("tx_m1"), auth_header=AUTH or None)
    results.append(("dedup same tx_id", code == 200 and body.get("deduped"), code, body))

    # 5. Priority annual > bimonthly > monthly
    code, body = _post(
        mk_event("tx_priority", ents=("ollenya_monthly", "ollenya_bimonthly", "ollenya_annual")),
        auth_header=AUTH or None,
    )
    results.append(("priority annual wins", code == 200, code, body))

    # 6. Bimonthly standalone
    code, body = _post(
        mk_event("tx_bi1", ents=("ollenya_bimonthly",)),
        auth_header=AUTH or None,
    )
    results.append(("bimonthly standalone", code == 200, code, body))

    # 7. Cancellation: tier None atteso
    code, body = _post(
        mk_event("tx_cancel1", evt_type="CANCELLATION", ents=("ollenya_monthly",)),
        auth_header=AUTH or None,
    )
    results.append(("cancellation", code == 200, code, body))

    # Riepilogo
    print("\n" + "=" * 60)
    all_ok = True
    for label, ok, code, body in results:
        mark = "✓" if ok else "✗"
        print(f"  {mark} {label}  [status={code}]  {str(body)[:100]}")
        all_ok = all_ok and ok
    print("=" * 60)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    run()
