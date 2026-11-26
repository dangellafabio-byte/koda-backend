import asyncio
import unittest
from local_memory_turn import run_private_turn, PrivateTurnError
from local_memory_privacy import is_private_turn, require_public_persistence, PrivatePersistenceError
from local_memory_delivery import PrivateDeliveryError


class TurnTests(unittest.IsolatedAsyncioTestCase):
    def args(self, work, emit):
        return dict(verified_uid='a', account_uid='a', ephemeral=False,
                    demo=False, enabled=True, emit=emit, work=work)

    async def test_direct_and_guard(self):
        events = []
        async def emit(event, audio):
            self.assertTrue(is_private_turn())
            events.append((event, audio))
        async def work(publish):
            with self.assertRaises(PrivatePersistenceError):
                require_public_persistence()
            await publish({'type': 'sentence'}, b'audio')
            events.append(publish)
        await run_private_turn(**self.args(work, emit))
        self.assertFalse(is_private_turn())
        self.assertEqual(events[0], ({'type': 'sentence'}, b'audio'))
        with self.assertRaises(PrivateDeliveryError):
            await events[1]({})

    async def test_reject_before_work(self):
        async def never(*args):
            self.fail('unexpected invocation')
        for key, value in [('verified_uid', None), ('verified_uid', 'me'),
                           ('account_uid', 'b'), ('enabled', False),
                           ('ephemeral', True), ('demo', True), ('emit', None)]:
            args = self.args(never, never)
            args[key] = value
            with self.assertRaises(PrivateTurnError):
                await run_private_turn(**args)

    async def test_error_and_cancellation(self):
        async def emit(*args):
            raise ValueError('private secret')
        async def work(publish):
            await publish({})
        with self.assertRaises(PrivateTurnError) as err:
            await run_private_turn(**self.args(work, emit))
        self.assertIsNone(err.exception.__context__)
        self.assertFalse(is_private_turn())
        async def cancel(publish):
            raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await run_private_turn(**self.args(cancel, emit))
        self.assertFalse(is_private_turn())
