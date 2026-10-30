"""ollenya_gender_guard.py — Post-processor safety-net gender (Fabio 2026-11-04).

Contesto: il prompt istruisce Claude Haiku 5.5 a declinare al femminile/maschile
in base ad `ai_gender`. Haiku su prompt lunghi è noto scivolare al maschile
generico ("sono contento" invece di "sono contenta"), anche con le regole
ribadite in fondo. Questo modulo è l'ULTIMA linea di difesa.

Regola fondamentale: tocchiamo SOLO forme auto-riferite di Ollenya. NON
tocchiamo:
  1. Citazioni dirette fra virgolette:  "..."   «...»   “...”   ‘...’   ‹...›
     (NOTA: l'apostrofo dritto `'` NON è trattato come quote perché in
      italiano è anche elisione — "l'ho detto", "dell'anno" — e usarlo come
      quote produrrebbe falsi positivi devastanti.)
  2. Discorso riportato dopo verba dicendi: "ha detto / disse / mi dice /
     chiese / ha scritto / afferma / sostiene / racconta / sussurra …".
     Dopo il verbum dicendi, la clausola successiva fino al primo delimitatore
     terminale (. ? ! ; newline o chiusura virgoletta) è PROTETTA.
  3. Aggettivi rivolti all'utente ("sei stanco?") — il contesto trigger
     richiede "sono / mi sento / non sono / sarei / mi sono / eccomi qua sono",
     che non matcha "sei".

CAVEAT (documentato nei test): la funzione analizza TESTO COMPLETO. Chiamarla
su chunk parziali di una citazione (es. 'Marco ha detto: "sono stan' + 'co"')
può produrre falsi positivi perché la virgoletta di chiusura non è ancora nel
buffer. Il fast pipeline di Ollenya applica il guard SOLO a FRASI COMPLETE
estratte da `_pop_first_sentence`, quindi la citazione è sempre intera. Il
test `test_citazione_spezzata_tra_chunk` dimostra la limitazione per
trasparenza.

Design:
    - Funzione PURA: input testo + ai_gender → output testo corretto + n_fix.
    - Zero I/O, <1ms per turno su testi normali.
    - Regex compilate una volta al load.
    - Log WARNING sulle correzioni effettive (telemetria frequenza bias).
"""
from __future__ import annotations
import re
import logging
from typing import Tuple, List

logger = logging.getLogger(__name__)


# ============================================================
# 1. CONTESTO AUTO-RIFERITO: trigger lessicali che fanno sì che
#    la parola successiva sia un aggettivo di Ollenya.
# ============================================================
_SELF_CONTEXT_ALTERNATIVES = (
    r"sono",
    r"mi\s+sento",
    r"non\s+sono",
    r"sarei",
    r"mi\s+sono",
    r"eccomi\s+qua\s+sono",
)

# ============================================================
# 2. COPPIE MASC ↔ FEM — aggettivi/participi usati su se stessa.
# ============================================================
_SELF_ADJ_PAIRS = [
    ("contento", "contenta"), ("curioso", "curiosa"),
    ("pronto", "pronta"), ("sicuro", "sicura"),
    ("tranquillo", "tranquilla"), ("stanco", "stanca"),
    ("sereno", "serena"), ("stato", "stata"),
    ("sentito", "sentita"), ("riuscito", "riuscita"),
    ("preoccupato", "preoccupata"), ("contentissimo", "contentissima"),
    ("felicissimo", "felicissima"), ("emozionato", "emozionata"),
    ("commosso", "commossa"), ("colpito", "colpita"),
    ("sorpreso", "sorpresa"), ("dispiaciuto", "dispiaciuta"),
    ("fiero", "fiera"), ("orgoglioso", "orgogliosa"),
    ("documentato", "documentata"), ("preparato", "preparata"),
    ("informato", "informata"), ("focalizzato", "focalizzata"),
    ("concentrato", "concentrata"), ("attento", "attenta"),
    ("attivo", "attiva"), ("interessato", "interessata"),
    ("coinvolto", "coinvolta"), ("grato", "grata"),
    ("distratto", "distratta"), ("nato", "nata"),
    ("cresciuto", "cresciuta"), ("progettato", "progettata"),
    ("costruito", "costruita"), ("addestrato", "addestrata"),
    ("programmato", "programmata"),
]


