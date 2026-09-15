"""
Free Tier Gate v65.53 (Fabio 2026-06)
=====================================
Gate server-side per limitare i turni chat scritta degli utenti Free.
Non modificabile dal client. Config runtime da Mongo (`free_config`
singleton) con fallback su env vars.

Contratto:
  - 5 turni ogni 3 giorni (default; configurabile a caldo)
  - Solo chat testuale con Ollenya (Home tab "Ollenya")
  - NON conta: Lascia Andare, MicroDemo (ephemeral), turni voce, Confessionale
  - Reset atomico alla scadenza del periodo
  - Impossibilità di bypass client (counter solo server)
  - Cambio dispositivo NON aggira il limite (contatore su profile Mongo)
  - Richieste fallite non consumano (increment con rollback compensativo)

Funzioni pubbliche:
  - get_free_config(db) → dict
  - set_free_config(db, patch) → dict
  - check_and_increment_free_turn(db, profile_id, config) → (ok: bool, reason: str, state: dict)
  - rollback_free_turn(db, profile_id) → None
  - compute_free_status(profile, config) → dict per API
  - format_countdown_it(seconds_remaining) → str
"""
from __future__ import annotations
import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("ollenya.free_gate")

# ============================ CONFIG FALLBACK ==============================
# Letti solo se il doc Mongo `free_config` non esiste. Vedi backend/.env.
def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except (ValueError, TypeError):
        return default

def _env_bool(key: str, default: bool) -> bool:
    v = os.getenv(key, str(default)).strip().lower()
    return v in ("true", "1", "yes", "on")

def _load_default_config() -> Dict[str, Any]:
    return {
        # Free tier chat scritta con Ollenya
        "turns_per_period": _env_int("OLLENYA_FREE_TURNS_PER_PERIOD", 5),
        "period_hours": _env_int("OLLENYA_FREE_PERIOD_HOURS", 72),
        "max_response_tokens": _env_int("OLLENYA_FREE_MAX_RESPONSE_TOKENS", 250),
        "gate_enabled": _env_bool("OLLENYA_FREE_GATE_ENABLED", True),
        # v65.54 — Premium chat scritta hardcap anti-abuso
        "premium_daily_hardcap": _env_int("OLLENYA_PREMIUM_DAILY_HARDCAP", 200),
        "premium_hardcap_enabled": _env_bool("OLLENYA_PREMIUM_HARDCAP_ENABLED", True),
        "premium_alert_threshold_pct": _env_int("OLLENYA_PREMIUM_ALERT_THRESHOLD_PCT", 80),
        "premium_alert_consecutive_days": _env_int("OLLENYA_PREMIUM_ALERT_CONSECUTIVE_DAYS", 3),
    }

# ============================ MONGO CONFIG =================================
_CONFIG_COLLECTION = "free_config"
_CONFIG_SINGLETON_ID = "singleton"

async def get_free_config(db) -> Dict[str, Any]:
    """Legge config runtime da Mongo. Fallback su env."""
    try:
        doc = await db[_CONFIG_COLLECTION].find_one({"_id": _CONFIG_SINGLETON_ID})
    except Exception as e:
        logger.warning(f"[free_config] read failed, using env fallback: {e}")
        doc = None

    fallback = _load_default_config()
    if not doc:
        return fallback

    merged = {**fallback}
    for k in (
        "turns_per_period", "period_hours", "max_response_tokens", "gate_enabled",
        "premium_daily_hardcap", "premium_hardcap_enabled",
        "premium_alert_threshold_pct", "premium_alert_consecutive_days",
    ):
        if k in doc and doc[k] is not None:
            merged[k] = doc[k]
    return merged

