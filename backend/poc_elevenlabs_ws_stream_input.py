"""POC — ElevenLabs WebSocket stream-input + Claude streaming parallel pipe.

Scopo:
   Verificare se l'uso dell'endpoint ElevenLabs WS `stream-input` in
   combinazione con lo streaming Claude porta la metrica
   `user_final → first_playable_audio` sotto i 2s (target 1.5s)
   mantenendo la qualità/naturalezza della voce Koda.

Come funziona:
   1. Simula user_final settando t=0 al momento della prima chiamata Claude.
   2. Apre WS ElevenLabs stream-input in parallelo (mentre Claude streamma).
   3. Man mano che Claude produce token, li invia al WS come frammenti di testo.
   4. Riceve chunk audio MP3 progressivamente dal WS.
   5. Misura:
      - TTFA_user (user_final → primo byte audio ricevuto)
      - TTFA_publish (primo momento in cui il server AVREBBE potuto publish al client)
      - LUFS di ogni chunk audio ricevuto → verifica drift intra/inter chunk
      - Wall clock totale
      - Salva audio completo su disco per giudizio qualitativo umano

Vincoli rispettati:
   - Isolato (nessuna modifica a server.py)
   - Nessuna modifica al client (POC solo server-side)
   - Nessuna modifica al comportamento della produzione
   - Test A/B con la STESSA identica catena di sistema prompt e user text
"""

import asyncio
import base64
import json
import os
import sys
import time
from typing import List, Dict, Any

import numpy as np
import websockets
from dotenv import load_dotenv

sys.path.insert(0, '/app/backend')
load_dotenv('/app/backend/.env')

# === Config ==================================================================
EMERGENT_LLM_KEY = os.environ['EMERGENT_LLM_KEY']
ELEVENLABS_API_KEY = os.environ['ELEVENLABS_API_KEY']
VOICE_ID = "POuqf18evoXOKIqV2Px7"  # Cielo — voce Koda produzione
MODEL_ID = "eleven_v3"             # stesso modello produzione
OUTPUT_FORMAT = "mp3_44100_128"    # stesso formato produzione (post-revert-B)
API_BASE = 'https://integrations.emergentagent.com/llm'

# Voice settings identiche a produzione
VOICE_SETTINGS = {
    "stability": 0.55,
    "similarity_boost": 0.75,
    "style": 0.20,
    "use_speaker_boost": True,
}

# === LUFS utility ===========================================================
def decode_mp3_to_pcm(mp3_bytes: bytes):
    import miniaudio
    d = miniaudio.decode(mp3_bytes, output_format=miniaudio.SampleFormat.SIGNED16,
                         nchannels=2, sample_rate=44100)
    return np.frombuffer(d.samples, dtype=np.int16).reshape(-1, 2), d.sample_rate

def compute_lufs(pcm: np.ndarray, sr: int) -> float:
    import pyloudnorm as pyln
    m = pyln.Meter(sr)
    return float(m.integrated_loudness(pcm.astype(np.float32) / 32768.0))


# === Build realistic Koda system prompt ====================================
def build_system_prompt() -> str:
    """Uses the REAL fast pipeline prompt builder from server.py.
    Realistic Fabio profile so we're testing under real conditions."""
    from server import _build_fast_system_prompt, Profile
    p = Profile(
        id="poc-fabio", name="Fabio", language="it", ai_name="Koda",
        ai_gender="f", user_gender="m", tts_voice_id=VOICE_ID,
        memory_summary=("Fabio è un imprenditore italiano che sta costruendo "
                        "Koda, un compagno vocale AI. Ama la naturalezza, "
                        "odia le voci fake."),
        core_traits="Analitico, esigente, empatico verso il prodotto.",
    )
    return _build_fast_system_prompt(p, [], memories=None, trial_state="active")


