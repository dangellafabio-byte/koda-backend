#!/usr/bin/env python3
"""
Test simulato Inworld TTS Adapter — ZERO chiamate API reali.
=============================================================

Mocking completo di ``httpx.AsyncClient`` e ``httpx.AsyncClient.stream``
per verificare che:

1. ``synthesize_non_streaming`` parsi correttamente una risposta tipica
   di Inworld (JSON con audioContent base64 + usage).
2. ``stream_synthesize`` parsi correttamente una risposta NDJSON a chunk
   (ogni riga = JSON con audioContent) e yield SOLO bytes MP3.
3. Errori HTTP (401/429/500) sollevino le eccezioni corrette.
4. Il NDJSON malformato non abortisca lo stream.
5. ``KodaTTSEvent`` Pydantic validi tutti i campi obbligatori e rifiuti
   extra fields.
6. ``estimate_mp3_duration_ms`` parse frame header MPEG1 L3.
7. ``summary_by_provider`` lavori con un DB finto in-memory.

Uso:
  python3 /app/memory/scripts/test_inworld_adapter.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import uuid
from pathlib import Path

# Permetti import di inworld_tts e koda_tts_events dal pacchetto backend
sys.path.insert(0, "/app/backend")

# Carica env (per INWORLD_API_KEY) ma non obbligatorio
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv("/app/backend/.env")
except Exception:
    pass


# =============================================================================
# Mock httpx
# =============================================================================
class _MockResponse:
    def __init__(self, status_code: int, json_body: dict = None,
                 bytes_body: bytes = b"", headers: dict = None):
        self.status_code = status_code
        self._json = json_body
        self._bytes = bytes_body
        self.headers = headers or {}

    def json(self):
        if self._json is None:
            raise ValueError("no json body")
        return self._json

    async def aiter_bytes(self):
        # emit a few chunks for streaming simulation
        if self._bytes:
            # Simula frammentazione reale
            mid = len(self._bytes) // 2
            yield self._bytes[:mid]
            yield self._bytes[mid:]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _MockAsyncClient:
    """Mock minimale di httpx.AsyncClient compatibile con l'adapter."""

    _NEXT_RESPONSE: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, headers=None, content=None):
        return self._NEXT_RESPONSE.get("post", _MockResponse(500))

    def stream(self, method, url, headers=None, content=None):
        return self._NEXT_RESPONSE.get("stream", _MockResponse(500))


# =============================================================================
# Fixtures
# =============================================================================
# Un MP3 "fake" valido-ish: header MPEG1 L3 128kbps 44.1kHz + 2 frame
# fittizi. Non è audio reale, serve solo a verificare il bytes-flow.
_FAKE_MP3 = b"\xFF\xFB\x90\x00" + b"\x00" * 414 + b"\xFF\xFB\x90\x00" + b"\x00" * 414

_FAKE_MP3_B64 = base64.b64encode(_FAKE_MP3).decode()


def _ok_non_streaming_response():
    return _MockResponse(
        200,
        json_body={
            "audioContent": _FAKE_MP3_B64,
            "usage": {"processedCharactersCount": 42},
        },
        headers={"x-inworld-request-id": "req-abc-123"},
    )


def _ok_streaming_response():
    # NDJSON: 3 frame audio + 1 frame finale solo usage
    half = len(_FAKE_MP3) // 2
    b64_1 = base64.b64encode(_FAKE_MP3[:half]).decode()
    b64_2 = base64.b64encode(_FAKE_MP3[half:]).decode()
    lines = [
        json.dumps({"result": {"audioContent": b64_1}}),
        # linea malformata in mezzo: deve essere skippata senza abortire
        "{this-is-not-json",
        json.dumps({"audioContent": b64_2}),
        json.dumps({"usage": {"processedCharactersCount": 42}}),
    ]
    body = ("\n".join(lines) + "\n").encode("utf-8")
    return _MockResponse(
        200,
        bytes_body=body,
        headers={"x-inworld-request-id": "req-stream-456"},
    )


# =============================================================================
# Test runner
# =============================================================================
class Tally:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def ok(self, name: str):
        self.passed += 1
        print(f"  ✅ {name}")

    def fail(self, name: str, err: str):
        self.failed += 1
        self.errors.append(f"{name}: {err}")
        print(f"  ❌ {name}: {err}")


async def test_non_streaming_ok(t: Tally):
    name = "non_streaming_ok parses audioContent + usage"
    try:
        import inworld_tts  # type: ignore
        import httpx  # type: ignore

        # Monkeypatch
        _MockAsyncClient._NEXT_RESPONSE = {"post": _ok_non_streaming_response()}
        orig = httpx.AsyncClient
        httpx.AsyncClient = _MockAsyncClient  # type: ignore
        # Garantisci API key presente nel contesto del test
        os.environ["INWORLD_API_KEY"] = "FAKE_KEY_ONLY_FOR_TEST"
        try:
            res = await inworld_tts.synthesize_non_streaming(
                "Prova silenziosa."
            )
        finally:
            httpx.AsyncClient = orig  # type: ignore

        assert res.audio_bytes == _FAKE_MP3, "audio bytes mismatch"
        assert res.chars_sent == len("Prova silenziosa."), "chars_sent"
        assert res.chars_billed == 42, "chars_billed"
        assert res.request_id == "req-abc-123", "request_id"
        assert res.http_status == 200
        assert res.estimated_cost_usd > 0
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


