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

import av  # type: ignore
import numpy as np
import soundfile as sf

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
    """Decodifica QUALSIASI audio (wav/m4a/mp3/aac/ogg/flac/webm/...) in
    float32 mono 16kHz. Strategia a 2 livelli:
      1. soundfile (veloce, WAV/FLAC/OGG nativi) — primo tentativo
      2. pyav (FFmpeg native binding self-contained, NESSUNA dipendenza
         da binari di sistema) — fallback per M4A iPhone Voice Memo, MP3, AAC, ecc.

    Ritorna (audio_float32_array, sample_rate_originale_for_debug).
    """
    # Tentativo 1: soundfile (WAV diretto, veloce)
    try:
        with io.BytesIO(audio_bytes) as buf:
            data, sr = sf.read(buf, dtype="float32", always_2d=False)
        if data.ndim == 2:  # stereo → mono
            data = data.mean(axis=1).astype(np.float32)
        original_sr = int(sr)
        logger.info(f"[silero-vad] decoded via soundfile: sr={sr}, len={len(data)} samples")
    except Exception as sf_err:
        # Tentativo 2: pyav (self-contained ffmpeg) per M4A/MP3/AAC iPhone
        logger.info(f"[silero-vad] soundfile failed ({sf_err}), trying pyav…")
        try:
            container = av.open(io.BytesIO(audio_bytes))
            audio_streams = container.streams.audio
            if not audio_streams:
                raise ValueError("no audio stream found")
            stream = audio_streams[0]
            original_sr = int(stream.codec_context.sample_rate or SR_TARGET)
            # Resampler PyAV interno: converte direttamente a float32 mono 16kHz
            # Questo evita un secondo resample step più giù (più veloce + qualità migliore).
            resampler = av.audio.resampler.AudioResampler(
                format="flt",
                layout="mono",
                rate=SR_TARGET,
            )
            chunks = []
            for frame in container.decode(stream):
                for out_frame in resampler.resample(frame):
                    arr = out_frame.to_ndarray()
                    # AudioResampler con layout="mono" ritorna shape (1, N) → squeezeamo
                    if arr.ndim == 2:
                        arr = arr[0]
                    chunks.append(arr.astype(np.float32, copy=False))
            container.close()
            if not chunks:
                raise ValueError("decoded zero audio frames")
            data = np.concatenate(chunks)
            logger.info(
                f"[silero-vad] decoded via pyav: original_sr={original_sr}, "
                f"resampled_to={SR_TARGET}, len={len(data)} samples"
            )
            # Già a SR_TARGET grazie al resampler PyAV → skip block resample
            return data, original_sr
        except Exception as av_err:
            raise ValueError(
                f"Cannot decode audio (tried soundfile + pyav). "
                f"soundfile_err={sf_err}; pyav_err={av_err}"
            )

    # Resample a 16kHz se serve (path solo per WAV/FLAC non a 16kHz)
    if original_sr != SR_TARGET:
        ratio = SR_TARGET / float(original_sr)
        new_len = int(len(data) * ratio)
        try:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(SR_TARGET, original_sr)
            data = resample_poly(data, SR_TARGET // g, original_sr // g).astype(np.float32)
        except Exception:
            # Fallback: interp lineare numpy (qualità ridotta ma sempre meglio di niente)
            x_old = np.linspace(0, 1, len(data))
            x_new = np.linspace(0, 1, new_len)
            data = np.interp(x_new, x_old, data).astype(np.float32)

    return data, original_sr


def probe_audio(
    audio_bytes: bytes,
    declared_filename: Optional[str] = None,
    threshold: float = 0.5,
    *,
    early_exit_prob: float = 0.9,
    early_exit_consecutive: int = 3,
    subsample_after_seconds: float = 8.0,
    subsample_factor: int = 2,
    time_budget_ms: float = 2500.0,
) -> dict:
    """Analizza un audio e ritorna probabilità VAD + segmenti.

    threshold: soglia per considerare un frame "speech" (default Silero=0.5).

    PERFORMANCE TUNING (Fabio escalation 2026-06-21, dopo log timeout 3.5s):
      - early_exit_prob/consecutive: ESCE non appena trova N frame consecutivi
        con prob >= soglia di confidenza alta. Caso tipico "Ciao Koda, mi
        senti?" → esce in 200-400ms invece di processare l'intero clip.
        Imposta early_exit_prob>=1 per disabilitare.
      - subsample_after_seconds + subsample_factor: per audio LUNGHI (>N sec),
        analizza solo un frame ogni K. Garantisce copertura completa del clip
        (anche caso "pausa 25s + parlato finale") in tempo dimezzato. Imposta
        subsample_factor=1 per disabilitare.
      - time_budget_ms: hard-cap sull'inferenza. Se l'audio è così lungo che
        sforerebbe il budget, ritorna comunque la decisione parziale (ratio
        calcolato sui frame processati). Garantisce che il client non vada
        MAI in fallback-timeout (timeout client = 3500ms).

    Returns:
      {
        "model": "silero_vad_v5",
        "duration_s": float,                # durata totale audio
        "analyzed_duration_s": float,       # quanto effettivamente analizzato
        "original_sr": int,
        "total_frames": int,                # frame effettivamente processati
        "frames_skipped_subsample": int,    # quanti frame skippati per subsample
        "speech_frames": int,
        "speech_ratio": float (0..1),
        "speech_prob_mean": float,
        "speech_prob_max": float,
        "segments": [...],
        "inference_ms": float,
        "decode_ms": float,
        "early_exit": bool,                 # true se uscita anticipata per voce trovata
        "budget_exceeded": bool,            # true se uscito per time budget
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
    total_audio_frames = n_full // CHUNK_SIZE  # quanti frame TEORICI avrebbe il clip

    # ─── SUBSAMPLE ATTIVO? ──────────────────────────────────────────────
    # Per audio > N secondi, processiamo 1 frame ogni K. Lo stato LSTM viene
    # comunque aggiornato solo coi frame processati: non è esattamente come
    # processare tutto, ma su clip lunghi (>8s) la probabilità VAD è
    # localmente coerente per centinaia di ms, quindi saltare ~32ms ogni
    # 64ms non degrada la rilevazione di voce sostenuta.
    effective_step = subsample_factor if duration_s > subsample_after_seconds and subsample_factor > 1 else 1
    frames_skipped = 0

    # ─── EARLY-EXIT TRACKER ─────────────────────────────────────────────
    consecutive_high = 0
    early_exit = False
    budget_exceeded = False
    time_budget_s = time_budget_ms / 1000.0

    for k, i in enumerate(range(0, n_full, CHUNK_SIZE * effective_step)):
        # Hard budget check ogni 10 frame (evita overhead time.time() ad ogni frame)
        if k > 0 and k % 10 == 0:
            if (time.time() - t_inf_start) >= time_budget_s:
                budget_exceeded = True
                break

        chunk = pcm[i:i + CHUNK_SIZE].reshape(1, -1)
        out, state = sess.run(
            None,
            {"input": chunk, "state": state, "sr": sr_input},
        )
        p = float(out[0][0])
        probs.append(p)

        # Early-exit: trovata voce confermata? esci subito.
        if early_exit_prob < 1.0:
            if p >= early_exit_prob:
                consecutive_high += 1
                if consecutive_high >= early_exit_consecutive:
                    early_exit = True
                    break
            else:
                consecutive_high = 0

    # Conteggio frame skippati dal subsample (solo informativo per log)
    if effective_step > 1:
        frames_skipped = total_audio_frames - len(probs)

    inference_ms = (time.time() - t_inf_start) * 1000
    analyzed_duration_s = (len(probs) * CHUNK_SIZE * effective_step) / float(SR_TARGET)

    probs_arr = np.array(probs, dtype=np.float32) if probs else np.zeros(0, dtype=np.float32)
    speech_mask = probs_arr >= threshold
    speech_frames = int(speech_mask.sum())
    total_frames = len(probs)

    # Tempo (in secondi) per frame processato. Con subsample, ogni frame
    # rappresenta CHUNK_SIZE * effective_step samples.
    frame_step_seconds = (CHUNK_SIZE * effective_step) / float(SR_TARGET)

    # PARAMETRI ROBUST SPEECH DETECTION (vedi commento sotto, dopo segments):
    MIN_ROBUST_DURATION_S = 0.20  # almeno 200ms di voce continua
    MIN_ROBUST_PEAK = 0.80
    MIN_ROBUST_RATIO_FLOOR = 0.20  # forza ratio almeno a questo se robust speech presente

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
                    "start_s": round(seg_start_idx * frame_step_seconds, 3),
                    "end_s": round(idx * frame_step_seconds, 3),
                    "peak_prob": round(float(seg_peak), 4),
                })
                in_seg = False
        if in_seg:
            segments.append({
                "start_s": round(seg_start_idx * frame_step_seconds, 3),
                "end_s": round(total_frames * frame_step_seconds, 3),
                "peak_prob": round(float(seg_peak), 4),
            })

    # ─── ROBUST SPEECH DETECTION (Fabio 2026-06-21) ─────────────────────
    # PROBLEMA RISCONTRATO NEI TEST: il ratio `speech_frames/total_frames`
    # falsifica i casi "silenzio lungo + voce alla fine" (es. l'utente
    # esita 25s, poi parla 5s → ratio 0.06, sotto soglia client 0.15, ma
    # Silero ha rilevato voce nettissima con prob>0.88).
    # FIX: se troviamo almeno un segmento "robusto" (>=200ms continui di
    # voce con peak>=0.8), forziamo il ratio a un floor di 0.20. Così la
    # logica client (threshold=0.15 su speech_ratio) continua a funzionare
    # senza modifiche frontend.
    has_robust_speech = any(
        (seg["end_s"] - seg["start_s"]) >= MIN_ROBUST_DURATION_S
        and seg["peak_prob"] >= MIN_ROBUST_PEAK
        for seg in segments
    )
    raw_speech_ratio = speech_frames / max(total_frames, 1)
    effective_speech_ratio = (
        max(raw_speech_ratio, MIN_ROBUST_RATIO_FLOOR)
        if has_robust_speech else raw_speech_ratio
    )

    return {
        "model": "silero_vad_v5",
        "duration_s": round(duration_s, 3),
        "analyzed_duration_s": round(analyzed_duration_s, 3),
        "original_sr": original_sr,
        "total_frames": total_frames,
        "frames_skipped_subsample": frames_skipped,
        "subsample_factor": effective_step,
        "speech_frames": speech_frames,
        "speech_ratio": round(effective_speech_ratio, 4),
        "raw_speech_ratio": round(raw_speech_ratio, 4),  # ratio originale per debug
        "has_robust_speech": has_robust_speech,
        "speech_prob_mean": round(float(probs_arr.mean()) if total_frames else 0.0, 4),
        "speech_prob_max": round(float(probs_arr.max()) if total_frames else 0.0, 4),
        "segments": segments,
        "threshold": threshold,
        "inference_ms": round(inference_ms, 1),
        "decode_ms": round(decode_ms, 1),
        "early_exit": early_exit,
        "budget_exceeded": budget_exceeded,
    }
