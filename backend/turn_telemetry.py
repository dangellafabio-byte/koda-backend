"""
turn_telemetry.py — Persistenza durevole dei contatori di turno (Fabio 2026-11-04).

Motivazione:
  - Railway Hobby conserva i log applicativi 7 giorni → non basta per il
    consuntivo del test personale fino al 30 novembre.
  - `_LAST_TIMING_SUMMARIES` è un deque in RAM (maxlen=10) → perde quasi tutto.
  - Serve una traccia DB per utente/turno con token, cache, output, TTS, path.

Contratto esplicito: MISSING ≠ ZERO.
  - Un conteggio a 0 (int) significa "zero misurato".
  - `None` significa "non disponibile" (es. TTS cancellato prima di produrre
    output, o chars non ritornati dal provider).
  La differenza serve nei consuntivi: distinguere "0 chars pronunciati" da
  "chars non pervenuti al calcolatore".

Design:
  - Collection MongoDB `koda_turn_telemetry` (singolo documento per turno).
  - Scrittura fire-and-forget con `record_turn_telemetry(db, event)`
    → se la scrittura fallisce (DB down, latenza), log WARNING e CONTINUA.
    NON blocca mai il flow utente.
  - Nessuna chiamata LLM aggiunta. Nessun contenuto personale testuale
    conservato (solo lunghezze/token/chars, mai `reply` o `user_payload`).
  - Idempotenza sui turni per `turn_id`: upsert con `$set` → riscrivere
    con gli stessi dati non duplica.
  - Idempotenza sui segmenti TTS: upsert in `koda_tts_segments` chiavato
    su `segment_id` (UUID generato dal chiamante PRIMA di avviare il TTS).
    Retry/cancel generano nuovi segment_id (non lo stesso UUID), così si
    conservano tutti i tentativi e il consuntivo è completo.

Schema documento `koda_turn_telemetry`:
    {
        turn_id, user_id, created_at (UTC), model, path, is_main_turn,
        tokens_input_fresh | None,
        tokens_cache_read  | None,
        tokens_cache_write | None,
        tokens_output      | None,
        usage_source,  # 'proxy' | 'tiktoken' | 'unknown'
        error, retry_count,
    }

Schema documento `koda_tts_segments` (uno PER CHIAMATA al provider TTS):
    {
        segment_id (UUID, chiave unica),
        turn_id, user_id, created_at (UTC),
        provider,            # 'elevenlabs' | 'inworld' | None
        model | None,        # es. 'inworld-tts-2-flash'
        rate_source,         # vedi inworld_tts._rate_source()
        chars_billed | None, # int o None (missing ≠ 0)
        audio_ms     | None,
        outcome,             # 'ok' | 'failed' | 'cancelled'
        attempt,             # 1-based; retries creano nuovi segment_id
        error | None,
        estimated_cost_usd | None,  # SOLO stima da _rate_source() non 'verified'
    }

Export:
  - `/api/admin/turn-telemetry/export` restituisce il JOIN turno+segmenti.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

COLLECTION_TURNS = "koda_turn_telemetry"
COLLECTION_TTS_SEGMENTS = "koda_tts_segments"

_ALLOWED_TOP_KEYS = {
    "turn_id", "user_id", "created_at", "model", "path", "is_main_turn",
    "tokens_input_fresh", "tokens_cache_read", "tokens_cache_write",
    "tokens_output", "usage_source", "error", "retry_count",
}

_ALLOWED_TTS_SEGMENT_KEYS = {
    "segment_id", "turn_id", "user_id", "created_at",
    "provider", "model", "rate_source",
    "chars_billed", "audio_ms", "outcome", "attempt",
    "error", "estimated_cost_usd",
}

_ALLOWED_PATHS = {
    "fast_voice", "converse_stream", "converse_text",
    "safety_classify", "intro_gender", "recap", "ghost", "probe",
}

_ALLOWED_OUTCOMES = {"ok", "failed", "cancelled"}


def _coerce_int_or_none(v: Any) -> Optional[int]:
    """Rispetta il contratto missing ≠ zero.
      - None → None (missing)
      - int, float, str numerico → int
      - stringhe non parsabili → None (preferiamo missing a 0 forzato)
    """
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _sanitize_turn(event: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {k: v for k, v in event.items() if k in _ALLOWED_TOP_KEYS}
    if "path" in out and out["path"] not in _ALLOWED_PATHS:
        logger.warning(f"[turn_telemetry] path non valido '{out['path']}' → unknown")
        out["path"] = "unknown"
    if "created_at" not in out:
        out["created_at"] = datetime.now(timezone.utc)
    for k in ("tokens_input_fresh", "tokens_cache_read",
              "tokens_cache_write", "tokens_output"):
        if k in out:
            out[k] = _coerce_int_or_none(out[k])
    # retry_count è sempre un int (0 default valido).
    try:
        out["retry_count"] = int(out.get("retry_count") or 0)
    except (TypeError, ValueError):
        out["retry_count"] = 0
    return out


def _sanitize_segment(seg: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {k: v for k, v in seg.items() if k in _ALLOWED_TTS_SEGMENT_KEYS}
    if "created_at" not in out:
        out["created_at"] = datetime.now(timezone.utc)
    if out.get("outcome") not in _ALLOWED_OUTCOMES:
        logger.warning(f"[turn_telemetry] outcome non valido '{out.get('outcome')}' → failed")
        out["outcome"] = "failed"
    for k in ("chars_billed", "audio_ms"):
        if k in out:
            out[k] = _coerce_int_or_none(out[k])
    try:
        out["attempt"] = int(out.get("attempt") or 1)
    except (TypeError, ValueError):
        out["attempt"] = 1
    return out


async def record_turn_telemetry(db: Any, event: Dict[str, Any]) -> bool:
    if db is None:
        return False
    try:
        doc = _sanitize_turn(event)
    except Exception as e:
        logger.warning(f"[turn_telemetry] sanitize_turn failed: {e!r}")
        return False
    turn_id = doc.get("turn_id")
    if not turn_id:
        logger.warning("[turn_telemetry] missing turn_id → skip")
        return False
    try:
        await db[COLLECTION_TURNS].update_one(
            {"turn_id": turn_id},
            {"$set": doc},
            upsert=True,
        )
        return True
    except Exception as e:
        logger.warning(f"[turn_telemetry] insert turn failed {turn_id[:8]}: {e!r}")
        return False


async def record_tts_segment(db: Any, segment: Dict[str, Any]) -> bool:
    """Scrive (upsert su `segment_id`) un segmento TTS.

    Chiavi obbligatorie: segment_id, turn_id, outcome.
    Idempotente: chiamarla 2 volte con stesso segment_id non duplica.
    I retry devono generare segment_id DIVERSI (nuovo UUID).
    """
    if db is None:
        return False
    try:
        doc = _sanitize_segment(segment)
    except Exception as e:
        logger.warning(f"[turn_telemetry] sanitize_segment failed: {e!r}")
        return False
    seg_id = doc.get("segment_id")
    if not seg_id or not doc.get("turn_id"):
        logger.warning("[turn_telemetry] missing segment_id/turn_id → skip")
        return False
    try:
        await db[COLLECTION_TTS_SEGMENTS].update_one(
            {"segment_id": seg_id},
            {"$set": doc},
            upsert=True,
        )
        return True
    except Exception as e:
        logger.warning(
            f"[turn_telemetry] insert segment failed seg={seg_id[:8]} "
            f"turn={doc.get('turn_id', '')[:8]}: {e!r}"
        )
        return False


async def ensure_indexes(db: Any) -> None:
    if db is None:
        return
    try:
        await db[COLLECTION_TURNS].create_index("turn_id", unique=True)
        await db[COLLECTION_TURNS].create_index([("user_id", 1), ("created_at", -1)])
        await db[COLLECTION_TURNS].create_index("created_at")
        await db[COLLECTION_TTS_SEGMENTS].create_index("segment_id", unique=True)
        await db[COLLECTION_TTS_SEGMENTS].create_index("turn_id")
        await db[COLLECTION_TTS_SEGMENTS].create_index([("user_id", 1), ("created_at", -1)])
    except Exception as e:
        logger.warning(f"[turn_telemetry] ensure_indexes failed: {e!r}")


async def export_range(
    db: Any,
    *,
    from_dt: Optional[datetime] = None,
    to_dt: Optional[datetime] = None,
    user_id: Optional[str] = None,
    limit: int = 10000,
) -> List[Dict[str, Any]]:
    """Legge i turni nel range + arricchisce con i segmenti TTS (lookup
    per `turn_id`). Ritorna lista di dict con shape:

        {
            ...turn fields...,
            tts_segments: [ {segment_id, outcome, ...}, ... ],
            tts_totals: {
                chars_billed_sum: int | None,
                audio_ms_sum:     int | None,
                segments_ok: int, segments_failed: int, segments_cancelled: int,
            }
        }
    """
    if db is None:
        return []
    q: Dict[str, Any] = {}
    if from_dt or to_dt:
        q["created_at"] = {}
        if from_dt:
            q["created_at"]["$gte"] = from_dt
        if to_dt:
            q["created_at"]["$lte"] = to_dt
    if user_id:
        q["user_id"] = user_id
    try:
        turns = [t async for t in db[COLLECTION_TURNS].find(q).sort("created_at", 1).limit(int(limit))]
    except Exception as e:
        logger.warning(f"[turn_telemetry] export_range turns failed: {e!r}")
        return []
    if not turns:
        return []
    turn_ids = [t["turn_id"] for t in turns if t.get("turn_id")]
    try:
        segs = [s async for s in db[COLLECTION_TTS_SEGMENTS].find(
            {"turn_id": {"$in": turn_ids}}
        )]
    except Exception as e:
        logger.warning(f"[turn_telemetry] export_range segments failed: {e!r}")
        segs = []
    by_turn: Dict[str, List[Dict[str, Any]]] = {}
    for s in segs:
        by_turn.setdefault(s.get("turn_id"), []).append(s)
    out: List[Dict[str, Any]] = []
    for t in turns:
        tid = t.get("turn_id")
        tsegs = by_turn.get(tid, [])
        chars_values = [s.get("chars_billed") for s in tsegs if s.get("chars_billed") is not None]
        ms_values = [s.get("audio_ms") for s in tsegs if s.get("audio_ms") is not None]
        totals = {
            "chars_billed_sum": sum(chars_values) if chars_values else None,
            "audio_ms_sum": sum(ms_values) if ms_values else None,
            "segments_ok": sum(1 for s in tsegs if s.get("outcome") == "ok"),
            "segments_failed": sum(1 for s in tsegs if s.get("outcome") == "failed"),
            "segments_cancelled": sum(1 for s in tsegs if s.get("outcome") == "cancelled"),
        }
        t = dict(t)
        t["tts_segments"] = tsegs
        t["tts_totals"] = totals
        out.append(t)
    return out
