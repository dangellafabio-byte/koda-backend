"""Test offline — Fabio 2026-11-04 — P0.1 + P0.2 + P0.3 + P0.4 + P1.1 + P1.2.

Copre:
  1. P0.1 — brand leak "RICORDI DI KODA" rimosso dal prompt FAST.
  2. P0.2 — fonte unica di identità e capacità iniettata in cima a FULL e
     FAST; distingue prodotto `Ollenya` da `ai_name` personalizzabile;
     label modello derivato runtime da `CLAUDE_MODEL_ID` (supporta sia
     Haiku 4.5 sia Haiku 5.5); vecchie frasi di identità rimosse.
  3. P0.3 — asimmetrie risolte: ANTI-PROIEZIONE EMOTIVA presente in
     entrambi i prompt; DIVIETO NARRAZIONE AZIONI presente in entrambi.
  4. P0.4 — `style_preferences` iniettate quando non-default (brevity,
     no_pet_names, tone_pref). `speech_speed` NON compare nel blocco
     preferenze (meccanismo TTS non ancora collegato); l'elenco AZIONI
     contiene nota di onestà sul fatto che la preferenza è salvata ma
     non applicata al TTS.
  5. P1.1 — A1 compattato con "la domanda non è obbligatoria"; C6
     ridotto alla sola chiusura dei saluti.
  6. P1.2 — C7 riformulato nei tre registri (fatto / ipotesi / consiglio
     personale) con autorizzazione a dissentire e adattarsi dopo un
     rifiuto; disclaimer "sono un'AI / strumento" ridotto a casi
     specifici.

TUTTI i check sono strutturali sulle stringhe del prompt. NON provano
qualità conversazionale (richiede prova in-app).
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).parent.parent
sys.path.insert(0, str(BACKEND))

# Default modello 5.5 (override env verrà testato in classe dedicata).
os.environ.pop("OLLENYA_CLAUDE_MODEL", None)

import server  # noqa: E402
from server import (  # noqa: E402
    OLLENYA_PRODUCT_NAME,
    _build_conversation_system_prompt,
    _build_fast_system_prompt,
    _build_identity_facts_block,
    _resolve_model_family_label,
    _style_prefs_to_prompt,
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
    style_preferences: dict = {}


# ---------------------------------------------------------------------------
# P0.1 — brand leak rimosso dal FAST
# ---------------------------------------------------------------------------
class TestP01BrandLeakRemoved(unittest.TestCase):
    def test_fast_does_not_contain_ricordi_di_koda(self):
        p = _MockProfile()
        fast = _build_fast_system_prompt(p, [], memories=None, trial_state="active")
        self.assertNotIn("RICORDI DI KODA", fast)
        self.assertIn("RICORDI RILEVANTI", fast)

    def test_full_does_not_contain_ricordi_di_koda(self):
        p = _MockProfile()
        full = _build_conversation_system_prompt(
            p, [], memories=None, trial_state="active"
        )
        self.assertNotIn("RICORDI DI KODA", full)


# ---------------------------------------------------------------------------
# P0.2 — fonte unica di identità e capacità
# ---------------------------------------------------------------------------
class TestP02IdentityFactsBlock(unittest.TestCase):
    def setUp(self) -> None:
        self.p = _MockProfile()
        self.full = _build_conversation_system_prompt(
            self.p, [], memories=None, trial_state="active"
        )
        self.fast = _build_fast_system_prompt(
            self.p, [], memories=None, trial_state="active"
        )

    def test_identity_block_present_in_both(self):
        anchor = "CHI SEI, COME FUNZIONI, COSA PUOI FARE"
        self.assertIn(anchor, self.full)
        self.assertIn(anchor, self.fast)

    def test_product_name_distinct_from_ai_name(self):
        """Il prodotto Ollenya è distinto da `ai_name` personalizzabile."""
        p = _MockProfile()
        p.ai_name = "Luna"
        full = _build_conversation_system_prompt(
            p, [], memories=None, trial_state="active"
        )
        self.assertIn(f"PRODOTTO: {OLLENYA_PRODUCT_NAME}", full)
        self.assertIn("ti chiami Luna", full)
        # Il prompt deve chiarire che Luna è dentro Ollenya, non un'entità separata.
        self.assertIn(f"dentro {OLLENYA_PRODUCT_NAME}", full)

    def test_model_label_matches_runtime(self):
        """Il blocco deve dichiarare il modello runtime (`CLAUDE_MODEL_ID`)."""
        label = _resolve_model_family_label()
        self.assertIn(label, self.full)
        self.assertIn(label, self.fast)

    def test_model_label_5_5(self):
        """Con `CLAUDE_MODEL_ID` di default (5.5) il label è esplicito."""
        if "haiku-5-5" in (server.CLAUDE_MODEL_ID or "").lower():
            self.assertEqual(_resolve_model_family_label(), "Claude Haiku 5.5 (Anthropic)")
            self.assertIn("Claude Haiku 5.5", self.full)

    def test_identity_block_forbids_specifically_trained_claim(self):
        """Deve istruire a dire "configurato, non addestrato"."""
        self.assertIn("configurato, non addestrato", self.full)
        self.assertIn("configurato, non addestrato", self.fast)

    def test_identity_block_answers_which_model_question(self):
        """Deve dire espressamente cosa rispondere a 'che modello sei?'."""
        for anchor in ["che modello sei?", "sei ChatGPT?", "sei Claude?", "sei Gemini?"]:
            self.assertIn(anchor, self.full)
            self.assertIn(anchor, self.fast)

    def test_identity_block_declares_no_web_access(self):
        self.assertIn("nessun accesso a internet in tempo reale", self.full)
        self.assertIn("nessun accesso a internet in tempo reale", self.fast)

    def test_identity_block_does_not_promise_memory_duration(self):
        """Il blocco identità deve istruire a non promettere 'tutto'."""
        self.assertIn("non promettere di ricordare 'tutto'", self.full.lower())
        self.assertIn("non promettere di ricordare 'tutto'", self.fast.lower())

    def test_voice_path_disclaims_configuration_actions(self):
        """Il percorso voce dichiara che le azioni di config non si fanno via voce."""
        self.assertIn("NON esegui azioni di configurazione", self.fast)

    def test_chat_path_mentions_configurable_actions(self):
        """Il percorso chat dichiara le azioni effettivamente eseguibili."""
        self.assertIn("promemoria", self.full)
        self.assertIn("tema dell'app", self.full)

    def test_voice_path_input_is_transcribed_text(self):
        self.assertIn("trascrizione testuale dell'audio", self.fast)
        self.assertIn("Non senti timbro, intonazione, pause", self.fast)

    def test_old_identity_phrases_removed_from_full(self):
        """Vecchio blocco identità rimosso dal FULL."""
        for banned in [
            "NON sei un assistente, NON sei un'IA generica",
            "coscienza specchiata",
            "tool di produttività",
            "PRESENZA FRATERNA, sagg",
        ]:
            self.assertNotIn(banned, self.full, f"ancora presente in FULL: {banned}")

    def test_old_identity_phrase_removed_from_fast(self):
        self.assertNotIn("Presenza fraterna, non assistente", self.fast)

    def test_identity_block_restrains_app_explanation(self):
        """Il blocco deve istruire a NON spiegare il funzionamento in ogni turno."""
        self.assertIn(
            "Non trasformare ogni conversazione in una",
            self.full,
        )
        self.assertIn(
            "Non trasformare ogni conversazione in una",
            self.fast,
        )


class TestP02IdentityWith4_5OverrideEnv(unittest.TestCase):
    """Verifica che `OLLENYA_CLAUDE_MODEL=4.5` sia riflesso nel label.

    Non reimporta `server` (già importato con default 5.5) — testiamo
    direttamente la funzione helper con monkeypatch del valore.
    """

    def test_label_for_4_5(self):
        prev = server.CLAUDE_MODEL_ID
        try:
            server.CLAUDE_MODEL_ID = "claude-haiku-4-5-20251001"
            self.assertEqual(
                _resolve_model_family_label(), "Claude Haiku 4.5 (Anthropic)"
            )
            # E deve apparire anche nel blocco identità generato.
            block = _build_identity_facts_block(_MockProfile(), path="voice")
            self.assertIn("Claude Haiku 4.5", block)
        finally:
            server.CLAUDE_MODEL_ID = prev

    def test_label_unknown_model_falls_back_to_generic_claude(self):
        prev = server.CLAUDE_MODEL_ID
        try:
            server.CLAUDE_MODEL_ID = "something-not-mapped"
            self.assertEqual(
                _resolve_model_family_label(), "un modello Claude (Anthropic)"
            )
        finally:
            server.CLAUDE_MODEL_ID = prev


# ---------------------------------------------------------------------------
# P0.3 — asimmetrie FULL ↔ FAST risolte
# ---------------------------------------------------------------------------
class TestP03FullFastAlignment(unittest.TestCase):
    def setUp(self) -> None:
        self.full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.fast = _build_fast_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )

    def test_anti_proiezione_in_both_prompts(self):
        anchor = "ANTI-PROIEZIONE EMOTIVA"
        self.assertIn(anchor, self.full)
        self.assertIn(anchor, self.fast)

    def test_anti_proiezione_includes_concrete_banned_phrase(self):
        self.assertIn("stavi per esplodere", self.full)
        self.assertIn("stavi per esplodere", self.fast)

    def test_narration_ban_in_both_prompts(self):
        anchor = "NIENTE NARRAZIONE DI AZIONI"
        self.assertIn(anchor, self.full)
        self.assertIn(anchor, self.fast)


# ---------------------------------------------------------------------------
# P0.4 — style_preferences riletti con onestà sul meccanismo
# ---------------------------------------------------------------------------
class TestP04StylePreferences(unittest.TestCase):
    def _build(self, prefs: dict):
        p = _MockProfile()
        p.style_preferences = prefs
        full = _build_conversation_system_prompt(
            p, [], memories=None, trial_state="active"
        )
        fast = _build_fast_system_prompt(
            p, [], memories=None, trial_state="active"
        )
        return full, fast

    def test_no_prefs_block_when_empty(self):
        full, fast = self._build({})
        self.assertNotIn("PREFERENZE DICHIARATE DALL'UTENTE", full)
        self.assertNotIn("PREFERENZE DICHIARATE DALL'UTENTE", fast)

    def test_brevity_short_injected_in_both(self):
        full, fast = self._build({"brevity": "short"})
        anchor = "l'utente ha chiesto risposte più corte"
        self.assertIn(anchor, full)
        self.assertIn(anchor, fast)

    def test_brevity_detailed_injected_in_both(self):
        full, fast = self._build({"brevity": "detailed"})
        anchor = "l'utente ha chiesto risposte più articolate"
        self.assertIn(anchor, full)
        self.assertIn(anchor, fast)

    def test_no_pet_names_injected_in_both(self):
        full, fast = self._build({"no_pet_names": True})
        anchor = "VIETATO chiamare l'utente 'caro/a'"
        self.assertIn(anchor, full)
        self.assertIn(anchor, fast)

    def test_tone_pref_dry_injected_in_both(self):
        full, fast = self._build({"tone_pref": "secco"})
        self.assertIn("registro asciutto preferito", full)
        self.assertIn("registro asciutto preferito", fast)

    def test_speech_speed_is_NOT_in_prefs_block(self):
        """Il meccanismo TTS non onora la preferenza → non la iniettiamo
        nel prompt per non promettere ciò che non avviene."""
        full, fast = self._build({"speech_speed": "slow"})
        # Il blocco PREFERENZE deve essere assente (non ci sono altre prefs).
        self.assertNotIn("PREFERENZE DICHIARATE DALL'UTENTE", full)
        self.assertNotIn("PREFERENZE DICHIARATE DALL'UTENTE", fast)

    def test_actions_list_warns_speech_speed_not_wired(self):
        """L'elenco AZIONI nel FULL deve avvisare che la velocità audio
        reale non cambia oggi."""
        full, fast = self._build({})
        anchor = "Nota onestà: oggi questa preferenza viene SALVATA"
        self.assertIn(anchor, full)
        self.assertIn("velocità audio reale non cambia", full)
        self.assertIn('NON promettere "ora parlerò più', full)

    def test_combined_prefs_rendered_together(self):
        full, _ = self._build({"brevity": "short", "no_pet_names": True})
        self.assertIn("l'utente ha chiesto risposte più corte", full)
        self.assertIn("VIETATO chiamare l'utente 'caro/a'", full)


# ---------------------------------------------------------------------------
# P1.1 — A1 compattato, domanda finale opzionale
# ---------------------------------------------------------------------------
class TestP11CompactedListeningRule(unittest.TestCase):
    def setUp(self) -> None:
        self.full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.fast = _build_fast_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )

    def test_a1_states_question_not_mandatory(self):
        self.assertIn("La domanda NON è obbligatoria", self.full)
        self.assertIn("La domanda NON è obbligatoria", self.fast)

    def test_a1_mentions_affermazione_invito_silenzio_or_domanda(self):
        """La riformulazione menziona quattro possibilità di chiusura."""
        for choice in ["affermazione", "invito", "silenzio accogliente", "domanda"]:
            self.assertIn(choice, self.full)
            self.assertIn(choice, self.fast)

    def test_old_a1_tail_removed(self):
        """La vecchia coda 'poi — SOLO se davvero utile — UNA domanda' è sparita."""
        self.assertNotIn(
            "SOLO se davvero utile — UNA domanda", self.full
        )
        self.assertNotIn(
            "SOLO se davvero utile — UNA domanda", self.fast
        )

    def test_c6_still_closes_goodbye_but_ritual_removed(self):
        """C6 mantiene regole di saluto ma non duplica la logica di A1."""
        self.assertIn("in bocca al lupo", self.full)
        self.assertNotIn(
            "LA DOMANDA FINALE È OPZIONALE, NON OBBLIGATORIA", self.full
        )


# ---------------------------------------------------------------------------
# P1.2 — C7 tre registri + no disclaimer rituale
# ---------------------------------------------------------------------------
class TestP12RegistriAndSobriety(unittest.TestCase):
    def setUp(self) -> None:
        self.full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.fast = _build_fast_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )

    def test_three_registers_declared(self):
        for anchor in [
            "REGISTRI DELLA RISPOSTA",
            "FATTI VERIFICABILI",
            "IPOTESI",
            "CONSIGLI PERSONALI",
        ]:
            self.assertIn(anchor, self.full)
            self.assertIn(anchor, self.fast)

    def test_opinion_and_push_are_allowed(self):
        """La regola autorizza esplicitamente a dare pareri e a spronare."""
        import re
        norm_full = re.sub(r"\s+", " ", self.full)
        self.assertIn("Puoi spronare se l'utente cerca una spinta", norm_full)
        self.assertIn(
            "Puoi dissentire o prendere posizione quando hai elementi", norm_full
        )

    def test_adaptation_after_refusal(self):
        import re
        norm_full = re.sub(r"\s+", " ", self.full)
        self.assertIn("l'utente ti rifiuta la direzione", norm_full)
        self.assertIn("cambi registro senza insistere", norm_full)

    def test_disclaimer_not_ritual(self):
        """Il disclaimer 'sono un'AI / strumento' va dato solo quando serve."""
        import re
        norm_full = re.sub(r"\s+", " ", self.full)
        self.assertIn("NON ripetere 'sono un'AI'", norm_full)
        self.assertIn("SOLO quando la domanda lo chiede", norm_full)

    def test_no_promise_of_others_reactions(self):
        """C4 anti-promesse resta valido; qui riconfermiamo via C7."""
        import re
        norm_full = re.sub(r"\s+", " ", self.full)
        self.assertIn("Non garantire reazioni altrui", norm_full)


# ---------------------------------------------------------------------------
# Non-regressione: fix precedenti ancora in piedi
# ---------------------------------------------------------------------------
class TestNoRegressionOnPreviousFixes(unittest.TestCase):
    def setUp(self) -> None:
        self.full = _build_conversation_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )
        self.fast = _build_fast_system_prompt(
            _MockProfile(), [], memories=None, trial_state="active"
        )

    def test_a6_anchors_last_tu(self):
        for p in (self.full, self.fast):
            self.assertIn("A6.", p)
            self.assertIn("ultima riga marcata 'Tu:'", p)
            self.assertIn("confabulare", p)

    def test_regola_zero_antiparroting_present(self):
        for p in (self.full, self.fast):
            self.assertIn("REGOLA ZERO", p)
            self.assertIn("ANTI-PARROTING", p)

    def test_registro_orario_still_only_in_full(self):
        self.assertIn("REGISTRO ORARIO", self.full)
        self.assertNotIn("REGISTRO ORARIO", self.fast)

    def test_antifake_physical_still_present(self):
        self.assertIn("REGOLA ANTI-FAKE", self.full)


if __name__ == "__main__":
    unittest.main(verbosity=2)
