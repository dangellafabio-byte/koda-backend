"""
inworld_dispatcher — Connette l'adapter Inworld al runtime TTS prod.
===================================================================

Modulo di orchestrazione tra:
  * ``inworld_tts`` (adapter puro HTTP)
  * ``koda_tts_events`` (telemetria)
  * ``koda_voice_catalog`` (disponibilità voce per provider)

Fornisce 2 funzioni che il server.py chiama quando ``provider="inworld"``:
  * ``generate_non_streaming()`` → ``bytes`` MP3 completi
  * ``stream_mp3()`` → async iterator di MP3 bytes

Entrambe:
  * sollevano :class:`InworldVoiceNotAvailable` se la voce brand richiesta
    NON è disponibile su Inworld (es: Vento non ancora validato);
  * registrano telemetria su ok/error/cancel (fire-and-forget);
  * NON fanno fallback automatico ad altri provider (contratto Fabio).

Zero import di server.py → nessun ciclo.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import AsyncIterator, Optional

import inworld_tts as _ad
import koda_tts_events as _ev
import koda_voice_catalog as _cat


log = logging.getLogger(__name__)


class InworldVoiceNotAvailable(_ad.InworldTTSError):
    """La voice brand richiesta non è coperta su Inworld in questa fase."""


# =============================================================================
# Helpers
# =============================================================================
def _resolve_voice_params(voice_key: Optional[str]) -> _ad.InworldVoiceParams:
    """Da chiave brand (cielo/vento) → InworldVoiceParams concreti.

    Solleva InworldVoiceNotAvailable se la voce non è disponibile su Inworld.
    """
    key = (voice_key or "cielo").lower().strip() or "cielo"
    entry = _cat.find_by_key(key)
    if not entry or "inworld" not in entry.available_on or not entry.inworld_voice_id:
        raise InworldVoiceNotAvailable(
            f"Voce '{key}' non disponibile su Inworld in questa fase. "
            f"Seleziona un'altra voce o usa ElevenLabs."
        )
    kwargs = {
        "voice_id": entry.inworld_voice_id,
    }
    if entry.inworld_delivery_mode:
        kwargs["delivery_mode"] = entry.inworld_delivery_mode
    # mescola con i default (model_id, language, speaking_rate dalle env)
    base = _ad.DEFAULT_VOICE_PARAMS
    return _ad.InworldVoiceParams(
        voice_id=kwargs.get("voice_id", base.voice_id),
        language=base.language,
        speaking_rate=base.speaking_rate,
        delivery_mode=kwargs.get("delivery_mode", base.delivery_mode),
        model_id=base.model_id,
        audio_encoding=base.audio_encoding,
    )


async def _safe_record(db, event: _ev.KodaTTSEvent) -> None:
    try:
        await _ev.record_tts_event(db, event)
    except Exception:
        pass  # telemetria non deve mai bloccare il playback


# =============================================================================
# Non-streaming
# =============================================================================
async def generate_non_streaming(
    db,
    *,
    text: str,
    user_id: str,
    endpoint: str,
    voice_key: Optional[str] = None,
    tone: Optional[str] = None,
) -> bytes:
    """Genera MP3 bytes completi via Inworld. Registra telemetria."""
    event_id = str(uuid.uuid4())
    try:
        params = _resolve_voice_params(voice_key)
    except InworldVoiceNotAvailable as e:
        # Logga tentativo bloccato (non-billable)
        await _safe_record(db, _ev.KodaTTSEvent(
            event_id=event_id,
            user_id=user_id,
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint=endpoint,
            mode="non_streaming",
            voice_id=voice_key,
            model_id=_ad.DEFAULT_VOICE_PARAMS.model_id,
            language=_ad.DEFAULT_VOICE_PARAMS.language,
            speaking_rate=_ad.DEFAULT_VOICE_PARAMS.speaking_rate,
            delivery_mode=_ad.DEFAULT_VOICE_PARAMS.delivery_mode,
            tone=tone,
            chars_sent=len(text or ""),
            chars_billed=None,
            rate_per_1m_chars_usd=_ad._rate_per_1m_usd(),
            estimated_cost_usd=0.0,
            billable=False,
            api_duration_ms=0,
            audio_bytes=0,
            attempts=1,
            outcome="error",
            error_class="InworldVoiceNotAvailable",
            error_message_short=str(e)[:200],
            served_bytes_to_client=0,
            played_confirmed=False,
            upstream_request_id=None,
            http_status=None,
        ))
        raise

    try:
        res = await _ad.synthesize_non_streaming(text, params)
    except _ad.InworldTTSError as e:
        chars_sent = len(text or "")
        await _safe_record(db, _ev.KodaTTSEvent(
            event_id=event_id,
            user_id=user_id,
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint=endpoint,
            mode="non_streaming",
            voice_id=params.voice_id,
            model_id=params.model_id,
            language=params.language,
            speaking_rate=params.speaking_rate,
            delivery_mode=params.delivery_mode,
            tone=tone,
            chars_sent=chars_sent,
            chars_billed=None,
            rate_per_1m_chars_usd=_ad._rate_per_1m_usd(),
            estimated_cost_usd=_ad._estimate_cost_usd(chars_sent),
            billable=True,  # Fabio: addebito incerto NON va azzerato
            api_duration_ms=0,
            audio_bytes=0,
            attempts=1,
            outcome="error",
            error_class=type(e).__name__,
            error_message_short=str(e)[:200],
            served_bytes_to_client=0,
            played_confirmed=False,
            upstream_request_id=None,
            http_status=None,
        ))
        raise

    audio_dur_ms = _ev.estimate_mp3_duration_ms(res.audio_bytes)
    await _safe_record(db, _ev.KodaTTSEvent(
        event_id=event_id,
        user_id=user_id,
        provider_requested="inworld",
        provider_actual="inworld",
        endpoint=endpoint,
        mode="non_streaming",
        voice_id=params.voice_id,
        model_id=params.model_id,
        language=params.language,
        speaking_rate=params.speaking_rate,
        delivery_mode=params.delivery_mode,
        tone=tone,
        chars_sent=res.chars_sent,
        chars_billed=res.chars_billed,
        rate_per_1m_chars_usd=_ad._rate_per_1m_usd(),
        estimated_cost_usd=res.estimated_cost_usd,
        billable=True,
        api_duration_ms=res.api_duration_ms,
        audio_duration_ms=audio_dur_ms,
        audio_bytes=len(res.audio_bytes),
        attempts=1,
        outcome="ok",
        error_class=None,
        error_message_short=None,
        served_bytes_to_client=0,
        played_confirmed=False,
        upstream_request_id=res.request_id,
        http_status=res.http_status,
    ))
    return res.audio_bytes


# =============================================================================
# Streaming
# =============================================================================
async def stream_mp3(
    db,
    *,
    text: str,
    user_id: str,
    endpoint: str,
    voice_key: Optional[str] = None,
    tone: Optional[str] = None,
) -> AsyncIterator[bytes]:
    """Yielda bytes MP3 puri. Registra telemetria a fine stream."""
    event_id = str(uuid.uuid4())
    try:
        params = _resolve_voice_params(voice_key)
    except InworldVoiceNotAvailable as e:
        await _safe_record(db, _ev.KodaTTSEvent(
            event_id=event_id,
            user_id=user_id,
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint=endpoint,
            mode="streaming",
            voice_id=voice_key,
            model_id=_ad.DEFAULT_VOICE_PARAMS.model_id,
            language=_ad.DEFAULT_VOICE_PARAMS.language,
            speaking_rate=_ad.DEFAULT_VOICE_PARAMS.speaking_rate,
            delivery_mode=_ad.DEFAULT_VOICE_PARAMS.delivery_mode,
            tone=tone,
            chars_sent=len(text or ""),
            chars_billed=None,
            rate_per_1m_chars_usd=_ad._rate_per_1m_usd(),
            estimated_cost_usd=0.0,
            billable=False,
            api_duration_ms=0,
            audio_bytes=0,
            attempts=1,
            outcome="error",
            error_class="InworldVoiceNotAvailable",
            error_message_short=str(e)[:200],
            served_bytes_to_client=0,
            played_confirmed=False,
            upstream_request_id=None,
            http_status=None,
        ))
        raise

    stream_result = _ad.InworldStreamResult(
        chars_sent=len(text or ""),
        model_id=params.model_id,
        voice_id=params.voice_id,
    )
    audio_accum = bytearray()
    cancelled = False
    error_class: Optional[str] = None
    error_msg: Optional[str] = None

    try:
        async for chunk in _ad.stream_synthesize(text, params, result_out=stream_result):
            audio_accum.extend(chunk)
            yield chunk
    except asyncio.CancelledError:
        cancelled = True
        raise
    except _ad.InworldTTSError as e:
        error_class = type(e).__name__
        error_msg = str(e)[:200]
        raise
    finally:
        audio_dur_ms = _ev.estimate_mp3_duration_ms(bytes(audio_accum))
        outcome = "ok"
        if cancelled or stream_result.cancelled:
            outcome = "cancelled"
        elif error_class:
            outcome = "error"
        chars_for_cost = (
            stream_result.chars_billed
            if stream_result.chars_billed is not None else stream_result.chars_sent
        )
        await _safe_record(db, _ev.KodaTTSEvent(
            event_id=event_id,
            user_id=user_id,
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint=endpoint,
            mode="streaming",
            voice_id=params.voice_id,
            model_id=params.model_id,
            language=params.language,
            speaking_rate=params.speaking_rate,
            delivery_mode=params.delivery_mode,
            tone=tone,
            chars_sent=stream_result.chars_sent,
            chars_billed=stream_result.chars_billed,
            rate_per_1m_chars_usd=_ad._rate_per_1m_usd(),
            estimated_cost_usd=_ad._estimate_cost_usd(chars_for_cost),
            billable=True,
            api_duration_ms=stream_result.api_duration_ms,
            first_chunk_ms=stream_result.first_chunk_ms,
            audio_duration_ms=audio_dur_ms,
            audio_bytes=stream_result.audio_bytes_total,
            chunks_count=stream_result.chunks_count,
            attempts=1,
            outcome=outcome,
            error_class=error_class,
            error_message_short=error_msg,
            served_bytes_to_client=stream_result.audio_bytes_total,
            played_confirmed=False,
            upstream_request_id=stream_result.request_id,
            http_status=stream_result.http_status,
        ))
