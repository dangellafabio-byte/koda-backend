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
# v4 (2026-07-31) — Fabio: "l'audio suona frettoloso, aggiungi respiro tra
# le frasi. Mantieni gli altri parametri invariati, agisci solo su
# ritmo/pause. Se necessario abbassa lievemente speed (0.92-0.94)."
#
# Strategia:
#   1. Cielo: speed 0.93 (era 0.97) — abbassato di 4% come autorizzato,
#      SOLO per questo audio promo. Il resto (stability/style/similarity)
#      resta identico alla config warm di produzione.
#   2. Il monologo Cielo viene generato in 4 BEAT SEPARATI e concatenati
#      con silenzi programmatici di 900ms → respiro reale tra pensieri
#      diversi, non affidato all'interpretazione della punteggiatura da
#      parte di ElevenLabs (che tende a pause corte).
#   3. Vento invariato: parametri warm produzione, speed 0.97 originale.
#
# Estratto ESATTAMENTE da server.py:_voice_settings_for_tone(tone="warm"),
# con speed override 0.93 SOLO per Cielo promo:
#   stability:        0.40  (warm tone default)
#   style:            0.55  (warm tone default)
#   speed:            0.93  (override promo, era 0.97 in-app)
#   similarity_boost: 0.82  (base_similarity per tutti i toni)
#   use_speaker_boost: True (sempre attivo in produzione)
VOICE_SETTINGS_CIELO_PROMO = {
    "stability": 0.40,
    "similarity_boost": 0.82,
    "style": 0.55,
    "speed": 0.93,
    "use_speaker_boost": True,
}

# Vento: config warm invariata (speed 0.97 come in-app).
VOICE_SETTINGS_VENTO_PROMO = {
    "stability": 0.40,
    "similarity_boost": 0.82,
    "style": 0.55,
    "speed": 0.97,
    "use_speaker_boost": True,
}

# === SCRIPT ================================================================
# v4 (2026-07-31) — Testo INVARIATO dalla v3 approvata, ma spezzato in
# BEAT separati per permettere pause programmatiche di respiro tra un
# pensiero e l'altro. Ogni CIELO_BEAT_N viene generato come clip
# indipendente e concatenato con 900ms di silenzio.
#
# Struttura narrativa:
#   Beat 1 → presentazione ("Ciao. Sono Koda.")
#   Beat 2 → promessa d'ascolto ("Quando mi parli, io ci sono...")
#   Beat 3 → cuore emotivo ("A volte hai solo bisogno... davvero accolto.
#            Io sono fatta per questo.")
#   Beat 4 → disclaimer riformulato ("Non sono una terapista...")
#   [PAUSA più lunga 1200ms]
#   Vento → chiusura maschile
#
# NOTA LEGALE: script E qualsiasi variante DEVONO essere validati da un
# avvocato prima della pubblicazione su TikTok/Instagram.
CIELO_BEATS = [
    # Beat 1 — Presentazione
    "Ciao. Sono Koda.",

    # Beat 2 — Promessa d'ascolto
    "Quando mi parli, io ci sono. "
    "Ti ascolto, senza quella fretta di darti una risposta... "
    "o di trovarti una soluzione.",

    # Beat 3 — Cuore emotivo
    "A volte hai solo bisogno di dire le cose ad alta voce, "
    "e sentire che quello che hai detto è stato davvero accolto. "
    "Io sono fatta per questo.",

    # Beat 4 — Disclaimer riformulato con empatia
    "Non sono una terapista, "
    "e questo non è un percorso terapeutico — "
    "è solo uno spazio dove puoi essere onesto, "
    "anche con te stesso.",
]

# Chiusura maschile — invariata.
VENTO_TEXT = (
    "E se preferisci sentirmi così, va bene lo stesso. "
    "Scegli tu."
)

# === PAUSE TRA I SEGMENTI ===================================================
# v4 (2026-07-31) — Pause di RESPIRO tra i beat di Cielo per evitare tono
# frettoloso. Valori scelti per lasciare "un pensiero completato" prima
# del successivo, senza far cadere l'attenzione.
PAUSE_BETWEEN_CIELO_BEATS_MS = 900   # respiro tra beat Cielo consecutivi
PAUSE_BEFORE_MALE_MS = 1200          # pausa più lunga prima del cambio voce
                                     # (era 1000ms in v3, alzata per enfasi
                                     # sul "colpo di scena" maschile)

