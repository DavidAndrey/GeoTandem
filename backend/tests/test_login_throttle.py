"""Brakes on password guessing (security review #2)."""

import threading
import time

import httpx
import pytest
from api_helpers import SETUP_TOKEN

from geotandem.auth import accounts
from geotandem.auth.throttle import LoginThrottle
from geotandem.data import DataBackend

PASSWORD = "korrekt-pferd-batterie"
WRONG = "falsch-falsch-falsch"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def fail(throttle: LoginThrottle, address: str, username: str, times: int) -> None:
    for _ in range(times):
        throttle.failed(address, username)


# --- the throttle ------------------------------------------------------------


def test_braking_starts_at_the_limit_per_username_and_address() -> None:
    throttle = LoginThrottle(per_account=3, per_address=100, window_s=60, clock=Clock())
    fail(throttle, "10.0.0.1", "anna", 2)
    assert throttle.retry_after("10.0.0.1", "anna") is None
    throttle.failed("10.0.0.1", "anna")
    assert throttle.retry_after("10.0.0.1", "anna") == 60
    # The same name from elsewhere, and another name from here, are not braked.
    assert throttle.retry_after("10.0.0.2", "anna") is None
    assert throttle.retry_after("10.0.0.1", "bert") is None


def test_usernames_count_as_accounts_normalise_them() -> None:
    throttle = LoginThrottle(per_account=2, per_address=100, window_s=60, clock=Clock())
    throttle.failed("a", "Anna")
    throttle.failed("a", " anna ")
    assert throttle.retry_after("a", "ANNA") is not None


def test_an_address_is_braked_across_usernames() -> None:
    throttle = LoginThrottle(per_account=100, per_address=3, window_s=60, clock=Clock())
    for name in ("anna", "bert", "carl"):
        throttle.failed("10.0.0.1", name)
    assert throttle.retry_after("10.0.0.1", "dora") == 60
    assert throttle.retry_after("10.0.0.2", "dora") is None


def test_failures_leave_the_window_one_by_one() -> None:
    clock = Clock()
    throttle = LoginThrottle(per_account=2, per_address=100, window_s=60, clock=clock)
    throttle.failed("a", "anna")
    clock.now += 30
    throttle.failed("a", "anna")
    assert throttle.retry_after("a", "anna") == 30  # until the first one leaves
    clock.now += 31  # the first failure has left the window
    assert throttle.retry_after("a", "anna") is None
    throttle.failed("a", "anna")
    assert throttle.retry_after("a", "anna") == pytest.approx(29)


def test_success_clears_its_username_but_not_the_address() -> None:
    throttle = LoginThrottle(per_account=3, per_address=6, window_s=60, clock=Clock())
    fail(throttle, "a", "anna", 2)
    fail(throttle, "a", "bert", 1)
    throttle.succeeded("a", "anna")
    fail(throttle, "a", "anna", 2)
    assert throttle.retry_after("a", "anna") is None  # 2 of 3 since the success
    throttle.failed("a", "carl")
    # One valid account must not reset the brake for guesses at others.
    assert throttle.retry_after("a", "dora") is not None


def test_memory_stays_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    from geotandem.auth import throttle as module

    monkeypatch.setattr(module, "MAX_KEYS", 10)
    throttle = LoginThrottle(per_account=5, per_address=5, window_s=60, clock=Clock())
    for i in range(100):
        throttle.failed(f"10.0.0.{i}", "anna")
    assert len(throttle._failures) <= 10


# --- accounts ----------------------------------------------------------------


def test_a_failed_sign_in_does_not_wait_for_the_write_lock(backend: DataBackend) -> None:
    accounts.create(backend.engine, "anna", PASSWORD, "user")
    with backend.engine.connect() as writer:
        writer.begin()  # BEGIN IMMEDIATE: holds the write lock
        started = time.monotonic()
        assert accounts.authenticate(backend.engine, "anna", WRONG) is None
        assert accounts.authenticate(backend.engine, "nobody", WRONG) is None
        assert time.monotonic() - started < 1
        writer.rollback()
    assert accounts.authenticate(backend.engine, "anna", PASSWORD) is not None


