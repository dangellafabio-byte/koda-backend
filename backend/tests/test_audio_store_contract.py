"""Test OFFLINE — contratto audioStore (frontend) + invariant replayMessage
(Fabio 2026-11-04).

Il frontend non ha un test-runner JS installato (no jest/tsx/ts-node).
Questi test verificano in modo STATICO che il codice TypeScript rispetti
il contratto richiesto da Fabio:

  1. Replay con zero chiamate ai generatori:
     - `replayMessage` NON chiama più `SpeechMod.speak`.
     - `replayMessage` NON chiama `fastConverseWS`.
     - Il nuovo path chiama solo `audioStore.readForReplay` + player
       locale su file.
  2. Audio assente/incompleto → ok=false con reason specifica, nessun
     fallback a rigenerazione (nessun `SpeechMod.speak` nel ramo else).
  3. Isolamento utente: `readMeta` verifica `user_id`.
  4. Flag disattivato preserva comportamento precedente:
     - `isBitExactReplayEnabled()` legge `EXPO_PUBLIC_REPLAY_BIT_EXACT`.
     - `appendSegment` ritorna early quando il flag è OFF.
     - `readForReplay` ritorna `feature_disabled` quando OFF.
  5. Path safety: sanitizeId rifiuta `..`, `/`, ecc.
  6. Isolamento filesystem: path include `user_id` sanitizzato.

Più un contratto-test IMPLEMENTATIVO in Python che riproduce la logica
di sanitize + path builder per asserire che non emerga mai un path
traversal (property-based su 1000 input random).
"""
from __future__ import annotations

import random
import re
import string
import sys
import unittest
from pathlib import Path

FRONTEND = Path(__file__).parent.parent.parent / "frontend"
AUDIO_STORE_PATH = FRONTEND / "lib" / "audioStore.ts"
SPEECH_PATH = FRONTEND / "lib" / "speech.ts"
INDEX_PATH = FRONTEND / "app" / "index.tsx"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


