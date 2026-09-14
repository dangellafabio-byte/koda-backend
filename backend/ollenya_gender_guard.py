"""koda_gender_guard.py — Post-processor safety-net gender (Fabio 2026-06).

Contesto: il prompt istruisce Claude Haiku 4.5 a declinare al femminile
o maschile in base ad `ai_gender`. Ma Haiku, su prompt lunghi (~4KB), è
noto per scivolare al maschile generico ("sono contento" invece di
"sono contenta"), anche con le regole ripetute in fondo al prompt.

Questo modulo è l'ULTIMA linea di difesa: dopo che Claude ha generato la
risposta, scansiona il testo e corregge SOLO gli aggettivi/participi
che Ollenya usa SU SE STESSA (`sono contento` → `sono contenta` se
ai_gender="f"). Non tocca gli aggettivi rivolti all'utente (quelli
dipendono da `user_gender` e sono più difficili da inferire senza
contesto sintattico completo).

Design:
    - Funzione PURA: input testo + ai_gender → output testo corretto.
    - Zero I/O, <1ms per turno.
    - Regex compilate una volta al load.
    - Log un WARNING se corregge (così vediamo la frequenza reale del bias).

Pattern selezionati (Fabio 2026-06):
    Prime persone singolari CHE CLAUDE USA PER PARLARE DI SE STESSA:
    - "sono X" (contento, pronto, stanco, sicuro, tranquillo, felice, ...)
    - "mi sento X" (pronto, sicuro, ...)
    - "sono stato/stata"
    - "mi sono X-ato/ata"
    - "ho fatto una X" (non nel form, ma "sono riuscito/a")
    - "non sono X"

    NON tocchiamo (troppo rischio falsi positivi):
    - "sei X" (l'utente — dipende da user_gender)
    - "eri X" (l'utente)
    - forme senza soggetto ambiguo ("è bello" resta invariato)
"""
from __future__ import annotations
import re
import logging
from typing import Tuple

logger = logging.getLogger(__name__)

# ============================================================
# Mappa correzioni: femminile → maschile e viceversa
# Ogni voce è (regex-pattern, replacement-if-f, replacement-if-m)
# ============================================================

# Aggettivi/participi che DI SICURO si riferiscono a Ollenya quando preceduti
# da "sono ", "mi sento ", "non sono ", "mi sono ", "sarei ", "eccomi qua sono ".
# Ordine: forma maschile → femminile e viceversa.
#
# Copertura basata sugli esempi del prompt (line 2556-2571):
#   contento, curioso, pronto, sicuro, tranquillo, stato, sentito, riuscito,
#   felice (non ha forma di genere → escluso), stanco, sereno.
#
# NB: usiamo lookbehind per garantire che si tratti di Ollenya che parla di sé.
_SELF_CONTEXT_ALTERNATIVES = (
    r"sono",              # "sono X"
    r"mi\s+sento",        # "mi sento X"
    r"non\s+sono",        # "non sono X"
    r"sarei",             # "sarei X"
    r"mi\s+sono",         # "mi sono X-ato/a"
    r"eccomi\s+qua\s+sono",  # rara ma nel prompt
)

# Coppie MASCHILE ↔ FEMMINILE per aggettivi/participi che Ollenya usa su sé
# stessa. Ogni tupla: (masc, fem).
_SELF_ADJ_PAIRS = [
    ("contento", "contenta"),
    ("curioso", "curiosa"),
    ("pronto", "pronta"),
    ("sicuro", "sicura"),
    ("tranquillo", "tranquilla"),
    ("stanco", "stanca"),
    ("sereno", "serena"),
    ("stato", "stata"),
    ("sentito", "sentita"),
    ("riuscito", "riuscita"),
    ("preoccupato", "preoccupata"),
    ("contentissimo", "contentissima"),
    ("felicissimo", "felicissima"),
    ("emozionato", "emozionata"),
    ("commosso", "commossa"),
    ("colpito", "colpita"),
    ("sorpreso", "sorpresa"),
    ("dispiaciuto", "dispiaciuta"),
    ("fiero", "fiera"),
    ("orgoglioso", "orgogliosa"),
    ("documentato", "documentata"),
    ("preparato", "preparata"),
    ("informato", "informata"),
    ("focalizzato", "focalizzata"),
    ("concentrato", "concentrata"),
    ("attento", "attenta"),
    ("attivo", "attiva"),
    ("presente", "presente"),  # invariato — safe
    ("interessato", "interessata"),
    ("coinvolto", "coinvolta"),
    ("grato", "grata"),
    ("distratto", "distratta"),
    ("nato", "nata"),
    ("cresciuto", "cresciuta"),
    ("progettato", "progettata"),
    ("costruito", "costruita"),
    ("addestrato", "addestrata"),
    ("programmato", "programmata"),
]


