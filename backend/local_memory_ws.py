"""Candidate direct WebSocket transport; deliberately not exposed by endpoints."""
import asyncio
from local_memory_auth import request_token, verified_memory_uid
from local_memory_turn import run_private_turn, PrivateTurnError


async def run_private_ws(*, websocket, sessions, email_to_uid, account_uid,
                         enabled, ephemeral, demo, work):
    """Authenticate independently and deliver without durable session or polling.

    Work is injected for tests; the existing fast pipeline is not safe to use here.
    The caller must own the socket lifecycle and establish the account identity.
    """
    if enabled is not True or ephemeral or demo:
        raise PrivateTurnError('private turn unavailable')
    uid = await verified_memory_uid(sessions, request_token(websocket), email_to_uid)
    lock = asyncio.Lock()

    async def emit(event, audio_bytes=None):
        async with lock:
            if audio_bytes is not None:
                if event.get('type') != 'sentence' or not isinstance(audio_bytes, bytes):
                    raise PrivateTurnError('private delivery failed')
                header = {k: event.get(k) for k in ('type', 'i', 'text', 'waveform', 'window_ms')}
                header.update(audio_bytes=len(audio_bytes), mime='audio/mpeg')
                await websocket.send_json(header)
                await websocket.send_bytes(audio_bytes)
            else:
                await websocket.send_json(event)

    await run_private_turn(verified_uid=uid, account_uid=account_uid,
                           ephemeral=ephemeral, demo=demo, enabled=enabled,
                           emit=emit, work=work)
