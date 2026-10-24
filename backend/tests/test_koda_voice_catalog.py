"""
Unit tests per koda_voice_catalog — struttura dati pura, zero I/O.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import koda_voice_catalog as _cat  # noqa: E402


class TestVoiceCatalog(unittest.TestCase):

    def test_list_voices_public_shape(self):
        voices = _cat.list_voices_public()
        self.assertGreaterEqual(len(voices), 2)
        for v in voices:
            self.assertIn("key", v)
            self.assertIn("name", v)
            self.assertIn("gender", v)
            self.assertIn("description", v)
            self.assertIn("elevenlabs_voice_id", v)
            self.assertIn("available_on", v)
            self.assertIsInstance(v["available_on"], list)
            # ElevenLabs deve essere sempre disponibile (nostro default)
            self.assertIn("elevenlabs", v["available_on"])

    def test_find_by_key(self):
        self.assertIsNotNone(_cat.find_by_key("cielo"))
        self.assertIsNotNone(_cat.find_by_key("CIELO"))
        self.assertIsNotNone(_cat.find_by_key("vento"))
        self.assertIsNone(_cat.find_by_key("nonexistent"))

    def test_find_by_elevenlabs_voice_id(self):
        found = _cat.find_by_elevenlabs_voice_id("POuqf18evoXOKIqV2Px7")
        self.assertIsNotNone(found)
        self.assertEqual(found.key, "cielo")
        self.assertIsNone(_cat.find_by_elevenlabs_voice_id("nonexistent"))

    def test_voices_do_not_leak_inworld_voice_id(self):
        """Il payload pubblico non deve mai contenere il voice_id tecnico
        Inworld — resta backend-only."""
        voices = _cat.list_voices_public()
        for v in voices:
            self.assertNotIn("inworld_voice_id", v)
            self.assertNotIn("inworld_delivery_mode", v)

    def test_is_voice_available_on(self):
        # Cielo deve essere sempre su elevenlabs almeno
        self.assertTrue(_cat.is_voice_available_on("cielo", "elevenlabs"))
        self.assertFalse(_cat.is_voice_available_on("cielo", "unknown"))
        self.assertFalse(_cat.is_voice_available_on("nonexistent", "elevenlabs"))


if __name__ == "__main__":
    unittest.main()