def _build_regex(words: Tuple[str, ...]) -> re.Pattern:
    """Compila regex che matcha `SELF_CONTEXT WORD` in un'unica alternanza,
    catturando SEPARATAMENTE il contesto (group 1) e la parola target
    (group 2), così possiamo sostituire solo la seconda mantenendo la prima.

    Case-insensitive. Il match include gli spazi tra context e word.
    """
    context_alt = "|".join(_SELF_CONTEXT_ALTERNATIVES)
    word_alt = "|".join(re.escape(w) for w in words)
    # group 1 = context (es. "sono", "mi sento"), group 2 = parola target
    pattern = rf"\b({context_alt})(\s+)({word_alt})\b"
    return re.compile(pattern, re.IGNORECASE)


_MASC_WORDS = tuple(m for m, _ in _SELF_ADJ_PAIRS)
_FEM_WORDS = tuple(f for _, f in _SELF_ADJ_PAIRS)

_RE_MASC_SELF = _build_regex(_MASC_WORDS)
_RE_FEM_SELF = _build_regex(_FEM_WORDS)

# Mappa lookup (case-insensitive) per la sostituzione word→word opposto.
_MASC_TO_FEM = {m.lower(): f for m, f in _SELF_ADJ_PAIRS}
_FEM_TO_MASC = {f.lower(): m for m, f in _SELF_ADJ_PAIRS}


def _preserve_case(original: str, replacement: str) -> str:
    """Mantiene capitalizzazione dell'originale sul replacement.
    'Pronto' → 'Pronta', 'PRONTO' → 'PRONTA', 'pronto' → 'pronta'.
    """
    if not original:
        return replacement
    if original.isupper():
        return replacement.upper()
    if original[0].isupper():
        return replacement.capitalize()
    return replacement


def fix_ai_gender(text: str, ai_gender: str) -> Tuple[str, int]:
    """Corregge il genere degli aggettivi che Ollenya usa su se stessa.

    Args:
        text: risposta di Ollenya (post-stripping audio tags).
        ai_gender: "f" | "m" | "n" (neutro → no-op).

    Returns:
        (corrected_text, n_corrections). n_corrections = quante parole
        sono state cambiate. Utile per telemetria.

    Esempi:
        fix_ai_gender("Ciao, sono contento di sentirti", "f")
          → ("Ciao, sono contenta di sentirti", 1)
        fix_ai_gender("Sono pronta, mi sento sicura", "m")
          → ("Sono pronto, mi sento sicuro", 2)
        fix_ai_gender("Sei stanco?", "f") → ("Sei stanco?", 0)  # utente, no touch
    """
    if not text or not isinstance(text, str):
        return text, 0
    g = (ai_gender or "").lower().strip()
    if g not in ("f", "m"):
        return text, 0  # neutro/undefined → no-op

    n = 0
    if g == "f":
        # Correggi maschile → femminile
        def _repl_m(m: re.Match) -> str:
            nonlocal n
            ctx, sp, word = m.group(1), m.group(2), m.group(3)
            fem = _MASC_TO_FEM.get(word.lower())
            if fem is None:
                return m.group(0)
            n += 1
            return f"{ctx}{sp}{_preserve_case(word, fem)}"
        text = _RE_MASC_SELF.sub(_repl_m, text)
    else:  # g == "m"
        # Correggi femminile → maschile
        def _repl_f(m: re.Match) -> str:
            nonlocal n
            ctx, sp, word = m.group(1), m.group(2), m.group(3)
            masc = _FEM_TO_MASC.get(word.lower())
            if masc is None:
                return m.group(0)
            n += 1
            return f"{ctx}{sp}{_preserve_case(word, masc)}"
        text = _RE_FEM_SELF.sub(_repl_f, text)

    if n > 0:
        logger.warning(
            f"[gender_guard] corrected {n} word(s) to ai_gender={g!r}"
        )
    return text, n
