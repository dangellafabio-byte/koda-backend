import asyncio
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from local_memory_ws_generation import run_private_ws_generation
from local_memory_turn import PrivateTurnError
from local_memory_privacy import is_private_turn


class PrivateWSGenerationTests(unittest.IsolatedAsyncioTestCase):
    def args(self):
        ws = SimpleNamespace(headers={'authorization': 'Bearer valid'}, cookies={},
                             send_json=AsyncMock(), send_bytes=AsyncMock())
        sessions = SimpleNamespace(find_one=AsyncMock(return_value={
            'email': 'user@example.com', 'expires_at': datetime.now(timezone.utc)+timedelta(hours=1)}))
        async def generate(**kwargs):
            self.assertTrue(is_private_turn())
            return 'Ti ascolto.'
        return dict(websocket=ws, sessions=sessions, email_to_uid=lambda e: 'account',
                    account_uid='account', enabled=True, system_prompt='Ascolta.',
                    text='Ciao', raw_context='[{"key":"friend","value":"Teo"}]',
                    generate=AsyncMock(side_effect=generate), provider_approved=True)

    async def test_composition(self):
        a = self.args()
        await run_private_ws_generation(**a)
        a['generate'].assert_awaited_once()
        events = [c.args[0] for c in a['websocket'].send_json.call_args_list]
        self.assertEqual([e['type'] for e in events], ['meta', 'done'])
        self.assertEqual(events[0]['reply'], 'Ti ascolto.')
        a['websocket'].send_bytes.assert_not_awaited()
        self.assertFalse(is_private_turn())

    async def test_denials(self):
        for change in ({'enabled':False}, {'provider_approved':False}, {'demo':True},
                       {'ephemeral':True}, {'account_uid':'other'}, {'raw_context':'[]'}):
            a = self.args(); a.update(change)
            with self.assertRaises(PrivateTurnError):
                await run_private_ws_generation(**a)
            a['generate'].assert_not_awaited()
            a['websocket'].send_json.assert_not_awaited()
            self.assertFalse(is_private_turn())

    async def test_expired_session(self):
        a = self.args()
        a['sessions'].find_one.return_value['expires_at'] = datetime.now(timezone.utc)-timedelta(seconds=1)
        with self.assertRaises(PrivateTurnError):
            await run_private_ws_generation(**a)
        a['generate'].assert_not_awaited()

    async def test_provider_failure(self):
        a = self.args(); a['generate'].side_effect = RuntimeError('secret')
        with self.assertRaisesRegex(PrivateTurnError, '^private turn failed$') as cm:
            await run_private_ws_generation(**a)
        self.assertIsNone(cm.exception.__context__)
        a['websocket'].send_json.assert_not_awaited()

    async def test_disconnect(self):
        a = self.args(); a['websocket'].send_json.side_effect = RuntimeError('secret')
        with self.assertRaises(PrivateTurnError):
            await run_private_ws_generation(**a)
        a['websocket'].send_json.assert_awaited_once()
        self.assertFalse(is_private_turn())

    async def test_cancellation(self):
        a = self.args(); a['generate'].side_effect = asyncio.CancelledError
        with self.assertRaises(asyncio.CancelledError):
            await run_private_ws_generation(**a)
        a['websocket'].send_json.assert_not_awaited()
        self.assertFalse(is_private_turn())
