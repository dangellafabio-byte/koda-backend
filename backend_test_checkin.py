"""Backend tests for Taccuino Vivo PROACTIVE CHECK-IN feature
+ profile schema extension + regression on legacy/Taccuino endpoints.

Reads EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env and appends /api.
"""
import os
import re
import json
import sys
from pathlib import Path
import requests

# --- Resolve base URL from /app/frontend/.env ---
ENV_PATH = Path("/app/frontend/.env")
BASE_URL = None
for line in ENV_PATH.read_text().splitlines():
    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
        BASE_URL = line.split("=", 1)[1].strip().strip('"')
        break
if not BASE_URL:
    print("ERROR: EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")
    sys.exit(1)

API = BASE_URL.rstrip("/") + "/api"
print(f"=== Testing against: {API} ===\n")

results = []  # list of (name, passed, http_code, snippet)


def record(name, ok, code, snippet=""):
    results.append((name, ok, code, snippet))
    status = "✅ PASS" if ok else "❌ FAIL"
    print(f"{status} [{code}] {name}")
    if snippet:
        # keep snippets short in console
        s = snippet if len(snippet) < 600 else snippet[:600] + "..."
        print(f"    → {s}")
    print()


def short(o):
    try:
        return json.dumps(o, ensure_ascii=False)[:400]
    except Exception:
        return str(o)[:400]


# ==========================================================
# 1) POST /api/checkin/generate — happy paths
# ==========================================================
print("─── 1) POST /api/checkin/generate (happy paths) ───\n")

VALID_TONES = {"warm", "calm", "concerned", "energetic", "neutral", "urgent"}

# 1a) morning, hour 9
try:
    r = requests.post(f"{API}/checkin/generate",
                      json={"slot": "morning", "local_hour": 9}, timeout=60)
    code = r.status_code
    j = r.json() if "application/json" in r.headers.get("content-type", "") else {}
    ok = (
        code == 200
        and isinstance(j.get("title"), str) and j["title"]
        and isinstance(j.get("body"), str) and j["body"]
        and isinstance(j.get("voice_text"), str) and j["voice_text"]
        and j.get("tone") in VALID_TONES
        and j.get("slot") == "morning"
    )
    morning_payload = j
    record("checkin morning local_hour=9 (title/body/voice_text/tone/slot ok)",
           ok, code, short(j))
except Exception as e:
    record("checkin morning local_hour=9", False, "EXC", str(e))
    morning_payload = {}

# 1b) evening, hour 21
try:
    r = requests.post(f"{API}/checkin/generate",
                      json={"slot": "evening", "local_hour": 21}, timeout=60)
    code = r.status_code
    j = r.json() if "application/json" in r.headers.get("content-type", "") else {}
    ok = (
        code == 200
        and j.get("slot") == "evening"
        and isinstance(j.get("body"), str) and j["body"]
        and isinstance(j.get("voice_text"), str) and j["voice_text"]
        and j.get("tone") in VALID_TONES
    )
    record("checkin evening local_hour=21 (slot=evening, content present)",
           ok, code, short(j))
    evening_payload = j
except Exception as e:
    record("checkin evening local_hour=21", False, "EXC", str(e))
    evening_payload = {}

# 1c) morning, language=en
try:
    r = requests.post(f"{API}/checkin/generate",
                      json={"slot": "morning", "local_hour": 9, "language": "en"},
                      timeout=60)
    code = r.status_code
    j = r.json() if "application/json" in r.headers.get("content-type", "") else {}
    body = (j.get("body") or "") + " " + (j.get("voice_text") or "")
    # Heuristic: English text should *not* contain frequent Italian markers
    italian_markers = [" sono ", " come ", " stai ", " buon", " amico", " ciao",
                       " fammi ", " va bene", " allora", " stasera", "piacere"]
    italian_hits = sum(1 for m in italian_markers if m.lower() in body.lower())
    english_markers = ["the ", " you", " how ", " good", " your", " hi", " hello",
                       " let", " evening", " morning", "today", " feel"]
    english_hits = sum(1 for m in english_markers if m.lower() in body.lower())
    looks_english = english_hits >= italian_hits  # at least as many EN hints as IT
    ok = (
        code == 200
        and j.get("slot") == "morning"
        and bool(j.get("body"))
        and looks_english
    )
    record(f"checkin language=en (heuristic en≥it markers: en={english_hits}, it={italian_hits})",
           ok, code, short(j))
except Exception as e:
    record("checkin language=en", False, "EXC", str(e))

