"""Test OFFLINE — Inworld synthesisContext.previousRequests (Fabio 2026-11-04).

Verifica:
  1. Flag OFF (default) → payload NON contiene `synthesisContext`.
  2. Flag ON → `synthesisContext.previousRequests` presente SOLO se
     il buffer ha testi reali.
  3. I testi nel buffer vengono MAI messaggi utente (STT): è
     responsabilità del chiamante, qui testiamo che il record funzioni
     solo con testo output effettivo.
  4. Limiti documentati: max 5, max 2000 char, oldest→newest.
  5. TTL: oltre `CONTEXT_TTL_S` la coda è stale.
  6. Isolamento tra utenti.
  7. Segmentazione: `_SENTENCE_RE` preserva `?` finali di domande,
     NON spezza domande a metà.

Nessuna chiamata rete, nessuna chiamata paid.
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

BACKEND = Path(__file__).parent.parent
sys.path.insert(0, str(BACKEND))

import inworld_context_buffer as cb  # noqa: E402
import inworld_tts as inworld  # noqa: E402


class TestPayloadFlagGating(unittest.TestCase):

    def tearDown(self):
        os.environ.pop("INWORLD_SEND_CONTEXT", None)
        cb._buffers.clear()

    def test_flag_off_by_default(self):
        self.assertFalse(cb.is_context_feature_enabled())

    def test_flag_on_when_env_set(self):
        os.environ["INWORLD_SEND_CONTEXT"] = "1"
        self.assertTrue(cb.is_context_feature_enabled())

    def test_payload_without_context(self):
        p = inworld.DEFAULT_VOICE_PARAMS.to_payload("Ciao", previous_requests=None)
        self.assertNotIn("synthesisContext", p)
        self.assertEqual(p["text"], "Ciao")

    def test_payload_with_context(self):
        p = inworld.DEFAULT_VOICE_PARAMS.to_payload(
            "Perché?",
            previous_requests=["Davvero?"],
        )
        self.assertIn("synthesisContext", p)
        pr = p["synthesisContext"]["previousRequests"]
        self.assertEqual(len(pr), 1)
        self.assertEqual(pr[0], {"text": "Davvero?"})

    def test_payload_rejects_more_than_5_items(self):
        with self.assertRaises(ValueError):
            inworld.DEFAULT_VOICE_PARAMS.to_payload(
                "x",
                previous_requests=["a", "b", "c", "d", "e", "f"],
            )

    def test_payload_rejects_more_than_2000_chars(self):
        with self.assertRaises(ValueError):
            inworld.DEFAULT_VOICE_PARAMS.to_payload(
                "x",
                previous_requests=["a" * 1000, "b" * 1200],
            )


class TestContextBufferBehavior(unittest.TestCase):

    def setUp(self):
        cb._buffers.clear()

    def test_record_and_get_single_user(self):
        cb.record_synthesized_text("u1", "Ciao, come stai?")
        cb.record_synthesized_text("u1", "Bene, grazie.")
        out = cb.get_context_for_user("u1")
        self.assertEqual(out, ["Ciao, come stai?", "Bene, grazie."])

    def test_user_isolation(self):
        cb.record_synthesized_text("u1", "testo di U1")
        cb.record_synthesized_text("u2", "testo di U2")
        self.assertEqual(cb.get_context_for_user("u1"), ["testo di U1"])
        self.assertEqual(cb.get_context_for_user("u2"), ["testo di U2"])

    def test_cap_5_items_lru(self):
        for i in range(1, 8):
            cb.record_synthesized_text("u1", f"frase {i}")
        out = cb.get_context_for_user("u1")
        # Solo le ULTIME 5
        self.assertEqual(out, [f"frase {i}" for i in range(3, 8)])

    def test_truncate_per_item_cap(self):
        long = "x" * 500  # oltre il PER_ITEM_SOFT_CAP_CHARS=400
        cb.record_synthesized_text("u1", long)
        out = cb.get_context_for_user("u1")
        self.assertEqual(len(out), 1)
        self.assertEqual(len(out[0]), cb.PER_ITEM_SOFT_CAP_CHARS)

    def test_total_budget_2000(self):
        for i in range(5):
            cb.record_synthesized_text("u1", "a" * 400)
        out = cb.get_context_for_user("u1")
        self.assertEqual(len(out), 5)
        self.assertEqual(sum(len(t) for t in out), 2000)

    def test_total_budget_drops_oldest_when_exceeded(self):
        # Mettiamo 5 x 400 = 2000. Aggiungiamo un 6° (deque maxlen=5 →
        # il primo esce). Totale resta ≤ 2000.
        for i in range(6):
            cb.record_synthesized_text("u1", "a" * 400)
        out = cb.get_context_for_user("u1")
        self.assertLessEqual(sum(len(t) for t in out), 2000)
        self.assertLessEqual(len(out), 5)

    def test_ttl_expires_entries(self):
        orig_ttl = cb.CONTEXT_TTL_S
        cb.CONTEXT_TTL_S = 0.05  # 50ms
        try:
            cb.record_synthesized_text("u1", "vecchio")
            time.sleep(0.1)
            cb.record_synthesized_text("u1", "nuovo")
            out = cb.get_context_for_user("u1")
            self.assertEqual(out, ["nuovo"])
        finally:
            cb.CONTEXT_TTL_S = orig_ttl

    def test_empty_text_ignored(self):
        cb.record_synthesized_text("u1", "")
        cb.record_synthesized_text("u1", "   ")
        self.assertEqual(cb.get_context_for_user("u1"), [])

    def test_missing_user_id_noop(self):
        cb.record_synthesized_text(None, "ciao")
        cb.record_synthesized_text("", "ciao")
        self.assertEqual(cb.get_context_for_user(None), [])
        self.assertEqual(cb.get_context_for_user(""), [])

    def test_clear_user(self):
        cb.record_synthesized_text("u1", "x")
        cb.clear_user("u1")
        self.assertEqual(cb.get_context_for_user("u1"), [])

    def test_order_chronological(self):
        cb.record_synthesized_text("u1", "primo")
        time.sleep(0.01)
        cb.record_synthesized_text("u1", "secondo")
        time.sleep(0.01)
        cb.record_synthesized_text("u1", "terzo")
        self.assertEqual(cb.get_context_for_user("u1"), ["primo", "secondo", "terzo"])


class TestSegmenterPreservesQuestions(unittest.TestCase):
    """Il segmentatore attuale (`_SENTENCE_RE`) deve riconoscere `?` come
    terminatore e NON spezzare dentro una domanda. Questo è un invariante
    che Fabio ha chiesto di VERIFICARE prima di riscrivere il segmentatore.
    """

    def test_question_mark_as_terminator(self):
        import server
        sent, rest = server._pop_first_sentence("Come stai? Dimmi.")
        self.assertEqual(sent, "Come stai?")
        self.assertEqual(rest.strip(), "Dimmi.")

    def test_question_mark_not_split_inside(self):
        import server
        # Il regex matcha PRIMO `?` → la prima frase è "Come stai?",
        # il rest comincia con " E tu?". Non c'è taglio INTERNO alla
        # domanda "Come stai?" (nessun soft-break tipo `,` dentro).
        sent, rest = server._pop_first_sentence("Come stai, oggi? E tu?")
        self.assertEqual(sent, "Come stai, oggi?")
        self.assertEqual(rest.strip(), "E tu?")

    def test_multiple_question_marks_preserved(self):
        import server
        # Doppi "??" sono comuni in italiano colloquiale (urgenza/sorpresa).
        # Il regex `[.!?…]+` li tratta come SINGOLO terminatore.
        sent, rest = server._pop_first_sentence("Davvero?? Non ci credo.")
        self.assertEqual(sent, "Davvero??")
        self.assertEqual(rest.strip(), "Non ci credo.")

    def test_early_chunk_does_not_split_inside_question(self):
        import server
        # Domanda lunga ma senza terminatori interni (`.`, `!`, `?`
        # intermedio). Un soft-break `,` c'è, ma `_pop_first_chunk_aggressive`
        # cerca soft-break SOLO dopo MIN_FIRST_CHUNK_CHARS=80. La virgola
        # qui è a pos 48, SOTTO soglia → nessun taglio. Risultato: aspetta
        # più testo (ritorna "", buf) finché non arriva il `?`.
        q = "Come stai dopo tutto, e cosa pensi del risultato"
        self.assertLess(len(q), 80)
        sent, rest = server._pop_first_chunk_aggressive(q)
        self.assertEqual(sent, "")
        self.assertEqual(rest, q)

    def test_sentence_regex_recognizes_interrogation(self):
        import re, server
        # L'invariante direct-on-regex: `?` è nel pattern di terminatore
        # ammessi. Se qualcuno un giorno rimuove `?` dal regex, questo
        # test lo intercetta.
        self.assertIn("?", server._SENTENCE_RE.pattern)
        self.assertIn("!", server._SENTENCE_RE.pattern)
        self.assertIn(".", server._SENTENCE_RE.pattern)


if __name__ == "__main__":
    unittest.main()
