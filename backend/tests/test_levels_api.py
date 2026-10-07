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
