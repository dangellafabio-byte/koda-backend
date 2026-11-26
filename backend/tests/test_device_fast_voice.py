import asyncio
import base64
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from local_memory_voice import account_audio
from local_memory_privacy import is_private_turn
from test_device_text import handler


class FastVoiceTests(unittest.IsolatedAsyncioTestCase):
    async def turn(self, tier='monthly', allowed='elevenlabs', fail=False):
        class Entry(dict):
            def model_dump(self, **kwargs):
                return self
        class Database(dict):
            pass
        db = Database(koda_tts_provider_prefs=NS(find_one=AsyncMock(return_value={'provider':'elevenlabs', 'voice_id':'cielo'})))
        uid = 'account'
        db.sessions = NS(find_one=AsyncMock(return_value={'email':'owner@example.org',
                         'expires_at':datetime.now(timezone.utc)+timedelta(hours=1)}))
        db.taccuino_profile = NS(find_one=AsyncMock(return_value={'id':uid,'subscription_tier':tier}),
                                 update_one=AsyncMock(return_value=NS(matched_count=1)))
        async def generate(**kwargs):
            self.assertTrue(is_private_turn())
            self.assertIn('Bari',kwargs['messages'][1]['content'])
            return NS(choices=[NS(message=NS(content=json.dumps({'reply':'Vivi a Bari.'})))])
        llm = AsyncMock(side_effect=generate)
        audio = b'mocked audio'
        convert = Mock(return_value=[audio],side_effect=RuntimeError('sensitive') if fail else None)
        profile = NS(id=uid, subscription_tier=tier, settings=NS(ai_enabled=True,voice_response=True),
                     language='it',ai_name='Ollenya',ai_gender='f')
        scope = dict(Request=object, HTTPException=HTTPException, os=os, db=db, _email_to_uid=lambda _:uid,
                     current_user_id=lambda:uid, Profile=Mock(return_value=profile),_compute_paid_state=lambda _:'active',
                     _check_text_rate_limit=lambda _:True, logger=Mock(), TimelineEntry=Entry,
                     _build_conversation_system_prompt=lambda *a,**k:'Ollenya',_inworld_acompletion=llm,
                     _resolve_voice_id=lambda _:'cielo', _get_eleven_client=lambda:NS(text_to_speech=NS(convert=convert)),
                     _estimate_mp3_duration_seconds=lambda _:2, asyncio=asyncio, base64=base64,
                     ConverseRequest=lambda text:NS(text=text,local_memory_context=None,ephemeral=False,demo_mode=False))
        for name in ['_device_audio','api_converse','api_device_memory_text','api_device_memory_voice']:
            fn = handler(name,scope)
        req = NS(state=NS(),headers={'authorization':'Bearer test'}, json=AsyncMock(return_value={
            'text':'Dove abito?', 'context':'[{"key":"home.city","value":"Bari"}]'}))
        with patch.dict(os.environ, {'OLLENYA_LOCAL_MEMORY_TEXT':'1','OLLENYA_LOCAL_MEMORY_VOICE':'1',
                        'OLLENYA_PRIVATE_PROVIDER_APPROVED':'1','INWORLD_API_KEY':'test',
                        'OLLENYA_PRIVATE_TTS_PROVIDER':allowed},clear=True):
            if tier=='monthly' and allowed=='elevenlabs' and not fail:
                resp = await fn(req)
                body = json.loads(resp.body)
                self.assertEqual(base64.b64decode(body['audio_mp3']), audio)
                self.assertEqual(resp.headers['cache-control'],'no-store')
                self.assertEqual(body['ai_entry']['text'],'Vivi a Bari.')
                convert.assert_called_once()
                self.assertEqual(convert.call_args.kwargs['voice_id'],'POuqf18evoXOKIqV2Px7')
                db.taccuino_profile.update_one.assert_awaited_once()
            else:
                with self.assertRaises(HTTPException) as error:
                    await fn(req)
                self.assertEqual(error.exception.status_code,402 if tier=='free' else 503)
                if not fail:
                    llm.assert_not_awaited()
                    convert.assert_not_called()
                else:
                    convert.assert_called_once()
                db.taccuino_profile.update_one.assert_not_awaited()

    async def test_fast_voice(self):
        await self.turn()

    async def test_free_account(self):
        await self.turn(tier='free')

    async def test_unapproved_voice(self):
        await self.turn(allowed='inworld')

    async def test_failed_audio_no_retry(self):
        await self.turn(fail=True)

    async def test_quota_conflict_reloads(self):
        collection = NS(find_one=AsyncMock(return_value={'subscription_tier':'monthly'}),
                        update_one=AsyncMock(side_effect=[NS(matched_count=0),NS(matched_count=1)]))
        await account_audio(collection,'uid',12)
        self.assertEqual(collection.find_one.await_count,2)
        for call in collection.update_one.await_args_list:
            self.assertEqual(call.args[0]['id'],'uid')
            self.assertIn('ledger_state',call.args[0])
            self.assertEqual(call.args[1]['$inc']['minutes_used_this_month'],0.2)
