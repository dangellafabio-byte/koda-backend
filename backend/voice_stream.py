"""
KODA — Voice Streaming Pipeline (Fase 1, giugno 2026)
======================================================

Architettura streaming end-to-end basata su Deepgram Live (WebSocket).

Sostituisce il flusso file-based (record → upload → STT) con uno streaming
continuo che permette:
  • Endpointing intelligente lato Deepgram (basato sul MODELLO linguistico,
    non sul volume del microfono) — risolve il bug VAD volumetrico in
    ambienti rumorosi (furgone) E su device con metering rotto (Xiaomi
    MIUI dove metering=-100 sempre).
  • Latenza end-to-end <2s: niente più upload-then-wait di 14s su rete
    mobile lenta, l'audio è già a destinazione quando l'utente smette
    di parlare.
  • Cross-platform identico: tutto JS lato client + Python lato server,
    nessun branch iOS/Android.

Wire protocol — Client → Server:
  Frame 0 (text JSON):
    {
      "type": "start",
      "ephemeral": false,
      "profile_lang": "it",
      "container": "aac"  // formato dei chunk binari che seguiranno
    }
  Frame 1..N (binary):
    Chunk audio AAC/m4a da ~250ms ciascuno (dal recording continuo lato
    client). Vengono convertiti server-side in linear16 PCM via ffmpeg
    e inoltrati a Deepgram Live.
  Frame finale (text JSON, opzionale):
    {"type": "end"}   // forza la chiusura — comunque Deepgram chiude
                      // naturalmente via UtteranceEnd dopo silenzio

Wire protocol — Server → Client:
  {"type":"ready","session_id":"..."}        // proxy DG attivo, manda audio
  {"type":"stt_interim","text":"..."}        // partial transcript live (UI)
  {"type":"stt_final","text":"...",
       "confidence":0.85}                    // utterance complete, pipeline parte
  {"type":"sentence","i":int,"text":str,...} // segue binary frame MP3 TTS
  {"type":"meta","reply":...,"tone":...,...} // metadata pipeline LLM
  {"type":"done"}                             // pipeline finita, ok chiudere
  {"type":"error","message":"..."}            // errore (server o Deepgram)

Endpointing Deepgram (parametri scelti dal playbook 2026):
  • model=nova-3              — modello migliore per italiano + rumore
  • language=it
  • encoding=linear16, sample_rate=16000  — formato PCM dopo conversione
  • endpointing=400           — 400ms silenzio = fine utterance (speech_final)
  • utterance_end_ms=1500     — fallback: 1.5s gap tra parole = UtteranceEnd
  • interim_results=true      — partial transcripts per UI feedback
  • vad_events=true           — eventi SpeechStarted per UI
  • smart_format=true         — punteggiatura + normalizzazione automatica
  • filler_words=false        — rimuove "ehm/uhm" per LLM più pulito

Constraint Emergent rispettati:
  • ffmpeg per conversione AAC→PCM (subprocess, no ML pesante)
  • Solo network/IO Python (websockets lib, no torch/onnxruntime)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional, Callable, Awaitable, Any, Dict

import websockets
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

# ============================================================
# CONFIGURATION
# ============================================================
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen"

# === FIX 2026-06-25 v7 (post-Build #5: ffmpeg not in container PATH) ===
# Il container Emergent NON ha ffmpeg installato via apt. Usiamo il binario
# static incluso nel package imageio-ffmpeg (già installato come dipendenza
# transitive). Senza questo, convert_aac_to_pcm16 fallisce silenziosamente
# e Deepgram non riceve mai audio → nessun stt_final → Koda non risponde.
# Questo era il vero motivo per cui Build #5 catturava i chunk ma non
# riceveva trascrizioni.
try:
    import imageio_ffmpeg
    FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()
    logger.info(f"[voice_stream] ffmpeg binary: {FFMPEG_BIN}")
except Exception as _ffmpeg_err:
    FFMPEG_BIN = "ffmpeg"  # fallback: spera che sia nel PATH
    logger.warning(
        f"[voice_stream] imageio_ffmpeg not available, falling back to PATH: {_ffmpeg_err}"
    )

# Parametri di query string Deepgram Live — vedi docstring per spiegazione.
# IMPORTANTE: questi sono valori INIZIALI da tunare nel furgone.
DG_PARAMS = {
    "model": "nova-3",
    "language": "it",
    "encoding": "linear16",
    "sample_rate": "16000",
    "channels": "1",
    "endpointing": "250",
    "utterance_end_ms": "900",
    "interim_results": "true",
    "vad_events": "true",
    "smart_format": "true",
    "filler_words": "false",
    "punctuate": "true",
    # === FIX 2026-06-25 v10 (post-Build #9 home test) ===
    # In casa silenziosa Deepgram trascriveva "Ciao Cosa" invece di "Ciao Koda"
    # (e talvolta "Coda"/"Goda"). Nova-3 supporta keyterm prompting (plain
    # string, NO intensifier suffix). Boostiamo il nome "Koda" così che la
    # rete neurale lo preferisca alle parole foneticamente vicine. Aggiungere
    # qui altri nomi-chiave del dominio se appariranno problemi simili
    # (es. "Sfogo", "Confessionale" se vengono sbagliati).
    "keyterm": "Koda",
}

# KeepAlive per evitare chiusura WS Deepgram dopo 10s di silenzio.
DG_KEEPALIVE_INTERVAL_S = 5.0

# Timeout dopo il quale, se il client non manda audio, chiudiamo.
CLIENT_IDLE_TIMEOUT_S = 20.0

# Hard cap totale sessione (safety net contro WS appesi).
# === FIX 2026-06-26 v18: cap differenziato chat (3min) vs sfogo (5min) ===
# Il client ora supporta cap differenziati:
#   - chat normale: 180s di parlato + 60s pipeline = ~240s
#   - Stanza dello Sfogo: 300s di parlato + 60s pipeline = ~360s
# Mettiamo 360s qui per coprire entrambi i casi senza branching server-side
# (il server non sa a priori se la sessione è ephemeral fino a che riceve
# il frame "start" — alzare il cap server è più sicuro di un check
# condizionale, e non causa danni: il cap scatta solo se il client non
# manda mai "end", caso che non si verifica nel flusso normale).
SESSION_HARD_CAP_S = 360.0


# ============================================================
# AUDIO CONVERSION (AAC → linear16 PCM)
# ============================================================
async def convert_aac_to_pcm16(chunk_bytes: bytes) -> bytes:
    """Converte un chunk audio AAC/m4a a linear16 PCM 16kHz mono via ffmpeg.

    Approccio: subprocess one-shot per chunk. Overhead misurato su container
    Debian (ffmpeg 5.1): ~30-50ms per chunk da 250ms. Accettabile per Fase 1.
    Se diventa bottleneck, in Fase 2 si può tenere un processo ffmpeg
    persistente con pipe in/out (più complesso ma sub-10ms).
    """
    if not chunk_bytes:
        return b""
    try:
        process = await asyncio.create_subprocess_exec(
            FFMPEG_BIN,
            "-hide_banner",
            "-loglevel", "error",
            "-i", "pipe:0",
            "-f", "s16le",          # PCM signed 16-bit little-endian (linear16)
            "-acodec", "pcm_s16le",
            "-ac", "1",             # mono
            "-ar", "16000",         # 16 kHz
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        pcm, err = await asyncio.wait_for(
            process.communicate(input=chunk_bytes),
            timeout=2.0,
        )
        if process.returncode != 0:
            logger.warning(
                f"[voice_stream] ffmpeg rc={process.returncode} "
                f"err={(err or b'')[:200]!r}"
            )
            return b""
        return pcm or b""
    except asyncio.TimeoutError:
        logger.warning("[voice_stream] ffmpeg conversion timed out")
        return b""
    except Exception as e:
        logger.warning(f"[voice_stream] ffmpeg conversion failed: {e}")
        return b""


# ============================================================
# DEEPGRAM LIVE SESSION
# ============================================================
class DeepgramLiveSession:
    """Wrap della connessione WebSocket verso Deepgram Live API.

    Espone metodi async per:
      • send_pcm(bytes)             → invia chunk PCM
      • recv_event() → dict|None    → riceve prossimo evento JSON
      • close_stream()              → invia CloseStream + chiude
    Si occupa internamente del KeepAlive periodico.
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        self._closed = False
        self._connect_started_at: Optional[float] = None

    @property
    def short_id(self) -> str:
        return self.session_id[:8]

    async def connect(self) -> None:
        if not DEEPGRAM_API_KEY:
            raise RuntimeError("DEEPGRAM_API_KEY not configured")
        qs = "&".join(f"{k}={v}" for k, v in DG_PARAMS.items())
        url = f"{DEEPGRAM_LIVE_URL}?{qs}"
        headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}
        self._connect_started_at = time.time()
        # websockets 14.x: usa additional_headers
        self.ws = await asyncio.wait_for(
            websockets.connect(
                url,
                additional_headers=headers,
                max_size=None,
                open_timeout=5.0,
                ping_interval=None,  # gestiamo noi il KeepAlive applicativo
            ),
            timeout=6.0,
        )
        dt_ms = int((time.time() - (self._connect_started_at or 0)) * 1000)
        logger.info(
            f"[KODA_STREAM_DG sess={self.short_id}] connected in {dt_ms}ms — "
            f"model={DG_PARAMS['model']} lang={DG_PARAMS['language']} "
            f"endpointing={DG_PARAMS['endpointing']}ms "
            f"utterance_end_ms={DG_PARAMS['utterance_end_ms']}ms"
        )
        # Avvia KeepAlive periodico in background.
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def _keepalive_loop(self) -> None:
        try:
            while not self._closed and self.ws is not None:
                await asyncio.sleep(DG_KEEPALIVE_INTERVAL_S)
                if self._closed or self.ws is None:
                    break
                try:
                    await self.ws.send(json.dumps({"type": "KeepAlive"}))
                except Exception as e:
                    logger.info(
                        f"[KODA_STREAM_DG sess={self.short_id}] "
                        f"keepalive send failed: {e}"
                    )
                    break
        except asyncio.CancelledError:
            pass

    async def send_pcm(self, pcm: bytes) -> None:
        if self._closed or self.ws is None or not pcm:
            return
        try:
            await self.ws.send(pcm)
        except Exception as e:
            logger.info(
                f"[KODA_STREAM_DG sess={self.short_id}] send_pcm failed: {e}"
            )
            self._closed = True

    async def recv_event(self) -> Optional[Dict[str, Any]]:
        """Riceve un evento JSON. Ritorna None se la WS è chiusa."""
        if self._closed or self.ws is None:
            return None
        try:
            msg = await self.ws.recv()
            if isinstance(msg, bytes):
                # Deepgram non manda binary in modalità STT
                return None
            return json.loads(msg)
        except (websockets.ConnectionClosed, json.JSONDecodeError) as e:
            logger.info(
                f"[KODA_STREAM_DG sess={self.short_id}] recv ended: {e}"
            )
            self._closed = True
            return None
        except Exception as e:
            logger.warning(
                f"[KODA_STREAM_DG sess={self.short_id}] recv error: {e}"
            )
            self._closed = True
            return None

    async def finalize(self) -> None:
        """Forza Deepgram a finalizzare i transcript correnti senza chiudere."""
        if self._closed or self.ws is None:
            return
        try:
            await self.ws.send(json.dumps({"type": "Finalize"}))
        except Exception:
            pass

    async def close_stream(self) -> None:
        """Invia CloseStream a Deepgram e chiude la WS."""
        self._closed = True
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:
                pass
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None


