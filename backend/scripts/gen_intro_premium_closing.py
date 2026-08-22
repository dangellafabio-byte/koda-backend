"""Genera clip chiusura Intro Premium — voce Cielo, model eleven_v3.
Testo (approvato Fabio, opzione b): "Adesso ci siamo. Cominciamo."
"""
import os, sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
KEY = os.environ.get("ELEVENLABS_API_KEY")
if not KEY:
    print("[FATAL] ELEVENLABS_API_KEY assente"); sys.exit(1)

ASSETS = Path("/app/frontend/assets/sounds/intro")
CIELO = "POuqf18evoXOKIqV2Px7"

from elevenlabs.client import ElevenLabs
client = ElevenLabs(api_key=KEY)

filename = "intro_premium_closing-cielo.mp3"
text = "Adesso ci siamo. Cominciamo."
print(f"[GEN] {filename}  ← “{text}”")
gen = client.text_to_speech.convert(
    text=text, voice_id=CIELO, model_id="eleven_v3",
    output_format="mp3_44100_128", language_code="it",
)
data = b"".join(c for c in gen if c)
if len(data) < 2000:
    raise RuntimeError(f"clip troppo piccola: {len(data)} B")
out = ASSETS / filename
out.write_bytes(data)
print(f"[OK] {filename} → {out} ({len(data)} B)")
