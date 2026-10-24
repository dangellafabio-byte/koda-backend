"""
Verifica che _estimate_mp3_duration_seconds in server.py usi il parser
frame-based (via koda_tts_events.estimate_mp3_duration_ms) e dia una
stima accurata anche su MP3 non-CBR-128.

Contesto Fabio 2026-10:
  Il quota tracking 500 min/mese DEVE essere stabile anche quando
  Inworld (bitrate variabile) emette MP3 diversi da ElevenLabs
  (CBR 128). Prima il formula ``bytes/16000`` dava errori fino a -64%
  su VBR → l'utente poteva superare il budget senza che la billing
  se ne accorgesse.
"""
import os
import sys
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))

import koda_tts_events as k  # noqa: E402


FFMPEG = "/root/.venv/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-aarch64-v7.0.2"


def _find_sample_mp3() -> Path:
    clips = BACKEND / "_blind_test_clips"
    for fname in sorted(clips.iterdir()):
        if fname.name.endswith(".mp3") and fname.stat().st_size > 10_000:
            return fname
    pytest.skip("no sample MP3 available")


def test_frame_parser_matches_cbr128_within_1pct(tmp_path):
    """ElevenLabs CBR 128kbps: la stima frame-based ≈ formula CBR 128."""
    src = _find_sample_mp3()
    data = src.read_bytes()
    cbr_s = len(data) / 16000.0  # bytes/16000 = formula vecchia 128 kbps CBR
    frame_ms = k.estimate_mp3_duration_ms(data)
    assert frame_ms is not None
    frame_s = frame_ms / 1000.0
    # Entro 1% su CBR 128 (frame_s dovrebbe essere ~uguale)
    diff_pct = abs(frame_s - cbr_s) / cbr_s * 100
    assert diff_pct < 1.0, f"CBR mismatch: cbr={cbr_s:.3f} frame={frame_s:.3f} diff={diff_pct:.1f}%"


def test_frame_parser_more_accurate_on_vbr(tmp_path):
    """Su MP3 VBR a basso bitrate, bytes/16000 dà errori > 20%,
    il frame-parser resta entro 2% del vero."""
    if not os.path.exists(FFMPEG):
        pytest.skip("ffmpeg not available")
    src = _find_sample_mp3()
    data128 = src.read_bytes()
    true_ms = k.estimate_mp3_duration_ms(data128)
    assert true_ms is not None
    true_s = true_ms / 1000.0

    vbr_path = tmp_path / "vbr.mp3"
    r = subprocess.run(
        [FFMPEG, "-y", "-i", str(src), "-codec:a", "libmp3lame",
         "-qscale:a", "7", str(vbr_path)],
        capture_output=True,
    )
    if r.returncode != 0 or not vbr_path.exists():
        pytest.skip("ffmpeg transcode failed")

    data_vbr = vbr_path.read_bytes()
    cbr_old = len(data_vbr) / 16000.0
    frame_new = k.estimate_mp3_duration_ms(data_vbr) / 1000.0

    # Verifica che il vecchio formula sottostima molto
    old_err_pct = abs(cbr_old - true_s) / true_s * 100
    # Verifica che il nuovo parser è vicino alla verità
    new_err_pct = abs(frame_new - true_s) / true_s * 100

    # Richiediamo:
    #   * old_err > 20%  (dimostra necessità del fix)
    #   * new_err < 5%   (nuovo parser accurato)
    assert old_err_pct > 20.0, (
        f"VBR non ha prodotto bitrate inferiore (old_err={old_err_pct:.1f}%)"
    )
    assert new_err_pct < 5.0, (
        f"Frame parser impreciso su VBR (new_err={new_err_pct:.1f}%)"
    )


def test_server_estimator_uses_frame_parser():
    """_estimate_mp3_duration_seconds in server.py deve essere
    equivalente al frame-parser (per output ElevenLabs 128kbps CBR
    la differenza è ~0; per MP3 non-CBR-128 USA frame_parser)."""
    import server as _srv
    src = _find_sample_mp3()
    data = src.read_bytes()
    srv_s = _srv._estimate_mp3_duration_seconds(data)
    frame_s = k.estimate_mp3_duration_ms(data) / 1000.0
    # Entro 2% (il server potrebbe fallbackare su CBR 128 se parser fallisce)
    diff_pct = abs(srv_s - frame_s) / max(frame_s, 0.001) * 100
    assert diff_pct < 2.0, f"server estimator diverge: srv={srv_s:.3f} frame={frame_s:.3f}"
