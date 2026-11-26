"""Experimental turn-local persistence guard. No active private turn yet.

Context propagates to asyncio child tasks; it is not a global DB firewall.
"""
import logging
from contextlib import contextmanager
from contextvars import ContextVar

_private = ContextVar('ollenya_private_turn', default=False)


class PrivatePersistenceError(RuntimeError):
    pass


@contextmanager
def private_turn():
    token = _private.set(True)
    try:
        yield
    finally:
        _private.reset(token)


def require_public_persistence():
    if _private.get():
        raise PrivatePersistenceError('durable storage unavailable for private turn')


def is_private_turn():
    return _private.get()


class PrivateTurnLogFilter(logging.Filter):
    def filter(self, record):
        # Drop before formatting, including exception information.
        return not is_private_turn()


_private_log_filter = PrivateTurnLogFilter()


def install_private_log_filter():
    # Handler filters also cover propagated records from child loggers.
    loggers = [logging.getLogger()]
    loggers.extend(x for x in logging.root.manager.loggerDict.copy().values()
                   if isinstance(x, logging.Logger))
    for logger in loggers:
        for handler in logger.handlers:
            handler.addFilter(_private_log_filter)
    if logging.lastResort is not None:
        logging.lastResort.addFilter(_private_log_filter)