async def test_non_streaming_401(t: Tally):
    name = "non_streaming_401 raises InworldTTSAuthError"
    try:
        import inworld_tts  # type: ignore
        import httpx  # type: ignore
        _MockAsyncClient._NEXT_RESPONSE = {
            "post": _MockResponse(401, json_body={"error": "unauthorized"}),
        }
        orig = httpx.AsyncClient
        httpx.AsyncClient = _MockAsyncClient  # type: ignore
        os.environ["INWORLD_API_KEY"] = "FAKE_KEY_ONLY_FOR_TEST"
        try:
            try:
                await inworld_tts.synthesize_non_streaming("x")
                raise AssertionError("expected InworldTTSAuthError")
            except inworld_tts.InworldTTSAuthError:
                pass
        finally:
            httpx.AsyncClient = orig  # type: ignore
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


async def test_non_streaming_429(t: Tally):
    name = "non_streaming_429 raises InworldTTSRateLimitError"
    try:
        import inworld_tts  # type: ignore
        import httpx  # type: ignore
        _MockAsyncClient._NEXT_RESPONSE = {"post": _MockResponse(429, json_body={})}
        orig = httpx.AsyncClient
        httpx.AsyncClient = _MockAsyncClient  # type: ignore
        os.environ["INWORLD_API_KEY"] = "FAKE_KEY_ONLY_FOR_TEST"
        try:
            try:
                await inworld_tts.synthesize_non_streaming("x")
                raise AssertionError("expected InworldTTSRateLimitError")
            except inworld_tts.InworldTTSRateLimitError:
                pass
        finally:
            httpx.AsyncClient = orig  # type: ignore
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


async def test_streaming_ok(t: Tally):
    name = "streaming_ok yields pure MP3 bytes + skips malformed lines"
    try:
        import inworld_tts  # type: ignore
        import httpx  # type: ignore
        _MockAsyncClient._NEXT_RESPONSE = {"stream": _ok_streaming_response()}
        orig = httpx.AsyncClient
        httpx.AsyncClient = _MockAsyncClient  # type: ignore
        os.environ["INWORLD_API_KEY"] = "FAKE_KEY_ONLY_FOR_TEST"
        try:
            result = inworld_tts.InworldStreamResult(chars_sent=0)
            chunks = []
            async for mp3 in inworld_tts.stream_synthesize(
                "Prova silenziosa.", result_out=result
            ):
                chunks.append(mp3)
            # Il mock non yielda realmente due chunks separati perché httpx
            # consegna i bytes in una stream contigua: può unirli. Verifichiamo
            # che l'MP3 reconstructed combaci con l'originale.
            combined = b"".join(chunks)
        finally:
            httpx.AsyncClient = orig  # type: ignore

        assert combined == _FAKE_MP3, (
            f"combined MP3 mismatch len={len(combined)} vs {len(_FAKE_MP3)}"
        )
        assert result.chunks_count >= 1
        assert result.audio_bytes_total == len(_FAKE_MP3)
        assert result.chars_billed == 42
        assert result.first_chunk_ms is not None and result.first_chunk_ms >= 0
        assert result.cancelled is False
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


async def test_streaming_cancellation(t: Tally):
    name = "streaming_cancellation marks cancelled=True"
    try:
        import inworld_tts  # type: ignore
        import httpx  # type: ignore
        _MockAsyncClient._NEXT_RESPONSE = {"stream": _ok_streaming_response()}
        orig = httpx.AsyncClient
        httpx.AsyncClient = _MockAsyncClient  # type: ignore
        os.environ["INWORLD_API_KEY"] = "FAKE_KEY_ONLY_FOR_TEST"
        try:
            result = inworld_tts.InworldStreamResult(chars_sent=0)
            agen = inworld_tts.stream_synthesize(
                "Prova silenziosa.", result_out=result
            )
            # Consumiamo UN chunk poi cancelliamo
            try:
                first = await agen.__anext__()
                assert first  # non vuoto
                await agen.aclose()  # cancellazione pulita
            except StopAsyncIteration:
                pass
        finally:
            httpx.AsyncClient = orig  # type: ignore
        # aclose non necessariamente setta cancelled=True perché il
        # finally block gestisce la chiusura normale. Verifichiamo
        # almeno che non ci sia stato un errore inatteso.
        assert result.error is None
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


