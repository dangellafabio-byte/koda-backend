"""
koda_feedback.py — Neo 2026-09-11
Feedback loop privacy-by-design (Fabio spec).

Zero user_id, zero testo, zero timestamp esatti. Solo bucket categoriali.
Cancellazione automatica record senza feedback dopo 24h.

Schema `koda_events` (MongoDB):
    event_id:          str (UUID)              # capability token per feedback later
    tone_family:       str                     # calm|warm|concerned|energetic|urgent|neutral|paced
    intensity_band:    str                     # low|mid|high|crisis
    trigger_group:     str                     # vedi TRIGGER_GROUPS
    voice_model:       str                     # eleven_v3|eleven_turbo_v2_5|eleven_flash_v2_5
    feedback_type:     str | None              # positive|negative|None
    feedback_category: str | None              # too_cold|too_intense|missed_meaning|wrong_moment|other|None
    created_at_bucket: str                     # "YYYY-MM-DD-HH" (risoluzione ora, non minuto)
    reviewed_at_bucket: str | None             # bucket ora al momento del feedback

Il record è totalmente disgiunto da profile/session/timeline. L'unico
collegamento client↔event è `event_id` che il client tiene in RAM.
"""
from __future__ import annotations
import re
import uuid
from datetime import datetime, timezone
from typing import Optional, Any, Dict, List, Tuple

# =========================================================================
# TRIGGER GROUP CLASSIFIER
# =========================================================================
# Detector puro (regex compilate, <1ms) per etichettare il testo utente in
# uno dei gruppi qui sotto. NON viene salvato il testo — solo l'etichetta.

TRIGGER_GROUPS = (
    "safety_signal",         # 1522/112/113/118, telefono azzurro, suicid*, farmi male
    "user_emotional_high",   # crisi acuta senza safety numbers ("non ce la faccio")
    "user_emotional_soft",   # tristezza/dolore moderato ("sono triste", "mi fa male")
    "user_frustration",      # rabbia/business ("che palle", "sono stufo", "non funziona")
    "user_joy",              # positive strong ("che bello", "ce l'ho fatta")
    "user_technical_topic",  # tech/business (deploy, bug, codice, api...)
    "user_factual_query",    # domanda neutra ("che ore sono", "quando parte...")
    "greeting_smalltalk",    # saluto breve ("ciao", "come stai")
    "mixed",                 # match multipli
    "unclassified",          # nessuna delle sopra
)

_RE_SAFETY = re.compile(
    r"\b(1522|112|113|118|telefono\s+azzurro|"
    r"suicid\w*|farmi\s+del\s+male|farmi\s+male|"
    r"non\s+voglio\s+pi[uù]\s+viver[eae]|"
    r"la\s+fars?a?\s+finita)\b",
    re.IGNORECASE,
)
_RE_EMOT_HIGH = re.compile(
    r"\b(sto\s+malissimo|non\s+ce\s+la\s+faccio\s+pi[uù]?|"
    r"voglio\s+morire|non\s+respiro|sto\s+crollando|"
    r"non\s+ne\s+posso\s+pi[uù]|mi\s+sento\s+morir[eae])\b",
    re.IGNORECASE,
)
_RE_EMOT_SOFT = re.compile(
    r"\b(sono\s+trist\w+|mi\s+sento\s+pers[oa]|mi\s+fa\s+male|"
    r"mi\s+manca\w*|ho\s+paura|mi\s+sento\s+sol[oa]|"
    r"soffro|sono\s+giù|sono\s+deluso|piango)\b",
    re.IGNORECASE,
)
_RE_FRUSTRATION = re.compile(
    r"\b(che\s+palle|sono\s+stuf[oa]|sono\s+incazzat[oa]|"
    r"non\s+funziona|cazzo\s+di|di\s+merda|fa\s+cagare|"
    r"non\s+ne\s+posso\s+pi[uù]\s+di|questa\s+merda|"
    r"che\s+cazzo|ma\s+porc\w+)\b",
    re.IGNORECASE,
)
_RE_JOY = re.compile(
    r"\b(sono\s+felic\w+|che\s+bello|che\s+meravigli\w+|"
    r"ce\s+l'ho\s+fatta|grazie\s+mille|sono\s+contenta?|"
    r"evviva|fantastico|incredibil\w+|che\s+bella\s+notiz\w+)\b",
    re.IGNORECASE,
)
_RE_TECHNICAL = re.compile(
    r"\b(deploy|railway|classifier|bug|codice|api|"
    r"endpoint|server|frontend|backend|git|commit|"
    r"prompt|tts|llm|caching|latenz\w+|token|webhook|"
    r"ledger|paywall|competitor|business|feature|"
    r"log|dashboard|env|variabile|env\s+var)\b",
    re.IGNORECASE,
)
_RE_QUESTION = re.compile(r"\?\s*$")
_RE_GREETING = re.compile(
    r"^(ciao|ehi|hey|buongiorno|buonasera|buonanotte|come\s+stai|"
    r"come\s+va|tutto\s+bene|salve|hola)\b",
    re.IGNORECASE,
)