# === Test cases ==============================================================
# Simulano ciò che un user reale direbbe a Koda, con risposte attese di
# lunghezze diverse (breve/media/lunga) per verificare comportamento sotto
# vari carichi.
TEST_CASES = [
    ("BREVE",  "Ciao Koda, mi senti?"),
    ("MEDIA",  "Ho avuto una giornata pesante. Puoi dirmi qualcosa che mi tranquillizzi?"),
    ("LUNGA",  "Sto lavorando a un progetto complesso da mesi. Ho paura di aver perso la direzione. Cosa mi consigli di fare quando mi sento così?"),
]


# === Claude streaming =======================================================
async def stream_claude(sys_prompt: str, user_msg: str):
    """Yields (token_delta_text, is_first) per ogni delta ricevuto da Claude."""
    import litellm
    stream = await litellm.acompletion(
        model='openai/claude-haiku-4-5-20251001',
        messages=[
            {'role': 'system', 'content': [{
                'type': 'text', 'text': sys_prompt,
                'cache_control': {'type': 'ephemeral'},
            }]},
            {'role': 'user', 'content': user_msg},
        ],
        stream=True,
        stream_options={"include_usage": True},
        api_key=EMERGENT_LLM_KEY,
        api_base=API_BASE,
        max_tokens=200,
        timeout=25,
    )
    is_first = True
    async for chunk in stream:
        try:
            piece = chunk.choices[0].delta.content or ''
        except (AttributeError, IndexError):
            piece = ''
        if piece:
            yield piece, is_first
            is_first = False


