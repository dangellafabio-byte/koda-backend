"""Candidate-only composition of strict auth, private generation and direct WS.
No live endpoint, audio, search, persistence or legacy fallback is enabled.
The caller must supply a trusted system prompt and server-side provider approval.
"""
from local_memory_ws import run_private_ws
from local_memory_turn import PrivateTurnError
from local_memory_generation import generate_private_reply


async def run_private_ws_generation(*, websocket, sessions, email_to_uid,
                                    account_uid, enabled=False, ephemeral=False,
                                    demo=False, system_prompt, text, raw_context,
                                    generate, provider_approved=False):
    if provider_approved is not True or not callable(generate):
        raise PrivateTurnError('private turn unavailable')

    async def work(publish):
        reply = await generate_private_reply(
            system_prompt=system_prompt, text=text, raw_context=raw_context,
            generate=generate, provider_approved=provider_approved)
        # Text-only candidate protocol; do not pretend audio was generated.
        await publish({'type': 'meta', 'reply': reply, 'voice_text': '',
                       'actions': [], 'close_session': False})
        await publish({'type': 'done'})

    await run_private_ws(websocket=websocket, sessions=sessions,
                         email_to_uid=email_to_uid, account_uid=account_uid,
                         enabled=enabled, ephemeral=ephemeral, demo=demo,
                         work=work)
