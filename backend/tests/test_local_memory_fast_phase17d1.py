import ast
import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

class HTTPError(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        super().__init__(detail)

class FastIngressTests(unittest.IsolatedAsyncioTestCase):
    def scope(self, name):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
        node.decorator_list = []
        scope = dict(FastStartRequest=object, WebSocket=object, HTTPException=HTTPError,
                     asyncio=asyncio, json=json, EMERGENT_LLM_KEY=False,
                     _ensure_fast_session_indexes=AsyncMock(), _fast_session_create=AsyncMock(),
                     _fast_pipeline_task=AsyncMock(), WebSocketDisconnect=type('Disconnect', (Exception,), {}),
                     logger=SimpleNamespace(info=lambda *a: None, error=lambda *a: None))
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<server>', 'exec'), scope)
        return scope

    async def test_http_rejects_before_storage(self):
        scope = self.scope('api_converse_fast_start')
        for payload in ('secret', {}, [], False, ''):
            with self.assertRaises(HTTPError) as err:
                await scope['api_converse_fast_start'](SimpleNamespace(local_memory_context=payload))
            self.assertEqual(err.exception.status_code, 403)
            self.assertNotIn('secret', str(err.exception))
        with self.assertRaises(HTTPError) as err:
            await scope['api_converse_fast_start'](SimpleNamespace(local_memory_context=None))
        self.assertEqual(err.exception.status_code, 500)
        for name in ('_ensure_fast_session_indexes', '_fast_session_create', '_fast_pipeline_task'):
            scope[name].assert_not_awaited()

    async def test_ws_rejects_before_storage(self):
        scope = self.scope('_converse_ws_handler')
        for payload in ('secret', {}, [], False, ''):
            ws = SimpleNamespace(accept=AsyncMock(), close=AsyncMock(), send_json=AsyncMock(),
                                 receive_text=AsyncMock(return_value=json.dumps({'text':'hello', 'local_memory_context':payload})))
            await scope['_converse_ws_handler'](ws)
            ws.send_json.assert_awaited_once_with({'type':'error','message':'Local memory unavailable on fast transport'})
            ws.close.assert_awaited_once()
        for name in ('_ensure_fast_session_indexes', '_fast_session_create', '_fast_pipeline_task'):
            scope[name].assert_not_awaited()
