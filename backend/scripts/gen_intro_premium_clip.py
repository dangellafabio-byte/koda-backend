"""
Script one-shot (2026-08-22, Fabio via Neo): genera la clip audio dell'
Intro Premium con ElevenLabs V3, voce "Cielo".

Testo (approvato da Fabio, opzione 3 modificata):
  "Eccomi. Ora hai anche la mia voce. Toccami quando sei pronto."

Stesso pattern di gen_intro_clips.py. NON tocca alcuna clip esistente.

USO:
  cd /app/backend && python scripts/gen_intro_premium_clip.py
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
if not ELEVENLABS_API_KEY:
    print("[FATAL] ELEVENLABS_API_KEY assente in backend/.env")
    sys.exit(1)

ASSETS_DIR = Path("/app/frontend/assets/sounds/intro")
VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7"
MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"

CLIP = (
    "intro_premium_eccomi-cielo.mp3",
    "Eccomi. Ora hai anche la mia voce. Toccami quando sei pronto.",
)


def generate_clip(filename: str, text: str) -> None:
    from elevenlabs.client import ElevenLabs
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
    out_path = ASSETS_DIR / filename
    print(f"[GEN] {filename}  ← “{text}”")
    try:
        gen = client.text_to_speech.convert(
            text=text,
            voice_id=VOICE_ID_CIELO,
            model_id=MODEL_ID,
            output_format=OUTPUT_FORMAT,
            language_code="it",
        )
        audio_bytes = b""
        for chunk in gen:
            if chunk:
                audio_bytes += chunk
    except Exception as e:
        raise RuntimeError(f"eleven_v3 failed on {filename}: {e}") from e
    if len(audio_bytes) < 2000:
        raise RuntimeError(f"clip {filename} sospettosamente piccola: {len(audio_bytes)} B")
    out_path.write_bytes(audio_bytes)
    print(f"[GEN] {filename} scritta OK ({len(audio_bytes)} B → {out_path})")


if __name__ == "__main__":
    print("=" * 66)
    print("Generazione clip Intro Premium — voce Cielo, model eleven_v3")
    print("=" * 66)
    generate_clip(*CLIP)
    print("=" * 66)
    print("FATTO.")
