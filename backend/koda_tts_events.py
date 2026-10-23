"""
koda_tts_events — Telemetria TTS unificata (Inworld + ElevenLabs)
=================================================================

Collection MongoDB SEPARATA da ``koda_events`` così la telemetria TTS
può evolvere senza impattare lo schema analytics esistente.

Un documento per ogni tentativo potenzialmente fatturato (comprese le
cancellazioni mid-stream, i cache hit, i fallimenti upstream): il campo
``billable`` distingue cosa Inworld/ElevenLabs ha fatturato davvero vs
cosa è stato speso solo come connect-only.

PRIVACY:
  * MAI registriamo il testo sintetizzato (contiene memorie personali).
  * MAI registriamo l'API key.
  * `error_message_short` è una stringa succinta (es: "InworldTTSTimeoutError"),
    MAI il body di risposta integrale.
"""
from __future__ import annotations

import datetime as _dt
import logging
from typing import Any, Optional

from pydantic import BaseModel, Field


log = logging.getLogger(__name__)

COLLECTION_NAME = "koda_tts_events"


class KodaTTSEvent(BaseModel):
    """Record singolo di una generazione TTS."""

    # Identità
    event_id: str
    user_id: str

    # Provider
    provider_requested: str  # "elevenlabs" | "inworld"
    provider_actual: str

    # Endpoint di origine
    endpoint: str
    mode: str  # "streaming" | "non_streaming" | "cache_hit" | "static_bundle"

    # Parametri vocali
    voice_id: Optional[str] = None
    model_id: Optional[str] = None
    language: Optional[str] = None
    speaking_rate: Optional[float] = None
    delivery_mode: Optional[str] = None  # Inworld only
    tone: Optional[str] = None  # ElevenLabs only

    # Caratteri + costo
    chars_sent: int = Field(..., ge=0)
    chars_billed: Optional[int] = Field(None, ge=0)
    rate_per_1m_chars_usd: float = Field(..., ge=0.0)
    estimated_cost_usd: float = Field(..., ge=0.0)
    billable: bool

    # Timing
    api_duration_ms: int = Field(..., ge=0)
    first_chunk_ms: Optional[int] = Field(None, ge=0)
    audio_duration_ms: Optional[int] = Field(None, ge=0)

    # Volume audio
    audio_bytes: int = Field(..., ge=0)
    chunks_count: Optional[int] = Field(None, ge=0)

    # Attempts
    attempts: int = Field(default=1, ge=1)

    # Outcome
    outcome: str  # "ok" | "cancelled" | "error" | "cache_hit"
    error_class: Optional[str] = None
    error_message_short: Optional[str] = None

    # Downstream
    served_bytes_to_client: int = Field(default=0, ge=0)
    played_confirmed: bool = False

    # Tracing
    upstream_request_id: Optional[str] = None
    http_status: Optional[int] = None

    # Metadati
    ts: _dt.datetime = Field(default_factory=lambda: _dt.datetime.now(_dt.timezone.utc))

    class Config:
        extra = "forbid"
        protected_namespaces = ()


# ============================================================================
# Indici
# ============================================================================
async def ensure_indexes(db) -> None:
    """Crea gli indici MongoDB. Idempotente."""
    try:
        coll = db[COLLECTION_NAME]
        await coll.create_index("event_id", unique=True)
        await coll.create_index([("user_id", 1), ("ts", -1)])
        await coll.create_index([("provider_actual", 1), ("ts", -1)])
        await coll.create_index([("endpoint", 1), ("ts", -1)])
        await coll.create_index("ts")
    except Exception as e:
        log.warning(f"[koda_tts_events] ensure_indexes failed: {e}")


# ============================================================================
# Insert
# ============================================================================
async def record_tts_event(db, event: KodaTTSEvent) -> None:
    """Insert idempotente di un record TTS. NON solleva su errore DB:
    la telemetria non deve mai bloccare il playback."""
    try:
        doc = event.model_dump(mode="json")
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


# ============================================================================
# Durata MP3 — fonte di verità UNICA per il consumo minuti AI
# ============================================================================
def estimate_mp3_duration_ms(mp3_bytes: bytes) -> Optional[int]:
    """Stima la durata di un MP3 dai frame header (ms).
    Più robusto di bytes/16000 perché:
      - supporta CBR/VBR/MPEG1/2
      - ignora header ID3
      - skippa frame malformati senza abortire.

    Ritorna None se parsing fallisce completamente.
    """
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


# ============================================================================
# Query helpers
# ============================================================================
async def recent_events(db, *, user_id: Optional[str] = None, limit: int = 50) -> list[dict]:
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
