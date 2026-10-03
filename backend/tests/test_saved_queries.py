"""Saved and shared queries (plan E1.7b, design C6), against the HTTP API."""

from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, sign_in, sign_in_as

PRIMARY = {"op": "in", "attr": "typ", "values": ["primar"]}
NEAR_RIVER = {"op": "related", "layer": "gewaesser", "predicate": "dwithin", "distance_m": 500}
QUERY: dict[str, Any] = {
    "schema_version": "2",
    "source": "schulen",
    "where": {"op": "and", "args": [PRIMARY, NEAR_RIVER]},
}
STATE = {"result": "schulen", "tree": {"kind": "group", "children": []}, "restriction": None}


def body(name: str = "Primarschulen am Wasser", **patch: Any) -> dict[str, Any]:
    return {"name": name, "state_version": 1, "state": STATE, "query": QUERY, **patch}


async def save_new(client: httpx.AsyncClient, **patch: Any) -> dict[str, Any]:
    response = await client.post("/api/queries", json=body(**patch))
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


async def test_save_list_and_open(client: httpx.AsyncClient) -> None:
    created = await save_new(client)
    assert created["conditions"] == {"attribute": 1, "spatial": 1, "restriction": False}
    assert created["mine"] is True
    assert created["shared"] is False
    assert created["result_layer"] == "schulen"
    listed = (await client.get("/api/queries")).json()
    assert [q["name"] for q in listed] == ["Primarschulen am Wasser"]
    opened = (await client.get(f"/api/queries/{created['id']}")).json()
    assert opened["state"] == STATE
    assert opened["query"]["where"]["args"][0] == PRIMARY


async def test_restriction_is_not_a_condition_count(client: httpx.AsyncClient) -> None:
    where = {"op": "and", "args": [PRIMARY, {"op": "bbox", "bbox": [7.3, 46.9, 7.5, 47]}]}
    created = await save_new(client, query={**QUERY, "where": where})
    assert created["conditions"] == {"attribute": 1, "spatial": 0, "restriction": True}


@pytest.mark.parametrize(
    ("patch", "status", "code"),
    [
        ({"query": {**QUERY, "buffer": {"distance_m": 100}}}, 400, "conditions_only"),
        (
            {
                "query": {
                    **QUERY,
                    "aggregate": {"by_layer": "gemeinden", "metrics": [{"fn": "count", "as": "n"}]},
                }
            },
            400,
            "conditions_only",
        ),
        ({"query": {"source": "spitaeler"}}, 400, "unknown_layer"),
        ({"name": ""}, 422, "schema_violation"),
        ({"state": {"x": "y" * 200_001}}, 413, "state_too_large"),
    ],
)
async def test_invalid_queries_are_rejected(
    client: httpx.AsyncClient, patch: dict[str, Any], status: int, code: str
) -> None:
    response = await client.post("/api/queries", json=body(**patch))
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


async def test_names_are_unique_per_owner(client: httpx.AsyncClient) -> None:
    first = await save_new(client)
    clash = await client.post("/api/queries", json=body())
    assert clash.status_code == 409
    assert clash.json()["details"]["existing"] == first["id"]


async def test_private_queries_stay_private(client: httpx.AsyncClient) -> None:
    own = await save_new(client)
    await sign_in_as(client, "m.keller")
    assert (await client.get("/api/queries")).json() == []
    assert (await client.get(f"/api/queries/{own['id']}")).status_code == 404
    assert (await client.post(f"/api/queries/{own['id']}/duplicate")).status_code == 404


async def test_shared_queries_are_readable_and_copied_not_changed(
    client: httpx.AsyncClient,
) -> None:
    """Design C6: "Geteilt = für alle lesbar, Ändern erzeugt Kopie"."""
    own = await save_new(client)
    shared = await client.patch(f"/api/queries/{own['id']}", json={"shared": True})
    assert shared.json()["shared"] is True

    await sign_in_as(client, "m.keller")
    listed = (await client.get("/api/queries")).json()
    assert [(q["name"], q["mine"], q["owner"]) for q in listed] == [
        ("Primarschulen am Wasser", False, "admin")
    ]
    assert (await client.get(f"/api/queries/{own['id']}")).status_code == 200
    for method, payload in [("PUT", body()), ("PATCH", {"name": "x"}), ("DELETE", None)]:
        response = await client.request(method, f"/api/queries/{own['id']}", json=payload)
        assert response.status_code == 403, method
        assert response.json()["code"] == "not_owner"

    copy = await client.post(f"/api/queries/{own['id']}/duplicate")
    assert copy.status_code == 201
    assert (copy.json()["mine"], copy.json()["shared"]) == (True, False)
    assert copy.json()["name"] == "Primarschulen am Wasser"  # free for this owner
    again = await client.post(f"/api/queries/{own['id']}/duplicate")
    assert again.json()["name"] == "Primarschulen am Wasser (Kopie)"
    changed = await client.put(
        f"/api/queries/{copy.json()['id']}", json=body(query={**QUERY, "limit": 1})
    )
    assert changed.status_code == 200
    # The original is untouched.
    await sign_in(client, "admin", ADMIN_PASSWORD)
    original = (await client.get(f"/api/queries/{own['id']}")).json()
    assert "limit" not in original["query"] or original["query"]["limit"] is None


async def test_a_shared_query_on_a_hidden_layer_is_not_shown(client: httpx.AsyncClient) -> None:
    """Q4: listing it would leak the name of a layer the account must not see."""
    own = await save_new(client, shared=True)
    hidden = await client.put(
        "/api/admin/visibility", json={"layer": "gewaesser", "role": "user", "visible": False}
    )
    assert hidden.status_code == 200
    await sign_in_as(client, "m.keller")
    assert (await client.get("/api/queries")).json() == []
    assert (await client.get(f"/api/queries/{own['id']}")).status_code == 404


async def test_usage_counts_sessions_of_every_account(client: httpx.AsyncClient) -> None:
    own = await save_new(client, shared=True)
    state = {"layers": [], "tree": {"kind": "group"}, "table": {}, "query": {"id": own["id"]}}
    session = {"name": "Mit Abfrage", "state_version": 1, "state": state, "query": QUERY}
    assert (await client.post("/api/sessions", json=session)).status_code == 201
    await sign_in_as(client, "m.keller")
    assert (await client.post("/api/sessions", json=session)).status_code == 201
    assert (await client.get(f"/api/queries/{own['id']}/usage")).json() == {"sessions": 2}

    await sign_in(client, "admin", ADMIN_PASSWORD)
    assert (await client.delete(f"/api/queries/{own['id']}")).status_code == 204
    # The sessions keep their own conditions and still open.
    sessions = (await client.get("/api/sessions")).json()
    check = (await client.post(f"/api/sessions/{sessions[0]['id']}/check")).json()
    assert check["identical"] is True
    await sign_in(client, "m.keller", USER_PASSWORD)
    assert (await client.get("/api/queries")).json() == []
