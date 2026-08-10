#!/usr/bin/env python3
"""
Rigenera le 11 clip persona-test dopo:
  1. FIX prompt "validare != interpretare" (server.py:2103-2115)
  2. FIX pacing TTS ridotto ~5-6% (server.py _voice_settings_for_tone)

Genera nuove risposte LLM tramite /api/converse (utente isolato), nuove TTS
tramite /api/tts, salva 11 mp3 in /app/frontend/assets/persona-test/NN.mp3
ed emette il JSON aggiornato per persona-test.tsx.

Cleanup finale: cancella il profilo/timeline dell'utente di test.
"""
import os
import sys
import json
import time
import asyncio
import pathlib
import httpx
from motor.motor_asyncio import AsyncIOMotorClient

# === Setup ===
BACKEND_URL = "http://localhost:8001"
TEST_USER_ID = "persona_test_gen_2026_08_10"
ASSETS_DIR = pathlib.Path("/app/frontend/assets/persona-test")
CONFIDENCE_TARGET = 35  # AMICHEVOLE
VOICE_CIELO = "POuqf18evoXOKIqV2Px7"

PROMPTS = [
    "Non lo so.",
    "Sono felicissimo cazzo.",
    "Ho litigato con mia madre.",
    "Boh.",
    "Sai che mi è successa una cosa assurda?",
    "Non ho voglia di parlare.",
    "Secondo te sto facendo una cazzata?",
    "Mi manca.",
    "Guarda che giornata di merda.",
    "Ho appena conosciuto una ragazza.",
    "Lascia stare, non voglio parlarne.",
]

async def setup_test_user(db) -> None:
    """Crea il profilo di test con confidence_level=35 (AMICHEVOLE)."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    await db.taccuino_profile.update_one(
        {"user_id": TEST_USER_ID},
        {
            "$set": {
                "user_id": TEST_USER_ID,
                "email": "persona_test@koda.local",
                "name": "Fabio",
                "koda_voice": "Cielo",
                "confidence_level": CONFIDENCE_TARGET,
                "onboarded": True,
                "interactions": 30,  # basta per essere "familiar"
                "last_seen_at": now,
                "settings": {"ai_enabled": True, "language": "it"},
                "memory_summary": "",
                "core_traits": "",
            }
        },
        upsert=True,
    )
    print(f"[SETUP] Test user created: {TEST_USER_ID} @ confidence_level={CONFIDENCE_TARGET}")

async def cleanup_test_user(db) -> None:
    """Cancella tutto lo stato del test user."""
    r1 = await db.taccuino_profile.delete_many({"user_id": TEST_USER_ID})
    r2 = await db.taccuino_timeline.delete_many({"user_id": TEST_USER_ID})
    r3 = await db.taccuino_key_facts.delete_many({"user_id": TEST_USER_ID})
    print(f"[CLEANUP] deleted: profile={r1.deleted_count} timeline={r2.deleted_count} key_facts={r3.deleted_count}")

async def call_converse(client: httpx.AsyncClient, text: str) -> dict:
    """Chiama /api/converse con l'header X-User-Id del test user."""
    r = await client.post(
        f"{BACKEND_URL}/api/converse",
        json={"text": text},
        headers={"X-User-Id": TEST_USER_ID},
        timeout=60.0,
    )
    r.raise_for_status()
    data = r.json()
    ai = data.get("ai_entry", {})
    return {
        "text": (ai.get("text") or "").strip(),
        "tone": (ai.get("tone") or "warm").lower(),
    }

async def call_tts(client: httpx.AsyncClient, text: str, tone: str) -> bytes:
    """Chiama /api/tts e restituisce i bytes MP3."""
    r = await client.post(
        f"{BACKEND_URL}/api/tts",
        json={"text": text, "voice_id": VOICE_CIELO, "tone": tone},
        headers={"X-User-Id": TEST_USER_ID},
        timeout=60.0,
    )
    r.raise_for_status()
    return r.content

async def main():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    mongo = AsyncIOMotorClient(mongo_url)
    db = mongo[db_name]

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    results = []
    try:
        await setup_test_user(db)
        async with httpx.AsyncClient() as client:
            for i, prompt in enumerate(PROMPTS, start=1):
                print(f"\n[TURN {i:02d}] user: {prompt!r}")
                # LLM
                t0 = time.time()
                resp = await call_converse(client, prompt)
                t_llm = time.time() - t0
                print(f"  LLM ({t_llm:.1f}s) → tone={resp['tone']!r} chars={len(resp['text'])}")
                print(f"    reply: {resp['text']!r}")
                # TTS
                t0 = time.time()
                mp3_bytes = await call_tts(client, resp["text"], resp["tone"])
                t_tts = time.time() - t0
                out_path = ASSETS_DIR / f"{i:02d}.mp3"
                out_path.write_bytes(mp3_bytes)
                print(f"  TTS ({t_tts:.1f}s) → {out_path} ({len(mp3_bytes)} bytes)")
                results.append({
                    "i": i,
                    "prompt": prompt,
                    "response": resp["text"],
                    "tone": resp["tone"],
                    "chars": len(resp["text"]),
                    "tts_bytes": len(mp3_bytes),
                })
    finally:
        await cleanup_test_user(db)

    # Dump JSON summary
    print("\n\n=== NEW CLIPS SUMMARY (JSON) ===")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    # Also save to a file for easy retrieval
    (ASSETS_DIR / "regeneration_summary.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n[DONE] Saved summary → {ASSETS_DIR / 'regeneration_summary.json'}")

if __name__ == "__main__":
    asyncio.run(main())