def test_a_password_changed_meanwhile_is_not_overwritten(backend: DataBackend) -> None:
    accounts.create(backend.engine, "anna", PASSWORD, "user")
    account, start = accounts.reset_password(backend.engine, "anna")
    with pytest.raises(accounts.AccountError) as raised:
        accounts.change_password(backend.engine, account.id, PASSWORD, "gurten-nebel-abend-2")
    assert raised.value.code == "wrong_password"
    assert accounts.authenticate(backend.engine, "anna", start) is not None


def test_overlong_passwords_are_refused(backend: DataBackend) -> None:
    with pytest.raises(accounts.AccountError) as raised:
        accounts.create(backend.engine, "anna", "x" * (accounts.MAX_PASSWORD_LENGTH + 1), "user")
    assert raised.value.code == "password_too_long"


# --- over HTTP ---------------------------------------------------------------


async def set_up(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/auth/setup",
        json={
            "token": SETUP_TOKEN,
            "username": "admin",
            "password": PASSWORD,
            "load_sample": False,
        },
    )
    assert response.status_code == 200, response.text
    client.cookies.clear()


async def login(client: httpx.AsyncClient, username: str, password: str) -> httpx.Response:
    return await client.post("/api/auth/login", json={"username": username, "password": password})


async def test_repeated_failures_brake_sign_in_even_with_the_right_password(
    anonymous: httpx.AsyncClient,
) -> None:
    await set_up(anonymous)
    for _ in range(10):  # GEOTANDEM_LOGIN_FAILURES
        assert (await login(anonymous, "admin", WRONG)).status_code == 401
    braked = await login(anonymous, "admin", PASSWORD)
    assert (braked.status_code, braked.json()["code"]) == (429, "too_many_attempts")
    assert braked.json()["message"] == "Too many failed sign-ins. Please try again in 15 minutes."
    assert int(braked.headers["retry-after"]) == braked.json()["details"]["retry_after_s"] == 900
    # Unknown usernames are braked alike: the answer says nothing about which exist.
    for _ in range(10):
        await login(anonymous, "niemand", WRONG)
    assert (await login(anonymous, "niemand", WRONG)).status_code == 429


async def test_a_success_clears_the_count_for_its_username(anonymous: httpx.AsyncClient) -> None:
    await set_up(anonymous)
    for _ in range(9):
        await login(anonymous, "admin", WRONG)
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200
    for _ in range(9):
        assert (await login(anonymous, "admin", WRONG)).status_code == 401


async def test_wrong_current_passwords_count_as_failed_sign_ins(
    anonymous: httpx.AsyncClient,
) -> None:
    await set_up(anonymous)
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200
    url = "/api/auth/password"
    for _ in range(10):
        wrong = await anonymous.post(url, json={"current": WRONG, "new": "gurten-nebel-abend-2"})
        assert wrong.json()["code"] == "wrong_password"
    braked = await anonymous.post(url, json={"current": PASSWORD, "new": "gurten-nebel-abend-2"})
    assert braked.status_code == 429


async def test_overlong_credentials_are_refused_before_hashing(
    anonymous: httpx.AsyncClient,
) -> None:
    response = await login(anonymous, "admin", "x" * (accounts.MAX_PASSWORD_LENGTH + 1))
    assert (response.status_code, response.json()["code"]) == (422, "schema_violation")


async def test_sign_in_answers_busy_while_every_hashing_slot_is_taken(
    anonymous: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await set_up(anonymous)
    slots = threading.BoundedSemaphore(1)
    monkeypatch.setattr(accounts, "_hashing", slots)
    monkeypatch.setattr(accounts, "HASHING_WAIT_S", 0.01)
    slots.acquire()
    try:
        response = await login(anonymous, "admin", PASSWORD)
    finally:
        slots.release()
    assert (response.status_code, response.json()["code"]) == (503, "busy")
    assert response.headers["retry-after"] == "5"
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200
