"""Analysis sessions (F-4.10, F-8.9; plan E1.7): saved, private, and checked on open.

Tested against the HTTP API, as a client that ignores the interface would see it.
"""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, sign_in, sign_in_as
from sqlalchemy import text

from geotandem.data import DataBackend

GOLDEN = Path(__file__).parent / "golden"
QUERY: dict[str, Any] = json.loads((GOLDEN / "schools_near_river.query.json").read_text("utf-8"))
STATE = {"layers": [{"id": "schulen"}], "result": "schulen", "tree": {"children": []}}


def body(name: str = "Schulen an der Aare", **patch: Any) -> dict[str, Any]:
    return {"name": name, "state_version": 1, "state": STATE, "query": QUERY, **patch}


async def save_new(client: httpx.AsyncClient, **patch: Any) -> dict[str, Any]:
    response = await client.post("/api/sessions", json=body(**patch))
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


async def test_save_list_open_and_check(client: httpx.AsyncClient) -> None:
    created = await save_new(client, note="Für die Vorführung")
    stamp = created["stamp"]
    result = (await client.post("/api/query", json=QUERY)).json()
    assert stamp["count"] == len(result["features"]) > 0
    assert stamp["query_hash"] == result["meta"]["query_hash"]
    assert stamp["data_versions"] == result["meta"]["data_versions"]

    listed = (await client.get("/api/sessions")).json()
    assert [(s["name"], s["result_layer"], s["data_changed"]) for s in listed] == [
        ("Schulen an der Aare", "schulen", False)
    ]
    opened = (await client.get(f"/api/sessions/{created['id']}")).json()
    assert opened["state"] == STATE
    assert opened["note"] == "Für die Vorführung"

    check = (await client.post(f"/api/sessions/{created['id']}/check")).json()
    assert check["identical"] is True
    assert check["current"]["ids_hash"] == stamp["ids_hash"]
    assert check["changed_layers"] == check["missing_layers"] == []
    assert (await client.get("/api/sessions/last")).json()["id"] == created["id"]


async def test_a_session_without_result_layer_has_no_stamp(client: httpx.AsyncClient) -> None:
    created = await save_new(client, query=None)
    assert created["stamp"] is None
    check = (await client.post(f"/api/sessions/{created['id']}/check")).json()
    assert check["identical"] is True


async def test_save_overwrites_and_restamps(client: httpx.AsyncClient) -> None:
    created = await save_new(client)
    narrower = {**QUERY, "limit": 1}
    saved = await client.put(f"/api/sessions/{created['id']}", json=body(query=narrower))
    assert saved.status_code == 200, saved.text
    assert saved.json()["stamp"]["count"] == 1
    assert saved.json()["query"]["limit"] == 1


async def test_names_are_unique_per_owner(client: httpx.AsyncClient) -> None:
    first = await save_new(client)
    clash = await client.post("/api/sessions", json=body())
    assert clash.status_code == 409
    assert clash.json()["code"] == "name_taken"
    assert clash.json()["details"]["existing"] == first["id"]
    other = await save_new(client, name="Zweite")
    renamed = await client.patch(f"/api/sessions/{other['id']}", json={"name": first["name"]})
    assert renamed.status_code == 409
    copy = await client.post(f"/api/sessions/{first['id']}/duplicate")
    assert copy.status_code == 201
    assert copy.json()["name"] == "Schulen an der Aare (Kopie)"
    again = await client.post(f"/api/sessions/{first['id']}/duplicate")
    assert again.json()["name"] == "Schulen an der Aare (Kopie 2)"


@pytest.mark.parametrize(
    ("patch", "status", "code"),
    [
        ({"name": "  "}, 422, "schema_violation"),
        ({"name": "x" * 121}, 422, "schema_violation"),
        ({"state_version": 0}, 422, "schema_violation"),
        ({"query": {"source": "Schulen"}}, 422, "schema_violation"),
        ({"query": {"source": "spitaeler"}}, 400, "unknown_layer"),
        ({"state": {"polygon": "x" * 1_000_001}}, 413, "state_too_large"),
    ],
)
async def test_invalid_sessions_are_rejected(
    client: httpx.AsyncClient, patch: dict[str, Any], status: int, code: str
) -> None:
    response = await client.post("/api/sessions", json=body(**patch))
    assert response.status_code == status, response.text
    assert response.json()["code"] == code
    assert (await client.get("/api/sessions")).json() == []


