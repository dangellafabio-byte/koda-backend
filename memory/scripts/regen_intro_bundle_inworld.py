#!/usr/bin/env python3
"""
Ollenya — Rigenerazione bundle intro con Inworld TTS-2 (one-shot batch).
========================================================================

Contratto operativo (approvato Fabio 2026-10):
 * 1 chiamata per clip, 0 retry, 0 fallback automatico.
 * Parametri FISSI: voce `vivid-feather-7719__design-voice-37081da2`,
   model `inworld-tts-2`, language `it-IT`, speakingRate 1.05,
   deliveryMode CREATIVE, MP3 default.
 * Nessun asset legacy toccato: scrivo in cartelle NUOVE
   (`intro-inworld/`, `lascia-andare-inworld/`, `audio-inworld/`)
   affianco alle originali, mai sovrascrivendo.
 * Se un file esiste già nella destinazione → SKIP (no rigenerazione).
 * Log costo caratteri reali (billed) riportati da Inworld dove disponibili.

Uso:
  python3 /app/memory/scripts/regen_intro_bundle_inworld.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


# ============================================================================
# Testi — recuperati dai sorgenti attivi (post-conferma trascrizione)
# ============================================================================
# Rotta → testo esatto. Cartella e nome preservati per 1:1 mapping con
# gli asset ElevenLabs correnti; cambia solo la cartella madre.
CLIPS = [
    # Intro V3 (prima apertura)
    ("intro-inworld/intro_v3_parte_di_me-cielo.mp3",
     "Voglio farti conoscere una parte di me."),

    # Lascia Andare — firstBoot
    ("intro-inworld/la_cuore-cielo.mp3",
     "Questo è il mio cuore, è tuo… qui puoi dire tutto quello che vuoi "
     "senza usare i freni né limiti, qui sei adesso nel tuo spazio "
     "dove nessuno ti può sentire."),
    ("intro-inworld/la_provalo-cielo.mp3",
     "Provalo."),

    # Lascia Andare — rituale open/close (solo Cielo per questa fase)
    ("lascia-andare-inworld/open-cielo.mp3",
     "Prenditi il tuo tempo."),
    ("lascia-andare-inworld/close-cielo.mp3",
     "Grazie per averlo lasciato andare."),

    # Heart Voice Reveal (post-LA)
    ("intro-inworld/reveal_cuore_voce-cielo.mp3",
     "Questo è il mio cuore. È tuo, sempre, gratuitamente. "
     "Ma ho anche una voce. Se vuoi, posso parlarti davvero."),

    # Microdemo
    ("intro-inworld/microdemo_open-cielo.mp3",
     "Eccomi. Dimmi qualcosa, quello che vuoi."),
    ("intro-inworld/microdemo_close-cielo.mp3",
     "Per ora è tutto. Ma possiamo continuare, se vuoi."),

    # Paywall post-demo
    ("intro-inworld/paywall_voce-cielo.mp3",
     "Questa è la mia voce. Il cuore resta sempre tuo, gratis. "
     "La voce, se vuoi che resti con te, è Premium."),

    # Intro Premium (tour post-paywall) — testo recuperato via STT 2026-10
    ("intro-inworld/intro_premium_eccomi-cielo.mp3",
     "Eccomi. Ora hai anche la mia voce. Toccami quando sei pronto."),
    ("intro-inworld/intro_premium_closing-cielo.mp3",
     "Adesso ci siamo. Cominciamo."),

    # Quota exhausted — pre-registrato (percorso /audio/, non /sounds/intro/)
    ("audio-inworld/koda_quota_exhausted.mp3",
     "Hai finito i minuti voce di questo mese. "
     "La voce ha bisogno di minuti che ora non hai più. "
     "Continuiamo in chat scritta, sono qui. "
     "Se vuoi, aggiungi trenta minuti dalla home."),
]

FRONTEND_ASSETS_ROOT = Path("/app/frontend/assets")
SOUNDS_ROOT = FRONTEND_ASSETS_ROOT / "sounds"

INWORLD_ENDPOINT = "https://api.inworld.ai/tts/v1/voice"
VOICE_PARAMS = {
    "modelId": "inworld-tts-2",
    "voiceId": "vivid-feather-7719__design-voice-37081da2",
    "language": "it-IT",
    "speakingRate": 1.05,
    "deliveryMode": "CREATIVE",
    "audioConfig": {"audioEncoding": "MP3"},
}
RATE_PER_1M_USD = float(os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD", "25.00"))


def load_env() -> None:
    env_path = Path("/app/backend/.env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def generate_one(api_key: str, text: str) -> tuple[bytes, dict, dict]:
    """Ritorna (audio_bytes, usage, http_info). Zero retry.
    Solleva su qualunque errore HTTP."""
    body = dict(VOICE_PARAMS)
    body["text"] = text
    req = urllib.request.Request(
        INWORLD_ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Basic {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Ollenya-TTS-Batch/1.0",
        },
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as resp:
        status = resp.status
        headers = dict(resp.headers.items())
        payload_raw = resp.read()
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    payload = json.loads(payload_raw.decode("utf-8"))
    audio_b64 = (
        payload.get("audioContent")
        or (payload.get("result") or {}).get("audioContent")
        or ""
    )
    if not audio_b64:
        raise RuntimeError("no audioContent in response")
    audio_bytes = base64.b64decode(audio_b64)
    usage = payload.get("usage") or (payload.get("result") or {}).get("usage") or {}
    http_info = {
        "status": status,
        "elapsed_ms": elapsed_ms,
        "request_id": headers.get("x-inworld-request-id")
                      or headers.get("x-request-id"),
    }
    return audio_bytes, usage, http_info


def main() -> int:
    load_env()
    api_key = os.environ.get("INWORLD_API_KEY", "").strip()
    if not api_key:
        print("ERRORE: INWORLD_API_KEY non configurata", file=sys.stderr)
        return 2

    print("=" * 72)
    print("Ollenya — Rigenerazione bundle intro Inworld (one-shot)")
    print(f"  Voice:   {VOICE_PARAMS['voiceId']}")
    print(f"  Model:   {VOICE_PARAMS['modelId']}")
    print(f"  Rate:    {VOICE_PARAMS['speakingRate']}  Delivery: {VOICE_PARAMS['deliveryMode']}")
    print(f"  Tariffa: ${RATE_PER_1M_USD:.2f}/1M char")
    print("=" * 72)

    total_sent = 0
    total_billed = 0
    total_bytes = 0
    total_cost_usd = 0.0
    total_api_ms = 0
    generated = 0
    skipped = 0
    failed_clips: list[str] = []

    for rel_path, text in CLIPS:
        chars = len(text)
        full = SOUNDS_ROOT / rel_path if rel_path.startswith(("intro-inworld", "lascia-andare-inworld")) \
            else FRONTEND_ASSETS_ROOT / rel_path
        full.parent.mkdir(parents=True, exist_ok=True)

        if full.exists() and full.stat().st_size > 1024:
            print(f"  ⊙ SKIP  {rel_path}  (già presente, {full.stat().st_size:,}B)")
            skipped += 1
            continue

        print(f"  → {rel_path}  ({chars} char)… ", end="", flush=True)
        try:
            audio_bytes, usage, http_info = generate_one(api_key, text)
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="replace")[:200]
            except Exception:
                pass
            print(f"HTTP {e.code}  {err_body}")
            failed_clips.append(f"{rel_path} HTTP {e.code}")
            continue
        except Exception as e:
            print(f"FAIL  {type(e).__name__}: {e}")
            failed_clips.append(f"{rel_path} {type(e).__name__}")
            continue

        if len(audio_bytes) < 500:
            print(f"FAIL  audio sospettosamente piccolo ({len(audio_bytes)}B)")
            failed_clips.append(f"{rel_path} too_small")
            continue

        full.write_bytes(audio_bytes)
        billed = (
            usage.get("processedCharactersCount")
            or usage.get("characterCount")
            or usage.get("inputCharacters")
            or chars  # fallback: assumi che sent == billed
        )
        clip_cost = (billed * RATE_PER_1M_USD) / 1_000_000.0
        total_sent += chars
        total_billed += billed if isinstance(billed, int) else chars
        total_bytes += len(audio_bytes)
        total_cost_usd += clip_cost
        total_api_ms += http_info["elapsed_ms"]
        generated += 1
        print(
            f"OK  {len(audio_bytes):>6,}B  "
            f"billed={billed} chars  "
            f"${clip_cost:.6f}  "
            f"{http_info['elapsed_ms']:>4}ms  "
            f"req_id={http_info['request_id'] or '?'}"
        )

    print("=" * 72)
    print(f"Generate: {generated}  Skipped: {skipped}  Failed: {len(failed_clips)}")
    print(f"Caratteri inviati:  {total_sent}")
    print(f"Caratteri billed:   {total_billed}")
    print(f"Bytes totali MP3:   {total_bytes:,}")
    print(f"API latency sum:    {total_api_ms} ms")
    print(f"Costo stimato:      ${total_cost_usd:.6f}  ({total_cost_usd*100:.4f} ¢)")
    if failed_clips:
        print("Fallimenti:")
        for f in failed_clips:
            print(f"  - {f}")
    print("=" * 72)
    return 0 if not failed_clips else 1


if __name__ == "__main__":
    sys.exit(main())
