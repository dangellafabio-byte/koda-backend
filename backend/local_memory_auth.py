"""Phase 17: strict, uncached authorization for experimental local context."""
from datetime import datetime, timezone


async def verified_memory_uid(sessions, token, email_to_uid):
    if not isinstance(token, str) or not token or len(token) > 4096:
        return None
    try:
        session = await sessions.find_one({'session_token': token})
        if not session:
            return None
        expiry = session.get('expires_at')
        if not isinstance(expiry, datetime):
            return None
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry <= datetime.now(timezone.utc):
            return None
        email = session.get('email')
        if not isinstance(email, str) or not email.strip():
            return None
        email = email.strip().lower()
        if email == 'dev@koda.local':
            return None
        uid = email_to_uid(email)
        return uid if uid and uid != 'me' else None
    except Exception:
        return None


def request_token(request):
    auth = request.headers.get('authorization', '') or ''
    if auth:
        return auth[7:].strip() if auth.lower().startswith('bearer ') else None
    return request.cookies.get('session_token')
