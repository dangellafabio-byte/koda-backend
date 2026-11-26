import ast
import asyncio
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any, Optional, Callable, Awaitable
from unittest.mock import AsyncMock, Mock


class VoiceTransportTests(unittest.IsolatedAsyncioTestCase):
    async def run_turn(self, provider, fail=False, microphone=True):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
        convert = Mock(return_value=[b'audio'], side_effect=RuntimeError() if fail else None)
        inworld = AsyncMock(return_value=b'audio', side_effect=RuntimeError() if fail else None)
        emit, append, done = AsyncMock(), AsyncMock(), AsyncMock()
        scope = dict(Any=Any, Optional=Optional, Callable=Callable, Awaitable=Awaitable, time=time,
                     asyncio=asyncio, is_private_turn=lambda:False, logger=Mock(), current_user_id=lambda:'account',
                     get_or_create_profile=AsyncMock(return_value=NS(settings=NS(), language='it')),
                     _resolve_voice_id=lambda _:'voice', _tts_provider_for_uid=AsyncMock(return_value=provider),
                     _get_eleven_client=lambda:NS(text_to_speech=NS(convert=convert)),
                     _INWORLD_ADAPTER_AVAILABLE=True, _inworld_dispatcher=NS(generate_non_streaming=inworld),
                     _normalize_for_tts_it=lambda x:x, _normalize_loudness_mp3=lambda audio,**kw:audio,
                     _voice_settings_for_tone=lambda *args:{}, db=object(),
                     _fast_session_append=append, _fast_session_mark_done=done)
        for name in ['_fast_pipeline_task','_run_pipeline_for_streamed_text']:
            fn = next(n for n in tree.body if getattr(n,'name',None)==name)
            exec(compile(ast.Module([fn],[]), '<backend>', 'exec'),scope)
        if microphone:
            await scope['_run_pipeline_for_streamed_text']('',False,50,0.1,emit,'session')
            append.assert_not_awaited()
            done.assert_not_awaited()
            events = emit.await_args_list
        else:
            await scope['_fast_pipeline_task']('session','',False,50)
            done.assert_awaited_once()
            events = append.await_args_list
        self.assertEqual([call.args[0 if microphone else 1]['type'] for call in events], ['sentence','meta','done'])
        if microphone:
            self.assertEqual(events[0].args[1], None if fail else b'audio')
        self.assertEqual(convert.call_count, int(provider=='elevenlabs'))
        self.assertEqual(inworld.await_count, int(provider=='inworld'))

    async def test_microphone_single_route(self):
        for provider in ['inworld','elevenlabs']:
            for fail in [False,True]:
                with self.subTest(provider=provider, fail=fail):
                    await self.run_turn(provider,fail)

    async def test_http_poll_keeps_events(self):
        await self.run_turn('elevenlabs',microphone=False)
