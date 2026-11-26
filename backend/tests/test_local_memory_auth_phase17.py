import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from local_memory_auth import verified_memory_uid, request_token

class Sessions:
    def __init__(self, record): self.record = record
    async def find_one(self, query):
        if query != {'session_token': 'valid'}: return None
        if isinstance(self.record, Exception): raise self.record
        return self.record

class AuthTests(unittest.TestCase):
    def check(self, record, token='valid'):
        return asyncio.run(verified_memory_uid(Sessions(record), token, lambda email: 'uid:'+email))
    def test_sessions(self):
        now = datetime.now(timezone.utc)
        valid = {'email':' A@example.com ', 'expires_at':now+timedelta(hours=1)}
        self.assertEqual(self.check(valid), 'uid:a@example.com')
        for record in (None, RuntimeError(), {**valid,'expires_at':now}, {**valid,'expires_at':None}, {**valid,'email':'dev@koda.local'}, {**valid,'email':''}):
            with self.subTest(record=record): self.assertIsNone(self.check(record))
        for token in (None, '', 'wrong', 123): self.assertIsNone(self.check(valid, token))
    def test_no_header_fallback(self):
        self.assertIsNone(request_token(SimpleNamespace(headers={'x-user-id':'uid'},cookies={})))
        self.assertEqual(request_token(SimpleNamespace(headers={'authorization':'Bearer valid'},cookies={})), 'valid')
        self.assertIsNone(request_token(SimpleNamespace(headers={'authorization':'Basic invalid'},cookies={'session_token':'valid'})))

if __name__ == '__main__': unittest.main()
