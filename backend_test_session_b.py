"""
Session B backend tests: Sealed Confessional + Web Search + auto-injection.
Run: python /app/backend_test_session_b.py
"""
import os
import sys
import time
import json
import base64
import requests
from nacl import secret as _nacl_secret
from nacl import utils as _nacl_utils

BASE = os.environ.get("BACKEND_URL") or "https://app-finder-408.preview.emergentagent.com/api"
TIMEOUT = 60

PASS = []
FAIL = []
WARN = []


def _log(ok, name, msg=""):
    line = f"{'✅' if ok else '❌'} {name}"
    if msg:
        line += f" — {msg}"
    print(line)
    (PASS if ok else FAIL).append((name, msg))


def _warn(name, msg):
    print(f"⚠️  {name} — {msg}")
    WARN.append((name, msg))


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


# =========================================================================
# 1. SEALED CONFESSIONAL  /api/converse/sealed
# =========================================================================
def test_sealed_happy_path():
    name = "1a) Sealed happy path: encrypt → 200 → decrypt valid Italian reply"
    key = _nacl_utils.random(32)
    box = _nacl_secret.SecretBox(key)
    plaintext = "Devo confessare una cosa terribile, ho fatto male a una persona"
    encrypted = box.encrypt(plaintext.encode("utf-8"))
    nonce_b64 = _b64(encrypted.nonce)
    ct_b64 = _b64(encrypted.ciphertext)
    body = {
        "nonce": nonce_b64,
        "ciphertext": ct_b64,
        "language": "it",
        "ai_name": "Coda",
        "ai_gender": "f",
        "user_gender": "m",
    }
    headers = {"X-Sealed-Key": _b64(key), "Content-Type": "application/json"}
    try:
        r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=TIMEOUT)
    except Exception as e:
        _log(False, name, f"request error: {e}")
        return None, None
    if r.status_code != 200:
        _log(False, name, f"status {r.status_code} body={r.text[:300]}")
        return None, None
    try:
        data = r.json()
    except Exception:
        _log(False, name, f"non-JSON response: {r.text[:200]}")
        return None, None
    out_nonce_b64 = data.get("nonce")
    out_ct_b64 = data.get("ciphertext")
    tone = data.get("tone")
    if not out_nonce_b64 or not out_ct_b64 or not tone:
        _log(False, name, f"missing fields: {data}")
        return None, None
    if tone not in {"warm", "calm", "concerned", "neutral", "energetic", "urgent"}:
        _log(False, name, f"unexpected tone {tone!r}")
        return None, None
    # Decrypt with same key
    try:
        out_nonce = base64.b64decode(out_nonce_b64)
        out_ct = base64.b64decode(out_ct_b64)
        decrypted = box.decrypt(out_ct, out_nonce).decode("utf-8")
    except Exception as e:
        _log(False, name, f"decrypt failed: {e}")
        return None, None
    # Sanity: Italian-ish, non-empty, may start with audio tag
    if len(decrypted) < 5:
        _log(False, name, f"decrypted reply too short: {decrypted!r}")
        return None, None
    print(f"   reply tone={tone!r} sample: {decrypted[:200]!r}")
    _log(True, name)
    return decrypted, tone


