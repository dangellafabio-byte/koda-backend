"""
observability.py — Inizializzazione Sentry per il backend Koda (FastAPI on Railway)

Region: EU (Frankfurt) — enforced dal DSN dell'organizzazione EU.
Sample rates: errori 100%, performance 20% (aligned col frontend).

Env vars richieste:
  SENTRY_DSN_BACKEND — DSN progetto koda-backend (separato dal frontend)
  ENVIRONMENT — "production" (Railway) / "development" (local)

Chiamare init_sentry() UNA SOLA VOLTA all'avvio di server.py, PRIMA di
qualunque altro import che possa emettere errori.

Privacy: before_send scrubba STT transcripts, TTS content, testo utente.
"""

from __future__ import annotations

import os
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Chiavi che potrebbero contenere testo utente / transcript / TTS
_SENSITIVE_KEY_PATTERNS = [
    "transcript",
    "stt_text",
    "user_text",
    "utterance",
    "tts_content",
    "tts_text",
    "dialogue",
    "conversation",
    "message_text",
    "sentence",
    "content",
    "koda_reply",
    "user_input",
    "prompt",
    "system_prompt",
    "claude_response",
    "reply_text",
]

_PII_USER_KEYS = ("email", "username", "name", "ip_address", "phone", "address")


def _is_sensitive_key(key: str) -> bool:
    lower = key.lower()
    return any(p in lower for p in _SENSITIVE_KEY_PATTERNS)


def _scrub_text_fields(obj: Any, depth: int = 0) -> Any:
    if depth > 10:
        return "[scrubbed_deep_nested]"
    if obj is None:
        return None
    if isinstance(obj, str):
        if len(obj) > 200:
            return "[scrubbed_long_string]"
        return obj
    if isinstance(obj, (int, float, bool)):
        return obj
    if isinstance(obj, list):
        return [_scrub_text_fields(x, depth + 1) for x in obj]
    if isinstance(obj, dict):
        scrubbed: Dict[str, Any] = {}
        for key, value in obj.items():
            if not isinstance(key, str):
                scrubbed[str(key)] = _scrub_text_fields(value, depth + 1)
                continue
            if _is_sensitive_key(key):
                scrubbed[key] = "[scrubbed]"
                continue
            if isinstance(value, str) and len(value) > 200:
                scrubbed[key] = "[scrubbed_long_string]"
            else:
                scrubbed[key] = _scrub_text_fields(value, depth + 1)
        return scrubbed
    # Fallback per tipi non gestibili (bytes, custom classes...)
    return str(type(obj).__name__)