async def set_free_config(db, patch: Dict[str, Any]) -> Dict[str, Any]:
    """Aggiorna config runtime. Solo i campi ammessi vengono scritti.
    Ritorna la config effettiva dopo l'update."""
    allowed = {
        "turns_per_period", "period_hours", "max_response_tokens", "gate_enabled",
        # v65.54 Premium
        "premium_daily_hardcap", "premium_hardcap_enabled",
        "premium_alert_threshold_pct", "premium_alert_consecutive_days",
    }
    bool_fields = {"gate_enabled", "premium_hardcap_enabled"}
    clean: Dict[str, Any] = {}
    for k, v in patch.items():
        if k not in allowed:
            continue
        if k in bool_fields:
            clean[k] = bool(v)
        else:
            try:
                clean[k] = int(v)
                if clean[k] < 1:
                    logger.warning(f"[free_config] set_free_config: {k}={v} < 1 → skipped")
                    del clean[k]
            except (ValueError, TypeError):
                logger.warning(f"[free_config] set_free_config: {k}={v} non int → skipped")

    if not clean:
        return await get_free_config(db)

    clean["updated_at_iso"] = datetime.now(timezone.utc).isoformat()
    await db[_CONFIG_COLLECTION].update_one(
        {"_id": _CONFIG_SINGLETON_ID},
        {"$set": clean},
        upsert=True,
    )
    logger.info(f"[free_config] updated: {clean}")
    return await get_free_config(db)

# ============================ ATOMIC GATE ==================================
async def check_and_increment_free_turn(
    db,
    profile_id: str,
    config: Dict[str, Any],
) -> Tuple[bool, str, Dict[str, Any]]:
    """
    Gate atomico:
      - Se necessario RESET (periodo scaduto): scrive nuovo period_start + turns_used=1
      - Altrimenti INCREMENT guardato: $inc turns_used solo se < LIMIT
      - Se guard fallisce → quota esaurita, nessun increment
    Ritorna (ok, reason, current_state).

    reason ∈ {"ok", "quota_exhausted", "gate_disabled", "error"}
    """
    if not config.get("gate_enabled", True):
        # Kill-switch attivo: non applicare il gate, nessun conteggio
        return True, "gate_disabled", {}

    limit = int(config["turns_per_period"])
    period_hours = int(config["period_hours"])
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    try:
        prof = await db.taccuino_profile.find_one(
            {"id": profile_id},
            {"free_chat_state": 1, "name": 1},
        )
    except Exception as e:
        logger.error(f"[free_gate] read failed profile_id={profile_id[:8]}: {e}")
        return False, "error", {}

    if not prof:
        return False, "error", {}

    state = prof.get("free_chat_state") or None
    # === Path 1: primo turno o periodo scaduto → RESET atomico ===
    needs_reset = True
    if state and state.get("period_start_iso"):
        try:
            period_start = datetime.fromisoformat(state["period_start_iso"])
            if period_start.tzinfo is None:
                period_start = period_start.replace(tzinfo=timezone.utc)
            elapsed = (now - period_start).total_seconds()
            if elapsed < period_hours * 3600:
                needs_reset = False
        except Exception as e:
            logger.warning(f"[free_gate] invalid period_start_iso, forcing reset: {e}")

    if needs_reset:
        new_state = {
            "period_start_iso": now_iso,
            "turns_used": 1,
            "last_reset_at_iso": now_iso,
        }
        try:
            await db.taccuino_profile.update_one(
                {"id": profile_id},
                {"$set": {"free_chat_state": new_state}},
            )
        except Exception as e:
            logger.error(f"[free_gate] reset update failed: {e}")
            return False, "error", {}
        logger.info(f"[free_gate] RESET+consume user={profile_id[:8]} period_start={now_iso} turns=1/{limit}")
        return True, "ok", new_state

    # === Path 2: periodo attivo → increment guardato ===
    current_turns = int(state.get("turns_used", 0))
    if current_turns >= limit:
        logger.info(f"[free_gate] EXHAUSTED user={profile_id[:8]} used={current_turns}/{limit}")
        return False, "quota_exhausted", state

    # Increment atomico con guard: se un'altra request concorrente ha già
    # portato il counter a limit, questa update NON matcha e ritorna None.
    try:
        updated = await db.taccuino_profile.find_one_and_update(
            {
                "id": profile_id,
                "$or": [
                    {"free_chat_state.turns_used": {"$lt": limit}},
                    {"free_chat_state": None},
                ],
            },
            {"$inc": {"free_chat_state.turns_used": 1}},
            projection={"free_chat_state": 1},
            return_document=True,  # motor: ReturnDocument.AFTER (fallback: default True)
        )
    except Exception as e:
        # Motor legacy: usa ReturnDocument
        try:
            from pymongo import ReturnDocument
            updated = await db.taccuino_profile.find_one_and_update(
                {
                    "id": profile_id,
                    "$or": [
                        {"free_chat_state.turns_used": {"$lt": limit}},
                        {"free_chat_state": None},
                    ],
                },
                {"$inc": {"free_chat_state.turns_used": 1}},
                projection={"free_chat_state": 1},
                return_document=ReturnDocument.AFTER,
            )
        except Exception as e2:
            logger.error(f"[free_gate] atomic inc failed: {e} / {e2}")
            return False, "error", state

    if not updated:
        # Race lost: qualcun'altra request ha superato il limite prima di noi
        logger.info(f"[free_gate] race lost user={profile_id[:8]}")
        return False, "quota_exhausted", state

    new_state = updated.get("free_chat_state") or state
    new_used = int(new_state.get("turns_used", current_turns + 1))
    logger.info(f"[free_gate] CONSUME user={profile_id[:8]} turns={new_used}/{limit}")
    return True, "ok", new_state