class TestAudioStoreTSInvariants(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not AUDIO_STORE_PATH.exists():
            raise unittest.SkipTest(f"missing {AUDIO_STORE_PATH}")
        cls.src = _read(AUDIO_STORE_PATH)

    def test_feature_flag_readable_and_default_on(self):
        self.assertIn("EXPO_PUBLIC_REPLAY_BIT_EXACT", self.src)
        self.assertIn('"1"', self.src)
        self.assertIn("isBitExactReplayEnabled", self.src)

    def test_appendSegment_early_returns_when_flag_off(self):
        # Deve esistere un check su isBitExactReplayEnabled() prima
        # di scrivere su filesystem.
        append_block = re.search(
            r"export async function appendSegment\(.*?\): Promise<void> \{(.+?)^\}",
            self.src, re.DOTALL | re.MULTILINE,
        )
        self.assertIsNotNone(append_block, "appendSegment signature missing")
        body = append_block.group(1)
        self.assertIn("isBitExactReplayEnabled()", body)
        self.assertIn("return", body)

    def test_readForReplay_returns_feature_disabled_when_off(self):
        self.assertIn('reason: "feature_disabled"', self.src)
        read_block = re.search(
            r"export async function readForReplay\(.+?\n\}",
            self.src, re.DOTALL,
        )
        self.assertIsNotNone(read_block)
        body = read_block.group(0)
        self.assertIn("isBitExactReplayEnabled()", body)

    def test_user_isolation_check_present(self):
        # readMeta deve rifiutare se parsed.user_id !== userId
        self.assertIn("parsed.user_id !== userId", self.src)
        # readForReplay deve ritornare user_mismatch quando il campo
        # salvato non coincide.
        self.assertIn('reason: "user_mismatch"', self.src)

    def test_sanitizeId_regex(self):
        # Permette solo [A-Za-z0-9_-], len ≤ 64
        self.assertIn("[^A-Za-z0-9_-]", self.src)
        self.assertIn("slice(0, 64)", self.src)

    def test_no_fallback_regen_on_missing(self):
        # Nel modulo audioStore stesso NON deve mai apparire
        # `SpeechMod` né chiamate TTS di nessun tipo.
        self.assertNotIn("SpeechMod", self.src)
        self.assertNotIn("fastConverseWS", self.src)
        self.assertNotIn("fastConverse", self.src)

    def test_cleanup_explicit_policy_fields(self):
        self.assertIn("DEFAULT_MAX_AGE_MS", self.src)
        self.assertIn("DEFAULT_MAX_MESSAGES_PER_USER", self.src)
        self.assertIn("messages_removed_by_age", self.src)
        self.assertIn("messages_removed_by_count", self.src)

    def test_meta_schema_version(self):
        self.assertIn("schema_version", self.src)


class TestReplayMessageNoRegenInIndex(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not INDEX_PATH.exists():
            raise unittest.SkipTest(f"missing {INDEX_PATH}")
        cls.src = _read(INDEX_PATH)
        # Estrai il body di replayMessage
        m = re.search(
            r"const replayMessage = async \(entry: TimelineEntry\) => \{(.+?)^\s*\};",
            cls.src, re.DOTALL | re.MULTILINE,
        )
        if not m:
            raise unittest.SkipTest("replayMessage body not found")
        cls.body = m.group(1)

    def test_replay_uses_audioStore_readForReplay(self):
        self.assertIn("audioStore.readForReplay", self.body)

    def test_replay_does_not_call_SpeechMod_speak(self):
        # SpeechMod.stop() è OK (toggle); SpeechMod.speak() NO (= regen).
        self.assertNotIn("SpeechMod.speak", self.body)

    def test_replay_does_not_call_fastConverse(self):
        self.assertNotIn("fastConverse", self.body)

    def test_replay_has_unavailable_message_branch(self):
        # Deve esserci un ramo che mostra "non disponibile" o simile
        # quando ok=false. Verifichiamo la presenza di una delle label.
        self.assertRegex(
            self.body,
            r"non disponibile|non_disponibile|Riascolto.*disattivato|missing_segments",
        )

    def test_turn_message_id_is_stable_before_ws(self):
        # Il generatore `_turnMsgId` deve esistere PRIMA della chiamata
        # a fastConverseWS, così onAudioSegment e aiEntry.id combaciano.
        wsidx = self.src.find("fastConverseWS(")
        tidx = self.src.find("_turnMsgId")
        self.assertGreater(wsidx, 0)
        self.assertGreater(tidx, 0)
        self.assertLess(tidx, wsidx, "_turnMsgId generato DOPO ws → mismatch")

    def test_onAudioSegment_wired_into_fastConverseWS(self):
        self.assertIn("onAudioSegment:", self.src)
        self.assertIn("audioStore.appendSegment", self.src)


class TestSpeechTsCallbackContract(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not SPEECH_PATH.exists():
            raise unittest.SkipTest(f"missing {SPEECH_PATH}")
        cls.src = _read(SPEECH_PATH)

    def test_onAudioSegment_option_declared(self):
        self.assertIn("onAudioSegment?:", self.src)
        self.assertIn("idx: number", self.src)
        self.assertIn("bytes: Uint8Array", self.src)

    def test_onAudioSegment_called_in_both_binary_branches(self):
        # Deve essere invocata sia nel ramo sync (u8) sia in quello async (Blob).
        count = self.src.count("opts.onAudioSegment")
        self.assertGreaterEqual(count, 2, f"found {count} invocations, expected ≥2")

    def test_onAudioSegment_uses_pendingSentence_text_not_sentence(self):
        # Il server pubblica `text` nel header 'sentence'. Il callback
        # DEVE leggere da `pendingSentence.text`, non `.sentence`.
        self.assertIn("pendingSentence.text", self.src)


class TestSanitizePropertyBased(unittest.TestCase):
    """Property-based su 1000 input random — nessun output deve contenere
    `/`, `..`, o altri caratteri path-sensitive."""

    SAFE_RE = re.compile(r"^[A-Za-z0-9_-]+$")

    @staticmethod
    def _sanitize_py(raw: str) -> str:
        s = re.sub(r"[^A-Za-z0-9_-]", "_", raw or "")[:64]
        return s or "_"

    def test_random_inputs_safe(self):
        rnd = random.Random(42)
        alphabet = string.printable + "àèéìòù\u2019\u201C\x00/\\"
        for _ in range(1000):
            n = rnd.randint(0, 120)
            raw = "".join(rnd.choice(alphabet) for _ in range(n))
            out = self._sanitize_py(raw)
            self.assertTrue(self.SAFE_RE.match(out))
            self.assertNotIn("..", out)
            self.assertNotIn("/", out)
            self.assertLessEqual(len(out), 64)


if __name__ == "__main__":
    unittest.main()
