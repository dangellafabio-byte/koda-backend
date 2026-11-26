import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_memory_delivery import PrivateEventDelivery, PrivateDeliveryError


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_text_and_audio(self):
        emit = AsyncMock()
        delivery = PrivateEventDelivery(emit)
        event = {'type': 'sentence', 'text': 'synthetic private fact'}
        await delivery.publish(event, b'audio')
        emit.assert_awaited_once_with(event, b'audio')

    async def test_missing_transport(self):
        with self.assertRaises(PrivateDeliveryError):
            PrivateEventDelivery(None)

    async def test_failure_closes_without_leaking_exception(self):
        emit = AsyncMock(side_effect=ValueError('synthetic secret'))
        delivery = PrivateEventDelivery(emit)
        with self.assertRaises(PrivateDeliveryError) as caught:
            await delivery.publish({'text': 'secret'})
        self.assertNotIn('secret', str(caught.exception))
        self.assertIsNone(caught.exception.__context__)
        with self.assertRaises(PrivateDeliveryError):
            await delivery.publish({})
        emit.assert_awaited_once()

    async def test_cancellation_propagates_and_closes(self):
        emit = AsyncMock(side_effect=asyncio.CancelledError)
        delivery = PrivateEventDelivery(emit)
        with self.assertRaises(asyncio.CancelledError):
            await delivery.publish({})
        with self.assertRaises(PrivateDeliveryError):
            await delivery.publish({})

    async def test_explicit_close(self):
        emit = AsyncMock()
        delivery = PrivateEventDelivery(emit)
        delivery.close()
        with self.assertRaises(PrivateDeliveryError):
            await delivery.publish({})
        emit.assert_not_awaited()
