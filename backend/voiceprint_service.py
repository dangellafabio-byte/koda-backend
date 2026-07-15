"""
Voiceprint Service — Speaker verification via Resemblyzer (GE2E embeddings).

Riconosce la voce specifica dell'utente (Fabio) e scarta chunk audio
provenienti da altre voci (rumore ambientale, vicini che parlano, TV, ecc.)
prima di inoltrarli a Deepgram STT.

Uso:
    from voiceprint_service import (
        extract_embedding_from_bytes,
        extract_embedding_from_path,
        compute_similarity,
        enroll_from_files,
    )

Architettura:
1. Enrollment: 3 file m4a (dall'onboarding) → estrai 3 embedding
   256-dim → media normalizzata → salva in MongoDB come reference.
2. Runtime (in WS voice_stream): per ogni chunk audio (~3s) →
   estrai embedding → cosine similarity con reference → se < soglia
   scarta prima di Deepgram (risparmia anche crediti Deepgram).

Threshold di default: 0.65 (empiricamente buono, tunabile per utente).
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import threading
from typing import Iterable, Optional

import numpy as np

logger = logging.getLogger(__name__)

# Lazy singletons — l'encoder carica in ~0.01s ma la prima chiamata
# a embed_utterance è ~10s (warmup PyTorch/JIT). Facciamo il warmup
# al primo utilizzo, non all'import.
_encoder_lock = threading.Lock()
_encoder = None
_ffmpeg_path: Optional[str] = None


def _get_encoder():
    """Restituisce l'istanza singleton di VoiceEncoder (lazy load)."""
    global _encoder
    if _encoder is None:
        with _encoder_lock:
            if _encoder is None:
                # Import lazy — resemblyzer non deve essere importato
                # al boot del server se voiceprint è disabilitato.
                from resemblyzer import VoiceEncoder  # type: ignore

                _encoder = VoiceEncoder(verbose=False)
                logger.info("[voiceprint] encoder loaded (Resemblyzer VoiceEncoder, CPU)")
    return _encoder


def _get_ffmpeg() -> str:
    """Path del binario ffmpeg statico (via imageio-ffmpeg)."""
    global _ffmpeg_path
    if _ffmpeg_path is None:
        import imageio_ffmpeg  # type: ignore

        _ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    return _ffmpeg_path


def _decode_audio_to_wav16k(audio_bytes: bytes, src_format_hint: str = "m4a") -> str:
    """Decodifica audio in-memory (m4a/webm/mp3/aac) → wav mono 16kHz temp file.

    Restituisce path del file wav (chiamante deve fare os.remove).
    """
    ffmpeg = _get_ffmpeg()
    # File temp di input (ffmpeg ha bisogno di un path)
    with tempfile.NamedTemporaryFile(suffix=f".{src_format_hint}", delete=False) as tmp_in:
        tmp_in.write(audio_bytes)
        in_path = tmp_in.name
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_out:
        out_path = tmp_out.name
    try:
        subprocess.run(
            [
                ffmpeg, "-y",
                "-i", in_path,
                "-ar", "16000",  # 16kHz (richiesto da resemblyzer)
                "-ac", "1",  # mono
                "-loglevel", "error",
                out_path,
            ],
            check=True,
            timeout=15,
        )
    finally:
        try:
            os.remove(in_path)
        except Exception:
            pass
    return out_path


def extract_embedding_from_path(audio_path: str) -> Optional[np.ndarray]:
    """Estrae embedding 256-dim (normalizzato) da un file audio.

    Supporta m4a, wav, mp3, webm, aac (via ffmpeg). Restituisce None se
    l'estrazione fallisce (audio troppo corto, file corrotto, ecc.).
    """
    from resemblyzer import preprocess_wav  # type: ignore

    try:
        if audio_path.lower().endswith(".wav"):
            wav_path = audio_path
            temp = False
        else:
            # Converti a wav 16kHz mono
            with open(audio_path, "rb") as fh:
                data = fh.read()
            wav_path = _decode_audio_to_wav16k(data, src_format_hint=audio_path.split(".")[-1])
            temp = True
        wav = preprocess_wav(wav_path)
        if len(wav) < 8000:  # meno di 0.5s → skip
            logger.warning(f"[voiceprint] audio too short: {audio_path}")
            if temp:
                try:
                    os.remove(wav_path)
                except Exception:
                    pass
            return None
        emb = _get_encoder().embed_utterance(wav)
        # Normalizza (cosine sim = dot product con vettori normalizzati)
        emb = emb / (np.linalg.norm(emb) + 1e-12)
        if temp:
            try:
                os.remove(wav_path)
            except Exception:
                pass
        return emb.astype(np.float32)
    except Exception as e:
        logger.warning(f"[voiceprint] failed to extract embedding from {audio_path}: {e}")
        return None


def extract_embedding_from_bytes(audio_bytes: bytes, src_format_hint: str = "webm") -> Optional[np.ndarray]:
    """Estrae embedding 256-dim (normalizzato) da audio in memoria.

    Usato in runtime nel WS voice_stream per chunk audio in arrivo.
    Restituisce None se l'audio è troppo corto o il decode fallisce.
    """
    from resemblyzer import preprocess_wav  # type: ignore

    if not audio_bytes or len(audio_bytes) < 1000:
        return None
    try:
        wav_path = _decode_audio_to_wav16k(audio_bytes, src_format_hint=src_format_hint)
        wav = preprocess_wav(wav_path)
        try:
            os.remove(wav_path)
        except Exception:
            pass
        if len(wav) < 8000:  # meno di 0.5s
            return None
        emb = _get_encoder().embed_utterance(wav)
        emb = emb / (np.linalg.norm(emb) + 1e-12)
        return emb.astype(np.float32)
    except Exception as e:
        logger.debug(f"[voiceprint] extract_embedding_from_bytes failed: {e}")
        return None


def compute_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
    """Cosine similarity fra due embedding normalizzati (range: -1..1)."""
    if emb1 is None or emb2 is None:
        return 0.0
    return float(np.dot(emb1, emb2))


def enroll_from_files(phrase_paths: Iterable[str]) -> Optional[list[float]]:
    """Enrollment: dato un iterable di path file audio (m4a delle 3 frasi),
    estrae gli embedding, li media, normalizza, e restituisce la reference
    come lista Python (serializzabile in MongoDB).

    Restituisce None se nessun file è utilizzabile.
    """
    embeddings: list[np.ndarray] = []
    for p in phrase_paths:
        emb = extract_embedding_from_path(p)
        if emb is not None:
            embeddings.append(emb)
    if not embeddings:
        return None
    ref = np.mean(embeddings, axis=0)
    ref = ref / (np.linalg.norm(ref) + 1e-12)
    logger.info(f"[voiceprint] enrolled reference from {len(embeddings)} phrases (dim={ref.shape[0]})")
    return ref.astype(np.float32).tolist()


def warmup() -> None:
    """Forza il caricamento dell'encoder + una dummy inference per il JIT.
    Chiamare all'avvio del server se si vuole ridurre la latenza del
    primo enrollment/gate (~10s → 100ms)."""
    try:
        enc = _get_encoder()
        dummy = np.zeros(16000, dtype=np.float32)  # 1s di silenzio
        _ = enc.embed_utterance(dummy)
        logger.info("[voiceprint] warmup done")
    except Exception as e:
        logger.warning(f"[voiceprint] warmup failed: {e}")


# Default threshold per gate. Empirico: 0.65 = strict, 0.55 = lax.
DEFAULT_THRESHOLD = 0.65
