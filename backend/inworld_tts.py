"""
Inworld TTS Adapter — Ollenya (modular, provider-pure)
======================================================

Adapter puro verso l'API Inworld AI TTS. Nessun side-effect globale, zero
dipendenze da server.py, zero fallback automatico ad altri provider.

Contratto audio (identico a ElevenLabs per non rompere il frontend):
  * ``synthesize_non_streaming()`` ritorna i bytes MP3 completi.
  * ``stream_synthesize()`` è un async iterator di bytes MP3 puri.
    Internamente consuma la risposta NDJSON di Inworld, decodifica ogni
    chunk Base64 e yielda SOLO i bytes audio. Nessuna NDJSON/SSE arriva
    al frontend.

Sicurezza:
  * API key letta da env (``INWORLD_API_KEY``), MAI loggata.
  * Nessun logging del testo da sintetizzare.
  * Nessun fallback automatico su errore: solleva InworldTTSError.
  * Timeout configurabile.

Modello/voce/tariffa (richiesta Fabio 2026-10):
  Niente hardcoded "inworld-tts-2" come definitivo. Il modello, la voce,
  la tariffa e il delivery_mode sono CONFIGURABILI:
    - Default via env (``INWORLD_MODEL_ID``, ``INWORLD_VOICE_ID``,
      ``INWORLD_RATE_PER_1M_CHARS_USD``, ``INWORLD_DELIVERY_MODE``).
    - Override per singola call via ``InworldVoiceParams``.
  Finché Fabio non ha confrontato gli audio e scelto il modello definitivo,
  i default partono con placeholder sicuri + ``INWORLD_MODEL_LOCKED=false``
  così è ovvio nella telemetria che il modello non è ancora definitivo.

Telemetria:
  Non scrive mai in MongoDB. Ritorna oggetti con metriche che il
  dispatcher usa per registrare ``koda_tts_events``.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import httpx


# =============================================================================
# Config endpoints
# =============================================================================
INWORLD_API_BASE = "https://api.inworld.ai"
INWORLD_ENDPOINT_NON_STREAMING = f"{INWORLD_API_BASE}/tts/v1/voice"
INWORLD_ENDPOINT_STREAMING = f"{INWORLD_API_BASE}/tts/v1/voice:stream"

DEFAULT_NON_STREAM_TIMEOUT_S = 60.0
DEFAULT_STREAM_TOTAL_TIMEOUT_S = 120.0

# Env defaults — scelte deliberatamente neutre finché Fabio non valida.
_DEFAULT_MODEL_ID = os.environ.get("INWORLD_MODEL_ID", "inworld-tts-1").strip() or "inworld-tts-1"
_DEFAULT_VOICE_ID = os.environ.get("INWORLD_VOICE_ID", "").strip() or "Alessandro"
_DEFAULT_LANGUAGE = os.environ.get("INWORLD_LANGUAGE", "it-IT").strip() or "it-IT"
_DEFAULT_DELIVERY = os.environ.get("INWORLD_DELIVERY_MODE", "CREATIVE").strip().upper() or "CREATIVE"
try:
    _DEFAULT_RATE_USD = float(os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD", "15.0"))
except (TypeError, ValueError):
    _DEFAULT_RATE_USD = 15.0
try:
    _DEFAULT_SPEAKING_RATE = float(os.environ.get("INWORLD_SPEAKING_RATE", "1.05"))
except (TypeError, ValueError):
    _DEFAULT_SPEAKING_RATE = 1.05
# Flag esplicito: finché "false", qualsiasi reporting telemetrico deve
# indicare che il modello è ancora in valutazione (no claim pricing).
INWORLD_MODEL_LOCKED = (
    os.environ.get("INWORLD_MODEL_LOCKED", "false").strip().lower() in ("1", "true", "yes")
)


@dataclass(frozen=True)
class InworldVoiceParams:
    """Parametri vocali Inworld — immutabili per request.

    I default partono dagli env. Override possibile campo per campo.
    """
    voice_id: str = _DEFAULT_VOICE_ID
    language: str = _DEFAULT_LANGUAGE
    speaking_rate: float = _DEFAULT_SPEAKING_RATE
    delivery_mode: str = _DEFAULT_DELIVERY  # CREATIVE | EXPRESSIVE | NEUTRAL | ...
    model_id: str = _DEFAULT_MODEL_ID
    audio_encoding: str = "MP3"

    def to_payload(self, text: str) -> dict:
        return {
            "text": text,
            "modelId": self.model_id,
            "voiceId": self.voice_id,
            "language": self.language,
            "speakingRate": self.speaking_rate,
            "deliveryMode": self.delivery_mode,
            "audioConfig": {"audioEncoding": self.audio_encoding},
        }


DEFAULT_VOICE_PARAMS = InworldVoiceParams()


# =============================================================================
# Exceptions
# =============================================================================
class InworldTTSError(Exception):
    """Errore generico adapter. Trattato come HTTP 502 upstream."""


class InworldTTSAuthError(InworldTTSError):
    """API key mancante o rifiutata (HTTP 401/403)."""


class InworldTTSRateLimitError(InworldTTSError):
    """Rate limit upstream (HTTP 429)."""


class InworldTTSBadResponseError(InworldTTSError):
    """Risposta malformata."""


class InworldTTSTimeoutError(InworldTTSError):
    """Timeout upstream."""


class InworldTTSCancelled(InworldTTSError):
    """Il consumer ha interrotto lo stream prima della fine."""


# =============================================================================
# Results
# =============================================================================
@dataclass
class InworldSynthesisResult:
    audio_bytes: bytes
    chars_sent: int
    chars_billed: Optional[int]
    api_duration_ms: int
    request_id: Optional[str]
    http_status: int
    estimated_cost_usd: float
    model_id: str
    voice_id: str


@dataclass
class InworldStreamResult:
    chars_sent: int
    chars_billed: Optional[int] = None
    audio_bytes_total: int = 0
    chunks_count: int = 0
    api_duration_ms: int = 0
    first_chunk_ms: Optional[int] = None
    request_id: Optional[str] = None
    http_status: Optional[int] = None
    estimated_cost_usd: float = 0.0
    cancelled: bool = False
    error: Optional[str] = None
    model_id: str = _DEFAULT_MODEL_ID
    voice_id: str = _DEFAULT_VOICE_ID


# =============================================================================
# Helpers
# =============================================================================
def _load_api_key() -> str:
    """Legge INWORLD_API_KEY dall'env del processo. MAI loggata."""
    key = os.environ.get("INWORLD_API_KEY", "").strip()
    if not key:
        raise InworldTTSAuthError("INWORLD_API_KEY non configurata")
    return key


