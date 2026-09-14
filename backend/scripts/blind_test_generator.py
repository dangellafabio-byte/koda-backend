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

# === ENGINE B: motore alternativo in test (Fabio 2026-09-10 v2, rollout progressivo)
# Il "motore B" è il candidato locale/cloud in test contro V3 (reference).
# Valore controllato via env var `KODA_BLIND_TEST_ENGINE_B`:
#   - kyutai_tts_local_B    (default, primo giro)
#   - megatts3_local_B      (se Kyutai fallisce Gate 1)
#   - xtts_v2_local_B       (se anche MegaTTS3 fallisce)
#   - cartesia_cloud_B      (fallback hybrid se locale falliscono tutti)
# Cambio del valore = automaticamente nuovo motore in test. Le clip generate
# in giri precedenti restano in DB con `engine=<vecchio_valore>` — la ricerca
# in next-pair filtra per il valore corrente. Zero conflitti.
ENGINE_A_ID = "elevenlabs_v3_reference_A"
ENGINE_B_ID = os.getenv("KODA_BLIND_TEST_ENGINE_B", "kyutai_tts_local_B")


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
    RITORNA la durata in secondi (stimata via bytes/16000 su mp3_44100_128).

    Config:
      - ELEVENLABS_API_KEY (env)
      - KODA_CIELO_VOICE_ID (env)  → default hardcoded fallback

    Params allineati al fast pipeline di server.py:
      - model_id="eleven_v3"
      - output_format="mp3_44100_128"
      - language_code="it"
      - voice_settings: stability=0.5, similarity_boost=0.75, style=0.35
        (valori "presente calma calda" da _voice_settings_for_tone default)
    """
    api_key = os.getenv("ELEVENLABS_API_KEY")
    voice_id = os.getenv("KODA_CIELO_VOICE_ID")
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY mancante in .env")
    if not voice_id:
        raise RuntimeError("KODA_CIELO_VOICE_ID mancante in .env")

    from elevenlabs.client import ElevenLabs
    client = ElevenLabs(api_key=api_key)

    # === VOICE SETTINGS COERENTI CON PRODUCTION (server.py:_voice_settings_for_tone default) ===
    # Il pre-test DEVE riflettere la voce che l'utente sente in Ollenya live.
    # Cambiare parametri qui = testare un motore che NON è quello che arriverà
    # all'utente → falsa il gate.
    from elevenlabs import VoiceSettings
    voice_settings = VoiceSettings(
        stability=0.5,
        similarity_boost=0.75,
        style=0.35,
        use_speaker_boost=True,
    )

    text = phrase["text"]

    # Chiamata SYNC dentro to_thread perché SDK 1.9.0 è sync.
    def _tts() -> bytes:
        chunks = client.text_to_speech.convert(
            text=text,
            voice_id=voice_id,
            model_id="eleven_v3",
            output_format="mp3_44100_128",
            language_code="it",
            voice_settings=voice_settings,
        )
        # chunks è generator di bytes → join
        return b"".join(chunks) if hasattr(chunks, "__iter__") else bytes(chunks)

    audio_bytes = await asyncio.to_thread(_tts)
    if not audio_bytes or len(audio_bytes) < 200:
        raise RuntimeError(f"ElevenLabs ritorno vuoto o troppo piccolo ({len(audio_bytes)} bytes)")

    with open(out_path, "wb") as f:
        f.write(audio_bytes)

    # Stima durata: mp3_44100_128 = 128 kbps CBR → 16000 bytes/sec
    duration = len(audio_bytes) / 16000.0
    return duration


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


async def run(mode: str, engine: str, gate1_only: bool = False):
    """Loop principale: genera tutti i clip mancanti + registra su DB."""
    phrases = load_phrases()
    # === GATE 1 FILTER (Fabio 2026-09-10) ===
    # Se gate1_only, restringe alle 5 frasi definite in meta.gate_1_pretest_phrase_ids
    # (definite in blind_test_phrases.jsonc). Costo API ridotto del 85%
    # (5 vs 34 frasi) → gate go/no-go rapido prima del batch completo.
    if gate1_only:
        with open(PHRASES_FILE, "r", encoding="utf-8") as f:
            raw = f.read()
        stripped = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        stripped = re.sub(r"^\s*#.*?$", "", stripped, flags=re.MULTILINE)
        gate1_ids = set(json.loads(stripped)["meta"]["gate_1_pretest_phrase_ids"])
        phrases = [p for p in phrases if p["id"] in gate1_ids]
        print(f"[blind-test-gen] GATE 1 MODE: filtered to {len(phrases)} phrases: {sorted(p['id'] for p in phrases)}")
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
    parser.add_argument("--gate1-only", action="store_true",
                        help="Genera solo le 5 frasi Gate 1 (pretest)")
    args = parser.parse_args()
    mode = "mock" if args.mock else "real"
    asyncio.run(run(mode=mode, engine=args.engine, gate1_only=args.gate1_only))
