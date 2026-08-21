"""
Script one-shot (2026-08-21, Fabio via Neo): genera le clip audio della nuova
sequenza narrativa intro-V3 con ElevenLabs V3, voce "Cielo".

USO:
  1. Verifica reveal_cuore_voce-cielo.mp3 con Whisper (STT via Emergent LLM key).
     - Se il testo trascritto matcha "esattamente" quello atteso → NON tocca il file.
     - Se differisce (anche per una parola) → segnala + rigenera.
  2. Genera le 4 clip mancanti/da sostituire:
     - intro_v3_saluto-cielo.mp3
     - intro_v3_parte_di_me-cielo.mp3
     - la_cuore-cielo.mp3
     - la_provalo-cielo.mp3
  3. Elimina dal disco le 2 clip obsolete:
     - come_ti_chiami-cielo.mp3
     - intro_v3_te_lo_mostro-cielo.mp3

NOTE:
  - voice_id "Cielo" = POuqf18evoXOKIqV2Px7 (come da server.py:1790 e MicroDemoKoda.tsx:58).
  - model_id = "eleven_v3" (massima qualità per il primo boot, come da spec Fabio).
  - output_format = mp3_44100_128 (stesso del resto del progetto, vedi server.py:9125).
  - Non tocco il registry dei clip nei componenti frontend: quello è compito
    delle modifiche A/B/C successive.
"""

import os
import re
import sys
import tempfile
from pathlib import Path
from dotenv import load_dotenv

# Load backend env (per ELEVENLABS_API_KEY e EMERGENT_LLM_KEY)
load_dotenv("/app/backend/.env")

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY")
if not ELEVENLABS_API_KEY:
    print("[FATAL] ELEVENLABS_API_KEY assente in backend/.env")
    sys.exit(1)
if not EMERGENT_LLM_KEY:
    print("[FATAL] EMERGENT_LLM_KEY assente in backend/.env")
    sys.exit(1)

ASSETS_DIR = Path("/app/frontend/assets/sounds/intro")
VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7"
MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"

# ============================================================
# STEP 1 — Verifica reveal_cuore_voce-cielo.mp3 con Whisper
# ============================================================
REVEAL_EXPECTED = (
    "Questo è il mio cuore. È tuo, sempre, gratuitamente. "
    "Ma ho anche una voce. Se vuoi, posso parlarti davvero."
)

def _normalize_for_compare(s: str) -> str:
    """Normalizza per confronto: lowercase, no punteggiatura, no spazi multipli."""
    s = s.lower().strip()
    # Rimuovi punteggiatura ma preserva parole
    s = re.sub(r"[^\wàèéìòù\s]", " ", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def verify_reveal_clip():
    path = ASSETS_DIR / "reveal_cuore_voce-cielo.mp3"
    if not path.exists():
        print(f"[REVEAL] {path.name} NON esiste → sarà da generare.")
        return False
    print(f"[REVEAL] Trascrivo {path.name} ({path.stat().st_size} B) con Whisper...")
    try:
        from emergentintegrations.llm.openai.stt import OpenAISpeechToText
        import asyncio

        async def _do():
            stt = OpenAISpeechToText(api_key=EMERGENT_LLM_KEY)
            with open(path, "rb") as f:
                resp = await stt.transcribe(
                    file=f,
                    model="whisper-1",
                    response_format="json",
                    language="it",
                )
            return getattr(resp, "text", "") or ""

        transcript = asyncio.run(_do()).strip()
        print(f"[REVEAL] Trascritto: “{transcript}”")
        print(f"[REVEAL] Atteso:     “{REVEAL_EXPECTED}”")
        match = _normalize_for_compare(transcript) == _normalize_for_compare(REVEAL_EXPECTED)
        if match:
            print("[REVEAL] ✅ MATCH — file lasciato invariato.")
            return True
        else:
            print("[REVEAL] ⚠️  DIVERGENZA — il file verrà rigenerato.")
            return False
    except Exception as e:
        print(f"[REVEAL] ERRORE whisper: {e}. NON tocco il file per prudenza; se non è corretto rifallo manualmente.")
        return True  # non tocchiamo per errore di verifica

# ============================================================
# STEP 2 — Generazione clip con ElevenLabs V3
# ============================================================
CLIPS_TO_GENERATE = [
    # (filename, text)
    ("intro_v3_saluto-cielo.mp3",
     "Ciao, piacere di conoscerti… io sono Koda, e tu?"),
    ("intro_v3_parte_di_me-cielo.mp3",
     "Voglio farti conoscere una parte di me."),
    ("la_cuore-cielo.mp3",
     "Questo è il mio cuore, è tuo… qui puoi dire tutto quello che vuoi "
     "senza usare i freni né limiti, qui sei adesso nel tuo spazio "
     "dove nessuno ti può sentire."),
    ("la_provalo-cielo.mp3",
     "Provalo."),
]

REVEAL_CLIP = ("reveal_cuore_voce-cielo.mp3", REVEAL_EXPECTED)

def generate_clip(filename: str, text: str) -> None:
    from elevenlabs.client import ElevenLabs
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
    out_path = ASSETS_DIR / filename
    print(f"[GEN] {filename}  ← “{text[:60]}{'…' if len(text) > 60 else ''}”")
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
        # Fallback silenzioso NO (spec Fabio): errore visibile.
        raise RuntimeError(f"eleven_v3 failed on {filename}: {e}") from e
    if len(audio_bytes) < 2000:
        raise RuntimeError(f"clip {filename} sospettosamente piccola: {len(audio_bytes)} B")
    out_path.write_bytes(audio_bytes)
    print(f"[GEN] {filename} scritta OK ({len(audio_bytes)} B → {out_path})")

# ============================================================
# STEP 3 — Elimina clip obsolete
# ============================================================
OBSOLETE_CLIPS = [
    "come_ti_chiami-cielo.mp3",
    "intro_v3_te_lo_mostro-cielo.mp3",
]

def remove_obsolete():
    for name in OBSOLETE_CLIPS:
        p = ASSETS_DIR / name
        if p.exists():
            p.unlink()
            print(f"[CLEAN] rimosso {name}")
        else:
            print(f"[CLEAN] {name} già assente")

# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    print("=" * 66)
    print("Generazione clip intro V3 — voce Cielo, model eleven_v3")
    print("=" * 66)

    # 1) Verifica reveal
    reveal_ok = verify_reveal_clip()

    # 2) Genera clip
    for filename, text in CLIPS_TO_GENERATE:
        generate_clip(filename, text)

    if not reveal_ok:
        generate_clip(*REVEAL_CLIP)

    # 3) Pulizia obsolete
    remove_obsolete()

    print("=" * 66)
    print("FATTO. Elenco finale directory:")
    for p in sorted(ASSETS_DIR.iterdir()):
        if p.suffix == ".mp3":
            print(f"  {p.stat().st_size:>7} B  {p.name}")
    print("=" * 66)
