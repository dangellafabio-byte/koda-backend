"""
Blind Test Generator — Cielo A/B (V3 vs Kyutai) [SCAFFOLD]
============================================================
Fabio 2026-09-10 (Piano B ridotto).

FLOW:
  1. Legge /app/backend/scripts/blind_test_phrases.jsonc (34 frasi)
  2. Per ogni frase, genera 2 versioni audio:
     - A: ElevenLabs V3 (reference) via ElevenLabs API + voice_id Cielo
     - B: Kyutai TTS (locale/cloud) con voce Cielo clonata
  3. Salva ogni clip in /app/backend/_blind_test_clips/<clip_id>.mp3
  4. Registra metadata in MongoDB `blind_test_clips` collection

BLOCCANTI (Fabio deve fornire prima di eseguire):
  [ ] Fonte audio reference Cielo per clone Kyutai (scenario A o B della mail)
  [ ] Credenziali cloud GPU se Kyutai su CPU risulta troppo lento
      (Modal / Replicate / HuggingFace Inference API key)

UTILITY MODE:
  --mock: genera clip fake (silence 1s) per testare il flow blind test
          senza attendere sintesi reali. Utile per validare backend + UI.
  --engine=A: genera solo reference V3 (skip Kyutai)
  --engine=B: genera solo Kyutai (skip V3)
  --engine=all: entrambi (default se non specificato --mock)

Esempio uso:
  python blind_test_generator.py --mock          # smoke test flow
  python blind_test_generator.py --engine=A      # solo V3
  python blind_test_generator.py --engine=all    # produzione completa
"""

import os
import sys
import re
import json
import uuid
import argparse
import asyncio
import struct
from datetime import datetime, timezone
from pathlib import Path

_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_root))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(_root / ".env")

# MongoDB (stesso db di produzione, collection separata blind_test_*)
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

CLIP_DIR = Path("/app/backend/_blind_test_clips")
CLIP_DIR.mkdir(parents=True, exist_ok=True)

PHRASES_FILE = _root / "scripts" / "blind_test_phrases.jsonc"

ENGINE_A_ID = "elevenlabs_v3_reference_A"
ENGINE_B_ID = "kyutai_tts_local_B"


def load_phrases() -> list[dict]:
    with open(PHRASES_FILE, "r", encoding="utf-8") as f:
        raw = f.read()
    stripped = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
    stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
    stripped = re.sub(r"^\s*#.*?$", "", stripped, flags=re.MULTILINE)
    return json.loads(stripped)["phrases"]


def make_silence_wav(path: Path, duration_s: float = 2.0, sample_rate: int = 16_000):
    """Genera un WAV di silenzio come mock (per testare flow senza sintesi reali)."""
    n_samples = int(duration_s * sample_rate)
    # PCM 16-bit mono, silenzio (tutti zeri)
    data = b"\x00\x00" * n_samples
    with open(path, "wb") as f:
        # WAV header
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", 16))
        f.write(struct.pack("<H", 1))  # PCM
        f.write(struct.pack("<H", 1))  # mono
        f.write(struct.pack("<I", sample_rate))
        f.write(struct.pack("<I", sample_rate * 2))
        f.write(struct.pack("<H", 2))
        f.write(struct.pack("<H", 16))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


async def generate_v3_reference(phrase: dict, out_path: Path) -> float:
    """
    Genera clip via ElevenLabs V3 API con voice Cielo.
    RITORNA la durata in secondi.

    BLOCCATO: serve ELEVENLABS_API_KEY + voice_id Cielo in env.
    Implementare qui la chiamata a elevenlabs.text_to_speech.convert()
    con model_id='eleven_v3' e stability=0.5 come nel fast pipeline di server.py.
    """
    raise NotImplementedError(
        "Implementare integrazione ElevenLabs V3 con voice_id Cielo. "
        "Serve ELEVENLABS_API_KEY + KODA_CIELO_VOICE_ID in .env."
    )


