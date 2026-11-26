import ast
import asyncio
import io
import logging
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from local_memory_privacy import private_turn, is_private_turn, install_private_log_filter

class PrivacyBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_logs_concurrent(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger('ollenya.test.private')
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        try:
            install_private_log_filter()
            async def private():
                with private_turn():
                    await asyncio.sleep(0)
                    logger.error('private payload', exc_info=True)
            async def public():
                await asyncio.sleep(0)
                logger.info('public payload')
            await asyncio.gather(private(), public())
            self.assertNotIn('private payload', stream.getvalue())
            self.assertIn('public payload', stream.getvalue())
        finally:
            logger.removeHandler(handler)
            handler.close()

    async def test_tavily_boundaries(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
        for name in ('api_search', '_tavily_search_brief'):
            node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
            node.decorator_list = []
            class HTTPException(Exception):
                def __init__(self, **kwargs): self.status_code = kwargs['status_code']
            client = AsyncMock()
            profile = AsyncMock()
            scope = dict(is_private_turn=is_private_turn, HTTPException=HTTPException,
                         _tavily_client=client, get_or_create_profile=profile,
                         SearchRequest=object, Optional=__import__('typing').Optional)
            exec(compile(ast.Module(body=[node], type_ignores=[]), '<server>', 'exec'), scope)
            with private_turn():
                if name == 'api_search':
                    with self.assertRaises(HTTPException) as err:
                        await scope[name](object())
                    self.assertEqual(err.exception.status_code, 403)
                else:
                    self.assertIsNone(await scope[name]('private payload'))
            client.search.assert_not_awaited()
            profile.assert_not_awaited()