# ============================================================
# CLIENT WS ↔ DEEPGRAM PROXY HANDLER
# ============================================================
async def voice_stream_handler(
    websocket: WebSocket,
    run_pipeline_for_text: Callable[..., Awaitable[None]],
) -> None:
    """Handler principale del WS /api/voice/stream.

    Args:
        websocket: il WS in arrivo dal client mobile
        run_pipeline_for_text: callable async che, dato il testo finale,
            esegue la pipeline LLM+TTS esistente e pubblica eventi via
            `emit` callback. Firma:
              await run_pipeline_for_text(
                  text=str,
                  ephemeral=bool,
                  audio_duration_ms=int,
                  stt_confidence=float,
                  emit=Callable[[dict, Optional[bytes]], Awaitable[None]],
                  session_id=str,
              )
    """
    await websocket.accept()

    session_id = uuid.uuid4().hex
    short_id = session_id[:8]
    started_at = time.time()
    dg: Optional[DeepgramLiveSession] = None
    client_alive = True

    # Stato della utterance corrente
    utterance_text_parts: list[str] = []
    utterance_confidence: Optional[float] = None
    speech_started_at: Optional[float] = None
    audio_bytes_received = 0
    chunks_received = 0
    last_chunk_at = time.time()

    # Configurazione dalla prima frame
    profile_lang = "it"
    ephemeral = False
    # === Geolocation one-shot dal client (Fabio 2026-06-29) ===
    # La città/regione/paese arrivano nel frame "start" dal GPS del telefono.
    # NON tocchiamo DB: passiamo i 3 valori a `run_pipeline_for_text` che li
    # inietta direttamente nel system prompt di Claude. Approccio
    # "usa quello che hai", zero stato server-side.
    location_city: Optional[str] = None
    location_region: Optional[str] = None
    location_country: Optional[str] = None

    async def emit_to_client(event: dict, audio_bytes: Optional[bytes] = None) -> None:
        """Emit verso il client (riusa il pattern del converse-ws esistente)."""
        nonlocal client_alive
        if not client_alive:
            return
        try:
            if event.get("type") == "sentence" and audio_bytes:
                header = {
                    "type": "sentence",
                    "i": event.get("i"),
                    "text": event.get("text"),
                    "waveform": event.get("waveform"),
                    "window_ms": event.get("window_ms"),
                    "audio_bytes": len(audio_bytes),
                    "mime": "audio/mpeg",
                }
                await websocket.send_json(header)
                await websocket.send_bytes(audio_bytes)
            else:
                await websocket.send_json(event)
        except (WebSocketDisconnect, RuntimeError) as e:
            client_alive = False
            logger.info(f"[KODA_STREAM sess={short_id}] client disconnected during emit: {e}")

    try:
        # ---------------- 1) Frame iniziale ----------------
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        except asyncio.TimeoutError:
            await emit_to_client({"type": "error", "message": "no start frame within 5s"})
            return
        try:
            start_req = json.loads(raw)
        except json.JSONDecodeError:
            await emit_to_client({"type": "error", "message": "invalid start JSON"})
            return
        if start_req.get("type") != "start":
            await emit_to_client({"type": "error", "message": "expected type=start as first frame"})
            return
        profile_lang = (start_req.get("profile_lang") or "it").lower()
        ephemeral = bool(start_req.get("ephemeral", False))
        container = (start_req.get("container") or "aac").lower()
        # Estraiamo la posizione GPS dal client (3 campi opzionali).
        # Sanity cap: max 80 char per evitare iniezioni nel prompt.
        def _clip(v: Any) -> Optional[str]:
            if not isinstance(v, str):
                return None
            s = v.strip()
            if not s:
                return None
            return s[:80]
        location_city = _clip(start_req.get("location_city"))
        location_region = _clip(start_req.get("location_region"))
        location_country = _clip(start_req.get("location_country"))
        logger.info(
            f"[KODA_STREAM sess={short_id}] start lang={profile_lang} "
            f"ephemeral={ephemeral} container={container} "
            f"city={location_city!r} region={location_region!r} country={location_country!r}"
        )

        # ---------------- 2) Connetti a Deepgram ----------------
        if not DEEPGRAM_API_KEY:
            await emit_to_client({"type": "error", "message": "STT not configured"})
            return
        dg = DeepgramLiveSession(session_id=session_id)
        try:
            await dg.connect()
        except Exception as e:
            logger.error(f"[KODA_STREAM sess={short_id}] DG connect failed: {e}")
            await emit_to_client({"type": "error", "message": f"STT unavailable: {e}"})
            return

        await emit_to_client({"type": "ready", "session_id": session_id})

        # ---------------- 3) Task: leggi eventi da Deepgram ----------------
        # (gira in parallelo al loop di lettura audio dal client)
        pipeline_in_flight = False

        async def dg_event_loop() -> None:
            nonlocal pipeline_in_flight, speech_started_at, utterance_confidence
            while client_alive and dg is not None and not dg._closed:
                evt = await dg.recv_event()
                if evt is None:
                    break

                evt_type = evt.get("type")

                if evt_type == "SpeechStarted":
                    if speech_started_at is None:
                        speech_started_at = time.time()
                    logger.info(f"[KODA_STREAM_DG sess={short_id}] SpeechStarted")

                elif evt_type == "Results":
                    # Transcript (interim o final)
                    ch = (evt.get("channel") or {})
                    alts = ch.get("alternatives") or []
                    if not alts:
                        continue
                    alt = alts[0] or {}
                    text = (alt.get("transcript") or "").strip()
                    is_final = bool(evt.get("is_final", False))
                    speech_final = bool(evt.get("speech_final", False))
                    conf = alt.get("confidence")
                    # === FIX 2026-06-29 — conf=0 fallback ===
                    # Su utterance brevi (es. "Koda mi senti?") o un po'
                    # rumorose, Deepgram Nova-3 a volte emette
                    # confidence=0.0 al livello top dell'alternative anche
                    # se le word singole hanno confidence valida (es. 0.97).
                    # Fallback: se conf top-level è 0 ma il campo `words`
                    # contiene confidence per parola, usiamo la media.
                    if conf is not None:
                        try:
                            conf_f = float(conf)
                            if conf_f <= 0.0:
                                words = alt.get("words") or []
                                word_confs = [
                                    float(w.get("confidence", 0))
                                    for w in words
                                    if isinstance(w, dict) and w.get("confidence") is not None
                                ]
                                if word_confs:
                                    mean_conf = sum(word_confs) / len(word_confs)
                                    logger.info(
                                        f"[KODA_STREAM_DG sess={short_id}] "
                                        f"conf=0 fallback: mean(words.conf)={mean_conf:.3f} "
                                        f"({len(word_confs)} words)"
                                    )
                                    conf_f = mean_conf
                            utterance_confidence = conf_f
                        except (TypeError, ValueError):
                            pass

                    if not text:
                        continue

                    if is_final:
                        utterance_text_parts.append(text)
                        if not speech_final:
                            # transcript finale parziale (es. fine segmento)
                            await emit_to_client({
                                "type": "stt_interim",
                                "text": " ".join(utterance_text_parts),
                                "is_final": True,
                            })
                    else:
                        # interim transcript
                        live_text = " ".join(utterance_text_parts + [text])
                        await emit_to_client({
                            "type": "stt_interim",
                            "text": live_text,
                            "is_final": False,
                        })

                    if speech_final and not pipeline_in_flight:
                        final_text = " ".join(utterance_text_parts).strip()
                        utterance_text_parts.clear()
                        if final_text:
                            await _trigger_pipeline(final_text)

                elif evt_type == "UtteranceEnd":
                    # Fallback: arriva se l'audio è continuato a entrare ma
                    # Deepgram non ha mai marcato speech_final.
                    if not pipeline_in_flight and utterance_text_parts:
                        final_text = " ".join(utterance_text_parts).strip()
                        utterance_text_parts.clear()
                        if final_text:
                            logger.info(
                                f"[KODA_STREAM sess={short_id}] "
                                f"UtteranceEnd → trigger pipeline (text={final_text!r})"
                            )
                            await _trigger_pipeline(final_text)

                elif evt_type == "Metadata":
                    # Metadata di sessione (ignora per ora)
                    pass

                elif evt_type == "Error":
                    msg = evt.get("description") or evt.get("message") or str(evt)
                    logger.error(f"[KODA_STREAM_DG sess={short_id}] error: {msg}")
                    await emit_to_client({"type": "error", "message": f"STT error: {msg}"})
                    break

        async def _trigger_pipeline(final_text: str) -> None:
            """Esegue la pipeline LLM+TTS esistente con il testo trascritto."""
            nonlocal pipeline_in_flight, utterance_confidence
            pipeline_in_flight = True
            audio_duration_ms = None
            if speech_started_at is not None:
                audio_duration_ms = int((time.time() - speech_started_at) * 1000)
            # === FIX 2026-06-29 — snapshot conf prima del reset ===
            # Catturiamo la conf di QUESTA utterance, poi resettiamo lo
            # stato per la prossima. Senza reset, su una WS lunga la
            # seconda utterance ereditava la confidence della prima
            # se Deepgram non emetteva una nuova confidence non-zero.
            conf_snapshot = utterance_confidence
            utterance_confidence = None
            await emit_to_client({
                "type": "stt_final",
                "text": final_text,
                "confidence": conf_snapshot,
                "audio_duration_ms": audio_duration_ms,
            })
            try:
                await run_pipeline_for_text(
                    text=final_text,
                    ephemeral=ephemeral,
                    audio_duration_ms=audio_duration_ms,
                    stt_confidence=conf_snapshot,
                    emit=emit_to_client,
                    session_id=session_id,
                    location_city=location_city,
                    location_region=location_region,
                    location_country=location_country,
                )
                if client_alive:
                    await emit_to_client({"type": "done"})
            except Exception as e:
                logger.error(f"[KODA_STREAM sess={short_id}] pipeline crashed: {e}")
                if client_alive:
                    await emit_to_client({"type": "error", "message": str(e)[:200]})
            finally:
                pipeline_in_flight = False

        dg_task = asyncio.create_task(dg_event_loop())

        # ---------------- 4) Loop principale: leggi audio dal client ----------------
        try:
            while client_alive:
                # Hard cap
                if time.time() - started_at > SESSION_HARD_CAP_S:
                    logger.warning(
                        f"[KODA_STREAM sess={short_id}] session hard-cap "
                        f"{SESSION_HARD_CAP_S}s raggiunto"
                    )
                    break
                # Client idle timeout
                if time.time() - last_chunk_at > CLIENT_IDLE_TIMEOUT_S and chunks_received > 0:
                    logger.info(
                        f"[KODA_STREAM sess={short_id}] client idle "
                        f"{CLIENT_IDLE_TIMEOUT_S}s, closing"
                    )
                    break

                # Riceve qualsiasi frame (binary o text) con timeout corto
                try:
                    msg = await asyncio.wait_for(websocket.receive(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                except WebSocketDisconnect:
                    client_alive = False
                    break

                # FastAPI ASGI: receive() ritorna dict con "type", "bytes" o "text"
                if msg.get("type") == "websocket.disconnect":
                    client_alive = False
                    break

                if "bytes" in msg and msg["bytes"] is not None:
                    chunk = msg["bytes"]
                    chunks_received += 1
                    audio_bytes_received += len(chunk)
                    last_chunk_at = time.time()

                    # Conversione AAC → PCM
                    t_conv = time.time()
                    pcm = await convert_aac_to_pcm16(chunk)
                    conv_ms = int((time.time() - t_conv) * 1000)

                    if not pcm:
                        # Conversione fallita: logghiamo ma non interrompiamo
                        logger.info(
                            f"[KODA_STREAM_CHUNK sess={short_id}] "
                            f"idx={chunks_received} aac={len(chunk)}B "
                            f"pcm=0B conv_ms={conv_ms} STATUS=convert_failed"
                        )
                        continue

                    # Invia a Deepgram
                    await dg.send_pcm(pcm)

                    # Diagnostica granulare (richiesta da Fabio per Xiaomi)
                    if chunks_received % 4 == 0 or chunks_received <= 4:
                        logger.info(
                            f"[KODA_STREAM_CHUNK sess={short_id}] "
                            f"idx={chunks_received} aac={len(chunk)}B "
                            f"pcm={len(pcm)}B conv_ms={conv_ms} "
                            f"total_bytes={audio_bytes_received}"
                        )

                elif "text" in msg and msg["text"] is not None:
                    try:
                        ctrl = json.loads(msg["text"])
                    except Exception:
                        continue
                    if ctrl.get("type") == "end":
                        logger.info(
                            f"[KODA_STREAM sess={short_id}] client sent end frame"
                        )
                        # Forza Deepgram a finalizzare
                        await dg.finalize()
                        # Aspetta un po' per ricevere il transcript finale
                        await asyncio.sleep(2.0)
                        break
        except WebSocketDisconnect:
            client_alive = False

        # ---------------- 5) Cleanup ----------------
        logger.info(
            f"[KODA_STREAM sess={short_id}] session ending — "
            f"chunks={chunks_received} bytes={audio_bytes_received} "
            f"dur={int((time.time() - started_at) * 1000)}ms"
        )
        if dg is not None:
            await dg.close_stream()
        # Aspetta che il task DG termini
        try:
            await asyncio.wait_for(dg_task, timeout=2.0)
        except (asyncio.TimeoutError, Exception):
            pass

    except WebSocketDisconnect:
        logger.info(f"[KODA_STREAM sess={short_id}] client disconnected (early)")
    except Exception as e:
        logger.error(f"[KODA_STREAM sess={short_id}] handler crash: {e}", exc_info=True)
        try:
            await emit_to_client({"type": "error", "message": "server error"})
        except Exception:
            pass
    finally:
        if dg is not None:
            try:
                await dg.close_stream()
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass
