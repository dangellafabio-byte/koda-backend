"""TTS Intensity Classifier v0 (Fabio 2026-08-14).

Sceglie tra ElevenLabs V3 (baseline espressiva, TTFA ~500-650ms) e
Turbo v2.5 (candidato veloce, TTFA ~250ms) sulla base del testo che
Koda ha appena prodotto — senza modifiche al prompt e senza LLM in
cascata. Solo regole leggere basate sui segnali già presenti (tone,
MODE §9, marker linguistici).

Design:
    - Funzione PURA: nessun side effect, nessuna I/O, nessun logging
      interno (il caller logga la decisione con contesto session_id).
    - Zero dipendenze esterne (solo `re` e `typing`).
    - Costo runtime target: <1ms per turno.
    - Traffic split misurato offline su 716 turni reali: 16.7% V3,
      83.3% Turbo. Anti-regression 100% sui casi ovvi.

Riferimento: vedi /tmp/koda_intensity/classifier_v0.py per lo script
di analisi offline che ha calibrato le regole. Il classificatore qui
è quella logica portata in modulo produzione, con feature flag
`KODA_TTS_CLASSIFIER_ENABLED` (default OFF) — verifica offline
completata e approvata da Fabio (verdetto zona grigia: Turbo va
bene anche per warm+lungo+filosofico, V3 riservato ai momenti di
vera necessità empatica).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# ---------------------------- Regex compilate --------------------------------
# (Estratte dal notebook offline /tmp/koda_intensity/classifier_v0.py)
_RE_TAG = re.compile(r"\[[a-z][a-z ]{1,30}\]", re.I)

# SALIRE (§9.2): imperativi che rallentano — "aspetta", "fermati", "respira".
_RE_SALIRE = re.compile(
    r"\b(aspett[ai]|ferm[ai]t[ei]|respira(?:re)?|piano piano|con calma|"
    r"prenditi il tempo|non è un vabbè|stacca il telefono|prendi(?:ti)? aria)\b",
    re.I,
)

# TENERE IL PUNTO (§9.4): validazione ferma esplicita.
_RE_TENERE = re.compile(
    r"\b(hai ragione (?:a|di|ad)|è (?:normal[ei]|legittim[oi]|dur[oa] cos[iì])|"
    r"è (?:proprio )?normal[ei] che|ti capisco (?:benissimo|davvero))\b",
    re.I,
)

# SDRAMMATIZZARE (§9.3): leggerezza umana con prospettiva.
_RE_SDRAMM = re.compile(
    r"\b(dai(?: vediamo| forza)?|proviamo|almeno il|almeno un|"
    r"anche al |anche solo il|magari (?:un|una)|un attimo di)\b",
    re.I,
)

# ADMIT_FAULT: humility esplicita, ammissione errore di Koda.
_RE_ADMIT = re.compile(
    r"\b(mi (?:spiace|dispiace) (?:davvero|molto|tanto|Fabio|Marco)|"
    r"ho sbagliat[oa]|è stata una mia|una mia cazzata|"
    r"scusa (?:davvero|Fabio|Marco|tanto)|"
    r"mi sono incartata|non voglio prometter|non riesco a farl[oa])\b",
    re.I,
)

# INFORM: risposta didattica/informativa (spiegazioni, elenchi, definizioni).
_RE_INFORM = re.compile(
    r"\b(quindi|allora,|significa|vuol dire|in pratica|il modo è|"
    r"la differenza|prima cos[ai]|dovresti|puoi (?:usare|fare|provare))\b",
    re.I,
)

# Safety / urgent (§17 TONE:urgent).
_RE_URGENT_NUM = re.compile(r"\b(1522|112|118|113|telefono azzurro)\b")

# Aperture stereotipate corte (chiacchiera piatta).
_RE_GREETING = re.compile(
    r"^(ciao|ehi|salve|buon(?:giorno|asera)|hey|bene(?:,)? grazie|"
    r"sto bene|sì(?:,)? ti sento|certo(?:,)? dimmi|ok(?:,)?)\b",
    re.I,
)

# Marker di gioia/entusiasmo autentico.
_RE_JOY = re.compile(
    r"\b(che bell[oa]|che figata|meraviglios|fantastic|grande!|bravissim|"
    r"che dolcezza|sono felice|mi fa piacere|contentissim)\b",
    re.I,
)

# Marker parolacce empatiche o auto-critiche (rabbia validata).
_RE_SWEAR_EMPATH = re.compile(r"\b(cazzat[ae]|merda|schifo|palle|casino)\b", re.I)

_RE_WORD = re.compile(r"\b[\wàèéìòùÀÈÉÌÒÙ']+\b", re.U)


# ------------------------ Modello dati risultato -----------------------------
V3_MODEL_ID = "eleven_v3"
TURBO_MODEL_ID = "eleven_turbo_v2_5"

# MODE §9 esteso (SPECCHIO = default).
MODE_SALIRE = "SALIRE"
MODE_TENERE = "TENERE"
MODE_ADMIT = "ADMIT_FAULT"
MODE_SDRAMM = "SDRAMM"
MODE_INFORM = "INFORM"
MODE_SPECCHIO = "SPECCHIO"

_MODES_FORCE_V3 = frozenset({MODE_SALIRE, MODE_TENERE, MODE_ADMIT})


@dataclass(frozen=True)
class ClassifierDecision:
    """Risultato della classificazione — piccolo, immutabile, log-friendly."""
    model_id: str            # "eleven_v3" o "eleven_turbo_v2_5"
    mode: str                # SPECCHIO / SALIRE / TENERE / ADMIT_FAULT / SDRAMM / INFORM
    intensity: int           # 0..4
    reason: str              # motivo sintetico ("mode_high"/"intensity>=3"/…)
    use_v3: bool             # True se model_id == V3_MODEL_ID
    n_words: int             # per telemetria


# ---------------------------- Detector interni -------------------------------
def _clean(text: str) -> str:
    """Rimuove i [tag] audio ma lascia il resto intatto."""
    return _RE_TAG.sub("", text or "").strip()


def _detect_mode(text: str, tone: Optional[str]) -> str:
    """
    Rileva la modalità §9 estesa. Ordine priorità (esclusivo):
      SALIRE > ADMIT_FAULT > TENERE > SDRAMM > INFORM > SPECCHIO.
    """
    if _RE_URGENT_NUM.search(text):
        return MODE_SALIRE  # safety = SALIRE al massimo
    if _RE_SALIRE.search(text):
        return MODE_SALIRE
    if _RE_ADMIT.search(text):
        return MODE_ADMIT
    if _RE_TENERE.search(text) and tone in {"concerned", "warm"}:
        return MODE_TENERE
    if (
        _RE_SDRAMM.search(text)
        and tone in {"warm", "calm"}
        and "?" in text
    ):
        return MODE_SDRAMM
    n_words = len(_RE_WORD.findall(text))
    if _RE_INFORM.search(text) and tone == "neutral" and n_words >= 25:
        return MODE_INFORM
    return MODE_SPECCHIO


def _detect_intensity(text: str, tone: Optional[str], mode: str) -> int:
    """
    Intensity 0..4 (definizione operativa concordata con Fabio 2026-08-14):
      0 = informativo/tech puro (ack, meteo, calc)
      1 = chiacchiera leggera (saluti, small talk)
      2 = presenza affettiva normale (default warm)
      3 = momento denso (humility, gioia forte, dolore accennato)
      4 = crisi/urgenza (safety, spirale, rabbia)
    """
    n_words = len(_RE_WORD.findall(text))
    has_greet = bool(_RE_GREETING.search(text.lstrip()))
    has_joy = bool(_RE_JOY.search(text))
    has_urgent = bool(_RE_URGENT_NUM.search(text))

    # 4: crisi/urgenza
    if has_urgent:
        return 4
    if mode == MODE_SALIRE and tone == "concerned":
        return 4
    if mode == MODE_SALIRE:
        return 3

    # 3: momento denso
    if mode in {MODE_TENERE, MODE_ADMIT}:
        return 3
    if tone == "concerned":
        return 3
    if has_joy and n_words >= 10:
        return 3

    # 0-1: ack/greeting/tech
    if tone == "neutral" and n_words < 12:
        return 0
    if has_greet and n_words < 15:
        return 1
    if mode == MODE_INFORM:
        return 1  # spiegazioni tecniche = bassa intensità emotiva
    if tone == "neutral":
        return 1  # neutral lungo = spiegazione, bassa intensità

    # 2: default warm normale (SPECCHIO/SDRAMM neutre)
    return 2


# ---------------------------- API pubblica -----------------------------------
def classify(text: str, tone: Optional[str]) -> ClassifierDecision:
    """
    Classifica un testo Koda e sceglie il modello TTS.

    Args:
        text:  Il testo della risposta (o del chunk 0 aggressive) — può
               contenere audio tags [warmly] ecc., verranno strippati.
        tone:  Il tone estratto dal reply prefix [TONE:xxx] o dal JSON
               structured output. Uno di:
                   warm | neutral | concerned | calm | energetic | urgent
               Può essere None se non ancora determinato (es. bootstrap
               al primissimo chunk prima che il tag sia stato letto).

    Returns:
        ClassifierDecision con model_id già pronto per essere passato a
        `client.text_to_speech.convert_as_stream(model_id=...)`.

    Regola V3:
        USE V3 se:  MODE ∈ {SALIRE, TENERE, ADMIT_FAULT}
                 OR INTENSITY ≥ 3
                 OR tone == concerned
                 OR contiene numeri di emergenza (1522/112/118)
        USE Turbo altrimenti.

    Safe default:
        - Se `text` vuoto o < 3 parole → V3 (safe, non guadagniamo nulla
          da Turbo su testi minuscoli e la decisione è troppo poco
          informata per essere affidabile).
        - Se `tone` None → V3 (safe: aspetta di avere il tag prima di
          risparmiare latenza).
    """
    clean = _clean(text)
    n_words = len(_RE_WORD.findall(clean))
    tone_norm = (tone or "").lower() or None

    # Safe fallback: troppo poco per decidere → V3 (comportamento attuale)
    if n_words < 3 or tone_norm is None:
        return ClassifierDecision(
            model_id=V3_MODEL_ID,
            mode=MODE_SPECCHIO,
            intensity=2,
            reason="insufficient_signal",
            use_v3=True,
            n_words=n_words,
        )

    mode = _detect_mode(clean, tone_norm)
    intensity = _detect_intensity(clean, tone_norm, mode)

    # Regola binaria V3 vs Turbo
    if mode in _MODES_FORCE_V3:
        return ClassifierDecision(
            model_id=V3_MODEL_ID, mode=mode, intensity=intensity,
            reason="mode_high", use_v3=True, n_words=n_words,
        )
    if intensity >= 3:
        return ClassifierDecision(
            model_id=V3_MODEL_ID, mode=mode, intensity=intensity,
            reason="intensity_ge_3", use_v3=True, n_words=n_words,
        )
    if tone_norm == "concerned":
        return ClassifierDecision(
            model_id=V3_MODEL_ID, mode=mode, intensity=intensity,
            reason="tone_concerned", use_v3=True, n_words=n_words,
        )
    if _RE_URGENT_NUM.search(clean):
        return ClassifierDecision(
            model_id=V3_MODEL_ID, mode=mode, intensity=intensity,
            reason="safety_nums", use_v3=True, n_words=n_words,
        )

    # Default: risparmio latenza con Turbo
    return ClassifierDecision(
        model_id=TURBO_MODEL_ID, mode=mode, intensity=intensity,
        reason="default_turbo", use_v3=False, n_words=n_words,
    )