async def rollback_free_turn(db, profile_id: str) -> None:
    """Decrementa turns_used di 1 (min 0). Chiamato se la LLM call fallisce
    dopo l'increment. Non blocca in caso di errore Mongo."""
    try:
        await db.taccuino_profile.update_one(
            {
                "id": profile_id,
                "free_chat_state.turns_used": {"$gt": 0},
            },
            {"$inc": {"free_chat_state.turns_used": -1}},
        )
        logger.info(f"[free_gate] ROLLBACK user={profile_id[:8]}")
    except Exception as e:
        logger.warning(f"[free_gate] rollback failed user={profile_id[:8]}: {e}")

# ============================ FREE STATUS PAYLOAD ==========================
def compute_free_status(
    profile_state: Optional[Dict[str, Any]],
    config: Dict[str, Any],
) -> Dict[str, Any]:
    """Payload leggibile dal client. Sicuro: non espone campi manipolabili."""
    limit = int(config["turns_per_period"])
    period_hours = int(config["period_hours"])
    now = datetime.now(timezone.utc)

    turns_used = 0
    period_ends_at_iso: Optional[str] = None
    seconds_until_reset = 0

    if profile_state and profile_state.get("period_start_iso"):
        try:
            period_start = datetime.fromisoformat(profile_state["period_start_iso"])
            if period_start.tzinfo is None:
                period_start = period_start.replace(tzinfo=timezone.utc)
            period_end = period_start + timedelta(hours=period_hours)
            if period_end > now:
                turns_used = int(profile_state.get("turns_used", 0))
                period_ends_at_iso = period_end.isoformat()
                seconds_until_reset = int((period_end - now).total_seconds())
            # else: periodo scaduto → prossima chiamata farà reset, ora esponiamo 0/LIMIT
        except Exception:
            pass

    turns_remaining = max(0, limit - turns_used)
    return {
        "turns_used": turns_used,
        "turns_limit": limit,
        "turns_remaining": turns_remaining,
        "period_hours": period_hours,
        "period_ends_at_iso": period_ends_at_iso,
        "seconds_until_reset": seconds_until_reset,
        "hours_until_reset": seconds_until_reset // 3600 if seconds_until_reset else 0,
        "countdown_it": format_countdown_it(seconds_until_reset) if seconds_until_reset else None,
        "gate_enabled": bool(config.get("gate_enabled", True)),
    }

