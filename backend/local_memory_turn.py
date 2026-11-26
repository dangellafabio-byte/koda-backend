"""Candidate-only lifecycle for direct private turns; not wired to endpoints."""
from local_memory_delivery import PrivateEventDelivery
from local_memory_privacy import private_turn


class PrivateTurnError(RuntimeError):
    pass


async def run_private_turn(*, verified_uid, account_uid, ephemeral, demo,
                           enabled, emit, work):
    """Run an awaited private operation with direct delivery and scoped guards.

    Caller must obtain verified_uid from strict session verification. Work must
    await all its child tasks; this helper does not authorize provider retention.
    """
    if (enabled is not True or not isinstance(verified_uid, str)
            or not verified_uid or verified_uid == 'me'
            or verified_uid != account_uid or ephemeral or demo
            or not callable(emit) or not callable(work)):
        raise PrivateTurnError('private turn unavailable')
    failed = False
    with private_turn():
        delivery = PrivateEventDelivery(emit)
        try:
            await work(delivery.publish)
        except Exception:
            failed = True
        finally:
            delivery.close()
    if failed:
        raise PrivateTurnError('private turn failed')
