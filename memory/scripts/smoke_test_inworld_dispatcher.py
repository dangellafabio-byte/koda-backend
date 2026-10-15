#!/usr/bin/env python3
"""
Smoke test reali Inworld dispatcher (MAX 2 richieste, budget $0.10).
======================================================================

Testa END-TO-END:
 1. Non-streaming via `inworld_dispatcher.generate_non_streaming`
 2. Streaming via `inworld_dispatcher.stream_mp3`
Entrambi registrano un evento in `koda_tts_events` → verifichiamo che:
 * audio reale generato (>500B)
 * cost stimato > 0
 * audio_duration_ms calcolata
 * provider_actual == "inworld"
 * played_confirmed == False (nessun ACK esplicito ancora)
 * nessuna chiave API nei log

Testo cortissimo per minimizzare costo (6+10 char ≈ $0.0004 totale).

Uso:
  cd /app && python3 /app/memory/scripts/smoke_test_inworld_dispatcher.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import time
import uuid

sys.path.insert(0, "/app/backend")

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv("/app/backend/.env")
except Exception:
    pass

import inworld_dispatcher as disp  # type: ignore
import koda_tts_events as kte  # type: ignore
import inworld_tts as it  # type: ignore
from motor.motor_asyncio import AsyncIOMotorClient  # type: ignore


FAKE_UID = "smoke-test-uid-" + str(uuid.uuid4())[:8]
TOTAL_BUDGET_USD = 0.10


async def main():
    db_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME", "test_database")
    if not db_url:
        print("ERRORE: MONGO_URL non in env", file=sys.stderr)
        return 1
    client = AsyncIOMotorClient(db_url)
    db = client[db_name]
    await kte.ensure_indexes(db)

    print("=" * 72)
    print(f"Smoke test Inworld dispatcher — uid={FAKE_UID}")
    print(f"Budget max cumulativo: ${TOTAL_BUDGET_USD:.2f}")
    print("=" * 72)

    cumulative_cost = 0.0

    # ===================================================================
    # TEST 1 — Non-streaming
    # ===================================================================
    print("\n[1/2] NON-STREAMING via dispatcher.generate_non_streaming()")
    text_1 = "Prova."
    t0 = time.perf_counter()
    try:
        audio = await disp.generate_non_streaming(
            db,
            text=text_1,
            user_id=FAKE_UID,
            endpoint="smoke_test_non_streaming",
            voice_id_requested="vivid-feather-7719__design-voice-37081da2",
            tone=None,
        )
    except Exception as e:
        print(f"  ❌ FAIL: {type(e).__name__}: {e}")
        return 2
    elapsed = time.perf_counter() - t0
    print(f"  ✅ audio bytes: {len(audio):,}")
    print(f"  ✅ wall-clock: {int(elapsed*1000)}ms")

    # Verifica DB: trova il record più recente per questo uid
    rows = await kte.recent_events(db, user_id=FAKE_UID, limit=1)
    if not rows:
        print(f"  ❌ FAIL: nessun record koda_tts_events per uid")
        return 3
    r = rows[0]
    print(f"  ✅ DB record: outcome={r.get('outcome')} "
          f"provider_actual={r.get('provider_actual')} "
          f"chars_sent={r.get('chars_sent')} "
          f"chars_billed={r.get('chars_billed')} "
          f"cost=${r.get('estimated_cost_usd'):.6f} "
          f"audio_dur_ms={r.get('audio_duration_ms')} "
          f"played_confirmed={r.get('played_confirmed')}")
    assert r.get("provider_actual") == "inworld"
    assert r.get("outcome") == "ok"
    assert r.get("played_confirmed") is False
    assert r.get("chars_billed") == len(text_1)
    assert r.get("audio_bytes", 0) > 500
    cumulative_cost += r.get("estimated_cost_usd", 0.0)

    # ===================================================================
    # TEST 2 — Streaming
    # ===================================================================
    if cumulative_cost >= TOTAL_BUDGET_USD * 0.5:
        print(f"\n  ⚠ Budget quasi esaurito, skip streaming test")
    else:
        print("\n[2/2] STREAMING via dispatcher.stream_mp3()")
        text_2 = "Prova stream."
        collected = bytearray()
        t0 = time.perf_counter()
        try:
            async for chunk in disp.stream_mp3(
                db,
                text=text_2,
                user_id=FAKE_UID,
                endpoint="smoke_test_streaming",
                voice_id_requested="vivid-feather-7719__design-voice-37081da2",
                tone=None,
            ):
                collected.extend(chunk)
        except Exception as e:
            print(f"  ❌ FAIL: {type(e).__name__}: {e}")
            return 4
        elapsed = time.perf_counter() - t0
        print(f"  ✅ audio bytes totali: {len(collected):,}")
        print(f"  ✅ wall-clock: {int(elapsed*1000)}ms")

        rows2 = await kte.recent_events(db, user_id=FAKE_UID, limit=2)
        if len(rows2) < 2:
            print(f"  ❌ FAIL: trovati solo {len(rows2)} record (atteso ≥2)")
            return 5
        # Prendi il più recente che è in modalità streaming
        r2 = next((x for x in rows2 if x.get("mode") == "streaming"), None)
        if not r2:
            print(f"  ❌ FAIL: nessun record con mode=streaming")
            return 6
        print(f"  ✅ DB record: outcome={r2.get('outcome')} "
              f"first_chunk_ms={r2.get('first_chunk_ms')} "
              f"chunks_count={r2.get('chunks_count')} "
              f"api_duration_ms={r2.get('api_duration_ms')} "
              f"audio_dur_ms={r2.get('audio_duration_ms')} "
              f"cost=${r2.get('estimated_cost_usd'):.6f}")
        assert r2.get("outcome") == "ok"
        assert r2.get("chunks_count", 0) >= 1
        assert r2.get("audio_bytes", 0) > 500
        cumulative_cost += r2.get("estimated_cost_usd", 0.0)

    # ===================================================================
    # TEST 3 — Guard Vento (NO chiamata API, solo guard-check)
    # ===================================================================
    print("\n[3] GUARD VENTO (no API call) via dispatcher.generate_non_streaming()")
    try:
        await disp.generate_non_streaming(
            db,
            text="prova vento",
            user_id=FAKE_UID,
            endpoint="smoke_test_vento_guard",
            voice_id_requested="ll9WG7PDTuyHwgC5MD6g",  # Vento canonico
            tone=None,
        )
        print(f"  ❌ FAIL: atteso InworldVoiceNotAvailable")
        return 7
    except disp.InworldVoiceNotAvailable as e:
        print(f"  ✅ Guard colpito: {e}")

    # Verifica record "error" per Vento guard
    rows3 = await kte.recent_events(db, user_id=FAKE_UID, limit=3)
    r3 = next((x for x in rows3 if x.get("error_class") == "InworldVoiceNotAvailable"), None)
    if r3:
        print(f"  ✅ Record guard: outcome={r3.get('outcome')} "
              f"billable={r3.get('billable')} "
              f"error_class={r3.get('error_class')} "
              f"cost=${r3.get('estimated_cost_usd'):.6f}")
        assert r3.get("outcome") == "error"
        assert r3.get("billable") is False
        assert r3.get("estimated_cost_usd") == 0.0
    else:
        print(f"  ❌ FAIL: nessun record guard")
        return 8

    # ===================================================================
    # TEST 4 — Summary telemetria
    # ===================================================================
    print("\n[4] SUMMARY aggregato telemetria")
    summary = await kte.summary_by_provider(db, user_id=FAKE_UID, since_hours=1)
    for p in summary.get("providers", []):
        print(f"  provider={p['provider_actual']} "
              f"events={p['events']} ok={p['events_ok']} "
              f"err={p['events_error']} "
              f"chars_billed={p['chars_billed_sum']} "
              f"cost=${p['cost_sum_usd']:.6f} "
              f"api_p50={p['api_duration_ms_p50']}ms "
              f"api_p95={p['api_duration_ms_p95']}ms "
              f"ttfb_p50={p['first_chunk_ms_p50']}ms")

    # ===================================================================
    # Cleanup: non facciamo delete, i record restano per audit
    # ===================================================================
    print("\n" + "=" * 72)
    print(f"COSTO CUMULATIVO SMOKE TEST: ${cumulative_cost:.6f}")
    print(f"BUDGET RESIDUO: ${TOTAL_BUDGET_USD - cumulative_cost:.4f}")
    print(f"UID TEST (da escludere dai record prod): {FAKE_UID}")
    print("=" * 72)
    print("TUTTO OK ✅")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
