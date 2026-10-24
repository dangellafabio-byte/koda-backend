"""
koda_tts_prefs — preferenze TTS provider per utente (dev A/B).
===============================================================

Collection ``koda_tts_provider_prefs`` SEPARATA dal profilo utente così
l'A/B test:
 * non impatta lo schema ``taccuino_profile`` esistente
 * resta nascosta agli utenti non whitelistati
 * si può cancellare in blocco con un drop collection quando il test chiude

Due operazioni:
 * ``get_provider_for_uid(db, uid) -> "elevenlabs" | "inworld"``
   — default "elevenlabs" se nessun doc. Il resolver fa anche doppio
     controllo whitelist (defense in depth): se un utente NON autorizzato
     per qualche ragione avesse un doc con ``inworld``, il resolver
     restituisce comunque ``elevenlabs``.
 * ``consume_switch_token(db, uid, token) -> {provider, consumed}``
   — i token sono rilasciati da ``issue_switch_token`` con TTL 10 min,
     uso unico, nessuna chiave API al loro interno.

MAI loggato il token nel chiaro.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import logging
import secrets
from typing import Optional, Dict, Any

log = logging.getLogger(__name__)


PREFS_COLLECTION = "koda_tts_provider_prefs"
TOKENS_COLLECTION = "koda_tts_switch_tokens"

ALLOWED_PROVIDERS = frozenset({"elevenlabs", "inworld"})
DEFAULT_PROVIDER = "elevenlabs"

# TTL dei token one-shot (minuti). Volontariamente breve.
TOKEN_TTL_MINUTES = 10


# =============================================================================
# Indici
# =============================================================================
async def ensure_indexes(db) -> None:
    try:
        await db[PREFS_COLLECTION].create_index("user_id", unique=True)
    except Exception as e:
        log.warning(f"[koda_tts_prefs] prefs index failed: {e}")
    try:
        await db[TOKENS_COLLECTION].create_index("token_hash", unique=True)
        # TTL su expires_at per auto-cleanup
        await db[TOKENS_COLLECTION].create_index(
            "expires_at", expireAfterSeconds=0
        )
    except Exception as e:
        log.warning(f"[koda_tts_prefs] tokens index failed: {e}")


# =============================================================================
# Preferenza utente
# =============================================================================
async def get_provider_for_uid(db, uid: str,
                               allowed_emails: Optional[frozenset[str]] = None,
                               email: Optional[str] = None) -> str:
    """Risolve il provider per un uid. **Default elevenlabs** sempre.

    Fonte di verità: il doc in ``koda_tts_provider_prefs``. L'allow-list
    email è già enforced una volta al momento dell'activate (vedi
    ``_require_inworld_ab_test_user`` in server.py): il doc può esistere
    SOLO se l'utente era whitelisted al momento dello switch. Ri-controllare
    la whitelist ad ogni call runtime era defense-in-depth che richiede
    la risoluzione dell'email — info che il resolver runtime non ha
    sempre disponibile (vedi bug 2026-10 Fabio: `_uid_email_from_session_or_profile`
    non leggeva dalle sessions → forzava fallback a elevenlabs anche con
    pref valida).

    I parametri ``allowed_emails`` / ``email`` sono mantenuti per
    retrocompatibilità ma NON più usati per il gating. Se un utente
    viene rimosso dalla hardcoded allow-list A/B, basta eliminare la
    riga dalla collezione ``koda_tts_provider_prefs``.
    """
    if not uid:
        return DEFAULT_PROVIDER
    try:
        doc = await db[PREFS_COLLECTION].find_one({"user_id": uid})
    except Exception as e:
        log.warning(f"[koda_tts_prefs] read failed uid={uid[:8]}: {e}")
        return DEFAULT_PROVIDER
    if not doc:
        return DEFAULT_PROVIDER
    provider = (doc.get("provider") or DEFAULT_PROVIDER).lower()
    if provider not in ALLOWED_PROVIDERS:
        return DEFAULT_PROVIDER
    return provider


async def set_provider_for_uid(db, uid: str, provider: str) -> None:
    """Setta/aggiorna la preferenza per un uid. Non controlla la
    whitelist (il controllo sta nel chiamante consume_switch_token)."""
    if provider not in ALLOWED_PROVIDERS:
        raise ValueError(f"provider non valido: {provider!r}")
    try:
        await db[PREFS_COLLECTION].update_one(
            {"user_id": uid},
            {"$set": {
                "user_id": uid,
                "provider": provider,
                "updated_at": _dt.datetime.now(_dt.timezone.utc),
            }},
            upsert=True,
        )
    except Exception as e:
        log.warning(f"[koda_tts_prefs] set failed uid={uid[:8]}: {e}")
        raise


async def clear_provider_for_uid(db, uid: str) -> None:
    """Rimuove la preferenza (ritorna a elevenlabs default)."""
    try:
        await db[PREFS_COLLECTION].delete_one({"user_id": uid})
    except Exception as e:
        log.warning(f"[koda_tts_prefs] clear failed uid={uid[:8]}: {e}")


# =============================================================================
# Preferenze estese {provider, voice_id} — wrapper 2026-10 (Fabio)
# =============================================================================
# Richieste dalla UI pubblica "Voce di Ollenya" che esponiamo tramite
# ``/api/tts/catalog`` + ``/api/tts/preferences``. Fusione lato DB: UNA
# sola collezione (PREFS_COLLECTION) con lo schema esteso
# ``{user_id, provider, voice_id, updated_at}``. ``voice_id`` è
# BACKWARD COMPATIBLE (null-safe) → i reader che leggono solo
# ``provider`` continuano a funzionare.
async def get_prefs_for_uid(db, uid: str) -> Dict[str, Any]:
    """Ritorna ``{provider: str, voice_id: Optional[str], updated_at: dt}``.

    Default elevenlabs + voice_id=None se il doc non esiste o è
    inconsistente.
    """
    out: Dict[str, Any] = {
        "provider": DEFAULT_PROVIDER,
        "voice_id": None,
        "updated_at": None,
    }
    if not uid:
        return out
    try:
        doc = await db[PREFS_COLLECTION].find_one({"user_id": uid})
    except Exception as e:
        log.warning(f"[koda_tts_prefs] get_prefs read failed uid={uid[:8]}: {e}")
        return out
    if not doc:
        return out
    p = (doc.get("provider") or DEFAULT_PROVIDER).lower()
    if p in ALLOWED_PROVIDERS:
        out["provider"] = p
    v = doc.get("voice_id")
    out["voice_id"] = v if isinstance(v, str) and v else None
    out["updated_at"] = doc.get("updated_at")
    return out


async def set_prefs_for_uid(
    db,
    uid: str,
    *,
    provider: Optional[str] = None,
    voice_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Upsert di provider e/o voice_id. Ritorna lo stato finale.

    Se ``provider`` None → non lo tocca (idem per ``voice_id``).
    Se ``voice_id`` è stringa vuota → lo rimuove (set None).
    """
    if provider is not None:
        provider = (provider or "").lower().strip()
        if provider not in ALLOWED_PROVIDERS:
            raise ValueError(f"provider non valido: {provider!r}")
    set_fields: Dict[str, Any] = {
        "user_id": uid,
        "updated_at": _dt.datetime.now(_dt.timezone.utc),
    }
    if provider is not None:
        set_fields["provider"] = provider
    unset_fields: Dict[str, Any] = {}
    if voice_id is not None:
        v = (voice_id or "").strip()
        if v:
            set_fields["voice_id"] = v
        else:
            unset_fields["voice_id"] = ""
    update_op: Dict[str, Any] = {"$set": set_fields}
    if unset_fields:
        update_op["$unset"] = unset_fields
    try:
        await db[PREFS_COLLECTION].update_one(
            {"user_id": uid}, update_op, upsert=True
        )
    except Exception as e:
        log.warning(f"[koda_tts_prefs] set_prefs failed uid={uid[:8]}: {e}")
        raise
    return await get_prefs_for_uid(db, uid)


