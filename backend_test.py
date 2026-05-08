"""
Taccuino Vivo backend test suite.

Tests after the legacy "App Compass" cleanup that removed ~310 lines from
backend/server.py. Verifies:
1. All Taccuino endpoints still respond (200)
2. Removed legacy endpoints return 404 / 410 (NOT 500)
3. /api/transcribe rejects empty audio (400)
4. /api/tts/prepare + /api/tts/audio/{token}.mp3 (with Range)
5. Watch for unexpected 500 errors
"""

import io
import os
import sys
import json
import time

import requests

# Resolve backend URL from frontend/.env (EXPO_PUBLIC_BACKEND_URL)
FRONTEND_ENV = "/app/frontend/.env"
BASE_URL = None
with open(FRONTEND_ENV, "r") as f:
    for line in f:
        line = line.strip()
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = line.split("=", 1)[1].strip().strip('"').strip("'")
            break

if not BASE_URL:
    print("FATAL: cannot resolve EXPO_PUBLIC_BACKEND_URL from frontend/.env")
    sys.exit(1)

API = BASE_URL.rstrip("/") + "/api"
print(f"Testing against: {API}")
print("=" * 80)


results = []  # (name, status, http, message)


def record(name, ok, http, msg=""):
    status = "PASS" if ok else "FAIL"
    results.append((name, status, http, msg))
    print(f"[{status}] {name} — HTTP {http}{(' — ' + msg) if msg else ''}")


def safe_req(method, path, **kwargs):
    url = API + path
    try:
        r = requests.request(method, url, timeout=60, **kwargs)
        return r, None
    except Exception as e:
        return None, str(e)


# ---------------------------------------------------------------
# 1. Working Taccuino endpoints
# ---------------------------------------------------------------

# 1a. GET /api/
r, err = safe_req("GET", "/")
if err:
    record("GET /api/", False, "-", f"network error: {err}")
else:
    ok = r.status_code == 200
    try:
        body = r.json()
    except Exception:
        body = {}
    msg_ok = isinstance(body, dict) and body.get("message") == "Taccuino Vivo API" and body.get("status") == "ok"
    record("GET /api/", ok and msg_ok, r.status_code,
           "" if ok and msg_ok else f"unexpected body: {r.text[:200]}")


# 1b. GET /api/profile
r, err = safe_req("GET", "/profile")
if err:
    record("GET /api/profile", False, "-", err)
else:
    ok = r.status_code == 200
    try:
        body = r.json()
    except Exception:
        body = {}
    has_id = isinstance(body, dict) and body.get("id") == "me"
    record("GET /api/profile", ok and has_id, r.status_code,
           "" if ok and has_id else f"body: {r.text[:200]}")


# 1c. PUT /api/profile {name: "Marco"}
test_name = "Marco"
r, err = safe_req("PUT", "/profile", json={"name": test_name})
if err:
    record("PUT /api/profile", False, "-", err)
else:
    ok = r.status_code == 200
    try:
        body = r.json()
    except Exception:
        body = {}
    name_ok = body.get("name") == test_name
    record("PUT /api/profile (set name)", ok and name_ok, r.status_code,
           "" if ok and name_ok else f"body: {r.text[:200]}")


# 1d. GET /api/timeline?limit=5
r, err = safe_req("GET", "/timeline", params={"limit": 5})
if err:
    record("GET /api/timeline", False, "-", err)
else:
    ok = r.status_code == 200
    try:
        body = r.json()
    except Exception:
        body = None
    is_list = isinstance(body, list)
    record("GET /api/timeline?limit=5", ok and is_list, r.status_code,
           "" if ok and is_list else f"body: {r.text[:200]}")


# 1e. POST /api/converse
r, err = safe_req("POST", "/converse", json={"text": "ciao, come stai?"})
ai_tone = None
if err:
    record("POST /api/converse", False, "-", err)
else:
    ok = r.status_code == 200
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    user_e = body.get("user_entry") if isinstance(body, dict) else None
    ai_e = body.get("ai_entry") if isinstance(body, dict) else None
    prof = body.get("profile") if isinstance(body, dict) else None
    has_all = bool(user_e and ai_e and prof)
    ai_text_ok = bool(ai_e and (ai_e.get("text") or "").strip())
    ai_tone_ok = bool(ai_e and ai_e.get("tone"))
    if ai_e:
        ai_tone = ai_e.get("tone")
    full_ok = ok and has_all and ai_text_ok and ai_tone_ok
    record(
        "POST /api/converse {text:'ciao, come stai?'}",
        full_ok,
        r.status_code,
        "" if full_ok else f"missing fields. body keys: {list(body.keys()) if isinstance(body, dict) else 'n/a'}; status={r.status_code}; raw[:200]={r.text[:200]}",
    )


# 1f. GET /api/recap?period=today
r, err = safe_req("GET", "/recap", params={"period": "today"})
if err:
    record("GET /api/recap?period=today", False, "-", err)
else:
    ok = r.status_code == 200
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    has_recap = isinstance(body, dict) and "recap" in body
    record("GET /api/recap?period=today", ok and has_recap, r.status_code,
           "" if ok and has_recap else f"body: {r.text[:200]}")


# 1g. GET /api/voices
r, err = safe_req("GET", "/voices")
if err:
    record("GET /api/voices", False, "-", err)
