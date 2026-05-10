"""
Backend tests for "Scatola Nera Emotiva" features:
- Ephemeral mode in /api/converse
- /api/ghost endpoint (with/without preserve_lesson, error handling)
- Profile schema regression (ai_name, ai_gender, user_gender)
- Light regression on other endpoints
"""
import os
import sys
import json
import requests
from pathlib import Path

# Read base URL from frontend env
ENV_PATH = Path("/app/frontend/.env")
BASE_URL = None
for line in ENV_PATH.read_text().splitlines():
    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
        BASE_URL = line.split("=", 1)[1].strip().strip('"').strip("'")
        break

if not BASE_URL:
    print("FATAL: EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")
    sys.exit(1)

API = f"{BASE_URL}/api"
print(f"Testing against: {API}\n")

results = []  # (label, ok, http_code, snippet)

def add(label, ok, code, snippet):
    results.append((label, ok, code, snippet))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {label} | HTTP {code} | {snippet[:200]}")


def get(path, **kw):
    return requests.get(f"{API}{path}", timeout=60, **kw)


def post(path, **kw):
    return requests.post(f"{API}{path}", timeout=120, **kw)


def put(path, **kw):
    return requests.put(f"{API}{path}", timeout=60, **kw)


# ============================================================
# 1. EPHEMERAL MODE — nothing persists
# ============================================================
print("\n=== TEST 1: EPHEMERAL MODE ===")

r = get("/profile")
prof_baseline = r.json()
total_baseline = prof_baseline.get("total_messages", 0)
mem_baseline = prof_baseline.get("memory_summary", "") or ""
print(f"baseline total_messages={total_baseline}, mem_len={len(mem_baseline)}")

r = get("/timeline?limit=500")
timeline_baseline = r.json()
tl_count_baseline = len(timeline_baseline)
print(f"baseline timeline count={tl_count_baseline}")

r = post("/converse", json={
    "text": "Una confessione segreta che non deve restare",
    "ephemeral": True,
})
code = r.status_code
try:
    body = r.json()
except Exception:
    body = {}
ok = code == 200 and "user_entry" in body and "ai_entry" in body and "profile" in body
add("1a. POST /converse ephemeral=true returns 200 + user_entry+ai_entry+profile",
    ok, code, json.dumps({k: (v if k != "profile" else "...") for k, v in (body if isinstance(body, dict) else {}).items()})[:300])

eph_ai_text = (body.get("ai_entry", {}) or {}).get("text", "") if ok else ""
eph_user_id = (body.get("user_entry", {}) or {}).get("id") if ok else None
eph_ai_id = (body.get("ai_entry", {}) or {}).get("id") if ok else None
print(f"  ephemeral AI reply: {eph_ai_text[:150]}")

# Profile in response NOT incremented
prof_in_resp = body.get("profile") or {}
total_in_resp = prof_in_resp.get("total_messages", -1)
mem_in_resp = prof_in_resp.get("memory_summary", "") or ""
ok2 = total_in_resp == total_baseline
add("1b. ephemeral response profile.total_messages unchanged", ok2, code,
    f"baseline={total_baseline}, in_resp={total_in_resp}")

ok3 = mem_in_resp == mem_baseline
add("1c. ephemeral response profile.memory_summary unchanged", ok3, code,
    f"baseline_len={len(mem_baseline)}, in_resp_len={len(mem_in_resp)}")

# GET /api/timeline — no entries added
r = get("/timeline?limit=500")
tl_after = r.json()
ok4 = len(tl_after) == tl_count_baseline
# Also confirm by id
ids_after = {e.get("id") for e in tl_after}
no_user_in_tl = (eph_user_id not in ids_after) if eph_user_id else True
no_ai_in_tl = (eph_ai_id not in ids_after) if eph_ai_id else True
add("1d. GET /timeline count unchanged after ephemeral",
    ok4 and no_user_in_tl and no_ai_in_tl, r.status_code,
    f"baseline={tl_count_baseline}, after={len(tl_after)}, user_id_present={not no_user_in_tl}, ai_id_present={not no_ai_in_tl}")

# GET /api/profile — fresh fetch unchanged
r = get("/profile")
prof_after = r.json()
ok5 = (prof_after.get("total_messages", -1) == total_baseline) and \
      ((prof_after.get("memory_summary", "") or "") == mem_baseline)
add("1e. GET /profile total_messages + memory_summary unchanged after ephemeral",
    ok5, r.status_code,
    f"baseline_total={total_baseline}, after_total={prof_after.get('total_messages')}, mem_match={(prof_after.get('memory_summary','') or '')==mem_baseline}")

