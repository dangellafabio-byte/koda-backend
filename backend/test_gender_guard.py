"""Unit test per koda_gender_guard (Fabio 2026-06)."""
import unittest
from koda_gender_guard import fix_ai_gender


class TestGenderGuard(unittest.TestCase):
    # ----- ai_gender='f' → correggi maschile a femminile --------------

    def test_sono_contento_to_contenta(self):
        out, n = fix_ai_gender("Ciao, sono contento di sentirti", "f")
        self.assertEqual(out, "Ciao, sono contenta di sentirti")
        self.assertEqual(n, 1)

    def test_multiple_corrections_f(self):
        out, n = fix_ai_gender("Sono pronto, mi sento sicuro e tranquillo", "f")
        self.assertEqual(out, "Sono pronta, mi sento sicura e tranquillo")
        # ultimo "tranquillo" non è preceduto da self-context → non tocca
        self.assertEqual(n, 2)

    def test_mi_sono_ato_to_ata(self):
        out, n = fix_ai_gender("Mi sono emozionato quando l'hai detto", "f")
        self.assertEqual(out, "Mi sono emozionata quando l'hai detto")
        self.assertEqual(n, 1)

    def test_non_sono_riuscito(self):
        out, n = fix_ai_gender("Non sono riuscito a capirti", "f")
        self.assertEqual(out, "Non sono riuscita a capirti")
        self.assertEqual(n, 1)

    def test_sarei_curioso(self):
        out, n = fix_ai_gender("Sarei curioso di sapere di più", "f")
        self.assertEqual(out, "Sarei curiosa di sapere di più")
        self.assertEqual(n, 1)

    def test_case_preservation(self):
        out, n = fix_ai_gender("Sono Pronto per te", "f")
        self.assertEqual(out, "Sono Pronta per te")
        self.assertEqual(n, 1)

    # ----- ai_gender='m' → correggi femminile a maschile --------------

    def test_sono_pronta_to_pronto(self):
        out, n = fix_ai_gender("Sono pronta, sono sicura", "m")
        self.assertEqual(out, "Sono pronto, sono sicuro")
        self.assertEqual(n, 2)

    def test_mi_sono_sentita(self):
        out, n = fix_ai_gender("Mi sono sentita bene", "m")
        self.assertEqual(out, "Mi sono sentito bene")
        self.assertEqual(n, 1)

    # ----- NON tocca aggettivi rivolti all'utente ---------------------

    def test_sei_stanco_no_touch(self):
        # "sei stanco" → utente MASCHIO. Se ai_gender="f", NON toccare
        # perché "sei" non è self-context. Rimane invariato.
        out, n = fix_ai_gender("Sei stanco oggi?", "f")
        self.assertEqual(out, "Sei stanco oggi?")
        self.assertEqual(n, 0)

    def test_ti_vedo_stanca_no_touch(self):
        out, n = fix_ai_gender("Ti vedo stanca oggi", "m")
        self.assertEqual(out, "Ti vedo stanca oggi")
        self.assertEqual(n, 0)

    # ----- gender neutro / vuoto / None -------------------------------

    def test_neutral_gender_noop(self):
        out, n = fix_ai_gender("Sono contento oggi", "n")
        self.assertEqual(out, "Sono contento oggi")
        self.assertEqual(n, 0)

    def test_empty_gender_noop(self):
        out, n = fix_ai_gender("Sono contenta oggi", "")
        self.assertEqual(out, "Sono contenta oggi")
        self.assertEqual(n, 0)

    def test_empty_text_safe(self):
        out, n = fix_ai_gender("", "f")
        self.assertEqual(out, "")
        self.assertEqual(n, 0)

    def test_none_text_safe(self):
        out, n = fix_ai_gender(None, "f")  # type: ignore
        self.assertIsNone(out)
        self.assertEqual(n, 0)

    # ----- Regressione: casi reali dai log del prompt -----------------

    def test_prompt_examples_f(self):
        """Frasi dagli esempi ai_decl del prompt (line 2567-2570)."""
        cases = [
            ("sono qui", "sono qui"),  # "qui" non è nella lista → no touch
            ("sono contento", "sono contenta"),
            ("sarei curioso", "sarei curiosa"),
            ("sono pronto", "sono pronta"),
            ("mi sento pronto", "mi sento pronta"),
        ]
        for src, expected in cases:
            out, _ = fix_ai_gender(src, "f")
            self.assertEqual(out, expected, msg=f"failed on: {src!r}")

    def test_prompt_examples_m(self):
        cases = [
            ("sono contenta", "sono contento"),
            ("sarei curiosa", "sarei curioso"),
            ("sono pronta", "sono pronto"),
        ]
        for src, expected in cases:
            out, _ = fix_ai_gender(src, "m")
            self.assertEqual(out, expected, msg=f"failed on: {src!r}")

    # ----- Robustezza: no double-application ---------------------------

    def test_idempotence(self):
        """Applicare due volte non deve cambiare l'output."""
        once, n1 = fix_ai_gender("Sono contento", "f")
        twice, n2 = fix_ai_gender(once, "f")
        self.assertEqual(once, twice)
        self.assertEqual(n2, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
