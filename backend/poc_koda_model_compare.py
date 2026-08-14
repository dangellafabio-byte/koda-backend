"""POC — Confronto V3 vs Flash v2.5 vs Turbo v2.5 sulla STESSA voce Koda.

Scopo:
    Verificare se Flash v2.5 o Turbo v2.5, usati sulla stessa voce_id di
    Koda produzione (Vento, ll9WG7PDTuyHwgC5MD6g), portano TTFA < 2s
    mantenendo l'identità/naturalezza percepita rispetto a V3.

Protocollo (Fabio 2026-08-14):
    - 4 frasi rappresentative (calda, concerned, energica, lunga)
    - 3 modelli: eleven_v3, eleven_flash_v2_5, eleven_turbo_v2_5
    - 12 generazioni totali
    - Stessa voice_id per tutte
    - Voice settings identici sui parametri semanticamente equivalenti
    - Annotazione ESPLICITA per parametri non compatibili tra modelli
    - Misure oggettive: TTFA, durata generata, wall time, errori
    - File MP3 affiancati per giudizio qualitativo umano
"""

import os
import time
import json
from typing import Dict, Any, List

from dotenv import load_dotenv
load_dotenv('/app/backend/.env')

from elevenlabs.client import ElevenLabs
from elevenlabs.types.voice_settings import VoiceSettings

ELEVENLABS_API_KEY = os.environ['ELEVENLABS_API_KEY']
VOICE_ID = "ll9WG7PDTuyHwgC5MD6g"  # Vento (maschile) — voce Koda produzione dell'utente
OUTPUT_FORMAT = "mp3_44100_128"

# === Voice settings — identici dove semanticamente equivalenti ===============
# Nota: TUTTI i modelli supportano stability, similarity_boost, style,
# use_speaker_boost. Sono i 4 parametri "core" della voice_settings API.
# Non ci sono altri parametri per-modello nella VoiceSettings ufficiale.
# → NIENTE differenze inevitabili da annotare per questo aspetto.
BASE_VOICE_SETTINGS = VoiceSettings(
    stability=0.55,
    similarity_boost=0.75,
    style=0.20,
    use_speaker_boost=True,
)

# === Note sui parametri per-modello (per trasparenza) ========================
MODEL_NOTES = {
    "eleven_v3": {
        "output_format_supported": True,
        "voice_settings_supported": True,
        "notes": (
            "Modello v3 — supporta text emotion tags [warmly], [concerned], ecc. "
            "Nel test IO NON uso tag emotion nel testo per confronto pulito "
            "(gli altri modelli non li rispettano). "
            "Non supporta optimize_streaming_latency (API 400). "
            "Nel test uso il testo esattamente come agli altri modelli."
        ),
    },
    "eleven_flash_v2_5": {
        "output_format_supported": True,
        "voice_settings_supported": True,
        "notes": (
            "Modello flash — ottimizzato per latenza. Meno espressivo di v3. "
            "Supporta optimize_streaming_latency (0-4) MA nel test NON lo uso "
            "per confronto apples-to-apples con v3 e turbo."
        ),
    },
    "eleven_turbo_v2_5": {
        "output_format_supported": True,
        "voice_settings_supported": True,
        "notes": (
            "Modello turbo — via di mezzo tra flash e v3. "
            "Supporta optimize_streaming_latency (0-4) MA nel test NON lo uso."
        ),
    },
}

# === Test sentences ==========================================================
SENTENCES = [
    (
        "calda_neutra",
        "Ciao, come va oggi? Sono qui, con calma.",
    ),
    (
        "concerned",
        "Senti, ti capisco. Quello che mi racconti pesa tanto.",
    ),
    (
        "energica",
        "Che bello! Sono davvero felice per te, dimmi tutto.",
    ),
    (
        "lunga_naturale",
        "Allora, la prima cosa è capire se davvero hai perso la rotta o se è "
        "solo stanchezza che ti fa vedere tutto grigio — succede quando tiri "
        "per mesi di fila senza fermarti mai. Prova questo: prendi carta e "
        "penna, scrivi solo tre righe, quali erano gli obiettivi quando hai "
        "iniziato, quali sono adesso, cosa è cambiato tra allora e ora. "
        "Non deve essere lungo, non deve essere bello — deve essere onesto.",
    ),
]

MODELS = [
    "eleven_v3",
    "eleven_flash_v2_5",
    "eleven_turbo_v2_5",
]