# ============================================================
# 2. NON-EPHEMERAL still persists (regression)
# ============================================================
print("\n=== TEST 2: NON-EPHEMERAL still persists ===")

prof_pre = get("/profile").json()
total_pre = prof_pre.get("total_messages", 0)
tl_pre = get("/timeline?limit=500").json()
tl_pre_count = len(tl_pre)

r = post("/converse", json={"text": "Questo invece resta nel taccuino"})
code = r.status_code
try:
    body = r.json()
except Exception:
    body = {}
ok = code == 200 and "user_entry" in body
add("2a. POST /converse without ephemeral → 200", ok, code,
    (body.get("ai_entry", {}) or {}).get("text", "")[:150])

prof_post = get("/profile").json()
tl_post = get("/timeline?limit=500").json()
tl_post_count = len(tl_post)

ok2 = (tl_post_count - tl_pre_count) == 2
add("2b. timeline count increased by exactly 2 (user+ai)", ok2, 200,
    f"pre={tl_pre_count}, post={tl_post_count}, delta={tl_post_count-tl_pre_count}")

ok3 = (prof_post.get("total_messages", -1) - total_pre) == 1
add("2c. profile.total_messages incremented by 1", ok3, 200,
    f"pre={total_pre}, post={prof_post.get('total_messages')}")

# ============================================================
# 3. GHOST endpoint — happy path (preserve_lesson=true)
# ============================================================
print("\n=== TEST 3: GHOST happy path (preserve_lesson=true) ===")

r = post("/converse", json={"text": "Ho rubato 20 euro a mio fratello quando ero piccolo"})
code = r.status_code
ghost_target_id = None
try:
    body = r.json()
    ghost_target_id = (body.get("user_entry") or {}).get("id")
except Exception:
    body = {}
add("3a. seed converse for ghost target", code == 200 and bool(ghost_target_id), code,
    f"user_entry.id={ghost_target_id}")

prof_pre_ghost = get("/profile").json()
mem_pre_ghost = prof_pre_ghost.get("memory_summary", "") or ""
print(f"  memory_summary BEFORE ghost (len={len(mem_pre_ghost)}): ...{mem_pre_ghost[-200:]!r}")

r = post("/ghost", json={"entry_id": ghost_target_id, "preserve_lesson": True})
code = r.status_code
try:
    body = r.json()
except Exception:
    body = {}
ok_resp = code == 200 and body.get("ok") is True and body.get("lesson_preserved") is True and isinstance(body.get("lesson"), str) and len(body.get("lesson", "")) > 0
extracted_lesson = body.get("lesson") if isinstance(body, dict) else None
add("3b. POST /ghost preserve_lesson=true → 200 ok=true lesson_preserved=true lesson=<str>",
    ok_resp, code, json.dumps(body)[:300])
print(f"  >>> EXTRACTED LESSON: {extracted_lesson!r}")

# Verify entry GONE
r = get("/timeline?limit=500")
tl_after_ghost = r.json()
ids = {e.get("id") for e in tl_after_ghost}
ok_gone = ghost_target_id not in ids
add("3c. ghosted entry id GONE from timeline", ok_gone, r.status_code,
    f"target={ghost_target_id} present={not ok_gone}")

# Verify memory_summary changed (contains lesson)
r = get("/profile")
prof_post_ghost = r.json()
mem_post_ghost = prof_post_ghost.get("memory_summary", "") or ""
ok_mem = (mem_post_ghost != mem_pre_ghost) and (extracted_lesson and extracted_lesson in mem_post_ghost)
add("3d. profile.memory_summary now contains the extracted lesson",
    ok_mem, r.status_code,
    f"changed={mem_post_ghost != mem_pre_ghost}, lesson_in_mem={(extracted_lesson or '') in mem_post_ghost}; tail: ...{mem_post_ghost[-220:]!r}")

# ============================================================
# 4. GHOST endpoint — preserve_lesson=false
# ============================================================
print("\n=== TEST 4: GHOST preserve_lesson=false ===")

r = post("/converse", json={"text": "Test fatto da cancellare senza lezione"})
code = r.status_code
target_id_2 = None
try:
    body = r.json()
    target_id_2 = (body.get("user_entry") or {}).get("id")
except Exception:
    body = {}
add("4a. seed converse for ghost target (no-lesson)", code == 200 and bool(target_id_2), code, f"id={target_id_2}")

prof_pre_4 = get("/profile").json()
mem_pre_4 = prof_pre_4.get("memory_summary", "") or ""

r = post("/ghost", json={"entry_id": target_id_2, "preserve_lesson": False})
code = r.status_code
try:
    body = r.json()
except Exception:
    body = {}
