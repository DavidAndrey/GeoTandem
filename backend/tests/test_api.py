"""HTTP interface in-process via httpx's ASGI transport (tech-stack 5.1)."""

import json
from pathlib import Path

import httpx
import pytest

from geotandem.api import routes
from geotandem.app import openapi_document
from geotandem.data import Limits
from geotandem.sample.load import dataset_version

GOLDEN = Path(__file__).parent / "golden"


async def test_health(client: httpx.AsyncClient) -> None:
    body = (await client.get("/api/health")).json()
    assert body["status"] == "ok"
    assert body["backend"] == "spatialite"
    assert body["schema_version"] == "2"
    assert body["sample_dataset_version"] == dataset_version()
    assert body["capabilities"]["missing"] == {}


async def test_layers(client: httpx.AsyncClient) -> None:
    layers = (await client.get("/api/layers")).json()
    assert [layer["name"] for layer in layers][:2] == ["gemeindedaten", "gemeinden"]
    schulen = (await client.get("/api/layers/schulen")).json()
    assert schulen["geometry_type"] == "Point"
    missing = await client.get("/api/layers/nope")
    assert missing.status_code == 404
    assert missing.json()["code"] == "unknown_layer"


async def test_query_is_reproducible(client: httpx.AsyncClient) -> None:
    query = json.loads((GOLDEN / "schools_near_river.query.json").read_text("utf-8"))
    expected = json.loads((GOLDEN / "schools_near_river.expected.json").read_text("utf-8"))
    first = (await client.post("/api/query", json=query)).json()
    second = (await client.post("/api/query", json=query)).json()
    assert first["type"] == "FeatureCollection"
    assert first["meta"]["query_hash"] == second["meta"]["query_hash"] == expected["query_hash"]
    assert [f["id"] for f in first["features"]] == [f["id"] for f in expected["features"]]
    assert first["features"] == second["features"]
    assert first["features"][0]["geometry"]["type"] == "Point"


async def test_validate(client: httpx.AsyncClient) -> None:
    query = json.loads((GOLDEN / "schools_per_municipality.query.json").read_text("utf-8"))
    body = (await client.post("/api/query/validate", json=query)).json()
    assert body == {
        "valid": True,
        "layers": ["schulen", "gemeinden"],
        "operations": ["aggregate", "attribute_filter"],
    }


@pytest.mark.parametrize(
    ("query", "status", "code"),
    [
        ({"source": "schulen", "sql": "DROP TABLE layer"}, 422, "schema_violation"),
        ({"source": "spitaeler"}, 400, "unknown_layer"),
        ({"source": "schulen"}, 413, "result_too_large"),  # 137 > max_features=100
    ],
)
async def test_rejections_share_one_body(
    client: httpx.AsyncClient, query: dict[str, object], status: int, code: str
) -> None:
    response = await client.post("/api/query", json=query)
    assert response.status_code == status
    body = response.json()
    assert body["code"] == code
    assert body["message"]
    assert "details" in body


async def test_schema_and_tools(client: httpx.AsyncClient) -> None:
    schema = (await client.get("/api/schema/query-object")).json()
    assert schema["$id"].endswith("/query-object/v2.json")
    tools = (await client.get("/api/tools")).json()
    assert [t["name"] for t in tools] == ["list_layers", "describe_layer", "run_query"]


async def test_frontend_served_with_client_routing(client: httpx.AsyncClient) -> None:
    for path in ("/", "/admin", "/sessions/abc"):
        response = await client.get(path)
        assert response.status_code == 200
        assert "<title>GeoTandem</title>" in response.text
    assert (await client.get("/api/unknown")).status_code == 404


def test_committed_openapi_matches_app() -> None:
    """Frontend types are generated from this file; it must not drift.

    Regenerate with ``make gen``.
    """
    committed = Path(__file__).parents[2] / "frontend" / "openapi.json"
    assert committed.read_text(encoding="utf-8") == openapi_document()


async def test_count_several_queries(client: httpx.AsyncClient) -> None:
    schools = {"source": "schulen"}
    primar = {"source": "schulen", "where": {"op": "in", "attr": "typ", "values": ["primar"]}}
    response = await client.post("/api/query/count", json={"queries": [schools, primar]})
    counts = response.json()["counts"]
    # 137 schools exceed max_features=100 for /api/query, but counting ships no features.
    assert counts[0] == 137 and 0 < counts[1] < 137


async def test_count_names_the_rejected_query(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/query/count", json={"queries": [{"source": "schulen"}, {"source": "spitaeler"}]}
    )
    assert (response.status_code, response.json()["code"]) == (400, "unknown_layer")
    assert response.json()["details"]["index"] == 1


async def test_counts_share_one_time_limit(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each count gets what is left of the request's limit; none starts after it."""
    clock = [0.0]
    given: list[float] = []

    def slow_count(_query: object, _backend: object, limits: Limits, _ops: object) -> int:
        given.append(limits.timeout_s)
        clock[0] += 4  # each count takes 4 s of the 10 s limit
        return 1

    monkeypatch.setattr(routes.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(routes, "count_query", slow_count)
    response = await client.post("/api/query/count", json={"queries": [{"source": "schulen"}] * 5})
    assert (response.status_code, response.json()["code"]) == (504, "query_timeout")
    assert response.json()["details"] == {"timeout_s": 10, "index": 3}
    assert given == [10, 6, 2]


async def test_ids_mark_hits_beyond_the_result_limit(client: httpx.AsyncClient) -> None:
    schools = {"source": "schulen"}
    # 137 schools exceed max_features=100: /api/query refuses, the ids still come.
    assert (await client.post("/api/query", json=schools)).status_code == 413
    ids = (await client.post("/api/query/ids", json=schools)).json()["ids"]
    assert len(ids) == 137 and ids == sorted(ids)
    primar = {**schools, "where": {"op": "in", "attr": "typ", "values": ["primar"]}}
    limited = {**primar, "limit": 5}
    features = (await client.post("/api/query", json=limited)).json()["features"]
    picked = (await client.post("/api/query/ids", json=limited)).json()["ids"]
    assert picked == sorted(f["id"] for f in features)


async def test_count_request_size_is_limited(client: httpx.AsyncClient) -> None:
    too_many = {"queries": [{"source": "schulen"}] * 51}
    assert (await client.post("/api/query/count", json=too_many)).status_code == 422
