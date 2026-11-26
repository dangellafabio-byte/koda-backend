import ast
import json
import sys
import unittest
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from voice_stream import voice_stream_handler

SERVER = Path(__file__).resolve().parents[1] / "server.py"


class LegacyHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_context_rejected_before_legacy_code(self):
        tree = ast.parse(SERVER.read_text())
        for name in ("api_converse", "_converse_stream_audio_impl"):
            fn = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == name)
            fn.decorator_list = []
            namespace = {"ConverseRequest": object, "Request": object, "Optional": Optional,
                         "HTTPException": HTTPException, "EMERGENT_LLM_KEY": False}
            exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SERVER), "exec"), namespace)
            for value in ("PRIVATE_SENTINEL", {}, [], False, ""):
                with self.subTest(route=name, value=value):
                    with self.assertRaises(HTTPException) as raised:
                        await namespace[name](SimpleNamespace(local_memory_context=value))
                    self.assertEqual(raised.exception.status_code, 403)
                    self.assertNotIn("PRIVATE_SENTINEL", raised.exception.detail)
            with self.assertRaises(HTTPException) as ordinary:
                await namespace[name](SimpleNamespace(local_memory_context=None))
            self.assertEqual(ordinary.exception.status_code, 500)


class VoiceIngressTests(unittest.IsolatedAsyncioTestCase):
    async def dispatch(self, start, *frames):
        ws = SimpleNamespace(
            query_params={}, accept=AsyncMock(), close=AsyncMock(), send_json=AsyncMock(),
            receive_text=AsyncMock(side_effect=[json.dumps(frame) for frame in (start, *frames)]),
        )
        pipeline = AsyncMock()
        server = SimpleNamespace(_current_user_id=ContextVar("uid", default="test-user"),
                                 db=SimpleNamespace(taccuino_profile=SimpleNamespace(
                                     find_one=AsyncMock(return_value={"subscription_tier": "monthly"}))))
        with (patch.dict(sys.modules, {"server": server}),
              patch("voice_stream.run_until_disconnect", new=lambda _, work: work),
              self.assertLogs("voice_stream", "INFO") as logs):
            pipeline.return_value = True
            await voice_stream_handler(ws, pipeline)
        return [call.args[0] for call in ws.send_json.await_args_list], pipeline, logs.output

    async def test_private_start_and_final_stop_before_dispatch(self):
        for start, frames in (
            ({"type": "start", "stt_source": "client_apple", "local_memory_context": "PRIVATE_SENTINEL"}, []),
            ({"type": "start", "stt_source": "client_apple"},
             [{"type": "transcript_from_client", "text": "PRIVATE_SENTINEL", "local_memory_context": False}]),
        ):
            events, pipeline, logs = await self.dispatch(start, *frames)
            self.assertEqual(events[-1]["type"], "error")
            self.assertNotIn("PRIVATE_SENTINEL", repr(events) + repr(logs))
            pipeline.assert_not_awaited()

    async def test_normal_final_reaches_existing_pipeline_without_transcript_in_log(self):
        events, pipeline, logs = await self.dispatch(
            {"type": "start", "stt_source": "client_apple"}, [],
            {"type": "transcript_from_client", "text": "NORMAL_SENTINEL", "local_memory_context": None},
        )
        self.assertEqual([event["type"] for event in events], ["ready", "stt_final", "done"])
        pipeline.assert_awaited_once()
        self.assertEqual(pipeline.await_args.kwargs["text"], "NORMAL_SENTINEL")
        self.assertNotIn("NORMAL_SENTINEL", repr(logs))
