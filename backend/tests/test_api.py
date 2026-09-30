"""HTTP interface in-process via httpx's ASGI transport (tech-stack 5.1)."""

import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from geotandem.app import create_app
from geotandem.config import Settings

GOLDEN = Path(__file__).parent / "golden"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    frontend = tmp_path / "dist"
    frontend.mkdir()
    (frontend / "index.html").write_text("<!doctype html><title>GeoTandem</title>")
    settings = Settings(
        data_dir=tmp_path / "data", load_sample_data=True, max_features=100, frontend_dir=frontend
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


async def test_health(client: httpx.AsyncClient) -> None:
    body = (await client.get("/api/health")).json()
    assert body["status"] == "ok"
    assert body["backend"] == "spatialite"
    assert body["schema_version"] == "0"
    assert body["sample_dataset_version"] == "tandemtal-1"
    assert body["capabilities"]["missing"] == {}


async def test_layers(client: httpx.AsyncClient) -> None:
    layers = (await client.get("/api/layers")).json()
    assert [layer["name"] for layer in layers][:2] == ["bevoelkerung", "gemeinden"]
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
        ({"source": "schulen"}, 413, "result_too_large"),  # 120 > max_features=100
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
    assert schema["$id"].endswith("/query-object/v0.json")
    tools = (await client.get("/api/tools")).json()
    assert [t["name"] for t in tools] == ["list_layers", "describe_layer", "run_query"]


async def test_frontend_served_with_client_routing(client: httpx.AsyncClient) -> None:
    for path in ("/", "/admin", "/sessions/abc"):
        response = await client.get(path)
        assert response.status_code == 200
        assert "<title>GeoTandem</title>" in response.text
    assert (await client.get("/api/unknown")).status_code == 404
