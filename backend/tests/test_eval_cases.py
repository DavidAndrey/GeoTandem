"""Cases over HTTP: the start set, own cases, import and export, data states
(plan E3, D1-D4, WP87).

The start set is listed first and never changes; an own case is checked on its
data state as a model's query is, so a reference the application would refuse
cannot become the right answer, and a live case on a layer the administrator's
model cannot see is refused. Export and import are a round trip and import is
all or nothing. A live case becomes ``stale`` when its layer goes and
``dataset_changed`` when its layer's dataset version moves; the detail counts
each reading's features on the case's data state.
"""

import json
import logging
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from import_files import make_files
from sqlalchemy import update
from sqlalchemy.orm import Session

from geotandem.catalog import get_layer
from geotandem.config import Settings
from geotandem.data import DataBackend
from geotandem.db.bootstrap import ConfigurationError
from geotandem.db.orm import Layer
from geotandem.engine import count_query
from geotandem.evaluation import cases as case_module
from geotandem.evaluation.schemas import EvalCase
from geotandem.evaluation.store import CaseStore
from geotandem.importing.run import ImportDecisions, run_import
from geotandem_query import QueryObject

REPO = Path(__file__).resolve().parents[2]
START = [REPO / "schema" / "eval-cases" / f"start-{s}.json" for s in ("tuning", "confirm")]
CASES = "/api/admin/evaluation/cases"