def test_sealed_missing_header():
    name = "1b) Missing X-Sealed-Key header → 400"
    key = _nacl_utils.random(32)
    box = _nacl_secret.SecretBox(key)
    encrypted = box.encrypt(b"ciao", _nacl_utils.random(_nacl_secret.SecretBox.NONCE_SIZE))
    body = {"nonce": _b64(encrypted.nonce), "ciphertext": _b64(encrypted.ciphertext), "language": "it"}
    r = requests.post(f"{BASE}/converse/sealed", json=body, timeout=TIMEOUT)
    if r.status_code == 400 and "missing X-Sealed-Key" in r.text:
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_sealed_invalid_base64():
    name = "1c) X-Sealed-Key invalid base64 → 400 invalid base64 payload"
    key = _nacl_utils.random(32)
    box = _nacl_secret.SecretBox(key)
    encrypted = box.encrypt(b"ciao", _nacl_utils.random(_nacl_secret.SecretBox.NONCE_SIZE))
    body = {
        "nonce": _b64(encrypted.nonce),
        "ciphertext": _b64(encrypted.ciphertext),
        "language": "it",
    }
    # Send invalid b64 string in nonce field actually — header is purely accepted as text;
    # invalid base64 detection happens during decode of either key/nonce/ct.
    headers = {"X-Sealed-Key": "@@@not-valid-base64@@@!!!"}
    r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=TIMEOUT)
    if r.status_code == 400 and "invalid base64" in r.text:
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_sealed_short_key():
    name = "1d) X-Sealed-Key 16 bytes → 400 invalid key length"
    short_key = _nacl_utils.random(16)
    # Build a body with valid base64 (encrypted with a different real key)
    real_key = _nacl_utils.random(32)
    box = _nacl_secret.SecretBox(real_key)
    encrypted = box.encrypt(b"ciao")
    body = {
        "nonce": _b64(encrypted.nonce),
        "ciphertext": _b64(encrypted.ciphertext),
        "language": "it",
    }
    headers = {"X-Sealed-Key": _b64(short_key)}
    r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=TIMEOUT)
    if r.status_code == 400 and "invalid key length" in r.text:
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_sealed_short_nonce():
    name = "1e) Nonce 12 bytes → 400 invalid nonce length"
    key = _nacl_utils.random(32)
    body = {
        "nonce": _b64(b"\x00" * 12),
        "ciphertext": _b64(b"\x00" * 32),
        "language": "it",
    }
    headers = {"X-Sealed-Key": _b64(key)}
    r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=TIMEOUT)
    if r.status_code == 400 and "invalid nonce length" in r.text:
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_sealed_wrong_key():
    name = "1f) Wrong key (decrypt fails) → 400 decrypt failed"
    real_key = _nacl_utils.random(32)
    fake_key = _nacl_utils.random(32)
    box = _nacl_secret.SecretBox(real_key)
    encrypted = box.encrypt(b"qualcosa di segreto")
    body = {
        "nonce": _b64(encrypted.nonce),
        "ciphertext": _b64(encrypted.ciphertext),
        "language": "it",
    }
    headers = {"X-Sealed-Key": _b64(fake_key)}
    r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=TIMEOUT)
    if r.status_code == 400 and "decrypt failed" in r.text:
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_sealed_no_persistence():
    """g+h: timeline count + memory_summary unchanged after a sealed call."""
    name_t = "1g) Sealed call does NOT add to timeline"
    name_m = "1h) Sealed call does NOT update memory_summary"
    try:
        tl_before = requests.get(f"{BASE}/timeline", timeout=TIMEOUT).json()
        prof_before = requests.get(f"{BASE}/profile", timeout=TIMEOUT).json()
    except Exception as e:
        _log(False, name_t, f"setup fetch failed: {e}")
        _log(False, name_m, "skipped")
        return

    count_before = len(tl_before) if isinstance(tl_before, list) else -1
    mem_before = (prof_before or {}).get("memory_summary", "")

    key = _nacl_utils.random(32)
    box = _nacl_secret.SecretBox(key)
    encrypted = box.encrypt("Una confessione che non deve lasciare traccia.".encode("utf-8"))
    body = {
        "nonce": _b64(encrypted.nonce),
        "ciphertext": _b64(encrypted.ciphertext),
        "language": "it",
        "ai_name": "Coda",
        "ai_gender": "f",
        "user_gender": "m",
    }
    headers = {"X-Sealed-Key": _b64(key)}
    r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=TIMEOUT)
    if r.status_code != 200:
        _log(False, name_t, f"sealed call failed: {r.status_code}")
        _log(False, name_m, "skipped")
        return

    time.sleep(0.5)
    tl_after = requests.get(f"{BASE}/timeline", timeout=TIMEOUT).json()
    prof_after = requests.get(f"{BASE}/profile", timeout=TIMEOUT).json()
    count_after = len(tl_after) if isinstance(tl_after, list) else -2
    mem_after = (prof_after or {}).get("memory_summary", "")

    if count_after == count_before:
        _log(True, name_t, f"count={count_before}")
    else:
        _log(False, name_t, f"timeline grew {count_before} → {count_after}")

    if mem_after == mem_before:
        _log(True, name_m, "memory_summary unchanged")
    else:
        _log(False, name_m, f"memory changed before-len={len(mem_before)} after-len={len(mem_after)}")


# =========================================================================
# 2. SEARCH  /api/search
# =========================================================================
def test_search_happy():
    name = "2a) /api/search happy path Italian query"
    body = {"query": "chi ha vinto la champions league 2024", "max_results": 4}
    r = requests.post(f"{BASE}/search", json=body, timeout=TIMEOUT)
    if r.status_code != 200:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")
        return
    data = r.json()
    results = data.get("results")
    if not isinstance(results, list) or not (1 <= len(results) <= 4):
        _log(False, name, f"unexpected results length: {results}")
        return
    bad = []
    for i, item in enumerate(results):
        for fld in ("title", "snippet", "url"):
            if not isinstance(item.get(fld), str) or not item.get(fld):
                bad.append(f"item[{i}].{fld} empty/missing")
        u = item.get("url", "")
        if not (u.startswith("http://") or u.startswith("https://")):
            bad.append(f"item[{i}].url not http(s): {u!r}")
    if bad:
        _log(False, name, "; ".join(bad[:3]))
    else:
        _log(True, name, f"got {len(results)} results, first url={results[0]['url'][:80]}")


