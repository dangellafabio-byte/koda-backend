"""
Confronto diretto Cielo Flash v2.5 vs Cielo V3 (non-blind).
Fabio 2026-09-10 — Neo.

Genera 5 frasi × 2 modelli con voice_settings PER-TONO identici a produzione
(`server.py::_voice_settings_for_tone`). Le clip finiscono nel DB con engine
etichettato chiaramente:
  - `elevenlabs_flash_v2_5_labeled` (Flash)
  - `elevenlabs_v3_labeled`         (V3)

Uso:
  python /app/backend/scripts/flash_vs_v3_compare.py
"""
import os
import re
import json
import uuid
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from motor.motor_asyncio import AsyncIOMotorClient
from elevenlabs.client import ElevenLabs
from elevenlabs import VoiceSettings

CLIP_DIR = Path("/app/backend/_blind_test_clips")
CLIP_DIR.mkdir(parents=True, exist_ok=True)

API_KEY = os.environ["ELEVENLABS_API_KEY"]
VOICE_ID = os.environ["KODA_CIELO_VOICE_ID"]

# === MAPPING FRASE → TONO (identico a quanto il classifier di prod farebbe) ===
PHRASE_TONE = {
    "intimity_02": "calm",
    "emotion_02":  "concerned",
    "normal_04":   "warm",
    "hard_it_03":  "warm",
    "prosody_02":  "concerned",
}


def voice_settings_for_tone(tone: str) -> VoiceSettings:
    """MIRROR ESATTO di server.py::_voice_settings_for_tone (stab/style/speed).
    NON toccare senza aggiornare anche server.py — è la garanzia di fedeltà."""
    base_similarity = 0.82  # default prod
    if tone == "calm":
        stab, style, speed = 0.80, 0.15, 0.77
    elif tone == "concerned":
        stab, style, speed = 0.15, 0.80, 0.80
    elif tone == "warm":
        stab, style, speed = 0.40, 0.55, 0.91
    elif tone == "energetic":
        stab, style, speed = 0.18, 0.90, 1.08
    elif tone == "urgent":
        stab, style, speed = 0.10, 0.95, 1.13
    elif tone == "paced":
        stab, style, speed = 0.45, 0.50, 0.74
        base_similarity = 0.90
    else:  # neutral
        stab, style, speed = 0.55, 0.30, 0.94
    return VoiceSettings(
        stability=stab,
        similarity_boost=base_similarity,
        style=style,
        use_speaker_boost=True,
        speed=speed,
    )


def load_gate1_phrases():
    fp = Path(__file__).resolve().parent / "blind_test_phrases.jsonc"
    with open(fp, "r", encoding="utf-8") as f:
        raw = f.read()
    stripped = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
    stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
    stripped = re.sub(r"^\s*#.*?$", "", stripped, flags=re.MULTILINE)
    data = json.loads(stripped)
    gate1_ids = set(data["meta"]["gate_1_pretest_phrase_ids"])
    return [p for p in data["phrases"] if p["id"] in gate1_ids]


async def main():
    client = ElevenLabs(api_key=API_KEY)
    mongo = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = mongo[os.environ["DB_NAME"]]

    # Cancella clip precedenti dei due engine labeled (idempotenza)
    for eng in ("elevenlabs_flash_v2_5_labeled", "elevenlabs_v3_labeled"):
        old = await db.blind_test_clips.find({"engine": eng}).to_list(200)
        for d in old:
            fp = d.get("filepath")
            if fp and os.path.exists(fp):
                try: os.remove(fp)
                except: pass
        r = await db.blind_test_clips.delete_many({"engine": eng})
        print(f"[cleanup] rimosse {r.deleted_count} clip pregresse {eng}")

    phrases = load_gate1_phrases()

    for phrase in phrases:
        pid = phrase["id"]
        text = phrase["text"]
        tone = PHRASE_TONE.get(pid, "warm")
        vs = voice_settings_for_tone(tone)
        for model_id, engine_label in [
            ("eleven_flash_v2_5", "elevenlabs_flash_v2_5_labeled"),
            ("eleven_v3",         "elevenlabs_v3_labeled"),
        ]:
            clip_id = str(uuid.uuid4())
            out_path = CLIP_DIR / f"{clip_id}.mp3"
            t0 = datetime.now()
            try:
                chunks = client.text_to_speech.convert(
                    text=text,
                    voice_id=VOICE_ID,
                    model_id=model_id,
                    output_format="mp3_44100_128",
                    language_code="it",
                    voice_settings=vs,
                )
                audio = b"".join(chunks)
            except Exception as e:
                print(f"  ❌ {pid} [{model_id}]: {e!r}")
                continue
            gen_s = (datetime.now() - t0).total_seconds()
            if len(audio) < 500:
                print(f"  ❌ {pid} [{model_id}]: audio troppo piccolo ({len(audio)}B)")
                continue
            out_path.write_bytes(audio)
            duration = len(audio) / 16000.0  # mp3_44100_128 = ~16000 bytes/s
            await db.blind_test_clips.replace_one(
                {"clip_id": clip_id},
                {
                    "clip_id": clip_id,
                    "phrase_id": pid,
                    "engine": engine_label,
                    "filepath": str(out_path),
                    "duration_s": duration,
                    "created_at": datetime.now(timezone.utc),
                    "mode": "real",
                    "tone": tone,
                    "voice_settings": {
                        "stability": vs.stability,
                        "similarity_boost": vs.similarity_boost,
                        "style": vs.style,
                        "speed": vs.speed,
                    },
                    "generation_time_s": gen_s,
                },
                upsert=True,
            )
            print(f"  ✓ {pid:<12} [{model_id:<18} tone={tone:<9}] → {duration:.2f}s (gen {gen_s:.1f}s) {clip_id}")

    print("\n[flash_vs_v3] Done.")


if __name__ == "__main__":
    asyncio.run(main())
