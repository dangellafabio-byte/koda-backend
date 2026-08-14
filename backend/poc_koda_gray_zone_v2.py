"""POC — Zona grigia FEDELE al pipeline classifier v0 (Fabio 2026-08-14).

Correzione rispetto a poc_koda_gray_zone.py:
    - V3 riceve `[warmly] testo` (esattamente come in produzione, dove
      `_v3_tag = _TONE_TO_V3_TAG.get(current_tone or "warm", "")` prepend il tag)
    - Turbo riceve `testo` puro (esattamente come nuovo pipeline con audio
      tag stripping per non-v3)

3 turni gray zone (warm+SPECCHIO) — sufficienti per confermare mele con mele
prima di attivare il flag su Railway.
"""
import os
import time
import json
from pathlib import Path

from dotenv import load_dotenv
load_dotenv('/app/backend/.env')

from elevenlabs.client import ElevenLabs
from elevenlabs.types.voice_settings import VoiceSettings

ELEVENLABS_API_KEY = os.environ['ELEVENLABS_API_KEY']
VOICE_ID = "ll9WG7PDTuyHwgC5MD6g"  # Vento
OUTPUT_FORMAT = "mp3_44100_128"
BASE_VOICE_SETTINGS = VoiceSettings(
    stability=0.55, similarity_boost=0.75, style=0.20, use_speaker_boost=True,
)

# Mapping identico a server.py:_TONE_TO_V3_TAG (warm → [warmly])
V3_TAG_FOR_TONE = {
    "calm":      "[softly]",
    "concerned": "[gently]",
    "warm":      "[warmly]",
    "energetic": "[excited]",
    "urgent":    "[urgent]",
    "neutral":   "",
}

# 3 turni gray zone da POC precedente — tutti warm (SPECCHIO)
gz_texts = json.loads(Path("/tmp/koda_intensity/gray_zone_texts.json").read_text())
SELECTED = [
    ("gz1v2_riflessione_stile", gz_texts[0], "warm"),
    ("gz3v2_lennon_vita",       gz_texts[2], "warm"),
    ("gz5v2_crescita",          gz_texts[4], "warm"),
]


def generate(client, sid, text_for_v3, text_for_turbo, model):
    text = text_for_v3 if model == "eleven_v3" else text_for_turbo
    t0 = time.time()
    ttfa = None
    buf = bytearray()
    err = None
    try:
        gen = client.text_to_speech.convert_as_stream(
            voice_id=VOICE_ID, text=text, model_id=model,
            output_format=OUTPUT_FORMAT, language_code="it",
            voice_settings=BASE_VOICE_SETTINGS,
        )
        for c in gen:
            if c:
                if ttfa is None:
                    ttfa = int((time.time() - t0) * 1000)
                buf.extend(c)
    except Exception as e:
        err = str(e)[:300]
    wall = int((time.time() - t0) * 1000)
    path = f"/tmp/poc_koda_{sid}_{model}.mp3"
    if buf:
        Path(path).write_bytes(bytes(buf))
    return {
        "sid": sid, "model": model, "text_sent": text[:80] + "...",
        "chars": len(text), "ttfa_ms": ttfa, "wall_ms": wall,
        "size_kb": round(len(buf) / 1024, 1), "error": err,
    }


def main():
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
    print("Warmup..."); generate(client, "warmup2", "Ciao.", "Ciao.", "eleven_turbo_v2_5")
    print("\n=== POC v2 — pipeline-faithful (V3 con audio tag, Turbo senza) ===\n")
    results = []
    for sid, text, tone in SELECTED:
        tag = V3_TAG_FOR_TONE.get(tone, "")
        text_v3 = (f"{tag} {text}").strip() if tag else text
        text_turbo = text  # come nuovo pipeline
        print(f"[{sid}] tone={tone}  words={len(text.split())}")
        print(f"  V3 text:    {text_v3[:100]!r}...")
        print(f"  Turbo text: {text_turbo[:100]!r}...")
        for m in ["eleven_v3", "eleven_turbo_v2_5"]:
            r = generate(client, sid, text_v3, text_turbo, m)
            results.append(r)
            print(f"    {m:22s}  TTFA={r['ttfa_ms']}ms wall={r['wall_ms']}ms {r['size_kb']}KB")
            time.sleep(0.3)
        print()

    Path("/tmp/poc_koda_gray_zone_v2.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2)
    )
    print(f"JSON: /tmp/poc_koda_gray_zone_v2.json")
    print(f"MP3:  /tmp/poc_koda_gz*v2_*.mp3")


if __name__ == "__main__":
    main()
