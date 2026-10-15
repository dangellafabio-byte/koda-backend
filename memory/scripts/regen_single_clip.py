#!/usr/bin/env python3
"""
Ollenya — Generazione singola clip Inworld TTS-2 (one-shot, zero retry)
========================================================================

Scopo
-----
Eseguire ESATTAMENTE UNA chiamata a `POST /tts/v1/voice` di Inworld AI
per il testo autorizzato, salvare l'MP3 risultante su disco e stampare
esito, caratteri processati, durata audio, costo stimato.

Garanzie
--------
  * UNA SOLA richiesta HTTP a Inworld, nessun retry, nessun loop.
  * Zero modifiche al backend produttivo (server.py non toccato).
  * La chiave INWORLD_API_KEY è letta da env (iniettata via vault
    Emergent nel .env del pod dev). Mai stampata, mai loggata.
  * Nessuna rigenerazione automatica.
  * Timeout singolo 60s. Se la richiesta fallisce, esce con exit≠0 e
    stampa l'errore. Non si tenta un secondo colpo.

Uso
---
  python3 /app/memory/scripts/regen_single_clip.py

Variabili d'ambiente richieste (già configurate nel pod dev):
  INWORLD_API_KEY                   # Basic Base64 Portal Inworld
  INWORLD_RATE_PER_1M_CHARS_USD     # tariffa listino, default 25.00

Nessuna chiave viene stampata in alcuna condizione.
"""
from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# -----------------------------------------------------------------------------
# Parametri — da piano v5 §4 (approvati dall'utente)
# -----------------------------------------------------------------------------
TEXT = "Io sono Ollenya. Grazie di essere qui. Da dove ti va di cominciare?"

INWORLD_ENDPOINT = "https://api.inworld.ai/tts/v1/voice"
BODY = {
    "text": TEXT,
    "modelId": "inworld-tts-2",
    "voiceId": "vivid-feather-7719__design-voice-37081da2",
    "language": "it-IT",
    "speakingRate": 1.05,
    "deliveryMode": "CREATIVE",
    "audioConfig": {"audioEncoding": "MP3"},
}

OUT_DIR = Path("/app/memory/home_payloads/inworld_samples")
OUT_FILE = OUT_DIR / "presentazione_koda-cielo__inworld.mp3"


def load_env_from_dotenv() -> None:
    """Fallback: se le var non sono nel processo, le prendo dal .env del
    backend (python-dotenv-like minimale, nessuna lib esterna)."""
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
    load_env_from_dotenv()

    api_key = os.environ.get("INWORLD_API_KEY", "").strip()
    if not api_key:
        print("ERRORE: INWORLD_API_KEY non configurata.", file=sys.stderr)
        return 2

    rate_per_1m = float(os.environ.get("INWORLD_RATE_PER_1M_CHARS_USD", "25.00"))
    plan_name = os.environ.get("INWORLD_PLAN", "on-demand")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Preparazione richiesta — un singolo urllib.request, nessun retry.
    body_bytes = json.dumps(BODY).encode("utf-8")
    req = urllib.request.Request(
        INWORLD_ENDPOINT,
        data=body_bytes,
        method="POST",
        headers={
            "Authorization": f"Basic {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Ollenya-TTS-Probe/1.0 (one-shot test)",
        },
    )

    chars_sent = len(TEXT)
    print("=" * 72)
    print("Ollenya — prova singola Inworld TTS-2")
    print("=" * 72)
    print(f"  endpoint: {INWORLD_ENDPOINT}")
    print(f"  modelId:  {BODY['modelId']}")
    print(f"  voiceId:  {BODY['voiceId']}")
    print(f"  language: {BODY['language']}")
    print(f"  speakingRate: {BODY['speakingRate']}")
    print(f"  deliveryMode: {BODY['deliveryMode']}")
    print(f"  audioEncoding: {BODY['audioConfig']['audioEncoding']}")
    print(f"  text (chars={chars_sent}): {TEXT!r}")
    print(f"  plan: {plan_name}  rate: ${rate_per_1m:.2f}/1M chars")
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

    # Response: JSON con audioContent base64 + eventuale usage
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

    import base64
    audio_bytes = base64.b64decode(audio_b64)

    OUT_FILE.write_bytes(audio_bytes)

    # Durata MP3: estrazione dai frame header senza librerie esterne.
    # mp3 bitrate table (MPEG1 Layer3)
    mp3_duration_sec = _estimate_mp3_duration(audio_bytes)

    usage = payload.get("usage") or payload.get("result", {}).get("usage") or {}
    billed_chars = (
        usage.get("processedCharactersCount")
        or usage.get("inputCharacters")
        or usage.get("characterCount")
        or None
    )

    # Costo stimato: su billed_chars se presente, altrimenti su chars_sent.
    chars_for_cost = billed_chars if isinstance(billed_chars, int) else chars_sent
    cost_usd = chars_for_cost * rate_per_1m / 1_000_000

    print(f"\n  <= HTTP {status} in {elapsed*1000:.0f} ms")
    print(f"     response bytes: {len(resp_body):,}")
    print(f"     audio bytes (decoded MP3): {len(audio_bytes):,}")
    print(f"     saved to: {OUT_FILE}")
    print()
    print(f"  CHARACTERS")
    print(f"     sent (len(text)): {chars_sent}")
    print(f"     billed by provider (usage.processedCharactersCount): "
          f"{billed_chars if billed_chars is not None else '<non riportato nella risposta>'}")
    print(f"  AUDIO")
    print(f"     estimated duration: {mp3_duration_sec:.2f} s"
          if mp3_duration_sec is not None else "     estimated duration: <stima fallita>")
    print(f"  COST (listino {plan_name}, ${rate_per_1m:.2f}/1M chars)")
    print(f"     stimato su {chars_for_cost} chars: ${cost_usd:.6f} ({cost_usd * 100:.4f} ¢)")
    print()
    print(f"  response headers (selected):")
    for h in ("content-type", "content-length", "x-request-id", "x-inworld-request-id"):
        v = resp_headers.get(h) or resp_headers.get(h.title())
        if v:
            print(f"     {h}: {v}")
    print()
    print("=" * 72)
    print("FINE. 1 richiesta effettuata, 0 retry, 0 modifiche al backend.")
    print("=" * 72)
    return 0


