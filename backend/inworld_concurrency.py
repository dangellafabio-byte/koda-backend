"""Process-wide admission queue for every Inworld HTTP TTS call.

The current Railway image runs one worker/replica. These limits are NOT
account-wide across replicas, preview deployments or external API clients.
"""
import asyncio
import logging
import hashlib
import uuid
import os
import time
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)


class QueueUnavailable(Exception):
    """No upstream call was made: local queue full or wait expired."""


class GenerationQueue:
    def __init__(self, limit=3, wait_seconds=15.0, max_waiting=32):
        if limit < 1 or wait_seconds <= 0 or max_waiting < 1:
            raise ValueError("Invalid Inworld queue settings")
        self.limit = limit
        self.wait_seconds = wait_seconds
        self.max_waiting = max_waiting
        self.active = 0
        self._users = set()
        self._waiting = []
        self._condition = asyncio.Condition()
        self.high_water = 0

    def _eligible(self, ticket):
        if self.active >= self.limit:
            return False
        # Oldest eligible request wins; one user's queued segments cannot
        # occupy every global slot and prevent other users from speaking.
        for candidate in self._waiting:
            if candidate[1] not in self._users:
                return candidate is ticket
        return False

    @asynccontextmanager
    async def slot(self, user_id=None):
        key = user_id or object()  # unscoped dev calls still share global cap
        ticket = (object(), key)
        request_id = uuid.uuid4().hex[:12]
        user_tag = hashlib.sha256(str(user_id or "unscoped").encode()).hexdigest()[:10]
        started = time.monotonic()
        async with self._condition:
            if len(self._waiting) >= self.max_waiting:
                raise QueueUnavailable("Inworld local TTS queue full")
            self._waiting.append(ticket)
            try:
                await asyncio.wait_for(
                    self._condition.wait_for(lambda: self._eligible(ticket)),
                    self.wait_seconds,
                )
            except BaseException as error:
                self._waiting.remove(ticket)
                self._condition.notify_all()
                if isinstance(error, asyncio.TimeoutError):
                    raise QueueUnavailable("Inworld local TTS queue timeout") from error
                raise
            self._waiting.remove(ticket)
            self._users.add(key)
            self.active += 1
            self.high_water = max(self.high_water, self.active)
            logger.info(
                "[OLLENYA_TTS_CONCURRENCY] start request=%s user=%s active=%d limit=%d waiting=%d wait_ms=%d",
                request_id, user_tag,
                self.active, self.limit, len(self._waiting),
                int((time.monotonic() - started) * 1000),
            )
            self._condition.notify_all()
        try:
            yield
        finally:
            async with self._condition:
                self.active -= 1
                self._users.remove(key)
                logger.info(
                    "[OLLENYA_TTS_CONCURRENCY] end request=%s user=%s active=%d limit=%d waiting=%d",
                    request_id, user_tag,
                    self.active, self.limit, len(self._waiting),
                )
                self._condition.notify_all()


QUEUE = GenerationQueue(
    limit=int(os.getenv("INWORLD_TTS_MAX_ACTIVE", "3")),
    wait_seconds=float(os.getenv("INWORLD_TTS_QUEUE_TIMEOUT_S", "15")),
    max_waiting=int(os.getenv("INWORLD_TTS_MAX_WAITING", "32")),
)