PRIMAR = {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"}
SCHULEN = {"source": "schulen", "where": PRIMAR}
OWN = {
    "id": "eigene-primar",
    "prompt": "Welche Primarschulen gibt es?",
    "tags": ["attribute"],
    "split": "confirm",
    "origin": "authored",
    "gold": SCHULEN,
}


def start_cases() -> list[dict[str, Any]]:
    return [case for path in START for case in json.loads(path.read_text("utf-8"))["cases"]]


def version_of(app: FastAPI, layer: str) -> str | None:
    info = get_layer(app.state.geotandem.backend.engine, layer)
    assert info is not None
    return info.dataset_version


def live(app: FastAPI, **extra: Any) -> dict[str, Any]:
    """A live case on ``schulen`` as the workplace would save it."""
    layers = [{"name": "schulen", "dataset_version": version_of(app, "schulen")}]
    return {**OWN, "id": "live-primar", "data_state": "live", "layers": layers, **extra}


def hits(app: FastAPI, reading: dict[str, Any]) -> int:
    query = QueryObject.model_validate({"schema_version": "2", "output": "map", **reading})
    state = app.state.geotandem
    return count_query(query, state.backend, state.limits)


async def created(client: httpx.AsyncClient, case: dict[str, Any]) -> dict[str, Any]:
    response = await client.post(CASES, json=case)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def refused(
    client: httpx.AsyncClient, case: dict[str, Any], status: int, code: str
) -> dict[str, Any]:
    response = await client.post(CASES, json=case)
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    assert body["code"] == code, body
    return body


# --- the start set -------------------------------------------------------------


async def test_the_list_shows_the_start_set_first_read_only_and_without_hits(
    client: httpx.AsyncClient,
) -> None:
    await created(client, OWN)
    page = (await client.get(CASES)).json()
    ids = [item["case"]["id"] for item in page["items"]]
    assert page["total"] == 72
    assert ids == [c["id"] for c in start_cases()] + ["eigene-primar"]
    assert all(item["read_only"] for item in page["items"][:71])
    assert not page["items"][71]["read_only"]
    assert all(item["reference_hits"] is None for item in page["items"])
    assert all(item["status"] == "ok" for item in page["items"])


async def test_the_list_filters_and_pages(client: httpx.AsyncClient) -> None:
    await created(client, OWN)
    split = (await client.get(CASES, params={"split": "tuning"})).json()
    assert split["total"] == 33
    assert {i["case"]["split"] for i in split["items"]} == {"tuning"}
    own = (await client.get(CASES, params={"origin": "authored"})).json()
    assert [i["case"]["id"] for i in own["items"]] == ["eigene-primar"]
    tag = (await client.get(CASES, params={"tag": "attribute"})).json()
    assert "eigene-primar" in [i["case"]["id"] for i in tag["items"]]
    assert all("attribute" in i["case"]["tags"] for i in tag["items"])
    assert (await client.get(CASES, params={"data_state": "live"})).json()["total"] == 0
    page = (await client.get(CASES, params={"offset": 70, "limit": 5})).json()
    assert page["total"] == 72 and len(page["items"]) == 2


async def test_a_start_case_reads_with_the_hits_of_each_reading_on_the_sample(
    client: httpx.AsyncClient,
) -> None:
    view = (await client.get(f"{CASES}/doc1-primar-koeniz")).json()
    assert view["read_only"] and view["status"] == "ok"
    assert view["reference_hits"] == [4, 8]
    assert view["created_at"] is None
    behaviour = (await client.get(f"{CASES}/n15-je-gemeinde")).json()
    assert behaviour["reference_hits"] is None


async def test_a_start_case_is_neither_edited_nor_deleted(client: httpx.AsyncClient) -> None:
    case = (await client.get(f"{CASES}/doc4-ohne-sek")).json()["case"]
    put = await client.put(f"{CASES}/doc4-ohne-sek", json={**case, "origin": "authored"})
    assert (put.status_code, put.json()["code"]) == (409, "case_read_only")
    gone = await client.delete(f"{CASES}/doc4-ohne-sek")
    assert (gone.status_code, gone.json()["code"]) == (409, "case_read_only")
    assert (await client.get(f"{CASES}/doc4-ohne-sek")).status_code == 200


async def test_an_unknown_case_is_not_found(client: httpx.AsyncClient) -> None:
    for method in ("GET", "PUT", "DELETE"):
        body = {**OWN, "id": "nirgends"} if method == "PUT" else None
        response = await client.request(method, f"{CASES}/nirgends", json=body)
        assert (response.status_code, response.json()["code"]) == (404, "not_found"), method


def test_the_start_set_is_found_where_the_settings_say(tmp_path: Path) -> None:
    """The image copies ``schema/eval-cases`` beside the package (Dockerfile)."""
    for path in START:
        (tmp_path / path.name).write_bytes(path.read_bytes())
    found = case_module.start_cases(Settings(data_dir=tmp_path, eval_cases_dir=tmp_path))
    assert [c.id for c in found] == [c["id"] for c in start_cases()]
    assert case_module.start_cases(Settings(data_dir=tmp_path)) == found


# --- own cases -------------------------------------------------------------------


async def test_an_own_case_is_created_read_edited_and_deleted(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    view = await created(client, OWN)
    assert view["case"] == {**OWN, **_defaults()}
    assert not view["read_only"] and view["created_at"] and view["updated_at"]
    assert view["reference_hits"] == [hits(app, SCHULEN)]

    edited = {**OWN, "tags": ["attribute", "eigene"], "note": "Primarstufe"}
    put = await client.put(f"{CASES}/eigene-primar", json=edited)
    assert put.status_code == 200, put.text
    assert put.json()["case"]["tags"] == ["attribute", "eigene"]
    assert (await client.get(f"{CASES}/eigene-primar")).json()["case"]["note"] == "Primarstufe"

    renamed = await client.put(f"{CASES}/eigene-primar", json={**edited, "id": "eigene-2"})
    assert renamed.status_code == 200, renamed.text
    assert (await client.get(f"{CASES}/eigene-primar")).status_code == 404

    assert (await client.delete(f"{CASES}/eigene-2")).status_code == 204
    assert (await client.get(f"{CASES}/eigene-2")).status_code == 404
    assert (await client.delete(f"{CASES}/eigene-2")).status_code == 404


def _defaults() -> dict[str, Any]:
    """What a view adds to a case it was not given: every field, ``null`` included."""
    return {
        "data_state": "sample",
        "origin_action": None,
        "schema_version": "2",
        "gold_any": None,
        "require": None,
        "expect": None,
        "also": [],
        "forbid": [],
        "other_approach": None,
        "note": "",
        "layers": [],
    }


async def test_a_case_read_and_written_back_demands_the_same(client: httpx.AsyncClient) -> None:
    """Review WP85 #1 through the routes: the view writes ``null``s; a PUT of it
    changes nothing a case demands."""
    await created(client, OWN)
    case = (await client.get(f"{CASES}/eigene-primar")).json()["case"]
    assert (await client.put(f"{CASES}/eigene-primar", json=case)).status_code == 200
    assert (await client.get(f"{CASES}/eigene-primar")).json()["case"] == case


async def test_ids_are_unique_over_the_start_set_and_own_cases(client: httpx.AsyncClient) -> None:
    await refused(client, {**OWN, "id": "doc1-primar-koeniz"}, 409, "case_id_taken")
    await created(client, OWN)
    await refused(client, OWN, 409, "case_id_taken")
    await created(client, {**OWN, "id": "eigene-2"})
    put = await client.put(f"{CASES}/eigene-2", json=OWN)
    assert (put.status_code, put.json()["code"]) == (409, "case_id_taken")
    put = await client.put(f"{CASES}/eigene-2", json={**OWN, "id": "doc1-primar-koeniz"})
    assert (put.status_code, put.json()["code"]) == (409, "case_id_taken")


async def test_a_copy_of_every_start_case_is_a_valid_own_case(client: httpx.AsyncClient) -> None:
    """The start set passes the checks of an own case: a copy is always possible."""
    copies = [{**c, "id": f"kopie-{c['id']}"[:63], "origin": "authored"} for c in start_cases()]
    result = (await client.post(f"{CASES}/import", json={"cases": copies})).json()
    assert result == {"imported": 71, "problems": []}


# --- validation ------------------------------------------------------------------


async def test_only_the_start_set_says_origin_start(client: httpx.AsyncClient) -> None:
    body = await refused(client, {**OWN, "origin": "start"}, 400, "case_invalid")
    assert body["details"] == {"case_id": "eigene-primar", "reason": "origin_start"}


@pytest.mark.parametrize(
    ("gold", "reason"),
    [
        ({"source": "geheim"}, "unknown_layer"),
        ({"source": "schulen", "where": {**PRIMAR, "attr": "erfunden"}}, "unknown_attribute"),
        ({"source": "schulen", "delete": True}, "model_query_invalid"),
        (
            {
                "source": "schulen",
                "where": {
                    "op": "or",
                    "args": [{**PRIMAR, "value": f"typ-{n}"} for n in range(9)],
                },
            },
            "limit_exceeded",
        ),
    ],
)
async def test_a_reference_passes_the_checks_of_a_model_query(
    client: httpx.AsyncClient, gold: dict[str, Any], reason: str
) -> None:
    """Security review E3: an import cannot carry a query past the checks."""
    body = await refused(client, {**OWN, "gold": gold}, 400, "case_invalid")
    assert body["details"]["case_id"] == "eigene-primar"
    assert body["details"]["reason"] == reason
    assert body["details"]["reading"] == 0


async def test_every_fair_reading_is_checked(client: httpx.AsyncClient) -> None:
    case = {**OWN, "gold": None, "gold_any": [SCHULEN, {"source": "geheim"}]}
    body = await refused(client, case, 400, "case_invalid")
    assert body["details"]["reading"] == 1


async def test_a_required_source_must_exist(client: httpx.AsyncClient) -> None:
    case = {**OWN, "gold": None, "require": {"source": "geheim", "conditions": [PRIMAR]}}
    body = await refused(client, case, 400, "case_invalid")
    assert body["details"]["reason"] == "unknown_layer"


async def test_a_live_case_on_a_missing_layer_is_stale_from_the_start(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    case = live(app, layers=[{"name": "verschwunden"}], gold={"source": "verschwunden"})
    body = await refused(client, case, 409, "case_stale")
    assert body["details"]["layer"] == "verschwunden"


async def test_a_live_case_names_every_layer_its_reference_uses(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    related = {
        "source": "schulen",
        "where": {
            "op": "related",
            "layer": "gemeinden",
            "predicate": "within",
            "where": {"op": "compare", "attr": "name", "cmp": "eq", "value": "Köniz"},
        },
    }
    body = await refused(client, live(app, gold=related), 400, "case_invalid")
    details = body["details"]
    assert (details["reason"], details["layer"]) == ("layer_not_listed", "gemeinden")


async def test_a_live_case_names_no_layer_it_does_not_use(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    layers = [{"name": "schulen"}, {"name": "gemeinden"}]
    body = await refused(client, live(app, layers=layers), 400, "case_invalid")
    details = body["details"]
    assert (details["reason"], details["layer"]) == ("layer_not_used", "gemeinden")


@pytest.mark.parametrize(
    "given", [{"name": "schulen"}, {"name": "schulen", "dataset_version": "x"}]
)
async def test_the_server_stamps_the_dataset_versions_of_a_live_case(
    client: httpx.AsyncClient, app: FastAPI, given: dict[str, Any]
) -> None:
    """D3: the version a case is compared with is the one of its creation, as
    the server reads it, whatever the client sent."""
    view = await created(client, live(app, layers=[given]))
    current = {"name": "schulen", "dataset_version": version_of(app, "schulen")}
    assert view["case"]["layers"] == [current]
    assert view["status"] == "ok"
    edited = await client.put(f"{CASES}/live-primar", json=live(app, layers=[given]))
    assert edited.json()["case"]["layers"] == [current]


async def test_a_live_require_case_names_its_layers(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    near = {"op": "related", "layer": "haltestellen", "predicate": "dwithin"}
    require = {"source": "schulen", "conditions": [near]}
    case = live(app, gold=None, require=require)
    body = await refused(client, case, 400, "case_invalid")
    details = body["details"]
    assert (details["reason"], details["layer"]) == ("layer_not_listed", "haltestellen")
    layers = [{"name": "schulen"}, {"name": "haltestellen"}]
    await created(client, {**case, "layers": layers})


async def test_a_required_attribute_must_exist(client: httpx.AsyncClient) -> None:
    wrong = {"op": "compare", "attr": "erfunden"}
    case = {**OWN, "gold": None, "require": {"source": "schulen", "conditions": [wrong]}}
    body = await refused(client, case, 400, "case_invalid")
    assert (body["details"]["reason"], body["details"]["attribute"]) == (
        "unknown_attribute",
        "erfunden",
    )


async def test_a_log_case_names_an_action_of_this_instance(client: httpx.AsyncClient) -> None:
    body = await refused(client, {**OWN, "origin": "log", "origin_action": 7}, 400, "case_invalid")
    assert body["details"]["reason"] == "origin_action"


async def test_an_edit_onto_a_missing_layer_is_stale(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    await created(client, live(app))
    gone = live(app, layers=[{"name": "verschwunden"}], gold={"source": "verschwunden"})
    put = await client.put(f"{CASES}/live-primar", json=gone)
    assert (put.status_code, put.json()["code"]) == (409, "case_stale")


async def test_a_layer_not_released_for_the_model_is_out_of_the_live_world(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """The administrator sees the layer, but a model would not know it."""
    patched = await client.patch("/api/admin/layers/schulen", json={"for_model": False})
    assert patched.status_code == 200, patched.text
    await refused(client, live(app), 409, "case_stale")


async def test_start_and_own_cases_fit_one_case_file(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Start set plus own cases are at most ``MAX_CASES``: the export of both is
    one valid case file; creation and import beyond are ``too_many``."""
    monkeypatch.setattr(case_module, "MAX_CASES", 73)
    await created(client, OWN)
    await created(client, {**OWN, "id": "eigene-2"})
    body = await refused(client, {**OWN, "id": "eigene-3"}, 400, "case_invalid")
    assert (body["details"]["reason"], body["details"]["max"]) == ("too_many", 2)

    exported = await client.get(f"{CASES}/export", params={"start": True})
    assert exported.status_code == 200, exported.text
    assert len(exported.json()["cases"]) == 73

    file = {"cases": [{**OWN, "id": "eigene-4"}]}
    result = (await client.post(f"{CASES}/import", json=file)).json()
    assert result["imported"] == 0
    assert [(p["case_id"], p["code"]) for p in result["problems"]] == [(None, "case_invalid")]


# --- export and import -------------------------------------------------------------


async def test_the_start_set_exports_as_its_files_hold_it(client: httpx.AsyncClient) -> None:
    """F-3.13: same keys and values; no ``null`` and no default it was not given."""
    exported = (await client.get(f"{CASES}/export", params={"start": True})).json()
    assert exported["format"] == "geotandem-eval-cases" and exported["version"] == 1
    assert exported["cases"] == start_cases()
    own = (await client.get(f"{CASES}/export")).json()
    assert own == {"format": "geotandem-eval-cases", "version": 1, "cases": []}


async def test_a_live_case_survives_export_and_import_unchanged(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    case = live(app, note="aus dem Arbeitsplatz", also=[])
    await created(client, case)
    exported = (await client.get(f"{CASES}/export")).json()
    assert exported["cases"] == [case]

    assert (await client.delete(f"{CASES}/live-primar")).status_code == 204
    result = await client.post(f"{CASES}/import", json=exported)
    assert result.json() == {"imported": 1, "problems": []}
    again = (await client.get(f"{CASES}/export")).json()
    assert again["cases"] == [{**case, "origin": "import"}]


async def test_an_imported_log_case_drops_the_action_of_its_instance(
    client: httpx.AsyncClient,
) -> None:
    """An action id of another instance names nothing here."""
    case = {**OWN, "origin": "log", "origin_action": 7}
    result = (await client.post(f"{CASES}/import", json={"cases": [case]})).json()
    assert result == {"imported": 1, "problems": []}
    (stored,) = (await client.get(f"{CASES}/export")).json()["cases"]
    assert stored["origin"] == "import" and "origin_action" not in stored


async def test_an_import_keeps_the_dataset_versions_of_its_file(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    case = live(app, layers=[{"name": "schulen", "dataset_version": "anderswo"}])
    result = (await client.post(f"{CASES}/import", json={"cases": [case]})).json()
    assert result == {"imported": 1, "problems": []}
    view = (await client.get(f"{CASES}/live-primar")).json()
    assert view["case"]["layers"] == [{"name": "schulen", "dataset_version": "anderswo"}]
    assert view["status"] == "dataset_changed"


async def test_an_import_over_the_limit_takes_nothing(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(case_module, "MAX_CASES", 72)
    file = {"cases": [OWN, {**OWN, "id": "eigene-2"}]}
    result = (await client.post(f"{CASES}/import", json=file)).json()
    assert result["imported"] == 0
    assert result["problems"][0]["code"] == "case_invalid"
    assert "at most 1 own cases" in result["problems"][0]["message"]
    assert (await client.get(CASES, params={"origin": "import"})).json()["total"] == 0


async def test_an_import_is_all_or_nothing(client: httpx.AsyncClient) -> None:
    bad = {**OWN, "id": "kaputt", "gold": {"source": "geheim"}}
    file = {"cases": [OWN, bad, {**OWN, "id": "doc1-primar-koeniz"}]}
    result = (await client.post(f"{CASES}/import", json=file)).json()
    assert result["imported"] == 0
    assert [(p["case_id"], p["code"]) for p in result["problems"]] == [
        ("kaputt", "case_invalid"),
        ("doc1-primar-koeniz", "case_id_taken"),
    ]
    assert "kaputt" in result["problems"][0]["message"]
    assert (await client.get(CASES, params={"origin": "authored"})).json()["total"] == 0


async def test_the_start_set_is_not_imported_again(client: httpx.AsyncClient) -> None:
    exported = (await client.get(f"{CASES}/export", params={"start": True})).json()
    result = (await client.post(f"{CASES}/import", json=exported)).json()
    assert result["imported"] == 0 and len(result["problems"]) == 71
    assert {p["code"] for p in result["problems"]} == {"case_id_taken"}


async def test_an_import_of_an_id_in_use_takes_nothing(client: httpx.AsyncClient) -> None:
    await created(client, OWN)
    file = {"cases": [{**OWN, "id": "neu"}, OWN]}
    result = (await client.post(f"{CASES}/import", json=file)).json()
    assert result["imported"] == 0
    assert [(p["case_id"], p["code"]) for p in result["problems"]] == [
        ("eigene-primar", "case_id_taken")
    ]
    assert (await client.get(f"{CASES}/neu")).status_code == 404


async def test_an_import_with_a_stale_live_case_names_it(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    case = live(app, layers=[{"name": "verschwunden"}], gold={"source": "verschwunden"})
    result = (await client.post(f"{CASES}/import", json={"cases": [case]})).json()
    assert result["problems"] == [
        {
            "case_id": "live-primar",
            "code": "case_stale",
            "message": "The case 'live-primar' uses the layer 'verschwunden', "
            "which is gone or hidden.",
        }
    ]


# --- data states (D1, D3) ----------------------------------------------------------


async def test_a_live_case_counts_its_reference_on_the_live_catalog(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    view = await created(client, live(app))
    assert view["status"] == "ok"
    assert view["reference_hits"] == [hits(app, SCHULEN)]


async def test_a_live_case_on_a_deleted_layer_reads_stale(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    await created(client, live(app))
    assert (await client.delete("/api/admin/layers/schulen")).status_code == 204

    view = (await client.get(f"{CASES}/live-primar")).json()
    assert (view["status"], view["status_layers"]) == ("stale", ["schulen"])
    assert view["reference_hits"] is None
    listed = (await client.get(CASES, params={"data_state": "live"})).json()["items"]
    assert [(i["status"], i["status_layers"]) for i in listed] == [("stale", ["schulen"])]


async def test_a_stale_case_is_edited_back_into_runs(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    await created(client, live(app))
    assert (await client.delete("/api/admin/layers/schulen")).status_code == 204
    layers = [{"name": "gemeinden", "dataset_version": version_of(app, "gemeinden")}]
    gold = {"source": "gemeinden"}
    put = await client.put(f"{CASES}/live-primar", json={**OWN, **_live_of(layers, gold)})
    assert put.status_code == 200, put.text
    assert put.json()["status"] == "ok"


def _live_of(layers: list[dict[str, Any]], gold: dict[str, Any]) -> dict[str, Any]:
    return {"id": "live-primar", "data_state": "live", "layers": layers, "gold": gold}


async def test_a_changed_dataset_version_marks_the_case(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    await created(client, live(app))
    engine = app.state.geotandem.backend.engine
    with Session(engine) as db, db.begin():
        db.execute(update(Layer).where(Layer.name == "schulen").values(dataset_version="neu"))

    view = (await client.get(f"{CASES}/live-primar")).json()
    assert (view["status"], view["status_layers"]) == ("dataset_changed", ["schulen"])
    assert view["reference_hits"] == [hits(app, SCHULEN)]


async def test_a_re_imported_layer_marks_the_case(
    client: httpx.AsyncClient, app: FastAPI, tmp_path: Path
) -> None:
    """D3 through a real import that replaces the layer: a new dataset version."""
    whole = {"source": "schulen"}
    await created(client, live(app, gold=whole))
    files = make_files(tmp_path / "import")
    backend = app.state.geotandem.backend
    run = run_import(
        files["schulen.geojson"],
        "schulen.geojson",
        ImportDecisions(replace="schulen"),
        backend,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run

    view = (await client.get(f"{CASES}/live-primar")).json()
    assert (view["status"], view["status_layers"]) == ("dataset_changed", ["schulen"])
    assert view["reference_hits"] == [hits(app, whole)]


async def test_a_reading_that_no_longer_passes_has_no_hits(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """The attribute of the reference is withdrawn from the model after creation."""
    await created(client, live(app))
    withdrawn = await client.patch(
        "/api/admin/layers/schulen/attributes/typ", json={"for_model": False}
    )
    assert withdrawn.status_code == 200, withdrawn.text
    view = (await client.get(f"{CASES}/live-primar")).json()
    assert view["status"] == "ok"
    assert view["reference_hits"] is None


async def test_sample_cases_run_on_their_own_copy_of_the_sample(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """D1: the live catalog changes nothing a sample case reads."""
    assert (await client.delete("/api/admin/layers/schulen")).status_code == 204
    view = (await client.get(f"{CASES}/doc1-primar-koeniz")).json()
    assert view["reference_hits"] == [4, 8]
    await created(client, OWN)


def test_the_sample_backend_is_built_once_and_only_read(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)
    first = case_module.sample_backend(settings)
    second = case_module.sample_backend(settings)
    assert first.engine is second.engine
    assert first.engine.url.database != settings.sqlalchemy_url
    with pytest.raises(PermissionError):
        first.drop_layer("schulen")


def test_the_sample_never_touches_a_configured_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D1: even with ``GEOTANDEM_DATABASE_URL`` set, the sample has a file of its own,
    opened read-only."""
    configured = tmp_path / "betrieb.sqlite"
    monkeypatch.setenv("GEOTANDEM_DATABASE_URL", f"sqlite:///{configured}")
    monkeypatch.setattr(case_module, "_samples", {})
    settings = Settings(data_dir=tmp_path)
    assert settings.database_url == f"sqlite:///{configured}"
    sample = case_module.sample_backend(settings)
    assert str(configured) not in str(sample.engine.url)
    assert "mode=ro" in str(sample.engine.url)
    assert not configured.exists()
    assert "schulen" in sample.layer_names()


def test_a_missing_start_set_stops_the_start(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="start set of the evaluation is missing"):
        case_module.start_cases(Settings(data_dir=tmp_path, eval_cases_dir=tmp_path / "leer"))


def test_an_own_case_behind_a_start_id_is_named_at_start(
    backend: DataBackend, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """A later start set may bring an id an own case has: the start log names it."""
    clash = EvalCase.model_validate({**OWN, "id": "doc1-primar-koeniz"})
    CaseStore(backend.engine).add([clash], at_most=10)
    with caplog.at_level(logging.WARNING, logger=case_module.log.name):
        case_module.check_start_set(settings, backend.engine)
    assert "doc1-primar-koeniz" in caplog.text