# ============================ COUNTDOWN NATURALE IT ========================
def format_countdown_it(seconds_remaining: int) -> str:
    """Formato naturale italiano coerente con spec:
      - < 2 min:    "puoi riprovare tra poco"
      - < 1 ora:    "tra 42 minuti"
      - < 24 ore:   "tra 6 ore"
      - >= 24 ore:  "tra 2 giorni e 3 ore" (senza 0 giorni / 0 ore)
    """
    if seconds_remaining is None or seconds_remaining < 0:
        return "tra poco"
    if seconds_remaining < 120:
        return "puoi riprovare tra poco"
    minutes = seconds_remaining // 60
    if minutes < 60:
        return f"tra {minutes} minut{'o' if minutes == 1 else 'i'}"
    hours = minutes // 60
    if hours < 24:
        return f"tra {hours} or{'a' if hours == 1 else 'e'}"
    days = hours // 24
    rem_hours = hours % 24
    if rem_hours == 0:
        return f"tra {days} giorn{'o' if days == 1 else 'i'}"
    return (
        f"tra {days} giorn{'o' if days == 1 else 'i'} e "
        f"{rem_hours} or{'a' if rem_hours == 1 else 'e'}"
    )

# ============================ PREMIUM DAILY HARDCAP v65.54 ==============
# Anti-abuso chat scritta Premium. 200 turni/giorno di default.
# Reset a mezzanotte:
#   - Utenti CON "Condividi la mia città" attivo → mezzanotte fuso locale
#   - Altrimenti → mezzanotte Europe/Rome (default IT)
#
# Timezone "fossilizzato" per il periodo in corso: se l'utente toggle il
# permesso a metà giornata, il day_iso già impostato resta valido fino
# alla mezzanotte di quel fuso. Il fuso nuovo vale dal prossimo reset.
try:
    from zoneinfo import ZoneInfo  # Python 3.9+
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore

def _tz_from_profile(profile: Dict[str, Any]) -> "ZoneInfo":
    """Ritorna il ZoneInfo effettivo per l'utente. Fallback: Europe/Rome.
    Legge `settings.geolocation_enabled` + `location_context.timezone` (se
    salvato via /profile/location-context). Se permesso disattivato o dati
    mancanti → Europe/Rome."""
    fallback = ZoneInfo("Europe/Rome") if ZoneInfo else None
    if not profile:
        return fallback
    settings = profile.get("settings") or {}
    geo_enabled = bool(settings.get("geolocation_enabled", False))
    if not geo_enabled:
        return fallback
    lc = profile.get("location_context") or {}
    tz_name = (lc.get("timezone") or "").strip() if isinstance(lc, dict) else ""
    if not tz_name or not ZoneInfo:
        return fallback
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return fallback

def _local_day_iso(profile: Dict[str, Any]) -> Tuple[str, str]:
    """Ritorna (day_iso, tz_name) del giorno locale corrente per l'utente."""
    tz = _tz_from_profile(profile)
    tz_name = getattr(tz, "key", "Europe/Rome") if tz else "Europe/Rome"
    now_local = datetime.now(tz) if tz else datetime.now(timezone.utc)
    return now_local.strftime("%Y-%m-%d"), tz_name

