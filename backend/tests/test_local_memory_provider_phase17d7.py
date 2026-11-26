import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from local_memory_provider import approved_generator

class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_approval_and_direct_route(self):
        completion = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Ti ascolto.'))]))
        with patch.dict('os.environ', {}, clear=True):
            self.assertIsNone(approved_generator(completion))
        with patch.dict('os.environ', {'OLLENYA_PRIVATE_PROVIDER_APPROVED':'1','INWORLD_API_KEY':'fake','OLLENYA_LLM_PROVIDER':'emergent'}, clear=True):
            self.assertIsNone(approved_generator(completion))
        with patch.dict('os.environ', {'OLLENYA_PRIVATE_PROVIDER_APPROVED':'1','INWORLD_API_KEY':'fake'}, clear=True):
            generate = approved_generator(completion)
            messages = [{'role':'user','content':'test'}]
            self.assertEqual(await generate(messages=messages), 'Ti ascolto.')
            completion.assert_awaited_once_with(messages=messages,max_tokens=650,timeout=30,stream=False)
