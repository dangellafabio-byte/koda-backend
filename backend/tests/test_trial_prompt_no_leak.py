"""
=== TRIAL CLOSING PROMPT — Anti-leak test (2026-08-10, Fabio) ===

Test di sicurezza che blocca la build se il blocco iniettato nel system
prompt di Koda durante la fase "closing" del trial contiene ANCHE UNA SOLA
parola vietata dalla spec (numeri, prezzi, nomi piani, unità temporali,
categorie commerciali).

Se questo test fallisce dopo una modifica al codice, significa che qualcuno
ha inavvertitamente introdotto un termine che rischia di far dire a Koda
qualcosa di tecnico/commerciale nel momento più delicato dell'esperienza —
la chiusura del primo incontro.

NON RIMUOVERE parole dalla lista senza discutere con Fabio esplicitamente.
"""

import re
import sys
import pathlib

# Aggiungi backend/ al sys.path per import di server.py
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from server import TRIAL_CLOSING_PROMPT_BLOCK  # noqa: E402


# Parole/frammenti che NON devono MAI apparire nel blocco iniettato.
# La ricerca è case-insensitive, substring (quindi "minut" cattura anche
# "minuti", "minutes", "minute", ecc.).
FORBIDDEN_TOKENS = [
    # Unità temporali quantitative
    "minut",     # minuti, minuto, minutes
    "second",    # secondi, secondo, seconds
    "giorn",     # giorni, giornata
    "settiman",  # settimana, settimane
    "ora ",      # "1 ora", "2 ore" - lascia " ora " (avverbio) fuori
    "ore ",
    " ore",
    # Numeri esatti che potrebbero riferirsi al budget/finestra
    "7 ",
    "5 ",
    "15 ",
    "300",
    "420",
    # Valute e prezzi
    "€",
    "eur",       # euro, eur
    "prezz",     # prezzo, prezzi
    "0,",        # es. "0,64"
    "0.",        # es. "0.64"
    # Categorie commerciali
    "premium",
    "abbonament",  # abbonamento, abbonamenti
    "sottoscri",   # sottoscrizione, sottoscritto
    "piano ",
    " piani",
    "trial",
    "prova",
    "gratis",
    "gratuit",  # gratuito, gratuita
    "a pagament",
    "pagament",  # pagamento, pagamenti
    "offerta",
    "offer",
    # Vocabolario che promette continuità
    "torna ",
    "risenti",
    "risentir",
    "riparliamo",
    "riparliam",
    "ci sentiamo",
    "a presto",
    "domani",
    "prossima volta",
]


def test_trial_closing_prompt_has_no_forbidden_tokens():
    """Ogni token vietato NON deve apparire nel blocco iniettato nel prompt."""
    lowered = TRIAL_CLOSING_PROMPT_BLOCK.lower()
    leaked = []
    for token in FORBIDDEN_TOKENS:
        if token.lower() in lowered:
            leaked.append(token)
    assert not leaked, (
        f"TRIAL_CLOSING_PROMPT_BLOCK contiene token vietati che potrebbero "
        f"contaminare la risposta di Koda: {leaked}\n\n"
        f"Non aggiungere numeri/prezzi/nomi piani/unità temporali nel blocco. "
        f"Le direttive devono essere astratte e categoriali "
        f"(vedi spec Fabio 2026-08-10)."
    )


def test_trial_closing_prompt_has_key_directives():
    """Sanity check: il blocco deve contenere i concetti chiave della spec."""
    lowered = TRIAL_CLOSING_PROMPT_BLOCK.lower()
    required_concepts = [
        "chiusura",   # deve parlare di chiusura
        "congedo",    # deve parlare di congedo
        "naturale",   # deve enfatizzare naturalezza (non forzare)
    ]
    missing = [c for c in required_concepts if c not in lowered]
    assert not missing, (
        f"TRIAL_CLOSING_PROMPT_BLOCK ha perso concetti chiave: {missing}. "
        f"Il blocco non può essere svuotato senza discussione esplicita."
    )


def test_trial_closing_prompt_length_within_reason():
    """Il blocco non deve esplodere in dimensione (impatto latenza TTFT).
    Target: < 3000 caratteri (~750 tokens). Se supera, va reso più conciso.
    """
    n = len(TRIAL_CLOSING_PROMPT_BLOCK)
    assert n < 3000, (
        f"TRIAL_CLOSING_PROMPT_BLOCK è cresciuto a {n} char — troppo lungo, "
        f"impatta la latenza TTFT del turno di congedo. Comprimere."
    )
    assert n > 200, (
        f"TRIAL_CLOSING_PROMPT_BLOCK è {n} char — troppo corto per contenere "
        f"le direttive della spec. Probabile bug nel merge."
    )


def test_compute_trial_state_returns_only_valid_enum():
    """`_compute_trial_state` deve ritornare SEMPRE uno di:
    'active' | 'closing' | 'expired'. Nessun altro valore, mai None.
    """
    from server import _compute_trial_state, Profile
    from datetime import datetime, timezone, timedelta

    # active: budget e finestra sotto le soglie
    p_active = Profile(id="test-active", trial_seconds_used=100.0)
    assert _compute_trial_state(p_active) == "active"

    # closing: budget >= 300s, < 420s, finestra ok
    p_closing = Profile(id="test-closing", trial_seconds_used=350.0)
    assert _compute_trial_state(p_closing) == "closing"

    # expired: budget >= 420s
    p_expired = Profile(id="test-expired", trial_seconds_used=500.0)
    assert _compute_trial_state(p_expired) == "expired"

    # expired: finestra scaduta anche con budget residuo
    old_iso = (datetime.now(timezone.utc) - timedelta(days=6)).isoformat()
    p_window_expired = Profile(
        id="test-window-expired",
        trial_seconds_used=50.0,
        trial_window_started_at=old_iso,
    )
    assert _compute_trial_state(p_window_expired) == "expired"

    # active: finestra non ancora partita (onboarding non completato)
    p_no_window = Profile(id="test-no-window", trial_seconds_used=100.0, trial_window_started_at=None)
    assert _compute_trial_state(p_no_window) == "active"


def test_estimate_mp3_duration_seconds_matches_bitrate():
    """`_estimate_mp3_duration_seconds` deve restituire secondi coerenti col
    formato mp3_44100_128 (128 kbps CBR) = 16000 bytes/sec."""
    from server import _estimate_mp3_duration_seconds

    # 16000 bytes = 1 secondo
    assert abs(_estimate_mp3_duration_seconds(b"x" * 16000) - 1.0) < 0.01

    # 32000 bytes = 2 secondi
    assert abs(_estimate_mp3_duration_seconds(b"x" * 32000) - 2.0) < 0.01

    # Input vuoto o troppo piccolo = 0
    assert _estimate_mp3_duration_seconds(b"") == 0.0
    assert _estimate_mp3_duration_seconds(b"x" * 50) == 0.0
    assert _estimate_mp3_duration_seconds(None) == 0.0  # type: ignore
