"""The layer profile (plan E2.2, S1-S7): metadata only, the account's view, canonical."""

import json
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import text

from geotandem.catalog import model_profile
from geotandem.data import DataBackend, Limits
from geotandem.tools import ToolContext, default_registry

KEY = "gem_nr"
SENTINELS = ("ZEBRA-7731", "QUOKKA-4402", "987654.321")


def sentinel_csv(directory: Path) -> Path:
    """Six points with two category values and one odd number: a code list and a
    range the import proposes from the rows."""
    rows = ["E,N,kategorie,wert"]
    for i in range(6):
        category = SENTINELS[i % 2]
        rows.append(f"{2600000 + i * 100},{1200000 + i * 100},{category},{SENTINELS[2]}")
    path = directory / "sentinel.csv"
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return path


async def import_sentinels(client: httpx.AsyncClient, path: Path) -> None:
    staged = await client.post(
        "/api/admin/imports", files={"file": (path.name, path.read_bytes(), "text/csv")}
    )
    assert staged.status_code == 200, staged.text
    preview = staged.json()["preview"]
    # The import does propose them: the proof below is not empty.
    proposals = {c["name"]: c["value_domain"] for c in preview["columns"]}
    assert set(proposals["kategorie"]["codes"]) == set(SENTINELS[:2])
    committed = await client.post(
        f"/api/admin/imports/{staged.json()['import_id']}/commit",
        json={
            "geo": {"mode": "xy", "x": "E", "y": "N", "crs": 2056},
            "layer_name": "sentinel",
            "title": "Sentinel",
        },
    )
    assert committed.json()["status"] in ("ok", "warning"), committed.text


async def profile_text(client: httpx.AsyncClient, account: str) -> str:
    response = await client.get("/api/admin/llm/profile", params={"account": account})
    assert response.status_code == 200, response.text
    return response.text


def leaked(text: str) -> list[str]:
    return [s for s in SENTINELS if s in text]


async def test_no_row_value_reaches_the_model_until_confirmed(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """S7: the done-when of E2.2 as a test."""
    await import_sentinels(client, sentinel_csv(tmp_path))
    text = await profile_text(client, "admin")
    assert '"name":"sentinel"' in text.replace(" ", "")
    assert leaked(text) == []
    single = await client.get("/api/admin/layers/sentinel/profile")
    assert leaked(single.text) == []
    # The administrator's editor still shows the proposal, marked unconfirmed.
    attributes = (await client.get("/api/admin/layers")).json()
    [layer] = [lay for lay in attributes if lay["name"] == "sentinel"]
    [kategorie] = [a for a in layer["attributes"] if a["name"] == "kategorie"]
    assert kategorie["value_domain_confirmed"] is False and kategorie["value_domain"]

    # Confirming (saving) one code list puts exactly that into the profile.
    confirmed = await client.patch(
        "/api/admin/layers/sentinel/attributes/kategorie",
        json={"value_domain": {"codes": {SENTINELS[0]: "Zebra-Gruppe"}}},
    )
    assert confirmed.json()["value_domain_confirmed"] is True
    assert leaked(await profile_text(client, "admin")) == [SENTINELS[0]]


async def test_s1_no_counts_or_extents(client: httpx.AsyncClient) -> None:
    text = await profile_text(client, "admin")
    for word in ("feature_count", "bbox", "extent", "dataset_version", "source"):
        assert word not in text


async def profile_of(client: httpx.AsyncClient, account: str) -> dict[str, Any]:
    body: dict[str, Any] = (
        await client.get("/api/admin/llm/profile", params={"account": account})
    ).json()
    return body


def layer_of(profile: dict[str, Any], name: str) -> dict[str, Any]:
    found: dict[str, Any] = next(lay for lay in profile["layers"] if lay["name"] == name)
    return found


async def test_s3_only_what_the_account_sees_and_the_model_may_know(
    client: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    with backend_of_client.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE layer_attribute SET \"references\" = 'gemeinden.gem_nr'"
                " WHERE name = 'gem_nr' AND layer_id ="
                " (SELECT id FROM layer WHERE name = 'gemeindedaten')"
            )
        )
    await client.patch("/api/admin/layers/schulen", json={"for_model": False})
    steuerjahr = "/api/admin/layers/gemeindedaten/attributes/steuerjahr"
    await client.patch(steuerjahr, json={"for_model": False})
    hide = {"layer": "gemeinden", "role": "user", "visible": False}
    assert (await client.put("/api/admin/visibility", json=hide)).status_code == 200
    created = await client.post("/api/admin/users", json={"username": "m.keller", "role": "user"})
    assert created.status_code == 201

    admin = await profile_of(client, "admin")
    user = await profile_of(client, "m.keller")
    assert "schulen" not in names(admin) and "schulen" not in names(user)
    assert "gemeinden" in names(admin) and "gemeinden" not in names(user)
    attributes = [a["name"] for a in layer_of(admin, "gemeindedaten")["attributes"]]
    assert "steuerjahr" not in attributes

    # A reference names its target only where the target is in the same profile.
    [admin_key] = [a for a in layer_of(admin, "gemeindedaten")["attributes"] if a["name"] == KEY]
    [user_key] = [a for a in layer_of(user, "gemeindedaten")["attributes"] if a["name"] == KEY]
    assert admin_key["references"] == "gemeinden.gem_nr"
    assert user_key.get("references") is None
    # Structure names no hidden layer. Free text an administrator wrote is theirs:
    # the sample describes gem_nr as "Schlüssel auf gemeinden.gem_nr".
    structure = [
        (lay["name"], [a.get("references") for a in lay["attributes"]]) for lay in user["layers"]
    ]
    assert "gemeinden" not in json.dumps(structure)


