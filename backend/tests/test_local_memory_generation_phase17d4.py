import json
import unittest
from unittest.mock import AsyncMock
from local_memory_generation import generate_private_reply, PrivateGenerationError
from local_memory_privacy import private_turn


class PrivateGenerationTests(unittest.IsolatedAsyncioTestCase):
    def args(self):
        return dict(system_prompt='Ascolta senza prescrivere scelte.', text='Come va?',
                    raw_context='[{"key":"friend","value":"Teo"}]',
                    generate=AsyncMock(return_value='Ti ascolto.'), provider_approved=True)

    async def test_private_payload_no_cache(self):
        args = self.args()
        with private_turn():
            self.assertEqual(await generate_private_reply(**args), 'Ti ascolto.')
        messages = args['generate'].call_args.kwargs['messages']
        self.assertEqual([m['role'] for m in messages], ['system', 'user'])
        self.assertTrue(all(set(m) == {'role', 'content'} for m in messages))
        self.assertNotIn('Teo', messages[0]['content'])
        self.assertEqual(json.loads(messages[1]['content'])['local_context'][0]['value'], 'Teo')

    async def test_default_and_public_denied(self):
        args = self.args()
        with self.assertRaises(PrivateGenerationError):
            await generate_private_reply(**args)
        args.pop('provider_approved')
        with private_turn(), self.assertRaises(PrivateGenerationError):
            await generate_private_reply(**args)
        args['generate'].assert_not_awaited()

    async def test_invalid_context_never_sent(self):
        for raw in ('[]', '{}', 'x'*2049, '[{"key":"a","value":"x"},{"key":"a","value":"y"}]', '[{"key":"a","value":" "}]'):
            args = self.args(); args['raw_context'] = raw
            with private_turn(), self.assertRaises(PrivateGenerationError):
                await generate_private_reply(**args)
            args['generate'].assert_not_awaited()

    async def test_provider_error_redacted(self):
        args = self.args(); args['generate'].side_effect = RuntimeError('secret')
        with private_turn(), self.assertRaisesRegex(PrivateGenerationError, '^private generation failed$') as cm:
            await generate_private_reply(**args)
        self.assertIsNone(cm.exception.__context__)
