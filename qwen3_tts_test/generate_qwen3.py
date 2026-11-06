"""
Qwen3-TTS - Generatore test voce italiana via HuggingFace Space.

Stato verificato il 6 nov 2026:
    - Space pubblico `Qwen/Qwen3-TTS-Demo` espone SOLO l'endpoint /tts_interface
      con voci preset (es. "Dolce / 意大利语-多尔切" per italiano).
    - NON esiste endpoint voice-clone su questa demo pubblica: non è possibile
      replicare via API la voce di riferimento dell'utente.
    - I pesi `Qwen/Qwen3-TTS-Flash-0.6B-Base` sono scaricabili da HF ma
      richiedono GPU/MLX per inferenza (non eseguibile nel container Python
      senza GPU). Solo on-device (iOS MLX / CUDA) può testare il voice design.

Uso:
    python generate_qwen3.py                 # 5 frasi con voce preset "Dolce"
    python generate_qwen3.py 0               # solo frase indice 0
    VOICE="Jennifer / 詹妮弗" python generate_qwen3.py   # altra voce preset

Output: out_0.wav ... out_4.wav in /app/qwen3_tts_test/
"""
import os
import sys
import time
import shutil
from pathlib import Path
from gradio_client import Client

WORKDIR = Path(__file__).resolve().parent

# 5 frasi scelte per stress-test prosodia empatica/conversazionale di Ollenya
SENTENCES = [
    "Ciao, sono qui. Raccontami pure, non devo essere da nessuna parte stasera.",
    "Oggi è stata una giornata lunga, lo sento dalla tua voce. Vuoi fermarti un attimo con me?",
    "A volte basta un respiro, piano, prima di decidere qualsiasi cosa.",
    "Non devi avere tutte le risposte adesso, nemmeno io le ho. Però posso starti accanto.",
    "Buonanotte piano piano. Domani ci sentiamo quando ti va, non c'è fretta.",
]

SPACE = "Qwen/Qwen3-TTS-Demo"
VOICE = os.environ.get("VOICE", "Dolce / 意大利语-多尔切")   # preset italiana default
LANGUAGE = "Italian / 意大利语"
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")


def make_client():
    kwargs = {"hf_token": HF_TOKEN} if HF_TOKEN else {}
    print(f"[qwen3] connessione a {SPACE} (token={'sì' if HF_TOKEN else 'no'})")
    return Client(SPACE, **kwargs)


def generate_one(client, idx: int, text: str) -> str | None:
    out_path = WORKDIR / f"out_{idx}.wav"
    print(f"\n[qwen3] [{idx}] voce='{VOICE}' lang='{LANGUAGE}'")
    print(f"[qwen3] [{idx}] text: {text}")
    t0 = time.time()
    try:
        result = client.predict(
            text,
            VOICE,
            LANGUAGE,
            api_name="/tts_interface",
        )
        dur = time.time() - t0
        src = result if isinstance(result, str) else (result[0] if result else None)
        if not src or not os.path.exists(src):
            print(f"[qwen3] [{idx}] output mancante: {result!r}")
            return None
        shutil.copy2(src, out_path)
        print(f"[qwen3] [{idx}] ok in {dur:.1f}s -> {out_path}")
        return str(out_path)
    except Exception as e:
        msg = str(e)
        print(f"[qwen3] [{idx}] ERRORE: {msg[:500]}")
        if any(k in msg.lower() for k in ("quota", "zerogpu", "gpu", "exceeded")):
            print("[qwen3] ⚠️ Quota ZeroGPU esaurita — stop.")
        return None


def main():
    try:
        client = make_client()
    except Exception as e:
        print(f"[qwen3] impossibile connettersi: {e}")
        sys.exit(2)

    if len(sys.argv) > 1:
        idx = int(sys.argv[1])
        ok = generate_one(client, idx, SENTENCES[idx])
        sys.exit(0 if ok else 1)

    results = []
    for i, s in enumerate(SENTENCES):
        ok = generate_one(client, i, s)
        results.append(ok)
        if ok is None:
            print("[qwen3] stop: errore o quota esaurita.")
            break
    print("\n[qwen3] riepilogo:")
    for i, r in enumerate(results):
        print(f"  [{i}] {'OK ' + r if r else 'FALLITO'}")


if __name__ == "__main__":
    main()
