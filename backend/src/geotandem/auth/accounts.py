"""Local accounts with two roles (F-3.12, etappen 11.1).

Passwords are hashed with Argon2 (tech-stack 3.6); the hash never leaves
this module's callers as anything but an opaque string in the database.
"""

from __future__ import annotations

import re
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Literal

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from pydantic import BaseModel
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from geotandem.db.orm import AuthSession, Role, User
from geotandem.db.spatialite import reading

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 1024
"""Bounds the hashing work one request can ask for."""
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")

_hasher = PasswordHasher()
# Verified when the username is unknown, so a failed login takes as long
# either way and does not reveal which accounts exist.
_DUMMY_HASH = _hasher.hash(secrets.token_hex(16))

MAX_HASHING = 4
"""Password checks at once. Each takes Argon2's memory (64 MB by default), so a
flood of sign-ins queues here instead of exhausting the server (review #2)."""
HASHING_WAIT_S = 10.0
_hashing = threading.BoundedSemaphore(MAX_HASHING)


class HashingBusy(Exception):
    """Every password-check slot stayed taken for ``HASHING_WAIT_S``."""


class AccountError(Exception):
    """A rule about accounts was violated; ``code`` is stable for the UI."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Account(BaseModel):
    id: int
    username: str
    display_name: str
    role: Role
    status: str
    must_change_password: bool
    created_at: datetime
    last_login_at: datetime | None


def _account(user: User) -> Account:
    return Account.model_validate(user, from_attributes=True)


def check_password(password: str, old: str | None = None) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AccountError(
            "password_too_short",
            f"The password needs at least {MIN_PASSWORD_LENGTH} characters.",
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise AccountError(
            "password_too_long",
            f"The password may have at most {MAX_PASSWORD_LENGTH} characters.",
        )
    if old is not None and password == old:
        raise AccountError("password_unchanged", "The new password must differ from the old one.")


def generate_password() -> str:
    """A start password for a new or reset account (design D9)."""
    return secrets.token_urlsafe(12)


def has_accounts(engine: Engine) -> bool:
    with Session(reading(engine)) as session:
        return bool(session.scalar(select(func.count()).select_from(User)))


def create(
    engine: Engine,
    username: str,
    password: str,
    role: Role,
    *,
    display_name: str = "",
    must_change_password: bool = False,
    first: bool = False,
) -> Account:
    """``first``: only while no account exists — checked in the same transaction, so
    of two setups at once only one succeeds (design A1)."""
    username = username.strip().lower()
    if not USERNAME.match(username):
        raise AccountError(
            "invalid_username",
            "Usernames have 2 to 63 characters: lower-case letters, digits, '.', '_' and '-'.",
        )
    check_password(password)
    # Hashed before the transaction: waiting for a hashing slot must not hold the write lock.
    password_hash = _hash(password)
    with Session(engine) as session, session.begin():
        if first and session.scalar(select(func.count()).select_from(User)):
            raise AccountError("setup_closed", "The application is already set up.")
        if session.scalar(select(User.id).where(User.username == username)):
            raise AccountError("username_taken", f"The username '{username}' is taken.")
        user = User(
            username=username,
            display_name=display_name.strip(),
            password_hash=password_hash,
            role=role,
            status="active",
            must_change_password=must_change_password,
        )
        session.add(user)
        session.flush()
        return _account(user)


def authenticate(engine: Engine, username: str, password: str) -> Account | None:
    """The account for these credentials, or ``None``: unknown, wrong or locked alike.

    The password is checked outside any write transaction: a failed attempt
    must not take the database's write lock (review #2). Only a success writes.
    """
    with Session(reading(engine)) as session:
        user = session.scalar(select(User).where(User.username == username.strip().lower()))
        found = None if user is None else (user.id, user.password_hash, user.status)
    if found is None:
        _verify(_DUMMY_HASH, password)
        return None
    user_id, password_hash, status = found
    if not _verify(password_hash, password) or status != "active":
        return None
    rehashed = _hash(password) if _hasher.check_needs_rehash(password_hash) else None
    with Session(engine) as session, session.begin():
        user = session.get(User, user_id)
        # Locked, deleted or given a new password while the hash was checked.
        if user is None or user.status != "active" or user.password_hash != password_hash:
            return None
        if rehashed is not None:
            user.password_hash = rehashed
        user.last_login_at = session.scalar(select(func.current_timestamp()))
        return _account(user)


def failure_reason(engine: Engine, username: str) -> str:
    """Why ``authenticate`` refused, for the security log only (review #13).

    Read after the fact, so the refusal itself stays the same for every reason.
    """
    with Session(reading(engine)) as session:
        user = session.scalar(select(User).where(User.username == username.strip().lower()))
        if user is None:
            return "unknown_user"
        return "wrong_password" if user.status == "active" else f"account_{user.status}"


def change_password(engine: Engine, user_id: int, current: str, new: str) -> None:
    """Hashing happens outside the write transaction, as in ``authenticate``."""
    wrong = AccountError("wrong_password", "The current password is wrong.")
    with Session(reading(engine)) as session:
        old_hash = session.get_one(User, user_id).password_hash
    if not _verify(old_hash, current):
        raise wrong
    check_password(new, old=current)
    new_hash = _hash(new)
    with Session(engine) as session, session.begin():
        user = session.get_one(User, user_id)
        if user.password_hash != old_hash:  # changed or reset meanwhile
            raise wrong
        user.password_hash = new_hash
        user.must_change_password = False


def reset_password(engine: Engine, username: str) -> tuple[Account, str]:
    """Set a generated start password the user must change; end their sessions (design D9)."""
    password = generate_password()
    password_hash = _hash(password)
    with Session(engine) as session, session.begin():
        user = _user(session, username)
        user.password_hash = password_hash
        user.must_change_password = True
        revoke_sessions(session, user.id)
        return _account(user), password


def get(engine: Engine, user_id: int) -> Account | None:
    with Session(reading(engine)) as session:
        user = session.get(User, user_id)
        return _account(user) if user else None


@contextmanager
def _hashing_slot() -> Iterator[None]:
    if not _hashing.acquire(timeout=HASHING_WAIT_S):
        raise HashingBusy
    try:
        yield
    finally:
        _hashing.release()


def _hash(password: str) -> str:
    with _hashing_slot():
        return _hasher.hash(password)


def _verify(hashed: str, password: str) -> bool:
    with _hashing_slot():
        try:
            return _hasher.verify(hashed, password)
        except (VerificationError, InvalidHashError):
            return False


def revoke_sessions(session: Session, user_id: int) -> None:
    """End every login of an account, e.g. when it is locked or its password reset."""
    for login in session.scalars(select(AuthSession).where(AuthSession.user_id == user_id)):
        session.delete(login)


# --- administration (design D9) -----------------------------------------------


class AccountUpdate(BaseModel):
    display_name: str | None = None
    role: Role | None = None
    status: Literal["active", "locked"] | None = None


def list_accounts(engine: Engine) -> list[Account]:
    with Session(reading(engine)) as session:
        return [_account(u) for u in session.scalars(select(User).order_by(User.username))]


def _user(session: Session, username: str) -> User:
    user = session.scalar(select(User).where(User.username == username.strip().lower()))
    if user is None:
        raise AccountError("unknown_user", f"There is no account '{username}'.")
    return user


def _guard_last_admin(session: Session, user: User) -> None:
    """Refuse to leave the instance without an active administrator (design D9)."""
    if user.role != "admin" or user.status != "active":
        return
    others = session.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role == "admin", User.status == "active", User.id != user.id)
    )
    if not others:
        raise AccountError(
            "last_admin", "The last active administrator cannot be demoted, locked or deleted."
        )


def update(engine: Engine, username: str, change: AccountUpdate) -> Account:
    with Session(engine) as session, session.begin():
        user = _user(session, username)
        demoted = change.role is not None and change.role != "admin"
        locked = change.status == "locked"
        if demoted or locked:
            _guard_last_admin(session, user)
        if change.display_name is not None:
            user.display_name = change.display_name.strip()
        if change.role is not None:
            user.role = change.role
        if change.status is not None:
            user.status = change.status
            if locked:
                revoke_sessions(session, user.id)
        session.flush()
        return _account(user)


def delete(engine: Engine, username: str) -> None:
    with Session(engine) as session, session.begin():
        user = _user(session, username)
        _guard_last_admin(session, user)
        session.delete(user)