def _seconds_until_next_midnight(profile: Dict[str, Any]) -> int:
    """Secondi da ora al prossimo reset (mezzanotte locale utente)."""
    tz = _tz_from_profile(profile)
    if not tz:
        now = datetime.now(timezone.utc)
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return int((tomorrow - now).total_seconds())
    now_local = datetime.now(tz)
    tomorrow_local = (now_local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((tomorrow_local - now_local).total_seconds())

async def check_and_increment_premium_turn(
    db,
    profile_id: str,
    config: Dict[str, Any],
) -> Tuple[bool, str, Dict[str, Any]]:
    """Gate Premium giornaliero. Ritorna (ok, reason, state_snapshot).
    reason ∈ {'ok', 'premium_daily_hardcap', 'gate_disabled', 'error'}."""
    if not config.get("premium_hardcap_enabled", True):
        return True, "gate_disabled", {}
    hardcap = int(config["premium_daily_hardcap"])
    try:
        prof = await db.taccuino_profile.find_one(
            {"id": profile_id},
            {"premium_chat_daily_state": 1, "settings": 1, "location_context": 1, "name": 1},
        )
    except Exception as e:
        logger.error(f"[premium_gate] read failed: {e}")
        return False, "error", {}
    if not prof:
        return False, "error", {}
    today_iso, tz_name = _local_day_iso(prof)
    state = prof.get("premium_chat_daily_state") or None
    # === Reset o primo turno del giorno ===
    if not state or state.get("day_iso") != today_iso:
        new_state = {
            "day_iso": today_iso,
            "turns_today": 1,
            "tz_used": tz_name,
        }
        try:
            await db.taccuino_profile.update_one(
                {"id": profile_id},
                {"$set": {"premium_chat_daily_state": new_state}},
            )
        except Exception as e:
            logger.error(f"[premium_gate] reset update failed: {e}")
            return False, "error", {}
        logger.info(f"[premium_gate] RESET+consume user={profile_id[:8]} day={today_iso} tz={tz_name} turns=1/{hardcap}")
        return True, "ok", new_state
    # === Increment guardato ===
    current = int(state.get("turns_today", 0))
    if current >= hardcap:
        logger.info(f"[premium_gate] HARDCAP user={profile_id[:8]} used={current}/{hardcap}")
        # Registra hit per l'alert (senza bloccare)
        try:
            await _record_premium_hit(db, profile_id, today_iso, current, hardcap, config)
        except Exception as _e:
            logger.warning(f"[premium_gate] alert record failed: {_e}")
        return False, "premium_daily_hardcap", state
    try:
        from pymongo import ReturnDocument
        updated = await db.taccuino_profile.find_one_and_update(
            {
                "id": profile_id,
                "premium_chat_daily_state.day_iso": today_iso,
                "premium_chat_daily_state.turns_today": {"$lt": hardcap},
            },
            {"$inc": {"premium_chat_daily_state.turns_today": 1}},
            projection={"premium_chat_daily_state": 1},
            return_document=ReturnDocument.AFTER,
        )
    except Exception as e:
        logger.error(f"[premium_gate] inc failed: {e}")
        return False, "error", state
    if not updated:
        logger.info(f"[premium_gate] race lost user={profile_id[:8]}")
        return False, "premium_daily_hardcap", state
    new_state = updated.get("premium_chat_daily_state") or state
    new_used = int(new_state.get("turns_today", current + 1))
    # Traccia hits per alert se ≥ threshold%
    threshold_pct = int(config.get("premium_alert_threshold_pct", 80))
    if (new_used / hardcap) * 100 >= threshold_pct:
        try:
            await _record_premium_hit(db, profile_id, today_iso, new_used, hardcap, config)
        except Exception as _e:
            logger.warning(f"[premium_gate] alert record: {_e}")
    logger.info(f"[premium_gate] CONSUME user={profile_id[:8]} turns={new_used}/{hardcap}")
    return True, "ok", new_state

async def rollback_premium_turn(db, profile_id: str) -> None:
    try:
        await db.taccuino_profile.update_one(
            {"id": profile_id, "premium_chat_daily_state.turns_today": {"$gt": 0}},
            {"$inc": {"premium_chat_daily_state.turns_today": -1}},
        )
    except Exception as e:
        logger.warning(f"[premium_gate] rollback failed: {e}")

async def _record_premium_hit(
    db, profile_id: str, day_iso: str, turns: int, hardcap: int, config: Dict[str, Any],
) -> None:
    """Registra un hit ≥ threshold% per il tracking anti-abuso. Se 3 giorni
    consecutivi al ≥ threshold%, triggera l'email admin."""
    threshold_pct = int(config.get("premium_alert_threshold_pct", 80))
    consec_needed = int(config.get("premium_alert_consecutive_days", 3))
    # Upsert entry giorno corrente
    await db.premium_hardcap_hits.update_one(
        {"profile_id": profile_id, "day_iso": day_iso},
        {
            "$set": {
                "profile_id": profile_id,
                "day_iso": day_iso,
                "turns": turns,
                "hardcap": hardcap,
                "threshold_pct_at_hit": threshold_pct,
                "last_hit_at_iso": datetime.now(timezone.utc).isoformat(),
            },
            "$setOnInsert": {"first_hit_at_iso": datetime.now(timezone.utc).isoformat()},
        },
        upsert=True,
    )
    # Check consecutivi
    today = datetime.strptime(day_iso, "%Y-%m-%d").date()
    days_to_check = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(consec_needed)]
    hits = await db.premium_hardcap_hits.count_documents(
        {"profile_id": profile_id, "day_iso": {"$in": days_to_check}}
    )
    if hits < consec_needed:
        return
    # Evita spam: solo 1 alert per settimana per utente
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    already = await db.premium_hardcap_alerts.find_one(
        {"profile_id": profile_id, "sent_at_iso": {"$gt": week_ago}}
    )
    if already:
        return
    # Media storica 30gg
    since_iso = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    pipeline = [
        {"$match": {"profile_id": profile_id, "day_iso": {"$gte": since_iso}}},
        {"$group": {"_id": None, "sum_turns": {"$sum": "$turns"}, "days": {"$sum": 1}}},
    ]
    avg = 0.0
    try:
        agg = await db.premium_hardcap_hits.aggregate(pipeline).to_list(1)
        if agg:
            avg = agg[0]["sum_turns"] / max(1, agg[0]["days"])
    except Exception:
        pass
    # Registra alert
    await db.premium_hardcap_alerts.insert_one({
        "profile_id": profile_id,
        "day_iso": day_iso,
        "consecutive_days": hits,
        "hardcap": hardcap,
        "turns_today": turns,
        "avg_last_30d": round(avg, 1),
        "sent_at_iso": datetime.now(timezone.utc).isoformat(),
    })
    # Trigger email (best-effort, non blocca)
    try:
        await _send_admin_alert_email(db, profile_id, day_iso, hits, turns, hardcap, avg)
    except Exception as e:
        logger.warning(f"[premium_gate] email alert failed: {e}")