def test_search_empty():
    name = "2b) /api/search empty query → 200 results=[]"
    r = requests.post(f"{BASE}/search", json={"query": "", "max_results": 4}, timeout=TIMEOUT)
    if r.status_code != 200:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")
        return
    data = r.json()
    if data.get("results") == []:
        _log(True, name)
    else:
        _log(False, name, f"unexpected results: {data}")


def test_search_cap8():
    name = "2c) /api/search max_results=8 caps at 8"
    body = {"query": "italia notizie oggi", "max_results": 8}
    r = requests.post(f"{BASE}/search", json=body, timeout=TIMEOUT)
    if r.status_code != 200:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")
        return
    data = r.json()
    n = len(data.get("results") or [])
    if n <= 8:
        _log(True, name, f"got {n} results (cap respected)")
    else:
        _log(False, name, f"got {n} > 8")


# =========================================================================
# 3. CONVERSE WEB-SEARCH AUTO-INJECTION
# =========================================================================
def test_converse_with_search_trigger():
    name = "3a) /api/converse text containing trigger → reply not empty"
    body = {"text": "cerca quanto costa l'iPhone 16 oggi", "ephemeral": False}
    r = requests.post(f"{BASE}/converse", json=body, timeout=120)
    if r.status_code != 200:
        _log(False, name, f"status={r.status_code} body={r.text[:300]}")
        return None
    data = r.json()
    ai = (data or {}).get("ai_entry") or {}
    ai_text = (ai.get("text") or "").strip()
    if len(ai_text) < 5:
        _log(False, name, f"ai reply too short: {ai_text!r}")
        return None
    print(f"   ai reply: {ai_text[:240]!r}")
    _log(True, name, "ai_entry populated")
    return ai_text


def test_converse_ephemeral_no_search():
    name = "3b) /api/converse ephemeral=True with trigger → still 200"
    body = {"text": "cerca quanto costa l'iPhone 16 oggi", "ephemeral": True}
    r = requests.post(f"{BASE}/converse", json=body, timeout=120)
    if r.status_code != 200:
        _log(False, name, f"status={r.status_code} body={r.text[:300]}")
        return
    data = r.json()
    ai = (data or {}).get("ai_entry") or {}
    if not (ai.get("text") or "").strip():
        _log(False, name, "empty ai reply")
        return
    _log(True, name)


def test_converse_no_trigger():
    name = "3c) /api/converse 'ciao come stai?' → no trigger, normal reply"
    body = {"text": "ciao come stai?", "ephemeral": False}
    r = requests.post(f"{BASE}/converse", json=body, timeout=120)
    if r.status_code == 200 and (r.json().get("ai_entry") or {}).get("text"):
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_converse_ore_trigger():
    name = "3d) /api/converse 'che ore sono adesso' → 200, trigger expected"
    body = {"text": "che ore sono adesso", "ephemeral": False}
    r = requests.post(f"{BASE}/converse", json=body, timeout=120)
    if r.status_code == 200 and (r.json().get("ai_entry") or {}).get("text"):
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def test_converse_news_trigger():
    name = "3e) /api/converse 'raccontami delle ultime news' → 200, trigger"
    body = {"text": "raccontami delle ultime news", "ephemeral": False}
    r = requests.post(f"{BASE}/converse", json=body, timeout=120)
    if r.status_code == 200 and (r.json().get("ai_entry") or {}).get("text"):
        _log(True, name)
    else:
        _log(False, name, f"status={r.status_code} body={r.text[:200]}")


def check_backend_logs_for_search_injection():
    """Best-effort: tail backend logs and look for the [converse] web search injected line."""
    name = "3f) Backend logs show '[converse] web search injected' for non-ephemeral trigger"
    try:
        import subprocess
        out = subprocess.check_output(
            "tail -n 400 /var/log/supervisor/backend.*.log 2>/dev/null | grep -E 'web search injected|web search failed' | tail -n 20",
            shell=True, text=True
        )
    except Exception as e:
        _warn(name, f"could not read logs: {e}")
        return
    if "web search injected" in out:
        _log(True, name, f"found marker — sample: {out.strip().splitlines()[-1][:160]}")
    else:
        # Not strictly a failure of the API but observability degraded
        _warn(name, f"no '[converse] web search injected' line found in last 400 lines (logs:\n{out[:400]})")


