"""Local accounts with two roles (F-3.12, etappen 11.1).

Passwords are hashed with Argon2 (tech-stack 3.6); the hash never leaves
this module's callers as anything but an opaque string in the database.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime
from typing import Literal

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from pydantic import BaseModel
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from geotandem.db.orm import AuthSession, Role, User

MIN_PASSWORD_LENGTH = 10
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")

_hasher = PasswordHasher()
# Verified when the username is unknown, so a failed login takes as long
# either way and does not reveal which accounts exist.
_DUMMY_HASH = _hasher.hash(secrets.token_hex(16))


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
    if old is not None and password == old:
        raise AccountError("password_unchanged", "The new password must differ from the old one.")


def generate_password() -> str:
    """A start password for a new or reset account (design D9)."""
    return secrets.token_urlsafe(12)


def has_accounts(engine: Engine) -> bool:
    with Session(engine) as session:
        return bool(session.scalar(select(func.count()).select_from(User)))


def create(
    engine: Engine,
    username: str,
    password: str,
    role: Role,
    *,
    display_name: str = "",
    must_change_password: bool = False,
) -> Account:
    username = username.strip().lower()
    if not USERNAME.match(username):
        raise AccountError(
            "invalid_username",
            "Usernames have 2 to 63 characters: lower-case letters, digits, '.', '_' and '-'.",
        )
    check_password(password)
    with Session(engine) as session, session.begin():
        if session.scalar(select(User.id).where(User.username == username)):
            raise AccountError("username_taken", f"The username '{username}' is taken.")
        user = User(
            username=username,
            display_name=display_name.strip(),
            password_hash=_hasher.hash(password),
            role=role,
            status="active",
            must_change_password=must_change_password,
        )
        session.add(user)
        session.flush()
        return _account(user)


def authenticate(engine: Engine, username: str, password: str) -> Account | None:
    """The account for these credentials, or ``None``: unknown, wrong or locked alike."""
    with Session(engine) as session, session.begin():
        user = session.scalar(select(User).where(User.username == username.strip().lower()))
        if user is None:
            _verify(_DUMMY_HASH, password)
            return None
        if not _verify(user.password_hash, password) or user.status != "active":
            return None
        if _hasher.check_needs_rehash(user.password_hash):
            user.password_hash = _hasher.hash(password)
        user.last_login_at = session.scalar(select(func.current_timestamp()))
        return _account(user)


def change_password(engine: Engine, user_id: int, current: str, new: str) -> None:
    with Session(engine) as session, session.begin():
        user = session.get_one(User, user_id)
        if not _verify(user.password_hash, current):
            raise AccountError("wrong_password", "The current password is wrong.")
        check_password(new, old=current)
        user.password_hash = _hasher.hash(new)
        user.must_change_password = False


def reset_password(engine: Engine, username: str) -> str:
    """Set a generated start password the user must change; end their sessions (design D9)."""
    password = generate_password()
    with Session(engine) as session, session.begin():
        user = _user(session, username)
        user.password_hash = _hasher.hash(password)
        user.must_change_password = True
        revoke_sessions(session, user.id)
    return password


def get(engine: Engine, user_id: int) -> Account | None:
    with Session(engine) as session:
        user = session.get(User, user_id)
        return _account(user) if user else None


def _verify(hashed: str, password: str) -> bool:
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
    with Session(engine) as session:
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
