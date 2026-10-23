"""
routes/tts_providers.py — Endpoint pubblici per la UI "Voce di Ollenya".
========================================================================

Espone tre endpoint auth-bound:

  GET  /api/tts/catalog
       → Lista voci con nome, genere e disponibilità per provider.

  GET  /api/tts/preferences
       → Preferenza TTS dell'utente autenticato (provider + voice_id).
       → Richiede autenticazione: usa `current_user_id()` dal middleware
         HTTP. Se l'utente è "me" (non autenticato), 401.
       → Un utente NON può leggere le preferenze di altri utenti: il DB
         query si basa SEMPRE sull'uid del middleware, mai da query/body.

  PUT  /api/tts/preferences
       Body JSON: {"provider": "elevenlabs"|"inworld", "voice_id"?: str}
       → Aggiorna la propria preferenza. Un utente può modificare SOLO
         la propria (stesso vincolo di GET).
       → Se il provider non è in ALLOWED_PROVIDERS → 400.

  GET  /api/dev/inworld-tts-health
       → Diagnostica configurazione adapter Inworld (DRY, no API call).
       → Non espone segreti. Utile per debug deploy.

Nessun endpoint fa chiamate API Inworld/ElevenLabs: lavoriamo solo su
preferenze e catalogo. L'auth è quella standard del middleware HTTP.
"""
from __future__ import annotations

import logging
from typing import Optional, Any, Dict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import koda_tts_prefs as _prefs
import koda_voice_catalog as _cat
import inworld_tts as _ad


log = logging.getLogger(__name__)


# =============================================================================
# Router
# =============================================================================
# NOTA: il prefisso /api è aggiunto dal main `api_router` di server.py tramite
# `app.include_router(api_router)`. Qui esponiamo paths relativi al prefix /api,
# quindi `/tts/...` → l'URL finale è `/api/tts/...`.
router = APIRouter()


# =============================================================================
# Modelli
# =============================================================================
class UpdatePrefsBody(BaseModel):
    provider: Optional[str] = None
    voice_id: Optional[str] = None


# =============================================================================
# Dipendenze auth-bound
# =============================================================================
def _require_auth_uid(request: Request) -> str:
    """Estrae uid dal ContextVar impostato dal middleware HTTP di server.py.

    Rifiuta con 401 se l'uid è "me" (non autenticato) — le preferenze
    hanno senso SOLO per utenti autenticati.
    """
    try:
        # Import ritardato per evitare dipendenza circolare con server.py
        import server as _srv  # type: ignore
        uid = _srv.current_user_id()
    except Exception:
        uid = "me"
    if not uid or uid == "me":
        raise HTTPException(status_code=401, detail="autenticazione richiesta")
    return uid


def _get_db(_request: Request):
    """Preleva db handle dal modulo server (motor AsyncIOMotorDatabase).
    `_request` è ignorato ma mantenuto per uniformità firma dei chiamanti.
    """
    import server as _srv  # type: ignore
    return _srv.db


# =============================================================================
# GET /api/tts/catalog  — pubblico (nessun dato utente)
# =============================================================================
@router.get("/tts/catalog")
async def get_tts_catalog() -> Dict[str, Any]:
    """Ritorna il catalogo voci di Ollenya + disponibilità per provider.

    Pubblico: non espone API key né dati utente. Il frontend usa la
    campagna `available_on` per DISABILITARE le voci non disponibili sul
    provider selezionato nella UI (no selezione destinata a fallire).
    """
    return {
        "label": "Voce di Ollenya",
        "default_provider": _prefs.DEFAULT_PROVIDER,
        "allowed_providers": sorted(_prefs.ALLOWED_PROVIDERS),
        "providers_meta": {
            "elevenlabs": {
                "name": "ElevenLabs",
                "description": "Qualità emotiva alta, latenza media.",
            },
            "inworld": {
                "name": "Inworld",
                "description": "Latenza bassa, in fase di valutazione.",
                "model_locked": _ad.INWORLD_MODEL_LOCKED,
            },
        },
        "voices": _cat.list_voices_public(),
    }