def _rate_per_1m_usd() -> float:
    try:
        return float(os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD", _DEFAULT_RATE_USD))
    except (TypeError, ValueError):
        return _DEFAULT_RATE_USD


def _estimate_cost_usd(chars: int) -> float:
    return (chars * _rate_per_1m_usd()) / 1_000_000.0


def _extract_billed_chars(payload: dict) -> Optional[int]:
    for container in (payload, payload.get("result") or {}):
        if not isinstance(container, dict):
            continue
        usage = container.get("usage") or {}
        if not isinstance(usage, dict):
            continue
        for k in ("processedCharactersCount", "characterCount", "inputCharacters"):
            v = usage.get(k)
            if isinstance(v, int):
                return v
    return None


def _validate_text(text: str, *, max_chars: int = 2000) -> str:
    text = (text or "").strip()
    if not text:
        raise InworldTTSError("testo vuoto")
    if len(text) > max_chars:
        raise InworldTTSError(f"testo troppo lungo: {len(text)} > {max_chars}")
    return text


def _auth_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Basic {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Ollenya-TTS/1.0",
    }


# =============================================================================
# Public API — Non-streaming
# =============================================================================
async def synthesize_non_streaming(
    text: str,
    params: InworldVoiceParams = DEFAULT_VOICE_PARAMS,
    *,
    timeout_s: float = DEFAULT_NON_STREAM_TIMEOUT_S,
) -> InworldSynthesisResult:
    """TTS Inworld non-streaming. Single-shot, zero retry.

    Nessun fallback automatico su errore: solleva InworldTTSError*.
    """
    text = _validate_text(text)
    api_key = _load_api_key()
    payload = params.to_payload(text)
    chars_sent = len(text)

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                INWORLD_ENDPOINT_NON_STREAMING,
                headers=_auth_headers(api_key),
                content=json.dumps(payload).encode("utf-8"),
            )
    except httpx.TimeoutException as e:
        raise InworldTTSTimeoutError(f"timeout dopo {timeout_s}s") from e
    except httpx.HTTPError as e:
        raise InworldTTSError(f"network error: {type(e).__name__}") from e

    api_duration_ms = int((time.perf_counter() - t0) * 1000)
    status = resp.status_code
    req_id = (
        resp.headers.get("x-inworld-request-id")
        or resp.headers.get("x-request-id")
    )

    if status in (401, 403):
        raise InworldTTSAuthError(f"auth refused: HTTP {status}")
    if status == 429:
        raise InworldTTSRateLimitError(f"rate limited: HTTP 429 req_id={req_id or '?'}")
    if status >= 400:
        raise InworldTTSError(f"upstream HTTP {status} req_id={req_id or '?'}")

    try:
        resp_json = resp.json()
    except Exception as e:
        raise InworldTTSBadResponseError("JSON parse error") from e

    audio_b64 = (
        resp_json.get("audioContent")
        or (resp_json.get("result") or {}).get("audioContent")
        or ""
    )
    if not audio_b64:
        raise InworldTTSBadResponseError("no audioContent in response")
    try:
        audio_bytes = base64.b64decode(audio_b64)
    except Exception as e:
        raise InworldTTSBadResponseError("audioContent not valid base64") from e

    if len(audio_bytes) < 500:
        raise InworldTTSBadResponseError(f"audio sospettosamente piccolo: {len(audio_bytes)}B")

    chars_billed = _extract_billed_chars(resp_json)
    chars_for_cost = chars_billed if chars_billed is not None else chars_sent

    return InworldSynthesisResult(
        audio_bytes=audio_bytes,
        chars_sent=chars_sent,
        chars_billed=chars_billed,
        api_duration_ms=api_duration_ms,
        request_id=req_id,
        http_status=status,
        estimated_cost_usd=_estimate_cost_usd(chars_for_cost),
        model_id=params.model_id,
        voice_id=params.voice_id,
    )


