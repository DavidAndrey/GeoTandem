"""Server-side login sessions behind an HttpOnly cookie (tech-stack 3.6).

The cookie carries a random token; the database stores only its SHA-256, so
a copy of the database does not hand out valid logins. Expiry slides with
use, written at most once a minute, but never beyond an absolute lifetime
from sign-in (security review #16).
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine, delete, select, update
from sqlalchemy.orm import Session

from geotandem.auth.accounts import Account
from geotandem.db.orm import AuthSession
from geotandem.db.spatialite import reading

COOKIE = "geotandem_session"
SECURE_COOKIE = f"__Host-{COOKIE}"
"""The name over HTTPS. A browser accepts it only from this very host, ``Secure`` and
for ``/``, so a sibling subdomain cannot plant a login of its own (security review #18)."""
_REFRESH = timedelta(minutes=1)
MAX_LOGINS = 20
"""Logins kept per account; a new one beyond ends the oldest (security review #6)."""


@dataclass(frozen=True)
class Lifetime:
    idle: timedelta
    """Unused this long, a login ends; every use extends it."""
    absolute: timedelta
    """From sign-in, whatever the use: a stolen cookie in use stays valid no longer
    (security review #16)."""


def cookie_name(secure: bool) -> str:
    """Which cookie holds the login; ``secure`` as the cookie is set (``Secure`` or not)."""
    return SECURE_COOKIE if secure else COOKIE


def _now() -> datetime:
    # SQLite stores naive timestamps; all of ours are UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start(engine: Engine, user_id: int, lifetime: Lifetime) -> str:
    token = secrets.token_urlsafe(32)
    with Session(engine) as session, session.begin():
        session.execute(delete(AuthSession).where(AuthSession.expires_at < _now()))
        expires_at = _now() + min(lifetime.idle, lifetime.absolute)
        session.add(AuthSession(token_hash=_digest(token), user_id=user_id, expires_at=expires_at))
        session.flush()
        # Sliding expiry: the login used least recently expires first.
        surplus = (
            select(AuthSession.token_hash)
            .where(AuthSession.user_id == user_id)
            .order_by(AuthSession.expires_at.desc())
            .offset(MAX_LOGINS)
        )
        session.execute(delete(AuthSession).where(AuthSession.token_hash.in_(surplus)))
    return token


def resolve(engine: Engine, token: str | None, lifetime: Lifetime) -> Account | None:
    """The account behind a session token, if the session is valid and the account active.

    Use extends the expiry by ``lifetime.idle``, up to ``lifetime.absolute`` after
    sign-in; a login past that ends even while in use.
    """
    if not token:
        return None
    # Read without the write lock, as on every request: an import storing its rows
    # must not hold up everyone else. Expired logins are removed by ``start``.
    digest = _digest(token)
    with Session(reading(engine)) as session:
        login = session.scalar(select(AuthSession).where(AuthSession.token_hash == digest))
        now = _now()
        if login is None:
            return None
        ends = login.created_at + lifetime.absolute
        if min(login.expires_at, ends) < now or login.user.status != "active":
            return None
        account = Account.model_validate(login.user, from_attributes=True)
        extended = min(now + lifetime.idle, ends)
        due = extended - login.expires_at > _REFRESH
    if due:
        with Session(engine) as session, session.begin():
            session.execute(
                update(AuthSession)
                .where(AuthSession.token_hash == digest)
                .values(expires_at=extended)
            )
    return account


def end(engine: Engine, token: str | None) -> None:
    if not token:
        return
    with Session(engine) as session, session.begin():
        session.execute(delete(AuthSession).where(AuthSession.token_hash == _digest(token)))


def end_others(engine: Engine, user_id: int, token: str | None) -> None:
    """End every login of an account but this one, e.g. after a password change."""
    keep = _digest(token) if token else None
    with Session(engine) as session, session.begin():
        session.execute(
            delete(AuthSession).where(
                AuthSession.user_id == user_id, AuthSession.token_hash != keep
            )
        )
