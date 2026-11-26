"""Bounded, read-only snapshot for individually reviewed device migration."""
from local_memory_auth import verified_memory_uid


async def import_candidates(db, bearer_token, email_to_uid):
    uid = await verified_memory_uid(db.sessions, bearer_token, email_to_uid)
    if not uid:
        return None

    values = []
    seen = set()
    sources = (
        (db.taccuino_memories, {"profile_id": uid, "source": "chat"}, "concept"),
        (db.taccuino_key_facts, {"profile_id": uid}, "fact"),
    )
    for collection, query, field in sources:
        cursor = collection.find(query, {"_id": 0, field: 1}).sort("created_at", -1)
        for item in await cursor.to_list(100):
            value = item.get(field)
            if not isinstance(value, str):
                continue
            value = value.strip()
            if value and len(value) <= 1000 and value not in seen:
                seen.add(value)
                values.append(value)
    return values
