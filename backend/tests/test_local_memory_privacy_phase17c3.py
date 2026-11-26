import ast
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from local_memory_privacy import private_turn, require_public_persistence, PrivatePersistenceError

METHODS = {'insert_one','insert_many','update_one','update_many','replace_one','delete_one','delete_many','bulk_write','find_one_and_update','find_one_and_delete','find_one_and_replace'}

class DirectPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_direct_taccuino_writes_guarded(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
        parents = {c:n for n in ast.walk(tree) for c in ast.iter_child_nodes(n)}
        count = 0
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call) or not isinstance(n.func, ast.Attribute) or n.func.attr not in METHODS:
                continue
            v = n.func.value
            if not (isinstance(v, ast.Attribute) and isinstance(v.value, ast.Name) and v.value.id == 'db' and v.attr.startswith('taccuino')):
                continue
            stmt = n
            while not isinstance(stmt, ast.stmt):
                stmt = parents[stmt]
            siblings = next(x for _, x in ast.iter_fields(parents[stmt]) if isinstance(x,list) and stmt in x)
            idx = siblings.index(stmt)
            self.assertGreater(idx, 0)
            guard = siblings[idx-1]
            self.assertEqual(ast.unparse(guard), 'require_public_persistence()')
            # Execute the actual guard followed by a synthetic write; no production DB.
            db = AsyncMock()
            scope = {'require_public_persistence':require_public_persistence, 'write':db}
            code = ast.parse('async def run():\n    require_public_persistence()\n    await write()')
            code.body[0].body[0] = guard
            exec(compile(ast.fix_missing_locations(code), '<guard>', 'exec'), scope)
            with private_turn(), self.assertRaises(PrivatePersistenceError):
                await scope['run']()
            db.assert_not_awaited()
            await scope['run']()
            db.assert_awaited_once()
            count += 1
        self.assertGreaterEqual(count, 60)
