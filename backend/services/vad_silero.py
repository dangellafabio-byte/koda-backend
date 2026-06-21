"""
Silero VAD server-side — Opzione 2 (Fabio escalation 2026-06-20 v8).

PERCHÉ ESISTE QUESTO MODULO:
Dopo 4 build TestFlight fallite sul VAD on-device (onnxruntime-react-native
incompatibile con NewArch), validiamo l'algoritmo Silero qui sul backend:
  - Zero rischio nativo iOS (gira solo Python)
  - Testabile via curl PRIMA di qualsiasi nuova build
  - Stesso identico modello (silero_vad.onnx v5) che voleva girare
    sul dispositivo
  - Se "voce nel furgone = 0.9, motore = 0.05" → algoritmo confermato →
    in una sessione futura porteremo Silero on-device con TFLite

Path utilizzo:
  POST /api/vad/probe (multipart/form-data, file= un audio qualsiasi)
  → {speech_prob_mean, speech_prob_max, speech_frames, total_frames,
     duration_s, segments: [{start_s, end_s, peak_prob}]}

Le rese del modello sul backend sono identiche a quelle che otterremmo
on-device — non c'è "perdita" né "approssimazione" tra le due modalità.
"""
from __future__ import annotations

import io
import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from pydub import AudioSegment

logger = logging.getLogger("silero_vad")

_MODEL_PATH = Path(__file__).resolve().parent.parent / "static_assets" / "silero_vad.onnx"

# Silero v5 specifiche
SR_TARGET = 16_000
CHUNK_SIZE = 512  # samples per frame at 16kHz = 32ms per frame
STATE_SHAPE = (2, 1, 128)  # LSTM state

# Singleton ONNX session — lazy-loaded al primo uso
_session = None
_load_lock_attempted = False


def _get_session():
    """Carica la InferenceSession in modalità lazy + idempotente."""
    global _session, _load_lock_attempted
    if _session is not None:
        return _session
    if _load_lock_attempted:
        # Caricamento già tentato in passato e fallito: evitiamo retry hot-loop
        raise RuntimeError("Silero VAD model failed to load earlier; check logs")
    _load_lock_attempted = True
    if not _MODEL_PATH.exists():
        raise FileNotFoundError(f"silero_vad.onnx not found at {_MODEL_PATH}")
    # Importazione locale per non rallentare il boot del server se il modulo
    # non viene mai usato.
    import onnxruntime as ort
    t0 = time.time()
    _session = ort.InferenceSession(
        str(_MODEL_PATH),
        providers=["CPUExecutionProvider"],
    )
    logger.info(
        f"[silero-vad] session ready in {(time.time()-t0)*1000:.0f}ms — "
        f"inputs={[i.name for i in _session.get_inputs()]} "
        f"outputs={[o.name for o in _session.get_outputs()]}"
    )
    return _session


