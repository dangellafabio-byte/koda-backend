"""
Koda Subscription + Quota module.

Hard Paywall logic:
- Free trial 3 giorni (cap 20 msg/giorno)
- 3 tier paid (mensili): Essential 80, Daily 250, Plus 500
- No free tier permanente: senza trial/sub attivo → 402 Payment Required

Source of truth della sottoscrizione = MongoDB (collection `taccuino_subscription`).
Verrà sincronizzata da webhook RevenueCat. Finché RevenueCat non è
configurato lato store, `mock-purchase` permette di simulare la
sottoscrizione per testing E2E.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional, Literal
from fastapi import APIRouter, HTTPException, Request, Header, Depends
from pydantic import BaseModel, Field
from motor.motor_asyncio import AsyncIOMotorDatabase
import logging
import os

logger = logging.getLogger("subscription")

# ─── Plan definitions ───────────────────────────────────────────────────────
TRIAL_DAYS = 3
TRIAL_DAILY_CAP = 20

PlanName = Literal["none", "trial", "essential", "daily", "plus"]

PLAN_LIMITS = {
    "none": {"monthly": 0, "daily": 0},
    "trial": {"monthly": TRIAL_DAILY_CAP * TRIAL_DAYS, "daily": TRIAL_DAILY_CAP},
    "essential": {"monthly": 80, "daily": 80},   # daily=monthly (no daily sub-cap)
    "daily": {"monthly": 250, "daily": 250},
    "plus": {"monthly": 500, "daily": 500},
}

PLAN_PRICES_EUR = {
    "essential": 4.99,
    "daily": 9.99,
    "plus": 19.99,
}


# ─── Models ─────────────────────────────────────────────────────────────────
class SubscriptionRecord(BaseModel):
    profile_id: str
    plan: PlanName = "none"
    status: Literal["none", "active", "expired", "cancelled"] = "none"
    source: Literal["none", "mock", "revenuecat"] = "none"

    # Trial
    trial_started_at: Optional[datetime] = None
    trial_expires_at: Optional[datetime] = None
    trial_consumed: bool = False  # set True quando il trial scade o si attiva un piano paid

    # Paid subscription period
    current_period_start: Optional[datetime] = None
    current_period_end: Optional[datetime] = None

    # Quotas
    daily_msg_count: int = 0
    daily_reset_at: Optional[datetime] = None
    monthly_msg_count: int = 0
    monthly_reset_at: Optional[datetime] = None

    # RevenueCat metadata (popolato dal webhook)
    revenuecat_original_app_user_id: Optional[str] = None
    revenuecat_product_id: Optional[str] = None
    last_event_at: Optional[datetime] = None


class SubscriptionStatusResponse(BaseModel):
    plan: PlanName
    status: str
    has_access: bool
    in_trial: bool
    trial_expires_at: Optional[datetime] = None
    current_period_end: Optional[datetime] = None
    daily_limit: int
    daily_used: int
    daily_remaining: int
    monthly_limit: int
    monthly_used: int
    monthly_remaining: int
    can_start_trial: bool


class StartTrialRequest(BaseModel):
    pass


class MockPurchaseRequest(BaseModel):
    plan: Literal["essential", "daily", "plus"]


# ─── Helpers ────────────────────────────────────────────────────────────────
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_aware(dt: Optional[datetime]) -> Optional[datetime]:
    """Normalizza datetime naive (da Mongo) come UTC."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _next_day_reset(now: datetime) -> datetime:
    """Reset giornaliero a UTC midnight del giorno successivo."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight + timedelta(days=1)


def _next_month_reset(now: datetime, anchor: Optional[datetime] = None) -> datetime:
    """Per piani paid: reset mensile a +30 giorni dall'inizio del periodo.
    Per il trial: usa la stessa logica (anche se il trial dura solo 3 giorni)."""
    base = anchor or now
    return base + timedelta(days=30)


async def _get_or_create(db: AsyncIOMotorDatabase, profile_id: str) -> SubscriptionRecord:
    doc = await db.taccuino_subscription.find_one({"profile_id": profile_id}, {"_id": 0})
    if doc:
        # Sanitize datetimes
        for k in ("trial_started_at", "trial_expires_at",
                  "current_period_start", "current_period_end",
                  "daily_reset_at", "monthly_reset_at", "last_event_at"):
            if k in doc:
                doc[k] = _ensure_aware(doc[k])
        return SubscriptionRecord(**doc)
    rec = SubscriptionRecord(profile_id=profile_id)
    await db.taccuino_subscription.insert_one(rec.model_dump())
    return rec


async def _save(db: AsyncIOMotorDatabase, rec: SubscriptionRecord) -> None:
    await db.taccuino_subscription.replace_one(
        {"profile_id": rec.profile_id}, rec.model_dump(), upsert=True
    )


def _is_active(rec: SubscriptionRecord, now: datetime) -> bool:
    """True se l'utente ha accesso (trial attivo o sub paid attiva)."""
    if rec.plan == "trial":
        expires = _ensure_aware(rec.trial_expires_at)
        return expires is not None and expires > now
    if rec.plan in ("essential", "daily", "plus") and rec.status == "active":
        end = _ensure_aware(rec.current_period_end)
        # Se non c'è end (mai si dovrebbe), considera attivo
        return end is None or end > now
    return False