def _scrub_user(user: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not user:
        return user
    # Mantieni SOLO l'id se presente (assunto già hashato)
    scrubbed: Dict[str, Any] = {}
    if user.get("id"):
        scrubbed["id"] = user["id"]
    for pii_key in _PII_USER_KEYS:
        user.pop(pii_key, None)
    return scrubbed


def _before_send(event: Dict[str, Any], hint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Scrubbing critico prima di inviare l'evento a Sentry.
    Restituire None droppa l'evento (safety net contro leak accidentali).
    """
    try:
        # 1. User: pulisci PII, mantieni solo id hashato
        if "user" in event:
            event["user"] = _scrub_user(event["user"])

        # 2. Contexts, extra, request: scrubbing profondo
        for field in ("contexts", "extra", "request"):
            if field in event:
                event[field] = _scrub_text_fields(event[field])

        # 3. Message: se contiene testo lungo, sostituisci
        if "message" in event and isinstance(event["message"], str):
            if len(event["message"]) > 100:
                event["message"] = "[scrubbed_long_message]"

        # 4. Exception values: mantieni tipo, pulisci value se troppo lungo
        if "exception" in event and "values" in event["exception"]:
            for ex in event["exception"]["values"]:
                if isinstance(ex.get("value"), str) and len(ex["value"]) > 200:
                    ex["value"] = "[scrubbed_exception_value]"

        # 5. Logentry (Python logging captured)
        if "logentry" in event:
            entry = event["logentry"]
            if isinstance(entry.get("message"), str) and len(entry["message"]) > 200:
                entry["message"] = "[scrubbed_log_message]"
            if "params" in entry:
                entry["params"] = _scrub_text_fields(entry["params"])

        # 6. Tags: rimuovi eventuali tag con chiave sensibile
        if "tags" in event and isinstance(event["tags"], dict):
            event["tags"] = {
                k: v for k, v in event["tags"].items() if not _is_sensitive_key(k)
            }

        # 7. Breadcrumbs (già limitati ma per sicurezza)
        if "breadcrumbs" in event and isinstance(event["breadcrumbs"], dict):
            values = event["breadcrumbs"].get("values", [])
            for bc in values:
                if isinstance(bc, dict):
                    if "data" in bc:
                        bc["data"] = _scrub_text_fields(bc["data"])
                    if isinstance(bc.get("message"), str) and len(bc["message"]) > 200:
                        bc["message"] = "[scrubbed_breadcrumb]"

        return event
    except Exception as err:  # noqa: BLE001
        logger.warning("[Sentry] before_send scrubber failed: %s", err)
        # Se lo scrubber fallisce, DROPPA l'evento (fail-closed per privacy)
        return None


_sentry_initialized = False


def init_sentry() -> bool:
    """
    Inizializza Sentry per il backend FastAPI di Koda.
    Idempotente: safe chiamare più volte.
    Ritorna True se inizializzato con successo, False altrimenti.
    """
    global _sentry_initialized
    if _sentry_initialized:
        return True

    dsn = os.getenv("SENTRY_DSN_BACKEND") or os.getenv("SENTRY_DSN") or ""
    if not dsn:
        logger.warning("[Sentry] SENTRY_DSN_BACKEND non impostato — crash reporting DISABILITATO")
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError as err:
        logger.warning("[Sentry] sentry-sdk non installato: %s", err)
        return False

    environment = os.getenv("ENVIRONMENT") or (
        "production" if os.getenv("RAILWAY_ENVIRONMENT") else "development"
    )

    # Release tag — matcha il release del frontend per correlazione cross-layer
    release = os.getenv("KODA_RELEASE") or os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown")[:8]

    try:
        sentry_sdk.init(
            dsn=dsn,
            # === Privacy: NIENTE PII automatico ===
            send_default_pii=False,
            # === Sampling: 100% errori, 20% performance ===
            sample_rate=1.0,
            traces_sample_rate=0.2,
            # === Release / environment ===
            release=f"koda-backend@{release}",
            environment=environment,
            # === Integrations ===
            integrations=[
                StarletteIntegration(
                    transaction_style="endpoint",
                    failed_request_status_codes={500, 501, 502, 503, 504, 505},
                ),
                FastApiIntegration(
                    transaction_style="endpoint",
                    failed_request_status_codes={500, 501, 502, 503, 504, 505},
                ),
                LoggingIntegration(
                    level=logging.INFO,       # capture INFO+ come breadcrumb
                    event_level=logging.ERROR,  # invia ERROR+ come event
                ),
            ],
            # === Privacy hook — CRITICO ===
            before_send=_before_send,
            # === Ignora eccezioni "attese" (client disconnessi, etc.) ===
            ignore_errors=[
                "WebSocketDisconnect",
                "ConnectionResetError",
                "ClientDisconnect",
            ],
            # Tag utili globali
            _experiments={},
        )
        # Tag globali
        sentry_sdk.set_tag("service", "koda-backend")
        sentry_sdk.set_tag("runtime", "railway")
        _sentry_initialized = True
        logger.info("[Sentry] backend initialized ✓ (env=%s, release=%s)", environment, release)
        return True
    except Exception as err:  # noqa: BLE001
        logger.warning("[Sentry] init failed: %s", err)
        return False


def set_sentry_user_context(hashed_user_id: Optional[str], **extra_tags: Any) -> None:
    """
    Imposta contesto utente ANONIMIZZATO per la request corrente.
    hashed_user_id: id già hashato (sha256), MAI email/username plaintext.
    """
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk
        if hashed_user_id:
            sentry_sdk.set_user({"id": hashed_user_id})
        else:
            sentry_sdk.set_user(None)
        for key, value in extra_tags.items():
            if not _is_sensitive_key(key):
                sentry_sdk.set_tag(key, str(value))
    except Exception:  # noqa: BLE001
        pass


def capture_koda_exception(
    exc: Exception,
    category: Optional[str] = None,
    **extra: Any,
) -> None:
    """Cattura eccezione con contesto Koda-specific (safe, viene comunque scrubbato)."""
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            if category:
                scope.set_tag("koda_error_category", category)
            if extra:
                scope.set_context("koda_context", extra)
            sentry_sdk.capture_exception(exc)
    except Exception:  # noqa: BLE001
        pass
