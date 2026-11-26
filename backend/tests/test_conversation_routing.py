import ast
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_explicit_and_invalid_routes(self):
        source = Path(__file__).resolve().parents[1] / "server.py"
        tree = ast.parse(source.read_text())
        function = next(node for node in tree.body
                        if getattr(node, "name", "") == "_claude_acompletion")
        direct = AsyncMock()
        proxy = AsyncMock()
        scope = dict(os=os, _inworld_acompletion=direct,
                     CLAUDE_PROXY_MODEL_ID="test", _claude_extra_body=lambda messages: {})
        exec(compile(ast.Module([function], []), str(source), "exec"), scope)
        with patch.dict(os.environ, {}, clear=True), patch.dict("sys.modules", {"litellm": proxy}):
            call = scope["_claude_acompletion"]
            await call(messages=[])
            direct.assert_awaited_once()
            os.environ["OLLENYA_LLM_PROVIDER"] = "inwrold"
            with self.assertRaises(ValueError):
                await call(messages=[])
            direct.assert_awaited_once()
            proxy.acompletion.assert_not_awaited()
            os.environ["OLLENYA_LLM_PROVIDER"] = "emergent"
            await call(messages=[])
            proxy.acompletion.assert_awaited_once()