# === ElevenLabs WS stream-input =============================================
async def run_pipeline(user_msg: str, sys_prompt: str, label: str) -> Dict[str, Any]:
    """Esegue una pipeline completa. Ritorna metriche + bytes audio + chunks."""

    ws_url = (
        f"wss://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/stream-input"
        f"?model_id={MODEL_ID}&output_format={OUTPUT_FORMAT}"
    )
    headers = [("xi-api-key", ELEVENLABS_API_KEY)]

    t_user_final = time.time()  # ← t=0 (user_final)

    metrics: Dict[str, Any] = {
        "label": label,
        "user_msg_chars": len(user_msg),
        "ttft_claude_ms": None,       # primo token Claude
        "ttfa_ms": None,              # primo byte audio dal WS ElevenLabs (=first_playable_audio!)
        "ttfa_after_first_word_ms": None,  # tempo tra "primo token Claude inviato" e "primo audio"
        "claude_wall_ms": None,
        "el_ws_open_ms": None,
        "el_wall_ms": None,
        "el_first_word_sent_ms": None,
        "total_wall_ms": None,
        "audio_chunks_received": 0,
        "audio_total_bytes": 0,
    }
    audio_chunks: List[bytes] = []
    audio_chunk_arrival_ts: List[float] = []
    reply_text_full: List[str] = []

    async with websockets.connect(ws_url, additional_headers=headers) as ws:
        metrics["el_ws_open_ms"] = int((time.time() - t_user_final) * 1000)

        # 1. Send initial config to WS
        await ws.send(json.dumps({
            "text": " ",  # bos placeholder as per docs
            "voice_settings": VOICE_SETTINGS,
            "generation_config": {
                # trigger di 50/120/171/... char per chunk audio
                "chunk_length_schedule": [50, 120, 160, 250],
            },
            "xi_api_key": ELEVENLABS_API_KEY,
        }))

        # 2. Concurrent tasks: Claude producer + WS text sender + WS audio consumer
        text_sent_buffer = []
        claude_done = asyncio.Event()
        text_send_lock = asyncio.Lock()

        async def claude_producer():
            """Pulla token da Claude, li accoda per invio al WS."""
            t_first_word_sent = None
            async for piece, is_first in stream_claude(sys_prompt, user_msg):
                if is_first:
                    metrics["ttft_claude_ms"] = int((time.time() - t_user_final) * 1000)
                reply_text_full.append(piece)
                # Invia SUBITO al WS (non aspettare buffer di parole intere).
                # ElevenLabs si occupa di aggregare in base a chunk_length_schedule.
                async with text_send_lock:
                    try:
                        await ws.send(json.dumps({"text": piece}))
                        if t_first_word_sent is None:
                            t_first_word_sent = time.time()
                            metrics["el_first_word_sent_ms"] = int((t_first_word_sent - t_user_final) * 1000)
                    except Exception:
                        return
            metrics["claude_wall_ms"] = int((time.time() - t_user_final) * 1000)
            # Segnala fine testo
            async with text_send_lock:
                try:
                    await ws.send(json.dumps({"text": ""}))
                except Exception:
                    pass
            claude_done.set()

        async def audio_consumer():
            """Riceve chunk audio dal WS. Ferma quando riceve isFinal o WS chiude."""
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30)
                except asyncio.TimeoutError:
                    break
                except websockets.exceptions.ConnectionClosed:
                    break

                try:
                    msg = json.loads(raw)
                except Exception:
                    continue

                audio_b64 = msg.get("audio")
                if audio_b64:
                    audio_bytes = base64.b64decode(audio_b64)
                    if metrics["ttfa_ms"] is None:
                        metrics["ttfa_ms"] = int((time.time() - t_user_final) * 1000)
                        if metrics.get("el_first_word_sent_ms"):
                            metrics["ttfa_after_first_word_ms"] = \
                                metrics["ttfa_ms"] - metrics["el_first_word_sent_ms"]
                    audio_chunks.append(audio_bytes)
                    audio_chunk_arrival_ts.append(time.time() - t_user_final)
                    metrics["audio_chunks_received"] += 1
                    metrics["audio_total_bytes"] += len(audio_bytes)

                if msg.get("isFinal"):
                    break

        producer_task = asyncio.create_task(claude_producer())
        consumer_task = asyncio.create_task(audio_consumer())
        await asyncio.gather(producer_task, consumer_task)

    metrics["el_wall_ms"] = int((time.time() - t_user_final) * 1000)
    metrics["total_wall_ms"] = metrics["el_wall_ms"]
    metrics["reply_text"] = "".join(reply_text_full)

    # Save audio to disk for human quality check
    if audio_chunks:
        full_mp3 = b"".join(audio_chunks)
        safe_label = label.replace(" ", "_").lower()
        out_path = f"/tmp/poc_ws_{safe_label}.mp3"
        with open(out_path, "wb") as f:
            f.write(full_mp3)
        metrics["audio_path"] = out_path

        # LUFS analysis: per-chunk + full
        try:
            pcm_full, sr = decode_mp3_to_pcm(full_mp3)
            metrics["full_audio_lufs"] = compute_lufs(pcm_full, sr)
            metrics["full_audio_dur_s"] = pcm_full.shape[0] / sr

            # Compute LUFS di ogni chunk audio ricevuto (per drift analysis)
            chunk_lufs: List[float] = []
            for i, cb in enumerate(audio_chunks):
                if len(cb) < 512:  # skip micro chunks
                    continue
                try:
                    pcm_c, sr_c = decode_mp3_to_pcm(cb)
                    if pcm_c.shape[0] >= sr_c * 0.4:  # min 400ms per LUFS
                        chunk_lufs.append(compute_lufs(pcm_c, sr_c))
                except Exception:
                    pass
            metrics["chunk_lufs_list"] = chunk_lufs
            if len(chunk_lufs) >= 2:
                metrics["lufs_intra_variance_LU"] = float(np.std(chunk_lufs))
                metrics["lufs_intra_max_delta_LU"] = float(max(chunk_lufs) - min(chunk_lufs))
        except Exception as e:
            metrics["lufs_error"] = str(e)

    metrics["audio_chunk_arrival_ts"] = audio_chunk_arrival_ts
    return metrics


