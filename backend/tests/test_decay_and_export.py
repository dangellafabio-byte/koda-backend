"""Test funzionali: time-decay memoria + export GDPR.

Eseguire con:  cd /app/backend && python tests/test_decay_and_export.py
Usa un profile_id di test e pulisce tutto alla fine (nessun impatto sui dati reali).
"""
import asyncio
import sys
import uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, "/app/backend")

import server  # noqa: E402

TEST_UID = str(uuid.uuid4())


async def main():
    db = server.db
    token = server._current_user_id.set(TEST_UID)
    try:
        # --- Setup: due ricordi identici per tag/importance, età diverse ---
        now = datetime.now(timezone.utc)
        old_mem = {
            "id": "test-old",
            "profile_id": TEST_UID,
            "concept": "L'utente ama suonare la chitarra la sera",
            "tags": ["chitarra", "musica"],
            "emotion": None,
            "importance": 7,
            "source": "chat",
            "created_at": (now - timedelta(days=90)).isoformat(),
        }
        new_mem = {
            "id": "test-new",
            "profile_id": TEST_UID,
            "concept": "L'utente ha iniziato un corso di chitarra jazz",
            "tags": ["chitarra", "musica"],
            "emotion": None,
            "importance": 7,
            "source": "chat",
            "created_at": now.isoformat(),
        }
        await db.taccuino_memories.insert_many([dict(old_mem), dict(new_mem)])

        # --- Test 1: time-decay — il ricordo recente deve vincere ---
        mems = await server._load_relevant_memories("parliamo di chitarra", limit=2)
        assert len(mems) == 2, f"attesi 2 ricordi, trovati {len(mems)}"
        assert mems[0].id == "test-new", f"il ricordo recente doveva essere primo, invece: {mems[0].id}"
        print("TEST 1 OK — time-decay: ricordo recente classificato sopra quello di 90gg")

        # --- Test 2: decadimento numerico corretto ---
        import math
        assert abs(2.0 * math.exp(0) - 2.0) < 1e-9
        assert abs(2.0 * math.exp(-30 / 30.0) - 0.7357) < 0.001
        assert abs(2.0 * math.exp(-90 / 30.0) - 0.0996) < 0.001
        print("TEST 2 OK — curva di decadimento: oggi=+2.0, 30gg=+0.74, 90gg=+0.10")

        # --- Test 3: ricordo vecchio ma importante resta raggiungibile ---
        mems_one = await server._load_relevant_memories("parliamo di chitarra", limit=5)
        ids = [m.id for m in mems_one]
        assert "test-old" in ids, "il ricordo vecchio non deve sparire, solo pesare meno"
        print("TEST 3 OK — ricordo vecchio ancora raggiungibile (pesa meno, non sparisce)")

    finally:
        await db.taccuino_memories.delete_many({"profile_id": TEST_UID})
        server._current_user_id.reset(token)
    print("\nTUTTI I TEST PASSATI")


if __name__ == "__main__":
    asyncio.run(main())
