"""Model connections and secrets (plan E2.1, WP57), over HTTP and below."""

import os
import stat
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, Events, sign_in, sign_in_as
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from geotandem.connections import Connections
from geotandem.db.orm import LLMConnection, User
from geotandem.vault import KEY_FILE, CredentialsUnreadable, Vault

Body = dict[str, Any]
URL = "/api/admin/llm/connections"
LOCAL = {"base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b"}
EXTERNAL = {"base_url": "https://api.openai.com/v1", "model": "gpt-5-mini"}
KEY = "sk-geheim-0123456789"


async def create(client: httpx.AsyncClient, name: str, **fields: Any) -> Body:
    response = await client.post(URL, json={"name": name, **LOCAL, **fields})
    assert response.status_code == 201, response.text
    body: Body = response.json()
    return body


async def patch(client: httpx.AsyncClient, id: int, **fields: Any) -> httpx.Response:
    return await client.patch(f"{URL}/{id}", json=fields)


async def refused(response: httpx.Response, code: str, status: int = 400) -> None:
    assert (response.status_code, response.json()["code"]) == (status, code), response.text


async def connections(client: httpx.AsyncClient) -> dict[str, Body]:
    return {c["name"]: c for c in (await client.get(URL)).json()}


def state(app: FastAPI) -> Connections:
    found: Connections = app.state.geotandem.connections
    return found


# --- the vault (C8) --------------------------------------------------------------


def test_the_key_file_is_made_once_and_private(tmp_path: Path) -> None:
    first = Vault.open(tmp_path)
    token = first.encrypt(KEY)
    assert KEY not in token
    mode = stat.S_IMODE(os.stat(tmp_path / KEY_FILE).st_mode)
    assert mode == 0o600
    assert Vault.open(tmp_path).decrypt(token) == KEY


def test_a_lost_key_file_makes_secrets_unreadable_not_the_start(tmp_path: Path) -> None:
    token = Vault.open(tmp_path).encrypt(KEY)
    (tmp_path / KEY_FILE).unlink()
    with pytest.raises(CredentialsUnreadable):
        Vault.open(tmp_path).decrypt(token)


# --- the key is write-only -------------------------------------------------------


async def test_the_api_key_never_comes_back(
    client: httpx.AsyncClient, app: FastAPI, events: Events, caplog: pytest.LogCaptureFixture
) -> None:
    created = await create(client, "Cloud", **EXTERNAL, api_key=KEY)
    assert created["has_api_key"] is True and not created["credentials_unreadable"]
    listed = await client.get(URL)
    one = await client.get(f"{URL}/{created['id']}")
    patched = await patch(client, created["id"], model="gpt-5", api_key=KEY + "-neu")
    for response in (listed, one, patched):
        assert KEY not in response.text
    assert KEY not in " ".join(str(e) for e in events)
    assert KEY not in caplog.text

    with Session(app.state.geotandem.backend.engine) as session:
        stored = session.scalar(select(LLMConnection.api_key))
    assert stored is not None and KEY not in stored
    endpoint = state(app).endpoint(created["id"])
    assert endpoint.api_key == KEY + "-neu" and KEY not in repr(endpoint)

    removed = await patch(client, created["id"], api_key=None)
    assert removed.json()["has_api_key"] is False


