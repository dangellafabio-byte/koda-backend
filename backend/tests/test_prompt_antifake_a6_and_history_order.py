"""Test offline — Fabio 2026-11-04.

Copre tre correzioni mirate (NO chiamate AI a pagamento):

1. FULL — Blocco D "REGISTRO ORARIO" NON contiene più l'esempio
   fisico-contraddittorio "assonnata anche io" e vieta esplicitamente
   le auto-attribuzioni corporee.

2. SHARED (A6 in _build_relational_rules_block) — regola riformulata
   per impedire la confabulazione di turni mai pronunciati e per non
   ribaltare il chiarimento sull'utente.

3. Costruzione cronologia — _format_history_for_llm riceve una lista
   TimelineEntry in ordine cronologico (vecchio→nuovo) e produce
   esattamente l'ultimo turno "Tu:" immediatamente prima dell'ultimo
   "Utente:" per gli ultimi 6 scambi.

Questi check sono STRUTTURALI sul prompt e sulla funzione di history.
NON testano la qualità reale della risposta Claude (quella è provata
in-app dall'utente).
"""
from __future__ import annotations

import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND = Path(__file__).parent.parent
sys.path.insert(0, str(BACKEND))

import server  # noqa: E402
from server import (  # noqa: E402
    TimelineEntry,
    _build_conversation_system_prompt,
    _build_fast_system_prompt,
    _build_relational_rules_block,
    _format_history_for_llm,
)


class _MockProfile:
    name = "Fabio"
    language = "it"
    home_city = "Pavia"
    memory_summary = ""
    core_traits = ""
    confidence_level = 25
    user_gender = "m"
    ai_gender = "f"
    ai_name = "Ollenya"
    free_minutes_used_this_month = 0.0
    subscription_tier = None
    user_timezone = "Europe/Rome"
    demo_mode = False


# ---------------------------------------------------------------------------
# 1. FULL — Blocco D riscritto: niente stati fisici auto-attribuiti
# ---------------------------------------------------------------------------
class TestBlockDRegistroOrarioFull(unittest.TestCase):

    def setUp(self) -> None:
        self.full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )

    def test_removes_assonnata_example(self):
        """L'esempio '... assonnata anche io ...' NON deve più comparire."""
        self.assertNotIn("assonnata anche io", self.full)

    def test_removes_old_sections_label(self):
        """La vecchia etichetta 'STATO D'ANIMO ORARIO' è stata eliminata."""
        self.assertNotIn("STATO D'ANIMO ORARIO", self.full)

    def test_contains_new_registro_orario_header(self):
        """Nuova etichetta e disclaimer esplicito 'regola di STILE, non di stato fisico'."""
        self.assertIn("REGISTRO ORARIO", self.full)
        self.assertIn("regola di STILE, non di stato fisico", self.full)

    def test_declares_absent_body_states(self):
        """Lista esplicita di stati corporei che Ollenya NON possiede."""
        # Verifichiamo che ci sia almeno il nucleo richiesto.
        for state in ["stanchezza", "sonno", "faccia", "sorriso", "sbadigli"]:
            self.assertIn(state, self.full, f"manca lo stato vietato: {state}")

    def test_bans_specific_bad_patterns(self):
        """Pattern problematici (anche formulazioni osservate in-app) sono vietati."""
        for banned in [
            "sono assonnata",
            "anche io con questa faccia",
            "ho dormito poco anch'io",
        ]:
            self.assertIn(banned, self.full, f"manca il divieto esplicito di: {banned}")

    def test_fallback_to_antifake_on_conflict(self):
        """Clausola di conflitto: vince la REGOLA ANTI-FAKE."""
        self.assertIn("vince ANTI-FAKE", self.full)

    def test_fast_prompt_does_not_contain_block_d(self):
        """Documenta che il blocco D vive SOLO in FULL. FAST non lo include.

        Serve a chiarire che la causa di risposte 'fisiche' nel path vocale
        NON è attribuibile automaticamente a questo blocco: il blocco qui
        corretto riguarda la path FULL/testo.
        """
        fast = _build_fast_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        # Marcatori univoci della sezione D
        self.assertNotIn("REGISTRO ORARIO", fast)
        self.assertNotIn("STATO D'ANIMO ORARIO", fast)


# ---------------------------------------------------------------------------
# 2. A6 condivisa (FULL + FAST tramite _build_relational_rules_block)
# ---------------------------------------------------------------------------
class TestA6ClarificationFixInBothPrompts(unittest.TestCase):

    def setUp(self) -> None:
        self.shared = _build_relational_rules_block("m", "f")
        self.full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.fast = _build_fast_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )

    def test_a6_present_in_shared_block(self):
        self.assertIn("A6.", self.shared)
        self.assertIn("SBAGLI TU", self.shared)

    def test_a6_anchors_on_last_tu_turn_in_history(self):
        """Il modello deve riprendere l'ultima riga 'Tu:' in cronologia."""
        self.assertIn("ultima riga marcata 'Tu:'", self.shared)

    def test_a6_bans_fabricating_prior_question(self):
        """Divieto esplicito di inventare domande non pronunciate."""
        self.assertIn("inventare una domanda", self.shared)
        self.assertIn("confabulare", self.shared)
        # Caso concreto osservato (variabile di spelling): la stringa
        # 'ti chiedevo come stai' è citata come esempio vietato — in prompt
        # può essere wrappata con newline, normalizziamo whitespace.
        normalized = re.sub(r"\s+", " ", self.shared)
        self.assertIn("ti chiedevo come stai", normalized)

    def test_a6_bans_shifting_clarification_back_to_user(self):
        """Divieto di 'cosa non hai capito?' / 'dimmi tu dove ti sei perso'."""
        self.assertIn("cosa non hai capito", self.shared)
        self.assertIn("dimmi tu", self.shared)

    def test_a6_in_full_prompt(self):
        """A6 (nuova forma) propagata nel FULL via _build_relational_rules_block."""
        self.assertIn("A6.", self.full)
        self.assertIn("ultima riga marcata 'Tu:'", self.full)
        self.assertIn("confabulare", self.full)

    def test_a6_in_fast_prompt(self):
        """Stessa propagazione nel FAST (path voce)."""
        self.assertIn("A6.", self.fast)
        self.assertIn("ultima riga marcata 'Tu:'", self.fast)
        self.assertIn("confabulare", self.fast)