# === Main runner ============================================================
async def main():
    sys_prompt = build_system_prompt()
    print(f"System prompt: {len(sys_prompt)} chars\n")

    all_results = []
    for label, user_msg in TEST_CASES:
        print(f"{'='*80}\n[{label}] user_msg: {user_msg!r}\n{'='*80}")
        try:
            m = await run_pipeline(user_msg, sys_prompt, label)
        except Exception as e:
            print(f"  ERROR: {e}")
            continue
        all_results.append(m)
        # Report per singolo test
        print(f"  ttft_claude_ms:         {m.get('ttft_claude_ms')}")
        print(f"  el_first_word_sent_ms:  {m.get('el_first_word_sent_ms')}")
        print(f"  TTFA (first audio):     {m.get('ttfa_ms')}  ← user_final → first_playable_audio")
        print(f"  claude_wall_ms:         {m.get('claude_wall_ms')}")
        print(f"  el_wall_ms:             {m.get('el_wall_ms')}")
        print(f"  audio_chunks:           {m.get('audio_chunks_received')}")
        print(f"  audio_bytes:            {m.get('audio_total_bytes')}")
        print(f"  audio_dur:              {m.get('full_audio_dur_s', 0):.2f}s" if m.get('full_audio_dur_s') else "  audio_dur: N/A")
        print(f"  audio_saved:            {m.get('audio_path')}")
        cl = m.get("chunk_lufs_list") or []
        if cl:
            print(f"  chunk LUFS list:        {[f'{x:+.2f}' for x in cl]}")
            if len(cl) >= 2:
                print(f"  intra-chunk LUFS delta: max={m.get('lufs_intra_max_delta_LU'):.2f} LU  stddev={m.get('lufs_intra_variance_LU'):.2f}")
            print(f"  full audio LUFS:        {m.get('full_audio_lufs'):+.2f}")
        print(f"  reply: {(m.get('reply_text') or '')[:150]!r}")
        print()

    print(f"\n{'='*80}\nSUMMARY TABLE\n{'='*80}")
    print(f"{'label':<8}{'ttft_C':<8}{'TTFA':<8}{'audio_dur':<11}{'chunks':<8}{'lufs_full':<11}{'intra_max_ΔLU':<15}")
    for m in all_results:
        ttft = m.get('ttft_claude_ms') or '-'
        ttfa = m.get('ttfa_ms') or '-'
        dur = f"{m.get('full_audio_dur_s', 0):.2f}s"
        chs = m.get('audio_chunks_received') or 0
        lf = f"{m.get('full_audio_lufs', 0):+.2f}" if m.get('full_audio_lufs') else 'N/A'
        d = m.get('lufs_intra_max_delta_LU')
        d_s = f"{d:+.2f}" if d is not None else 'N/A'
        print(f"{m['label']:<8}{str(ttft):<8}{str(ttfa):<8}{dur:<11}{str(chs):<8}{lf:<11}{d_s:<15}")

    print(f"\n{'='*80}")
    print(f"CRITERI DECISIONALI:")
    print(f"  ✅ SUCCESS: TTFA < 2000ms E intra-chunk LUFS delta < 1.0 LU  E audio naturale (ascolto)")
    print(f"  ❌ FAIL:    TTFA >= 2000ms  OR  drift LUFS >= 1.5 LU  OR  audio non naturale")
    print(f"\nAscolta gli MP3 salvati in /tmp/poc_ws_*.mp3 per giudizio qualitativo.")

    # Salva risultati JSON
    with open("/tmp/poc_ws_results.json", "w") as f:
        # rimuovi campi non-serializzabili
        clean = []
        for m in all_results:
            c = {k: v for k, v in m.items() if not isinstance(v, (bytes, list)) or k in ('chunk_lufs_list', 'audio_chunk_arrival_ts')}
            clean.append(c)
        json.dump(clean, f, indent=2, default=str)
    print(f"\nResults JSON saved to /tmp/poc_ws_results.json")


if __name__ == "__main__":
    asyncio.run(main())
