"""
Backend tests for L'Amico Fraterno pivot (2026-05-10).

Tests:
  1. Profile schema with new fields ai_name/ai_gender/user_gender (round-trip).
  2. /api/converse with brotherly persona — empathic listening.
  3. Italian gender agreement (masc vs fem).
  4. Brotherly "spronare" behavior (suggest reconnecting with humans).
  5. Action suggestion after long catarsi.
  6. Regression: GET /api/, /api/voices, /api/timeline, /api/checkin/generate.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import requests


# ---------- Resolve base URL from frontend/.env ----------
def _read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_env = _read_env(Path("/app/frontend/.env"))
BACKEND = _env.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BACKEND:
    print("ERROR: EXPO_PUBLIC_BACKEND_URL not found in /app/frontend/.env")
    sys.exit(1)
API = f"{BACKEND}/api"
print(f"API base: {API}")

TIMEOUT = 90  # converse may take 30-60s with Claude

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    print(f"\n[{status}] {name}")
    if detail:
        for line in detail.splitlines():
            print(f"    {line}")
    results.append((name, ok, detail))


def get(path: str, **kw) -> requests.Response:
    return requests.get(f"{API}{path}", timeout=TIMEOUT, **kw)


def post(path: str, **kw) -> requests.Response:
    return requests.post(f"{API}{path}", timeout=TIMEOUT, **kw)


def put(path: str, **kw) -> requests.Response:
    return requests.put(f"{API}{path}", timeout=TIMEOUT, **kw)


# ---------- 1. Profile schema with new fields ----------
def test_profile_schema():
    print("\n========== 1. Profile schema (ai_name/ai_gender/user_gender) ==========")
    # Step 1a: GET /api/profile shows the 3 new fields with defaults
    r = get("/profile")
    if r.status_code != 200:
        record("1a. GET /profile", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    p = r.json()
    has_all = all(k in p for k in ("ai_name", "ai_gender", "user_gender"))
    record(
        "1a. GET /profile includes ai_name/ai_gender/user_gender",
        has_all,
        f"ai_name={p.get('ai_name')!r} ai_gender={p.get('ai_gender')!r} "
        f"user_gender={p.get('user_gender')!r}",
    )

    # Step 1b: PUT all 4 fields
    body = {"ai_name": "Aurora", "ai_gender": "f", "user_gender": "m", "name": "Marco"}
    r = put("/profile", json=body)
    if r.status_code != 200:
        record("1b. PUT /profile (all 4 fields)", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    p = r.json()
    ok = (
        p.get("ai_name") == "Aurora"
        and p.get("ai_gender") == "f"
        and p.get("user_gender") == "m"
        and p.get("name") == "Marco"
    )
    record(
        "1b. PUT /profile reflects all 4 fields",
        ok,
        f"ai_name={p.get('ai_name')!r} ai_gender={p.get('ai_gender')!r} "
        f"user_gender={p.get('user_gender')!r} name={p.get('name')!r}",
    )

    # Step 1c: GET /api/profile confirms persistence
    r = get("/profile")
    p = r.json()
    ok = (
        r.status_code == 200
        and p.get("ai_name") == "Aurora"
        and p.get("ai_gender") == "f"
        and p.get("user_gender") == "m"
        and p.get("name") == "Marco"
    )
    record(
        "1c. GET /profile persistence after PUT",
        ok,
        f"ai_name={p.get('ai_name')!r} ai_gender={p.get('ai_gender')!r} "
        f"user_gender={p.get('user_gender')!r} name={p.get('name')!r}",
    )

    # Step 1d: PUT only ai_name → others should remain unchanged
    r = put("/profile", json={"ai_name": "Coda"})
    if r.status_code != 200:
        record("1d. PUT /profile partial", False, f"HTTP {r.status_code}: {r.text[:200]}")
        return
    p = r.json()
    ok = (
        p.get("ai_name") == "Coda"
        and p.get("ai_gender") == "f"      # unchanged
        and p.get("user_gender") == "m"    # unchanged
        and p.get("name") == "Marco"        # unchanged
    )
    record(
        "1d. PUT /profile partial (only ai_name) keeps others unchanged",
        ok,
        f"ai_name={p.get('ai_name')!r} ai_gender={p.get('ai_gender')!r} "
        f"user_gender={p.get('user_gender')!r} name={p.get('name')!r}",
    )


# ---------- 2. Converse — empathic listening ----------
BAD_OPENERS = [
    "certo!",
    "certo,",
    "capisco perfettamente",
    "sono qui per",
    "come posso aiutarti",
    "come posso aiutarvi",
]


def _opens_with_bot_phrase(text: str) -> tuple[bool, str]:
    s = text.lower().lstrip("[ ]").lstrip()
    # Strip leading audio tag if present like [warmly]
    s = re.sub(r"^\[[^\]]+\]\s*", "", s)
    for bad in BAD_OPENERS:
        if s.startswith(bad):
            return True, bad
    return False, ""


def _sentence_count(text: str) -> int:
    # very rough sentence count
    cleaned = re.sub(r"\[[^\]]+\]", "", text or "")
    parts = re.split(r"[.!?…]+", cleaned)
    return len([p for p in parts if p.strip()])


def test_empathic_listening():
    print("\n========== 2. Converse — empathic listening (brotherly) ==========")
    # Pre-condition
    r = put("/profile", json={"name": "Marco", "ai_gender": "f", "user_gender": "m"})
    record(
        "2.pre. PUT profile name=Marco user=m ai=f",
        r.status_code == 200,
        f"HTTP {r.status_code}",
    )

    payload = {"text": "Devo dirti una cosa che non ho mai detto a nessuno"}
    r = post("/converse", json=payload)
    if r.status_code != 200:
        record(
            "2. POST /converse (confidenza)",
            False,
            f"HTTP {r.status_code}: {r.text[:300]}",
        )
        return
    data = r.json()
    ai = data.get("ai_entry") or {}
    text = ai.get("text") or ""
    voice_text = ai.get("voice_text") or ""
    tone = ai.get("tone")

    bad, bad_phrase = _opens_with_bot_phrase(text)
    sentences = _sentence_count(text)

    detail = (
        f"ai.text={text!r}\n"
        f"ai.voice_text={voice_text!r}\n"
        f"tone={tone}\n"
        f"sentences={sentences}\n"
        f"bot_opener={bad_phrase or 'none'}"
    )
    # Pass criteria: not a bot opener, reasonably short
    ok = (not bad) and sentences <= 4
    record("2. Empathic listening response qualitative check", ok, detail)


# ---------- 3. Italian gender agreement ----------
def _has_word(text: str, words: list[str]) -> list[str]:
    found = []
    low = " " + re.sub(r"\[[^\]]+\]", "", text or "").lower() + " "
    for w in words:
        if re.search(r"\b" + re.escape(w) + r"\b", low):
            found.append(w)
    return found


def test_gender_agreement():
    print("\n========== 3. Italian gender agreement ==========")
    # ----- Female -----
    r = put("/profile", json={"user_gender": "f", "ai_gender": "f", "name": "Sara"})
    record("3a.pre. PUT profile user=f ai=f name=Sara", r.status_code == 200, f"HTTP {r.status_code}")

    r = post("/converse", json={"text": "Sono molto stanca oggi, e mi sento sola"})
    if r.status_code != 200:
        record("3a. POST /converse (female)", False, f"HTTP {r.status_code}: {r.text[:300]}")
    else:
        ai = r.json().get("ai_entry") or {}
        text = ai.get("text") or ""
        # Mismatch = masculine forms applied to a female user.
        mismatch_masc = _has_word(text, ["stanco", "solo", "provato", "triste lui", "preoccupato"])
        # We deliberately do NOT flag "solo" alone because Italian uses it as
        # adverb meaning "only" too. Check word-boundary, then context: if
        # surrounded by "sei|ti vedo|sei stato" it's the mismatch.
        # Stricter check: look for "sei stanco" / "ti vedo stanco" / "sei provato" / "sei solo"
        strict_masc = []
        low = re.sub(r"\[[^\]]+\]", "", text or "").lower()
        for phr in ["sei stanco", "sei solo", "sei provato", "ti vedo stanco", "ti vedo provato", "sei preoccupato", "sei stato"]:
            if phr in low:
                strict_masc.append(phr)

        detail = (
            f"ai.text={text!r}\n"
            f"voice_text={ai.get('voice_text')!r}\n"
            f"flagrant_masc_phrases={strict_masc}\n"
            f"loose_masc_words_seen={mismatch_masc}"
        )
        ok = len(strict_masc) == 0
        record("3a. Female user → no flagrant masculine declension", ok, detail)

    # ----- Male -----
    r = put("/profile", json={"user_gender": "m", "name": "Marco"})
    record("3b.pre. PUT profile user=m name=Marco", r.status_code == 200, f"HTTP {r.status_code}")

    r = post("/converse", json={"text": "Sono molto stanco oggi, e mi sento solo"})
    if r.status_code != 200:
        record("3b. POST /converse (male)", False, f"HTTP {r.status_code}: {r.text[:300]}")
    else:
        ai = r.json().get("ai_entry") or {}
        text = ai.get("text") or ""
        low = re.sub(r"\[[^\]]+\]", "", text or "").lower()
        strict_fem = []
        for phr in ["sei stanca", "sei sola", "sei provata", "ti vedo stanca", "ti vedo provata", "sei preoccupata", "sei stata"]:
            if phr in low:
                strict_fem.append(phr)

        detail = (
            f"ai.text={text!r}\n"
            f"voice_text={ai.get('voice_text')!r}\n"
            f"flagrant_fem_phrases={strict_fem}"
        )
        ok = len(strict_fem) == 0
        record("3b. Male user → no flagrant feminine declension", ok, detail)


# ---------- 4. Brotherly "spronare" ----------
def test_spronare():
    print("\n========== 4. Brotherly spronare ==========")
    payload = {"text": "Sto un po' esagerando a parlare solo con te ultimamente"}
    r = post("/converse", json=payload)
    if r.status_code != 200:
        record("4. POST /converse (over-reliance)", False, f"HTTP {r.status_code}: {r.text[:300]}")
        return
    ai = r.json().get("ai_entry") or {}
    text = ai.get("text") or ""
    voice = ai.get("voice_text") or ""
    low = (text + " " + voice).lower()
    # Look for hints to reconnect with real humans
    keywords = [
        "carne e ossa", "vera", "vere", "persone", "persona", "umano", "umana",
        "amico", "amica", "amici", "amiche", "famiglia", "fratello", "sorella",
        "uscire", "uscita", "qualcuno", "vita reale", "fuori", "telefono",
        "chiamarl", "chiama ", "mondo reale",
    ]
    hits = [k for k in keywords if k in low]
    detail = (
        f"ai.text={text!r}\n"
        f"voice_text={voice!r}\n"
        f"reconnect_keywords_seen={hits}"
    )
    ok = len(hits) >= 1
    record("4. Suggests reconnecting with real humans", ok, detail)


# ---------- 5. Action suggestion after catarsi ----------
def test_action_after_catarsi():
    print("\n========== 5. Action suggestion after catarsi ==========")
    payload = {
        "text": (
            "Mi sento svuotato. Ho parlato di tutto questo per ore con te. "
            "Non so cosa fare ora."
        )
    }
    r = post("/converse", json=payload)
    if r.status_code != 200:
        record("5. POST /converse (post-catarsi)", False, f"HTTP {r.status_code}: {r.text[:300]}")
        return
    ai = r.json().get("ai_entry") or {}
    text = ai.get("text") or ""
    voice = ai.get("voice_text") or ""
    sentences = _sentence_count(text)
    low = (text + " " + voice).lower()
    action_words = [
        "esci", "uscire", "cammin", "passeggiata", "passeggiare",
        "respira", "aria", "caffè", "telefono", "chiama", "chiamare",
        "muovi", "fuori", "doccia", "cena", "letto", "isolato",
    ]
    hits = [w for w in action_words if w in low]
    detail = (
        f"ai.text={text!r}\n"
        f"voice_text={voice!r}\n"
        f"sentences={sentences}\n"
        f"action_keywords_seen={hits}"
    )
    # Spec says "may suggest" — accept either short-but-action OR short empathic.
    # Hard requirement: short (<= 5 sentences) and not a bot opener.
    bad, _ = _opens_with_bot_phrase(text)
    ok = (not bad) and sentences <= 5
    record("5. Post-catarsi: short, non-bot tone (action suggestion optional)", ok, detail)


# ---------- 6. Regression ----------
def test_regression():
    print("\n========== 6. Regression — other endpoints ==========")
    r = get("/")
    ok = r.status_code == 200 and "Taccuino Vivo" in (r.text or "")
    record("6a. GET /api/", ok, f"HTTP {r.status_code} body={r.text[:150]}")

    r = get("/voices")
    ok = r.status_code == 200 and isinstance(r.json().get("voices"), list)
    record("6b. GET /api/voices", ok, f"HTTP {r.status_code} voices={len(r.json().get('voices', []))}")

    r = get("/timeline")
    ok = r.status_code == 200 and isinstance(r.json(), list)
    record("6c. GET /api/timeline", ok, f"HTTP {r.status_code} entries={len(r.json()) if r.status_code==200 else '-'}")

    r = post("/checkin/generate", json={"slot": "morning", "local_hour": 9})
    if r.status_code != 200:
        record("6d. POST /api/checkin/generate", False, f"HTTP {r.status_code}: {r.text[:200]}")
    else:
        d = r.json()
        ok = all(k in d and d[k] for k in ("title", "body", "voice_text", "tone"))
        record(
            "6d. POST /api/checkin/generate (morning, 9)",
            ok,
            f"title={d.get('title')!r} body={d.get('body')!r} "
            f"tone={d.get('tone')} voice_text={d.get('voice_text')!r}",
        )


# ---------- Main ----------
if __name__ == "__main__":
    try:
        test_profile_schema()
        test_empathic_listening()
        test_gender_agreement()
        test_spronare()
        test_action_after_catarsi()
        test_regression()
    except Exception as e:
        print(f"\n!! Unhandled exception during tests: {e}")
        raise
    finally:
        print("\n\n==================== SUMMARY ====================")
        passed = sum(1 for _, ok, _ in results if ok)
        failed = sum(1 for _, ok, _ in results if not ok)
        print(f"PASSED: {passed}    FAILED: {failed}    TOTAL: {len(results)}")
        for name, ok, _ in results:
            print(f"  {'✅' if ok else '❌'}  {name}")
