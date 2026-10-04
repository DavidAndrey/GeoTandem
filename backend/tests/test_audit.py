"""The security log (security review #13)."""

import json
import logging
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, SETUP_TOKEN, USER_PASSWORD, sign_in_as
from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.orm import Session

from geotandem import audit
from geotandem.cli import main
from geotandem.data import DataBackend
from geotandem.db.orm import User

Events = list[dict[str, Any]]


@pytest.fixture
def events() -> Iterator[Events]:
    """What the security log records, as dicts: the event's name plus its fields."""
    found: Events = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            found.append({"event": record.getMessage(), **record.audit})  # type: ignore[attr-defined]

    handler = Collect()
    audit.log.addHandler(handler)
    level = audit.log.level
    audit.log.setLevel(logging.INFO)
    yield found
    audit.log.removeHandler(handler)
    audit.log.setLevel(level)


def named(events: Events, name: str) -> list[dict[str, Any]]:
    return [e for e in events if e["event"] == name]


async def login(client: httpx.AsyncClient, username: str, password: str) -> httpx.Response:
    return await client.post("/api/auth/login", json={"username": username, "password": password})


# --- sign-in ---------------------------------------------------------------------


async def test_sign_ins_are_logged_with_the_reason_of_a_failure(
    client: httpx.AsyncClient, backend_of_client: DataBackend, events: Events
) -> None:
    await sign_in_as(client, "m.keller")
    client.cookies.clear()
    events.clear()

    assert (await login(client, "niemand", "egal-egal-egal")).status_code == 401
    assert (await login(client, "admin", "falsch-falsch")).status_code == 401
    with Session(backend_of_client.engine) as session, session.begin():
        session.execute(update(User).where(User.username == "m.keller").values(status="locked"))
    assert (await login(client, "m.keller", USER_PASSWORD)).status_code == 401
    assert (await login(client, "admin", ADMIN_PASSWORD)).status_code == 200

    failed = named(events, "sign_in_failed")
    # An unknown username may be a password typed one field too early (review #26).
    assert [(e.get("username"), e["reason"]) for e in failed] == [
        (None, "unknown_user"),
        ("admin", "wrong_password"),
        ("m.keller", "account_locked"),
    ]
    [success] = named(events, "sign_in")
    assert success == {
        "event": "sign_in",
        "username": "admin",
        "address": "127.0.0.1",
        "method": "POST",
        "path": "/api/auth/login",
    }
    # The answer stays the same for every reason; only the log tells them apart.
    assert "egal-egal-egal" not in json.dumps(events)
    assert ADMIN_PASSWORD not in json.dumps(events)


async def test_throttled_sign_ins_are_logged(client: httpx.AsyncClient, events: Events) -> None:
    client.cookies.clear()
    for _ in range(11):
        await login(client, "admin", "falsch-falsch")
    [throttled] = named(events, "sign_in_throttled")
    assert throttled["username"] == "admin"
    assert throttled["retry_after_s"] == 900


async def test_a_password_in_the_username_field_is_not_logged(
    client: httpx.AsyncClient, events: Events
) -> None:
    """Typed one field too early, a password must not end up in the log (review #26)."""
    client.cookies.clear()
    for _ in range(11):  # failed, then throttled
        await login(client, ADMIN_PASSWORD, "admin")
    assert {e["event"] for e in events} == {"sign_in_failed", "sign_in_throttled"}
    assert ADMIN_PASSWORD not in json.dumps(events)


async def test_own_password_and_sign_out_are_logged(
    client: httpx.AsyncClient, events: Events
) -> None:
    url = "/api/auth/password"
    await client.post(url, json={"current": "falsch-falsch", "new": "gurten-nebel-abend-2"})
    await client.post(url, json={"current": ADMIN_PASSWORD, "new": "gurten-nebel-abend-2"})
    await client.post("/api/auth/logout")
    assert [e["event"] for e in events] == [
        "password_change_failed",
        "password_changed",
        "sign_out",
    ]
    assert {e["username"] for e in events} == {"admin"}


async def test_the_first_administrator_and_wrong_setup_tokens_are_logged(
    anonymous: httpx.AsyncClient, events: Events
) -> None:
    body = {"username": "chefin", "password": ADMIN_PASSWORD, "load_sample": False}
    await anonymous.post("/api/auth/setup", json={**body, "token": "geraten-geraten"})
    await anonymous.post("/api/auth/setup", json={**body, "token": SETUP_TOKEN})
    assert [e["event"] for e in events] == ["setup_token_rejected", "setup"]
    assert events[1]["username"] == "chefin"
    # Neither the guess nor the token itself goes into the log.
    assert "geraten" not in json.dumps(events) and SETUP_TOKEN not in json.dumps(events)


# --- administration --------------------------------------------------------------