async def _send_admin_alert_email(
    db, profile_id: str, day_iso: str, consec: int, turns: int, hardcap: int, avg_30d: float,
) -> None:
    """Invia email admin via Emergent Managed Resend con rate-limit 6h/utente.

    Dipendenza soft: se l'invio fallisce, logga e prosegue senza rompere il flow.
    """
    try:
        from admin_email_worker import enqueue_and_send
        res = await enqueue_and_send(
            db,
            profile_id=profile_id,
            day_iso=day_iso,
            consec=consec,
            turns=turns,
            hardcap=hardcap,
            avg_30d=avg_30d,
        )
        logger.warning(
            f"[ADMIN_ALERT_EMAIL] queued profile={profile_id[:8]} outbox={res.get('outbox_id')}"
        )
    except Exception as e:
        logger.warning(f"[admin_alert] enqueue failed: {e}")

def compute_premium_status(
    profile: Dict[str, Any],
    config: Dict[str, Any],
) -> Dict[str, Any]:
    """Payload live per il client Premium. Sicuro."""
    hardcap = int(config.get("premium_daily_hardcap", 200))
    state = profile.get("premium_chat_daily_state") if profile else None
    today_iso, tz_name = _local_day_iso(profile or {})
    turns_today = 0
    if state and state.get("day_iso") == today_iso:
        turns_today = int(state.get("turns_today", 0))
    seconds_until_reset = _seconds_until_next_midnight(profile or {})
    return {
        "turns_today": turns_today,
        "daily_hardcap": hardcap,
        "turns_remaining": max(0, hardcap - turns_today),
        "tz_used": tz_name,
        "seconds_until_reset": seconds_until_reset,
        "reset_countdown_it": format_countdown_it(seconds_until_reset),
        "hardcap_enabled": bool(config.get("premium_hardcap_enabled", True)),
    }
