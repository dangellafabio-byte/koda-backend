"""POC — Zona grigia V3 vs Turbo (Fabio 2026-08-14).

Contesto:
    Il classificatore minimo (MODE + INTENSITY → V3/Turbo) ha identificato una
    zona grigia: turni warm+lungo+SPECCHIO che leggendo il testo sembrano
    "momenti densi filosofici/personali" ma che il classificatore lascia su
    Turbo. Traffic split totale 16.7% V3 / 83.3% Turbo, ma questi 6-10 turni
    potrebbero essere falsi negativi.

Test:
    Generare gli STESSI 7 testi reali di produzione con V3 e Turbo (14 file
    totali) sulla voce Vento (voce Koda maschile utente), e confrontarli in
    A/B sulla pagina web dedicata. Se Turbo regge → classificatore v0 pronto,
    zona grigia non è un problema. Se Turbo non regge → 1 sola feature mirata.

Nessuna modifica al prompt Koda. Nessuna modifica alla produzione.
"""
import os
import time
import json
from typing import Dict, Any, List
from pathlib import Path

from dotenv import load_dotenv
load_dotenv('/app/backend/.env')

from elevenlabs.client import ElevenLabs
from elevenlabs.types.voice_settings import VoiceSettings

ELEVENLABS_API_KEY = os.environ['ELEVENLABS_API_KEY']
VOICE_ID = "ll9WG7PDTuyHwgC5MD6g"  # Vento — voce Koda maschile
OUTPUT_FORMAT = "mp3_44100_128"

# Stessi voice settings usati nel primo test A/B/C — coerenza per calibrazione orecchio
BASE_VOICE_SETTINGS = VoiceSettings(
    stability=0.55,
    similarity_boost=0.75,
    style=0.20,
    use_speaker_boost=True,
)

MODELS = ["eleven_v3", "eleven_turbo_v2_5"]

# 7 turni reali di produzione (warm+lungo+SPECCHIO) — dalla zona grigia
GRAY_ZONE_TEXTS = json.loads(Path("/tmp/koda_intensity/gray_zone_texts.json").read_text())

# ID leggibili per i file (in ordine)
GRAY_IDS = [
    "gz1_riflessione_stile",       # 136w — "una riflessione lunga non è il mio stile"
    "gz2_parole_lunghe",           # 129w — "cerchi parole lunghe adesso"
    "gz3_lennon_vita",             # 125w — "La vita è quella cosa che accade" (Lennon)
    "gz4_terza_volta",             #  97w — "ti noto che mi chiedi la stessa cosa"
    "gz5_crescita",                # 179w — "quello che vedo in te è una crescita"
    "gz6_luna_acqua",              #  58w — "immagina una superficie d'acqua calma di notte"
    "gz7_specchio_scuro",          #  76w — "rappresentarmi come uno specchio d'acqua scuro"
]

assert len(GRAY_ZONE_TEXTS) == len(GRAY_IDS), "mismatch texts / ids"

def generate_one(client: ElevenLabs, sid: str, text: str, model: str) -> Dict[str, Any]:
    t_start = time.time()
    ttfa_ms = None
    audio_bytes = bytearray()
    error = None
    try:
        gen = client.text_to_speech.convert_as_stream(
            voice_id=VOICE_ID,
            text=text,
            model_id=model,
            output_format=OUTPUT_FORMAT,
            language_code="it",
            voice_settings=BASE_VOICE_SETTINGS,
        )
        for chunk in gen:
            if chunk:
                if ttfa_ms is None:
                    ttfa_ms = int((time.time() - t_start) * 1000)
                audio_bytes.extend(chunk)
    except Exception as e:
        error = str(e)[:400]
    wall_ms = int((time.time() - t_start) * 1000)
    mp3 = bytes(audio_bytes)
    out_path = f"/tmp/poc_koda_{sid}_{model}.mp3"
    if mp3:
        with open(out_path, "wb") as f:
            f.write(mp3)
    audio_dur_s = None
    try:
        import miniaudio, numpy as np
        d = miniaudio.decode(mp3, output_format=miniaudio.SampleFormat.SIGNED16,
                             nchannels=2, sample_rate=44100)
        pcm = np.frombuffer(d.samples, dtype=np.int16).reshape(-1, 2)
        audio_dur_s = pcm.shape[0] / d.sample_rate
    except Exception:
        pass
    return {
        "sentence_id": sid,
        "model": model,
        "voice_id": VOICE_ID,
        "chars": len(text),
        "words": len(text.split()),
        "ttfa_ms": ttfa_ms,
        "wall_ms": wall_ms,
        "mp3_bytes": len(mp3),
        "audio_dur_s": round(audio_dur_s, 2) if audio_dur_s else None,
        "audio_path": out_path if mp3 else None,
        "error": error,
    }


