"""Cancel a client-STT turn as soon as its WebSocket disconnects."""
import asyncio


async def run_until_disconnect(websocket, pipeline):
    # There is no other reader while the client-STT handler awaits its turn.
    # An 'end' frame only ends STT; it must NOT discard the requested answer.
    async def disconnected():
        while True:
            frame = await websocket.receive()
            if frame.get("type") == "websocket.disconnect":
                return

    work = asyncio.create_task(pipeline)
    watch = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait((work, watch), return_when=asyncio.FIRST_COMPLETED)
        if work in done:
            await work  # propagate actual pipeline errors
            return True
        await watch  # propagate transport errors rather than silently hanging
        return False
    finally:
        for task in (work, watch):
            if not task.done():
                task.cancel()
        await asyncio.gather(work, watch, return_exceptions=True)
