"""inworld_context_buffer.py — buffer per-utente dei testi effettivamente
sintetizzati, per alimentare `synthesisContext.previousRequests` di Inworld
TTS (Fabio 2026-11-04).

Scopo:
  - Conservare GLI ULTIMI testi che Inworld ha realmente sintetizzato con
    SUCCESSO per uno specifico utente. Serve come "memoria prosodica"
    passata nel body REST della chiamata successiva.
  - MAI contenere testo dell'utente (STT) spacciato per "sintesi
    precedente". Solo output effettivamente parlati da Ollenya.
  - MAI aggiungere latenza: la lettura è snapshot in-memory, O(1).

Vincoli documentati:
  - Max 5 testi (`MAX_PREV_REQUESTS`).
  - Combinati ≤ 2000 char (`MAX_PREV_TOTAL_CHARS`).
  - Ordine cronologico oldest→newest.
  - TTL (`CONTEXT_TTL_S`, default 180s): oltre questa soglia la coda
    scade e torna vuota — "contesto fresco" per nuove sessioni.

Flag di controllo:
  - Env ``INWORLD_SEND_CONTEXT=1`` → l'adapter dispatcher legge dal
    buffer e passa il campo nel payload. OFF di default: comportamento
    pre-2026-11-04 preservato.
  - Env ``INWORLD_SEND_CONTEXT`` non è letto QUI (modulo neutro): è il
    chiamante dispatcher a decidere se interrogare il buffer. Questo
    isola la policy dal data layer.

LIMITAZIONE NOTA (documentata, non bug):
  La pipeline Ollenya può generare segmenti TTS IN PARALLELO: segmento N+1
  può partire PRIMA che il segmento N abbia finito la synth. In questo
  caso il buffer per N+1 è "best-effort": contiene solo i segmenti già
  completati al momento della call. Non aspettiamo mai sintesi precedenti:
  l'alternativa (serializzare TTS per avere contesto perfetto) aumenterebbe
  la latenza e viola il vincolo esplicito di Fabio.

Policy di igiene:
  - Nessun contenuto personale STT. Il modulo accetta solo testi
    output. Chi inserisce accidentalmente un testo utente commette un
    bug CHIAMANTE: qui non facciamo euristica di detection.
  - I testi inseriti vengono troncati a 400 char (soglia conservativa
    per non superare il totale di 2000 su 5).
"""
from __future__ import annotations

import logging
import os
import time
from collections import deque
from threading import Lock
from typing import Deque, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ─── Limiti documentati Inworld (verificati su docs 2026-11-04) ──────
MAX_PREV_REQUESTS = 5
MAX_PREV_TOTAL_CHARS = 2000
PER_ITEM_SOFT_CAP_CHARS = 400  # 5 × 400 = 2000, dà cushion

# ─── TTL del buffer: oltre questo intervallo la coda è "stale" ───────
CONTEXT_TTL_S = float(os.environ.get("INWORLD_CONTEXT_TTL_S", "180"))

# ─── Max utenti attivi in buffer (LRU implicita per inattività) ──────
MAX_USERS_IN_MEMORY = int(os.environ.get("INWORLD_CONTEXT_MAX_USERS", "500"))

# user_id → deque di (timestamp_s, text_snippet). Snippet già troncato.
_buffers: Dict[str, Deque[Tuple[float, str]]] = {}
_lock = Lock()


def record_synthesized_text(user_id: Optional[str], text: str) -> None:
    """Chiamato dal dispatcher dopo una call Inworld RIUSCITA.

    `text` deve essere il testo REALMENTE inviato come `text` del payload
    (ciò che Inworld ha convertito in audio). Troncato internamente a
    PER_ITEM_SOFT_CAP_CHARS per garantire il vincolo cumulativo.

    Thread-safe. Idempotente logicamente (chiamarla 2 volte di seguito
    con lo stesso testo appende 2 entry — è responsabilità del chiamante
    non doppiare).
    """
    if not user_id or not text:
        return
    text = text.strip()
    if not text:
        return
    snippet = text[:PER_ITEM_SOFT_CAP_CHARS]
    now = time.monotonic()
    with _lock:
        q = _buffers.get(user_id)
        if q is None:
            # Semplice capienza per evitare growth illimitata.
            if len(_buffers) >= MAX_USERS_IN_MEMORY:
                # Elimina l'utente più stantio (quello col top più vecchio).
                try:
                    stalest_uid = min(
                        _buffers,
                        key=lambda u: (
                            _buffers[u][0][0] if _buffers[u] else 0.0
                        ),
                    )
                    _buffers.pop(stalest_uid, None)
                except ValueError:
                    pass
            q = deque(maxlen=MAX_PREV_REQUESTS)
            _buffers[user_id] = q
        q.append((now, snippet))


def _prune_for_payload(entries: List[Tuple[float, str]]) -> List[str]:
    """Applica i limiti documentati: tiene gli ultimi N (<=5) e taglia
    quelli più vecchi se il totale supera 2000 char. Mantiene l'ordine
    cronologico (oldest→newest). Elimina entries scadute per TTL.
    """
    now = time.monotonic()
    fresh = [(ts, t) for (ts, t) in entries if now - ts <= CONTEXT_TTL_S]
    if not fresh:
        return []
    # Prendi gli ultimi ≤5
    fresh = fresh[-MAX_PREV_REQUESTS:]
    # Dal più RECENTE indietro: accumula finché totale ≤ 2000.
    out_rev: List[str] = []
    total = 0
    for (_ts, t) in reversed(fresh):
        if total + len(t) > MAX_PREV_TOTAL_CHARS:
            break
        out_rev.append(t)
        total += len(t)
    return list(reversed(out_rev))


def get_context_for_user(user_id: Optional[str]) -> List[str]:
    """Snapshot thread-safe. Ritorna lista pronta per
    `synthesisContext.previousRequests` (già rispetta i limiti).
    Lista vuota = nessun contesto da inviare.
    """
    if not user_id:
        return []
    with _lock:
        q = _buffers.get(user_id)
        if not q:
            return []
        entries = list(q)
    return _prune_for_payload(entries)


def clear_user(user_id: Optional[str]) -> None:
    """Reset esplicito (es. logout, cambio sessione)."""
    if not user_id:
        return
    with _lock:
        _buffers.pop(user_id, None)


def is_context_feature_enabled() -> bool:
    """Flag master: SOLO se ``INWORLD_SEND_CONTEXT=1`` il dispatcher
    chiama ``get_context_for_user()``. Default OFF — nessun cambio di
    comportamento rispetto al pre-2026-11-04."""
    return os.environ.get("INWORLD_SEND_CONTEXT", "").strip() == "1"


# ─── Introspection per diagnostica (uso test / admin) ────────────────
def _debug_snapshot(user_id: Optional[str]) -> Dict[str, object]:
    """Non-pubblica: usata dai test offline per asserire stato."""
    if not user_id:
        return {"queue": [], "count": 0}
    with _lock:
        q = _buffers.get(user_id)
        if not q:
            return {"queue": [], "count": 0}
        return {
            "queue": [{"age_s": time.monotonic() - ts, "text": t} for (ts, t) in q],
            "count": len(q),
        }