# =========================================================================
# 4. REGRESSION
# =========================================================================
def test_regression():
    print("\n--- 4. Regression ---")
    # GET /
    r = requests.get(f"{BASE}/", timeout=TIMEOUT)
    _log(r.status_code == 200, "4.1 GET /api/", f"status={r.status_code}")

    # GET /profile
    r = requests.get(f"{BASE}/profile", timeout=TIMEOUT)
    _log(r.status_code == 200, "4.2 GET /api/profile", f"status={r.status_code}")

    # PUT /profile name=Marco
    r = requests.put(f"{BASE}/profile", json={"name": "Marco"}, timeout=TIMEOUT)
    ok = r.status_code == 200 and (r.json().get("name") == "Marco")
    _log(ok, "4.3 PUT /api/profile name=Marco", f"status={r.status_code}")

    # GET /timeline
    r = requests.get(f"{BASE}/timeline", timeout=TIMEOUT)
    _log(r.status_code == 200 and isinstance(r.json(), list), "4.4 GET /api/timeline", f"status={r.status_code}")

    # POST /converse
    r = requests.post(f"{BASE}/converse", json={"text": "ciao"}, timeout=120)
    if r.status_code == 200:
        d = r.json()
        ok = bool(d.get("ai_entry") and d.get("user_entry") and d.get("profile"))
        _log(ok, "4.5 POST /api/converse {text:ciao}", "ai_entry+user_entry+profile present")
    else:
        _log(False, "4.5 POST /api/converse {text:ciao}", f"status={r.status_code} body={r.text[:200]}")

    # POST /checkin/generate
    r = requests.post(f"{BASE}/checkin/generate", json={"slot": "morning", "local_hour": 9}, timeout=120)
    if r.status_code == 200:
        d = r.json()
        ok = bool(d.get("title") and d.get("body") and d.get("voice_text") and d.get("tone"))
        _log(ok, "4.6 POST /api/checkin/generate", f"title={d.get('title')!r}")
    else:
        _log(False, "4.6 POST /api/checkin/generate", f"status={r.status_code} body={r.text[:200]}")

    # GET /voices
    r = requests.get(f"{BASE}/voices", timeout=TIMEOUT)
    _log(
        r.status_code == 200 and isinstance(r.json().get("voices"), list),
        "4.7 GET /api/voices",
        f"status={r.status_code} count={len((r.json() or {}).get('voices') or [])}"
    )

    # GET /recap?period=today
    r = requests.get(f"{BASE}/recap?period=today", timeout=120)
    _log(r.status_code == 200, "4.8 GET /api/recap?period=today", f"status={r.status_code}")

    # POST /transcribe empty audio → 400
    files = {"audio": ("empty.webm", b"", "audio/webm")}
    r = requests.post(f"{BASE}/transcribe", files=files, data={"language": "it"}, timeout=TIMEOUT)
    _log(r.status_code == 400, "4.9 POST /api/transcribe empty → 400", f"status={r.status_code}")


def main():
    print(f"Backend: {BASE}\n")
    print("--- 1. Sealed Confessional ---")
    test_sealed_happy_path()
    test_sealed_missing_header()
    test_sealed_invalid_base64()
    test_sealed_short_key()
    test_sealed_short_nonce()
    test_sealed_wrong_key()
    test_sealed_no_persistence()

    print("\n--- 2. /api/search (DuckDuckGo) ---")
    test_search_happy()
    test_search_empty()
    test_search_cap8()

    print("\n--- 3. /api/converse web-search auto-injection ---")
    test_converse_with_search_trigger()
    test_converse_ephemeral_no_search()
    test_converse_no_trigger()
    test_converse_ore_trigger()
    test_converse_news_trigger()
    check_backend_logs_for_search_injection()

    test_regression()

    print(f"\n=== SUMMARY: {len(PASS)} pass, {len(FAIL)} fail, {len(WARN)} warn ===")
    if FAIL:
        print("FAILURES:")
        for n, m in FAIL:
            print(f"  ❌ {n} — {m}")
    if WARN:
        print("WARNINGS:")
        for n, m in WARN:
            print(f"  ⚠️  {n} — {m}")
    sys.exit(0 if not FAIL else 1)


if __name__ == "__main__":
    main()
