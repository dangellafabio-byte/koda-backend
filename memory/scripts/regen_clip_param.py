#!/usr/bin/env python3
"""
Ollenya — Generazione singola clip Inworld TTS-2 (parametrizzata)
==================================================================

Variante parametrizzata di regen_single_clip.py: accetta TEXT e OUT_FILENAME
come argomenti CLI così possiamo generare qualunque frase senza duplicare
codice. Resta valido il contratto: UNA SOLA richiesta HTTP, 0 retry.

Uso:
  python3 /app/memory/scripts/regen_clip_param.py \
      --text "Ciao, come stai?" \
      --out  "ciao_come_stai__inworld.mp3" \
      [--voice vivid-feather-7719__design-voice-37081da2] \
      [--rate 1.05] \
      [--delivery CREATIVE] \
      [--language it-IT]

Garanzie:
  * UNA sola richiesta a Inworld, nessun retry, nessun loop.
  * Zero modifiche al backend produttivo.
  * API key letta da env (INWORLD_API_KEY), mai stampata.
  * Timeout 60s.
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


INWORLD_ENDPOINT = "https://api.inworld.ai/tts/v1/voice"
OUT_DIR = Path("/app/memory/home_payloads/inworld_samples")


def load_env_from_dotenv() -> None:
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


def main() -> int:
    p = argparse.ArgumentParser(description="Inworld TTS-2 single-shot generator")
    p.add_argument("--text", required=True, help="Testo da sintetizzare (IT)")
    p.add_argument("--out", required=True, help="Nome file MP3 di output (solo basename)")
    p.add_argument("--voice", default="vivid-feather-7719__design-voice-37081da2")
    p.add_argument("--rate", type=float, default=1.05)
    p.add_argument("--delivery", default="CREATIVE",
                   choices=["CREATIVE", "EXPRESSIVE", "STANDARD", "CALM", "NEUTRAL"])
    p.add_argument("--language", default="it-IT")
    p.add_argument("--model", default="inworld-tts-2")
    args = p.parse_args()

    load_env_from_dotenv()

    api_key = os.environ.get("INWORLD_API_KEY", "").strip()
    if not api_key:
        print("ERRORE: INWORLD_API_KEY non configurata.", file=sys.stderr)
        return 2

    rate_per_1m = float(os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD", "25.00"))

    # Sanitizza nome file (solo basename, estensione mp3 obbligatoria)
    out_name = os.path.basename(args.out)
    if not out_name.lower().endswith(".mp3"):
        out_name += ".mp3"
    if "/" in out_name or ".." in out_name:
        print("ERRORE: nome file output non valido.", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_file = OUT_DIR / out_name

    body = {
        "text": args.text,
        "modelId": args.model,
        "voiceId": args.voice,
        "language": args.language,
        "speakingRate": args.rate,
        "deliveryMode": args.delivery,
        "audioConfig": {"audioEncoding": "MP3"},
    }
    body_bytes = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        INWORLD_ENDPOINT,
        data=body_bytes,
        method="POST",
        headers={
            "Authorization": f"Basic {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Ollenya-TTS-Probe/1.1 (param one-shot)",
        },
    )

    chars_sent = len(args.text)
    print("=" * 72)
    print("Ollenya — generazione singola clip Inworld TTS-2 (parametrizzata)")
    print("=" * 72)
    print(f"  modelId:       {args.model}")
    print(f"  voiceId:       {args.voice}")
    print(f"  language:      {args.language}")
    print(f"  speakingRate:  {args.rate}")
    print(f"  deliveryMode:  {args.delivery}")
    print(f"  out file:      {out_file}")
    print(f"  text (chars={chars_sent}): {args.text!r}")
    print(f"  tariffa:       ${rate_per_1m:.2f}/1M chars")
    print()
    print("  => invio UNA SOLA richiesta (timeout 60s, nessun retry)...")

    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status = resp.status
            resp_headers = dict(resp.headers.items())
            resp_body = resp.read()
    except urllib.error.HTTPError as e:
        elapsed = time.perf_counter() - t0
        err_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"\nHTTP {e.code} in {elapsed*1000:.0f} ms", file=sys.stderr)
        print(f"headers: {dict(e.headers.items())}", file=sys.stderr)
        print(f"body: {err_body[:2000]}", file=sys.stderr)
        return 3
    except urllib.error.URLError as e:
        elapsed = time.perf_counter() - t0
        print(f"\nURLError in {elapsed*1000:.0f} ms: {e.reason}", file=sys.stderr)
        return 4
    except Exception as e:
        elapsed = time.perf_counter() - t0
        print(f"\nError in {elapsed*1000:.0f} ms: {e!r}", file=sys.stderr)
        return 5

    elapsed = time.perf_counter() - t0

    try:
        payload = json.loads(resp_body.decode("utf-8"))
    except Exception as e:
        print(f"ERRORE parsing JSON risposta: {e}", file=sys.stderr)
        print(f"first 500 bytes: {resp_body[:500]!r}", file=sys.stderr)
        return 6

    audio_b64 = (
        payload.get("audioContent")
        or payload.get("result", {}).get("audioContent")
        or ""
    )
    if not audio_b64:
        print(f"ERRORE: nessun audioContent nella risposta.", file=sys.stderr)
        print(f"keys: {list(payload.keys())}", file=sys.stderr)
        return 7

    audio_bytes = base64.b64decode(audio_b64)
    out_file.write_bytes(audio_bytes)

    usage = payload.get("usage") or payload.get("result", {}).get("usage") or {}
    billed_chars = (
        usage.get("processedCharactersCount")
        or usage.get("inputCharacters")
        or usage.get("characterCount")
        or None
    )
    chars_for_cost = billed_chars if isinstance(billed_chars, int) else chars_sent
    cost_usd = chars_for_cost * rate_per_1m / 1_000_000

    print(f"\n  <= HTTP {status} in {elapsed*1000:.0f} ms")
    print(f"     response bytes: {len(resp_body):,}")
    print(f"     audio bytes (decoded MP3): {len(audio_bytes):,}")
    print(f"     saved to: {out_file}")
    print()
    print(f"  CHARACTERS")
    print(f"     sent:   {chars_sent}")
    print(f"     billed: {billed_chars if billed_chars is not None else '<non riportato>'}")
    print(f"  COST (${rate_per_1m:.2f}/1M chars)")
    print(f"     su {chars_for_cost} chars: ${cost_usd:.6f} ({cost_usd*100:.4f} ¢)")
    print()
    print(f"  response headers (selected):")
    for h in ("content-type", "content-length", "x-request-id", "x-inworld-request-id"):
        v = resp_headers.get(h) or resp_headers.get(h.title())
        if v:
            print(f"     {h}: {v}")
    print()
    print("=" * 72)
    print("FINE. 1 richiesta effettuata, 0 retry, 0 modifiche al backend produttivo.")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