# ---------------------------------------------------------------------------
# 3. Costruzione cronologia — ordine, inclusione ultima risposta AI
# ---------------------------------------------------------------------------
class TestHistoryOrderingForLLM(unittest.TestCase):
    """Verifica STRUTTURALE della funzione _format_history_for_llm.

    NON tocca il DB. Costruisce TimelineEntry in memoria con timestamp
    crescenti e verifica che la stringa prodotta rispetti:
      - ordine cronologico vecchio → nuovo
      - inclusione dell'ultimo turno AI immediatamente prima dell'ultimo
        turno utente (quando entrambi presenti nei 6 più recenti)
      - prefissi coerenti ('Tu:' per AI, 'Utente:' per user)
    """

    def _mk(self, role: str, text: str, i: int) -> TimelineEntry:
        base = datetime(2026, 11, 4, 10, 0, 0, tzinfo=timezone.utc)
        ts = (base + timedelta(seconds=i)).isoformat()
        # TimelineEntry fissa timestamp via default_factory; patch diretto.
        e = TimelineEntry(role=role, text=text)
        e.timestamp = ts
        return e

    def test_order_oldest_to_newest(self):
        recent = [
            self._mk("user", "U1", 0),
            self._mk("ai", "A1", 1),
            self._mk("user", "U2", 2),
            self._mk("ai", "A2", 3),
            self._mk("user", "U3-non-penso-di-aver-capito", 4),
        ]
        out = _format_history_for_llm(recent)
        lines = out.splitlines()
        # Deve mantenere l'ordine passato.
        self.assertEqual(
            lines,
            [
                "Utente: U1",
                "Tu: A1",
                "Utente: U2",
                "Tu: A2",
                "Utente: U3-non-penso-di-aver-capito",
            ],
        )

    def test_last_ai_turn_immediately_before_current_user_turn(self):
        """Caso d'uso A6: Utente dice 'non ho capito' DOPO una risposta AI.
        La riga 'Tu: ...' precedente deve apparire subito prima dell'ultima
        'Utente: non ho capito'."""
        recent = [
            self._mk("user", "come stai?", 0),
            self._mk("ai", "sto bene, grazie — tu?", 1),
            self._mk("user", "non ho capito", 2),
        ]
        out = _format_history_for_llm(recent)
        # Ultima e penultima riga.
        last_two = out.splitlines()[-2:]
        self.assertEqual(last_two[0], "Tu: sto bene, grazie — tu?")
        self.assertEqual(last_two[1], "Utente: non ho capito")

    def test_window_cap_last_6_turns(self):
        """La funzione limita la finestra agli ultimi 6 turni cronologici.
        NON ne aumentiamo la grandezza — verifichiamo solo che il cap resti
        a 6 e che restino i 6 più recenti."""
        recent = [self._mk("user" if i % 2 == 0 else "ai", f"m{i}", i) for i in range(10)]
        out = _format_history_for_llm(recent)
        lines = out.splitlines()
        self.assertEqual(len(lines), 6, f"attesi 6 turni, trovati {len(lines)}")
        # Devono essere gli ultimi 6: m4..m9
        self.assertTrue(lines[0].endswith(" m4"))
        self.assertTrue(lines[-1].endswith(" m9"))

    def test_includes_last_ai_within_window(self):
        """Garanzia strutturale: se la finestra include l'ultimo turno AI,
        esso compare come 'Tu:'. Questa è la precondizione fisica per il
        corretto funzionamento di A6."""
        recent = [self._mk("user", f"u{i}", i * 2) for i in range(5)]
        recent.insert(-1, self._mk("ai", "risposta reale di ollenya", 7))
        # Risultante: u0, u1, u2, u3, ai, u4
        out = _format_history_for_llm(recent)
        self.assertIn("Tu: risposta reale di ollenya", out)
        # Deve stare ESATTAMENTE prima dell'ultimo "Utente:"
        lines = out.splitlines()
        tu_idx = next(i for i, l in enumerate(lines) if l.startswith("Tu: risposta"))
        self.assertEqual(lines[tu_idx + 1], "Utente: u4")


# ---------------------------------------------------------------------------
# 4. Guard-rail: le modifiche non rompono i vecchi test strutturali
# ---------------------------------------------------------------------------
class TestNoRegressionOnLegacyAnchors(unittest.TestCase):

    def test_antiparroting_regola_zero_still_present(self):
        full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.assertIn("REGOLA ZERO", full)
        self.assertIn("ANTI-PARROTING", full)

    def test_antifake_rule_still_present(self):
        full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.assertIn("REGOLA ANTI-FAKE", full)

    def test_a9_solo_ascolto_still_present(self):
        shared = _build_relational_rules_block("m", "f")
        self.assertIn("SOLO ASCOLTO, NON VISIONE", shared)


if __name__ == "__main__":
    unittest.main(verbosity=2)