def main():
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
    print("Warmup...")
    try:
        _ = generate_one(client, "warmup_gz", "Ciao.", "eleven_turbo_v2_5")
        print(f"  warmup TTFA={_.get('ttfa_ms')}ms\n")
    except Exception as e:
        print(f"  warmup failed: {e}")

    results: List[Dict[str, Any]] = []
    for i, (sid, text) in enumerate(zip(GRAY_IDS, GRAY_ZONE_TEXTS), 1):
        preview = text[:80].replace("\n", " ")
        print(f"=== [{i}/7] {sid}  ({len(text)}c, {len(text.split())}w)  '{preview}...' ===")
        for model in MODELS:
            print(f"  → {model}...", flush=True, end=" ")
            r = generate_one(client, sid, text, model)
            results.append(r)
            if r["error"]:
                print(f"ERROR: {r['error']}")
            else:
                print(f"TTFA={r['ttfa_ms']}ms wall={r['wall_ms']}ms size={r['mp3_bytes']/1024:.1f}KB dur={r['audio_dur_s']}s")
            time.sleep(0.4)
        print()

    print("=" * 100)
    print(f"{'ID':<24}{'Model':<22}{'TTFA':<10}{'Wall':<10}{'Dur':<10}{'Size KB'}")
    print("=" * 100)
    for r in results:
        err = r.get("error")
        ttfa = "-" if err else f"{r['ttfa_ms']}ms"
        wall = "-" if err else f"{r['wall_ms']}ms"
        dur = "-" if err else f"{r.get('audio_dur_s') or '-'}s"
        size = f"{r['mp3_bytes']/1024:.1f}"
        print(f"{r['sentence_id']:<24}{r['model']:<22}{ttfa:<10}{wall:<10}{dur:<10}{size}")

    # aggregate TTFA per model
    print("\n" + "=" * 60)
    print("MEDIA TTFA per modello (zona grigia, 7 testi lunghi):")
    print("=" * 60)
    for m in MODELS:
        vals = [r["ttfa_ms"] for r in results if r["model"] == m and r["ttfa_ms"] is not None]
        if vals:
            avg = sum(vals) / len(vals)
            print(f"  {m:<22} avg={avg:.0f}ms  min={min(vals)}  max={max(vals)}  n={len(vals)}")

    out = {
        "voice_id": VOICE_ID,
        "voice_settings": {
            "stability": BASE_VOICE_SETTINGS.stability,
            "similarity_boost": BASE_VOICE_SETTINGS.similarity_boost,
            "style": BASE_VOICE_SETTINGS.style,
            "use_speaker_boost": BASE_VOICE_SETTINGS.use_speaker_boost,
        },
        "texts": {sid: t for sid, t in zip(GRAY_IDS, GRAY_ZONE_TEXTS)},
        "results": results,
    }
    Path("/tmp/poc_koda_gray_zone.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print("\nJSON: /tmp/poc_koda_gray_zone.json")
    print(f"MP3:  /tmp/poc_koda_gz*_*.mp3  ({sum(1 for r in results if r.get('audio_path'))} file)")


if __name__ == "__main__":
    main()
