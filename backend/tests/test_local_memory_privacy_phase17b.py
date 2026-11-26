"""Static regression guard: private context must not reach active pipelines."""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class PrivacyHoldTests(unittest.TestCase):
    def test_no_active_context_consumers(self):
        for filename in ('server.py', 'voice_stream.py'):
            tree = ast.parse((ROOT / filename).read_text())
            # Permit only the exact fail-closed ingress predicates, not consumers.
            allowed = set()
            ingress = {
                'api_converse_fast_start', '_converse_ws_handler', 'api_converse',
                '_converse_stream_audio_impl', 'voice_stream_handler',
            }
            predicates = {
                'req.local_memory_context is not None',
                "req.get('local_memory_context') is not None",
                "start_req.get('local_memory_context') is not None",
                "msg.get('local_memory_context') is not None",
            }
            for fn in tree.body:
                if isinstance(fn, ast.AsyncFunctionDef) and fn.name in ingress:
                    for candidate in ast.walk(fn):
                        if isinstance(candidate, ast.If) and ast.unparse(candidate.test) in predicates:
                            allowed.update(ast.walk(candidate.test))
            for node in ast.walk(tree):
                if node in allowed:
                    continue
                with self.subTest(file=filename, line=getattr(node, 'lineno', 0)):
                    if isinstance(node, ast.Call):
                        self.assertNotEqual(getattr(node.func, 'id', None), '_local_memory_context_for_turn')
                    if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
                        self.assertNotEqual(node.attr, 'local_memory_context')
                    if isinstance(node, ast.Constant) and isinstance(node.value, str):
                        self.assertNotEqual(node.value, 'local_memory_context')

if __name__ == '__main__':
    unittest.main()