def _reset_quotas_if_needed(rec: SubscriptionRecord, now: datetime) -> SubscriptionRecord:
    """Reset daily/monthly counter quando scaduti."""
    daily_reset = _ensure_aware(rec.daily_reset_at)
    if daily_reset is None or now >= daily_reset:
        rec.daily_msg_count = 0
        rec.daily_reset_at = _next_day_reset(now)

    monthly_reset = _ensure_aware(rec.monthly_reset_at)
    if monthly_reset is None or now >= monthly_reset:
        rec.monthly_msg_count = 0
        # Allinea il reset mensile alla fine del periodo
        rec.monthly_reset_at = (
            _ensure_aware(rec.current_period_end)
            or _ensure_aware(rec.trial_expires_at)
            or _next_month_reset(now)
        )
    return rec


def _build_status_response(rec: SubscriptionRecord, now: datetime) -> SubscriptionStatusResponse:
    rec = _reset_quotas_if_needed(rec, now)
    has_access = _is_active(rec, now)
    in_trial = rec.plan == "trial" and has_access
    limits = PLAN_LIMITS.get(rec.plan, PLAN_LIMITS["none"])
    daily_limit = limits["daily"]
    monthly_limit = limits["monthly"]

    return SubscriptionStatusResponse(
        plan=rec.plan,
        status=rec.status,
        has_access=has_access,
        in_trial=in_trial,
        trial_expires_at=_ensure_aware(rec.trial_expires_at),
        current_period_end=_ensure_aware(rec.current_period_end),
        daily_limit=daily_limit,
        daily_used=rec.daily_msg_count,
        daily_remaining=max(0, daily_limit - rec.daily_msg_count),
        monthly_limit=monthly_limit,
        monthly_used=rec.monthly_msg_count,
        monthly_remaining=max(0, monthly_limit - rec.monthly_msg_count),
        can_start_trial=(not rec.trial_consumed) and rec.plan == "none",
    )


# ─── Public API (used by chat endpoints) ────────────────────────────────────
class QuotaCheckResult(BaseModel):
    allowed: bool
    reason: Optional[str] = None  # "no_subscription" | "daily_limit" | "monthly_limit"
    plan: PlanName
    status: str
    remaining_today: int
    remaining_month: int


