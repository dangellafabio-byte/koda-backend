import ast
import unittest
from pathlib import Path
from typing import Any, Optional
from local_memory_privacy import private_turn, is_private_turn


class FastPrivateBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_pipeline_rejects_private_before_any_side_effect(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                    and n.name == '_fast_pipeline_task')
        scope = dict(Any=Any, Optional=Optional, is_private_turn=is_private_turn)
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<server>', 'exec'), scope)
        # No time, DB, provider or logger is supplied: reaching any of them fails.
        with private_turn():
            with self.assertRaisesRegex(RuntimeError, '^Private fast pipeline unavailable$'):
                await scope['_fast_pipeline_task']('session', 'private', False, None)
        self.assertFalse(is_private_turn())
