"""Execute production functions with fake providers/DB; no server startup or API calls.

Run: python -m unittest discover -s backend/tests -p test_tts_switch_regression_offline.py
"""
import ast
import asyncio
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import time
import unittest
from unittest.mock import AsyncMock, Mock

SOURCE = Path(os.environ.get('VOICE_REVIEW_SOURCE', str(Path(__file__).resolve().parents[1] / 'server.py')))

class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(str(detail))


def functions(*names, **extra):
    tree = ast.parse(SOURCE.read_text())
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    for n in nodes:
        n.decorator_list = []
    code = 'from __future__ import annotations\n' + ast.unparse(ast.Module(body=nodes, type_ignores=[]))
    ns = dict(asyncio=asyncio, time=time, logger=logging.getLogger('offline'), HTTPException=HTTPException)
    ns.update(extra)
    exec(compile(code, str(SOURCE), 'exec'), ns)
    return ns


class ResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_switch_both_ways_and_default(self):
        collection = SimpleNamespace(find_one=AsyncMock(return_value=None))
        ns = functions('_tts_provider_for_uid', db={'koda_tts_provider_prefs': collection}, _INWORLD_ADAPTER_AVAILABLE=True)
        resolve = ns['_tts_provider_for_uid']
        self.assertEqual(await resolve('control'), 'elevenlabs')
        collection.find_one.return_value = {'provider': 'inworld'}
        self.assertEqual(await resolve('review'), 'inworld')
        collection.find_one.return_value = {'provider': 'elevenlabs'}
        self.assertEqual(await resolve('review'), 'elevenlabs')

    async def test_database_error_never_silently_changes_provider(self):
        collection = SimpleNamespace(find_one=AsyncMock(side_effect=RuntimeError('offline')))
        ns = functions('_tts_provider_for_uid', db={'koda_tts_provider_prefs': collection}, _INWORLD_ADAPTER_AVAILABLE=True)
        with self.assertRaises(HTTPException) as err:
            await ns['_tts_provider_for_uid']('review')
        self.assertEqual(err.exception.status_code, 503)

    async def test_missing_adapter_fails_only_for_inworld_preference(self):
        collection = SimpleNamespace(find_one=AsyncMock(return_value={'provider':'inworld'}))
        ns = functions('_tts_provider_for_uid', db={'koda_tts_provider_prefs': collection}, _INWORLD_ADAPTER_AVAILABLE=False)
        with self.assertRaises(HTTPException):
            await ns['_tts_provider_for_uid']('review')
        collection.find_one.return_value = None
        self.assertEqual(await ns['_tts_provider_for_uid']('control'), 'elevenlabs')


class SynthesisTests(unittest.IsolatedAsyncioTestCase):
    def setup_ns(self, provider='inworld', error=None):
        iw = AsyncMock(return_value=b'inworld-mp3', side_effect=error)
        convert = Mock(return_value=[b'eleven-mp3'])
        el = Mock(return_value=SimpleNamespace(text_to_speech=SimpleNamespace(convert=convert)))
        ns = functions('api_tts', 'api_tts_prepare', '_fast_pipeline_task',
            _INWORLD_ADAPTER_AVAILABLE=True,
            _tts_provider_for_current_user=AsyncMock(return_value=provider),
            _tts_provider_for_uid=AsyncMock(return_value=provider),
            _inworld_dispatcher=SimpleNamespace(generate_non_streaming=iw, InworldVoiceNotAvailable=type("VoiceUnavailable", (Exception,), {})),
            _inworld_tts=SimpleNamespace(InworldTTSError=RuntimeError),
            _get_eleven_client=el, get_or_create_profile=AsyncMock(return_value=None),
            _voice_settings_for_tone=lambda *args: {}, current_user_id=lambda: 'review',
            _resolve_voice_id=lambda p: 'cielo', _normalize_for_tts_it=lambda text: text,
            _normalize_loudness_mp3=lambda data, **kw: data,
            _fast_session_append=AsyncMock(), _fast_session_mark_done=AsyncMock(),
            _store_tts_audio=AsyncMock(return_value='test-token'), db={},
            Response=lambda **kw: SimpleNamespace(**kw),
        )
        return ns, iw, el, convert

    async def test_http_inworld_paths_do_not_initialize_elevenlabs(self):
        for endpoint in ('api_tts', 'api_tts_prepare'):
            with self.subTest(endpoint=endpoint):
                ns, iw, el, _ = self.setup_ns()
                req = SimpleNamespace(text='Ciao', voice_id='cielo', tone='calm', stability=None, similarity_boost=None)
                result = await ns[endpoint](req)
                iw.assert_awaited_once()
                el.assert_not_called()

    async def test_short_transcript_inworld_calls_exactly_one_provider(self):
        ns, iw, el, convert = self.setup_ns()
        events = []
        async def emit(event, audio_bytes=None): events.append((event, audio_bytes))
        await ns['_fast_pipeline_task']('test-session', 'sì', True, 100, emit=emit, authed_uid='review')
        iw.assert_awaited_once()
        el.assert_not_called()
        convert.assert_not_called()
        self.assertTrue(any(data == b'inworld-mp3' for _, data in events))

    async def test_short_transcript_elevenlabs_calls_exactly_one_provider(self):
        ns, iw, el, convert = self.setup_ns('elevenlabs')
        await ns['_fast_pipeline_task']('test-session', 'sì', True, 100, authed_uid='control')
        iw.assert_not_awaited()
        el.assert_called_once()
        convert.assert_called_once()

    async def test_inworld_error_is_published_without_elevenlabs_fallback(self):
        ns, iw, el, convert = self.setup_ns(error=RuntimeError('fake failure'))
        events = []
        async def emit(event, audio_bytes=None): events.append(event)
        await ns['_fast_pipeline_task']('test-session', 'sì', True, 100, emit=emit, authed_uid='review')
        iw.assert_awaited_once()
        el.assert_not_called()
        self.assertTrue(any(e['type'] == 'error' and e.get('provider') == 'inworld' for e in events))
        self.assertFalse(any(e['type'] == 'sentence' for e in events))


if __name__ == '__main__':
    unittest.main()