def _estimate_mp3_duration(data: bytes) -> float | None:
    """Stima durata MP3 dai frame header. Supporta MPEG1/2 Layer III.
    Ritorna None in caso di parsing fallito."""
    try:
        # MPEG Audio bitrate table (MPEG1 L3, MPEG2 L3)
        # Index 0 = free, 15 = reserved
        BR_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
        BR_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
        SR_MPEG1 = [44100, 48000, 32000, 0]
        SR_MPEG2 = [22050, 24000, 16000, 0]
        SR_MPEG25 = [11025, 12000, 8000, 0]

        # Skip ID3v2 tag if present
        i = 0
        if data[:3] == b"ID3":
            # size at bytes 6..9, synchsafe int
            s = data[6:10]
            size = ((s[0] & 0x7F) << 21) | ((s[1] & 0x7F) << 14) | ((s[2] & 0x7F) << 7) | (s[3] & 0x7F)
            i = 10 + size

        total_sec = 0.0
        while i + 4 < len(data):
            if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
                i += 1
                continue
            b2 = data[i + 1]
            b3 = data[i + 2]
            version_id = (b2 >> 3) & 0x03   # 0=MPEG2.5, 2=MPEG2, 3=MPEG1
            layer = (b2 >> 1) & 0x03         # 1=Layer III
            if layer != 1:
                i += 1
                continue
            br_idx = (b3 >> 4) & 0x0F
            sr_idx = (b3 >> 2) & 0x03
            padding = (b3 >> 1) & 0x01
            if version_id == 3:
                br = BR_MPEG1_L3[br_idx] * 1000
                sr = SR_MPEG1[sr_idx]
                samples_per_frame = 1152
            elif version_id == 2:
                br = BR_MPEG2_L3[br_idx] * 1000
                sr = SR_MPEG2[sr_idx]
                samples_per_frame = 576
            elif version_id == 0:
                br = BR_MPEG2_L3[br_idx] * 1000
                sr = SR_MPEG25[sr_idx]
                samples_per_frame = 576
            else:
                i += 1
                continue
            if br == 0 or sr == 0:
                i += 1
                continue
            # frame length (bytes)
            if version_id == 3:
                frame_len = int(144 * br / sr + padding)
            else:
                frame_len = int(72 * br / sr + padding)
            if frame_len <= 0:
                i += 1
                continue
            total_sec += samples_per_frame / sr
            i += frame_len
        return total_sec if total_sec > 0 else None
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
