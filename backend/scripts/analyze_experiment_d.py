"""
EXPERIMENT D — TTS reali per minuto di conversazione
=====================================================

Analizza i log del backend (Emergent pod o Railway) per calcolare:

  - Secondi di TTS Koda REALMENTE sintetizzati per turno
  - Millisecondi di parlato UTENTE per turno
  - Ratio "TTS_koda_seconds / (user_audio_seconds + tts_koda_seconds)"

Log necessari (grep-friendly, aggiunti a server.py 2026-09-10):
  - `[KODA_TIMING] USER_PAYLOAD sid=... user_audio_ms=<int>`
  - `[KODA_TTS_DUR] sid=... idx=... chunk_dur_seconds=<float>`

Uso locale (Emergent pod):
  python scripts/analyze_experiment_d.py /var/log/supervisor/backend.err.log

Uso su Railway (via CLI o dashboard):
  railway logs --json | python scripts/analyze_experiment_d.py -

Output: statistiche aggregate per rispondere alla domanda:
  "230 minuti di piano venduti = quanti minuti effettivi di TTS Koda?"
"""

import sys
import re
from collections import defaultdict


USER_PAYLOAD_RE = re.compile(
    r"\[KODA_TIMING\]\s+USER_PAYLOAD\s+sid=(?P<sid>\w+).*?user_audio_ms=(?P<user_ms>-?\d+)"
)
TTS_DUR_RE = re.compile(
    r"\[KODA_TTS_DUR\]\s+sid=(?P<sid>\w+)\s+idx=(?P<idx>\d+)\s+chunk_dur_seconds=(?P<dur>[\d.]+)"
)


def analyze(lines):
    """
    Aggrega per SID (sessione).
    Per ogni SID: somma user_audio_ms + somma tts_dur_seconds.
    Ratio finale calcolata su totale.
    """
    per_sid_user_ms = defaultdict(float)
    per_sid_user_count = defaultdict(int)  # numero di turni utente in questa sessione
    per_sid_tts_seconds = defaultdict(float)
    per_sid_tts_chunks = defaultdict(int)

    for line in lines:
        m = USER_PAYLOAD_RE.search(line)
        if m:
            sid = m.group("sid")
            ms = int(m.group("user_ms"))
            if ms > 0:
                per_sid_user_ms[sid] += ms
                per_sid_user_count[sid] += 1
            continue
        m = TTS_DUR_RE.search(line)
        if m:
            sid = m.group("sid")
            dur = float(m.group("dur"))
            per_sid_tts_seconds[sid] += dur
            per_sid_tts_chunks[sid] += 1

    return {
        "per_sid_user_ms": dict(per_sid_user_ms),
        "per_sid_user_count": dict(per_sid_user_count),
        "per_sid_tts_seconds": dict(per_sid_tts_seconds),
        "per_sid_tts_chunks": dict(per_sid_tts_chunks),
    }


def report(agg):
    """Stampa report leggibile + statistiche aggregate."""
    all_sids = set(agg["per_sid_user_ms"]) | set(agg["per_sid_tts_seconds"])
    if not all_sids:
        print("⚠️  Nessun log KODA_TIMING/KODA_TTS_DUR trovato nell'input.")
        print("   Verifica di aver deployato la nuova versione con la telemetria D.")
        return

    print("=" * 80)
    print("EXPERIMENT D — TTS reali per conversazione Koda")
    print("=" * 80)
    print()
    print(f"{'sid':<12} {'turni':<7} {'user_s':<10} {'tts_s':<10} "
          f"{'tts_chunks':<12} {'ratio_TTS/total':<18}")
    print("-" * 80)

    total_user_ms = 0
    total_tts_seconds = 0.0
    total_user_turns = 0
    total_tts_chunks = 0

    for sid in sorted(all_sids):
        user_ms = agg["per_sid_user_ms"].get(sid, 0.0)
        user_turns = agg["per_sid_user_count"].get(sid, 0)
        tts_s = agg["per_sid_tts_seconds"].get(sid, 0.0)
        tts_chunks = agg["per_sid_tts_chunks"].get(sid, 0)

        user_s = user_ms / 1000.0
        total_s = user_s + tts_s
        ratio = (tts_s / total_s) if total_s > 0 else 0.0

        print(f"{sid:<12} {user_turns:<7} {user_s:<10.2f} {tts_s:<10.2f} "
              f"{tts_chunks:<12} {ratio*100:>6.1f}% TTS / {(1-ratio)*100:.1f}% USER")

        total_user_ms += user_ms
        total_user_turns += user_turns
        total_tts_seconds += tts_s
        total_tts_chunks += tts_chunks

    print("-" * 80)
    total_user_s = total_user_ms / 1000.0
    grand_total_s = total_user_s + total_tts_seconds
    grand_ratio = (total_tts_seconds / grand_total_s) if grand_total_s > 0 else 0.0

    print(f"{'TOTALE':<12} {total_user_turns:<7} {total_user_s:<10.2f} "
          f"{total_tts_seconds:<10.2f} {total_tts_chunks:<12} "
          f"{grand_ratio*100:>6.1f}% TTS / {(1-grand_ratio)*100:.1f}% USER")
    print()
    print("=" * 80)
    print("RISPOSTA ESPERIMENTO D")
    print("=" * 80)
    print(f"Conversazione totale osservata : {grand_total_s:.1f}s "
          f"({grand_total_s/60:.2f} min)")
    print(f"TTS Koda sintetizzato          : {total_tts_seconds:.1f}s "
          f"({total_tts_seconds/60:.2f} min)")
    print(f"Utente parlato                 : {total_user_s:.1f}s "
          f"({total_user_s/60:.2f} min)")
    print()
    print(f"→ Per ogni MINUTO di conversazione, TTS Koda sintetizzato: "
          f"{grand_ratio*60:.1f}s ({grand_ratio*100:.1f}%)")
    print()
    if grand_ratio > 0 and total_tts_seconds > 0:
        # Proiezione: se il paywall vende 230 min "di conversazione",
        # quanto TTS reale genera?
        tts_per_conversation_minute = grand_ratio  # frazione di minuto = secondi/60
        print(f"PROIEZIONE per piano da 230 min di conversazione:")
        print(f"  TTS reale generato: {230 * tts_per_conversation_minute:.1f} min "
              f"({230 * tts_per_conversation_minute * 60:.0f}s)")
        print(f"  Costo ElevenLabs (a €0.023/min TTS): "
              f"€{230 * tts_per_conversation_minute * 0.023:.2f}")
    else:
        print("(dati insufficienti per proiezione)")
    print("=" * 80)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <logfile> | -  (stdin)")
        sys.exit(1)

    path = sys.argv[1]
    if path == "-":
        lines = sys.stdin.readlines()
    else:
        with open(path, "r", errors="replace") as f:
            lines = f.readlines()

    agg = analyze(lines)
    report(agg)


if __name__ == "__main__":
    main()
