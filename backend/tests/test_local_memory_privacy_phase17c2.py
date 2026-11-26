import ast
import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from local_memory_privacy import private_turn, require_public_persistence, PrivatePersistenceError


class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_sink_functions_block_before_database(self):
        source = Path(__file__).resolve().parents[1] / 'server.py'
        names = {'save_profile', '_store_tts_audio', '_fast_session_create', '_fast_session_append', '_fast_session_mark_done'}
        tree = ast.parse(source.read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
        self.assertEqual({n.name for n in nodes}, names)
        for n in nodes:
            n.returns = None
            for arg in n.args.args:
                arg.annotation = None
        db = AsyncMock()
        scope = {'require_public_persistence': require_public_persistence, 'db': db}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), scope)
        with private_turn():
            for n in nodes:
                with self.subTest(sink=n.name), self.assertRaises(PrivatePersistenceError):
                    await scope[n.name](*[None for _ in n.args.args])
        self.assertEqual(db.mock_calls, [])

    async def test_task_isolation_and_inheritance(self):
        async def check():
            require_public_persistence()
        public = asyncio.create_task(check())
        with private_turn():
            child = asyncio.create_task(check())
            with self.assertRaises(PrivatePersistenceError):
                await child
            await public
        require_public_persistence()

    async def test_reset_after_exception_and_nested_scope(self):
        with self.assertRaises(ValueError):
            with private_turn():
                with private_turn():
                    pass
                with self.assertRaises(PrivatePersistenceError):
                    require_public_persistence()
                raise ValueError()
        require_public_persistence()
