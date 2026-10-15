"""
inworld_dispatcher — connette Inworld adapter al runtime TTS prod.
===================================================================

Modulo di orchestrazione tra:
 * ``inworld_tts`` (adapter puro HTTP)
 * ``koda_tts_events`` (telemetria)
 * ``koda_tts_prefs`` (guard voce Vento)

Fornisce 2 funzioni che il dispatcher in ``server.py`` chiama al posto
di ElevenLabs quando ``provider=inworld``:

 * ``generate_non_streaming()`` → ``bytes`` MP3 completi
 * ``stream_mp3()`` → async iterator di MP3 bytes

Entrambe:
 * registrano SEMPRE un evento in ``koda_tts_events`` (anche su error/cancel)
 * sollevano :class:`InworldVoiceNotAvailable` se la voce richiesta è
   Vento (non disponibile in fase 1)
 * NON fanno fallback automatico a ElevenLabs (contratto Fabio)

Zero import di server.py → nessun ciclo.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import AsyncIterator, Optional

import inworld_tts as _ad
import koda_tts_events as _ev
import koda_tts_prefs as _prefs


class InworldVoiceNotAvailable(_ad.InworldTTSError):
    """La voice_id richiesta non è coperta dalla fase A/B corrente."""


# =============================================================================
# Non-streaming
# =============================================================================
async def generate_non_streaming(
    db,
    *,
    text: str,
    user_id: str,
    endpoint: str,
    voice_id_requested: Optional[str] = None,
    tone: Optional[str] = None,
) -> bytes:
    """Genera MP3 bytes completi via Inworld. Registra telemetria."""
    # Guard voce Vento (non implementata in Inworld fase 1)
    if _prefs.is_vento_voice(voice_id_requested):
        # Logga sempre il tentativo (bloccato) → l'owner vede subito
        # se il frontend sta tentando Vento sotto Inworld.
        await _ev.record_tts_event(db, _ev.KodaTTSEvent(
            event_id=str(uuid.uuid4()),
            user_id=user_id,
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint=endpoint,
            mode="non_streaming",
            voice_id=voice_id_requested,
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
            first_chunk_ms=None,
            audio_duration_ms=None,
            audio_bytes=0,
            chunks_count=None,
            attempts=1,
            outcome="error",
            error_class="InworldVoiceNotAvailable",
            error_message_short="vento_not_in_fase1",
            served_bytes_to_client=0,
            played_confirmed=False,
            upstream_request_id=None,
            http_status=None,
        ))
        raise InworldVoiceNotAvailable(
            "Voce 'Vento' non disponibile con provider Inworld in questa "
            "fase di test. Seleziona 'Cielo' oppure torna a ElevenLabs."
        )

    event_id = str(uuid.uuid4())
    params = _ad.DEFAULT_VOICE_PARAMS

    try:
        res = await _ad.synthesize_non_streaming(text, params)
    except _ad.InworldTTSError as e:
        # Record tentativo fallito. Se è un timeout o un'auth error,
        # l'addebito è incerto → chars_billed=None, billable=True
        # (potenzialmente fatturato), estimated_cost su chars_sent.
        chars_sent = len(text or "")
        await _ev.record_tts_event(db, _ev.KodaTTSEvent(
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
            billable=True,  # addebito incerto, non assumiamo zero
            api_duration_ms=0,
            first_chunk_ms=None,
            audio_duration_ms=None,
            audio_bytes=0,
            chunks_count=None,
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

    # Successo
    audio_dur_ms = _ev.estimate_mp3_duration_ms(res.audio_bytes)
    await _ev.record_tts_event(db, _ev.KodaTTSEvent(
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
        first_chunk_ms=None,
        audio_duration_ms=audio_dur_ms,
        audio_bytes=len(res.audio_bytes),
        chunks_count=None,
        attempts=1,
        outcome="ok",
        error_class=None,
        error_message_short=None,
        served_bytes_to_client=0,  # il chiamante aggiorna via ack
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
    voice_id_requested: Optional[str] = None,
    tone: Optional[str] = None,
) -> AsyncIterator[bytes]:
    """Yielda bytes MP3 puri. Registra telemetria al termine (ok/cancel/error)."""
    if _prefs.is_vento_voice(voice_id_requested):
        await _ev.record_tts_event(db, _ev.KodaTTSEvent(
            event_id=str(uuid.uuid4()),
            user_id=user_id,
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint=endpoint,
            mode="streaming",
            voice_id=voice_id_requested,
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
            first_chunk_ms=None,
            audio_duration_ms=None,
            audio_bytes=0,
            chunks_count=None,
            attempts=1,
            outcome="error",
            error_class="InworldVoiceNotAvailable",
            error_message_short="vento_not_in_fase1",
            served_bytes_to_client=0,
            played_confirmed=False,
            upstream_request_id=None,
            http_status=None,
        ))
        raise InworldVoiceNotAvailable(
            "Voce 'Vento' non disponibile con provider Inworld in questa "
            "fase di test."
        )

    event_id = str(uuid.uuid4())
    params = _ad.DEFAULT_VOICE_PARAMS
    stream_result = _ad.InworldStreamResult(chars_sent=len(text or ""))
    audio_accum = bytearray()  # per stima durata audio alla fine
    cancelled = False
    error_class: Optional[str] = None
    error_msg: Optional[str] = None

    try:
        async for chunk in _ad.stream_synthesize(
            text, params, result_out=stream_result
        ):
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
        # Record SEMPRE (anche su ok, cancel, error). audio_duration_ms
        # calcolata dagli bytes che siamo riusciti a decodificare.
        audio_dur_ms = _ev.estimate_mp3_duration_ms(bytes(audio_accum))
        outcome = "ok"
        if cancelled or stream_result.cancelled:
            outcome = "cancelled"
        elif error_class:
            outcome = "error"
        # Il costo è: billed se riportato dal provider, altrimenti sui
        # chars_sent (addebito incerto non azzerato: contratto Fabio)
        chars_for_cost = (
            stream_result.chars_billed
            if stream_result.chars_billed is not None else stream_result.chars_sent
        )
        try:
            await _ev.record_tts_event(db, _ev.KodaTTSEvent(
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
        except Exception:
            # La telemetria non deve bloccare mai lo stream
            pass
