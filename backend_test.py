#!/usr/bin/env python3
"""
Backend test — Tavily Web Search integration via /api/converse-fast/start.

Tests:
1) Explicit "cerca" trigger → web-search triggered, reply uses web facts
2) Factual keyword "meteo" → web-search triggered, reply has weather info
3) Normal conversation → NO web-search trigger, normal empathic reply
"""
import os
import sys
import time
import json
import requests
from typing import Optional, Tuple, List, Dict, Any


def _load_backend_url() -> str:
    env_path = "/app/frontend/.env"
    url = None
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("EXPO_PUBLIC_BACKEND_URL=") or line.startswith("REACT_APP_BACKEND_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'")
                if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                    break
    if not url:
        print("FATAL: cannot find backend URL in /app/frontend/.env")
        sys.exit(2)
    return url.rstrip("/")


BACKEND = _load_backend_url()
API = f"{BACKEND}/api"
BACKEND_LOG = "/var/log/supervisor/backend.err.log"


def _log_position() -> int:
    try:
        return os.path.getsize(BACKEND_LOG)
    except Exception:
        return 0


def _log_slice_since(pos: int) -> str:
    try:
        with open(BACKEND_LOG, "rb") as f:
            f.seek(pos)
            return f.read().decode("utf-8", errors="replace")
    except Exception as e:
        return f"<log slice error: {e}>"


def run_fast_convo(text: str, ephemeral: bool = False, max_wall_s: float = 60.0):
    log_pos_before = _log_position()
    t0 = time.time()
    r = requests.post(f"{API}/converse-fast/start",
                      json={"text": text, "ephemeral": ephemeral},
                      timeout=20)
    print(f"  POST /converse-fast/start → HTTP {r.status_code}  ({int((time.time()-t0)*1000)}ms)")
    if r.status_code != 200:
        print(f"    body: {r.text[:400]}")
        return r.status_code, "", None, [], _log_slice_since(log_pos_before)
    sid = r.json().get("session_id", "")
    print(f"  session_id: {sid}")
    if not sid:
        return r.status_code, "", None, [], _log_slice_since(log_pos_before)

    since = 0
    all_events: List[dict] = []
    meta_event: Optional[dict] = None
    deadline = time.time() + max_wall_s
    done = False
    poll_count = 0
    while time.time() < deadline:
        poll_count += 1
        try:
            pr = requests.get(f"{API}/converse-fast/poll/{sid}",
                              params={"since": since, "timeout": 8},
                              timeout=12)
        except requests.RequestException as e:
            print(f"    poll error: {e}")
            time.sleep(0.5)
            continue
        if pr.status_code != 200:
            print(f"  POLL → HTTP {pr.status_code}: {pr.text[:200]}")
            return pr.status_code, sid, None, all_events, _log_slice_since(log_pos_before)
        body = pr.json()
        events = body.get("events", []) or []
        for ev in events:
            all_events.append(ev)
            etype = ev.get("type")
            if etype == "sentence":
                print(f"    ← sentence i={ev.get('i')} text={(ev.get('text') or '')[:80]!r}")
            elif etype == "meta":
                meta_event = ev
                print(f"    ← meta reply={(ev.get('reply') or '')[:120]!r} tone={ev.get('tone')}")
            elif etype == "error":
                print(f"    ← ERROR: {ev.get('message')}")
            else:
                print(f"    ← {etype}: {json.dumps(ev)[:120]}")
        since = body.get("next", since)
        done = bool(body.get("done"))
        if done:
            break
    total_ms = int((time.time() - t0) * 1000)
    print(f"  total wallclock: {total_ms}ms, polls={poll_count}, done={done}")
    return r.status_code, sid, meta_event, all_events, _log_slice_since(log_pos_before)


def _grep_fast_lines(log: str, sid8: str) -> List[str]:
    out = []
    for line in log.splitlines():
        if f"[fast {sid8}]" in line or "[fast]" in line:
            out.append(line.strip())
    return out


def assert_true(name: str, cond: bool, detail: str = "") -> bool:
    if cond:
        print(f"    ✅ {name}")
    else:
        print(f"    ❌ {name}  {detail}")
    return cond


