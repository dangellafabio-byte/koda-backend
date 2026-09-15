"""Admin email worker for Ollenya.

Handles delivery of Premium hardcap abuse alerts from the
`admin_alert_outbox` MongoDB collection through the Emergent Managed
Resend integration.

Design:
- All outbound emails are *server-side rendered* (no caller-supplied HTML).
- Structural guardrail `_assert_safe_email` is enforced on every send.
- Per-profile rate-limit: max 1 email every 6h (`admin_alert_ratelimits`).
- Real-time trigger + admin flush endpoint both go through the same path.
- All sends are best-effort: on failure the outbox row stays `delivered: false`
  so a later flush retries.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from html import escape
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Emergent Managed Email — proxy constants (do NOT read base URL from env)
# ---------------------------------------------------------------------------
EMAIL_BASE_URL = "https://integrations.emergentagent.com"
EMAIL_KEY = os.getenv("EMERGENT_EMAIL_KEY", "").strip()
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "Ollenya").strip() or "Ollenya"
EMAIL_REPLY_TO = os.getenv("EMAIL_REPLY_TO", "").strip() or None

# Admin recipient: env override + hardcoded fallback per user spec
_ADMIN_FALLBACK = "dangella.fabio@gmail.com"

# Rate-limit window per user (seconds)
_RATE_LIMIT_SECONDS = 6 * 60 * 60  # 6h


def _admin_email() -> str:
    return (os.getenv("KODA_ADMIN_ALERT_EMAIL", "").strip() or _ADMIN_FALLBACK)


# ---------------------------------------------------------------------------
# Guardrail gate (copy of playbook — DO NOT WEAKEN)
# ---------------------------------------------------------------------------
_SHORTENERS = ("bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "goo.gl", "rebrand.ly")
_CRED_ASK = (
    "reply with your password", "reply with the code", "send your password", "cvv",
    "send us your password", "enter your password below", "confirm your card number",
    "your full card number", "seed phrase", "recovery phrase", "verify your card",
    "social security number", "confirm your bank details",
)
_HOSTISH = re.compile(r"\b(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})", re.I)


def _host_ok(host: str) -> bool:
    if not host or "xn--" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return not any(host == s or host.endswith("." + s) for s in _SHORTENERS)


def _same_site(shown: str, real: str) -> bool:
    return shown == real or real.endswith("." + shown) or shown.endswith("." + real)


class _EmailScan(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: set[str] = set()
        self.urls: List[str] = []
        self.anchors: List[tuple[str, str]] = []
        self._href: Optional[str] = None
        self._text: List[str] = []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag.lower())
        self.urls += [v for k, v in attrs if k.lower() in ("href", "src") and v]
        if tag.lower() == "a":
            self._href = dict((k.lower(), v) for k, v in attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href is not None:
            self.anchors.append((self._href, "".join(self._text)))
            self._href, self._text = None, []


def _assert_safe_email(subject: str, html: str) -> None:
    scan = _EmailScan()
    scan.feed(html)
    if scan.tags & {"form", "input", "textarea", "select"}:
        raise ValueError("No forms or input fields in email (G2)")
    body = f"{subject}\n{html}".lower()
    for p in _CRED_ASK:
        if p in body:
            raise ValueError(f"Email asks the recipient for credentials: {p!r} (G2)")
    for url in scan.urls:
        low = url.strip().lower()
        if low.startswith(("mailto:", "tel:", "cid:", "#")):
            continue
        if not low.startswith("https://"):
            raise ValueError(f"Email links/assets must be absolute https: {url!r} (G3)")
        host = urlparse(low).hostname or ""
        if not _host_ok(host) or urlparse(low).username is not None:
            raise ValueError(f"Shortened, numeric-host or credential-bearing URL: {url!r} (G3)")
    for href, text in scan.anchors:
        real = urlparse(href.strip().lower()).hostname or ""
        if not real:
            continue
        for m in _HOSTISH.finditer(text):
            if not _same_site(m.group(1).lower(), real):
                raise ValueError(f"Anchor text {m.group(1)!r} ≠ real link host {real!r} (G3)")


# ---------------------------------------------------------------------------
# Low-level send
# ---------------------------------------------------------------------------
async def _send_email(*, to: str, subject: str, html: str) -> Optional[str]:
    _assert_safe_email(subject, html)
    if not EMAIL_KEY:
        raise RuntimeError("EMERGENT_EMAIL_KEY not configured")
    payload: Dict[str, Any] = {
        "to": [to],
        "subject": subject,
        "html": html,
        "from_name": EMAIL_FROM_NAME,
    }
    if EMAIL_REPLY_TO:
        payload["contact_email"] = EMAIL_REPLY_TO
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{EMAIL_BASE_URL}/api/v1/email/send",
            headers={"X-Email-Key": EMAIL_KEY},
            json=payload,
        )
    resp.raise_for_status()
    return (resp.json() or {}).get("id")


# ---------------------------------------------------------------------------
# HTML template — pure server-side, no caller input in markup
# ---------------------------------------------------------------------------
def _render_abuse_alert_html(
    *,
    profile_id: str,
    day_iso: str,
    consec: int,
    turns: int,
    hardcap: int,
    avg_30d: float,
) -> str:
    p_id = escape(profile_id)
    day = escape(day_iso)
    interpretation = (
        "Se la media storica ≈ turni oggi, l'utente è un heavy user abituale (uso legittimo). "
        "Se la media storica è molto inferiore ai turni odierni, il pattern è anomalo e "
        "potrebbe indicare un abuso automatizzato."
    )
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="background:#0e0f13;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">'
        '<tr><td align="center" style="padding:24px">'
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" '
        'style="max-width:560px;background:#171923;border-radius:12px;'
        'border:1px solid #262a36;overflow:hidden">'
        '<tr><td style="padding:20px 24px;background:#1f2230;border-bottom:1px solid #262a36">'
        '<div style="color:#f5c451;font-size:12px;letter-spacing:1.5px;text-transform:uppercase">'
        'abuse watch</div>'
        '<div style="color:#f2f4f8;font-size:20px;font-weight:600;margin-top:4px">'
        f'Utente Premium vicino al daily hardcap</div></td></tr>'
        '<tr><td style="padding:24px;color:#c9cdd8;font-size:14px;line-height:1.55">'
        '<p style="margin:0 0 12px 0">Un utente Premium ha superato la soglia dell\'80% del '
        'daily hardcap per tre giorni consecutivi.</p>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="border-collapse:collapse;margin:12px 0">'
        f'<tr><td style="padding:6px 0;color:#8a90a2">Profile ID</td>'
        f'<td style="padding:6px 0;color:#f2f4f8;font-family:Menlo,monospace">{p_id}</td></tr>'
        f'<tr><td style="padding:6px 0;color:#8a90a2">Giorno locale</td>'
        f'<td style="padding:6px 0;color:#f2f4f8">{day}</td></tr>'
        f'<tr><td style="padding:6px 0;color:#8a90a2">Turni oggi</td>'
        f'<td style="padding:6px 0;color:#f2f4f8">{int(turns)} / {int(hardcap)}</td></tr>'
        f'<tr><td style="padding:6px 0;color:#8a90a2">Giorni consecutivi ≥ 80%</td>'
        f'<td style="padding:6px 0;color:#f2f4f8">{int(consec)}</td></tr>'
        f'<tr><td style="padding:6px 0;color:#8a90a2">Media 30gg</td>'
        f'<td style="padding:6px 0;color:#f2f4f8">{avg_30d:.1f} turni/giorno</td></tr>'
        '</table>'
        f'<p style="margin:12px 0 0 0;color:#8a90a2;font-size:13px">{escape(interpretation)}</p>'
        '</td></tr>'
        '<tr><td style="padding:16px 24px;background:#12141c;border-top:1px solid #262a36;'
        'color:#6b7080;font-size:12px">'
        f'Inviato da {escape(EMAIL_FROM_NAME)}. Nessuna azione richiesta al destinatario. '
        'Nessuna password o dato sensibile viene mai richiesto via email.'
        '</td></tr></table></td></tr></table>'
    )


# ---------------------------------------------------------------------------
# Rate-limit check
# ---------------------------------------------------------------------------
async def _rate_limit_ok(db, profile_id: str) -> bool:
    """Returns True if a new email is allowed for profile_id, False otherwise."""
    now = datetime.now(timezone.utc)
    doc = await db.admin_alert_ratelimits.find_one({"profile_id": profile_id}, {"_id": 0})
    if doc and doc.get("last_sent_at_iso"):
        try:
            last = datetime.fromisoformat(doc["last_sent_at_iso"].replace("Z", "+00:00"))
            if (now - last).total_seconds() < _RATE_LIMIT_SECONDS:
                return False
        except Exception:
            pass
    return True


async def _mark_rate_limit(db, profile_id: str) -> None:
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.admin_alert_ratelimits.update_one(
        {"profile_id": profile_id},
        {"$set": {"profile_id": profile_id, "last_sent_at_iso": now_iso}},
        upsert=True,
    )


# ---------------------------------------------------------------------------
# Public: send a single outbox row (used by real-time trigger)
# ---------------------------------------------------------------------------
async def deliver_outbox_row(db, row: Dict[str, Any]) -> Dict[str, Any]:
    """Attempts to send a single admin_alert_outbox row.

    Returns a status dict:
        {"delivered": bool, "reason": str, "email_id": Optional[str]}
    """
    row_id = row.get("_id")
    profile_id = row.get("profile_id") or "unknown"
    subject = row.get("subject") or "[abuse-watch] alert"

    if not EMAIL_KEY:
        return {"delivered": False, "reason": "email_key_missing", "email_id": None}

    # Rate limit per profile
    if not await _rate_limit_ok(db, profile_id):
        await db.admin_alert_outbox.update_one(
            {"_id": row_id},
            {"$set": {"skipped": True, "skip_reason": "rate_limit", "skipped_at_iso":
                      datetime.now(timezone.utc).isoformat()}},
        )
        return {"delivered": False, "reason": "rate_limit", "email_id": None}

    # Prefer stored HTML if present, else render from the audit fields
    html = row.get("html")
    if not html:
        html = _render_abuse_alert_html(
            profile_id=profile_id,
            day_iso=str(row.get("day_iso", "")),
            consec=int(row.get("consec", 0)),
            turns=int(row.get("turns", 0)),
            hardcap=int(row.get("hardcap", 0)),
            avg_30d=float(row.get("avg_30d", 0.0)),
        )
    to_addr = (row.get("to") or _admin_email()).strip()

    try:
        email_id = await _send_email(to=to_addr, subject=subject, html=html)
        await _mark_rate_limit(db, profile_id)
        await db.admin_alert_outbox.update_one(
            {"_id": row_id},
            {"$set": {
                "delivered": True,
                "delivered_at_iso": datetime.now(timezone.utc).isoformat(),
                "email_id": email_id,
            }},
        )
        return {"delivered": True, "reason": "ok", "email_id": email_id}
    except Exception as e:
        logger.warning(f"[admin_email] delivery failed for {row_id}: {e}")
        await db.admin_alert_outbox.update_one(
            {"_id": row_id},
            {"$set": {"last_error": str(e)[:400],
                      "last_error_at_iso": datetime.now(timezone.utc).isoformat()}},
            upsert=False,
        )
        return {"delivered": False, "reason": "send_error", "email_id": None}


# ---------------------------------------------------------------------------
# Public: outbox flush (used by admin endpoint + startup)
# ---------------------------------------------------------------------------
async def flush_outbox(db, limit: int = 50) -> Dict[str, Any]:
    """Processes up to `limit` pending outbox rows. Safe to call anytime."""
    if not EMAIL_KEY:
        return {"processed": 0, "delivered": 0, "skipped": 0,
                "reason": "email_key_missing"}
    cursor = db.admin_alert_outbox.find(
        {"delivered": {"$ne": True}}
    ).sort("sent_at_iso", 1).limit(limit)
    rows = await cursor.to_list(limit)
    delivered = 0
    skipped = 0
    for row in rows:
        res = await deliver_outbox_row(db, row)
        if res["delivered"]:
            delivered += 1
        else:
            skipped += 1
    return {"processed": len(rows), "delivered": delivered, "skipped": skipped}


# ---------------------------------------------------------------------------
# Public: real-time trigger (called from free_tier_gate at alert creation)
# ---------------------------------------------------------------------------
async def enqueue_and_send(
    db,
    *,
    profile_id: str,
    day_iso: str,
    consec: int,
    turns: int,
    hardcap: int,
    avg_30d: float,
) -> Dict[str, Any]:
    """Inserts an outbox row and immediately attempts delivery."""
    to_addr = _admin_email()
    subject = f"[abuse-watch] {profile_id[:8]} vicino al daily hardcap"
    html = _render_abuse_alert_html(
        profile_id=profile_id, day_iso=day_iso, consec=consec,
        turns=turns, hardcap=hardcap, avg_30d=avg_30d,
    )
    plain = (
        f"Utente Premium: {profile_id}\n"
        f"Giorno: {day_iso}\n"
        f"Turni: {turns}/{hardcap}\n"
        f"Consecutivi >= 80%: {consec}\n"
        f"Media 30gg: {avg_30d:.1f}\n"
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "profile_id": profile_id,
        "to": to_addr,
        "subject": subject,
        "html": html,
        "body": plain,
        "day_iso": day_iso,
        "consec": consec,
        "turns": turns,
        "hardcap": hardcap,
        "avg_30d": avg_30d,
        "sent_at_iso": now_iso,
        "delivered": False,
    }
    ins = await db.admin_alert_outbox.insert_one(doc)
    doc["_id"] = ins.inserted_id
    # Fire delivery in background — do not block gate flow
    try:
        # Use asyncio.create_task so /api/converse returns immediately
        asyncio.create_task(deliver_outbox_row(db, doc))
        return {"queued": True, "outbox_id": str(ins.inserted_id)}
    except Exception as e:
        logger.warning(f"[admin_email] background dispatch failed: {e}")
        return {"queued": True, "outbox_id": str(ins.inserted_id), "warning": str(e)}
