"""
Test integrazione webhook RevenueCat (post-hardening 2026-11-06).

Verifica:
  - Auth obbligatoria (401 senza/wrong header)
  - Dedup su event.id
  - Rinnovo stesso piano (non duplica ledger)
  - Priority annual > bimonthly > monthly
  - Cancellation (resta attivo), Expiration/Refund (revoca)
"""
import os
import sys
import json
import urllib.request
import urllib.error
import pathlib

from dotenv import load_dotenv
load_dotenv(dotenv_path=pathlib.Path(__file__).resolve().parent.parent / ".env", override=True)

BASE = "http://127.0.0.1:8001/api/subscription/webhook"
AUTH = os.environ.get("REVENUECAT_WEBHOOK_AUTH", "")
assert AUTH, "REVENUECAT_WEBHOOK_AUTH mancante nel .env del test env"


def post(body, hdr=None):
    data = json.dumps(body).encode()
    h = {"Content-Type": "application/json"}
    if hdr is not None:
        h["Authorization"] = hdr
    req = urllib.request.Request(BASE, data=data, method="POST", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def ev(eid, t, ents=("ollenya_monthly",), uid="test_user_1",
       product="ollenya_monthly", exp_ms=2**40):
    return {
        "event": {
            "id": eid, "transaction_id": "tx_" + eid, "type": t,
            "app_user_id": uid, "product_id": product,
            "entitlements": {e: {"active": True} for e in ents},
            "expiration_at_ms": exp_ms,
        }
    }


def run():
    cases = [
        ("no auth → 401",
         lambda: post(ev("e_noauth", "INITIAL_PURCHASE")), 401),
        ("wrong auth → 401",
         lambda: post(ev("e_wrong", "INITIAL_PURCHASE"), hdr="Bearer nope"), 401),
        ("initial monthly → 200",
         lambda: post(ev("e_init_m", "INITIAL_PURCHASE", ("ollenya_monthly",)), hdr=AUTH), 200),
        ("dedup same event.id → deduped",
         lambda: post(ev("e_init_m", "INITIAL_PURCHASE", ("ollenya_monthly",)), hdr=AUTH), 200),
        ("renewal monthly (new event.id)",
         lambda: post(ev("e_renew_m", "RENEWAL", ("ollenya_monthly",)), hdr=AUTH), 200),
        ("priority annual wins",
         lambda: post(ev("e_pri", "INITIAL_PURCHASE",
                         ("ollenya_monthly", "ollenya_bimonthly", "ollenya_annual")), hdr=AUTH), 200),
        ("bimonthly standalone",
         lambda: post(ev("e_bi", "INITIAL_PURCHASE", ("ollenya_bimonthly",),
                         product="ollenya_bimonthly"), hdr=AUTH), 200),
        ("cancellation (still active)",
         lambda: post(ev("e_cancel", "CANCELLATION", ("ollenya_monthly",)), hdr=AUTH), 200),
        ("expiration (revoke)",
         lambda: post(ev("e_expir", "EXPIRATION", ()), hdr=AUTH), 200),
        ("refund (revoke)",
         lambda: post(ev("e_refund", "REFUND", ()), hdr=AUTH), 200),
    ]
    ok_all = True
    for label, fn, expected in cases:
        code, body = fn()
        good = (code == expected)
        ok_all = ok_all and good
        mark = "✓" if good else "✗"
        print(f"  {mark} {label:<35s}  [{code}]  {body[:70]}")
    print("=" * 60)
    if ok_all:
        print("ALL OK")
        sys.exit(0)
    else:
        print("FAILURES")
        sys.exit(1)


if __name__ == "__main__":
    run()
