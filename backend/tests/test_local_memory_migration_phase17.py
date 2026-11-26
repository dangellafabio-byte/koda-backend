import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from local_memory_migration import import_candidates


class ImportCandidatesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.session = {
            "email": "a@example.test",
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
        }
        self.db = SimpleNamespace(
            sessions=SimpleNamespace(find_one=AsyncMock(return_value=self.session)),
            taccuino_memories=self.collection([{"concept": " Milano "}, {"concept": "x" * 1001}]),
            taccuino_key_facts=self.collection([{"fact": "Milano"}, {"fact": "Suona la chitarra"}]),
        )

    @staticmethod
    def collection(rows):
        cursor = Mock()
        cursor.sort.return_value = cursor
        cursor.to_list = AsyncMock(return_value=rows)
        return SimpleNamespace(find=Mock(return_value=cursor))

    async def test_reads_strict_owner_only_and_exposes_bounded_text(self):
        uid = lambda email: "uid:" + email
        self.assertEqual(await import_candidates(self.db, "token", uid), ["Milano", "Suona la chitarra"])
        self.db.sessions.find_one.assert_awaited_once_with({"session_token": "token"})
        self.db.taccuino_memories.find.assert_called_once_with(
            {"profile_id": "uid:a@example.test", "source": "chat"}, {"_id": 0, "concept": 1},
        )
        self.db.taccuino_key_facts.find.assert_called_once_with(
            {"profile_id": "uid:a@example.test"}, {"_id": 0, "fact": 1},
        )
        self.db.taccuino_memories.find.return_value.to_list.assert_awaited_once_with(100)

    async def test_unverified_expired_dev_and_fallback_uid_never_query_memory(self):
        uid = lambda email: "uid:" + email
        self.assertIsNone(await import_candidates(self.db, None, uid))
        self.assertIsNone(await import_candidates(self.db, "token", lambda _: "me"))
        self.session["email"] = "dev@koda.local"
        self.assertIsNone(await import_candidates(self.db, "token", uid))
        self.session["email"] = "a@example.test"
        self.session["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.assertIsNone(await import_candidates(self.db, "token", uid))
        self.db.taccuino_memories.find.assert_not_called()
        self.db.taccuino_key_facts.find.assert_not_called()