# Fade in/out finali per morbidezza (evita click al taglio)
FADE_IN_MS = 60
FADE_OUT_MS = 400


# === FUNZIONI ===============================================================
def synthesize(
    client: ElevenLabs,
    text: str,
    voice_id: str,
    label: str,
    voice_settings: dict,
) -> Path:
    """Genera un MP3 usando la config vocale indicata."""
    print(f"[→] Generazione {label} ({len(text)} caratteri)...")
    audio_gen = client.text_to_speech.convert(
        voice_id=voice_id,
        text=text,
        model_id=MODEL_ID,
        output_format=OUTPUT_FORMAT,
        voice_settings=voice_settings,
    )
    output_path = OUTPUT_DIR / f"{label}.mp3"
    with open(output_path, "wb") as f:
        for chunk in audio_gen:
            if chunk:
                f.write(chunk)
    size_kb = output_path.stat().st_size / 1024
    print(f"[✓] {label}.mp3 salvato ({size_kb:.1f} KB)")
    return output_path


def combine_beats(beat_paths: list[Path], vento_path: Path, out_path: Path) -> Path:
    """Concatena tutti i beat Cielo (con 900ms di respiro tra loro),
    poi 1200ms di pausa, poi Vento. Applica fade in/out finali."""
    print("[→] Concatenazione beat con pause di respiro...")

    silence_between_beats = AudioSegment.silent(duration=PAUSE_BETWEEN_CIELO_BEATS_MS)
    silence_before_male = AudioSegment.silent(duration=PAUSE_BEFORE_MALE_MS)

    # Assemblaggio Cielo con respiri tra beat
    combined = AudioSegment.empty()
    for i, bp in enumerate(beat_paths):
        beat_audio = AudioSegment.from_mp3(bp)
        combined += beat_audio
        # Aggiungi respiro DOPO ogni beat tranne l'ultimo
        if i < len(beat_paths) - 1:
            combined += silence_between_beats

    # Pausa lunga prima del cambio voce, poi Vento
    vento = AudioSegment.from_mp3(vento_path)
    combined += silence_before_male + vento

    # Fade morbido inizio/fine
    combined = combined.fade_in(FADE_IN_MS).fade_out(FADE_OUT_MS)

    combined.export(str(out_path), format="mp3", bitrate="320k")
    print(f"[✓] Master finale salvato: {out_path}")
    print(f"    Durata totale: {len(combined) / 1000:.1f}s")
    return out_path


def main() -> None:
    print("=" * 60)
    print("Koda Teaser Audio Generator v4 (beat-based, breath pauses)")
    print("=" * 60)
    client = ElevenLabs(api_key=API_KEY)

    # Genera ciascun beat Cielo come clip separata
    beat_paths: list[Path] = []
    for i, beat_text in enumerate(CIELO_BEATS, start=1):
        beat_path = synthesize(
            client,
            beat_text,
            CIELO_VOICE_ID,
            f"cielo_beat_{i}_v4",
            VOICE_SETTINGS_CIELO_PROMO,
        )
        beat_paths.append(beat_path)

    # Genera chiusura Vento
    vento_path = synthesize(
        client,
        VENTO_TEXT,
        VENTO_VOICE_ID,
        "vento_closing_v4",
        VOICE_SETTINGS_VENTO_PROMO,
    )

    master_path = OUTPUT_DIR / "koda_teaser_v4.mp3"
    combine_beats(beat_paths, vento_path, master_path)

    print()
    print("=" * 60)
    print("File generati in /app/scripts/output/:")
    for i, _ in enumerate(CIELO_BEATS, start=1):
        print(f"  • cielo_beat_{i}_v4.mp3   — beat Cielo #{i}")
    print(f"  • vento_closing_v4.mp3   — chiusura Vento")
    print(f"  • koda_teaser_v4.mp3     — MASTER con respiri (900ms tra beat)")
    print("=" * 60)


if __name__ == "__main__":
    main()
