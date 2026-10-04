"""Catalog extras of plan E1.8, WP41: default visibility of new layers (design
D10) and duplicating a layer (design D2), against the HTTP API."""

from pathlib import Path
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, sign_in, sign_in_as
from fastapi import FastAPI
from import_files import make_files


@pytest.fixture(scope="module")
def files(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return make_files(tmp_path_factory.mktemp("files"))


async def import_points(client: httpx.AsyncClient, path: Path, name: str) -> dict[str, Any]:
    staged = await client.post("/api/admin/imports", files={"file": (path.name, path.read_bytes())})
    import_id = staged.json()["import_id"]
    run = await client.post(f"/api/admin/imports/{import_id}/commit", json={"layer_name": name})
    body: dict[str, Any] = run.json()
    assert body["status"] in ("ok", "warning"), body
    return body


async def user_sees(client: httpx.AsyncClient, layer: str) -> bool:
    await sign_in(client, "m.keller", USER_PASSWORD)
    names = [info["name"] for info in (await client.get("/api/layers")).json()]
    await sign_in(client, "admin", ADMIN_PASSWORD)
    return layer in names


# --- default visibility (design D10) -----------------------------------------------


async def test_new_layers_wait_for_release_unless_set_otherwise(
    client: httpx.AsyncClient, files: dict[str, Path]
) -> None:
    await sign_in_as(client, "m.keller")
    await sign_in(client, "admin", ADMIN_PASSWORD)
    default = await client.get("/api/admin/visibility/default")
    assert default.json() == {"new_layers_visible": False}

    await import_points(client, files["schulen.geojson"], "verdeckt")
    assert not await user_sees(client, "verdeckt")

    changed = await client.put("/api/admin/visibility/default", json={"new_layers_visible": True})
    assert changed.json() == {"new_layers_visible": True}
    await import_points(client, files["schulen.geojson"], "sofort")
    assert await user_sees(client, "sofort")
    # The setting applies to new layers; the earlier one stays as it was.
    assert not await user_sees(client, "verdeckt")


async def test_a_replaced_layer_keeps_its_visibility(
    client: httpx.AsyncClient, files: dict[str, Path]
) -> None:
    await sign_in_as(client, "m.keller")
    await sign_in(client, "admin", ADMIN_PASSWORD)
    await import_points(client, files["schulen.geojson"], "bleibt")
    await client.put("/api/admin/visibility/default", json={"new_layers_visible": True})
    path = files["schulen.geojson"]
    staged = await client.post("/api/admin/imports", files={"file": (path.name, path.read_bytes())})
    run = await client.post(
        f"/api/admin/imports/{staged.json()['import_id']}/commit", json={"replace": "bleibt"}
    )
    assert run.json()["status"] in ("ok", "warning")
    assert not await user_sees(client, "bleibt")


# --- duplicate (design D2) ------------------------------------------------------------


async def test_a_duplicate_copies_data_metadata_and_visibility(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    await sign_in(client, "admin", ADMIN_PASSWORD)
    await client.patch("/api/admin/layers/schulen/attributes/name", json={"label": "Schulname X"})

    copy = await client.post("/api/admin/layers/schulen/duplicate", json={})
    assert copy.status_code == 201, copy.text
    info = copy.json()
    assert (info["name"], info["title"]) == ("schulen_kopie", "Schulen (Kopie)")
    original = (await client.get("/api/layers/schulen")).json()
    assert info["feature_count"] == original["feature_count"]
    assert info["geometry_type"] == original["geometry_type"]
    assert [(a["name"], a["label"], a["data_type"]) for a in info["attributes"]] == [
        (a["name"], a["label"], a["data_type"]) for a in original["attributes"]
    ]

    rows = {
        "schulen": (await client.post("/api/query", json={"source": "schulen", "limit": 5})).json(),
        "copy": (
            await client.post("/api/query", json={"source": "schulen_kopie", "limit": 5})
        ).json(),
    }
    assert [f["properties"] for f in rows["copy"]["features"]] == [
        f["properties"] for f in rows["schulen"]["features"]
    ]
    assert [f["geometry"] for f in rows["copy"]["features"]] == [
        f["geometry"] for f in rows["schulen"]["features"]
    ]
    # The sample is released for users, so is its copy.
    assert await user_sees(client, "schulen_kopie")

    # A second copy is numbered; the copy is logged like an import.
    again = await client.post("/api/admin/layers/schulen/duplicate", json={"title": "Zweite"})
    assert (again.json()["name"], again.json()["title"]) == ("schulen_kopie2", "Zweite")
    log = (await client.get("/api/admin/import-log")).json()
    assert {(r["mode"], r["layer_name"]) for r in log} >= {
        ("duplicate", "schulen_kopie"),
        ("duplicate", "schulen_kopie2"),
    }


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"name": "gemeinden"}, 409, "layer_exists"),
        ({"name": "Nicht Gültig"}, 400, "bad_request"),
    ],
)
async def test_bad_duplicate_names(
    client: httpx.AsyncClient, body: dict[str, Any], status: int, code: str
) -> None:
    response = await client.post("/api/admin/layers/schulen/duplicate", json=body)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


async def test_no_free_copy_name_asks_for_one(
    client: httpx.AsyncClient, app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    backend = app.state.geotandem.backend
    copies = ["schulen_kopie", *(f"schulen_kopie{i}" for i in range(2, 100))]
    monkeypatch.setattr(backend, "layer_names", lambda: ["schulen", *copies])
    response = await client.post("/api/admin/layers/schulen/duplicate", json={})
    assert (response.status_code, response.json()["code"]) == (409, "layer_exists")


async def test_only_administrators_duplicate(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    response = await client.post("/api/admin/layers/schulen/duplicate", json={})
    assert response.status_code == 403
    assert (await client.get("/api/admin/visibility/default")).status_code == 403
