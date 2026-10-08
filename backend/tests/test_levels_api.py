"""Levels of model support in the administration (plan E2.0, WP55), over HTTP."""

from typing import Any

import httpx
from api_helpers import ADMIN_PASSWORD, Events, sign_in, sign_in_as
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from geotandem.db.orm import User

Body = dict[str, Any]


async def levels(client: httpx.AsyncClient) -> list[Body]:
    response = await client.get("/api/admin/levels")
    assert response.status_code == 200, response.text
    found: list[Body] = response.json()["levels"]
    return found


async def put(client: httpx.AsyncClient, body: list[Body]) -> httpx.Response:
    return await client.put("/api/admin/levels", json={"levels": body})


async def test_the_shipped_levels_are_listed(client: httpx.AsyncClient) -> None:
    found = await levels(client)
    assert [(lv["name"], lv["selectable"], lv["is_default"]) for lv in found] == [
        ("Assistenz", True, False),
        ("Prüfen", True, True),
        ("Automatisch", False, False),
    ]
    assert found[1]["matrix"] == dict.fromkeys(
        ["catalog", "query", "spatial", "derive", "display"], "approve"
    )


async def test_the_set_is_saved_as_a_whole(client: httpx.AsyncClient, events: Events) -> None:
    assistenz, pruefen, automatisch = await levels(client)
    pruefen = {
        **pruefen,
        "name": "Prüfen mit Karte",
        "matrix": {**pruefen["matrix"], "display": "auto"},
    }
    new = {
        "name": "Nur Katalog",
        "description": "Das Modell sieht die Layerliste.",
        "selectable": True,
        "matrix": {**assistenz["matrix"], "catalog": "auto"},
    }
    # Reordered, one renamed, one new, Automatisch deleted.
    response = await put(client, [pruefen, assistenz, new])
    assert response.status_code == 200, response.text

    found = await levels(client)
    assert [lv["name"] for lv in found] == ["Prüfen mit Karte", "Assistenz", "Nur Katalog"]
    assert found[0]["id"] == pruefen["id"] and found[0]["matrix"]["display"] == "auto"
    assert found[2]["id"] not in (assistenz["id"], pruefen["id"], automatisch["id"])
    assert found[2]["matrix"]["catalog"] == "auto"

    [event] = [e for e in events if e["event"] == "levels_changed"]
    assert event["username"] == "admin"
    assert event["created"] == [found[2]["id"]]
    assert event["deleted"] == [automatisch["id"]]


async def test_refusals_carry_their_code_and_change_nothing(client: httpx.AsyncClient) -> None:
    shipped = await levels(client)
    assistenz, pruefen, _ = shipped

    cases: list[tuple[list[Body], str]] = [
        ([], "level_count"),
        (
            [
                *shipped,
                {**assistenz, "id": None, "name": "B"},
                {**assistenz, "id": None, "name": "C"},
            ],
            "level_count",
        ),
        ([assistenz], "default_level_count"),
        ([assistenz, {**pruefen, "selectable": False}], "default_not_selectable"),
        ([pruefen, {**assistenz, "name": " prüfen"}], "level_name_taken"),
        ([{**assistenz, "is_default": True}], "default_level_deleted"),
    ]
    for body, code in cases:
        response = await put(client, body)
        assert (response.status_code, response.json()["code"]) == (400, code), body

    response = await put(client, [pruefen, {**assistenz, "id": 999}])
    assert (response.status_code, response.json()["code"]) == (404, "not_found")

    incomplete = {**pruefen, "matrix": {"catalog": "auto"}}
    response = await put(client, [incomplete])
    assert (response.status_code, response.json()["code"]) == (422, "schema_violation")

    assert await levels(client) == shipped


async def test_the_default_goes_only_after_another_took_over(client: httpx.AsyncClient) -> None:
    assistenz, pruefen, automatisch = await levels(client)
    moved = [{**assistenz, "is_default": True}, {**pruefen, "is_default": False}, automatisch]
    assert (await put(client, moved)).status_code == 200
    response = await put(client, [{**assistenz, "is_default": True}, automatisch])
    assert response.status_code == 200
    assert [lv["name"] for lv in await levels(client)] == ["Assistenz", "Automatisch"]


async def test_a_deleted_level_lets_its_accounts_fall_back(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    assistenz, pruefen, automatisch = await levels(client)
    engine = app.state.geotandem.backend.engine
    await sign_in_as(client, "m.keller")
    with Session(engine) as session, session.begin():
        session.execute(
            update(User).where(User.username == "m.keller").values(level_id=assistenz["id"])
        )
    await sign_in(client, "admin", ADMIN_PASSWORD)

    assert (await put(client, [pruefen, automatisch])).status_code == 200
    with Session(engine) as session:
        assert session.scalar(select(User.level_id).where(User.username == "m.keller")) is None


async def test_only_administrators_see_or_change_levels(client: httpx.AsyncClient) -> None:
    shipped = await levels(client)
    await sign_in_as(client, "m.keller")
    assert (await client.get("/api/admin/levels")).status_code == 403
    assert (await put(client, shipped)).status_code == 403


# --- the account's choice (H6, H7, C14) ------------------------------------------


async def options(client: httpx.AsyncClient) -> Body:
    response = await client.get("/api/llm/options")
    assert response.status_code == 200, response.text
    body: Body = response.json()
    return body


async def test_users_choose_among_selectable_levels(client: httpx.AsyncClient) -> None:
    assistenz, pruefen, automatisch = await levels(client)
    await sign_in_as(client, "m.keller")

    offered = await options(client)
    assert [lv["name"] for lv in offered["levels"]] == ["Assistenz", "Prüfen"]
    assert (offered["chosen_level_id"], offered["active_level_id"]) == (None, pruefen["id"])

    chosen = await client.put("/api/llm/options", json={"level_id": assistenz["id"]})
    assert chosen.json()["active_level_id"] == assistenz["id"]
    # A connection field not sent stays as it was.
    assert chosen.json()["chosen_connection_id"] is None

    refused = await client.put("/api/llm/options", json={"level_id": automatisch["id"]})
    assert (refused.status_code, refused.json()["code"]) == (400, "level_not_available")
    refused = await client.put("/api/llm/options", json={"level_id": 999})
    assert refused.json()["code"] == "level_not_available"
    assert (await options(client))["active_level_id"] == assistenz["id"]

    back = await client.put("/api/llm/options", json={"level_id": None})
    assert back.json()["active_level_id"] == pruefen["id"]


async def test_administrators_may_use_every_level(client: httpx.AsyncClient) -> None:
    *_, automatisch = await levels(client)
    offered = await options(client)
    assert [lv["selectable"] for lv in offered["levels"]] == [True, True, False]
    chosen = await client.put("/api/llm/options", json={"level_id": automatisch["id"]})
    assert chosen.json()["active_level_id"] == automatisch["id"]


async def test_a_level_closed_later_falls_back_to_the_default(
    client: httpx.AsyncClient,
) -> None:
    assistenz, pruefen, automatisch = await levels(client)
    await sign_in_as(client, "m.keller")
    await client.put("/api/llm/options", json={"level_id": assistenz["id"]})
    await sign_in(client, "admin", ADMIN_PASSWORD)
    closed = {**assistenz, "selectable": False}
    assert (await put(client, [closed, pruefen, automatisch])).status_code == 200

    await sign_in(client, "m.keller", "nutzer-passwort-1")
    now = await options(client)
    assert (now["chosen_level_id"], now["active_level_id"]) == (assistenz["id"], pruefen["id"])
    assert [lv["name"] for lv in now["levels"]] == ["Prüfen"]