else:
    ok = r.status_code == 200
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    voices = body.get("voices", []) if isinstance(body, dict) else []
    enabled = body.get("enabled") if isinstance(body, dict) else None
    expected = {"Matilda", "Sarah", "Charlotte", "Jessica", "Liam", "Charlie", "Callum", "Daniel"}
    names = {v.get("name") for v in voices if isinstance(v, dict)}
    has_curated = expected.issubset(names)
    full_ok = ok and has_curated and isinstance(enabled, bool)
    record("GET /api/voices", full_ok, r.status_code,
           "" if full_ok else f"missing curated voices. found: {sorted(names)}; enabled={enabled}")


# 1h. POST /api/tts/prepare
voice_id_matilda = "XrExE9yKIg1WjnnlVkGX"
r, err = safe_req("POST", "/tts/prepare", json={"text": "ciao", "voice_id": voice_id_matilda})
tts_token = None
tts_size = None
if err:
    record("POST /api/tts/prepare", False, "-", err)
else:
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    if r.status_code == 200:
        tts_token = body.get("token")
        tts_size = body.get("size")
        ok = bool(tts_token) and isinstance(tts_size, int) and tts_size > 0
        record("POST /api/tts/prepare {text:'ciao'}", ok, r.status_code,
               "" if ok else f"unexpected body: {r.text[:200]}")
    elif r.status_code == 503:
        # Config issue, NOT regression
        record("POST /api/tts/prepare {text:'ciao'}", True, r.status_code,
               "Minor: ElevenLabs not configured (503) — config issue, NOT regression from cleanup")
    else:
        record("POST /api/tts/prepare {text:'ciao'}", False, r.status_code,
               f"unexpected: {r.text[:200]}")


# 1i. GET /api/tts/audio/{token}.mp3 (with and without Range)
if tts_token:
    # Full GET
    r, err = safe_req("GET", f"/tts/audio/{tts_token}.mp3")
    if err:
        record("GET /api/tts/audio/{token}.mp3", False, "-", err)
    else:
        ct = r.headers.get("content-type", "").lower()
        accept_ranges = r.headers.get("accept-ranges", "").lower()
        ok = r.status_code == 200 and "audio/mpeg" in ct and len(r.content) > 0
        record("GET /api/tts/audio/{token}.mp3 (full)", ok, r.status_code,
               "" if ok else f"ct={ct}, len={len(r.content)}, accept_ranges={accept_ranges}")

    # Range request 0-100
    r, err = safe_req("GET", f"/tts/audio/{tts_token}.mp3", headers={"Range": "bytes=0-100"})
    if err:
        record("GET /api/tts/audio/{token}.mp3 (Range)", False, "-", err)
    else:
        cr = r.headers.get("content-range", "")
        ct = r.headers.get("content-type", "").lower()
        ok = r.status_code == 206 and "audio/mpeg" in ct and len(r.content) == 101 and cr.startswith("bytes 0-100/")
        record("GET /api/tts/audio/{token}.mp3 (Range bytes=0-100)", ok, r.status_code,
               "" if ok else f"content-range={cr}, ct={ct}, len={len(r.content)}")
else:
    record("GET /api/tts/audio/{token}.mp3", True, "skip",
           "Skipped: no token from /tts/prepare")


# ---------------------------------------------------------------
# 2. Removed legacy endpoints (must NOT be 500)
# ---------------------------------------------------------------

legacy_cases = [
    ("GET",  "/categories",   404),
    ("GET",  "/featured-app", 404),
    ("POST", "/recommend",    410),
    ("GET",  "/favorites",    404),
    ("GET",  "/history",      404),
    ("GET",  "/demo/mp4",     404),
]

for method, path, expected_code in legacy_cases:
    kwargs = {}
    if method == "POST" and path == "/recommend":
        kwargs["json"] = {"query": "x"}
    r, err = safe_req(method, path, **kwargs)
    if err:
        record(f"{method} /api{path}", False, "-", err)
        continue
    ok = r.status_code == expected_code
    is_500 = r.status_code >= 500
    note = ""
    if is_500:
        note = f"CRITICAL: 500-class error indicates dangling code references! body: {r.text[:200]}"
    elif not ok:
        note = f"expected {expected_code}, got {r.status_code}"
    record(f"{method} /api{path} (expect {expected_code})", ok, r.status_code, note)


# ---------------------------------------------------------------
# 3. /api/transcribe rejects empty audio with 400
# ---------------------------------------------------------------

# Send an empty file under field "audio"
files = {"audio": ("empty.webm", b"", "audio/webm")}
data = {"language": "it"}
r, err = safe_req("POST", "/transcribe", files=files, data=data)
if err:
    record("POST /api/transcribe (empty audio)", False, "-", err)
else:
    ok = r.status_code == 400
    record("POST /api/transcribe (empty audio → expect 400)", ok, r.status_code,
           "" if ok else f"body: {r.text[:200]}")


# ---------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------
print("=" * 80)
print("SUMMARY")
print("=" * 80)
fails = [r for r in results if r[1] == "FAIL"]
for name, status, http, msg in results:
    print(f"  [{status}] HTTP={http} {name} {('— ' + msg) if msg and status == 'FAIL' else ''}")
print(f"\nTotal: {len(results)} | Pass: {len(results) - len(fails)} | Fail: {len(fails)}")
sys.exit(1 if fails else 0)