ok = code == 200 and body.get("ok") is True and body.get("lesson_preserved") is False and body.get("lesson") is None
add("4b. POST /ghost preserve_lesson=false → 200 ok=true lesson_preserved=false lesson=null",
    ok, code, json.dumps(body)[:300])

r = get("/timeline?limit=500")
tl_after = r.json()
ids = {e.get("id") for e in tl_after}
ok_gone = target_id_2 not in ids
add("4c. entry GONE from timeline", ok_gone, r.status_code, f"present={not ok_gone}")

r = get("/profile")
prof_post_4 = r.json()
mem_post_4 = prof_post_4.get("memory_summary", "") or ""
ok_mem = mem_post_4 == mem_pre_4
add("4d. memory_summary UNCHANGED",
    ok_mem, r.status_code,
    f"changed={mem_post_4 != mem_pre_4}; pre_len={len(mem_pre_4)}, post_len={len(mem_post_4)}")

# ============================================================
# 5. GHOST endpoint — error handling
# ============================================================
print("\n=== TEST 5: GHOST error handling ===")

r = post("/ghost", json={"entry_id": "non-esiste-12345", "preserve_lesson": True})
add("5a. unknown entry_id → 404", r.status_code == 404, r.status_code, r.text[:200])

r = post("/ghost", json={})
add("5b. missing entry_id → 422 validation error", r.status_code == 422, r.status_code, r.text[:200])

# ============================================================
# 6. PROFILE schema regression (ai_name, ai_gender, user_gender)
# ============================================================
print("\n=== TEST 6: PROFILE schema regression ===")

r = get("/profile")
prof = r.json()
has_fields = all(k in prof for k in ("ai_name", "ai_gender", "user_gender"))
add("6a. GET /profile returns ai_name/ai_gender/user_gender", has_fields, r.status_code,
    f"ai_name={prof.get('ai_name')}, ai_gender={prof.get('ai_gender')}, user_gender={prof.get('user_gender')}")

r = put("/profile", json={"ai_name": "Aurora", "ai_gender": "f", "user_gender": "m"})
code = r.status_code
try:
    body = r.json()
except Exception:
    body = {}
ok_put = code == 200 and body.get("ai_name") == "Aurora" and body.get("ai_gender") == "f" and body.get("user_gender") == "m"
add("6b. PUT /profile updates ai_name/ai_gender/user_gender", ok_put, code,
    f"ai_name={body.get('ai_name')}, ai_gender={body.get('ai_gender')}, user_gender={body.get('user_gender')}")

# Verify persistence
r = get("/profile")
prof2 = r.json()
ok_persist = prof2.get("ai_name") == "Aurora" and prof2.get("ai_gender") == "f" and prof2.get("user_gender") == "m"
add("6c. PUT values persisted", ok_persist, r.status_code,
    f"ai_name={prof2.get('ai_name')}, ai_gender={prof2.get('ai_gender')}, user_gender={prof2.get('user_gender')}")

# Restore to a sensible state
put("/profile", json={"ai_name": "Coda"})

# ============================================================
# 7. Light regression on other endpoints
# ============================================================
print("\n=== TEST 7: Regression on other endpoints ===")

r = get("/")
add("7a. GET /api/ → 200", r.status_code == 200, r.status_code, r.text[:200])

r = get("/voices")
ok = r.status_code == 200
try:
    j = r.json()
    ok = ok and isinstance(j.get("voices"), list) and len(j["voices"]) >= 8
    snippet = f"voices={len(j['voices'])}, enabled={j.get('enabled')}"
except Exception:
    snippet = r.text[:200]
add("7b. GET /api/voices → 200 with curated voices", ok, r.status_code, snippet)

r = post("/checkin/generate", json={"slot": "morning", "local_hour": 9})
ok = r.status_code == 200
try:
    j = r.json()
    ok = ok and all(k in j for k in ("title", "body", "voice_text", "tone", "slot"))
    snippet = f"title={j.get('title')!r}, tone={j.get('tone')}, voice_text={j.get('voice_text','')[:120]!r}"
except Exception:
    snippet = r.text[:200]
add("7c. POST /api/checkin/generate morning/9 → 200", ok, r.status_code, snippet)


# ============================================================
# SUMMARY
# ============================================================
print("\n" + "=" * 70)
print("SUMMARY")
print("=" * 70)
n_pass = sum(1 for _, ok, _, _ in results if ok)
n_total = len(results)
for label, ok, code, snippet in results:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] HTTP {code} — {label}")

print(f"\n{n_pass}/{n_total} tests passed")
if extracted_lesson:
    print(f"\n>>> EXTRACTED LESSON (from ghost test 3): {extracted_lesson!r}")
sys.exit(0 if n_pass == n_total else 1)
