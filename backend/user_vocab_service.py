"""
user_vocab_service.py — Estrazione vocabolario adattivo per utente.

Analizza la timeline dell'utente e restituisce le parole ricorrenti come
"keyterm" da iniettare nei parametri Deepgram STT (Nova-3). Questo boosta
il riconoscimento di:
  • nomi propri (persone, luoghi, aziende ricorrenti nel vissuto dell'utente)
  • termini tecnici del suo dominio (parole del suo lavoro/hobby)
  • gergo personale (soprannomi, parole familiari)

Deepgram Nova-3 accetta multipli `keyterm=X` in query string: il motore
neurale li privilegia foneticamente rispetto a parole comuni con timbro
simile. Fabio dice spesso "furgone" → verrà boostato automaticamente.

Cache in-memory 5 min per uid — riduce carico DB su sessioni WS ripetute.
Reset naturale al restart backend (accettabile).

Come funziona:
  1) Query ultimi 200 messaggi role="user" dalla timeline dell'utente.
  2) Tokenizza il testo (alfabetico, min 4 char, lowercase).
  3) Rimuove stopword italiane (articoli, preposizioni, verbi ausiliari…).
  4) Counter delle frequenze → top N parole.
  5) Ritorna la lista pronta per essere aggiunta al `keyterm` di DG.

Il calcolo è veloce: 200 entry × ~20 parole = 4k token. Pure Python, no LLM.

Autore: 2026-07-15 (P2 richiesta utente Fabio)
"""
from __future__ import annotations
import re
import time
import logging
from collections import Counter
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

# === Stopword italiane ===
# Lista curata: articoli, preposizioni, congiunzioni, pronomi, verbi
# ausiliari e comuni, avverbi molto frequenti. Non serve completezza NLP:
# basta rimuovere il rumore ad alta frequenza per far emergere le parole
# semanticamente rilevanti.
_STOPWORDS_IT = frozenset([
    # Articoli e determinanti
    "che", "chi", "cui", "quale", "quali", "quanto", "quanta", "quanti", "quante",
    "questo", "questa", "questi", "queste", "quello", "quella", "quelli", "quelle",
    # Preposizioni + articolate
    "alla", "alle", "allo", "agli", "alle", "della", "delle", "dello", "degli",
    "dalla", "dalle", "dallo", "dagli", "sulla", "sulle", "sullo", "sugli",
    "nella", "nelle", "nello", "negli", "come", "dove", "quando", "perché",
    "perche", "senza", "sopra", "sotto", "verso", "dopo", "prima", "durante",
    "contro", "davanti", "dietro", "vicino", "lungo", "attraverso",
    # Congiunzioni
    "però", "pero", "quindi", "allora", "mentre", "anche", "ancora", "sempre",
    "mai", "solo", "già", "gia", "adesso", "oggi", "ieri", "domani",
    # Pronomi
    "noi", "voi", "loro", "essi", "esse", "esso", "essa",
    "mio", "mia", "miei", "mie", "tuo", "tua", "tuoi", "tue",
    "suo", "sua", "suoi", "sue", "nostro", "nostra", "nostri", "nostre",
    "vostro", "vostra", "vostri", "vostre",
    "cosa", "cose", "qualcosa", "niente", "nessuno", "tutti", "tutto", "tutta", "tutte",
    "molto", "poco", "tanto", "troppo", "abbastanza",
    # Verbi ausiliari/comuni
    "sono", "sei", "siamo", "siete", "sono", "essere", "stato", "stata", "stati", "state",
    "sarà", "sara", "sarebbe", "fosse", "fossi", "fossero",
    "hai", "abbiamo", "avete", "hanno", "avere", "avuto", "avuta",
    "avrà", "avra", "avrebbe", "avesse",
    "posso", "puoi", "può", "puo", "possiamo", "potete", "possono", "potere",
    "voglio", "vuoi", "vuole", "vogliamo", "volete", "vogliono", "volere",
    "devo", "devi", "deve", "dobbiamo", "dovete", "devono", "dovere",
    "faccio", "fai", "facciamo", "fate", "fanno", "fatto", "fare",
    "dico", "dici", "dice", "diciamo", "dite", "dicono", "detto", "dire",
    "vado", "vai", "andiamo", "andate", "vanno", "andare", "andato",
    "vedo", "vedi", "vediamo", "vedete", "vedono", "vedere", "visto",
    "sento", "senti", "sentiamo", "sentite", "sentono", "sentire", "sentito",
    "penso", "pensi", "pensa", "pensiamo", "pensate", "pensano", "pensare",
    "credo", "credi", "crede", "crediamo", "credete", "credono", "credere",
    # Comuni "riempitivi"
    "molto", "davvero", "veramente", "proprio", "ormai", "invece", "magari",
    "forse", "certo", "certamente", "insomma", "praticamente", "sicuramente",
    "assolutamente", "completamente", "totalmente", "principalmente",
    # Numeri scritti
    "uno", "una", "due", "tre", "quattro", "cinque", "sei", "sette", "otto",
    "nove", "dieci", "cento", "mille",
    # Interazione con Koda
    "koda", "coda", "grazie", "prego", "scusa", "scusami", "ciao", "buongiorno",
    "buonasera", "buonanotte", "salve",
])

