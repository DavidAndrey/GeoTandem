"""Server-side login sessions behind an HttpOnly cookie (tech-stack 3.6).

The cookie carries a random token; the database stores only its SHA-256, so
a copy of the database does not hand out valid logins. Expiry slides with
use, written at most once a minute.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine, delete, select
from sqlalchemy.orm import Session

from geotandem.auth.accounts import Account
from geotandem.db.orm import AuthSession

COOKIE = "geotandem_session"
_REFRESH = timedelta(minutes=1)


def _now() -> datetime:
    # SQLite stores naive timestamps; all of ours are UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start(engine: Engine, user_id: int, lifetime: timedelta) -> str:
    token = secrets.token_urlsafe(32)
    with Session(engine) as session, session.begin():
        session.execute(delete(AuthSession).where(AuthSession.expires_at < _now()))
        session.add(
            AuthSession(token_hash=_digest(token), user_id=user_id, expires_at=_now() + lifetime)
        )
    return token


def resolve(engine: Engine, token: str | None, lifetime: timedelta) -> Account | None:
    """The account behind a session token, if the session is valid and the account active."""
    if not token:
        return None
    with Session(engine) as session, session.begin():
        login = session.scalar(select(AuthSession).where(AuthSession.token_hash == _digest(token)))
        if login is None:
            return None
        now = _now()
        if login.expires_at < now or login.user.status != "active":
            session.delete(login)
            return None
        if login.expires_at - lifetime + _REFRESH < now:
            login.expires_at = now + lifetime
        return Account.model_validate(login.user, from_attributes=True)


def end(engine: Engine, token: str | None) -> None:
    if not token:
        return
    with Session(engine) as session, session.begin():
        session.execute(delete(AuthSession).where(AuthSession.token_hash == _digest(token)))
