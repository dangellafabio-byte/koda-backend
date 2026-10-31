"""
Inworld TTS Adapter — Ollenya (dev-only, isolated)
===================================================

Adapter puro verso l'API Inworld AI TTS-2. **NON collegato ad alcun router
di produzione**. Esportato per essere consumato in futuro dal dispatcher
backend una volta approvato lo switch per utente.

Contratto audio:
----------------
Entrambe le API HTTP di prod che useranno questo adapter (``/api/tts``
e ``/api/tts/stream``) servono il frontend con ``audio/mpeg`` (MP3 crudo,
chunked transfer per lo streaming). Questo modulo rispetta lo stesso
contratto:

* ``synthesize_non_streaming()`` ritorna i **bytes MP3 completi**.
* ``stream_synthesize()`` è un **async iterator di bytes MP3 puri**:
  internamente consuma la risposta NDJSON di Inworld, decodifica ogni
  chunk Base64 e yielda SOLO i bytes audio. Nessuna NDJSON/SSE arriva
  al frontend.

Garanzie di sicurezza:
----------------------
* API key letta da env (``INWORLD_API_KEY``), MAI loggata.
* Nessun logging del testo da sintetizzare (potenzialmente contiene
  memorie personali degli utenti).
* Nessun fallback automatico ad altri provider: fail hard con
  :class:`InworldTTSError` + sotto-classi. Il dispatcher chiamante
  decide cosa fare dell'errore.
* Timeout configurabile per singola richiesta.

Telemetria:
-----------
Non scrive mai direttamente in MongoDB. Ritorna invece oggetti
:class:`InworldSynthesisResult` / :class:`InworldStreamResult` che il
chiamante usa per costruire il record ``koda_tts_events`` (vedi
``koda_tts_events.py``). Questo mantiene l'adapter puro e testabile.

Nessun side-effect globale.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx


# =============================================================================
# Config
# =============================================================================
INWORLD_API_BASE = "https://api.inworld.ai"
INWORLD_ENDPOINT_NON_STREAMING = f"{INWORLD_API_BASE}/tts/v1/voice"
INWORLD_ENDPOINT_STREAMING = f"{INWORLD_API_BASE}/tts/v1/voice:stream"

# Tariffa listino on-demand di partenza (USD per 1M char processati).
# ATTENZIONE: 25.00 USD/1M è il PLACEHOLDER di listino "Starter"; non
# corrisponde necessariamente al piano reale di Fabio né al rate specifico
# di ``inworld-tts-2-flash``. Override via env ``INWORLD_RATE_PER_1M_CHARS_USD``
# ogni volta che il piano cambia. La fonte della tariffa viene annotata nei
# documenti telemetria (`tts.rate_source`) per distinguere stima da addebito.
DEFAULT_INWORLD_RATE_PER_1M_CHARS_USD = 25.00

# Timeout singola richiesta (sec). Non-streaming può essere più lungo
# per testi lunghi; streaming invece ha hard-cap sul TOTAL stream time.
DEFAULT_NON_STREAM_TIMEOUT_S = 60.0
DEFAULT_STREAM_TOTAL_TIMEOUT_S = 120.0


@dataclass(frozen=True)
class InworldVoiceParams:
    """Parametri vocali Inworld — immutabili per request.

    Default: identici alla voce approvata da Fabio durante i test API
    (``vivid-feather-7719__design-voice-37081da2``, ``it-IT``, rate 1.05,
    delivery ``CREATIVE``).
    """

    voice_id: str = "vivid-feather-7719__design-voice-37081da2"
    language: str = "it-IT"
    speaking_rate: float = 1.05
    delivery_mode: str = "CREATIVE"  # CREATIVE | EXPRESSIVE | STANDARD | CALM | NEUTRAL
    # Modello default allineato a scelta Fabio 2026-10-30: TTS-2 Flash
    # (variante a latenza bassa / costo contenuto).
    model_id: str = "inworld-tts-2-flash"
    audio_encoding: str = "MP3"

    def to_payload(
        self,
        text: str,
        *,
        previous_requests: Optional[List[str]] = None,
    ) -> dict:
        """Costruisce il payload REST verso Inworld TTS.

        `previous_requests`: lista di testi effettivamente sintetizzati
        in turni precedenti (ordine cronologico, oldest→newest). Se
        presente, viene inserita in `synthesisContext.previousRequests`
        — vedi docs Inworld "best-practices/generating-speech":
          - max 5 elementi
          - lunghezza combinata ≤ 2000 char
          - ordinati dal più vecchio al più nuovo
          - "context text is not billed toward your character usage;
            only the primary `text` field of the current request is
            billed" → inviare contesto NON aumenta la spesa.

        NOTA Flash: `inworld-tts-2-flash` NON supporta "steering"
        (instruction tags vocali ignorati), MA accetta `synthesisContext`
        secondo la documentazione pubblica (endpoint synthesize-speech,
        verificato 2026-11-04).
        """
        payload: Dict[str, Any] = {
            "text": text,
            "modelId": self.model_id,
            "voiceId": self.voice_id,
            "language": self.language,
            "speakingRate": self.speaking_rate,
            "deliveryMode": self.delivery_mode,
            "audioConfig": {"audioEncoding": self.audio_encoding},
        }
        if previous_requests:
            # Sanity check: rispettiamo i limiti documentati, non li
            # ridimensioniamo silenziosamente. Chi passa più di 5 o
            # più di 2000 char complessivi riceve un errore locale
            # subito, non una failure Inworld. Vedi
            # `inworld_context_buffer._prune_for_payload()` per la
            # politica di selezione a monte.
            if len(previous_requests) > 5:
                raise ValueError(
                    "synthesisContext.previousRequests: max 5 elementi "
                    "(Inworld docs 2026-11-04)"
                )
            total_chars = sum(len(t or "") for t in previous_requests)
            if total_chars > 2000:
                raise ValueError(
                    f"synthesisContext.previousRequests: max 2000 char "
                    f"combinati (ricevuti {total_chars})"
                )
            payload["synthesisContext"] = {
                "previousRequests": [{"text": t} for t in previous_requests],
            }
        return payload


DEFAULT_VOICE_PARAMS = InworldVoiceParams()


# =============================================================================
# Exceptions
# =============================================================================
class InworldTTSError(Exception):
    """Errore generico adapter. Da trattare come HTTP 502 upstream per il
    chiamante dispatcher."""


class InworldTTSAuthError(InworldTTSError):
    """API key mancante o rifiutata (HTTP 401/403)."""


class InworldTTSRateLimitError(InworldTTSError):
    """Rate limit upstream (HTTP 429)."""


class InworldTTSBadResponseError(InworldTTSError):
    """Risposta malformata (JSON mancante, audioContent assente,
    NDJSON non parsabile)."""


class InworldTTSTimeoutError(InworldTTSError):
    """Timeout upstream."""


class InworldTTSCancelled(InworldTTSError):
    """Il consumer ha interrotto lo stream prima della fine."""


# =============================================================================
# Results
# =============================================================================
@dataclass
class InworldSynthesisResult:
    """Risultato di una call non-streaming."""

    audio_bytes: bytes
    chars_sent: int
    chars_billed: Optional[int]  # None se Inworld non riporta usage
    api_duration_ms: int
    request_id: Optional[str]
    http_status: int
    estimated_cost_usd: float


@dataclass
class InworldStreamResult:
    """Risultato riassuntivo di una call streaming (riempito dopo che lo
    stream è stato consumato o cancellato). Il chiamante lo usa per
    popolare la telemetria dopo la playback.
    """

    chars_sent: int
    chars_billed: Optional[int] = None
    audio_bytes_total: int = 0
    chunks_count: int = 0
    api_duration_ms: int = 0  # tempo totale della chiamata HTTP (connect → close)
    first_chunk_ms: Optional[int] = None  # TTFB sul primo chunk MP3 utile
    request_id: Optional[str] = None
    http_status: Optional[int] = None
    estimated_cost_usd: float = 0.0
    cancelled: bool = False
    error: Optional[str] = None  # messaggio succinto, nessun contenuto testo


# =============================================================================
# Helpers
# =============================================================================
def _load_api_key() -> str:
    """Legge INWORLD_API_KEY dall'env del processo. Mai loggato."""
    key = os.environ.get("INWORLD_API_KEY", "").strip()
    if not key:
        raise InworldTTSAuthError("INWORLD_API_KEY non configurata")
    return key


