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
import io
import json
import logging
import os
import struct
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

# ============================================================
# WHISPER-1 OVERRIDE (Fabio 2026-07-01 — "primo → 1º" bug)
# ============================================================
# Deepgram continua a gestire endpointing (detection di quando smetti di
# parlare) MA la trascrizione finale, se possibile, la prendiamo da
# Whisper-1 di OpenAI: più accurato in italiano rumoroso (furgone).
# Fallback trasparente al testo Deepgram se Whisper fallisce/timeout.
EMERGENT_LLM_KEY = os.getenv("EMERGENT_LLM_KEY", "")
WHISPER_ENABLED = bool(EMERGENT_LLM_KEY)
WHISPER_TIMEOUT_SEC = 6.0  # tempo max prima del fallback Deepgram
_whisper_client = None

def _get_whisper_client():
    """Lazy init del client Whisper via emergentintegrations."""
    global _whisper_client
    if _whisper_client is None and WHISPER_ENABLED:
        try:
            from emergentintegrations.llm.openai.speech_to_text import OpenAISpeechToText
            _whisper_client = OpenAISpeechToText(api_key=EMERGENT_LLM_KEY)
            logger.info("[voice_stream] Whisper-1 client initialized (via EMERGENT_LLM_KEY)")
        except Exception as e:
            logger.warning(f"[voice_stream] Whisper-1 client init failed: {e}")
            _whisper_client = None
    return _whisper_client

def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 16000) -> bytes:
    """Wrappa PCM s16le mono in header WAV RIFF (formato accettato da Whisper).

    Header WAV standard 44-byte per PCM 16-bit mono a 16 kHz.
    """
    num_samples = len(pcm_bytes) // 2  # 16-bit = 2 byte per sample
    byte_rate = sample_rate * 2  # mono * 2 byte
    header = b"RIFF"
    header += struct.pack("<I", 36 + len(pcm_bytes))  # chunk size
    header += b"WAVEfmt "
    header += struct.pack("<I", 16)  # subchunk1 size (PCM)
    header += struct.pack("<H", 1)  # audio format (1 = PCM)
    header += struct.pack("<H", 1)  # num channels (mono)
    header += struct.pack("<I", sample_rate)
    header += struct.pack("<I", byte_rate)
    header += struct.pack("<H", 2)  # block align
    header += struct.pack("<H", 16)  # bits per sample
    header += b"data"
    header += struct.pack("<I", len(pcm_bytes))  # data size
    return header + pcm_bytes