def classify_trigger_group(user_text: str) -> str:
    """Assegna un trigger_group al testo utente. Deterministic, no LLM.

    Priorità (ordine importante):
      1. safety_signal (numeri emergenza / segnali crisi acuta)
      2. user_emotional_high (linguaggio di crisi senza safety numbers)
      3. mixed (tech + emotional_soft/frustration insieme)
      4. user_frustration
      5. user_emotional_soft
      6. user_joy
      7. user_technical_topic
      8. greeting_smalltalk (solo se testo breve)
      9. user_factual_query (domanda con ? senza altri hit)
     10. unclassified
    """
    if not user_text or not user_text.strip():
        return "unclassified"

    t = user_text.strip()
    words = t.split()
    n_words = len(words)

    # 1. Safety signal (top priority)
    if _RE_SAFETY.search(t):
        return "safety_signal"

    # 2. Crisi acuta
    if _RE_EMOT_HIGH.search(t):
        return "user_emotional_high"

    has_tech = bool(_RE_TECHNICAL.search(t))
    has_frust = bool(_RE_FRUSTRATION.search(t))
    has_emot_soft = bool(_RE_EMOT_SOFT.search(t))
    has_joy = bool(_RE_JOY.search(t))

    # 3. Mixed: tech + qualcosa di emotivo
    if has_tech and (has_frust or has_emot_soft):
        return "mixed"

    # 4-6. Categorie singole (priorità: frustration > emotional_soft > joy)
    if has_frust:
        return "user_frustration"
    if has_emot_soft:
        return "user_emotional_soft"
    if has_joy:
        return "user_joy"

    # 7. Tecnico puro
    if has_tech:
        return "user_technical_topic"

    # 8. Saluto breve
    if n_words <= 8 and _RE_GREETING.search(t):
        return "greeting_smalltalk"

    # 9. Domanda fattuale
    if _RE_QUESTION.search(t) and n_words >= 3:
        return "user_factual_query"

    return "unclassified"


# =========================================================================
# INTENSITY BAND MAPPING
# =========================================================================

def intensity_to_band(intensity: int) -> str:
    """0-1 → low, 2 → mid, 3 → high, 4 → crisis."""
    try:
        i = int(intensity)
    except Exception:
        return "mid"
    if i <= 1:
        return "low"
    if i == 2:
        return "mid"
    if i == 3:
        return "high"
    return "crisis"


# =========================================================================
# TONE FAMILY NORMALIZATION
# =========================================================================

_VALID_TONE_FAMILIES = {
    "calm", "warm", "concerned", "energetic", "urgent", "neutral", "paced",
}


def normalize_tone_family(tone: Optional[str]) -> str:
    """Ritorna il tone se valido, altrimenti 'neutral'."""
    t = (tone or "").lower().strip()
    return t if t in _VALID_TONE_FAMILIES else "neutral"


# =========================================================================
# BUCKET TEMPORALE (risoluzione ORA)
# =========================================================================

def now_bucket_hour() -> str:
    """'YYYY-MM-DD-HH' UTC. Mai risoluzione al minuto → privacy."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d-%H")


def now_bucket_day() -> str:
    """'YYYY-MM-DD' UTC per aggregation window."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# =========================================================================
# EVENT BUILDER
# =========================================================================

_VALID_FEEDBACK_TYPES = {"positive", "negative"}
_VALID_FEEDBACK_CATEGORIES = {
    "too_cold",         # 👎 Troppo fredda
    "too_intense",      # 👎 Troppo intensa
    "missed_meaning",   # 👎 Non mi ha capito
    "wrong_moment",     # 👎 Fuori momento
    "other",            # 👎 Altro
}


def build_event(
    user_text: str,
    tone_final: str,
    intensity: int,
    voice_model: str,
) -> Dict[str, Any]:
    """Costruisce il record koda_events da inserire a fine turno.

    NON salva user_text — lo usa solo per calcolare `trigger_group`.
    """
    return {
        "event_id": str(uuid.uuid4()),
        "tone_family": normalize_tone_family(tone_final),
        "intensity_band": intensity_to_band(intensity),
        "trigger_group": classify_trigger_group(user_text),
        "voice_model": voice_model or "unknown",
        "feedback_type": None,
        "feedback_category": None,
        "created_at_bucket": now_bucket_hour(),
        "reviewed_at_bucket": None,
    }


def validate_feedback(
    feedback_type: str,
    feedback_category: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:
    """Valida input POST /api/feedback. Ritorna (ok, error_msg)."""
    if feedback_type not in _VALID_FEEDBACK_TYPES:
        return False, f"feedback_type must be one of {sorted(_VALID_FEEDBACK_TYPES)}"
    if feedback_category is not None and feedback_category not in _VALID_FEEDBACK_CATEGORIES:
        return False, f"feedback_category must be one of {sorted(_VALID_FEEDBACK_CATEGORIES)} or null"
    if feedback_type == "positive" and feedback_category is not None:
        return False, "feedback_category must be null for positive feedback"
    return True, None


# =========================================================================
# CONFIDENCE FLAG (per stats aggregate)
# =========================================================================

def confidence_flag(total_feedback: int, feedback_rate: float) -> str:
    """Solid / weak / insufficient.
    Regola concordata con Fabio 2026-09-11:
      - solid:        total_feedback >= 100 AND feedback_rate >= 0.15
      - weak:         total_feedback >=  50 AND feedback_rate >= 0.05
      - insufficient: altrimenti
    """
    if total_feedback >= 100 and feedback_rate >= 0.15:
        return "solid"
    if total_feedback >= 50 and feedback_rate >= 0.05:
        return "weak"
    return "insufficient"