def _rate_per_1m_usd() -> float:
    try:
        return float(os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD",
                                    DEFAULT_INWORLD_RATE_PER_1M_CHARS_USD))
    except (TypeError, ValueError):
        return DEFAULT_INWORLD_RATE_PER_1M_CHARS_USD


def _rate_source() -> str:
    """Ritorna una stringa che indica la PROVENIENZA del rate corrente.
    IMPORTANTE: nessun livello qui garantisce la tariffa reale fatturata
    dal provider — solo la fattura Inworld è fonte di verità per
    l'addebito. Questi marker servono a documentare la fonte del
    parametro usato nella STIMA.

    Livelli:
      * 'inworld_env_configured':
            l'env ``INWORLD_RATE_PER_1M_CHARS_USD`` è impostata e parsabile
            → il parametro è stato configurato esplicitamente.
            NON implica che corrisponda al piano reale: l'utente potrebbe
            aver inserito un valore sbagliato o obsoleto.
      * 'inworld_env_verified':
            l'env ``INWORLD_RATE_PER_1M_CHARS_USD`` è impostata E l'env
            ``INWORLD_RATE_VERIFIED=1`` è presente — l'operatore ha
            dichiarato ESPLICITAMENTE di aver confrontato il valore con
            il contratto del piano attivo (o con una fattura recente).
            Resta una stima, ma rafforzata da verifica umana.
      * 'inworld_fallback_placeholder':
            nessun override env → stiamo usando il PLACEHOLDER di listino
            ($25.00 USD / 1M char) definito in
            ``DEFAULT_INWORLD_RATE_PER_1M_CHARS_USD``. Questo valore
            NON è specifico di `inworld-tts-2-flash`, NON corrisponde al
            piano reale di Fabio, ed è destinato a essere sostituito via
            env quando il piano è noto. Qualsiasi stima calcolata con
            questo rate è INDICATIVA, non una previsione di addebito.
    """
    raw = os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD")
    if not raw:
        return "inworld_fallback_placeholder"
    try:
        float(raw)
    except (TypeError, ValueError):
        return "inworld_fallback_placeholder"
    if os.environ.get("INWORLD_RATE_VERIFIED") == "1":
        return "inworld_env_verified"
    return "inworld_env_configured"


