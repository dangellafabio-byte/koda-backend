"""
Unit tests per inworld_tts — SOLO logica interna, nessuna chiamata HTTP.

Rispetta la direttiva Fabio 2026-10: niente consumo API in questa fase.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import inworld_tts as _ad  # noqa: E402


class TestInworldAdapterPure(unittest.TestCase):

    def test_health_check_shape(self):
        cfg = _ad.health_check_config()
        self.assertTrue(cfg.get("module_loaded"))
        self.assertIn("default_voice_id", cfg)
        self.assertIn("default_model_id", cfg)
        self.assertIn("rate_per_1m_chars_usd", cfg)
        # Dopo merge main (2026-10): model_locked NON è più esposto da
        # health_check_config() (è letto a runtime da env dentro
        # routes/tts_providers.py). Verifichiamo che il nuovo contratto
        # non abbia regressioni sui campi veramente usati dalla UI.
        self.assertIn("api_key_present", cfg)
        self.assertIsInstance(cfg["api_key_present"], bool)
        self.assertIn("endpoint_non_streaming", cfg)
        self.assertIn("endpoint_streaming", cfg)
        self.assertIsInstance(cfg["api_key_present"], bool)

    def test_health_check_hides_secrets(self):
        cfg = _ad.health_check_config()
        for k, v in cfg.items():
            self.assertNotIn("api_key", str(k).lower().replace("api_key_present", ""))
            if isinstance(v, str):
                self.assertNotIn("Basic ", v)

    def test_validate_text_empty_raises(self):
        with self.assertRaises(_ad.InworldTTSError):
            _ad._validate_text("")
        with self.assertRaises(_ad.InworldTTSError):
            _ad._validate_text("   ")

    def test_validate_text_too_long_raises(self):
        with self.assertRaises(_ad.InworldTTSError):
            _ad._validate_text("x" * 3000, max_chars=2000)

    def test_validate_text_ok(self):
        self.assertEqual(_ad._validate_text("ciao"), "ciao")

    def test_cost_estimation(self):
        # Con default 15 USD / 1M chars → 1000 chars = 0.015 USD
        rate = _ad._rate_per_1m_usd()
        cost_100 = _ad._estimate_cost_usd(100)
        self.assertAlmostEqual(cost_100, rate / 10000.0, places=6)

    def test_voice_params_payload_structure(self):
        p = _ad.InworldVoiceParams(voice_id="Test", model_id="inworld-test-x")
        payload = p.to_payload("ciao")
        self.assertEqual(payload["text"], "ciao")
        self.assertEqual(payload["voiceId"], "Test")
        self.assertEqual(payload["modelId"], "inworld-test-x")
        self.assertIn("audioConfig", payload)
        self.assertEqual(payload["audioConfig"]["audioEncoding"], "MP3")

    def test_load_api_key_missing_raises(self):
        old = os.environ.pop("INWORLD_API_KEY", None)
        try:
            with self.assertRaises(_ad.InworldTTSAuthError):
                _ad._load_api_key()
        finally:
            if old is not None:
                os.environ["INWORLD_API_KEY"] = old

    def test_extract_billed_chars_variants(self):
        self.assertEqual(_ad._extract_billed_chars({"usage": {"processedCharactersCount": 42}}), 42)
        self.assertEqual(_ad._extract_billed_chars({"result": {"usage": {"characterCount": 17}}}), 17)
        self.assertIsNone(_ad._extract_billed_chars({"foo": "bar"}))


if __name__ == "__main__":
    unittest.main()