async def generate_kyutai_local(phrase: dict, out_path: Path, reference_audio: Path) -> float:
    """
    Genera clip via Kyutai TTS locale (o cloud GPU) con voice cloning.
    RITORNA la durata in secondi.

    BLOCCATO: serve fonte audio reference Cielo + setup Kyutai TTS.
    Repo Kyutai: https://github.com/kyutai-labs/delayed-streams-modeling
    Modelli: HuggingFace kyutai/tts-1.6b-en_fr (multilingua limitato,
    Italian best-effort).

    NOTA IMPORTANTE: Kyutai TTS 1.6b è ottimizzato per EN/FR. Per Italian
    la qualità è degradata. Alternativa: MegaTTS3 (Alibaba) o XTTS-v2 (Coqui,
    deprecato ma migliore su Italian).

    Serve valutare EMPIRICAMENTE quale è più credibile su italiano prima
    di dichiarare "Kyutai TTS" come benchmark. Questo va fatto in un primo
    test A/B interno (Fabio + Neo) sulle prime 5 frasi, prima di reclutare
    tester esterni.
    """
    raise NotImplementedError(
        "Implementare setup Kyutai TTS + voice cloning. "
        "Serve reference audio Cielo + valutazione qualità Italian."
    )


async def run(mode: str, engine: str):
    """Loop principale: genera tutti i clip mancanti + registra su DB."""
    phrases = load_phrases()
    print(f"[blind-test-gen] Loaded {len(phrases)} phrases")

    mongo_url = os.getenv("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.getenv("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    print(f"[blind-test-gen] DB: {db_name} @ {mongo_url}")

    engines_to_run = []
    if engine in ("A", "all"):
        engines_to_run.append(ENGINE_A_ID)
    if engine in ("B", "all"):
        engines_to_run.append(ENGINE_B_ID)

    total = 0
    for phrase in phrases:
        for eng in engines_to_run:
            existing = await db.blind_test_clips.find_one({
                "phrase_id": phrase["id"],
                "engine": eng,
            })
            if existing:
                print(f"  · skip {phrase['id']}/{eng} (already generated)")
                continue

            clip_id = str(uuid.uuid4())
            ext = "wav" if mode == "mock" else "mp3"
            out_path = CLIP_DIR / f"{clip_id}.{ext}"

            try:
                if mode == "mock":
                    make_silence_wav(out_path, duration_s=2.0)
                    duration = 2.0
                elif eng == ENGINE_A_ID:
                    duration = await generate_v3_reference(phrase, out_path)
                elif eng == ENGINE_B_ID:
                    # Reference audio Cielo (fonte da definire con Fabio)
                    ref_audio_env = os.getenv("KODA_CIELO_REFERENCE_AUDIO")
                    if not ref_audio_env:
                        raise RuntimeError(
                            "KODA_CIELO_REFERENCE_AUDIO non impostata in .env. "
                            "Fabio deve fornire il path del file audio Cielo "
                            "per il voice cloning Kyutai."
                        )
                    duration = await generate_kyutai_local(
                        phrase, out_path, Path(ref_audio_env)
                    )
                else:
                    continue
            except NotImplementedError as e:
                print(f"  ⚠️  {phrase['id']}/{eng}: BLOCCATO — {e}")
                continue
            except Exception as e:
                print(f"  ❌ {phrase['id']}/{eng}: FAIL — {e!r}")
                continue

            await db.blind_test_clips.replace_one(
                {"clip_id": clip_id},
                {
                    "clip_id": clip_id,
                    "phrase_id": phrase["id"],
                    "engine": eng,
                    "filepath": str(out_path),
                    "duration_s": duration,
                    "created_at": datetime.now(timezone.utc),
                    "mode": mode,
                },
                upsert=True,
            )
            total += 1
            print(f"  ✓ {phrase['id']}/{eng} → {clip_id} ({duration:.2f}s)")

    print(f"\n[blind-test-gen] Done. Generated {total} clips.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true",
                        help="Generate silence WAV instead of real TTS (test flow)")
    parser.add_argument("--engine", choices=["A", "B", "all"], default="all")
    args = parser.parse_args()
    mode = "mock" if args.mock else "real"
    asyncio.run(run(mode=mode, engine=args.engine))