async def test_account_changes_are_logged_with_who_made_them(
    client: httpx.AsyncClient, events: Events
) -> None:
    await client.post("/api/admin/users", json={"username": "m.keller", "role": "user"})
    await client.patch("/api/admin/users/m.keller", json={"role": "admin", "status": "locked"})
    reset = await client.post("/api/admin/users/m.keller/reset-password")
    await client.delete("/api/admin/users/m.keller")

    assert [e["event"] for e in events] == [
        "account_created",
        "account_updated",
        "account_password_reset",
        "account_deleted",
    ]
    assert {(e["username"], e["account"]) for e in events} == {("admin", "m.keller")}
    assert events[0]["role"] == "user"
    assert events[1]["changes"] == {"role": "admin", "status": "locked"}
    # The generated start password is shown to the administrator, never logged.
    assert reset.json()["start_password"] not in json.dumps(events)


async def test_catalog_and_visibility_changes_are_logged(
    client: httpx.AsyncClient, events: Events
) -> None:
    await client.patch("/api/admin/layers/schulen", json={"description": "Volksschulen"})
    await client.patch("/api/admin/layers/schulen/attributes/name", json={"label": "Name"})
    await client.put(
        "/api/admin/visibility", json={"layer": "schulen", "role": "user", "visible": False}
    )
    await client.put("/api/admin/visibility/default", json={"new_layers_visible": True})
    await client.post("/api/admin/layers/schulen/duplicate", json={})
    await client.delete("/api/admin/layers/schulen_kopie")

    assert [e["event"] for e in events] == [
        "layer_updated",
        "attribute_updated",
        "visibility_changed",
        "visibility_default_changed",
        "layer_duplicated",
        "layer_deleted",
    ]
    assert events[0]["fields"] == ["description"]  # which fields, not their texts
    assert events[2] == {
        **events[2],
        "layer": "schulen",
        "role": "user",
        "visible": False,
    }
    assert events[4]["copy"] == "schulen_kopie"
    assert all(e["username"] == "admin" for e in events)


async def test_imports_are_logged(client: httpx.AsyncClient, events: Events) -> None:
    files = {"file": ("orte.csv", b"name;wert\na;1\n", "text/csv")}
    first = (await client.post("/api/admin/imports", files=files)).json()["import_id"]
    await client.delete(f"/api/admin/imports/{first}")
    assert [e["event"] for e in events] == ["import_uploaded", "import_cancelled"]
    assert events[0]["file"] == "orte.csv"
    assert events[0]["import_id"] == events[1]["import_id"] == first


async def test_a_user_at_the_administration_is_logged(
    client: httpx.AsyncClient, events: Events
) -> None:
    await sign_in_as(client, "m.keller")
    events.clear()
    assert (await client.get("/api/admin/users")).status_code == 403
    [forbidden] = events
    assert (forbidden["event"], forbidden["username"]) == ("forbidden", "m.keller")
    assert forbidden["path"] == "/api/admin/users"


# --- guards ----------------------------------------------------------------------


async def test_the_guards_refusals_are_logged(client: httpx.AsyncClient, events: Events) -> None:
    await client.post("/api/auth/logout", headers={"origin": "https://evil.example"})
    await client.post("/api/auth/login", content=b"x" * (3 * 1024 * 1024))
    refused, too_large = events
    assert refused["event"] == "cross_origin_refused"
    assert refused["origin"] == "https://evil.example"
    assert (too_large["event"], too_large["upload"]) == ("request_too_large", False)
    assert too_large["path"] == "/api/auth/login"


# --- format ----------------------------------------------------------------------


def test_each_event_is_one_json_line_whatever_the_input() -> None:
    record = logging.LogRecord(audit.LOGGER, logging.INFO, "", 0, "sign_in_failed", (), None)
    record.audit = {"username": 'admin\n{"event": "sign_in"}', "address": "10.0.0.1"}
    line = audit.JsonLines().format(record)
    assert "\n" not in line
    entry = json.loads(line)
    assert entry["event"] == "sign_in_failed"
    assert entry["username"] == 'admin\n{"event": "sign_in"}'
    assert entry["level"] == "info" and entry["time"].endswith("+00:00")


def test_the_log_has_one_handler_however_often_it_is_configured(app: FastAPI) -> None:
    audit.configure()
    audit.configure()
    json_handlers = [h for h in audit.log.handlers if isinstance(h.formatter, audit.JsonLines)]
    assert len(json_handlers) == 1
    assert audit.log.propagate is False


def test_accounts_made_on_the_command_line_are_logged(
    settings_env: None, events: Events, capsys: pytest.CaptureFixture[str]
) -> None:
    main(["user", "create", "m.keller", "--start-password"])
    main(["user", "reset-password", "m.keller"])
    assert [(e["event"], e["username"], e["account"]) for e in events] == [
        ("account_created", "cli", "m.keller"),
        ("account_password_reset", "cli", "m.keller"),
    ]
    start = capsys.readouterr().out.split("start password: ")[-1].split()[0]
    assert start not in json.dumps(events)