# Audio-tag detection on morning_payload.voice_text (informational)
if morning_payload:
    vt = morning_payload.get("voice_text", "")
    has_tags = bool(re.search(r"\[[a-zA-Z][a-zA-Z _',\-]{1,30}\]", vt))
    print(f"    [info] morning voice_text contains audio tags? {has_tags}")
    print(f"    [info] morning voice_text sample: {vt[:300]}\n")

# Stylistic difference between morning vs evening (informational, soft check)
if morning_payload and evening_payload:
    m_body = (morning_payload.get("body") or "").lower()
    e_body = (evening_payload.get("body") or "").lower()
    different = m_body != e_body
    print(f"    [info] morning vs evening bodies differ? {different}")
    print(f"    [info] evening voice_text sample: {evening_payload.get('voice_text','')[:300]}\n")


# ==========================================================
# 2) POST /api/checkin/generate — robustness
# ==========================================================
print("─── 2) POST /api/checkin/generate (robustness) ───\n")

# 2a) invalid slot "noon"
try:
    r = requests.post(f"{API}/checkin/generate",
                      json={"slot": "noon", "local_hour": 12}, timeout=60)
    code = r.status_code
    j = r.json() if "application/json" in r.headers.get("content-type", "") else {}
    ok = code == 200 and bool(j.get("body")) and bool(j.get("voice_text"))
    record("checkin invalid slot=noon → 200 with sensible content",
           ok, code, short(j))
except Exception as e:
    record("checkin invalid slot=noon", False, "EXC", str(e))

# 2b) empty body {}
try:
    r = requests.post(f"{API}/checkin/generate", json={}, timeout=60)
    code = r.status_code
    j = r.json() if "application/json" in r.headers.get("content-type", "") else {}
    ok = (
        code == 200
        and j.get("slot") == "morning"  # default
        and bool(j.get("body"))
    )
    record("checkin empty body {} → 200, defaults applied (slot=morning)",
           ok, code, short(j))
except Exception as e:
    record("checkin empty body", False, "EXC", str(e))

# 2c) out-of-range hour
try:
    r = requests.post(f"{API}/checkin/generate",
                      json={"slot": "morning", "local_hour": 99}, timeout=60)
    code = r.status_code
    j = r.json() if "application/json" in r.headers.get("content-type", "") else {}
    ok = code == 200 and bool(j.get("body"))
    record("checkin local_hour=99 → 200 (no crash)", ok, code, short(j))
except Exception as e:
    record("checkin local_hour=99", False, "EXC", str(e))


# ==========================================================
# 3) Profile schema extension — settings round-trip
# ==========================================================
print("─── 3) Profile schema extension (round-trip) ───\n")

# 3a) GET /api/profile — defaults present
try:
    r = requests.get(f"{API}/profile", timeout=30)
    code = r.status_code
    j = r.json() if r.ok else {}
    settings = (j or {}).get("settings", {}) or {}
    ok = (
        code == 200
        and "checkin_mode" in settings
        and "checkin_morning_time" in settings
        and "checkin_evening_time" in settings
    )
    record(
        f"GET /api/profile has checkin_* fields "
        f"(mode={settings.get('checkin_mode')!r}, "
        f"morning={settings.get('checkin_morning_time')!r}, "
        f"evening={settings.get('checkin_evening_time')!r})",
        ok, code, short(settings),
    )
    initial_profile = j
    initial_settings = settings
except Exception as e:
    record("GET /api/profile (defaults)", False, "EXC", str(e))
    initial_profile = {}
    initial_settings = {}

# 3b) PUT /api/profile updating checkin fields
try:
    new_settings = dict(initial_settings)  # preserve all existing fields
    new_settings.update({
        "checkin_mode": "both",
        "checkin_morning_time": "07:15",
        "checkin_evening_time": "22:45",
    })
    r = requests.put(f"{API}/profile", json={"settings": new_settings}, timeout=30)
    code = r.status_code
    j = r.json() if r.ok else {}
    s = (j or {}).get("settings", {}) or {}
    ok = (
        code == 200
        and s.get("checkin_mode") == "both"
        and s.get("checkin_morning_time") == "07:15"
        and s.get("checkin_evening_time") == "22:45"
    )
    record("PUT /api/profile {checkin_mode=both, 07:15/22:45} reflected in response",
           ok, code, short(s))
except Exception as e:
    record("PUT /api/profile checkin update", False, "EXC", str(e))