async def clear_prefs_for_uid(db, uid: str) -> None:
    """Alias di ``clear_provider_for_uid``: rimuove tutta la riga pref."""
    await clear_provider_for_uid(db, uid)


# =============================================================================
# Token monouso
# =============================================================================
def _hash_token(token: str) -> str:
    """Hash SHA-256 del token. Mai salviamo il token nel chiaro."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def issue_switch_token(db, uid: str, provider: str) -> dict:
    """Rilascia un token monouso per attivare un provider.

    Il token è una stringa short URL-safe (≥22 char). Scade dopo
    ``TOKEN_TTL_MINUTES`` e dopo la prima activate. Non contiene chiavi
    API: è solo un segreto da passare al client via chat sicura.
    """
    if provider not in ALLOWED_PROVIDERS:
        raise ValueError(f"provider non valido: {provider!r}")
    token = secrets.token_urlsafe(24)
    th = _hash_token(token)
    now = _dt.datetime.now(_dt.timezone.utc)
    exp = now + _dt.timedelta(minutes=TOKEN_TTL_MINUTES)
    try:
        await db[TOKENS_COLLECTION].insert_one({
            "token_hash": th,
            "user_id": uid,
            "provider": provider,
            "issued_at": now,
            "expires_at": exp,
            "consumed_at": None,
        })
    except Exception as e:
        log.warning(f"[koda_tts_prefs] token insert failed: {e}")
        raise
    return {
        "token": token,
        "provider": provider,
        "expires_at": exp.isoformat(),
        "ttl_minutes": TOKEN_TTL_MINUTES,
    }


async def consume_switch_token(db, uid: str, token: str) -> dict:
    """Consuma un token monouso. Verifica binding uid + scadenza + non
    già consumato. Se OK → aggiorna la preferenza utente e ritorna il
    provider attivato.

    Mai logga il token raw.

    Returns:
        dict con ``{provider, activated_at}``.

    Raises:
        ``ValueError`` con una ragione testuale breve (non il token):
        ``"invalid"`` | ``"expired"`` | ``"used"`` | ``"uid_mismatch"``.
    """
    if not token or not isinstance(token, str) or len(token) < 10:
        raise ValueError("invalid")
    th = _hash_token(token)
    doc = await db[TOKENS_COLLECTION].find_one({"token_hash": th})
    if not doc:
        raise ValueError("invalid")

    now = _dt.datetime.now(_dt.timezone.utc)
    exp = doc.get("expires_at")
    if exp is not None and getattr(exp, "tzinfo", None) is None:
        exp = exp.replace(tzinfo=_dt.timezone.utc)
    if exp is not None and exp < now:
        raise ValueError("expired")
    if doc.get("consumed_at") is not None:
        raise ValueError("used")
    if doc.get("user_id") != uid:
        raise ValueError("uid_mismatch")

    provider = doc.get("provider", DEFAULT_PROVIDER)
    # Atomic update: marca come consumed + setta pref — se la pref update
    # fallisce, il token resta non-consumed (riprovabile).
    res = await db[TOKENS_COLLECTION].update_one(
        {"token_hash": th, "consumed_at": None},
        {"$set": {"consumed_at": now}},
    )
    if res.modified_count == 0:
        # Qualcuno l'ha consumato tra la find e l'update (race)
        raise ValueError("used")

    await set_provider_for_uid(db, uid, provider)
    return {
        "provider": provider,
        "activated_at": now.isoformat(),
    }


# =============================================================================
# Helpers di comodo per il dispatcher
# =============================================================================
# Voice IDs ElevenLabs — queste sono le "voci Vento" (maschile) che NON
# sono disponibili con provider=inworld in questa fase (fase 1, solo Cielo).
# Se un utente ha selezionato una di queste voci E provider=inworld →
# il dispatcher solleva InworldVoiceNotAvailable → HTTP 503.
VENTO_VOICE_IDS = frozenset({
    "ll9WG7PDTuyHwgC5MD6g",  # Vento (maschile v4) canonica
    "nPczCjzI2devNBz1zQrb",  # Brian legacy → Vento
    "dJwiFcjz9zW5Pge7G8AG",  # Theo v3 legacy → Vento
})


def is_vento_voice(voice_id: Optional[str]) -> bool:
    if not voice_id:
        return False
    return voice_id in VENTO_VOICE_IDS