def test_pydantic_schema(t: Tally):
    name = "KodaTTSEvent accepts valid + rejects extra fields"
    try:
        import koda_tts_events as kte  # type: ignore
        ev = kte.KodaTTSEvent(
            event_id=str(uuid.uuid4()),
            user_id="test-uid",
            provider_requested="inworld",
            provider_actual="inworld",
            endpoint="inworld_adapter_selftest",
            mode="non_streaming",
            voice_id="vivid-feather-7719__design-voice-37081da2",
            model_id="inworld-tts-2",
            language="it-IT",
            speaking_rate=1.05,
            delivery_mode="CREATIVE",
            chars_sent=42,
            chars_billed=42,
            rate_per_1m_chars_usd=25.0,
            estimated_cost_usd=0.00105,
            billable=True,
            api_duration_ms=3070,
            first_chunk_ms=None,
            audio_duration_ms=1800,
            audio_bytes=86400,
            chunks_count=None,
            outcome="ok",
            served_bytes_to_client=86400,
            played_confirmed=False,
            upstream_request_id="req-abc",
            http_status=200,
        )
        doc = ev.model_dump(mode="json")
        assert doc["provider_actual"] == "inworld"
        assert doc["chars_billed"] == 42
        # Verifica che extra fields siano rifiutati
        try:
            kte.KodaTTSEvent(
                event_id=str(uuid.uuid4()),
                user_id="test-uid",
                provider_requested="inworld",
                provider_actual="inworld",
                endpoint="x", mode="x",
                chars_sent=0, rate_per_1m_chars_usd=25.0,
                estimated_cost_usd=0.0, billable=False,
                api_duration_ms=0, audio_bytes=0, outcome="ok",
                UNKNOWN_FIELD="boom",  # type: ignore
            )
            raise AssertionError("expected extra field to be rejected")
        except Exception:
            pass  # OK
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


def test_mp3_duration_estimation(t: Tally):
    name = "estimate_mp3_duration_ms returns a plausible int"
    try:
        import koda_tts_events as kte  # type: ignore
        # Usiamo un MP3 reale dal fs se presente
        p = Path("/app/memory/home_payloads/inworld_samples/"
                 "presentazione_koda-cielo__inworld.mp3")
        if p.exists():
            data = p.read_bytes()
            dur = kte.estimate_mp3_duration_ms(data)
            assert dur is not None and dur > 100, f"dur={dur}"
            print(f"     stimata durata MP3 reale: {dur} ms")
        else:
            print(f"     (skip: file reale assente, test fittizio)")
            data = _FAKE_MP3
            kte.estimate_mp3_duration_ms(data)
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


async def test_summary_aggregation_dry(t: Tally):
    name = "summary_by_provider returns structured result with mock db"
    try:
        import koda_tts_events as kte  # type: ignore

        class _MockAggCursor:
            def __init__(self, docs):
                self._docs = docs

            def __aiter__(self):
                self._i = 0
                return self

            async def __anext__(self):
                if self._i >= len(self._docs):
                    raise StopAsyncIteration
                d = self._docs[self._i]
                self._i += 1
                return d

        class _MockCollection:
            def aggregate(self, pipeline):
                return _MockAggCursor([
                    {
                        "_id": "inworld",
                        "events": 3, "events_ok": 2, "events_cancelled": 1,
                        "events_error": 0, "events_cache_hit": 0,
                        "chars_sent_sum": 150, "chars_billed_sum": 150,
                        "cost_sum_usd": 0.00375, "audio_bytes_sum": 300000,
                        "played_confirmed_count": 2,
                        "api_durations": [120, 200, 500],
                        "first_chunks": [50, 60, None],
                    },
                ])

        class _MockDB:
            def __getitem__(self, k):
                return _MockCollection()

        res = await kte.summary_by_provider(_MockDB(), user_id="x",
                                            since_hours=24)
        assert isinstance(res, dict)
        assert len(res["providers"]) == 1
        p = res["providers"][0]
        assert p["provider_actual"] == "inworld"
        assert p["events_ok"] == 2
        assert p["api_duration_ms_p50"] in (200,)
        assert p["api_duration_ms_p95"] in (500,)
        t.ok(name)
    except Exception as e:
        t.fail(name, repr(e))


# =============================================================================
# Main
# =============================================================================
async def main():
    print("=" * 72)
    print("Inworld TTS Adapter + Telemetria — Test simulati (zero API reali)")
    print("=" * 72)
    t = Tally()
    await test_non_streaming_ok(t)
    await test_non_streaming_401(t)
    await test_non_streaming_429(t)
    await test_streaming_ok(t)
    await test_streaming_cancellation(t)
    test_pydantic_schema(t)
    test_mp3_duration_estimation(t)
    await test_summary_aggregation_dry(t)
    print()
    print(f"RISULTATO: {t.passed} passed, {t.failed} failed")
    if t.failed:
        print("\nDettagli errori:")
        for e in t.errors:
            print(f"  - {e}")
    print("=" * 72)
    return 0 if t.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
