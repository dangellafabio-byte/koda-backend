"""Candidate endpoint adapter. No production provider is registered."""
import os
from local_memory_ws_generation import run_private_ws_generation


async def dispatch_private_ws(websocket, request, *, sessions=None,
                              email_to_uid=None, generate=None,
                              system_prompt=None, provider_approved=False):
    failed = True
    if (os.getenv('OLLENYA_LOCAL_MEMORY_WS', '0') == '1'
            and provider_approved is True and callable(generate)
            and sessions is not None and callable(email_to_uid)
            and isinstance(system_prompt, str) and system_prompt.strip()
            and request.get('ephemeral', False) is False
            and request.get('demo', False) is False
            and isinstance(request.get('account_uid'), str)):
        try:
            await run_private_ws_generation(
                websocket=websocket, sessions=sessions, email_to_uid=email_to_uid,
                account_uid=request['account_uid'], enabled=True,
                system_prompt=system_prompt, text=request.get('text'),
                raw_context=request.get('local_memory_context'), generate=generate,
                provider_approved=True)
            failed = False
        except Exception:
            pass
    if failed:
        try:
            await websocket.send_json({'type': 'error', 'message':
                                       'Local memory unavailable on fast transport'})
        except Exception:
            pass
