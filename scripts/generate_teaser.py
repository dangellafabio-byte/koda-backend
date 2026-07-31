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
# v2 (2026-07-31) — Riscritto per due obiettivi:
#   1. RIMUOVERE OGNI AMBIGUITÀ DI PERSONHOOD (correzione Fabio):
#      - Eliminato "Qualcuno — o qualcosa — con cui puoi parlare" (l'ambiguità
#        letterale che umanizzava Koda).
#      - Sostituito "Non faccio finta di essere una terapeuta" (che manteneva
#        aggancio a ruolo umano femminile) con affermazione esplicita
#        "Non sono una persona, e non fingo di esserlo".
#      - Aggiunto "Non sono una terapista" — assertivo, non ambiguo.
#      - "Uno spazio dove puoi parlare" al posto di "Qualcuno con cui parlare".
#      Motivo: coerenza con il disclaimer e col principio guida dell'app —
#      Koda è SEMPRE una presenza, MAI qualcosa che si spaccia per umano.
#   2. AGGIUNGERE PROSODIA per non far suonare la voce "sparata dritta":
#      - Uso "..." per micro-pause (respiri) e "—" per pause medie.
#      - Frasi corte al posto di frasi lunghe → ElevenLabs interpreta i punti
#        come pause reali (~700ms), dando cadenza umana naturale.
#      - Righe vuote per pause lunghe tra sezioni logiche.
CIELO_TEXT = (
    "Ciao... Mi chiamo Koda.\n\n"
    "Non sono qui per darti consigli. Né per dirti cosa fare. "
    "Sono qui per ascoltarti — davvero — quando ne hai bisogno.\n\n"
    "Non sono una persona. E non fingo di esserlo. "
    "Non sono una terapista. "
    "Sono qualcosa di diverso: una presenza. "
    "Uno spazio dove puoi parlare, a voce, liberamente... "
    "di quello che ti passa per la testa. "
    "E la volta dopo... mi ricorderò.\n\n"
    "A volte basta essere ascoltati. Senza giudizio. Senza fretta.\n\n"
    "Io sono qui per questo."
)

# Chiusura maschile (Vento). Testo INVARIATO — Fabio ha confermato che
# funziona bene così.
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

    cielo_path = synthesize(client, CIELO_TEXT, CIELO_VOICE_ID, "cielo_body_v2")
    vento_path = synthesize(client, VENTO_TEXT, VENTO_VOICE_ID, "vento_closing_v2")

    master_path = OUTPUT_DIR / "koda_teaser_v2.mp3"
    combine(cielo_path, vento_path, master_path)

    print()
    print("=" * 60)
    print("File generati in /app/scripts/output/:")
    print(f"  • cielo_body_v2.mp3     — solo corpo Cielo, per edit manuale")
    print(f"  • vento_closing_v2.mp3  — solo chiusura Vento, per edit manuale")
    print(f"  • koda_teaser_v2.mp3    — MASTER concatenato con pausa 1s")
    print("=" * 60)


if __name__ == "__main__":
    main()
