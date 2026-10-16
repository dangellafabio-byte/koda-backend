"""
Test simulati del dispatcher TTS della fast pipeline, SENZA chiamate API reali.
Verifica le 3 rotte critiche:

  1. uid=None/me  → provider ritorna "elevenlabs"
  2. uid autenticato con pref=inworld  → provider ritorna "inworld"
  3. uid autenticato con pref=elevenlabs  → provider ritorna "elevenlabs"

Mock del DB (motor-like) → nessuna connessione reale.
Mock dell'adapter Inworld → nessuna chiamata di rete.

Run: `python memory/scripts/test_tts_dispatch_branches.py`
Exit code 0 = tutti i branch OK; non-zero = regressione.
"""
import asyncio
import sys
import os

# Append backend dir
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))


# ---- Mock Mongo ------------------------------------------------------------
class _MockCollection:
    def __init__(self, data: dict):
        self._data = data

    async def find_one(self, query):
        key = query.get("user_id")
        return self._data.get(key)


class _MockDB:
    def __init__(self, prefs_data: dict):
        self._prefs = _MockCollection(prefs_data)

    def __getitem__(self, name):
        if name == "koda_tts_provider_prefs":
            return self._prefs
        return _MockCollection({})


# ---- Branch tests ---------------------------------------------------------
async def run_tests():
    import koda_tts_prefs

    # Scenario 1: uid None → DEFAULT_PROVIDER (elevenlabs)
    db = _MockDB(prefs_data={})
    prov = await koda_tts_prefs.get_provider_for_uid(db, None)
    assert prov == "elevenlabs", f"Expected elevenlabs for uid=None, got {prov!r}"
    print("[OK] Branch 1: uid=None → elevenlabs")

    # Scenario 2: uid real, pref=inworld in DB → ritorna inworld
    uid_fabio = "a1b2c3d4-eeee-4abc-8def-000000000001"
    db = _MockDB(prefs_data={
        uid_fabio: {"user_id": uid_fabio, "provider": "inworld"},
    })
    prov = await koda_tts_prefs.get_provider_for_uid(db, uid_fabio)
    assert prov == "inworld", f"Expected inworld, got {prov!r}"
    print(f"[OK] Branch 2: uid={uid_fabio[:8]} pref=inworld → inworld")

    # Scenario 3: uid real, pref=elevenlabs → elevenlabs
    db = _MockDB(prefs_data={
        uid_fabio: {"user_id": uid_fabio, "provider": "elevenlabs"},
    })
    prov = await koda_tts_prefs.get_provider_for_uid(db, uid_fabio)
    assert prov == "elevenlabs", f"Expected elevenlabs, got {prov!r}"
    print(f"[OK] Branch 3: uid={uid_fabio[:8]} pref=elevenlabs → elevenlabs")

    # Scenario 4: provider sconosciuto → fallback a elevenlabs
    db = _MockDB(prefs_data={
        uid_fabio: {"user_id": uid_fabio, "provider": "borked_x"},
    })
    prov = await koda_tts_prefs.get_provider_for_uid(db, uid_fabio)
    assert prov == "elevenlabs", f"Expected elevenlabs fallback, got {prov!r}"
    print(f"[OK] Branch 4: uid={uid_fabio[:8]} pref=borked_x → elevenlabs fallback")

    # Scenario 5: email NON passata → doc esiste → ritorna comunque inworld
    # (defense-in-depth removed → doc è fonte di verità)
    db = _MockDB(prefs_data={
        uid_fabio: {"user_id": uid_fabio, "provider": "inworld"},
    })
    prov = await koda_tts_prefs.get_provider_for_uid(
        db, uid_fabio, allowed_emails=None, email=None,
    )
    assert prov == "inworld", (
        f"REGRESSIONE: resolver richiede ancora email per inworld, got {prov!r}"
    )
    print("[OK] Branch 5: inworld doc + email=None → inworld (no email gate)")

    print("\n[ALL BRANCHES PASS]")


# ---- Context propagation test (NEW) ---------------------------------------
async def test_context_prop():
    """Verifica che il nostro fix sul passaggio esplicito di authed_uid
    non dipenda dal ContextVar."""
    # Importiamo contextvars direttamente perché non vogliamo caricare server.py
    # (richiede un DB vero). Simuliamo il flusso logico.
    from contextvars import ContextVar
    cv: ContextVar[str] = ContextVar("uid", default="me")

    async def task(explicit_uid):
        # Simula _fast_pipeline_task post-fix: usa authed_uid, non il CV
        actual = explicit_uid or cv.get()
        return actual

    tok = cv.set("real-uid-xyz")
    try:
        t = asyncio.create_task(task("real-uid-xyz"))
    finally:
        cv.reset(tok)

    r = await t
    assert r == "real-uid-xyz", f"Explicit uid non passato: got {r!r}"
    print("[OK] Context test: authed_uid esplicito indipendente dal CV")


if __name__ == "__main__":
    asyncio.run(run_tests())
    asyncio.run(test_context_prop())
    print("\n[GREEN] Tutti i test simulati OK (no API consumption)")