def _decode_audio_to_pcm16k_mono_f32(
    audio_bytes: bytes,
    declared_filename: Optional[str] = None,
) -> tuple[np.ndarray, int]:
    """Decodifica QUALSIASI audio (wav/m4a/mp3/aac/ogg/flac/...) in
    float32 mono 16kHz. Strategia a 2 livelli:
      1. soundfile (veloce, WAV/FLAC/OGG nativi)
      2. pydub + ffmpeg (tutto il resto: M4A iPhone Voice Memo, MP3, AAC...)

    Ritorna (audio_float32_array, sample_rate_originale_for_debug).
    """
    # Tentativo 1: soundfile (WAV diretto)
    try:
        with io.BytesIO(audio_bytes) as buf:
            data, sr = sf.read(buf, dtype="float32", always_2d=False)
        if data.ndim == 2:  # stereo → mono
            data = data.mean(axis=1).astype(np.float32)
        original_sr = int(sr)
        logger.info(f"[silero-vad] decoded via soundfile: sr={sr}, len={len(data)} samples")
    except Exception as sf_err:
        # Tentativo 2: pydub (ffmpeg per M4A/MP3/AAC iPhone)
        logger.info(f"[silero-vad] soundfile failed ({sf_err}), trying pydub+ffmpeg…")
        try:
            seg = AudioSegment.from_file(io.BytesIO(audio_bytes))
            # Pydub usa int16 per default; lo lasciamo lavorare nel suo formato
            # e poi normalizziamo.
            seg = seg.set_channels(1)  # mono
            original_sr = seg.frame_rate
            samples_i16 = np.array(seg.get_array_of_samples(), dtype=np.int16)
            data = (samples_i16.astype(np.float32) / 32768.0).copy()
            logger.info(f"[silero-vad] decoded via pydub+ffmpeg: sr={original_sr}, len={len(data)}")
        except Exception as pd_err:
            raise ValueError(
                f"Cannot decode audio (tried soundfile + pydub). "
                f"soundfile_err={sf_err}; pydub_err={pd_err}"
            )

    # Resample a 16kHz se serve (usando numpy linear interp, basta per VAD)
    if original_sr != SR_TARGET:
        ratio = SR_TARGET / float(original_sr)
        new_len = int(len(data) * ratio)
        # Usa scipy se disponibile (qualità migliore), altrimenti linear numpy
        try:
            from scipy.signal import resample_poly
            # GCD-based polyphase = qualità decente, no scipy.signal.resample (FFT) costoso
            from math import gcd
            g = gcd(SR_TARGET, original_sr)
            data = resample_poly(data, SR_TARGET // g, original_sr // g).astype(np.float32)
        except Exception:
            # Fallback: interp lineare numpy
            x_old = np.linspace(0, 1, len(data))
            x_new = np.linspace(0, 1, new_len)
            data = np.interp(x_new, x_old, data).astype(np.float32)

    return data, original_sr


def probe_audio(
    audio_bytes: bytes,
    declared_filename: Optional[str] = None,
    threshold: float = 0.5,
) -> dict:
    """Analizza un audio e ritorna probabilità VAD + segmenti.

    threshold: soglia per considerare un frame "speech" (default Silero=0.5).

    Returns:
      {
        "model": "silero_vad_v5",
        "duration_s": float,
        "original_sr": int,
        "total_frames": int,
        "speech_frames": int,
        "speech_ratio": float (0..1),
        "speech_prob_mean": float,
        "speech_prob_max": float,
        "segments": [{"start_s": float, "end_s": float, "peak_prob": float}, ...],
        "inference_ms": float,
        "decode_ms": float,
      }
    """
    t_decode_start = time.time()
    pcm, original_sr = _decode_audio_to_pcm16k_mono_f32(audio_bytes, declared_filename)
    decode_ms = (time.time() - t_decode_start) * 1000

    duration_s = len(pcm) / float(SR_TARGET)

    sess = _get_session()
    state = np.zeros(STATE_SHAPE, dtype=np.float32)
    probs = []

    t_inf_start = time.time()
    sr_input = np.array(SR_TARGET, dtype=np.int64)
    # Pad finale per avere frame multipli di CHUNK_SIZE
    n_full = len(pcm) - (len(pcm) % CHUNK_SIZE)
    for i in range(0, n_full, CHUNK_SIZE):
        chunk = pcm[i:i + CHUNK_SIZE].reshape(1, -1)
        out, state = sess.run(
            None,
            {"input": chunk, "state": state, "sr": sr_input},
        )
        probs.append(float(out[0][0]))
    inference_ms = (time.time() - t_inf_start) * 1000

    probs_arr = np.array(probs, dtype=np.float32) if probs else np.zeros(0, dtype=np.float32)
    speech_mask = probs_arr >= threshold
    speech_frames = int(speech_mask.sum())
    total_frames = len(probs)

    # Segmenta i frame "speech" contigui
    segments = []
    if total_frames > 0:
        in_seg = False
        seg_start_idx = 0
        seg_peak = 0.0
        for idx, p in enumerate(probs):
            if p >= threshold and not in_seg:
                in_seg = True
                seg_start_idx = idx
                seg_peak = p
            elif p >= threshold and in_seg:
                if p > seg_peak:
                    seg_peak = p
            elif p < threshold and in_seg:
                segments.append({
                    "start_s": round(seg_start_idx * CHUNK_SIZE / SR_TARGET, 3),
                    "end_s": round(idx * CHUNK_SIZE / SR_TARGET, 3),
                    "peak_prob": round(float(seg_peak), 4),
                })
                in_seg = False
        if in_seg:
            segments.append({
                "start_s": round(seg_start_idx * CHUNK_SIZE / SR_TARGET, 3),
                "end_s": round(total_frames * CHUNK_SIZE / SR_TARGET, 3),
                "peak_prob": round(float(seg_peak), 4),
            })

    return {
        "model": "silero_vad_v5",
        "duration_s": round(duration_s, 3),
        "original_sr": original_sr,
        "total_frames": total_frames,
        "speech_frames": speech_frames,
        "speech_ratio": round(speech_frames / max(total_frames, 1), 4),
        "speech_prob_mean": round(float(probs_arr.mean()) if total_frames else 0.0, 4),
        "speech_prob_max": round(float(probs_arr.max()) if total_frames else 0.0, 4),
        "segments": segments,
        "threshold": threshold,
        "inference_ms": round(inference_ms, 1),
        "decode_ms": round(decode_ms, 1),
    }
