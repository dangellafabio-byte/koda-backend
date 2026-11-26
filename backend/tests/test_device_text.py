import ast
import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from local_memory_privacy import is_private_turn, private_turn
from local_memory_text import private_text_reply


def handler(name, scope):
    source = Path(__file__).resolve().parents[1] / 'server.py'
    tree = ast.parse(source.read_text())
    fn = next(node for node in tree.body if getattr(node, 'name', '') == name)
    fn.decorator_list = []
    exec(compile(ast.Module([fn], []), str(source), 'exec'), scope)
    return scope[name]


class TextTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_before_auth_or_body(self):
        fn = handler('api_device_memory_text', dict(Request=object, os=os, HTTPException=HTTPException))
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(HTTPException) as err:
            await fn(None)
        self.assertEqual(err.exception.status_code, 503)

    async def test_production_handler_returns_without_legacy_sinks(self):
        class Entry(dict):
            def model_dump(self, **kwargs):
                return self

        async def generate(**kwargs):
            self.assertTrue(is_private_turn())
            self.assertEqual(kwargs['max_tokens'], 800)
            self.assertIn('Nina', kwargs['messages'][1]['content'])
            return NS(choices=[NS(message=NS(content=json.dumps({'reply':'Si chiama Nina.'})))])
        token = 'local-test'
        uid = 'account-a'
        sessions = NS(find_one=AsyncMock())
        from datetime import datetime, timezone, timedelta
        sessions.find_one.return_value = {'email':'a@example.org', 'expires_at':datetime.now(timezone.utc)+timedelta(hours=1)}
        profiles = NS(find_one=AsyncMock(return_value={'id':uid}))
        profile = NS(id=uid, language='it', ai_name='Ollenya', ai_gender='f', subscription_tier='annual',
                     settings=NS(ai_enabled=True))
        scope = dict(Request=object, HTTPException=HTTPException, os=os, _inworld_acompletion=generate,
                     db=NS(sessions=sessions, taccuino_profile=profiles), current_user_id=lambda:uid,
                     _email_to_uid=lambda _:uid, Profile=Mock(return_value=profile),
                     _build_conversation_system_prompt=lambda *a,**k:'Rispondi in JSON.',
                     _check_text_rate_limit=lambda _:True, logger=Mock(), TimelineEntry=Entry,
                     _free_gate=NS(get_free_config=AsyncMock(),check_and_increment_premium_turn=AsyncMock(return_value=(False,'disabled',{}))),
                     ConverseRequest=lambda text:NS(text=text, ephemeral=False, demo_mode=False, is_voice_turn=False, local_memory_context=None))
        handler('api_converse', scope)
        fn = handler('api_device_memory_text', scope)
        request = NS(headers={'authorization':'Bearer '+token},state=NS(),json=AsyncMock(return_value={
            'text':'Come si chiama?', 'context':'[{"key":"pet.name","value":"Nina"}]'}))
        with patch.dict(os.environ, {'OLLENYA_LOCAL_MEMORY_TEXT':'1','OLLENYA_PRIVATE_PROVIDER_APPROVED':'1','INWORLD_API_KEY':'placeholder'}, clear=True):
            response = await fn(request)
        self.assertEqual(json.loads(response.body)['ai_entry']['text'], 'Si chiama Nina.')
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertFalse(is_private_turn())
        projection = profiles.find_one.await_args.args[1]
        self.assertNotIn('memory_summary', projection)
        self.assertNotIn('core_traits', projection)

    async def test_invalid_reply_and_empty_context(self):
        fake = AsyncMock(return_value=NS(choices=[NS(message=NS(content='{}'))]))
        with private_turn(), self.assertRaises(ValueError):
            await private_text_reply('Ciao','[]','system',fake,250)
        self.assertEqual(fake.await_args.kwargs['messages'][1]['content'],'Ciao')