async def test_a_key_from_another_secret_key_is_reported(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    created = await create(client, "Cloud", **EXTERNAL, api_key=KEY)
    foreign = Vault.open(Path(app.state.geotandem.settings.data_dir) / "anders").encrypt(KEY)
    with Session(app.state.geotandem.backend.engine) as session, session.begin():
        session.execute(text("UPDATE llm_connection SET api_key = :k"), {"k": foreign})
    assert (await connections(client))["Cloud"]["credentials_unreadable"] is True
    with pytest.raises(CredentialsUnreadable):
        state(app).endpoint(created["id"])


# --- local or external, data release, effort (C5, C6, C10) -----------------------


async def test_defaults_follow_from_local_or_external(client: httpx.AsyncClient) -> None:
    local = await create(client, "Ollama")
    external = await create(client, "Cloud", **EXTERNAL)
    assert (local["locality"], local["host"]) == ("local", "127.0.0.1")
    assert (local["may_receive_data"], local["reasoning_effort"]) == (True, "none")
    assert (external["locality"], external["host"]) == ("external", "api.openai.com")
    assert (external["may_receive_data"], external["reasoning_effort"]) == (False, "default")


async def test_an_external_host_cannot_be_made_local(client: httpx.AsyncClient) -> None:
    external = await create(client, "Cloud", **EXTERNAL, marked_external=False)
    assert external["locality"] == "external"
    marked = await create(client, "Ollama", marked_external=True)
    assert marked["locality"] == "external" and marked["may_receive_data"] is False
    response = await patch(client, marked["id"], marked_external=False)
    assert response.json()["locality"] == "local"


async def test_data_release_to_an_external_connection_needs_confirmation(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(URL, json={"name": "Cloud", **EXTERNAL, "may_receive_data": True})
    await refused(response, "data_release_unconfirmed")
    cloud = await create(client, "Cloud", **EXTERNAL)
    await refused(
        await patch(client, cloud["id"], may_receive_data=True), "data_release_unconfirmed"
    )
    released = await patch(client, cloud["id"], may_receive_data=True, confirm_data_release=True)
    assert released.json()["may_receive_data"] is True

    # A local connection with data release moved to an external host needs it too.
    local = await create(client, "Ollama")
    moved = await patch(client, local["id"], base_url="https://models.example.com/v1")
    await refused(moved, "data_release_unconfirmed")


async def test_urls_names_and_effort_are_checked(client: httpx.AsyncClient) -> None:
    ftp = await client.post(URL, json={"name": "X", **LOCAL, "base_url": "ftp://x/v1"})
    await refused(ftp, "llm_invalid_url")
    keyed_url = {"name": "X", **LOCAL, "base_url": "http://anna:pw@127.0.0.1/v1"}
    await refused(await client.post(URL, json=keyed_url), "llm_invalid_url")
    await create(client, "Ollama")
    twin = await client.post(URL, json={"name": "ollama ", **LOCAL})
    await refused(twin, "connection_name_taken")
    effort = await client.post(URL, json={"name": "Y", **LOCAL, "reasoning_effort": "maximal"})
    await refused(effort, "schema_violation", 422)


# --- the default (C18) -----------------------------------------------------------


async def test_the_first_enabled_connection_becomes_the_default(
    client: httpx.AsyncClient,
) -> None:
    a = await create(client, "A")
    assert a["is_default"] is False  # not enabled: nothing to default to
    a = (await patch(client, a["id"], enabled=True)).json()
    assert a["is_default"] is True
    b = await create(client, "B", enabled=True)
    assert b["is_default"] is False


async def test_one_default_and_it_is_enabled(client: httpx.AsyncClient) -> None:
    a = await create(client, "A", enabled=True)
    b = await create(client, "B", enabled=True, is_default=True)
    found = await connections(client)
    assert (found["A"]["is_default"], found["B"]["is_default"]) == (False, True)

    c = await create(client, "C")
    await refused(await patch(client, c["id"], is_default=True), "default_not_enabled")
    for change in ({"enabled": False}, {"is_default": False}):
        await refused(await patch(client, b["id"], **change), "default_connection_required")
    await refused(await client.delete(f"{URL}/{b['id']}"), "default_connection_required")

    # Hand the default over, then the old one may go.
    assert (await patch(client, a["id"], is_default=True)).status_code == 200
    assert (await client.delete(f"{URL}/{b['id']}")).status_code == 204
    # The last enabled one may be disabled; then there is no default.
    off = (await patch(client, a["id"], enabled=False)).json()
    assert (off["enabled"], off["is_default"]) == (False, False)


# --- the account's choice (C14, C17) ---------------------------------------------


async def options(client: httpx.AsyncClient) -> Body:
    response = await client.get("/api/llm/options")
    assert response.status_code == 200, response.text
    body: Body = response.json()
    return body


async def choose(client: httpx.AsyncClient, id: int | None) -> httpx.Response:
    return await client.put("/api/llm/options", json={"connection_id": id})


async def test_no_connection_means_no_options(client: httpx.AsyncClient) -> None:
    assert await options(client) == {
        "connections": [],
        "chosen_connection_id": None,
        "active_connection_id": None,
    }


async def test_a_user_chooses_among_enabled_connections(client: httpx.AsyncClient) -> None:
    a = await create(client, "Ollama", enabled=True)
    b = await create(client, "Cloud", **EXTERNAL, enabled=True)
    hidden = await create(client, "Versuch")
    await sign_in_as(client, "m.keller")

    offered = await options(client)
    assert [(c["name"], c["locality"], c["host"]) for c in offered["connections"]] == [
        ("Cloud", "external", "api.openai.com"),
        ("Ollama", "local", "127.0.0.1"),
    ]
    assert "base_url" not in offered["connections"][0]
    assert (offered["chosen_connection_id"], offered["active_connection_id"]) == (None, a["id"])

    chosen = (await choose(client, b["id"])).json()
    assert (chosen["chosen_connection_id"], chosen["active_connection_id"]) == (b["id"], b["id"])
    await refused(await choose(client, hidden["id"]), "connection_not_available")
    await refused(await choose(client, 999), "connection_not_available")


async def test_administrators_cannot_choose_a_disabled_connection(
    client: httpx.AsyncClient,
) -> None:
    hidden = await create(client, "Versuch")
    await refused(await choose(client, hidden["id"]), "connection_not_available")


async def test_a_disabled_choice_falls_back_and_returns(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    a = await create(client, "A", enabled=True)
    b = await create(client, "B", enabled=True)
    await sign_in_as(client, "m.keller")
    await choose(client, b["id"])
    await sign_in(client, "admin", ADMIN_PASSWORD)

    await patch(client, b["id"], enabled=False)
    await sign_in(client, "m.keller", "nutzer-passwort-1")
    now = await options(client)
    assert (now["chosen_connection_id"], now["active_connection_id"]) == (b["id"], a["id"])

    await sign_in(client, "admin", ADMIN_PASSWORD)
    await patch(client, b["id"], enabled=True)
    await sign_in(client, "m.keller", "nutzer-passwort-1")
    assert (await options(client))["active_connection_id"] == b["id"]

    await sign_in(client, "admin", ADMIN_PASSWORD)
    assert (await client.delete(f"{URL}/{b['id']}")).status_code == 204
    with Session(app.state.geotandem.backend.engine) as session:
        chosen = session.scalar(select(User.llm_connection_id).where(User.username == "m.keller"))
    assert chosen is None


# --- audit and access (C16) ------------------------------------------------------


async def test_every_change_is_audited_by_field_names(
    client: httpx.AsyncClient, events: Events
) -> None:
    created = await create(client, "Ollama", api_key=KEY)
    await patch(client, created["id"], model="gemma3:4b", temperature=0.0)
    await client.delete(f"{URL}/{created['id']}")
    logged = [e for e in events if e["event"] == "llm_connection_changed"]
    assert [(e["action"], e.get("fields")) for e in logged] == [
        ("created", ["api_key", "base_url", "model", "name"]),
        ("updated", ["model"]),
        ("deleted", None),
    ]
    assert all(e["username"] == "admin" and e["id"] == created["id"] for e in logged)


async def test_only_administrators_manage_connections(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    assert (await client.get(URL)).status_code == 403
    assert (await client.post(URL, json={"name": "X", **LOCAL})).status_code == 403
