"""
koda_tts_prefs — Preferenze TTS provider+voce per utente.
=========================================================

Collection ``koda_tts_provider_prefs`` separata dal profilo utente.
Modello semplice (post 2026-10, no più token one-shot né whitelist):

    { user_id, provider, voice_id, updated_at }

Flusso:
  * Default per nuovi utenti = ElevenLabs + Cielo.
  * L'utente può cambiare provider/voce dalla UI Impostazioni → "Voce
    di Ollenya". Gli endpoint FastAPI usano l'autenticazione standard
    (middleware HTTP → `current_user_id()`) e PERMETTONO SOLO di
    editare la propria preferenza.
  * La fonte di verità è questa collection. Se un record non esiste
    per l'uid → fallback default (ElevenLabs).

Non espone API keys. Non logga token.
"""
from __future__ import annotations

import datetime as _dt
import logging
from typing import Optional, Dict, Any

log = logging.getLogger(__name__)


PREFS_COLLECTION = "koda_tts_provider_prefs"
ALLOWED_PROVIDERS = frozenset({"elevenlabs", "inworld"})
DEFAULT_PROVIDER = "elevenlabs"


# ============================================================================
# Indici
# ============================================================================
async def ensure_indexes(db) -> None:
    try:
        await db[PREFS_COLLECTION].create_index("user_id", unique=True)
    except Exception as e:
        log.warning(f"[koda_tts_prefs] index failed: {e}")


# ============================================================================
# Letture
# ============================================================================
async def get_prefs_for_uid(db, uid: str) -> Dict[str, Any]:
    """Ritorna {provider, voice_id, updated_at} per l'uid.

    Default (nessun doc) = {provider="elevenlabs", voice_id=None, updated_at=None}.
    `voice_id=None` significa "usa default del profile.settings.tts_voice_id
    attuale" — l'utente non ha ancora espresso una preferenza di voce
    distinta dal provider.
    """
    out = {"provider": DEFAULT_PROVIDER, "voice_id": None, "updated_at": None}
    if not uid or uid == "me":
        return out
    try:
        doc = await db[PREFS_COLLECTION].find_one({"user_id": uid})
    except Exception as e:
        log.warning(f"[koda_tts_prefs] read failed uid={uid[:8]}: {e}")
        return out
    if not doc:
        return out
    provider = (doc.get("provider") or DEFAULT_PROVIDER).lower()
    if provider not in ALLOWED_PROVIDERS:
        provider = DEFAULT_PROVIDER
    vid = doc.get("voice_id")
    if vid is not None and not isinstance(vid, str):
        vid = None
    ua = doc.get("updated_at")
    if isinstance(ua, _dt.datetime):
        ua = ua.isoformat()
    return {"provider": provider, "voice_id": vid, "updated_at": ua}


async def get_provider_for_uid(db, uid: str) -> str:
    """Shortcut: ritorna SOLO il provider. Default `elevenlabs`."""
    prefs = await get_prefs_for_uid(db, uid)
    return prefs.get("provider") or DEFAULT_PROVIDER


# ============================================================================
# Scritture
# ============================================================================
async def set_prefs_for_uid(
    db,
    uid: str,
    *,
    provider: Optional[str] = None,
    voice_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Aggiorna la preferenza. Sovrascrive solo i campi passati esplicitamente.

    - `provider` deve essere in ALLOWED_PROVIDERS.
    - `voice_id` è un identificativo stringa (voce brand "cielo" / "vento" o
      voice_id tecnico, dipende da come il catalogo mappa).
    - Il caller è responsabile di aver autenticato l'utente E che `uid` sia
      quello dell'utente autenticato (NO privilege escalation).

    Ritorna lo stato dopo l'update.
    """
    if not uid or uid == "me":
        raise ValueError("uid richiesto per set_prefs")
    update: Dict[str, Any] = {}
    if provider is not None:
        p = provider.lower().strip()
        if p not in ALLOWED_PROVIDERS:
            raise ValueError(f"provider non valido: {provider!r}")
        update["provider"] = p
    if voice_id is not None:
        if not isinstance(voice_id, str) or not voice_id.strip():
            raise ValueError("voice_id deve essere stringa non vuota")
        update["voice_id"] = voice_id.strip()
    if not update:
        return await get_prefs_for_uid(db, uid)
    update["user_id"] = uid
    update["updated_at"] = _dt.datetime.now(_dt.timezone.utc)
    try:
        await db[PREFS_COLLECTION].update_one(
            {"user_id": uid},
            {"$set": update},
            upsert=True,
        )
    except Exception as e:
        log.warning(f"[koda_tts_prefs] set failed uid={uid[:8]}: {e}")
        raise
    return await get_prefs_for_uid(db, uid)


async def clear_prefs_for_uid(db, uid: str) -> None:
    """Reset: torna al default (elevenlabs)."""
    if not uid or uid == "me":
        return
    try:
        await db[PREFS_COLLECTION].delete_one({"user_id": uid})
    except Exception as e:
        log.warning(f"[koda_tts_prefs] clear failed uid={uid[:8]}: {e}")
