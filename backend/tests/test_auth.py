"""Accounts and login sessions (F-3.12; design A1, A2, A4)."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import httpx
import pytest
from api_helpers import SETUP_TOKEN
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from geotandem.auth import accounts, sessions
from geotandem.auth.accounts import AccountError
from geotandem.data import DataBackend
from geotandem.db.orm import AuthSession, User

PASSWORD = "korrekt-pferd-batterie"


async def set_up(client: httpx.AsyncClient, **body: object) -> httpx.Response:
    return await client.post(
        "/api/auth/setup",
        json={"token": SETUP_TOKEN, "username": "admin", "password": PASSWORD, **body},
    )


# --- first administrator (A1) ------------------------------------------------


async def test_setup_creates_the_first_admin_once(anonymous: httpx.AsyncClient) -> None:
    assert (await anonymous.get("/api/auth/setup")).json()["needs_setup"] is True

    response = await set_up(anonymous, display_name="Systemverwaltung")
    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    assert sessions.COOKIE in response.cookies
    me = (await anonymous.get("/api/auth/me")).json()
    assert (me["username"], me["display_name"]) == ("admin", "Systemverwaltung")
    assert "password_hash" not in me

    assert (await anonymous.get("/api/auth/setup")).json()["needs_setup"] is False
    again = await set_up(anonymous, username="boss")
    assert (again.status_code, again.json()["code"]) == (409, "setup_closed")


def test_only_one_of_simultaneous_setups_succeeds(backend: DataBackend) -> None:
    def attempt(name: str) -> str:
        try:
            accounts.create(backend.engine, name, PASSWORD, "admin", first=True)
        except AccountError as exc:
            return exc.code
        return "ok"

    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(attempt, ["anna", "bert", "carl", "dora"]))
    assert sorted(results) == ["ok", "setup_closed", "setup_closed", "setup_closed"]


async def test_setup_enforces_password_rules(anonymous: httpx.AsyncClient) -> None:
    response = await set_up(anonymous, password="kurz")
    assert (response.status_code, response.json()["code"]) == (400, "password_too_short")
    assert (await anonymous.get("/api/auth/setup")).json()["needs_setup"] is True


async def test_cookie_is_http_only_and_strict(anonymous: httpx.AsyncClient) -> None:
    header = (await set_up(anonymous)).headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=strict" in header


# --- login and logout (A2) ---------------------------------------------------


async def test_login_logout(anonymous: httpx.AsyncClient) -> None:
    await set_up(anonymous)
    await anonymous.post("/api/auth/logout")
    assert (await anonymous.get("/api/auth/me")).status_code == 401

    response = await anonymous.post(
        "/api/auth/login", json={"username": "ADMIN", "password": PASSWORD}
    )
    assert response.status_code == 200
    assert (await anonymous.get("/api/auth/me")).json()["username"] == "admin"


@pytest.mark.parametrize(
    "credentials",
    [
        {"username": "admin", "password": "falsch-falsch"},
        {"username": "niemand", "password": PASSWORD},
    ],
)
async def test_failed_login_does_not_say_why(
    anonymous: httpx.AsyncClient, credentials: dict[str, str]
) -> None:
    await set_up(anonymous)
    anonymous.cookies.clear()
    response = await anonymous.post("/api/auth/login", json=credentials)
    assert response.status_code == 401
    assert response.json()["message"] == (
        "Username or password is wrong, or the account is locked."
    )


async def test_locked_account_cannot_sign_in_and_loses_its_session(
    anonymous: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    await set_up(anonymous)
    with Session(backend_of_client.engine) as session, session.begin():
        session.execute(update(User).values(status="locked"))
    assert (await anonymous.get("/api/auth/me")).status_code == 401
    response = await anonymous.post(
        "/api/auth/login", json={"username": "admin", "password": PASSWORD}
    )
    assert response.status_code == 401


# --- own password (A4) ---------------------------------------------------------


async def test_change_password(anonymous: httpx.AsyncClient) -> None:
    await set_up(anonymous)
    url = "/api/auth/password"
    wrong = await anonymous.post(
        url, json={"current": "falsch-falsch", "new": "gurten-nebel-abend-2"}
    )
    assert wrong.json()["code"] == "wrong_password"
    same = await anonymous.post(url, json={"current": PASSWORD, "new": PASSWORD})
    assert same.json()["code"] == "password_unchanged"
    short = await anonymous.post(url, json={"current": PASSWORD, "new": "kurz"})
    assert short.json()["code"] == "password_too_short"
    assert (
        await anonymous.post(url, json={"current": PASSWORD, "new": "gurten-nebel-abend-2"})
    ).status_code == 204

    anonymous.cookies.clear()
    old = await anonymous.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert old.status_code == 401
    new = await anonymous.post(
        "/api/auth/login", json={"username": "admin", "password": "gurten-nebel-abend-2"}
    )
    assert new.status_code == 200


async def test_changing_the_password_ends_the_other_logins(
    anonymous: httpx.AsyncClient, app: FastAPI
) -> None:
    await set_up(anonymous)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as elsewhere:
        await elsewhere.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
        assert (await elsewhere.get("/api/auth/me")).status_code == 200
        changed = await anonymous.post(
            "/api/auth/password", json={"current": PASSWORD, "new": "gurten-nebel-abend-2"}
        )
        assert changed.status_code == 204
        assert (await elsewhere.get("/api/auth/me")).status_code == 401
    assert (await anonymous.get("/api/auth/me")).status_code == 200


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
    lifetime = sessions.Lifetime(idle=timedelta(hours=1), absolute=timedelta(days=7))
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


def test_a_login_ends_after_its_absolute_lifetime_however_used(backend: DataBackend) -> None:
    """A stolen cookie kept in use does not stay valid for ever (security review #16)."""
    account = accounts.create(backend.engine, "m.keller", PASSWORD, "user")
    lifetime = sessions.Lifetime(idle=timedelta(hours=1), absolute=timedelta(hours=8))
    token = sessions.start(backend.engine, account.id, lifetime)

    def signed_in_since(hours: float) -> None:
        with Session(backend.engine) as session, session.begin():
            login = session.scalars(select(AuthSession)).one()
            login.created_at = sessions._now() - timedelta(hours=hours)
            login.expires_at = sessions._now() + timedelta(minutes=1)  # just used

    # Seven and a half hours in: use extends the expiry only up to the eighth hour.
    signed_in_since(7.5)
    assert sessions.resolve(backend.engine, token, lifetime) is not None
    with Session(backend.engine) as session:
        login = session.scalars(select(AuthSession)).one()
        assert login.expires_at == login.created_at + lifetime.absolute

    # Past the eighth hour: over, although used a minute ago.
    signed_in_since(8.1)
    assert sessions.resolve(backend.engine, token, lifetime) is None
