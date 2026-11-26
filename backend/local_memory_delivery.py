"""Phase 17C prototype: direct-only delivery, never a durable fallback.

Not wired into production pipelines. This boundary covers event delivery only;
provider retention, audio storage, logging and other sinks need separate gates.
"""


class PrivateDeliveryError(RuntimeError):
    pass


class PrivateEventDelivery:
    def __init__(self, emit):
        if not callable(emit):
            raise PrivateDeliveryError('direct delivery required')
        self._emit = emit
        self._closed = False

    def close(self):
        self._closed = True
        self._emit = None

    async def publish(self, event, audio_bytes=None):
        if self._closed:
            raise PrivateDeliveryError('direct delivery closed')
        failed = False
        try:
            await self._emit(event, audio_bytes)
        except Exception:
            self.close()
            failed = True
        except BaseException:
            self.close()
            raise
        if failed:
            # Outside the except block: do not chain potentially private data.
            raise PrivateDeliveryError('direct delivery failed')