# 3c) GET /api/profile again — values persist
try:
    r = requests.get(f"{API}/profile", timeout=30)
    code = r.status_code
    j = r.json() if r.ok else {}
    s = (j or {}).get("settings", {}) or {}
    ok = (
        code == 200
        and s.get("checkin_mode") == "both"
        and s.get("checkin_morning_time") == "07:15"
        and s.get("checkin_evening_time") == "22:45"
    )
    record("GET /api/profile after PUT — values persisted",
           ok, code, short(s))
except Exception as e:
    record("GET /api/profile after update", False, "EXC", str(e))

# 3d) Restore reasonable defaults so we don't pollute future runs
try:
    restored = dict(initial_settings) if initial_settings else {}
    if not restored:
        restored = {"checkin_mode": "off",
                    "checkin_morning_time": "08:30",
                    "checkin_evening_time": "21:30"}
    requests.put(f"{API}/profile", json={"settings": restored}, timeout=30)
    print("    [info] restored profile settings to baseline.\n")
except Exception as e:
    print(f"    [warn] failed to restore profile settings: {e}\n")


# ==========================================================
# 4) Regression — legacy/Taccuino endpoints not broken
# ==========================================================
print("─── 4) Regression on Taccuino endpoints ───\n")

# 4a) GET /api/
try:
    r = requests.get(f"{API}/", timeout=30)
    code = r.status_code
    j = r.json() if r.ok else {}
    ok = code == 200 and "Taccuino" in (j.get("message") or "")
    record("GET /api/ → 200 'Taccuino Vivo API'", ok, code, short(j))
except Exception as e:
    record("GET /api/", False, "EXC", str(e))

# 4b) POST /api/converse {"text":"ciao"}
try:
    r = requests.post(f"{API}/converse", json={"text": "ciao"}, timeout=120)
    code = r.status_code
    j = r.json() if r.ok else {}
    ok = (
        code == 200
        and isinstance(j.get("user_entry"), dict)
        and isinstance(j.get("ai_entry"), dict)
        and bool(j["ai_entry"].get("text"))
    )
    record("POST /api/converse {'text':'ciao'} → user_entry+ai_entry",
           ok, code, short({"ai_text": j.get("ai_entry", {}).get("text", "")[:200],
                            "tone": j.get("ai_entry", {}).get("tone")}))
except Exception as e:
    record("POST /api/converse", False, "EXC", str(e))

# 4c) GET /api/timeline
try:
    r = requests.get(f"{API}/timeline", timeout=30)
    code = r.status_code
    ok = code == 200 and isinstance(r.json(), list)
    record("GET /api/timeline → 200 list", ok, code,
           f"len={len(r.json()) if r.ok else 'N/A'}")
except Exception as e:
    record("GET /api/timeline", False, "EXC", str(e))

# 4d) GET /api/voices
try:
    r = requests.get(f"{API}/voices", timeout=30)
    code = r.status_code
    j = r.json() if r.ok else {}
    ok = code == 200 and isinstance(j.get("voices"), list) and len(j["voices"]) >= 1
    record("GET /api/voices → 200 with voices[]", ok, code,
           f"voices={len(j.get('voices', []))} enabled={j.get('enabled')}")
except Exception as e:
    record("GET /api/voices", False, "EXC", str(e))

# 4e) GET /api/recap?period=today
try:
    r = requests.get(f"{API}/recap", params={"period": "today"}, timeout=120)
    code = r.status_code
    j = r.json() if r.ok else {}
    ok = code == 200 and isinstance(j.get("recap"), str)
    record("GET /api/recap?period=today → 200 with recap", ok, code, short(j))
except Exception as e:
    record("GET /api/recap?period=today", False, "EXC", str(e))

# 4f) POST /api/transcribe with empty body → 400
try:
    # Send a multipart form with an empty file
    files = {"audio": ("empty.webm", b"", "audio/webm")}
    r = requests.post(f"{API}/transcribe", files=files, timeout=30)
    code = r.status_code
    ok = code == 400
    record("POST /api/transcribe empty audio → 400", ok, code, r.text[:200])
except Exception as e:
    record("POST /api/transcribe empty audio", False, "EXC", str(e))


# ==========================================================
# Summary
# ==========================================================
print("\n=== SUMMARY ===")
passed = sum(1 for _, ok, *_ in results if ok)
total = len(results)
print(f"Passed: {passed}/{total}")
for name, ok, code, _ in results:
    print(f"  {'✅' if ok else '❌'} [{code}] {name}")

sys.exit(0 if passed == total else 1)
