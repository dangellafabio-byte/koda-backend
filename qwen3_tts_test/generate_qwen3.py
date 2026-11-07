"""
Qwen3-TTS - voice-clone 0.6B via HuggingFace Space Qwen/Qwen3-TTS.
Lingue API: Auto/Chinese/English/Japanese/Korean/French/German/Spanish/Portuguese/Russian.
NB: italiano NON in elenco -> uso 'Auto'.

Uso:
    python generate_qwen3.py          # tutte e 5
    python generate_qwen3.py 0        # solo frase 0

Variabili d'ambiente:
    HF_TOKEN   token HF se la quota anonima è esaurita
    REF_TEXT   trascrizione dell'audio di riferimento (consigliato; vuoto = ASR interno)
    REF_AUDIO  path audio ref (default reference_audio.wav)
    MODEL_SIZE '0.6B' (default) o '1.7B'
"""
import os
import sys
import time
import shutil
from pathlib import Path
from gradio_client import Client, handle_file

WORKDIR = Path(__file__).resolve().parent
REF_AUDIO = os.environ.get("REF_AUDIO", str(WORKDIR / "reference_audio.wav"))
REF_TEXT = os.environ.get("REF_TEXT", "")  # vuoto -> ASR interno dello Space
MODEL_SIZE = os.environ.get("MODEL_SIZE", "0.6B")
LANGUAGE = "Auto"  # italiano non supportato esplicitamente, Auto fa auto-detect
SPACE = "Qwen/Qwen3-TTS"
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")

SENTENCES = [
    "Ciao, sono qui. Raccontami pure, non devo essere da nessuna parte stasera.",
    "Oggi è stata una giornata lunga, lo sento dalla tua voce. Vuoi fermarti un attimo con me?",
    "A volte basta un respiro, piano, prima di decidere qualsiasi cosa.",
    "Non devi avere tutte le risposte adesso, nemmeno io le ho. Però posso starti accanto.",
    "Buonanotte piano piano. Domani ci sentiamo quando ti va, non c'è fretta.",
]


def make_client():
    kwargs = {"hf_token": HF_TOKEN} if HF_TOKEN else {}
    print(f"[qwen3] connessione a {SPACE} (token={'sì' if HF_TOKEN else 'no'})")
    return Client(SPACE, **kwargs)


def generate_one(client, idx: int, text: str) -> str | None:
    out_path = WORKDIR / f"out_{idx}.wav"
    print(f"\n[qwen3] [{idx}] model={MODEL_SIZE} lang={LANGUAGE}")
    print(f"[qwen3] [{idx}] ref_audio={REF_AUDIO}")
    print(f"[qwen3] [{idx}] ref_text={'(vuoto, ASR interno)' if not REF_TEXT else REF_TEXT[:80]}")
    print(f"[qwen3] [{idx}] target: {text}")
    t0 = time.time()
    try:
        result = client.predict(
            handle_file(REF_AUDIO),   # ref_audio
            REF_TEXT,                 # ref_text
            text,                     # target_text
            LANGUAGE,                 # language
            False,                    # use_xvector_only
            MODEL_SIZE,               # model_size
            api_name="/generate_voice_clone",
        )
        dur = time.time() - t0
        audio_path, status = (result[0], result[1]) if isinstance(result, (list, tuple)) else (result, "")
        print(f"[qwen3] [{idx}] status={status!r}")
        if not audio_path or not os.path.exists(audio_path):
            print(f"[qwen3] [{idx}] output mancante: {result!r}")
            return None
        shutil.copy2(audio_path, out_path)
        print(f"[qwen3] [{idx}] ok in {dur:.1f}s -> {out_path}")
        return str(out_path)
    except Exception as e:
        msg = str(e)
        print(f"[qwen3] [{idx}] ERRORE: {msg[:600]}")
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
