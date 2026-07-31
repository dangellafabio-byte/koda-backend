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
# CRITICAL (Fabio 2026-07-31): il modello DEVE essere identico a quello
# che il backend usa in produzione per le conversazioni reali con l'utente.
# NON possiamo usare eleven_multilingual_v2 "perché ha qualità superiore" —
# darebbe una voce diversa da quella che l'utente sente nell'app.
# Il backend usa eleven_flash_v2_5 ovunque (server.py righe 6520, 6840,
# 7401, 7592, ecc.) → usiamo lo stesso qui, senza eccezioni.
MODEL_ID = "eleven_flash_v2_5"
OUTPUT_FORMAT = "mp3_44100_128"

# === IMPOSTAZIONI VOCE — IDENTICHE ALLA PRODUZIONE ==========================
# v3 (2026-07-31) — Fabio: "non inventare parametri, usa quelli veri dell'app".
# Estratto ESATTAMENTE da server.py:_voice_settings_for_tone(tone="warm"),
# che è il tono conversazionale di default di Koda in-app (commento in
# codice: "★ default: abbraccio caldo, naturale, presente").
#
# Questi sono I parametri della voce di Koda che l'utente sente ogni giorno
# nell'app. Il video promo DEVE suonare identico → identità coerente.
#
#   stability:        0.40  (warm tone default)
#   style:            0.55  (warm tone default)
#   speed:            0.97  (warm tone default)
#   similarity_boost: 0.82  (base_similarity per tutti i tonis)
#   use_speaker_boost: True (sempre attivo in produzione)
VOICE_SETTINGS_WARM = {
    "stability": 0.40,
    "similarity_boost": 0.82,
    "style": 0.55,
    "speed": 0.97,
    "use_speaker_boost": True,
}

# === SCRIPT ================================================================
# v3 (2026-07-31) — Versione finale approvata da Fabio.
# Riscritta rispetto alla v2 per:
#   - Tono più diretto e conciso (rimosso "Non sono qui per darti consigli...",
#     "presenza", "mi ricorderò" — semplificato in "io ci sono / ti ascolto")
#   - Inserito "davvero accolto" come parola-chiave emotiva centrale
#   - "Io sono fatta per questo" — assertivo, chiude il concetto principale
#   - "Non è un percorso terapeutico — è solo uno spazio dove puoi essere
#     onesto, anche con te stesso" → riformulazione forte del disclaimer
#     legale con framing empatico invece che difensivo
#
# NOTA LEGALE (promemoria Fabio 2026-07-31): questo script E qualsiasi
# variante futura DEVONO essere validati da un avvocato prima della
# pubblicazione su TikTok/Instagram, come il disclaimer in-app. Il linguaggio
# di marketing pubblico segue lo stesso percorso di review legale.
CIELO_TEXT = (
    "Ciao. Sono Koda.\n\n"
    "Quando mi parli, io ci sono. Ti ascolto, senza quella fretta "
    "di darti una risposta... o di trovarti una soluzione.\n\n"
    "A volte hai solo bisogno di dire le cose ad alta voce, "
    "e sentire che quello che hai detto è stato davvero accolto. "
    "Io sono fatta per questo.\n\n"
    "Non sono una terapista, e questo non è un percorso terapeutico — "
    "è solo uno spazio dove puoi essere onesto, anche con te stesso."
)

# Chiusura maschile (Vento). Testo INVARIATO dalla v1 — Fabio conferma
# nuovamente che va bene così.
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
    """Genera un MP3 usando la config vocale IDENTICA alla produzione (warm tone)."""
    print(f"[→] Generazione {label} ({len(text)} caratteri)...")
    audio_gen = client.text_to_speech.convert(
        voice_id=voice_id,
        text=text,
        model_id=MODEL_ID,
        output_format=OUTPUT_FORMAT,
        voice_settings=VOICE_SETTINGS_WARM,
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

    cielo_path = synthesize(client, CIELO_TEXT, CIELO_VOICE_ID, "cielo_body_v3")
    vento_path = synthesize(client, VENTO_TEXT, VENTO_VOICE_ID, "vento_closing_v3")

    master_path = OUTPUT_DIR / "koda_teaser_v3.mp3"
    combine(cielo_path, vento_path, master_path)

    print()
    print("=" * 60)
    print("File generati in /app/scripts/output/:")
    print(f"  • cielo_body_v3.mp3     — solo corpo Cielo, per edit manuale")
    print(f"  • vento_closing_v3.mp3  — solo chiusura Vento, per edit manuale")
    print(f"  • koda_teaser_v3.mp3    — MASTER concatenato con pausa 1s")
    print("=" * 60)


if __name__ == "__main__":
    main()