def _estimate_cost_usd(chars: int) -> float:
    return (chars * _rate_per_1m_usd()) / 1_000_000.0


def _extract_billed_chars(payload: dict) -> Optional[int]:
    """Inworld può riportare l'usage in posizioni leggermente diverse
    tra endpoint streaming e non-streaming. Cerchiamo in tutti i campi
    noti; ritorniamo None se nessuno è presente."""
    for container in (payload, payload.get("result") or {}):
        if not isinstance(container, dict):
            continue
        usage = container.get("usage") or {}
        if not isinstance(usage, dict):
            continue
        for k in ("processedCharactersCount", "characterCount",
                  "inputCharacters"):
            v = usage.get(k)
            if isinstance(v, int):
                return v
    return None


def _validate_text(text: str, *, max_chars: int = 2000) -> str:
    text = (text or "").strip()
    if not text:
        raise InworldTTSError("testo vuoto")
    if len(text) > max_chars:
        # Non logghiamo il testo. Logghiamo solo la len.
        raise InworldTTSError(f"testo troppo lungo: {len(text)} > {max_chars}")
    return text


def _auth_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Basic {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Ollenya-TTS/1.0 (dev)",
    }


# =============================================================================
# Public API — Non-streaming
# =============================================================================
async def synthesize_non_streaming(
    text: str,
    params: InworldVoiceParams = DEFAULT_VOICE_PARAMS,
    *,
    timeout_s: float = DEFAULT_NON_STREAM_TIMEOUT_S,
    previous_requests: Optional[List[str]] = None,
) -> InworldSynthesisResult:
    """Chiamata TTS Inworld non-streaming. Un single-shot, 0 retry.

    Il chiamante gestisce retry/fallback/cache a monte: qui NON facciamo
    retry automatici per rispettare la regola "nessun fallback automatico".

    Args:
        previous_requests: opzionale, lista di testi effettivamente
            sintetizzati in turni precedenti (ordine cronologico), da
            iniettare in ``synthesisContext.previousRequests``. Se
            ``None`` il payload NON contiene il campo (comportamento
            retro-compatibile). Vedi :meth:`InworldVoiceParams.to_payload`.

    Returns:
        :class:`InworldSynthesisResult` — contiene i bytes MP3 completi
        pronti da servire al frontend con media_type ``audio/mpeg``.

    Raises:
        :class:`InworldTTSAuthError` — API key non valida/mancante.
        :class:`InworldTTSRateLimitError` — HTTP 429.
        :class:`InworldTTSBadResponseError` — JSON malformato.
        :class:`InworldTTSTimeoutError` — timeout upstream.
        :class:`InworldTTSError` — tutti gli altri errori.
    """
    text = _validate_text(text)
    api_key = _load_api_key()
    payload = params.to_payload(text, previous_requests=previous_requests)
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
        # Mai includere details sulla request (potrebbe includere URL+params)
        raise InworldTTSError(f"network error: {type(e).__name__}") from e

    api_duration_ms = int((time.perf_counter() - t0) * 1000)
    status = resp.status_code
    req_id = (
        resp.headers.get("x-inworld-request-id")
        or resp.headers.get("x-request-id")
    )

    if status == 401 or status == 403:
        raise InworldTTSAuthError(f"auth refused: HTTP {status}")
    if status == 429:
        raise InworldTTSRateLimitError(f"rate limited: HTTP 429 "
                                       f"req_id={req_id or '?'}")
    if status >= 400:
        # Non logghiamo il body risposta integro perché potrebbe echoare
        # il testo. Logghiamo solo il primo frammento sanificato.
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
        raise InworldTTSBadResponseError(
            f"audio sospettosamente piccolo: {len(audio_bytes)}B"
        )

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
    """Async generator di bytes **MP3 puri** (NO NDJSON, NO Base64).

    Internamente consuma la risposta NDJSON di Inworld
    (``POST /tts/v1/voice:stream``), decodifica ogni chunk Base64 e
    yielda solo l'audio. Il chiamante può passare un ``result_out``
    pre-allocato: alla fine (o alla cancellazione) troverà metriche
    popolate per la telemetria.

    Pattern d'uso tipico (dispatcher backend)::

        result = InworldStreamResult(chars_sent=len(text))
        async def mp3_pipe():
            async for chunk in stream_synthesize(text, params,
                                                 result_out=result):
                yield chunk
        resp = StreamingResponse(mp3_pipe(), media_type="audio/mpeg")
        # dopo che resp è stato consumato → record_tts_event(result)

    Raises (durante il consumo, non alla costruzione):
        Vedi :func:`synthesize_non_streaming`.
    """
    text = _validate_text(text)
    api_key = _load_api_key()
    payload = params.to_payload(text)
    chars_sent = len(text)

    if result_out is None:
        result_out = InworldStreamResult(chars_sent=chars_sent)
    else:
        # consumer può pre-popolare, ma noi comunque forziamo coerenza
        result_out.chars_sent = chars_sent

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

                if resp.status_code == 401 or resp.status_code == 403:
                    raise InworldTTSAuthError(
                        f"auth refused: HTTP {resp.status_code}"
                    )
                if resp.status_code == 429:
                    raise InworldTTSRateLimitError(
                        f"rate limited: HTTP 429 req_id="
                        f"{result_out.request_id or '?'}"
                    )
                if resp.status_code >= 400:
                    raise InworldTTSError(
                        f"upstream HTTP {resp.status_code} "
                        f"req_id={result_out.request_id or '?'}"
                    )

                # NDJSON parsing: ogni linea è un JSON separato con
                # ``{"result": {"audioContent": "<base64>"}}`` oppure
                # ``{"audioContent": "<base64>"}`` + eventuale ``usage``
                # nell'ultimo frame.
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
                            # linea malformata → skip ma non abortire:
                            # Inworld può emettere pulse/keepalive
                            continue
                        # Estrai audioContent da entrambe le forme
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
                                    result_out.first_chunk_ms = int(
                                        (first_chunk_time - t0) * 1000
                                    )
                                result_out.audio_bytes_total += len(mp3_chunk)
                                result_out.chunks_count += 1
                                yield mp3_chunk
                        # usage può arrivare nell'ultimo frame
                        billed = _extract_billed_chars(frame)
                        if billed is not None:
                            result_out.chars_billed = billed
                # Flush buffer finale (se Inworld non manda newline finale)
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
        # Consumer ha cancellato lo stream → telemetria "cancelled"
        result_out.cancelled = True
        result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
        chars_for_cost = (
            result_out.chars_billed
            if result_out.chars_billed is not None else chars_sent
        )
        result_out.estimated_cost_usd = _estimate_cost_usd(chars_for_cost)
        raise  # ri-sollevamo per preservare la semantica di cancellazione
    except httpx.TimeoutException as e:
        result_out.error = "timeout"
        result_out.api_duration_ms = int((time.perf_counter() - t0) * 1000)
        raise InworldTTSTimeoutError(
            f"stream timeout dopo {total_timeout_s}s"
        ) from e
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
# Introspection (per endpoint selftest DRY — nessuna chiamata API)
# =============================================================================
def health_check_config() -> dict:
    """Verifica dry-run: adapter configurato e import OK? NESSUNA chiamata
    HTTP. Nessun segreto esposto nei valori di ritorno."""
    api_key_present = bool(os.environ.get("INWORLD_API_KEY", "").strip())
    return {
        "module_loaded": True,
        "httpx_available": True,
        "api_key_present": api_key_present,
        "endpoint_non_streaming": INWORLD_ENDPOINT_NON_STREAMING,
        "endpoint_streaming": INWORLD_ENDPOINT_STREAMING,
        "default_voice_id": DEFAULT_VOICE_PARAMS.voice_id,
        "default_language": DEFAULT_VOICE_PARAMS.language,
        "default_speaking_rate": DEFAULT_VOICE_PARAMS.speaking_rate,
        "default_delivery_mode": DEFAULT_VOICE_PARAMS.delivery_mode,
        "default_model_id": DEFAULT_VOICE_PARAMS.model_id,
        "rate_per_1m_chars_usd": _rate_per_1m_usd(),
        "non_stream_timeout_s": DEFAULT_NON_STREAM_TIMEOUT_S,
        "stream_total_timeout_s": DEFAULT_STREAM_TOTAL_TIMEOUT_S,
    }
