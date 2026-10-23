"""
Integration test: il dispatcher Inworld è agganciato correttamente ai
percorsi vocali live di server.py (hooks di routing provider).

Specifiche Fabio 2026-10:
  1. server._resolve_tts_pref_for_uid() ritorna la pref salvata e
     ha una cache che si invalida su update.
  2. server._try_inworld_tts_bytes() incapsula tutte le InworldTTSError
     in RuntimeError con prefisso diagnostico — NON si vede mai
     InworldTTSError leak attraverso i path TTS.
  3. Il routing WS (voice/stream) e HTTP (/tts/prepare, /tts/stream)
     NON fa fallback automatico ad ElevenLabs quando Inworld è
     selezionato e fallisce (contratto no-double-charge).

Usiamo mock per non toccare mai l'API Inworld reale.
"""
import os
import sys
import asyncio
from pathlib import Path
from unittest.mock import patch, AsyncMock

import pytest

HERE = Path(__file__).parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))


def test_resolver_default_is_elevenlabs_for_me():
    """Utente anonimo (uid='me') → provider default = elevenlabs."""
    import server as _srv
    loop = asyncio.new_event_loop()
    try:
        pref = loop.run_until_complete(_srv._resolve_tts_pref_for_uid("me"))
        assert pref["provider"] == "elevenlabs"
    finally:
        loop.close()


def test_resolver_handles_none_uid():
    import server as _srv
    loop = asyncio.new_event_loop()
    try:
        pref = loop.run_until_complete(_srv._resolve_tts_pref_for_uid(None))
        assert pref["provider"] == "elevenlabs"
    finally:
        loop.close()


def test_pref_cache_invalidation():
    import server as _srv
    _srv._TTS_PREF_CACHE["fake_uid"] = (1_000_000.0, {"provider": "inworld"})
    _srv._invalidate_tts_pref_cache("fake_uid")
    assert "fake_uid" not in _srv._TTS_PREF_CACHE


def test_try_inworld_wraps_auth_error():
    """Senza INWORLD_API_KEY, l'adapter solleva InworldTTSAuthError.
    Il wrapper _try_inworld_tts_bytes deve propagarlo come RuntimeError.
    """
    import server as _srv

    # Simula modulo disponibile ma key mancante
    assert _srv._INWORLD_WIRED
    orig_env = os.environ.pop("INWORLD_API_KEY", None)
    try:
        loop = asyncio.new_event_loop()
        try:
            with pytest.raises(RuntimeError) as excinfo:
                loop.run_until_complete(
                    _srv._try_inworld_tts_bytes(
                        text="ciao",
                        user_id="test_uid",
                        endpoint="test",
                        voice_key="cielo",
                        tone=None,
                    )
                )
            # Senza key → la risoluzione voce fallisce prima
            # (InworldVoiceNotAvailable se Cielo non ha mapping Inworld, O
            # InworldTTSAuthError se la voce è mappata ma la key manca).
            msg = str(excinfo.value)
            assert any(
                tag in msg
                for tag in ("inworld_auth_missing", "inworld_voice_unavailable")
            ), f"Messaggio inatteso: {msg!r}"
        finally:
            loop.close()
    finally:
        if orig_env is not None:
            os.environ["INWORLD_API_KEY"] = orig_env


def test_try_inworld_no_fallback_to_elevenlabs():
    """Il contratto Fabio: in caso di errore Inworld, il wrapper non
    deve mai tornare un `bytes` ottenuto via ElevenLabs. O rilancia o
    ritorna None (solo se il modulo è completamente scollegato).
    """
    import server as _srv
    # Il modulo È wired → in caso di errore DEVE sollevare RuntimeError.
    assert _srv._INWORLD_WIRED
    # Simula errore upstream Inworld
    orig = _srv._inworld_dispatcher.generate_non_streaming

    async def _raise_timeout(*a, **kw):
        raise _srv._inworld_adapter.InworldTTSTimeoutError("boom")

    _srv._inworld_dispatcher.generate_non_streaming = _raise_timeout
    try:
        loop = asyncio.new_event_loop()
        try:
            with pytest.raises(RuntimeError) as excinfo:
                loop.run_until_complete(
                    _srv._try_inworld_tts_bytes(
                        text="ciao",
                        user_id="t",
                        endpoint="x",
                        voice_key="cielo",
                        tone=None,
                    )
                )
            assert "inworld_timeout" in str(excinfo.value)
        finally:
            loop.close()
    finally:
        _srv._inworld_dispatcher.generate_non_streaming = orig


def test_catalog_endpoint_exposes_inworld_option():
    """Il catalogo pubblico include Inworld tra i provider ammessi."""
    import server as _srv  # noqa: F401
    from fastapi.testclient import TestClient
    import server
    client = TestClient(server.app)
    r = client.get("/api/tts/catalog")
    assert r.status_code == 200
    data = r.json()
    assert "inworld" in data.get("allowed_providers", [])
    assert "elevenlabs" in data.get("allowed_providers", [])
    assert data.get("default_provider") == "elevenlabs"
    assert data.get("label") == "Voce di Ollenya"


def test_dev_inworld_health_endpoint():
    import server
    from fastapi.testclient import TestClient
    client = TestClient(server.app)
    r = client.get("/api/dev/inworld-tts-health")
    assert r.status_code == 200
    data = r.json()
    # Esponiamo solo booleans/strings innocui — mai la key.
    assert "api_key_present" in data
    assert isinstance(data["api_key_present"], bool)
    assert "INWORLD_API_KEY" not in str(data)  # paranoia