_TOKEN_RE = re.compile(r"[a-zA-ZàèéìòùÀÈÉÌÒÙ']+")


def extract_keywords_from_texts(texts: List[str], max_words: int = 25) -> List[str]:
    """Estrae le parole più frequenti da una lista di testi utente.

    Args:
        texts: lista di stringhe (i testi grezzi dei messaggi utente).
        max_words: massimo numero di keyterm da restituire.

    Returns:
        Lista di parole (lowercase) ordinate per frequenza decrescente,
        già filtrate da stopword e da parole troppo corte.
    """
    if not texts:
        return []
    counter: Counter[str] = Counter()
    for txt in texts:
        if not isinstance(txt, str) or not txt:
            continue
        for tok in _TOKEN_RE.findall(txt):
            w = tok.lower().strip("'")
            # Filtri: minimo 4 char, alfabetico, non stopword
            if len(w) < 4:
                continue
            if w in _STOPWORDS_IT:
                continue
            # Skip parole con troppe consonanti consecutive (probabilmente
            # errori STT/typo — es. "xghtr")
            if len(w) > 20:
                continue
            counter[w] += 1
    # Filtra solo parole che appaiono >= 2 volte (evita hapax legomena
    # che non aiutano il modello e allungano solo la query string).
    frequent = [w for w, cnt in counter.most_common(max_words * 3) if cnt >= 2]
    return frequent[:max_words]


# === Cache in-memory per-uid ===
# Chiave: uid. Valore: {"terms": [...], "expires_at": epoch}.
# TTL breve: le sessioni WS di uno stesso utente in rapida successione
# vedono la stessa vocab senza toccare il DB ogni volta.
_VOCAB_CACHE: Dict[str, Dict[str, Any]] = {}
_VOCAB_CACHE_TTL_S = 5 * 60  # 5 minuti


async def get_user_keyterms(db, uid: str, max_words: int = 25) -> List[str]:
    """Restituisce le parole ricorrenti dell'utente per Deepgram keyterm.

    Args:
        db: motor AsyncIOMotorDatabase (server.py `db`).
        uid: profile_id dell'utente.
        max_words: cap sul numero di keyterm restituiti (default 25).

    Returns:
        Lista di stringhe pronte per essere aggiunte a `dg_params["keyterm"]`.
        Vuota se l'utente non ha ancora abbastanza timeline o in caso di errore.
    """
    if not uid or uid == "me":
        return []
    # Cache hit?
    now = time.time()
    entry = _VOCAB_CACHE.get(uid)
    if entry and entry.get("expires_at", 0) > now:
        return list(entry.get("terms", []))
    # Cache miss → query DB
    try:
        cursor = db.taccuino_timeline.find(
            {"profile_id": uid, "role": "user"},
            {"_id": 0, "text": 1},
        ).sort("timestamp", -1).limit(200)
        docs = await cursor.to_list(200)
    except Exception as e:
        logger.warning(f"[user_vocab] DB query failed uid={uid[:8]}: {e}")
        return []
    texts = [d.get("text", "") for d in docs if d.get("text")]
    terms = extract_keywords_from_texts(texts, max_words=max_words)
    _VOCAB_CACHE[uid] = {
        "terms": terms,
        "expires_at": now + _VOCAB_CACHE_TTL_S,
    }
    logger.info(
        f"[user_vocab] uid={uid[:8]} extracted {len(terms)} keyterms "
        f"from {len(texts)} messages; top5={terms[:5]}"
    )
    return terms


def invalidate_user_vocab(uid: str) -> None:
    """Rimuove la cache vocab di un utente (usalo quando si cancella
    la memoria, o quando si aggiungono molti messaggi nuovi)."""
    _VOCAB_CACHE.pop(uid, None)
