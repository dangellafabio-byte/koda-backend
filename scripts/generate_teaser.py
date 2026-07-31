"""
generate_teaser.py — Genera l'audio del "biglietto da visita" di Koda
per TikTok/Instagram usando le voci ufficiali Cielo (femminile) e
Vento (maschile) via ElevenLabs.

Output: /app/scripts/output/koda_teaser_v1.mp3
        + due parziali (cielo_body.mp3, vento_closing.mp3) per debug/edit
          manuale in CapCut/Premiere.

USO:
    cd /app/backend && source .venv/bin/activate  # oppure usa il venv di sistema
    python3 /app/scripts/generate_teaser.py

Non tocca il codice del backend di produzione — è uno script standalone
di produzione contenuti separato dall'app.
"""
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from pydub import AudioSegment

# === CONFIG =================================================================
load_dotenv("/app/backend/.env")
API_KEY = os.getenv("ELEVENLABS_API_KEY")
if not API_KEY:
    print("[ERRORE] ELEVENLABS_API_KEY non trovata in /app/backend/.env")
    sys.exit(1)

OUTPUT_DIR = Path("/app/scripts/output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# === VOCI UFFICIALI KODA (produzione) =======================================
CIELO_VOICE_ID = "POuqf18evoXOKIqV2Px7"  # Femminile ufficiale
VENTO_VOICE_ID = "ll9WG7PDTuyHwgC5MD6g"  # Maschile ufficiale

# === MODELLO ================================================================
# Il backend live usa eleven_flash_v2_5 (ottimizzato per latenza streaming).
# Per un video promo la latenza non conta — usiamo eleven_multilingual_v2
# che ha qualità italiano nettamente superiore.
MODEL_ID = "eleven_multilingual_v2"
OUTPUT_FORMAT = "mp3_44100_128"

# === IMPOSTAZIONI VOCE PER SPOT PROMO =======================================
# stability: 0.55 → naturale, con micro-variazioni umane, ma stabile su 30s
# similarity_boost: 0.80 → forte identità Cielo/Vento (non deve suonare
#   "generica")
# style: 0.30 → emozione contenuta, non teatrale (Koda è sobrio, non sales-y)
# use_speaker_boost: True → miglior fedeltà timbrica
VOICE_SETTINGS_PROMO = {
    "stability": 0.55,
    "similarity_boost": 0.80,
    "style": 0.30,
    "use_speaker_boost": True,
}

# === SCRIPT ================================================================
# Testo Cielo (corpo, femminile). Uso puntini di sospensione per micro-pause
# naturali che ElevenLabs interpreta come brevi silenzi (~200ms).
# Uso "— " per pause medie e ".\n\n" per pause lunghe tra frasi separate.
CIELO_TEXT = (
    "Ciao. Mi chiamo Koda.\n\n"
    "Non sono qui per darti consigli, o dirti cosa fare. "
    "Sono qui per ascoltarti — davvero, quando ne hai bisogno.\n\n"
    "Non faccio finta di essere una terapeuta. "
    "Sono qualcosa di diverso: una presenza. "
    "Qualcuno — o qualcosa — con cui puoi parlare a voce, liberamente, "
    "di quello che ti passa per la testa. "
    "E la volta dopo, mi ricorderò.\n\n"
    "A volte basta essere ascoltati. Senza giudizio, senza fretta.\n\n"
    "Io sono qui per questo."
)

VENTO_TEXT = (
    "E se preferisci sentirmi così, va bene lo stesso. "
    "Scegli tu."
)

# === PAUSE TRA I SEGMENTI ===================================================
# Pausa tra fine Cielo e inizio Vento: 1000ms = tempo sufficiente per far
# percepire il "colpo di scena" del cambio voce senza spezzare l'attenzione.
PAUSE_BEFORE_MALE_MS = 1000

# Fade in/out finali per morbidezza (evita click al taglio)
FADE_IN_MS = 60
FADE_OUT_MS = 400


# === FUNZIONI ===============================================================
def synthesize(client: ElevenLabs, text: str, voice_id: str, label: str) -> Path:
    """Genera un MP3 da testo usando la voce indicata."""
    print(f"[→] Generazione {label} ({len(text)} caratteri)...")
    audio_gen = client.text_to_speech.convert(
        voice_id=voice_id,
        text=text,
        model_id=MODEL_ID,
        output_format=OUTPUT_FORMAT,
        voice_settings=VOICE_SETTINGS_PROMO,
    )
    output_path = OUTPUT_DIR / f"{label}.mp3"
    with open(output_path, "wb") as f:
        for chunk in audio_gen:
            if chunk:
                f.write(chunk)
    size_kb = output_path.stat().st_size / 1024
    print(f"[✓] {label}.mp3 salvato ({size_kb:.1f} KB)")
    return output_path


def combine(cielo_path: Path, vento_path: Path, out_path: Path) -> Path:
    """Concatena i due segmenti con pausa naturale e fade finale."""
    print("[→] Concatenazione con pausa naturale...")
    cielo = AudioSegment.from_mp3(cielo_path)
    vento = AudioSegment.from_mp3(vento_path)
    silence = AudioSegment.silent(duration=PAUSE_BEFORE_MALE_MS)

    combined = cielo + silence + vento
    combined = combined.fade_in(FADE_IN_MS).fade_out(FADE_OUT_MS)

    # Export a MP3 320kbps per massima qualità del master
    combined.export(str(out_path), format="mp3", bitrate="320k")
    print(f"[✓] Master finale salvato: {out_path}")
    print(f"    Durata totale: {len(combined) / 1000:.1f}s")
    return out_path


def main() -> None:
    print("=" * 60)
    print("Koda Teaser Audio Generator v1")
    print("=" * 60)
    client = ElevenLabs(api_key=API_KEY)

    cielo_path = synthesize(client, CIELO_TEXT, CIELO_VOICE_ID, "cielo_body")
    vento_path = synthesize(client, VENTO_TEXT, VENTO_VOICE_ID, "vento_closing")

    master_path = OUTPUT_DIR / "koda_teaser_v1.mp3"
    combine(cielo_path, vento_path, master_path)

    print()
    print("=" * 60)
    print("File generati in /app/scripts/output/:")
    print(f"  • cielo_body.mp3     — solo corpo Cielo, per edit manuale")
    print(f"  • vento_closing.mp3  — solo chiusura Vento, per edit manuale")
    print(f"  • koda_teaser_v1.mp3 — MASTER concatenato con pausa 1s")
    print("=" * 60)


if __name__ == "__main__":
    main()