def _build_regex(words: Tuple[str, ...]) -> re.Pattern:
    context_alt = "|".join(_SELF_CONTEXT_ALTERNATIVES)
    word_alt = "|".join(re.escape(w) for w in words)
    pattern = rf"\b({context_alt})(\s+)({word_alt})\b"
    return re.compile(pattern, re.IGNORECASE)


_MASC_WORDS = tuple(m for m, _ in _SELF_ADJ_PAIRS)
_FEM_WORDS = tuple(f for _, f in _SELF_ADJ_PAIRS)

_RE_MASC_SELF = _build_regex(_MASC_WORDS)
_RE_FEM_SELF = _build_regex(_FEM_WORDS)

_MASC_TO_FEM = {m.lower(): f for m, f in _SELF_ADJ_PAIRS}
_FEM_TO_MASC = {f.lower(): m for m, f in _SELF_ADJ_PAIRS}


# ============================================================
# 3. PROTEZIONE CITAZIONI + REPORTED SPEECH
# ============================================================
# Coppie di virgolette: carattere apertura → carattere chiusura.
# NON includiamo "'" (U+0027 apostrofo dritto) perché in italiano è
# ANCHE elisione — causerebbe falsi positivi su "l'ho detto" ecc.
_QUOTE_PAIRS = {
    '"': '"',           # ASCII dritte (apertura = chiusura)
    '«': '»',           # guillemets angolari
    '\u201C': '\u201D', # “ ” curly double
    '\u2018': '\u2019', # ‘ ’ curly single
    '\u2039': '\u203A', # ‹ › single guillemets
}
_OPENERS = set(_QUOTE_PAIRS.keys())
_CLOSERS = {v: k for k, v in _QUOTE_PAIRS.items() if v != k}

# Verba dicendi italiani. Dopo questi verbi, la clausola successiva è
# PROTETTA (è parlato altrui, non di Ollenya).
_REPORTED_CUE_RE = re.compile(
    r"\b("
    r"(?:ha|hanno|aveva|avevano|avrà|avranno|avrebbe|avrebbero|abbia|avesse)\s+"
    r"(?:detto|chiesto|scritto|urlato|gridato|risposto|pensato|confessato|"
    r"ammesso|replicato|mormorato|sussurrato|aggiunto|precisato|ribadito|"
    r"commentato|obiettato|protestato|promesso|giurato|annunciato|dichiarato)"
    r"|"
    r"(?:disse|chiese|rispose|urlò|gridò|scrisse|pensò|confessò|ammise|"
    r"replicò|mormorò|sussurrò|aggiunse|precisò|ribadì|commentò|obiettò|"
    r"protestò|promise|giurò|annunciò|dichiarò)"
    r"|"
    r"mi\s+(?:ha|hanno|aveva)\s+(?:detto|chiesto|scritto|confessato|promesso|giurato)"
    r"|"
    r"(?:dice|dicono|afferma|affermano|sostiene|sostengono|racconta|raccontano|"
    r"sussurra|sussurrano|mormora|mormorano|urla|urlano|grida|gridano|"
    r"risponde|rispondono|chiede|chiedono|scrive|scrivono)"
    r")\b",
    re.IGNORECASE,
)

# Delimitatori di fine-clausola dopo cue reportato. Includono anche le
# CHIUSURE di virgolette: se una cue è "Marco ha detto:" seguita da una
# citazione aperta, la clausola reportata termina quando la citazione si
# chiude — altrimenti qualsiasi "sono contento" FUORI dalla quote dopo la
# cue verrebbe erroneamente protetto fino al punto finale.
_CLAUSE_END_CHARS = set(".?!;\n\r") | set(_CLOSERS.keys()) | {'"'}