# =============================================================================
# Public API — Streaming
# =============================================================================
async def stream_synthesize(
    text: str,
    params: InworldVoiceParams = DEFAULT_VOICE_PARAMS,
    *,
    total_timeout_s: float = DEFAULT_STREAM_TOTAL_TIMEOUT_S,
    result_out: Optional[InworldStreamResult] = None,
) -> AsyncIterator[bytes]:
    """Async generator di bytes MP3 puri (NO NDJSON, NO Base64)."""
    text = _validate_text(text)
    api_key = _load_api_key()
    payload = params.to_payload(text)
    chars_sent = len(text)

    if result_out is None:
        result_out = InworldStreamResult(
            chars_sent=chars_sent,
            model_id=params.model_id,
            voice_id=params.voice_id,
        )
    else:
        result_out.chars_sent = chars_sent
        result_out.model_id = params.model_id
        result_out.voice_id = params.voice_id

    t0 = time.perf_counter()
    first_chunk_time: Optional[float] = None

    try:
        async with httpx.AsyncClient(timeout=total_timeout_s) as client:
            async with client.stream(
                "POST",
                INWORLD_ENDPOINT_STREAMING,
                headers=_auth_headers(api_key),
                content=json.dumps(payload).encode("utf-8"),
            ) as resp:
                result_out.http_status = resp.status_code
                result_out.request_id = (
                    resp.headers.get("x-inworld-request-id")
                    or resp.headers.get("x-request-id")
                )

                if resp.status_code in (401, 403):
                    raise InworldTTSAuthError(f"auth refused: HTTP {resp.status_code}")
                if resp.status_code == 429:
                    raise InworldTTSRateLimitError(
                        f"rate limited: HTTP 429 req_id={result_out.request_id or '?'}"
                    )
                if resp.status_code >= 400:
                    raise InworldTTSError(
                        f"upstream HTTP {resp.status_code} req_id={result_out.request_id or '?'}"
                    )

                buf = b""
                async for raw in resp.aiter_bytes():
                    if not raw:
                        continue
                    buf += raw
                    while True:
                        nl = buf.find(b"\n")
                        if nl < 0:
                            break
                        line = buf[:nl].strip()
                        buf = buf[nl + 1:]
                        if not line:
                            continue
                        try:
                            frame = json.loads(line.decode("utf-8"))
                        except Exception:
                            continue
                        audio_b64 = (
                            frame.get("audioContent")
                            or (frame.get("result") or {}).get("audioContent")
                            or ""
                        )
                        if audio_b64:
                            try:
                                mp3_chunk = base64.b64decode(audio_b64)
                            except Exception:
                                continue
                            if mp3_chunk:
                                if first_chunk_time is None:
                                    first_chunk_time = time.perf_counter()
                                    result_out.first_chunk_ms = int((first_chunk_time - t0) * 1000)
                                result_out.audio_bytes_total += len(mp3_chunk)
                                result_out.chunks_count += 1
                                yield mp3_chunk
                        billed = _extract_billed_chars(frame)
                        if billed is not None:
                            result_out.chars_billed = billed
                tail = buf.strip()
                if tail:
                    try:
                        frame = json.loads(tail.decode("utf-8"))
                        audio_b64 = (
                            frame.get("audioContent")
                            or (frame.get("result") or {}).get("audioContent")
                            or ""
                        )
                        if audio_b64:
                            mp3_chunk = base64.b64decode(audio_b64)
                            if mp3_chunk:
                                result_out.audio_bytes_total += len(mp3_chunk)
                                result_out.chunks_count += 1
                                yield mp3_chunk
                        billed = _extract_billed_chars(frame)
                        if billed is not None:
                            result_out.chars_billed = billed
                    except Exception:
                        pass
    except asyncio.CancelledError:
        result_out.cancelled = True
        result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
        chars_for_cost = (
            result_out.chars_billed
            if result_out.chars_billed is not None else chars_sent
        )
        result_out.estimated_cost_usd = _estimate_cost_usd(chars_for_cost)
        raise
    except httpx.TimeoutException as e:
        result_out.error = "timeout"
        result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
        raise InworldTTSTimeoutError(f"stream timeout dopo {total_timeout_s}s") from e
    except InworldTTSError as e:
        result_out.error = type(e).__name__
        result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
        chars_for_cost = (
            result_out.chars_billed
            if result_out.chars_billed is not None else chars_sent
        )
        result_out.estimated_cost_usd = _estimate_cost_usd(chars_for_cost)
        raise
    except httpx.HTTPError as e:
        result_out.error = f"net:{type(e).__name__}"
        result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
        raise InworldTTSError(f"network error: {type(e).__name__}") from e

    result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
    chars_for_cost = (
        result_out.chars_billed
        if result_out.chars_billed is not None else chars_sent
    )
    result_out.estimated_cost_usd = _estimate_cost_usd(chars_for_cost)