async def check_and_consume_message(db: AsyncIOMotorDatabase, profile_id: str) -> QuotaCheckResult:
    """
    Chiamata PRIMA di processare un messaggio chat.
    - Se nessuna sub attiva → allowed=False reason=no_subscription (HTTP 402)
    - Se quota giornaliera esaurita → allowed=False reason=daily_limit (HTTP 429)
    - Se quota mensile esaurita → allowed=False reason=monthly_limit (HTTP 429)
    - Altrimenti incrementa contatori e ritorna allowed=True
    """
    now = _utcnow()
    rec = await _get_or_create(db, profile_id)
    rec = _reset_quotas_if_needed(rec, now)

    if not _is_active(rec, now):
        # Mark expired se trial era attivo ma è scaduto
        if rec.plan == "trial" and rec.trial_expires_at:
            rec.status = "expired"
            rec.trial_consumed = True
            await _save(db, rec)
        return QuotaCheckResult(
            allowed=False, reason="no_subscription",
            plan=rec.plan, status=rec.status,
            remaining_today=0, remaining_month=0,
        )

    limits = PLAN_LIMITS[rec.plan]
    if rec.daily_msg_count >= limits["daily"]:
        await _save(db, rec)
        return QuotaCheckResult(
            allowed=False, reason="daily_limit",
            plan=rec.plan, status=rec.status,
            remaining_today=0,
            remaining_month=max(0, limits["monthly"] - rec.monthly_msg_count),
        )
    if rec.monthly_msg_count >= limits["monthly"]:
        await _save(db, rec)
        return QuotaCheckResult(
            allowed=False, reason="monthly_limit",
            plan=rec.plan, status=rec.status,
            remaining_today=max(0, limits["daily"] - rec.daily_msg_count),
            remaining_month=0,
        )

    # Consume
    rec.daily_msg_count += 1
    rec.monthly_msg_count += 1
    await _save(db, rec)

    return QuotaCheckResult(
        allowed=True, reason=None,
        plan=rec.plan, status=rec.status,
        remaining_today=max(0, limits["daily"] - rec.daily_msg_count),
        remaining_month=max(0, limits["monthly"] - rec.monthly_msg_count),
    )


async def assert_quota_or_raise(db: AsyncIOMotorDatabase, profile_id: str) -> QuotaCheckResult:
    """
    Helper: chiama check_and_consume_message e solleva HTTPException
    con codice corretto se non allowed.
    """
    result = await check_and_consume_message(db, profile_id)
    if result.allowed:
        return result
    if result.reason == "no_subscription":
        raise HTTPException(status_code=402, detail={
            "error": "subscription_required",
            "message": "Subscription or active trial required",
            "plan": result.plan, "status": result.status,
        })
    if result.reason == "daily_limit":
        raise HTTPException(status_code=429, detail={
            "error": "daily_limit_reached",
            "message": "Daily message limit reached",
            "plan": result.plan,
            "remaining_month": result.remaining_month,
        })
    if result.reason == "monthly_limit":
        raise HTTPException(status_code=429, detail={
            "error": "monthly_limit_reached",
            "message": "Monthly message limit reached",
            "plan": result.plan,
        })
    raise HTTPException(status_code=403, detail={"error": "forbidden"})


