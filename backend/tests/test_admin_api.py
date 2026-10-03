"""Administration interface for import and layer management (E1.3), over HTTP."""

from pathlib import Path
from typing import Any

import httpx
import pytest
from import_files import LV95, make_files

from geotandem.app import create_app
from geotandem.config import Settings


@pytest.fixture(scope="module")
def files(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return make_files(tmp_path_factory.mktemp("import"))


async def upload(client: httpx.AsyncClient, path: Path) -> httpx.Response:
    return await client.post("/api/admin/imports", files={"file": (path.name, path.read_bytes())})


async def staged(client: httpx.AsyncClient, path: Path) -> dict[str, Any]:
    response = await upload(client, path)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# --- wizard -------------------------------------------------------------------


async def test_upload_preview_commit(client: httpx.AsyncClient, files: dict[str, Path]) -> None:
    body = await staged(client, files["messstellen.csv"])
    preview = body["preview"]
    assert preview["record_count"] == 21
    assert preview["xy"] == {"x": "E", "y": "N", "crs": LV95}

    run = (
        await client.post(
            f"/api/admin/imports/{body['import_id']}/commit",
            json={"geo": {"mode": "xy", "x": "E", "y": "N", "crs": LV95}, "title": "Messstellen"},
        )
    ).json()
    assert (run["status"], run["imported_count"], run["layer_name"]) == (
        "warning",
        20,
        "messstellen",
    )
    layer = (await client.get("/api/layers/messstellen")).json()
    assert (layer["title"], layer["feature_count"]) == ("Messstellen", 20)
    # The staged file is gone after a successful import.
    again = await client.post(f"/api/admin/imports/{body['import_id']}/commit", json={})
    assert (again.status_code, again.json()["code"]) == (404, "not_found")


async def test_key_proposal_uses_existing_layers(
    client: httpx.AsyncClient, files: dict[str, Path]
) -> None:
    preview = (await staged(client, files["kennzahlen.xlsx"]))["preview"]
    proposals = [(k["column"], k["layer"], k["attribute"]) for k in preview["keys"]]
    assert ("Gem-Nr", "gemeinden", "gem_nr") in proposals


async def test_failed_commit_keeps_the_file_for_a_retry(
    client: httpx.AsyncClient, files: dict[str, Path]
) -> None:
    import_id = (await staged(client, files["gemeinden_ohne_prj.zip"]))["import_id"]
    commit = f"/api/admin/imports/{import_id}/commit"
    failed = (await client.post(commit, json={})).json()
    assert (failed["status"], failed["errors"][0]["code"]) == ("failed", "crs_unknown")
    retried = (await client.post(commit, json={"geo": {"mode": "geometry", "crs": LV95}})).json()
    assert retried["status"] == "ok"


async def test_repreview_with_other_options(
    client: httpx.AsyncClient, files: dict[str, Path]
) -> None:
    import_id = (await staged(client, files["netz.gpkg"]))["import_id"]
    preview = (
        await client.post(f"/api/admin/imports/{import_id}/preview", json={"sublayer": "gewaesser"})
    ).json()
    assert (preview["options"]["sublayer"], preview["record_count"]) == ("gewaesser", 2)
    wrong = await client.post(f"/api/admin/imports/{import_id}/preview", json={"sublayer": "bahn"})
    assert wrong.status_code == 400
    assert wrong.json()["details"]["reason"] == "unknown_sublayer"


async def test_cancel_is_logged(client: httpx.AsyncClient, files: dict[str, Path]) -> None:
    import_id = (await staged(client, files["schulen.geojson"]))["import_id"]
    run = (await client.delete(f"/api/admin/imports/{import_id}")).json()
    assert (run["status"], run["source_name"]) == ("aborted", "schulen.geojson")
    log = (await client.get("/api/admin/import-log", params={"status": "aborted"})).json()
    assert [r["id"] for r in log] == [run["id"]]


async def test_unreadable_upload(client: httpx.AsyncClient, tmp_path: Path) -> None:
    broken = tmp_path / "kaputt.gpkg"
    broken.write_bytes(b"nope")
    response = await upload(client, broken)
    assert response.status_code == 400
    assert (response.json()["code"], response.json()["details"]["reason"]) == (
        "unreadable_source",
        "unreadable",
    )
    unsupported = tmp_path / "plan.dxf"
    unsupported.write_bytes(b"0")
    assert (await upload(client, unsupported)).json()["details"]["reason"] == "unsupported_format"


async def test_upload_size_limit(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path / "data", max_import_mb=1)
    app = create_app(settings)
    big = tmp_path / "gross.csv"
    big.write_bytes(b"a,b\n" + b"1,2\n" * 300_000)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await upload(client, big)
    assert (response.status_code, response.json()["code"]) == (413, "upload_too_large")
    assert list(settings.staging_dir.iterdir()) == []


# --- catalog and metadata -----------------------------------------------------


async def test_catalog_shows_last_import(client: httpx.AsyncClient) -> None:
    layers = (await client.get("/api/admin/layers")).json()
    schulen = next(layer for layer in layers if layer["name"] == "schulen")
    assert schulen["last_import"]["status"] == "ok"
    assert schulen["source"] == "sample:tandemtal"


async def test_rename_and_curate(client: httpx.AsyncClient) -> None:
    layer = await client.patch(
        "/api/admin/layers/schulen", json={"title": "Schulhäuser", "for_model": False}
    )
    assert (layer.json()["name"], layer.json()["title"]) == ("schulen", "Schulhäuser")
    attribute = await client.patch(
        "/api/admin/layers/schulen/attributes/schueler",
        json={"label": "Schülerzahl", "unit": "Personen", "value_domain": {"min": 0, "max": 2000}},
    )
    assert attribute.json()["value_domain"] == {"min": 0, "max": 2000}
    assert attribute.json()["unit"] == "Personen"
    # Queries keep working: the identifier did not change.
    result = await client.post(
        "/api/query", json={"source": "schulen", "output": "table", "limit": 1}
    )
    assert result.status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"value_domain": {"min": 5, "max": 1}},
        {"value_domain": {"min": 1, "codes": {"a": "A"}}},
    ],
)
async def test_invalid_value_domain(client: httpx.AsyncClient, body: dict[str, Any]) -> None:
    response = await client.patch("/api/admin/layers/schulen/attributes/schueler", json=body)
    assert (response.status_code, response.json()["code"]) == (422, "schema_violation")


