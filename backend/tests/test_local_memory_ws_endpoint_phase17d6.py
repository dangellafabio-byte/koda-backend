import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from datetime import datetime, timezone, timedelta
from local_memory_ws_endpoint import dispatch_private_ws

class EndpointTests(unittest.IsolatedAsyncioTestCase):
    def setup_args(self):
        ws = SimpleNamespace(headers={'authorization':'Bearer valid'}, cookies={}, send_json=AsyncMock())
        sessions = SimpleNamespace(find_one=AsyncMock(return_value={'email':'a@example.com','expires_at':datetime.now(timezone.utc)+timedelta(hours=1)}))
        req = dict(account_uid='account', text='Ciao', local_memory_context='[{"key":"friend","value":"Teo"}]')
        args = dict(sessions=sessions, email_to_uid=lambda e:'account', generate=AsyncMock(return_value='Ti ascolto.'), system_prompt='Ascolta.', provider_approved=True)
        return ws, req, args

    async def test_default_and_unconfigured(self):
        ws, req, args = self.setup_args()
        with patch.dict('os.environ', {'OLLENYA_LOCAL_MEMORY_WS':'0'}):
            await dispatch_private_ws(ws, req, **args)
        with patch.dict('os.environ', {'OLLENYA_LOCAL_MEMORY_WS':'1'}):
            await dispatch_private_ws(ws, req)
        args['generate'].assert_not_awaited()
        args['sessions'].find_one.assert_not_awaited()
        self.assertEqual(ws.send_json.await_count, 2)

    async def test_injected_candidate(self):
        ws, req, args = self.setup_args()
        with patch.dict('os.environ', {'OLLENYA_LOCAL_MEMORY_WS':'1'}):
            await dispatch_private_ws(ws, req, **args)
        self.assertEqual([c.args[0]['type'] for c in ws.send_json.call_args_list], ['meta','done'])

    async def test_account_and_modes(self):
        for change in ({'account_uid':'other'}, {'demo':True}, {'ephemeral':True}, {'demo':'false'}):
            ws, req, args = self.setup_args(); req.update(change)
            with patch.dict('os.environ', {'OLLENYA_LOCAL_MEMORY_WS':'1'}):
                await dispatch_private_ws(ws, req, **args)
            args['generate'].assert_not_awaited()
            self.assertEqual(ws.send_json.call_args.args[0]['type'], 'error')
