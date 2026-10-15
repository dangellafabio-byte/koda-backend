"""
koda_tts_events — Telemetria TTS unificata (Inworld + ElevenLabs)
=================================================================

Collection MongoDB SEPARATA da ``koda_events``: così la telemetria TTS
può evolvere senza impattare lo schema analytics esistente.

Un documento per **ogni tentativo potenzialmente fatturato** (comprese le
cancellazioni mid-stream, i cache hit, i fallimenti upstream): il campo
``billable`` distingue chiaramente cosa Inworld/ElevenLabs ha fatturato
davvero vs cosa è stato speso solo come connect-only.

**MAI** registriamo il testo sintetizzato: contiene memorie personali.
Registriamo solo la lunghezza e il voice_id/parametri.

**MAI** registriamo l'API key.

Il campo ``played_confirmed`` è ``False`` di default e il frontend può
inviare un ACK esplicito (``PATCH /api/dev/tts-telemetry/{event_id}/ack-play``,
non implementato in questa fase) per confermare che l'audio ha davvero
suonato in output. Finché non arriva l'ACK, l'audio è considerato
"servito" ma NON "riprodotto".
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
from typing import Any, Optional

from pydantic import BaseModel, Field


log = logging.getLogger(__name__)


COLLECTION_NAME = "koda_tts_events"


# =============================================================================
# Schema
# =============================================================================
class KodaTTSEvent(BaseModel):
    """Record singolo di una generazione TTS.

    Pydantic model usato SOLO per validation + serialization (dict →
    insert_one). Non è un ODM: non ha metodi di persistenza.
    """

    # === Identità ===
    event_id: str = Field(..., description="UUID generato dal chiamante")
    user_id: str = Field(..., description="uid utente")

    # === Provider ===
    provider_requested: str = Field(
        ..., description='Provider richiesto dal dispatcher: "elevenlabs" | "inworld"'
    )
    provider_actual: str = Field(
        ..., description="Provider effettivamente usato per generare l'audio"
    )
    # Serve per catturare mismatch (es: provider_requested=inworld ma la
    # chiamata è caduta su cache preparata con ElevenLabs). Il frontend
    # non può mai assumere l'uno = l'altro.

    # === Endpoint di origine ===
    endpoint: str = Field(
        ...,
        description=(
            'Nome logico del punto di ingresso: "api_tts" | "api_tts_stream" | '
            '"api_tts_bridge" | "api_tts_prepare" | "_do_tts_fast_pipeline" | '
            '"_stream_tts_for_sentence" | "_do_tts_didnt_hear" | '
            '"inworld_adapter_selftest" | "static_asset_bundle"'
        ),
    )
    mode: str = Field(
        ..., description='"streaming" | "non_streaming" | "cache_hit" | "static_bundle"'
    )

    # === Parametri vocali ===
    voice_id: Optional[str] = None
    model_id: Optional[str] = None
    language: Optional[str] = None
    speaking_rate: Optional[float] = None
    delivery_mode: Optional[str] = None  # Inworld only
    tone: Optional[str] = None  # ElevenLabs only

    # === Caratteri + costo ===
    chars_sent: int = Field(..., ge=0)
    chars_billed: Optional[int] = Field(
        None, ge=0, description="Char effettivamente fatturati dal provider (se riportati)"
    )
    rate_per_1m_chars_usd: float = Field(..., ge=0.0)
    estimated_cost_usd: float = Field(..., ge=0.0)
    billable: bool = Field(
        ..., description="True se questa call conta ai fini della fattura provider"
    )

    # === Timing ===
    api_duration_ms: int = Field(
        ..., ge=0, description="Tempo totale della chiamata HTTP upstream"
    )
    first_chunk_ms: Optional[int] = Field(
        None, ge=0,
        description="TTFB sul primo chunk MP3 utile (solo streaming)"
    )
    audio_duration_ms: Optional[int] = Field(
        None, ge=0,
        description=(
            "Durata effettiva dell'audio generato in millisecondi. "
            "STIMATA dai bytes se non riportata dal provider. Distinta da "
            "api_duration_ms."
        ),
    )

    # === Audio volume ===
    audio_bytes: int = Field(..., ge=0)
    chunks_count: Optional[int] = Field(
        None, ge=0, description="Numero di chunk MP3 yielded (solo streaming)"
    )

    # === Retry/attempts ===
    attempts: int = Field(
        default=1, ge=1,
        description="Quanti tentativi questa event ha causato (noi non facciamo "
                    "retry automatici: resta ≥1 se il dispatcher ne fa manuali)"
    )

    # === Outcome ===
    outcome: str = Field(
        ..., description='"ok" | "cancelled" | "error" | "cache_hit"'
    )
    error_class: Optional[str] = Field(
        None, description="Classe dell'errore (es: InworldTTSTimeoutError)"
    )
    # Breve messaggio succinto, MAI contenente il testo sintetizzato.
    error_message_short: Optional[str] = None

    # === Flussi downstream ===
    served_bytes_to_client: int = Field(
        default=0, ge=0,
        description="Byte effettivamente inviati al client HTTP (post-cancel inclusi)"
    )
    played_confirmed: bool = Field(
        default=False,
        description="ACK esplicito del frontend che l'audio è stato riprodotto"
    )

    # === Request tracing ===
    upstream_request_id: Optional[str] = None  # x-inworld-request-id | x-request-id
    http_status: Optional[int] = None

    # === Metadati ===
    ts: _dt.datetime = Field(default_factory=lambda: _dt.datetime.now(_dt.timezone.utc))

    class Config:
        extra = "forbid"
        # Disabilita il protected namespace "model_" per permettere il
        # campo ``model_id`` senza warning (è il nome ufficiale del
        # parametro Inworld e ElevenLabs).
        protected_namespaces = ()


# =============================================================================
# Indici
# =============================================================================
async def ensure_indexes(db) -> None:
    """Crea gli indici MongoDB necessari (idempotente)."""
    try:
        coll = db[COLLECTION_NAME]
        await coll.create_index("event_id", unique=True)
        await coll.create_index([("user_id", 1), ("ts", -1)])
        await coll.create_index([("provider_actual", 1), ("ts", -1)])
        await coll.create_index([("endpoint", 1), ("ts", -1)])
        await coll.create_index("ts")
    except Exception as e:
        log.warning(f"[koda_tts_events] ensure_indexes failed: {e}")


# =============================================================================
# Insert helper
# =============================================================================
async def record_tts_event(db, event: KodaTTSEvent) -> None:
    """Insert idempotente di un record TTS. Non solleva in caso di
    errore DB (telemetria non deve mai bloccare il playback)."""
    try:
        doc = event.model_dump(mode="json")
        # Convert ISO string back to datetime for proper MongoDB storage
        if isinstance(doc.get("ts"), str):
            try:
                doc["ts"] = _dt.datetime.fromisoformat(doc["ts"].replace("Z", "+00:00"))
            except Exception:
                doc["ts"] = _dt.datetime.now(_dt.timezone.utc)
        await db[COLLECTION_NAME].update_one(
            {"event_id": event.event_id},
            {"$setOnInsert": doc},
            upsert=True,
        )
    except Exception as e:
        log.warning(f"[koda_tts_events] insert failed event_id={event.event_id} err={e}")


async def update_play_ack(db, event_id: str, played: bool) -> bool:
    """Patch per aggiornare ``played_confirmed`` quando il frontend
    conferma la playback effettiva. Ritorna True se ha matchato un
    documento."""
    try:
        res = await db[COLLECTION_NAME].update_one(
            {"event_id": event_id},
            {"$set": {"played_confirmed": bool(played)}},
        )
        return bool(res.matched_count)
    except Exception as e:
        log.warning(f"[koda_tts_events] ack update failed: {e}")
        return False


# =============================================================================
# Query helpers (per endpoint read-only /api/dev/tts-telemetry/*)
# =============================================================================
async def recent_events(db, *, user_id: Optional[str] = None,
                        limit: int = 50) -> list[dict]:
    q: dict[str, Any] = {}
    if user_id:
        q["user_id"] = user_id
    try:
        cur = db[COLLECTION_NAME].find(q).sort("ts", -1).limit(max(1, min(limit, 500)))
        rows = []
        async for doc in cur:
            doc["_id"] = str(doc["_id"])
            if isinstance(doc.get("ts"), _dt.datetime):
                doc["ts"] = doc["ts"].isoformat()
            rows.append(doc)
        return rows
    except Exception as e:
        log.warning(f"[koda_tts_events] recent query failed: {e}")
        return []


async def summary_by_provider(db, *, user_id: Optional[str] = None,
                              since_hours: int = 24) -> dict:
    """Aggregazione: totali per provider_actual nelle ultime N ore.

    Ritorna breakdown separato per Inworld e ElevenLabs con
    totali di caratteri, costo, latenze medie e p95 (p95 calcolato
    client-side per semplicità).
    """
    since = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=since_hours)
    match: dict[str, Any] = {"ts": {"$gte": since}}
    if user_id:
        match["user_id"] = user_id

    try:
        pipeline = [
            {"$match": match},
            {"$group": {
                "_id": "$provider_actual",
                "events": {"$sum": 1},
                "events_ok": {"$sum": {"$cond": [{"$eq": ["$outcome", "ok"]}, 1, 0]}},
                "events_cancelled": {"$sum": {"$cond": [{"$eq": ["$outcome", "cancelled"]}, 1, 0]}},
                "events_error": {"$sum": {"$cond": [{"$eq": ["$outcome", "error"]}, 1, 0]}},
                "events_cache_hit": {"$sum": {"$cond": [{"$eq": ["$outcome", "cache_hit"]}, 1, 0]}},
                "chars_sent_sum": {"$sum": "$chars_sent"},
                "chars_billed_sum": {"$sum": {"$ifNull": ["$chars_billed", 0]}},
                "cost_sum_usd": {"$sum": "$estimated_cost_usd"},
                "audio_bytes_sum": {"$sum": "$audio_bytes"},
                "played_confirmed_count": {"$sum": {"$cond": ["$played_confirmed", 1, 0]}},
                "api_durations": {"$push": "$api_duration_ms"},
                "first_chunks": {"$push": "$first_chunk_ms"},
            }},
        ]
        rows = []
        async for d in db[COLLECTION_NAME].aggregate(pipeline):
            durs = sorted(x for x in d.get("api_durations") or [] if isinstance(x, int))
            ttfbs = sorted(x for x in d.get("first_chunks") or [] if isinstance(x, int))
            def _p(lst, p):
                if not lst:
                    return None
                k = max(0, min(len(lst) - 1, int(round(p / 100.0 * (len(lst) - 1)))))
                return lst[k]
            rows.append({
                "provider_actual": d.get("_id"),
                "events": d.get("events", 0),
                "events_ok": d.get("events_ok", 0),
                "events_cancelled": d.get("events_cancelled", 0),
                "events_error": d.get("events_error", 0),
                "events_cache_hit": d.get("events_cache_hit", 0),
                "chars_sent_sum": d.get("chars_sent_sum", 0),
                "chars_billed_sum": d.get("chars_billed_sum", 0),
                "cost_sum_usd": round(d.get("cost_sum_usd", 0.0), 6),
                "audio_bytes_sum": d.get("audio_bytes_sum", 0),
                "played_confirmed_count": d.get("played_confirmed_count", 0),
                "api_duration_ms_p50": _p(durs, 50),
                "api_duration_ms_p95": _p(durs, 95),
                "first_chunk_ms_p50": _p(ttfbs, 50),
                "first_chunk_ms_p95": _p(ttfbs, 95),
            })
        return {
            "since": since.isoformat(),
            "user_id_filter": user_id,
            "providers": rows,
        }
    except Exception as e:
        log.warning(f"[koda_tts_events] summary failed: {e}")
        return {"since": since.isoformat(), "providers": [], "error": "query_failed"}


# =============================================================================
# Helpers di comodo per il dispatcher futuro
# =============================================================================
def estimate_mp3_duration_ms(mp3_bytes: bytes) -> Optional[int]:
    """Stima la durata MP3 (ms) dai frame header. Supporta MPEG1/2 L3.
    Ritorna None se parsing fallisce.
    Replica della logica in /app/memory/scripts/regen_single_clip.py
    (compatta per telemetria)."""
    if not mp3_bytes:
        return None
    try:
        BR_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
        BR_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
        SR_MPEG1 = [44100, 48000, 32000, 0]
        SR_MPEG2 = [22050, 24000, 16000, 0]
        SR_MPEG25 = [11025, 12000, 8000, 0]
        i = 0
        data = mp3_bytes
        if data[:3] == b"ID3":
            s = data[6:10]
            size = ((s[0] & 0x7F) << 21) | ((s[1] & 0x7F) << 14) | \
                   ((s[2] & 0x7F) << 7) | (s[3] & 0x7F)
            i = 10 + size
        total_sec = 0.0
        while i + 4 < len(data):
            if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
                i += 1
                continue
            b2 = data[i + 1]
            b3 = data[i + 2]
            version_id = (b2 >> 3) & 0x03
            layer = (b2 >> 1) & 0x03
            if layer != 1:
                i += 1
                continue
            br_idx = (b3 >> 4) & 0x0F
            sr_idx = (b3 >> 2) & 0x03
            padding = (b3 >> 1) & 0x01
            if version_id == 3:
                br = BR_MPEG1_L3[br_idx] * 1000
                sr = SR_MPEG1[sr_idx]
                spf = 1152
            elif version_id == 2:
                br = BR_MPEG2_L3[br_idx] * 1000
                sr = SR_MPEG2[sr_idx]
                spf = 576
            elif version_id == 0:
                br = BR_MPEG2_L3[br_idx] * 1000
                sr = SR_MPEG25[sr_idx]
                spf = 576
            else:
                i += 1
                continue
            if br == 0 or sr == 0:
                i += 1
                continue
            frame_len = int(144 * br / sr + padding) if version_id == 3 \
                else int(72 * br / sr + padding)
            if frame_len <= 0:
                i += 1
                continue
            total_sec += spf / sr
            i += frame_len
        return int(total_sec * 1000) if total_sec > 0 else None
    except Exception:
        return None
