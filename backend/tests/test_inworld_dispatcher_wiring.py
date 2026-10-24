"""
Integration test: il dispatcher Inworld è agganciato ai percorsi vocali
live di server.py tramite il resolver provider ``_tts_provider_for_uid``
(e la variante da ContextVar ``_tts_provider_for_current_user``).

Fase 2026-10 (merge main + update/ollenya-inworld-20261023):
   * UN SOLO percorso provider: ``koda_tts_prefs.get_provider_for_uid``
     è la fonte di verità, letta via resolver di main.
   * ``_try_inworld_tts_bytes`` NON ESISTE: la generazione live chiama
     direttamente ``_inworld_dispatcher.generate_non_streaming()`` /
     ``stream_mp3()`` da dentro i blocchi `_tts_provider_* == "inworld"
     and _INWORLD_ADAPTER_AVAILABLE`.

Usiamo mock per non toccare mai l'API Inworld reale.
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))


def test_resolver_default_is_elevenlabs_for_me():
    """Resolver esplicito con uid='me' → default elevenlabs."""
    import server as _srv
    loop = asyncio.new_event_loop()
    try:
        p = loop.run_until_complete(_srv._tts_provider_for_uid("me"))
        assert p == "elevenlabs"
    finally:
        loop.close()


def test_resolver_handles_none_uid():
    import server as _srv
    loop = asyncio.new_event_loop()
    try:
        p = loop.run_until_complete(_srv._tts_provider_for_uid(None))
        assert p == "elevenlabs"
    finally:
        loop.close()


def test_resolver_handles_anon_uid():
    import server as _srv
    loop = asyncio.new_event_loop()
    try:
        p = loop.run_until_complete(_srv._tts_provider_for_uid("anon"))
        assert p == "elevenlabs"
    finally:
        loop.close()


def test_current_user_resolver_default():
    """Resolver context-based senza request → elevenlabs."""
    import server as _srv
    loop = asyncio.new_event_loop()
    try:
        p = loop.run_until_complete(_srv._tts_provider_for_current_user())
        assert p == "elevenlabs"
    finally:
        loop.close()


def test_dispatcher_wrapps_auth_error():
    """Senza INWORLD_API_KEY, il dispatcher solleva InworldTTSAuthError
    (o un altro errore chiaro). Il server lo intercetta nei blocchi
    `inworld_tts.InworldTTSError`. Qui verifichiamo che l'adapter puro
    la propaga correttamente.
    """
    import inworld_tts as _ad
    orig_key = os.environ.pop("INWORLD_API_KEY", None)
    try:
        with pytest.raises(_ad.InworldTTSAuthError):
            _ad._load_api_key()
    finally:
        if orig_key is not None:
            os.environ["INWORLD_API_KEY"] = orig_key


def test_catalog_endpoint_exposes_inworld_option():
    """Il catalogo pubblico include Inworld tra i provider ammessi."""
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
    assert isinstance(
        data.get("providers_meta", {}).get("inworld", {}).get("model_locked"),
        bool,
    )


def test_preferences_endpoint_requires_auth():
    """Senza Bearer token → 401 (contratto auth-bound)."""
    from fastapi.testclient import TestClient
    import server
    client = TestClient(server.app)
    r = client.get("/api/tts/preferences")
    assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"


def test_dispatcher_import_contract():
    """Il dispatcher espone le due funzioni che server.py chiama."""
    import inworld_dispatcher as d
    import inspect
    for name in ("generate_non_streaming", "stream_mp3"):
        fn = getattr(d, name, None)
        assert fn is not None, f"{name} missing"
        sig = inspect.signature(fn)
        kwargs = list(sig.parameters.keys())
        # Firma attesa dopo merge
        assert "voice_id_requested" in kwargs, (
            f"{name} manca di voice_id_requested; segno di dispatcher incompatibile"
        )
        assert "tone" in kwargs
        assert "endpoint" in kwargs
        assert "user_id" in kwargs