# =============================================================================
# Introspection — DRY (no HTTP call, no secret exposure)
# =============================================================================
def health_check_config() -> dict:
    """Diagnostica configurazione adapter. ZERO chiamate upstream, zero segreti."""
    api_key_present = bool(os.environ.get("INWORLD_API_KEY", "").strip())
    return {
        "module_loaded": True,
        "httpx_available": True,
        "api_key_present": api_key_present,
        "endpoint_non_streaming": INWORLD_ENDPOINT_NON_STREAMING,
        "endpoint_streaming": INWORLD_ENDPOINT_STREAMING,
        "default_model_id": DEFAULT_VOICE_PARAMS.model_id,
        "default_voice_id": DEFAULT_VOICE_PARAMS.voice_id,
        "default_language": DEFAULT_VOICE_PARAMS.language,
        "default_speaking_rate": DEFAULT_VOICE_PARAMS.speaking_rate,
        "default_delivery_mode": DEFAULT_VOICE_PARAMS.delivery_mode,
        "rate_per_1m_chars_usd": _rate_per_1m_usd(),
        "model_locked": INWORLD_MODEL_LOCKED,
        "non_stream_timeout_s": DEFAULT_NON_STREAM_TIMEOUT_S,
        "stream_total_timeout_s": DEFAULT_STREAM_TOTAL_TIMEOUT_S,
    }
