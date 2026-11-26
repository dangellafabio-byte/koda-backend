import asyncio
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from local_memory_ws import run_private_ws
from local_memory_turn import PrivateTurnError
from local_memory_privacy import is_private_turn


class PrivateWSTests(unittest.IsolatedAsyncioTestCase):
    def setup_args(self):
        self.ws = SimpleNamespace(headers={'authorization':'Bearer valid'}, cookies={},
                                  send_json=AsyncMock(), send_bytes=AsyncMock())
        self.sessions = SimpleNamespace(find_one=AsyncMock(return_value={
            'email':'user@example.com', 'expires_at':datetime.now(timezone.utc)+timedelta(hours=1)}))
        return dict(websocket=self.ws, sessions=self.sessions, email_to_uid=lambda e:'account',
                    account_uid='account', enabled=True, ephemeral=False, demo=False)

    async def test_direct_delivery(self):
        args = self.setup_args()
        async def work(publish):
            self.assertTrue(is_private_turn())
            await publish({'type':'sentence','text':'private'}, b'audio')
        await run_private_ws(**args, work=work)
        self.sessions.find_one.assert_awaited_once_with({'session_token':'valid'})
        self.ws.send_bytes.assert_awaited_once_with(b'audio')
        self.assertEqual(self.ws.send_json.call_args.args[0]['audio_bytes'], 5)
        self.assertFalse(is_private_turn())

    async def test_denials(self):
        for change in ({'enabled':False}, {'ephemeral':True}, {'demo':True}, {'account_uid':'other'}):
            args = self.setup_args(); args.update(change)
            work = AsyncMock()
            with self.assertRaises(PrivateTurnError):
                await run_private_ws(**args, work=work)
            work.assert_not_awaited(); self.ws.send_json.assert_not_awaited()

    async def test_disconnect(self):
        args = self.setup_args()
        self.ws.send_json.side_effect = RuntimeError('private secret')
        async def work(publish):
            await publish({'type':'sentence'}, b'audio')
        with self.assertRaisesRegex(PrivateTurnError, '^private turn failed$'):
            await run_private_ws(**args, work=work)
        self.ws.send_bytes.assert_not_awaited()
        self.assertFalse(is_private_turn())

    async def test_concurrent_frames(self):
        args = self.setup_args(); order = []
        async def header(event):
            order.append(('header',event['i'])); await asyncio.sleep(0)
        async def binary(data):
            order.append(('binary',data)); await asyncio.sleep(0)
        self.ws.send_json.side_effect = header; self.ws.send_bytes.side_effect = binary
        async def work(publish):
            await asyncio.gather(*(publish({'type':'sentence','i':i},bytes([i])) for i in range(2)))
        await run_private_ws(**args, work=work)
        self.assertEqual(order,[('header',0),('binary',b'\x00'),('header',1),('binary',b'\x01')])