# === Runner ==================================================================
def generate_one(client: ElevenLabs, sentence_id: str, text: str, model: str) -> Dict[str, Any]:
    """Esegue una singola generazione, misura TTFA e wall time, salva MP3."""
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

    # Save file
    out_path = f"/tmp/poc_koda_{sentence_id}_{model}.mp3"
    if mp3:
        with open(out_path, "wb") as f:
            f.write(mp3)

    # Compute audio duration via miniaudio
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
        "sentence_id": sentence_id,
        "model": model,
        "voice_id": VOICE_ID,
        "chars": len(text),
        "ttfa_ms": ttfa_ms,
        "wall_ms": wall_ms,
        "mp3_bytes": len(mp3),
        "audio_dur_s": round(audio_dur_s, 2) if audio_dur_s else None,
        "audio_path": out_path if mp3 else None,
        "error": error,
    }


def main():
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)

    # Warm-up: prima chiamata scarta l'overhead TLS
    print("Warmup (throw-away call to establish connection)...")
    try:
        _warm = generate_one(client, "warmup", "Ciao.", "eleven_flash_v2_5")
        print(f"  warmup: {_warm.get('ttfa_ms')}ms, {_warm.get('wall_ms')}ms, err={_warm.get('error')}\n")
    except Exception as e:
        print(f"  warmup failed: {e}")

    results: List[Dict[str, Any]] = []

    for sentence_id, text in SENTENCES:
        print(f"=== {sentence_id} ({len(text)} chars) ===")
        for model in MODELS:
            print(f"  → {model}...", flush=True, end=" ")
            r = generate_one(client, sentence_id, text, model)
            results.append(r)
            if r["error"]:
                print(f"ERROR: {r['error']}")
            else:
                print(f"TTFA={r['ttfa_ms']}ms  wall={r['wall_ms']}ms  size={r['mp3_bytes']/1024:.1f}KB  dur={r['audio_dur_s']}s")
            time.sleep(0.3)  # respiro tra chiamate
        print()

    # Print matrix
    print("\n" + "=" * 100)
    print(f"{'Sentence':<18}{'Model':<22}{'TTFA (ms)':<12}{'Wall (ms)':<12}{'Dur (s)':<10}{'Path':<40}")
    print("=" * 100)
    for r in results:
        p = r.get("audio_path") or ""
        p_short = p.replace("/tmp/", "")
        err = r.get("error")
        ttfa = "-" if err else str(r["ttfa_ms"])
        wall = "-" if err else str(r["wall_ms"])
        dur = "-" if err else str(r.get("audio_dur_s") or "-")
        print(f"{r['sentence_id']:<18}{r['model']:<22}{ttfa:<12}{wall:<12}{dur:<10}{p_short:<40}")

    # Aggregated: TTFA average per model
    print("\n" + "=" * 60)
    print("MEDIA TTFA per modello (esclusi errori):")
    print("=" * 60)
    for m in MODELS:
        vals = [r["ttfa_ms"] for r in results if r["model"] == m and r["ttfa_ms"] is not None]
        if vals:
            avg = sum(vals) / len(vals)
            print(f"  {m:<22} avg TTFA = {avg:.0f}ms  (min={min(vals)}, max={max(vals)}, n={len(vals)})")

    # Save JSON
    out = {
        "voice_id": VOICE_ID,
        "voice_id_note": "ll9WG7PDTuyHwgC5MD6g = Vento (maschile) — voce Koda produzione utente Fabio",
        "output_format": OUTPUT_FORMAT,
        "voice_settings_used": {
            "stability": BASE_VOICE_SETTINGS.stability,
            "similarity_boost": BASE_VOICE_SETTINGS.similarity_boost,
            "style": BASE_VOICE_SETTINGS.style,
            "use_speaker_boost": BASE_VOICE_SETTINGS.use_speaker_boost,
        },
        "voice_settings_compatibility": (
            "Tutti e 3 i modelli supportano stability, similarity_boost, style, "
            "use_speaker_boost con semantica equivalente. Nessuna differenza "
            "inevitabile da annotare per questi 4 parametri."
        ),
        "model_notes": MODEL_NOTES,
        "sentences": {sid: text for sid, text in SENTENCES},
        "results": results,
    }
    with open("/tmp/poc_koda_model_compare.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nJSON results: /tmp/poc_koda_model_compare.json")
    print(f"Audio files:  /tmp/poc_koda_*.mp3  ({len([r for r in results if r.get('audio_path')])} files)")
    print("\nAscolta i file affiancati per giudicare identità/timbro/naturalezza/prosodia.")


if __name__ == "__main__":
    main()
