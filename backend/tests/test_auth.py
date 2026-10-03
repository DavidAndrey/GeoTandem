"""Accounts and login sessions (F-3.12; design A1, A2, A4)."""

from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from geotandem.auth import accounts, sessions
from geotandem.auth.accounts import AccountError
from geotandem.data import DataBackend
from geotandem.db.orm import AuthSession, User

PASSWORD = "korrekt-pferd-batterie"


async def set_up(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(
        "/api/auth/setup", json={"username": "admin", "password": PASSWORD, **body}
    )


# --- first administrator (A1) ------------------------------------------------


async def test_setup_creates_the_first_admin_once(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/auth/setup")).json()["needs_setup"] is True

    response = await set_up(client, display_name="Systemverwaltung")
    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    assert sessions.COOKIE in response.cookies
    me = (await client.get("/api/auth/me")).json()
    assert (me["username"], me["display_name"]) == ("admin", "Systemverwaltung")
    assert "password_hash" not in me

    assert (await client.get("/api/auth/setup")).json()["needs_setup"] is False
    again = await client.post("/api/auth/setup", json={"username": "boss", "password": PASSWORD})
    assert (again.status_code, again.json()["code"]) == (409, "setup_closed")


async def test_setup_enforces_password_rules(client: httpx.AsyncClient) -> None:
    response = await set_up(client, password="kurz")
    assert (response.status_code, response.json()["code"]) == (400, "password_too_short")
    assert (await client.get("/api/auth/setup")).json()["needs_setup"] is True


async def test_cookie_is_http_only_and_strict(client: httpx.AsyncClient) -> None:
    header = (await set_up(client)).headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=strict" in header


# --- login and logout (A2) ---------------------------------------------------


async def test_login_logout(client: httpx.AsyncClient) -> None:
    await set_up(client)
    await client.post("/api/auth/logout")
    assert (await client.get("/api/auth/me")).status_code == 401

    response = await client.post(
        "/api/auth/login", json={"username": "ADMIN", "password": PASSWORD}
    )
    assert response.status_code == 200
    assert (await client.get("/api/auth/me")).json()["username"] == "admin"


@pytest.mark.parametrize(
    "credentials",
    [
        {"username": "admin", "password": "falsch-falsch"},
        {"username": "niemand", "password": PASSWORD},
    ],
)
async def test_failed_login_does_not_say_why(
    client: httpx.AsyncClient, credentials: dict[str, str]
) -> None:
    await set_up(client)
    client.cookies.clear()
    response = await client.post("/api/auth/login", json=credentials)
    assert response.status_code == 401
    assert response.json()["message"] == (
        "Username or password is wrong, or the account is locked."
    )


async def test_locked_account_cannot_sign_in_and_loses_its_session(
    client: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    await set_up(client)
    with Session(backend_of_client.engine) as session, session.begin():
        session.execute(update(User).values(status="locked"))
    assert (await client.get("/api/auth/me")).status_code == 401
    response = await client.post(
        "/api/auth/login", json={"username": "admin", "password": PASSWORD}
    )
    assert response.status_code == 401


# --- own password (A4) ---------------------------------------------------------


async def test_change_password(client: httpx.AsyncClient) -> None:
    await set_up(client)
    url = "/api/auth/password"
    wrong = await client.post(url, json={"current": "falsch-falsch", "new": "neues-passwort-1"})
    assert wrong.json()["code"] == "wrong_password"
    same = await client.post(url, json={"current": PASSWORD, "new": PASSWORD})
    assert same.json()["code"] == "password_unchanged"
    short = await client.post(url, json={"current": PASSWORD, "new": "kurz"})
    assert short.json()["code"] == "password_too_short"
    assert (
        await client.post(url, json={"current": PASSWORD, "new": "neues-passwort-1"})
    ).status_code == 204

    client.cookies.clear()
    old = await client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert old.status_code == 401
    new = await client.post(
        "/api/auth/login", json={"username": "admin", "password": "neues-passwort-1"}
    )
    assert new.status_code == 200


# --- accounts and sessions without HTTP ---------------------------------------


def test_passwords_are_stored_as_argon2(backend: DataBackend) -> None:
    accounts.create(backend.engine, "m.keller", PASSWORD, "user")
    with Session(backend.engine) as session:
        stored = session.scalar(select(User.password_hash))
    assert stored is not None and stored.startswith("$argon2id$") and PASSWORD not in stored


@pytest.mark.parametrize("username", ["a", "Mara Keller", "-x", "x" * 64])
def test_invalid_usernames(backend: DataBackend, username: str) -> None:
    with pytest.raises(AccountError) as info:
        accounts.create(backend.engine, username, PASSWORD, "user")
    assert info.value.code == "invalid_username"


def test_duplicate_username(backend: DataBackend) -> None:
    accounts.create(backend.engine, "m.keller", PASSWORD, "user")
    with pytest.raises(AccountError) as info:
        accounts.create(backend.engine, "M.Keller", PASSWORD, "user")
    assert info.value.code == "username_taken"


def test_session_expires_and_slides(backend: DataBackend) -> None:
    account = accounts.create(backend.engine, "m.keller", PASSWORD, "user")
    lifetime = timedelta(hours=1)
    token = sessions.start(backend.engine, account.id, lifetime)
    with Session(backend.engine) as session:
        stored = session.scalar(select(AuthSession.token_hash))
    assert stored is not None and token not in stored  # only the hash is stored

    # Nearly expired, then used: the expiry moves forward.
    with Session(backend.engine) as session, session.begin():
        login = session.scalars(select(AuthSession)).one()
        login.expires_at -= timedelta(minutes=55)
        before = login.expires_at
    assert sessions.resolve(backend.engine, token, lifetime) is not None
    with Session(backend.engine) as session:
        assert session.scalars(select(AuthSession)).one().expires_at > before

    # Expired: gone.
    with Session(backend.engine) as session, session.begin():
        session.scalars(select(AuthSession)).one().expires_at -= timedelta(hours=2)
    assert sessions.resolve(backend.engine, token, lifetime) is None
    assert sessions.resolve(backend.engine, "made-up", lifetime) is None