async def test_unknown_layer_and_attribute(client: httpx.AsyncClient) -> None:
    assert (await client.patch("/api/admin/layers/nope", json={})).status_code == 404
    response = await client.patch("/api/admin/layers/schulen/attributes/nope", json={})
    assert response.status_code == 404


async def test_profile_follows_for_model(client: httpx.AsyncClient) -> None:
    profile = (await client.get("/api/admin/layers/gewaesser/profile")).json()
    assert profile["name"] == "gewaesser"
    typ = next(a for a in profile["attributes"] if a["name"] == "typ")
    assert typ["codes"] == {"fluss": "Fluss", "bach": "Bach"}
    await client.patch("/api/admin/layers/gewaesser/attributes/typ", json={"for_model": False})
    profile = (await client.get("/api/admin/layers/gewaesser/profile")).json()
    assert "typ" not in [a["name"] for a in profile["attributes"]]
    await client.patch("/api/admin/layers/gewaesser", json={"for_model": False})
    assert (await client.get("/api/admin/layers/gewaesser/profile")).json() is None


async def test_delete_layer(client: httpx.AsyncClient) -> None:
    assert (await client.delete("/api/admin/layers/strassen")).status_code == 204
    assert (await client.get("/api/layers/strassen")).status_code == 404
    assert (await client.delete("/api/admin/layers/strassen")).status_code == 404