def test_case(label: str, text: str, expect_web_search: bool,
              expect_reply_keywords: Optional[List[str]] = None) -> Dict[str, Any]:
    print(f"\n{'='*70}\n{label}\n{'='*70}")
    print(f"  text: {text!r}")
    status, sid, meta, events, log = run_fast_convo(text, ephemeral=False)
    sid8 = sid[:8]
    fast_lines = _grep_fast_lines(log, sid8)
    web_trigger_lines = [l for l in fast_lines if "web-search triggered" in l]
    web_done_lines = [l for l in fast_lines if "web-search done in" in l]
    print(f"  -- [fast {sid8}] log lines: {len(fast_lines)} matching")
    for ln in fast_lines[-14:]:
        # show only the suffix to keep noise low
        print(f"    | {ln[-220:]}")

    results: Dict[str, Any] = {
        "label": label, "text": text, "start_status": status, "session_id": sid,
        "meta": meta, "events_count": len(events),
        "expect_web_search": expect_web_search,
        "web_trigger_lines": web_trigger_lines, "web_done_lines": web_done_lines,
        "pass": True, "reasons": [],
    }

    if not assert_true("start returned 200", status == 200):
        results["pass"] = False; results["reasons"].append("start != 200")
    if not assert_true("session_id present", bool(sid)):
        results["pass"] = False; results["reasons"].append("no session_id")
    if not assert_true("polling reached done=true (meta event received)", meta is not None):
        results["pass"] = False; results["reasons"].append("no meta event / not done")
    reply_text = (meta or {}).get("reply", "") or ""
    print(f"    reply: {reply_text!r}")

    if expect_web_search:
        ok_trig = len(web_trigger_lines) > 0
        if not assert_true("web-search triggered logged", ok_trig):
            results["pass"] = False; results["reasons"].append("no web-search trigger log")
        ok_brief = any("brief=yes" in l for l in web_done_lines)
        if not assert_true("Tavily returned brief=yes", ok_brief,
                           detail=f"web_done_lines={web_done_lines}"):
            results["pass"] = False; results["reasons"].append("brief != yes")
    else:
        ok_no_trig = len(web_trigger_lines) == 0
        if not assert_true("NO web-search triggered", ok_no_trig,
                           detail=f"unexpected: {web_trigger_lines}"):
            results["pass"] = False; results["reasons"].append("unexpected web-search trigger")

    if reply_text:
        if expect_web_search:
            forbidden = ("non ho accesso a internet", "non posso cercare",
                         "non posso accedere a internet", "non ho accesso al web")
            lowered = reply_text.lower()
            ok_not_refusal = not any(f in lowered for f in forbidden)
            assert_true("reply does NOT refuse web access", ok_not_refusal,
                        detail=f"reply: {reply_text[:200]}")
            if not ok_not_refusal:
                results["pass"] = False; results["reasons"].append("reply refuses web")
        if expect_reply_keywords:
            lowered = reply_text.lower()
            found = [k for k in expect_reply_keywords if k.lower() in lowered]
            print(f"    reply keyword hits: {found}")
            results["keyword_hits"] = found

    return results


def main() -> int:
    print(f"Backend: {API}")
    print(f"Log: {BACKEND_LOG}\n")
    try:
        r = requests.get(f"{API}/", timeout=10)
        print(f"GET /api/ → {r.status_code}: {r.text[:80]}")
    except Exception as e:
        print(f"GET /api/ failed: {e}")
        return 2

    results = []
    results.append(test_case(
        "TEST 1 — Trigger esplicito 'Cerca le ultime notizie dall'Italia'",
        "Cerca le ultime notizie dall'Italia",
        expect_web_search=True,
    ))
    results.append(test_case(
        "TEST 2 — Keyword fattuale 'Che tempo fa oggi a Roma?'",
        "Che tempo fa oggi a Roma?",
        expect_web_search=True,
        expect_reply_keywords=["roma", "grad", "sole", "piogg", "nuvol", "ventos", "ciel", "°"],
    ))
    results.append(test_case(
        "TEST 3 — Conversazione normale (no trigger)",
        "Ciao, come va? Oggi mi sento un po' stanco.",
        expect_web_search=False,
    ))

    print(f"\n{'#'*70}\nFINAL SUMMARY\n{'#'*70}")
    all_pass = True
    for r in results:
        mark = "✅" if r["pass"] else "❌"
        print(f"{mark} {r['label']}")
        print(f"     reply: {((r.get('meta') or {}).get('reply') or '')[:200]!r}")
        if r["web_trigger_lines"]:
            print(f"     trigger log: {r['web_trigger_lines'][-1][-220:]}")
        if r["web_done_lines"]:
            print(f"     done log:    {r['web_done_lines'][-1][-220:]}")
        if r["reasons"]:
            print(f"     reasons: {r['reasons']}")
        if not r["pass"]:
            all_pass = False
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