def test_s4_canonical_ordered_and_hashed(sample: DataBackend) -> None:
    visible = sample.layer_names()
    first = model_profile(sample.engine, visible)
    again = model_profile(sample.engine, list(reversed(sorted(visible))))
    assert first.profile_version == 1
    assert (first.hash, first.size_chars) == (again.hash, again.size_chars)
    assert len(first.hash) == 64
    assert [p.name for p in first.layers] == sorted(p.name for p in first.layers)
    fewer = model_profile(sample.engine, [n for n in visible if n != "schulen"])
    assert fewer.hash != first.hash and fewer.size_chars < first.size_chars


def test_the_model_path_tools_return_profiles(sample: DataBackend) -> None:
    context = ToolContext(sample, Limits(max_features=10, timeout_s=10))
    registry = default_registry()
    listed = registry.get("list_layers").call(context, {}).model_dump_json()
    described = registry.get("describe_layer").call(context, {"layer": "schulen"})
    assert "feature_count" not in listed and "bbox" not in listed
    assert (
        described.model_dump()
        == next(
            p
            for p in model_profile(sample.engine, sample.layer_names()).layers
            if p.name == "schulen"
        ).model_dump()
    )


async def test_unknown_account_is_404(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/admin/llm/profile", params={"account": "niemand"})
    assert (response.status_code, response.json()["code"]) == (404, "not_found")


def names(profile: dict[str, Any]) -> list[str]:
    return [layer["name"] for layer in profile["layers"]]


async def test_the_preview_sizes_the_profile_against_the_accounts_connection(
    client: httpx.AsyncClient,
) -> None:
    """S5: a token estimate next to the context length of the connection in use."""
    alone = await profile_of(client, "admin")
    assert alone["tokens_estimate"] == -(-alone["size_chars"] // 3)
    assert (alone["budget"], alone["over_budget"]) == (None, False)

    connection = {"name": "Ollama", "base_url": "http://127.0.0.1:11434/v1", "model": "q"}
    created = await client.post(
        "/api/admin/llm/connections", json={**connection, "enabled": True, "context_length": 256}
    )
    assert created.status_code == 201, created.text
    small = await profile_of(client, "admin")
    assert small["budget"] == {"connection": "Ollama", "context_length": 256}
    assert small["tokens_estimate"] > 256 and small["over_budget"] is True

    await client.patch(
        f"/api/admin/llm/connections/{created.json()['id']}", json={"context_length": 10_000_000}
    )
    assert (await profile_of(client, "admin"))["over_budget"] is False