# =============================================================================
# GET /api/tts/preferences  — auth-bound
# =============================================================================
@router.get("/tts/preferences")
async def get_my_tts_prefs(request: Request) -> Dict[str, Any]:
    uid = _require_auth_uid(request)
    db = _get_db(request)
    prefs = await _prefs.get_prefs_for_uid(db, uid)
    return {
        "user_id": uid[:8] + "...",  # mai esponiamo l'uid completo nei response
        "provider": prefs.get("provider") or _prefs.DEFAULT_PROVIDER,
        "voice_id": prefs.get("voice_id"),
        "updated_at": prefs.get("updated_at"),
    }


# =============================================================================
# PUT /api/tts/preferences  — auth-bound, modifica SOLO la propria pref
# =============================================================================
@router.put("/tts/preferences")
async def update_my_tts_prefs(
    body: UpdatePrefsBody,
    request: Request,
) -> Dict[str, Any]:
    uid = _require_auth_uid(request)
    db = _get_db(request)

    # Validazioni semantiche
    provider = (body.provider or "").lower().strip() or None
    if provider is not None and provider not in _prefs.ALLOWED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"provider non valido: {provider!r}. Attesi: {sorted(_prefs.ALLOWED_PROVIDERS)}",
        )

    voice_id = (body.voice_id or "").strip() or None
    # Se è stata passata una voice_id, verifica che corrisponda a una voce
    # del catalogo (ElevenLabs voice_id *o* chiave brand) E che sia
    # disponibile sul provider richiesto / corrente.
    if voice_id:
        entry = (
            _cat.find_by_key(voice_id)
            or _cat.find_by_elevenlabs_voice_id(voice_id)
        )
        if not entry:
            raise HTTPException(
                status_code=400,
                detail=f"voice_id sconosciuto: {voice_id!r}",
            )
        # Risolvi provider effettivo per il check availability.
        effective_provider = provider
        if effective_provider is None:
            cur = await _prefs.get_prefs_for_uid(db, uid)
            effective_provider = cur.get("provider") or _prefs.DEFAULT_PROVIDER
        if effective_provider not in entry.available_on:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"La voce '{entry.name}' non è disponibile su "
                    f"'{effective_provider}' in questa fase."
                ),
            )

    try:
        updated = await _prefs.set_prefs_for_uid(
            db, uid, provider=provider, voice_id=voice_id
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.warning(f"[tts_prefs] update failed uid={uid[:8]}: {e}")
        raise HTTPException(status_code=500, detail="update failed")

    return {
        "ok": True,
        "provider": updated.get("provider"),
        "voice_id": updated.get("voice_id"),
        "updated_at": updated.get("updated_at"),
    }


# =============================================================================
# DELETE /api/tts/preferences  — reset al default
# =============================================================================
@router.delete("/tts/preferences")
async def reset_my_tts_prefs(request: Request) -> Dict[str, Any]:
    uid = _require_auth_uid(request)
    db = _get_db(request)
    await _prefs.clear_prefs_for_uid(db, uid)
    return {"ok": True, "provider": _prefs.DEFAULT_PROVIDER, "voice_id": None}


# =============================================================================
# GET /api/dev/inworld-tts-health  — dry diagnostic (no API call, no secrets)
# =============================================================================
@router.get("/dev/inworld-tts-health")
async def inworld_tts_health() -> Dict[str, Any]:
    """Ritorna la configurazione dell'adapter Inworld.

    DRY: zero chiamate HTTP a Inworld, zero esposizione di segreti
    (`api_key_present` è solo bool). Utile per verificare che l'env
    sia agganciato correttamente dopo un deploy.
    """
    return _ad.health_check_config()