def _find_quoted_spans(text: str) -> List[Tuple[int, int]]:
    """Ritorna lista di (start, end) [exclusive end] delle regioni dentro
    virgolette BILANCIATE. Se una virgoletta aperta non viene chiusa,
    protegge dalla posizione di apertura fino alla fine del testo
    (comportamento conservativo: non toccare testo in uno stato ambiguo).
    """
    spans: List[Tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in _OPENERS:
            # Trova chiusura. Se è una ASCII " (apertura = chiusura),
            # consideriamo "la prossima " dopo questa" come chiusura.
            close_char = _QUOTE_PAIRS[ch]
            # Caso apertura == chiusura (ASCII "): la prossima " uguale.
            start = i
            j = i + 1
            while j < n and text[j] != close_char:
                j += 1
            if j < n:
                # trovata chiusura
                spans.append((start, j + 1))
                i = j + 1
                continue
            else:
                # non chiusa → protegge fino a fine testo
                spans.append((start, n))
                break
        i += 1
    return spans


def _find_reported_spans(text: str) -> List[Tuple[int, int]]:
    """Dopo ogni verbum dicendi, protegge la clausola successiva fino al
    prossimo delimitatore terminale o fine testo. Es:
      'Marco ha detto che sono stanco. Poi se ne è andato.'
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
         (cue '...ha detto' seguita da clausola fino a '.')
    """
    spans: List[Tuple[int, int]] = []
    n = len(text)
    for m in _REPORTED_CUE_RE.finditer(text):
        clause_start = m.end()
        j = clause_start
        while j < n and text[j] not in _CLAUSE_END_CHARS:
            j += 1
        spans.append((clause_start, j))
    return spans


def _merge_spans(spans: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not spans:
        return []
    spans = sorted(spans)
    merged = [list(spans[0])]
    for a, b in spans[1:]:
        if a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def _is_protected(pos: int, spans: List[Tuple[int, int]]) -> bool:
    for a, b in spans:
        if a <= pos < b:
            return True
    return False


def _build_protected_spans(text: str) -> List[Tuple[int, int]]:
    """Unisce quoted + reported in lista di span protetti ordinati."""
    return _merge_spans(_find_quoted_spans(text) + _find_reported_spans(text))


# ============================================================
# 4. SOSTITUZIONE CON PROTEZIONE
# ============================================================
def _preserve_case(original: str, replacement: str) -> str:
    if not original:
        return replacement
    if original.isupper():
        return replacement.upper()
    if original[0].isupper():
        return replacement.capitalize()
    return replacement


def fix_ai_gender(text: str, ai_gender: str) -> Tuple[str, int]:
    """Corregge il genere degli aggettivi auto-riferiti di Ollenya.

    PROTEGGE citazioni (virgolette bilanciate) e discorso riportato
    (dopo verba dicendi).

    Args:
        text: risposta/frase di Ollenya (post-stripping audio tags).
        ai_gender: "f" | "m" | "n"/altro (neutro → no-op).

    Returns:
        (corrected_text, n_corrections).
    """
    if not text or not isinstance(text, str):
        return text, 0
    g = (ai_gender or "").lower().strip()
    if g not in ("f", "m"):
        return text, 0

    protected = _build_protected_spans(text)

    if g == "f":
        regex = _RE_MASC_SELF
        mapping = _MASC_TO_FEM
    else:
        regex = _RE_FEM_SELF
        mapping = _FEM_TO_MASC

    n = 0

    def _repl(m: re.Match) -> str:
        nonlocal n
        if _is_protected(m.start(), protected):
            return m.group(0)
        ctx, sp, word = m.group(1), m.group(2), m.group(3)
        new = mapping.get(word.lower())
        if new is None:
            return m.group(0)
        n += 1
        return f"{ctx}{sp}{_preserve_case(word, new)}"

    out = regex.sub(_repl, text)
    if n > 0:
        logger.warning(f"[gender_guard] corrected {n} word(s) to ai_gender={g!r}")
    return out, n
