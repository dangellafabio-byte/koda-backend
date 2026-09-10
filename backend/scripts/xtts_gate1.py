"""
XTTS-v2 batch generator per Gate 1 blind test.
Fabio 2026-09-10 — Neo.

Setup:
  venv: /tmp/xtts_env
  torch 2.13.0+cpu, coqui-tts 0.27.5, transformers 4.57.6
  reference audio: clip V3 di intimity_02 (2.80s, Cielo)

Uso:
  /tmp/xtts_env/bin/python /app/backend/scripts/xtts_gate1.py
"""
import os
import sys
import re
import json
import uuid
import asyncio
from datetime import datetime, timezone
from pathlib import Path

_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_root))
from dotenv import load_dotenv
load_dotenv(_root / ".env")

# TOS accettato dal maintainer (Fabio) — required per download modello
os.environ["COQUI_TOS_AGREED"] = "1"
# Redirezione cache modelli su /tmp (74GB liberi) invece di /root (100% pieno)
os.environ["XDG_DATA_HOME"] = "/tmp/tts_data"
os.environ["HF_HOME"] = "/tmp/hf_home"
os.environ["TORCH_HOME"] = "/tmp/torch_home"

from motor.motor_asyncio import AsyncIOMotorClient

CLIP_DIR = Path("/app/backend/_blind_test_clips")
CLIP_DIR.mkdir(parents=True, exist_ok=True)

# Reference audio: usiamo la clip V3 di intimity_02 come voice sample per il
# cloning. È 2.80s di Cielo, timbro pulito, testo breve.
REFERENCE_CLIP_ID = "8e25fd49-68e0-499b-a07d-f26284645edb"  # intimity_02 V3
REFERENCE_AUDIO = CLIP_DIR / f"{REFERENCE_CLIP_ID}.mp3"

PHRASES_FILE = _root / "scripts" / "blind_test_phrases.jsonc"
ENGINE_B_ID = "xtts_v2_local_B"


def load_gate1_phrases() -> list[dict]:
    with open(PHRASES_FILE, "r", encoding="utf-8") as f:
        raw = f.read()
    stripped = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
    stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
    stripped = re.sub(r"^\s*#.*?$", "", stripped, flags=re.MULTILINE)
    data = json.loads(stripped)
    gate1_ids = set(data["meta"]["gate_1_pretest_phrase_ids"])
    return [p for p in data["phrases"] if p["id"] in gate1_ids]


async def main():
    from TTS.api import TTS

    if not REFERENCE_AUDIO.exists():
        raise SystemExit(f"Reference audio non trovato: {REFERENCE_AUDIO}")
    print(f"[xtts] reference audio: {REFERENCE_AUDIO} ({REFERENCE_AUDIO.stat().st_size} bytes)")

    print("[xtts] carico modello XTTS-v2 (primo run: download ~2GB da HF)…")
    t0 = datetime.now()
    tts = TTS(model_name="tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=True)
    print(f"[xtts] modello caricato in {(datetime.now()-t0).total_seconds():.1f}s")

    phrases = load_gate1_phrases()
    print(f"[xtts] Gate 1 phrases: {[p['id'] for p in phrases]}")

    mongo_url = os.getenv("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.getenv("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    for phrase in phrases:
        existing = await db.blind_test_clips.find_one({
            "phrase_id": phrase["id"], "engine": ENGINE_B_ID,
        })
        if existing:
            print(f"  · skip {phrase['id']} (already generated)")
            continue

        clip_id = str(uuid.uuid4())
        out_path = CLIP_DIR / f"{clip_id}.wav"
        t_gen = datetime.now()
        try:
            tts.tts_to_file(
                text=phrase["text"],
                file_path=str(out_path),
                speaker_wav=str(REFERENCE_AUDIO),
                language="it",
                split_sentences=True,
            )
        except Exception as e:
            print(f"  ❌ {phrase['id']}: {e!r}")
            continue
        gen_s = (datetime.now() - t_gen).total_seconds()

        # Durata stimata dalla dimensione file WAV (24kHz mono int16 ≈ 48000 bytes/s)
        # Usiamo torchaudio per la durata reale
        import torchaudio
        info = torchaudio.info(str(out_path))
        duration = info.num_frames / info.sample_rate

        await db.blind_test_clips.replace_one(
            {"clip_id": clip_id},
            {
                "clip_id": clip_id,
                "phrase_id": phrase["id"],
                "engine": ENGINE_B_ID,
                "filepath": str(out_path),
                "duration_s": float(duration),
                "created_at": datetime.now(timezone.utc),
                "mode": "real",
                "generation_time_s": gen_s,
                "reference_audio_clip_id": REFERENCE_CLIP_ID,
            },
            upsert=True,
        )
        print(f"  ✓ {phrase['id']} → {clip_id} ({duration:.2f}s audio, gen {gen_s:.1f}s)")

    print("\n[xtts] Done.")


if __name__ == "__main__":
    asyncio.run(main())
