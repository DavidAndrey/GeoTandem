"""Brakes on password guessing (security review #2)."""

import asyncio
import threading
import time

import httpx
import pytest
from api_helpers import SETUP_TOKEN
from fastapi import FastAPI

from geotandem.api.slots import HashingSlots
from geotandem.auth import accounts
from geotandem.auth.throttle import Braked, LoginThrottle, client
from geotandem.data import DataBackend

PASSWORD = "korrekt-pferd-batterie"
WRONG = "falsch-falsch-falsch"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def fail(throttle: LoginThrottle, address: str, username: str, times: int = 1) -> None:
    for _ in range(times):
        throttle.attempt(address, username).failed()


def succeed(throttle: LoginThrottle, address: str, username: str) -> None:
    throttle.attempt(address, username, known_device=True).succeeded()


# --- the throttle ------------------------------------------------------------


def test_braking_starts_at_the_limit_per_username_and_address() -> None:
    throttle = LoginThrottle(per_account=3, per_address=100, window_s=60, clock=Clock())
    fail(throttle, "10.0.0.1", "anna", 2)
    assert throttle.retry_after("10.0.0.1", "anna") is None
    fail(throttle, "10.0.0.1", "anna")
    assert throttle.retry_after("10.0.0.1", "anna") == 60
    # The same name from elsewhere, and another name from here, are not braked.
    assert throttle.retry_after("10.0.0.2", "anna") is None
    assert throttle.retry_after("10.0.0.1", "bert") is None


def test_usernames_count_as_accounts_normalise_them() -> None:
    throttle = LoginThrottle(per_account=2, per_address=100, window_s=60, clock=Clock())
    fail(throttle, "a", "Anna")
    fail(throttle, "a", " anna ")
    assert throttle.retry_after("a", "ANNA") is not None


def test_an_address_is_braked_across_usernames() -> None:
    throttle = LoginThrottle(per_account=100, per_address=3, window_s=60, clock=Clock())
    for name in ("anna", "bert", "carl"):
        fail(throttle, "10.0.0.1", name)
    assert throttle.retry_after("10.0.0.1", "dora") == 60
    assert throttle.retry_after("10.0.0.2", "dora") is None


def test_failures_leave_the_window_one_by_one() -> None:
    clock = Clock()
    throttle = LoginThrottle(per_account=2, per_address=100, window_s=60, clock=clock)
    fail(throttle, "a", "anna")
    clock.now += 30
    fail(throttle, "a", "anna")
    assert throttle.retry_after("a", "anna") == 30  # until the first one leaves
    clock.now += 31  # the first failure has left the window
    assert throttle.retry_after("a", "anna") is None
    fail(throttle, "a", "anna")
    assert throttle.retry_after("a", "anna") == pytest.approx(29)


def test_success_clears_its_username_but_not_the_address() -> None:
    throttle = LoginThrottle(per_account=3, per_address=6, window_s=60, clock=Clock())
    fail(throttle, "a", "anna", 2)
    fail(throttle, "a", "bert", 1)
    succeed(throttle, "a", "anna")
    fail(throttle, "a", "anna", 2)
    assert throttle.retry_after("a", "anna") is None  # 2 of 3 since the success
    fail(throttle, "a", "carl")
    # One valid account must not reset the brake for guesses at others.
    assert throttle.retry_after("a", "dora") is not None


def test_guesses_at_one_username_from_many_clients_are_paced() -> None:
    """Spread over addresses, guesses are slowed down, not refused (security review #27)."""
    clock = Clock()
    throttle = LoginThrottle(
        per_account=10, per_address=10, per_username=3, window_s=600, pace_s=30, clock=clock
    )
    for i in range(3):
        fail(throttle, f"10.0.0.{i}", "anna")
    with pytest.raises(Braked) as braked:
        throttle.attempt("10.0.9.9", "anna")
    assert (braked.value.limit, braked.value.retry_after_s) == ("username", 30)
    assert throttle.retry_after("10.0.9.9", "bert") is None  # other usernames go on
    clock.now += 30
    fail(throttle, "10.0.9.9", "anna")  # one check per pace
    assert throttle.retry_after("10.0.8.8", "anna") == 30
    # A browser that has signed in to the account before is not paced.
    assert throttle.retry_after("10.0.8.8", "anna", known_device=True) is None
    succeed(throttle, "10.0.8.8", "anna")
    assert throttle.retry_after("10.0.7.7", "anna") == 30  # its success clears no one else's


def test_attempts_running_at_once_all_count() -> None:
    """Counted when they start, not when they fail: parallel guesses cannot all pass
    the check before the first one fails (security review #24)."""
    throttle = LoginThrottle(per_account=2, per_address=100, window_s=60, clock=Clock())
    throttle.attempt("a", "anna")
    throttle.attempt("a", "anna")
    with pytest.raises(Braked) as braked:
        throttle.attempt("a", "anna")
    assert braked.value.retry_after_s == 60


def test_an_attempt_that_tested_no_password_is_taken_back() -> None:
    throttle = LoginThrottle(per_account=1, per_address=1, window_s=60, clock=Clock())
    with throttle.attempt("a", "anna"):
        pass  # e.g. busy, or the new password broke a rule
    with pytest.raises(RuntimeError), throttle.attempt("a", "anna"):
        raise RuntimeError
    assert throttle.retry_after("a", "anna") is None


