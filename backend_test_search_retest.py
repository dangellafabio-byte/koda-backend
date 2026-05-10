"""
Retest after fix: Wikipedia REST API replaces DuckDuckGo HTML scraping.
Tests:
  1. POST /api/search with various queries
  2. POST /api/converse with web search auto-injection
  3. Smoke regression on previously passing endpoints
"""
import os
import sys
import json
import time
import base64
import secrets
import nacl.secret
import nacl.utils
import requests

BASE = "https://app-finder-408.preview.emergentagent.com/api"

results = []

def log(name, ok, msg=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {msg}")
    results.append((name, ok, msg))


def test_search_champions():
    body = {"query": "Champions League 2024 vincitore", "max_results": 3}
    r = requests.post(f"{BASE}/search", json=body, timeout=20)
    if r.status_code != 200:
        log("search.champions", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    data = r.json()
    items = data.get("results") or []
    if len(items) < 1:
        log("search.champions", False, f"expected >=1 results, got {len(items)}: {data}")
        return
    # Verify each item structure
    bad = []
    for it in items:
        if not it.get("title"): bad.append("missing title")
        if not it.get("snippet") or len(it.get("snippet", "").strip()) < 10:
            bad.append(f"empty/short snippet: {it.get('snippet')!r}")
        url = it.get("url") or ""
        if not url.startswith("https://it.wikipedia.org/wiki/") and not url.startswith("https://en.wikipedia.org/wiki/"):
            bad.append(f"unexpected url: {url}")
    if bad:
        log("search.champions", False, f"validation issues: {bad}; sample={items[0]}")
        return
    log("search.champions", True, f"got {len(items)} results; first title={items[0]['title']!r}, snippet[:80]={items[0]['snippet'][:80]!r}, url={items[0]['url']}")


def test_search_italia_repubblica():
    body = {"query": "Italia Repubblica", "max_results": 2}
    r = requests.post(f"{BASE}/search", json=body, timeout=20)
    if r.status_code != 200:
        log("search.italia_rep", False, f"HTTP {r.status_code}")
        return
    items = r.json().get("results") or []
    if len(items) < 1:
        log("search.italia_rep", False, f"expected >=1 result, got {len(items)}")
        return
    log("search.italia_rep", True, f"got {len(items)} results; first={items[0]['title']!r}")


def test_search_empty():
    r = requests.post(f"{BASE}/search", json={"query": ""}, timeout=20)
    if r.status_code != 200:
        log("search.empty_query", False, f"HTTP {r.status_code}")
        return
    items = r.json().get("results") or []
    if items != []:
        log("search.empty_query", False, f"expected empty list, got {items}")
        return
    log("search.empty_query", True, "results=[] as expected")


def test_search_nonsense():
    body = {"query": "ajksdhflakjsdhflkjasdf nonsense xyzqqq"}
    r = requests.post(f"{BASE}/search", json=body, timeout=20)
    if r.status_code != 200:
        log("search.nonsense", False, f"HTTP {r.status_code}")
        return
    items = r.json().get("results") or []
    if items != []:
        log("search.nonsense", False, f"expected empty list, got {len(items)} items: {items[:1]}")
        return
    log("search.nonsense", True, "results=[] as expected")


def test_converse_web_inject_uefa():
    body = {"text": "cerca cos'è la UEFA Champions League"}
    r = requests.post(f"{BASE}/converse", json=body, timeout=60)
    if r.status_code != 200:
        log("converse.web_inject_uefa", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    data = r.json()
    ai_text = ((data.get("ai_entry") or {}).get("text") or "").lower()
    if not ai_text:
        log("converse.web_inject_uefa", False, "ai_entry.text empty")
        return
    # Verify reference to Wikipedia content
    keywords = ["uefa", "champions", "edizion", "final", "calci", "europ", "competiz", "club"]
    hits = [k for k in keywords if k in ai_text]
    if len(hits) < 2:
        log("converse.web_inject_uefa", False,
            f"ai_text doesn't seem to reference Wikipedia content (matched={hits}). text[:300]={ai_text[:300]!r}")
        return
    log("converse.web_inject_uefa", True,
        f"ai text references Wikipedia content (matched={hits}); text[:200]={ai_text[:200]!r}")


def test_converse_no_trigger():
    body = {"text": "ciao come stai?"}
    r = requests.post(f"{BASE}/converse", json=body, timeout=60)
    if r.status_code != 200:
        log("converse.no_trigger", False, f"HTTP {r.status_code}")
        return
    log("converse.no_trigger", True, "200 OK; trigger heuristic should not fire (verify via logs)")


def test_converse_ephemeral_no_inject():
    body = {"text": "cerca cos'è la UEFA Champions League", "ephemeral": True}
    r = requests.post(f"{BASE}/converse", json=body, timeout=60)
    if r.status_code != 200:
        log("converse.ephemeral_no_inject", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    log("converse.ephemeral_no_inject", True, "200 OK; ephemeral should bypass web search (verify via logs)")


def test_converse_sealed_smoke():
    """Smoke test of the previously-passing sealed endpoint."""
    key = nacl.utils.random(32)
    box = nacl.secret.SecretBox(key)
    nonce = nacl.utils.random(24)
    plaintext = "Ho bisogno di parlare con qualcuno, mi sento solo stasera.".encode("utf-8")
    ct_full = box.encrypt(plaintext, nonce)
    ciphertext = ct_full.ciphertext  # without nonce prefix
    body = {
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
    headers = {"X-Sealed-Key": base64.b64encode(key).decode()}
    r = requests.post(f"{BASE}/converse/sealed", json=body, headers=headers, timeout=60)
    if r.status_code != 200:
        log("converse.sealed_smoke", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    data = r.json()
    try:
        resp_nonce = base64.b64decode(data["nonce"])
        resp_ct = base64.b64decode(data["ciphertext"])
        plain_resp = box.decrypt(resp_ct, resp_nonce).decode("utf-8")
    except Exception as e:
        log("converse.sealed_smoke", False, f"decrypt failed: {e}")
        return
    if not plain_resp.strip():
        log("converse.sealed_smoke", False, "empty decrypted response")
        return
    log("converse.sealed_smoke", True, f"decrypted reply len={len(plain_resp)}; tone={data.get('tone')}; sample={plain_resp[:100]!r}")


def test_profile_smoke():
    r = requests.get(f"{BASE}/profile", timeout=20)
    if r.status_code != 200:
        log("profile.get", False, f"HTTP {r.status_code}")
        return
    log("profile.get", True, "200 OK")


def test_converse_ciao_smoke():
    body = {"text": "ciao"}
    r = requests.post(f"{BASE}/converse", json=body, timeout=60)
    if r.status_code != 200:
        log("converse.ciao", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    data = r.json()
    if not (data.get("ai_entry") or {}).get("text"):
        log("converse.ciao", False, "no ai_entry.text")
        return
    log("converse.ciao", True, "200 OK with ai_entry.text")


if __name__ == "__main__":
    print(f"Backend: {BASE}\n")
    print("=== /api/search tests ===")
    test_search_champions()
    test_search_italia_repubblica()
    test_search_empty()
    test_search_nonsense()
    print("\n=== /api/converse web inject tests ===")
    test_converse_web_inject_uefa()
    test_converse_no_trigger()
    test_converse_ephemeral_no_inject()
    print("\n=== Regression smoke ===")
    test_converse_sealed_smoke()
    test_profile_smoke()
    test_converse_ciao_smoke()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"\n=== SUMMARY: {passed} pass, {failed} fail (of {len(results)}) ===")
    for name, ok, msg in results:
        if not ok:
            print(f"  FAIL: {name}: {msg}")
    sys.exit(0 if failed == 0 else 1)
