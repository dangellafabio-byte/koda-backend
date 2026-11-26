"""Account-scoped voice selection and usage accounting for direct HTTP delivery."""
import os


async def voice_route(db, uid, default_voice):
    from koda_tts_prefs import PREFS_COLLECTION
    prefs = await db[PREFS_COLLECTION].find_one({"user_id": uid}, {"provider": 1, "voice_id": 1, "_id": 0})
    provider = prefs.get("provider") if prefs else "elevenlabs"
    if provider not in ("inworld", "elevenlabs") or os.getenv("OLLENYA_PRIVATE_TTS_PROVIDER") != provider:
        raise ValueError("Private speech unavailable")
    from koda_voice_catalog import find_by_key, find_by_elevenlabs_voice_id
    selected = (prefs or {}).get("voice_id") or default_voice
    entry = find_by_key(selected) or find_by_elevenlabs_voice_id(selected)
    if provider == "inworld":
        if not entry or not entry.inworld_voice_id or provider not in entry.available_on:
            raise ValueError("Selected voice unavailable")
        return provider, entry.inworld_voice_id
    return provider, entry.elevenlabs_voice_id if entry else selected


async def account_audio(collection, uid, seconds):
    """Compare-and-swap using only subscription fields. Never load the memory profile."""
    import subscription_ledger as ledger
    for _ in range(6):
        row = await collection.find_one({"id": uid}, {"_id": 0, "subscription_tier": 1, "ledger_state": 1})
        tier = (row or {}).get("subscription_tier")
        if tier == "unlimited":
            return
        if tier not in ("monthly", "bimonthly", "annual") or seconds <= 0:
            raise ValueError("Voice quota unavailable")
        old = row.get("ledger_state")
        state = (ledger.SubscriptionLedger.from_dict(old) if old and old.get("plan") == tier
                 else ledger.create_ledger(tier))
        before = state.current_period_index
        result = ledger.consume(state, seconds / 60)
        update = {"$set": {"ledger_state": state.to_dict()}}
        if state.current_period_index != before:
            update["$set"]["minutes_used_this_month"] = float(result.total_consumed)
        else:
            update["$inc"] = {"minutes_used_this_month": float(result.total_consumed)}
        written = await collection.update_one({"id": uid, "subscription_tier": tier, "ledger_state": old}, update)
        if written.matched_count:
            return
    raise RuntimeError("Voice quota update conflicted")