async def test_sessions_are_private(client: httpx.AsyncClient) -> None:
    """Even an administrator does not see another account's session (design decision 2)."""
    await sign_in_as(client, "m.keller")
    own = await save_new(client)
    await sign_in(client, "admin", ADMIN_PASSWORD)
    assert (await client.get("/api/sessions")).json() == []
    for method, path in [
        ("GET", f"/api/sessions/{own['id']}"),
        ("PUT", f"/api/sessions/{own['id']}"),
        ("PATCH", f"/api/sessions/{own['id']}"),
        ("DELETE", f"/api/sessions/{own['id']}"),
        ("POST", f"/api/sessions/{own['id']}/check"),
        ("POST", f"/api/sessions/{own['id']}/duplicate"),
    ]:
        payload = body() if method == "PUT" else {} if method == "PATCH" else None
        response = await client.request(method, path, json=payload)
        assert response.status_code == 404, (method, path)
    # The same name is free for another owner.
    await save_new(client)


async def test_signed_out_clients_cannot_reach_sessions(client: httpx.AsyncClient) -> None:
    await save_new(client)
    await client.post("/api/auth/logout")
    assert (await client.get("/api/sessions")).status_code == 401


async def test_deleting_an_account_deletes_its_sessions(
    client: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    await sign_in_as(client, "m.keller")
    await save_new(client)
    await sign_in(client, "admin", ADMIN_PASSWORD)
    assert (await client.delete("/api/admin/users/m.keller")).status_code == 204
    with backend_of_client.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM analysis_session")).scalar() == 0


async def test_check_names_a_changed_layer(
    client: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    created = await save_new(client)
    hit = (await client.post("/api/query", json=QUERY)).json()["features"][0]["id"]
    with backend_of_client.engine.begin() as conn:
        conn.execute(text("DELETE FROM lyr_schulen WHERE fid = :fid"), {"fid": hit})
        conn.execute(text("UPDATE layer SET dataset_version = 'neu' WHERE name = 'schulen'"))
    check = (await client.post(f"/api/sessions/{created['id']}/check")).json()
    assert check["identical"] is False
    assert check["changed_layers"] == ["schulen"]
    assert check["current"]["count"] == check["saved"]["count"] - 1
    listed = (await client.get("/api/sessions")).json()
    assert listed[0]["data_changed"] is True


async def test_a_new_version_with_the_same_features_is_still_identical(
    client: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    created = await save_new(client)
    with backend_of_client.engine.begin() as conn:
        conn.execute(text("UPDATE layer SET dataset_version = 'neu' WHERE name = 'gewaesser'"))
    check = (await client.post(f"/api/sessions/{created['id']}/check")).json()
    assert check["identical"] is True
    assert check["changed_layers"] == ["gewaesser"]


async def test_a_hidden_layer_is_missing(client: httpx.AsyncClient) -> None:
    """Visibility holds when reopening (F-2.7, design C8)."""
    await sign_in_as(client, "m.keller")
    created = await save_new(client)
    await sign_in(client, "admin", ADMIN_PASSWORD)
    hidden = await client.put(
        "/api/admin/visibility", json={"layer": "gewaesser", "role": "user", "visible": False}
    )
    assert hidden.status_code == 200
    await sign_in(client, "m.keller", USER_PASSWORD)
    check = (await client.post(f"/api/sessions/{created['id']}/check")).json()
    assert check["identical"] is False
    assert check["missing_layers"] == ["gewaesser"]
    assert check["current"] is None


async def test_check_tells_whether_the_state_still_rebuilds_the_saved_query(
    client: httpx.AsyncClient,
) -> None:
    created = await save_new(client)
    path = f"/api/sessions/{created['id']}/check"
    same = await client.post(path, json={"rebuilt": QUERY, "has_result": True})
    assert same.json()["state_matches"] is True
    # Key order and omitted defaults do not matter: the canonical form decides.
    reordered = {**dict(reversed(list(QUERY.items()))), "output": "map"}
    assert (await client.post(path, json={"rebuilt": reordered, "has_result": True})).json()[
        "state_matches"
    ] is True
    other = {**QUERY, "limit": 3}
    assert (await client.post(path, json={"rebuilt": other, "has_result": True})).json()[
        "state_matches"
    ] is False
    assert (await client.post(path, json={"has_result": False})).json()["state_matches"] is False
    assert (await client.post(path)).json()["state_matches"] is None