# ─── Router ─────────────────────────────────────────────────────────────────
def create_subscription_router(get_db, current_user_id_fn) -> APIRouter:
    """
    Factory che costruisce il router con dipendenze iniettate.
    `get_db` ritorna AsyncIOMotorDatabase, `current_user_id_fn` ritorna lo user UUID.
    """
    router = APIRouter(prefix="/api/subscription", tags=["subscription"])

    @router.get("/status", response_model=SubscriptionStatusResponse)
    async def get_status():
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        return _build_status_response(rec, _utcnow())

    @router.post("/start-trial", response_model=SubscriptionStatusResponse)
    async def start_trial():
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        now = _utcnow()

        # Già consumato o piano attivo
        if rec.trial_consumed:
            raise HTTPException(status_code=409, detail={
                "error": "trial_already_used",
                "message": "Free trial già utilizzato per questo utente",
            })
        if _is_active(rec, now):
            raise HTTPException(status_code=409, detail={
                "error": "already_subscribed",
                "message": "Hai già una sottoscrizione/trial attivo",
            })

        rec.plan = "trial"
        rec.status = "active"
        rec.source = "mock"  # Apple/Google trial sarà gestito da webhook
        rec.trial_started_at = now
        rec.trial_expires_at = now + timedelta(days=TRIAL_DAYS)
        rec.current_period_start = now
        rec.current_period_end = rec.trial_expires_at
        rec.daily_msg_count = 0
        rec.daily_reset_at = _next_day_reset(now)
        rec.monthly_msg_count = 0
        rec.monthly_reset_at = rec.trial_expires_at
        await _save(db, rec)

        logger.info(f"[subscription] trial started for {uid}, expires {rec.trial_expires_at}")
        return _build_status_response(rec, now)

    @router.post("/mock-purchase", response_model=SubscriptionStatusResponse)
    async def mock_purchase(req: MockPurchaseRequest):
        """
        Per testing finché RevenueCat non è collegato agli store.
        Simula l'acquisto di un piano paid. Verrà rimpiazzato dal
        webhook RevenueCat in produzione.

        ⚠️ MOCKED — DA SOSTITUIRE CON WEBHOOK REVENUECAT
        """
        db = get_db()
        uid = current_user_id_fn()
        now = _utcnow()
        rec = await _get_or_create(db, uid)

        rec.plan = req.plan
        rec.status = "active"
        rec.source = "mock"
        rec.trial_consumed = True
        rec.current_period_start = now
        rec.current_period_end = now + timedelta(days=30)
        rec.daily_msg_count = 0
        rec.daily_reset_at = _next_day_reset(now)
        rec.monthly_msg_count = 0
        rec.monthly_reset_at = rec.current_period_end
        await _save(db, rec)

        logger.info(f"[subscription] MOCK purchase: {uid} -> {req.plan}")
        return _build_status_response(rec, now)

    @router.post("/restore", response_model=SubscriptionStatusResponse)
    async def restore_purchases():
        """
        Restore mock: ritorna lo stato corrente.
        In produzione: chiamerà RevenueCat REST API e sincronizzerà.
        """
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        return _build_status_response(rec, _utcnow())

    @router.post("/cancel", response_model=SubscriptionStatusResponse)
    async def cancel_subscription():
        """Annulla la sub corrente (mock per testing)."""
        db = get_db()
        uid = current_user_id_fn()
        rec = await _get_or_create(db, uid)
        rec.plan = "none"
        rec.status = "cancelled"
        rec.current_period_end = _utcnow()
        await _save(db, rec)
        return _build_status_response(rec, _utcnow())

    return router


def create_webhook_router(get_db) -> APIRouter:
    """Webhook RevenueCat — stub. Da completare quando RevenueCat è configurato."""
    router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])

    REVENUECAT_WEBHOOK_TOKEN = os.environ.get("REVENUECAT_WEBHOOK_TOKEN", "")

    @router.post("/revenuecat")
    async def revenuecat_webhook(request: Request, authorization: Optional[str] = Header(default=None)):
        # Verifica shared secret
        if REVENUECAT_WEBHOOK_TOKEN:
            expected = f"Bearer {REVENUECAT_WEBHOOK_TOKEN}"
            if authorization != expected:
                logger.warning("[webhook/revenuecat] unauthorized request")
                raise HTTPException(status_code=401, detail="unauthorized")

        payload = await request.json()
        event = payload.get("event", {})
        app_user_id = event.get("app_user_id")
        event_type = event.get("type")
        product_id = event.get("product_id")

        logger.info(f"[webhook/revenuecat] event={event_type} user={app_user_id} product={product_id}")

        # TODO: mapping product_id → plan, aggiornamento subscription record
        # Implementazione completa quando RevenueCat sarà configurato

        return {"received": True}

    return router