def test_successes_do_not_count_against_the_address() -> None:
    throttle = LoginThrottle(per_account=2, per_address=2, window_s=60, clock=Clock())
    for _ in range(5):
        succeed(throttle, "a", "anna")
    assert throttle.retry_after("a", "bert") is None


def test_an_ipv6_client_is_counted_by_its_64() -> None:
    """One customer gets a whole /64: a fresh address must not be a fresh count (review #22)."""
    throttle = LoginThrottle(per_account=3, per_address=5, window_s=60, clock=Clock())
    for host in ("2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff:ffff:ffff:ffff"):
        fail(throttle, host, "anna")
    assert throttle.retry_after("2001:db8:1:2:abcd::9", "anna") == 60
    assert throttle.retry_after("2001:db8:1:3::1", "anna") is None  # the next /64
    fail(throttle, "2001:db8:1:2::7", "bert", 2)
    assert throttle.retry_after("2001:db8:1:2::8", "carl") == 60  # the address limit too


@pytest.mark.parametrize(
    ("address", "counted_as"),
    [
        ("192.0.2.1", "192.0.2.1"),
        ("::ffff:192.0.2.1", "192.0.2.1"),
        ("2001:db8::1", "2001:db8::/64"),
        ("fe80::1%eth0", "fe80::/64"),
        ("unknown", "unknown"),
    ],
)
def test_who_counts_as_one_client(address: str, counted_as: str) -> None:
    assert client(address) == counted_as


def test_memory_stays_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    from geotandem.auth import throttle as module

    monkeypatch.setattr(module, "MAX_KEYS", 10)
    throttle = LoginThrottle(per_account=5, per_address=5, window_s=60, clock=Clock())
    for i in range(100):
        fail(throttle, f"10.0.0.{i}", "anna")
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


async def test_sign_ins_wait_for_a_password_check_on_no_worker_thread(
    anonymous: httpx.AsyncClient, app: FastAPI
) -> None:
    """More waiting sign-ins than worker threads (40): the rest of the API still answers
    (security review #23)."""
    await set_up(anonymous)
    state = app.state.geotandem
    state.hashing_slots = HashingSlots(total=1, wait_s=5)
    async with state.hashing_slots.hold():
        waiting = [asyncio.create_task(login(anonymous, "admin", WRONG)) for _ in range(60)]
        await asyncio.sleep(0.2)
        started = time.monotonic()
        assert (await anonymous.get("/api/auth/setup")).status_code == 200
        assert time.monotonic() - started < 1
        assert not any(task.done() for task in waiting)
    answers = [response.status_code for response in await asyncio.gather(*waiting)]
    assert set(answers) <= {401, 429}
    assert answers.count(401) == 10  # GEOTANDEM_LOGIN_FAILURES, then braked


async def test_sign_in_answers_busy_while_it_waits_too_long_for_a_check(
    anonymous: httpx.AsyncClient, app: FastAPI
) -> None:
    await set_up(anonymous)
    state = app.state.geotandem
    state.hashing_slots = HashingSlots(total=1, wait_s=0.01)
    async with state.hashing_slots.hold():
        response = await login(anonymous, "admin", PASSWORD)
        changed = await anonymous.post(
            "/api/auth/password", json={"current": PASSWORD, "new": "gurten-nebel-abend-2"}
        )
    assert (response.status_code, response.json()["code"]) == (503, "busy")
    assert response.headers["retry-after"] == "5"
    assert changed.status_code == 401  # not signed in: refused before waiting for a check
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200


async def test_sign_ins_at_once_are_braked_at_the_limit(
    anonymous: httpx.AsyncClient, app: FastAPI
) -> None:
    """Each counted as it starts: as many guesses at once as there are slots get no
    further than the limit (security review #24). Before, 40 of 60 got through."""
    await set_up(anonymous)
    state = app.state.geotandem
    state.hashing_slots = HashingSlots(total=40, wait_s=5)
    answers = await asyncio.gather(*(login(anonymous, "admin", WRONG) for _ in range(60)))
    codes = [response.status_code for response in answers]
    assert codes.count(401) == 10 and codes.count(429) == 50


async def test_a_new_password_breaking_a_rule_is_no_failed_attempt(
    anonymous: httpx.AsyncClient,
) -> None:
    await set_up(anonymous)
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200
    for _ in range(12):
        refused = await anonymous.post(
            "/api/auth/password", json={"current": PASSWORD, "new": "kurz"}
        )
        assert refused.json()["code"] != "too_many_attempts"


async def test_a_flooded_username_still_lets_its_owner_in(
    anonymous: httpx.AsyncClient, app: FastAPI
) -> None:
    """Guesses at "admin" from 21 addresses: the 21st is paced, the owner's browser,
    which has signed in before, is not (security review #27)."""
    await set_up(anonymous)
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200
    assert (await anonymous.post("/api/auth/logout")).status_code == 204
    assert anonymous.cookies.get("geotandem_device")  # kept on sign-out

    async def guess(host: str) -> httpx.Response:
        transport = httpx.ASGITransport(app=app, client=(host, 4711))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as stranger:
            return await login(stranger, "admin", WRONG)

    for i in range(20):  # GEOTANDEM_LOGIN_FAILURES_PER_USERNAME
        assert (await guess(f"2001:db8:{i}::1")).status_code == 401
    paced = await guess("2001:db8:99::1")
    assert (paced.status_code, paced.json()["code"]) == (429, "too_many_attempts")
    assert 0 < paced.json()["details"]["retry_after_s"] <= 30
    assert (await login(anonymous, "admin", PASSWORD)).status_code == 200