async def transcribe_pcm_with_whisper(pcm_bytes: bytes, session_short: str = "?") -> Optional[str]:
    """Trascrivi PCM 16kHz mono via Whisper-1. None se fallisce (fallback DG).

    L'input è PCM linear16 già convertito da ffmpeg. Lo wrappiamo in WAV
    e lo passiamo a Whisper come file-like object. Se Whisper impiega
    più di WHISPER_TIMEOUT_SEC secondi → None → il caller usa DG.
    """
    if not pcm_bytes or not WHISPER_ENABLED:
        return None
    client = _get_whisper_client()
    if client is None:
        return None
    try:
        wav_bytes = _pcm_to_wav(pcm_bytes, sample_rate=16000)
        buf = io.BytesIO(wav_bytes)
        buf.name = "utterance.wav"  # emergentintegrations valida l'estensione
        t0 = time.time()
        # === FIX 2026-07-02 (Fabio "log JSON in Claude") ===
        # response_format="json" → ritorna un oggetto con .text pulito.
        # Il proxy Emergent (via litellm) può però wrappare la risposta in
        # vari modi (TranscriptionResponse pydantic, dict, str JSON, o
        # anche una string che CONTIENE il JSON verbose_json). Nel log
        # utente del 2026-07-01 si è visto Claude ricevere direttamente
        # `{"text":"...","usage":{"type":"duration",...}}` come "final
        # text": significa che uno dei rami di sopra estraeva `text` ma
        # il valore ESTRATTO era a sua volta JSON annidato.
        # Fix: dopo aver preso `text` da qualsiasi ramo, se sembra JSON
        # (inizia con `{`), fai `json.loads` e ri-estrai `.text`. Loop
        # 2 giri per gestire doppio wrapping.
        response = await asyncio.wait_for(
            client.transcribe(
                file=buf,
                model="whisper-1",  # === FIX 2026-07-10 (Fabio) — Rollback da gpt-4o-mini-transcribe (respinto dal proxy Emergent LLM: "Invalid model: gpt-4o-mini-transcribe. Must be one of ['whisper-1']") → torniamo a whisper-1 che è supportato dal proxy ===
                response_format="json",
                language="it",
                # === FIX 2026-07-02 v43 — Prompt generico italiano ===
                # NOTA IMPORTANTE (Fabio 2026-07-02): il prompt DEVE restare
                # GENERICO. Koda è un'app per chiunque parli italiano — non
                # per un utente specifico. Il prompt aiuta il modello a
                # riconoscere l'italiano quotidiano naturale, NON a boostare
                # keyword di un dominio specifico. Se in futuro serve gergo
                # specifico (es. cucina, edilizia, sanità), il fix corretto
                # è iniettarlo dinamicamente dal profilo utente, NON
                # hardcodarlo qui.
                # Stesso prompt usato in server.py per coerenza cross-endpoint.
                prompt=(
                    "Conversazione informale in italiano. Sport: boxe, calcio, "
                    "tennis, padel, yoga, palestra. Cibo: pasta, pizza, "
                    "espresso, caffè, brioche, cornetto. Tecnologia: "
                    "smartphone, app, password, email, file, WiFi. Lavoro, "
                    "soldi, spese, banca. Famiglia, mamma, papà, fratello, "
                    "sorella. Numeri e orari naturali (es: alle sette e "
                    "mezza, fra dieci minuti)."
                ),
            ),
            timeout=WHISPER_TIMEOUT_SEC,
        )
        elapsed_ms = int((time.time() - t0) * 1000)

        def _extract_text(payload: Any) -> str:
            """Estrai il campo 'text' da un payload (str/dict/obj) in modo
            tollerante. Ritorna stringa vuota se non trovato.
            """
            if payload is None:
                return ""
            # dict → prendi 'text'
            if isinstance(payload, dict):
                return str(payload.get("text") or "").strip()
            # pydantic/obj con .text
            attr = getattr(payload, "text", None)
            if isinstance(attr, str):
                return attr.strip()
            # str → potrebbe essere plain text o JSON string
            if isinstance(payload, str):
                return payload.strip()
            return ""

        raw_text = _extract_text(response)

        # === Sanitizzazione anti-JSON annidato ===
        # Se il testo estratto sembra a sua volta un JSON (es.
        # '{"text":"ciao","usage":...}'), lo parsiamo e ri-estraiamo.
        # Facciamo max 3 loop per evitare cicli infiniti su payload strani.
        text: str = raw_text
        for _ in range(3):
            if not text:
                break
            s = text.strip()
            if not (s.startswith("{") and s.endswith("}")):
                break
            try:
                inner = json.loads(s)
            except Exception:
                # Non è JSON valido → tienilo così com'è
                break
            if isinstance(inner, dict) and "text" in inner:
                text = str(inner.get("text") or "").strip()
                # ripeti il check al prossimo giro
                continue
            break
        text = text.strip()
        # === FIX 2026-07-02 v42 — Filtro anti-hallucination esteso per gpt-4o-mini-transcribe ===
        # Pattern legacy Whisper-1 (YouTube training) → mantenuti come double-guard.
        # Nuovi pattern gpt-4o-mini-transcribe: ripetizioni patologiche
        # (es. "sì sì sì sì sì" su audio muto), continuazioni fantasma.
        _HALLUCINATION_MARKERS = (
            # Legacy Whisper-1 (safe double-guard)
            "amara.org",
            "sottotitoli creati",
            "grazie per aver guardato",
            "grazie a tutti per",
            "iscrivetevi al canale",
            "www.",
            # gpt-4o-mini-transcribe: canali/CTA occasionali
            "iscriviti al canale",
            "grazie per l'ascolto",
            "buon proseguimento",
            "grazie per aver visto",
            # === FIX 2026-07-11 (Fabio) — Whisper prompt-bleed hallucination ===
            # whisper-1 su audio silenzioso/rumoroso rigurgita frammenti del
            # prompt biasing. Il prompt in server.py contiene: "Numeri e orari
            # naturali (es: alle sette e mezza, fra dieci minuti)." Se il testo
            # trascritto contiene questi frammenti letterali → hallucination.
            "numeri e orari naturali",
            "alle sette e mezza",
            "fra dieci minuti",
            "es: alle sette",
            # === FIX 2026-07-11 pomeriggio (Fabio "Pag. 1 Pag. 2") ===
            # whisper-1 su audio interamente muto/rumoroso genera enumerazioni
            # di pagine, capitoli, punti — è un pattern tipico di training su
            # documenti PDF/libri. Detecter sotto ma anche double-guard qui.
            "pag. 1 pag. 2",
            "capitolo 1 capitolo 2",
            "punto 1 punto 2",
        )
        low = text.lower()
        if text and any(m in low for m in _HALLUCINATION_MARKERS):
            logger.info(
                f"[voice_stream sess={session_short}] STT hallucination "
                f"(marker) detected → fallback Deepgram (was: {text!r})"
            )
            return None
        # === FIX 2026-07-11 (Fabio) — Progressive enumeration hallucination ===
        # Detecta pattern tipo "X 1 X 2 X 3 X 4 X 5" o "1. Y 2. Y 3. Y":
        # whisper allucina enumerazioni da training su documenti/PDF.
        try:
            words_seq2 = [w.lower().strip(",.!?;:") for w in text.split() if w]
            # Estrai numeri consecutivi visti nel testo
            import re as _re
            nums = [int(w) for w in words_seq2 if _re.fullmatch(r"\d+", w)]
            if len(nums) >= 4:
                # Verifica se sono strettamente crescenti di 1 (1,2,3,4,5)
                is_progressive = all(nums[i + 1] - nums[i] == 1 for i in range(len(nums) - 1))
                if is_progressive and nums[0] <= 3:  # inizia da 1, 2 o 3
                    logger.info(
                        f"[voice_stream sess={session_short}] STT hallucination "
                        f"(progressive enumeration {nums}) → fallback Deepgram "
                        f"(was: {text!r})"
                    )
                    return None
        except Exception:
            pass
        # === FIX 2026-07-11 (Fabio) — Sentence-level repetition ===
        # volte. Es: "Numeri e orari naturali. Numeri e orari naturali."
        # oppure "Grazie mille grazie mille". Detectiamo ripetizioni di
        # sequenze di 2+ parole con span totale ≥50% del testo.
        try:
            words_lc_seq = [w.lower().strip(",.!?;:") for w in text.split() if w]
            n_seq = len(words_lc_seq)
            if n_seq >= 4:
                # Try sequence length from 2 up to n/2
                repeat_found = False
                for L in range(2, min(n_seq // 2 + 1, 8)):  # L=lunghezza sequenza
                    for start in range(0, n_seq - 2 * L + 1):
                        seq_a = words_lc_seq[start : start + L]
                        seq_b = words_lc_seq[start + L : start + 2 * L]
                        if seq_a == seq_b and len(" ".join(seq_a)) >= 8:
                            repeat_found = True
                            break
                    if repeat_found:
                        break
                if repeat_found:
                    logger.info(
                        f"[voice_stream sess={session_short}] STT hallucination "
                        f"(sentence-level repetition) → fallback Deepgram "
                        f"(was: {text!r})"
                    )
                    return None
        except Exception:
            pass
        # === FIX 2026-07-02 v42 — Detector ripetizioni patologiche ===
        # gpt-4o-mini-transcribe su audio muto/rumoroso tende a produrre
        # sequenze del tipo "sì sì sì sì sì" o "no no no no no". Se la
        # stessa parola breve compare >=5 volte consecutive, è hallucination.
        # Threshold conservativo per evitare falsi positivi su parlato reale
        # con ripetizioni naturali (es. "no no aspetta" è legittimo).
        try:
            words = [w.lower().strip(",.!?;:") for w in text.split() if w]
            if len(words) >= 5:
                # Trova la sequenza più lunga di parole identiche consecutive
                max_run = 1
                cur_run = 1
                cur_w = words[0]
                for w in words[1:]:
                    if w == cur_w and len(w) <= 4:  # solo parole corte (sì, no, eh, mh, ok)
                        cur_run += 1
                        if cur_run > max_run:
                            max_run = cur_run
                    else:
                        cur_run = 1
                        cur_w = w
                if max_run >= 5:
                    logger.info(
                        f"[voice_stream sess={session_short}] STT hallucination "
                        f"(repetition run={max_run}) → fallback Deepgram "
                        f"(was: {text!r})"
                    )
                    return None
        except Exception:
            pass  # non blocchiamo per errore di filtro
        # === FIX 2026-07-10 pomeriggio (Fabio "Gradanti cellulari naturali") ===
        # Detector whisper-1 nonsense hallucination su audio rumoroso.
        # Pattern osservato in produzione: whisper-1 su audio con SNR basso o
        # silenzio parziale allucina "frasi" corte fatte di 2-6 sostantivi/aggettivi
        # sconnessi, tutti lunghi (≥6 char), senza articoli/verbi/preposizioni.
        # Es. "Gradanti cellulari naturali.", "Camarera portafoglio decisivo."
        # Se la frase è breve E ogni parola è lunga E nessuna parola è tra
        # quelle funzionali italiane più frequenti → hallucination → reject.
        # Whitelist ultra-conservativa: se anche UNA parola funzionale è presente,
        # la frase è considerata legittima. Evita falsi positivi su parlato reale.
        _COMMON_IT_FUNCTIONAL_WORDS = {
            # articoli/preposizioni/congiunzioni
            "il", "la", "lo", "i", "gli", "le", "un", "uno", "una",
            "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
            "del", "dello", "della", "dei", "degli", "delle",
            "al", "allo", "alla", "ai", "agli", "alle",
            "dal", "dalla", "dai", "dagli", "dalle",
            "nel", "nella", "nei", "negli", "nelle",
            "sul", "sulla", "sui", "sugli", "sulle",
            "col", "coi",
            "e", "o", "ma", "però", "quindi", "anche", "come", "che", "chi",
            "se", "quando", "dove", "perché", "mentre", "senza",
            # pronomi/verbi ausiliari comuni
            "io", "tu", "lui", "lei", "noi", "voi", "loro",
            "mi", "ti", "ci", "vi", "si", "ne",
            "me", "te", "sé",
            "ho", "hai", "ha", "abbiamo", "avete", "hanno",
            "sono", "sei", "è", "siamo", "siete",
            "ero", "eri", "era", "eravamo", "eravate", "erano",
            "avevo", "avevi", "aveva",
            "sarò", "sarai", "sarà",
            "faccio", "fai", "fa", "fatto", "fare",
            "vado", "vai", "va", "andare",
            "voglio", "vuoi", "vuole", "vogliamo",
            "posso", "puoi", "può", "possiamo",
            # negazioni/avverbi/interiezioni frequenti
            "non", "no", "sì", "si", "già", "mai", "sempre", "ora", "adesso",
            "poi", "prima", "dopo", "qui", "lì", "là", "molto", "poco", "tanto",
            "bene", "male", "così", "solo", "davvero", "forse", "quasi",
            "cosa", "cose", "niente", "tutto", "tutti", "nulla", "qualcosa",
            "ciao", "grazie", "prego", "scusa", "aspetta", "senti", "guarda",
            "ok", "va", "bene", "eh", "mh", "boh", "beh",
            # verbi/sostantivi molto frequenti (base koda usage)
            "voglio", "penso", "credo", "sento", "vedo", "dico", "detto",
            "sono", "casa", "vita", "tempo", "giorno", "oggi", "ieri", "domani",
            "koda", "coda",  # nome AI
        }
        try:
            words_nostrip = [w.strip(",.!?;:()[]\"'“”‘’") for w in text.split() if w]
            words_lc = [w.lower() for w in words_nostrip if w]
            n = len(words_lc)
            if 2 <= n <= 6:
                has_functional = any(w in _COMMON_IT_FUNCTIONAL_WORDS for w in words_lc)
                all_long = all(len(w) >= 6 for w in words_lc)
                if not has_functional and all_long:
                    logger.info(
                        f"[voice_stream sess={session_short}] STT hallucination "
                        f"(nonsense: {n} long words, no functional) → fallback Deepgram "
                        f"(was: {text!r})"
                    )
                    return None
        except Exception:
            pass
        logger.info(
            f"[voice_stream sess={session_short}] STT_MODEL=whisper-1 "
            f"pcm={len(pcm_bytes)}B ({len(pcm_bytes)/32000:.1f}s) "
            f"ms={elapsed_ms} text={text!r}"
        )
        return text if text else None
    except asyncio.TimeoutError:
        logger.warning(
            f"[voice_stream sess={session_short}] STT_MODEL=whisper-1 TIMEOUT "
            f"({WHISPER_TIMEOUT_SEC}s) → fallback Deepgram"
        )
        return None
    except Exception as e:
        logger.warning(
            f"[voice_stream sess={session_short}] Whisper-1 error → fallback Deepgram: {e}"
        )
        return None

# Parametri di query string Deepgram Live — vedi docstring per spiegazione.
# IMPORTANTE: questi sono valori INIZIALI da tunare nel furgone.
# === FIX 2026-07-02 (Fabio "non capisce quando chiudere in furgone") ===
# I parametri di endpointing ora sono DINAMICI in funzione dell'audio route
# rilevata dal client (Bluetooth auto, auricolari cablati, mic interno).
# Vedi `dg_params_for_route()` sotto. Questi restano come default/fallback
# per compatibilità (se il client non manda audio_route).
DG_PARAMS = {
    "model": "nova-3",
    "language": "it",
    "encoding": "linear16",
    "sample_rate": "16000",
    "channels": "1",
    "endpointing": "250",
    "utterance_end_ms": "800",
    "interim_results": "true",
    "vad_events": "true",
    "smart_format": "true",
    "filler_words": "false",
    "punctuate": "true",
    # === FIX 2026-06-25 v10 (post-Build #9 home test) ===
    # In casa silenziosa Deepgram trascriveva "Ciao Cosa" invece di "Ciao Koda"
    # (e talvolta "Coda"/"Goda"). Nova-3 supporta keyterm prompting (plain
    # string, NO intensifier suffix). Boostiamo il nome "Koda" così che la
    # rete neurale lo preferisca alle parole foneticamente vicine.
    # === FIX 2026-07-03 v45 (Fabio "STT dice metri invece di chilometri") ===
    # Log reale in CarPlay: DG trascrive "400 metri" quando Fabio dice
    # "400 chilometri". Ambiente rumoroso + parola foneticamente ambigua
    # (metri vs chilometri hanno la stessa terminazione "-etri"). Nova-3
    # accetta MULTIPLI keyterm — passiamo lista completa unità di misura
    # + parole del dominio Fabio (autista/furgone). QS builder in
    # `connect()` emette un `keyterm=X` per ogni elemento della lista.
    "keyterm": [
        "Koda",
        # Unità di misura (cutoff "metri/chilometri" #1 problema Fabio)
        "chilometri", "kilometri", "chilometro", "chilometraggio",
        "minuti", "minuto", "secondi", "ora", "ore",
        # Dominio guida/furgone
        "autista", "furgone", "camion", "autostrada",
        "consegna", "consegne", "pacco", "pacchi", "corriere",
        "uscita", "ingresso", "casello", "svincolo",
        # Nomi luoghi ricorrenti nei log Fabio
        "Fiano", "Capena", "Monterotondo", "Roma", "Lazio",
    ],
}


def dg_params_for_route(audio_route: Optional[str]) -> Dict[str, str]:
    """Restituisce i parametri Deepgram tunati per la audio route corrente.

    === FIX 2026-07-02 (Fabio furgone) + hotfix regressione DG-400 ===
    In furgone connesso al Bluetooth auto, il mic dell'auto/telefono
    riceve costantemente rumore motore/vento. Deepgram non trigga
    speech_final finché non c'è un vero "silenzio" — che in furgone
    non arriva mai. Tunare AGGRESSIVAMENTE l'endpointing (soglia in ms
    di "silenzio percepito" dopo cui DG marca fine utterance) risolve.

    IMPORTANTE (bugfix iter12): Deepgram Live impone un MINIMO HARD di
    1000ms su `utterance_end_ms`. Valori inferiori causano HTTP 400
    "server rejected WebSocket connection" e la WS non si apre → nessun
    STT → Koda non risponde. Manteniamo quindi utterance_end_ms=1000
    per TUTTE le route e variamo SOLO `endpointing` (minimo ~10ms
    documentato, quindi valori come 150-350 sono tutti validi).

    Args:
        audio_route: uno di "bluetooth", "wired", "builtin", None (o
                     stringa sconosciuta → trattata come "builtin").
    Returns:
        Copia di DG_PARAMS con endpointing/utterance_end_ms adattati.
    """
    params = dict(DG_PARAMS)
    route = (audio_route or "").strip().lower()
    if route == "bluetooth":
        # === FIX 2026-07-03 v45 (Fabio "mi tagli il 400 prima di dire chilometri") ===
        # Log reale: "che cazzo hai capito? 400" — tagliato PRIMA di completare
        # "chilometri". Fabio stava pensando/dicendo il numero, DG con 900ms
        # ha chiuso l'utterance perché ha visto silenzio breve dopo "400".
        # In stato agitato/pensiero (guida stressata, ha appena litigato con
        # Koda per un errore di comprensione) le pause tra parole possono
        # arrivare a 1000-1100ms. Alziamo endpointing a 1200ms per Bluetooth
        # CarPlay: soglia superiore alla pausa massima di riflessione stress.
        # utterance_end_ms rimane 2000ms (Deepgram aspetta 2s totali per
        # dichiarare fine utterance).
        # Trade-off: +300ms sul TTFT audio a fine turno. Accettabile: molto
        # meglio di essere tagliati mentre stai per completare la parola.
        params["endpointing"] = "1200"
        params["utterance_end_ms"] = "2000"
    elif route == "wired":
        # Auricolari cablati: contesto tipicamente silenzioso, meno rischio
        # falsi positivi. Manteniamo un po' più conservativo.
        params["endpointing"] = "350"
        params["utterance_end_ms"] = "1000"
    else:
        # builtin / unknown: default bilanciato.
        # === FIX 2026-07-03 v39 (Fabio "mi tagli ancora le frasi") ===
        # 250ms erano troppo aggressivi per mic interno iPhone: bastava
        # una pausa di respirazione (~300ms) tra una frase e l'altra
        # perché Deepgram dichiarasse speech_final → cutoff. Alzato a
        # 600ms: soglia superiore alla pausa di respirazione (200-400ms)
        # ma inferiore a una pausa di riflessione (>800ms).
        # utterance_end_ms alzato 1000→1500: dà a Deepgram un margine
        # più largo per capire se l'utterance è finita davvero o è solo
        # una pausa naturale.
        # Trade-off: +300-500ms di latenza dopo che l'utente ha finito
        # DAVVERO di parlare (perché DG aspetta più a lungo). In cambio,
        # niente più cutoff su frasi con pause di respirazione naturali.
        # === FIX 2026-07-02 v40 (Fabio "Koda mi ha interrotto in furgone") ===
        # Ancora troppo aggressivo per uso in guida. Pausa media di
        # riflessione al volante = 700-1200ms (guardi lo specchio,
        # pensi alla prossima parola). Con 600ms Koda partiva a
        # rispondere prima che l'utente finisse. Alzato a 900ms
        # (tollera pausa di respirazione lunga) e utterance_end_ms a
        # 2000ms (Deepgram aspetta di vedere davvero silenzio prima
        # di dichiarare fine).
        # Trade-off aggiuntivo: +300-500ms sul TTFT audio a fine turno.
        # Accettabile perché elimina il "Koda mi interrompe" — bug
        # molto più frustrante della latenza.
        params["endpointing"] = "900"
        params["utterance_end_ms"] = "2000"
    # Dev-time + runtime guard: Deepgram richiede utterance_end_ms>=1000.
    # Nota: usiamo un if esplicito invece di `assert` così la protezione
    # resta attiva anche in prod se qualcuno lancia uvicorn con `-O`
    # (asserts strippati). Se qualcuno accidentalmente edita i valori
    # sopra a <1000, logghiamo l'errore e forziamo 1000 → WS non fallisce.
    try:
        if int(params["utterance_end_ms"]) < 1000:
            logger.error(
                f"[dg_params_for_route] INVALID utterance_end_ms="
                f"{params.get('utterance_end_ms')!r} for route={route!r} "
                f"— Deepgram will reject with HTTP 400. Forcing to 1000."
            )
            params["utterance_end_ms"] = "1000"
    except (ValueError, TypeError):
        logger.error(
            f"[dg_params_for_route] non-int utterance_end_ms="
            f"{params.get('utterance_end_ms')!r} — Forcing to 1000."
        )
        params["utterance_end_ms"] = "1000"
    return params

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

# === FIX 2026-07-02 v40 (Fabio "entra in registrazione e non si muove più") ===
# Watchdog: se dopo X secondi dallo start della utterance corrente non è
# arrivato nessuno stt_final (Deepgram non riesce a chiudere in ambiente
# rumoroso, es. furgone), forziamo la trascrizione fallback su tutto il
# PCM accumulato via gpt-4o-mini-transcribe e chiudiamo la sessione pulita.
# Evita il caso di sessioni appese indefinitamente che richiedono la
# chiusura manuale dell'app.
MAX_UTTERANCE_NO_FINAL_S = 30.0


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

    def __init__(self, session_id: str, dg_params: Optional[Dict[str, str]] = None):
        self.session_id = session_id
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        self._closed = False
        self._connect_started_at: Optional[float] = None
        # === FIX 2026-07-02 (Fabio audio route dinamica) ===
        # Se il caller passa dei parametri custom (es. tunati per Bluetooth),
        # li usiamo. Altrimenti fallback ai default globali.
        self.dg_params: Dict[str, str] = dg_params if dg_params else dict(DG_PARAMS)

    @property
    def short_id(self) -> str:
        return self.session_id[:8]

    async def connect(self) -> None:
        if not DEEPGRAM_API_KEY:
            raise RuntimeError("DEEPGRAM_API_KEY not configured")
        # === FIX 2026-07-03 v45 — keyterm multipli ===
        # Deepgram Nova-3 accetta un `keyterm=X` per ogni parola boostata.
        # Se un value del dict è una lista, emettiamo più occorrenze dello
        # stesso param (Fabio: chilometri/metri, autista, furgone, ecc.).
        from urllib.parse import quote as _uq
        qs_parts = []
        for k, v in self.dg_params.items():
            if isinstance(v, (list, tuple)):
                for item in v:
                    qs_parts.append(f"{k}={_uq(str(item))}")
            else:
                qs_parts.append(f"{k}={_uq(str(v))}")
        qs = "&".join(qs_parts)
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
            f"model={self.dg_params['model']} lang={self.dg_params['language']} "
            f"endpointing={self.dg_params['endpointing']}ms "
            f"utterance_end_ms={self.dg_params['utterance_end_ms']}ms"
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
    # === FIX 2026-07-01 — Whisper-1 override (Fabio "primo → 1º") ===
    # Buffer PCM 16kHz mono accumulato per l'utterance corrente. Deepgram
    # continua a fare l'endpointing (sa quando smetti di parlare) ma la
    # trascrizione finale, se Whisper risponde in tempo, la prendiamo da
    # Whisper: più accurata in italiano rumoroso (furgone). Fallback a
    # Deepgram in caso di errore/timeout → zero rischio regressione.
    utterance_pcm_buffer = bytearray()

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
        # === FIX 2026-07-02 (Fabio "non capisce quando chiudere in furgone") ===
        # Il client manda la audio route rilevata (bluetooth/wired/builtin).
        # Usiamo questa info per tunare i parametri Deepgram (endpointing +
        # utterance_end_ms) e chiudere il mic anche nel rumore del furgone.
        audio_route = (start_req.get("audio_route") or "").strip().lower() or None
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
            f"audio_route={audio_route!r} "
            f"city={location_city!r} region={location_region!r} country={location_country!r}"
        )

        # ---------------- 2) Connetti a Deepgram ----------------
        if not DEEPGRAM_API_KEY:
            await emit_to_client({"type": "error", "message": "STT not configured"})
            return
        # Params Deepgram tunati per la audio route corrente (bluetooth in
        # furgone → più aggressivo, wired → più conservativo).
        dg_params_dyn = dg_params_for_route(audio_route)
        dg = DeepgramLiveSession(session_id=session_id, dg_params=dg_params_dyn)
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
                            # === FIX 2026-07-01 — Whisper override ===
                            # Snapshot PCM PRIMA di clear (per Whisper).
                            pcm_snapshot = bytes(utterance_pcm_buffer)
                            utterance_pcm_buffer.clear()
                            await _trigger_pipeline(final_text, pcm_snapshot)

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
                            pcm_snapshot = bytes(utterance_pcm_buffer)
                            utterance_pcm_buffer.clear()
                            await _trigger_pipeline(final_text, pcm_snapshot)

                elif evt_type == "Metadata":
                    # Metadata di sessione (ignora per ora)
                    pass

                elif evt_type == "Error":
                    msg = evt.get("description") or evt.get("message") or str(evt)
                    logger.error(f"[KODA_STREAM_DG sess={short_id}] error: {msg}")
                    await emit_to_client({"type": "error", "message": f"STT error: {msg}"})
                    break

        async def _trigger_pipeline(final_text: str, pcm_snapshot: bytes = b"") -> None:
            """Esegue la pipeline LLM+TTS esistente con il testo trascritto.

            === FIX 2026-07-01 — Whisper-1 override ===
            Se abbiamo il PCM buffer di questa utterance, proviamo a
            trascriverlo con Whisper-1 (più accurato in italiano rumoroso).
            Se Whisper riesce → usiamo il suo testo. Altrimenti fallback
            trasparente al testo Deepgram (`final_text`) come prima.
            """
            nonlocal pipeline_in_flight, utterance_confidence
            # === FIX 2026-07-09 — Idempotency guard ===
            # Sia dg_event_loop (su speech_final) sia il branch "end" (fallback)
            # possono tentare di chiamare _trigger_pipeline. Se una è già in
            # corso, il secondo chiamante deve abortire silenziosamente per
            # evitare doppie risposte TTS / doppio consumo LLM.
            if pipeline_in_flight:
                logger.info(
                    f"[KODA_STREAM sess={short_id}] _trigger_pipeline SKIP "
                    f"(already in flight) — caller text={final_text!r}"
                )
                return
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

            # === FIX 2026-07-01 — Whisper override + skip su high-confidence (Fabio latenza) ===
            # Log confronto Deepgram vs Whisper per capire quanto migliora
            # in produzione. Se Whisper vuoto/errore → tengo Deepgram.
            #
            # OTTIMIZZAZIONE LATENZA: se Deepgram è confidente (conf>=0.7)
            # E il testo è "sano" (nessuna cifra sospetta tipo 1º/2ª/3° in
            # posti strani), SKIP Whisper → risparmio 500-800ms per turno.
            # Whisper resta attivo solo su testi sospetti dove serve davvero.
            transcript_source = "deepgram"
            transcript_used = final_text

            # Heuristica "testo sospetto" che triggera Whisper anche con conf alta:
            #   - cifre ordinali tipo "1º", "2ª", "3°" (STT confuso "primo"→"1º")
            #   - testo molto corto (<8 char) che spesso è rumore
            #   - troncamento evidente (ultima parola sotto 3 char)
            import re as _re
            _suspicious_ordinal = bool(_re.search(r'\b\d+[°ºªᵃᵉ]', final_text))
            _too_short = len(final_text.strip()) < 8
            _ends_truncated = False
            _words = final_text.strip().split()
            if _words and len(_words[-1]) <= 2 and _words[-1] not in {"è", "e", "a", "o", "in", "di", "da", "un", "il", "la", "le", "no", "sì", "un'", "l'", "d'", "un", "ho", "so", "va", "sa", "fa", "me", "mi", "ti", "si", "ci", "vi", "lo", "gli", "che", "chi", "fu", "ma"}:
                _ends_truncated = True
            suspicious = _suspicious_ordinal or _too_short or _ends_truncated

            # Conf alta = Deepgram si fida. In quel caso skip Whisper SE
            # non ci sono altri segnali sospetti.
            dg_high_confidence = (conf_snapshot is not None and conf_snapshot >= 0.7)

            skip_whisper = dg_high_confidence and not suspicious

            if WHISPER_ENABLED and pcm_snapshot and len(pcm_snapshot) > 1600 and not skip_whisper:
                # 1600B = 0.05s @ 16kHz → skip utterance troppo brevi che
                # sarebbero rumore o click accidentale.
                # === FIX 2026-07-03 v40 — Timing Whisper misurato ===
                # Per rispondere alla domanda di Fabio "quanto costa Whisper
                # esattamente in produzione?" logghiamo il ms reale ogni turno.
                _t_whisper_start = time.time()
                whisper_text = await transcribe_pcm_with_whisper(
                    pcm_snapshot, session_short=short_id
                )
                _whisper_ms = int((time.time() - _t_whisper_start) * 1000)
                logger.info(
                    f"[KODA_PIPELINE_STT sess={short_id}] "
                    f"whisper_ms={_whisper_ms} dg_conf={conf_snapshot} "
                    f"whisper_hit={bool(whisper_text)}"
                )
                if whisper_text:
                    transcript_source = "whisper-1"
                    transcript_used = whisper_text
                    logger.info(
                        f"[KODA_STT_OVERRIDE sess={short_id}] "
                        f"deepgram={final_text!r} conf={conf_snapshot} "
                        f"whisper={whisper_text!r} "
                        f"→ using WHISPER (suspicious={suspicious})"
                    )
                else:
                    logger.info(
                        f"[KODA_STT_OVERRIDE sess={short_id}] "
                        f"whisper unavailable → using DEEPGRAM: {final_text!r}"
                    )
            elif skip_whisper:
                logger.info(
                    f"[KODA_STT_OVERRIDE sess={short_id}] "
                    f"skip whisper (dg_conf={conf_snapshot} high) → deepgram={final_text!r}"
                )
                logger.info(
                    f"[KODA_PIPELINE_STT sess={short_id}] "
                    f"whisper_ms=0 dg_conf={conf_snapshot} whisper_hit=SKIPPED"
                )

            await emit_to_client({
                "type": "stt_final",
                "text": transcript_used,
                "confidence": conf_snapshot,
                "audio_duration_ms": audio_duration_ms,
                "stt_source": transcript_source,  # per diag frontend
            })
            try:
                await run_pipeline_for_text(
                    text=transcript_used,
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

        # === FIX 2026-07-02 v40 — Watchdog anti-blocco ===
        # Se Deepgram non emette speech_final o UtteranceEnd entro
        # MAX_UTTERANCE_NO_FINAL_S (30s) dallo start della utterance corrente,
        # forziamo la chiusura della utterance triggerando la pipeline con
        # il PCM accumulato (Whisper si occupa della trascrizione se il testo
        # Deepgram è vuoto). Evita il caso "furgone rumoroso → DG non decide
        # mai" che lasciava la sessione bloccata indefinitamente.
        async def utterance_watchdog_loop() -> None:
            nonlocal speech_started_at
            while client_alive and dg is not None and not dg._closed:
                try:
                    await asyncio.sleep(2.0)
                except asyncio.CancelledError:
                    break
                # Se stiamo già processando o non abbiamo audio, skip.
                if pipeline_in_flight:
                    continue
                if not utterance_pcm_buffer:
                    continue
                # Riferimento temporale: preferiamo speech_started_at
                # (Deepgram ha visto voce). Se DG non l'ha mai emesso ma
                # abbiamo comunque audio nel buffer, usiamo started_at
                # + un piccolo warmup di 3s per non triggerare troppo
                # presto su rumore breve.
                ref_t = speech_started_at if speech_started_at is not None else (started_at + 3.0)
                elapsed = time.time() - ref_t
                if elapsed < MAX_UTTERANCE_NO_FINAL_S:
                    continue
                # Trigger fallback
                buf_size = len(utterance_pcm_buffer)
                partial_text = " ".join(utterance_text_parts).strip()
                logger.warning(
                    f"[KODA_STREAM sess={short_id}] WATCHDOG: no stt_final "
                    f"in {elapsed:.1f}s buffer={buf_size}B "
                    f"partial_text={partial_text!r} → forcing fallback transcribe"
                )
                pcm_snapshot = bytes(utterance_pcm_buffer)
                utterance_pcm_buffer.clear()
                utterance_text_parts.clear()
                # Reset per una eventuale prossima utterance nella
                # stessa sessione (anche se in pratica il client
                # probabilmente chiude e riapre).
                speech_started_at = None
                try:
                    await _trigger_pipeline(partial_text, pcm_snapshot)
                except Exception as e:
                    logger.error(
                        f"[KODA_STREAM sess={short_id}] watchdog pipeline error: {e}"
                    )

        watchdog_task = asyncio.create_task(utterance_watchdog_loop())

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
                    # === FIX 2026-07-01 — accumula PCM per Whisper override ===
                    utterance_pcm_buffer.extend(pcm)

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
                            f"[KODA_STREAM sess={short_id}] client sent end frame — "
                            f"finalizing DG and awaiting pipeline completion"
                        )
                        # === FIX 2026-07-09 (Fabio "tap-to-stop closes WS too early") ===
                        # PROBLEMA precedente: dopo finalize() facevamo solo
                        # asyncio.sleep(2.0) e poi break → WS chiusa PRIMA che
                        # la pipeline LLM+TTS (Claude + ElevenLabs, tipicamente
                        # 3-5s) potesse emettere sentence + audio + done →
                        # Koda non rispondeva mai al tap-to-stop.
                        #
                        # NUOVO: dopo finalize aspettiamo (a) che la pipeline
                        # parta entro 3s, (b) che finisca entro 25s. Se DG non
                        # emette speech_final in 3s ma abbiamo PCM buffer,
                        # facciamo il fallback Whisper direttamente.
                        try:
                            await dg.finalize()
                        except Exception as e:
                            logger.warning(
                                f"[KODA_STREAM sess={short_id}] dg.finalize() failed: {e}"
                            )

                        # === FIX 2026-07-09 v2 — Wait unificato con detection start/end ===
                        # Approccio:
                        #   - Max 28s totali per pipeline (3s start + 25s run)
                        #   - Traccia _pipeline_seen: True appena vediamo
                        #     pipeline_in_flight=True. Se poi torna False,
                        #     usciamo subito (pipeline complete).
                        #   - Se dopo 3s non l'abbiamo mai vista → fallback.
                        _t0 = time.time()
                        _pipeline_seen = False
                        while (time.time() - _t0) < 28.0:
                            if not client_alive:
                                break
                            if pipeline_in_flight:
                                _pipeline_seen = True
                            elif _pipeline_seen:
                                # Era in flight, ora finita → esci subito
                                break
                            elif (time.time() - _t0) > 3.0:
                                # 3s scaduti senza mai vedere pipeline partire
                                break
                            await asyncio.sleep(0.15)

                        # Fallback: DG non ha mai fatto partire la pipeline →
                        # trigger manuale con PCM buffer (Whisper)
                        if not _pipeline_seen and utterance_pcm_buffer and client_alive:
                            logger.warning(
                                f"[KODA_STREAM sess={short_id}] end frame: no DG "
                                f"speech_final in 3s, forcing fallback pipeline "
                                f"with {len(utterance_pcm_buffer)}B PCM"
                            )
                            pcm_snapshot = bytes(utterance_pcm_buffer)
                            utterance_pcm_buffer.clear()
                            partial_text = " ".join(utterance_text_parts).strip()
                            utterance_text_parts.clear()
                            try:
                                await _trigger_pipeline(partial_text, pcm_snapshot)
                                # Nota: _trigger_pipeline è await-blocking, quando
                                # ritorna la pipeline è già completa. Non serve
                                # un ulteriore wait.
                            except Exception as e:
                                logger.error(
                                    f"[KODA_STREAM sess={short_id}] end fallback "
                                    f"pipeline error: {e}"
                                )
                        elif _pipeline_seen and pipeline_in_flight and client_alive:
                            # Rara: siamo usciti dal wait unificato per timeout
                            # 28s ma la pipeline è ancora in corso. Warning e
                            # chiudiamo comunque.
                            logger.warning(
                                f"[KODA_STREAM sess={short_id}] end frame: pipeline "
                                f"still in flight after 28s, closing anyway"
                            )
                        else:
                            logger.info(
                                f"[KODA_STREAM sess={short_id}] end frame: pipeline "
                                f"complete (seen={_pipeline_seen}), closing session"
                            )
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
        # Cancella il watchdog task (v40)
        try:
            watchdog_task.cancel()
            await asyncio.wait_for(watchdog_task, timeout=1.0)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
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
