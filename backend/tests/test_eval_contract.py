"""The contract of the evaluation, frozen in WP85 (plan E3, sections 1 and 6).

The start set is a valid case file and survives a round trip unchanged, the
committed case-file schema is the one the code writes, the case rules of D2
hold, every code is registered, no view can carry rows, and every route exists
for administrators only and answers 501 until its work package lands.
"""

import json
from pathlib import Path
from typing import Any, get_args

import httpx
import pytest
from api_helpers import sign_in_as
from fastapi import FastAPI
from pydantic import ValidationError

from geotandem.codes import CODES
from geotandem.evaluation.schemas import (
    CaseFile,
    EvalCase,
    EvalErrorCode,
    RunRequest,
    case_file_schema,
)
from geotandem_query import QueryObject

REPO = Path(__file__).resolve().parents[2]
CASES = REPO / "schema" / "eval-cases"
START = {"tuning": CASES / "start-tuning.json", "confirm": CASES / "start-confirm.json"}
SOURCE = REPO / "backend" / "src" / "geotandem"

PENDING_CODES: dict[str, str] = {
    "case_invalid": "WP87",
    "case_id_taken": "WP87",
    "case_read_only": "WP87",
    "case_stale": "WP87",
    "run_busy": "WP90",
    "external_not_confirmed": "WP90",
    "runs_not_comparable": "WP90",
}
"""Codes the contract names but no route raises yet, with the WP that must. That
WP raises the code and removes it here; Gate E3 needs this empty."""

ROUTES: dict[tuple[str, str], str] = {
    ("GET", "/api/admin/evaluation/cases"): "WP87",
    ("POST", "/api/admin/evaluation/cases"): "WP87",
    ("GET", "/api/admin/evaluation/cases/export"): "WP87",
    ("POST", "/api/admin/evaluation/cases/import"): "WP87",
    ("GET", "/api/admin/evaluation/cases/draft-from-action/1"): "WP92",
    ("GET", "/api/admin/evaluation/cases/doc1-primar-koeniz"): "WP87",
    ("PUT", "/api/admin/evaluation/cases/doc1-primar-koeniz"): "WP87",
    ("DELETE", "/api/admin/evaluation/cases/doc1-primar-koeniz"): "WP87",
    ("POST", "/api/admin/evaluation/runs/estimate"): "WP90",
    ("POST", "/api/admin/evaluation/runs"): "WP90",
    ("GET", "/api/admin/evaluation/runs"): "WP90",
    ("GET", "/api/admin/evaluation/runs/1"): "WP90",
    ("POST", "/api/admin/evaluation/runs/1/abort"): "WP90",
    ("GET", "/api/admin/evaluation/runs/1/answers?case_id=doc1-primar-koeniz&point=0"): "WP90",
    ("GET", "/api/admin/evaluation/runs/1/export"): "WP90",
    ("POST", "/api/admin/evaluation/comparison"): "WP90",
    ("GET", "/api/admin/evaluation/profile-summary?account=admin"): "WP94",
}
"""Every route of section 6 with the WP that builds it. A WP that lands moves
its routes out of the 501 check into its own tests."""

BUILT: set[tuple[str, str]] = set()

POINT = {"connection_id": 1, "level_id": 1}
CASE = {"id": "eigene-1", "prompt": "Schulen in Köniz", "tags": ["in"], "split": "confirm"}
BODIES: dict[str, Any] = {
    "/api/admin/evaluation/cases": {**CASE, "expect": "clarification"},
    "/api/admin/evaluation/cases/doc1-primar-koeniz": {**CASE, "expect": "clarification"},
    "/api/admin/evaluation/cases/import": {"cases": []},
    "/api/admin/evaluation/runs/estimate": {"points": [POINT]},
    "/api/admin/evaluation/runs": {"points": [POINT]},
    "/api/admin/evaluation/comparison": {"run": 1, "against": 2},
}


def _start(split: str) -> CaseFile:
    return CaseFile.model_validate_json(START[split].read_text("utf-8"))


def _readings(case: EvalCase) -> list[dict[str, Any]]:
    return case.gold_any or ([case.gold] if case.gold else [])


# --- the start set (D2) --------------------------------------------------------


@pytest.mark.parametrize("split", ["tuning", "confirm"])
def test_the_start_set_survives_a_round_trip_unchanged(split: str) -> None:
    """F-3.13: export and import change nothing; unset fields stay out."""
    text = START[split].read_text("utf-8")
    again = json.dumps(
        json.loads(_start(split).model_dump_json(exclude_unset=True)), ensure_ascii=False, indent=2
    )
    assert again + "\n" == text


@pytest.mark.parametrize("split", ["tuning", "confirm"])
def test_start_cases_are_sample_start_cases_of_their_split(split: str) -> None:
    for case in _start(split).cases:
        assert (case.split, case.data_state, case.origin) == (split, "sample", "start"), case.id


def test_start_case_ids_are_unique_over_both_splits() -> None:
    ids = [c.id for split in START for c in _start(split).cases]
    assert len(ids) == len(set(ids)) == 71


def test_every_reference_of_the_start_set_is_a_query_object() -> None:
    for split in START:
        for case in _start(split).cases:
            for gold in _readings(case):
                QueryObject.model_validate(
                    {"schema_version": case.schema_version, "output": "map", **gold}
                )


def test_the_committed_case_file_schema_is_current() -> None:
    """``make gen`` writes it; a change of the format without it fails here."""
    committed = json.loads((CASES / "case-file-v1.schema.json").read_text("utf-8"))
    assert committed == case_file_schema()


# --- the case rules (D2) -------------------------------------------------------


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"expect": "clarification", "gold": {"source": "schulen"}},
        {"gold_any": [{"source": "schulen"}]},
    ],
)
def test_a_case_has_exactly_one_answer(extra: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, **extra})


def test_a_log_case_names_its_action_and_only_it_does() -> None:
    log = {**CASE, "expect": "query", "origin": "log"}
    with pytest.raises(ValidationError):
        EvalCase.model_validate(log)
    assert EvalCase.model_validate({**log, "origin_action": 7}).origin_action == 7
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, "expect": "query", "origin_action": 7})


def test_a_live_query_case_names_its_layers() -> None:
    live = {**CASE, "data_state": "live", "gold": {"source": "schulen"}}
    with pytest.raises(ValidationError):
        EvalCase.model_validate(live)
    EvalCase.model_validate({**live, "layers": [{"name": "schulen", "dataset_version": "a1"}]})


def test_a_case_file_has_no_repeated_ids() -> None:
    case = {**CASE, "expect": "clarification"}
    with pytest.raises(ValidationError):
        CaseFile.model_validate({"cases": [case, case]})


def test_a_run_compares_with_one_of_its_points() -> None:
    with pytest.raises(ValidationError):
        RunRequest.model_validate({"points": [POINT], "reference": 1})
    with pytest.raises(ValidationError):
        RunRequest.model_validate({"points": []})


# --- codes ---------------------------------------------------------------------


def test_every_evaluation_code_is_registered_and_pending() -> None:
    assert set(get_args(EvalErrorCode)) <= set(CODES)
    assert set(PENDING_CODES) <= set(get_args(EvalErrorCode))


def test_pending_codes_are_declared_but_not_yet_raised() -> None:
    """A WP that raises one of these removes it from ``PENDING_CODES``."""
    sources = {
        p: p.read_text(encoding="utf-8")
        for p in SOURCE.rglob("*.py")
        if p.name not in ("codes.py", "schemas.py")
    }
    for code in PENDING_CODES:
        users = [p.name for p, text in sources.items() if f'"{code}"' in text]
        assert users == [], f"{code} is raised in {users}: drop it from PENDING_CODES"


# --- the routes ----------------------------------------------------------------


def _template(path: str) -> str:
    path = path.split("?")[0]
    for value, name in (
        ("/runs/1", "/runs/{run_id}"),
        ("/draft-from-action/1", "/draft-from-action/{action_id}"),
        ("/cases/doc1-primar-koeniz", "/cases/{case_id}"),
    ):
        path = path.replace(value, name)
    return path


def test_every_route_of_the_contract_is_described(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    for method, path in ROUTES:
        assert method.lower() in paths[_template(path)], (method, path)
    assert "202" in paths["/api/admin/evaluation/runs"]["post"]["responses"]
    described = {
        (m.upper(), p)
        for p, ms in paths.items()
        if p.startswith("/api/admin/evaluation")
        for m in ms
    }
    assert described == {(m, _template(p)) for m, p in ROUTES}


def test_no_view_of_the_evaluation_can_carry_rows(app: FastAPI) -> None:
    """D8, F-9.3: answers carry feature ids, never rows or geometries."""
    for path, methods in app.openapi()["paths"].items():
        if path.startswith("/api/admin/evaluation"):
            for spec in methods.values():
                text = json.dumps(spec)
                assert "ExecuteResponse" not in text and "QueryResult" not in text, path


async def _call(client: httpx.AsyncClient, method: str, path: str) -> httpx.Response:
    return await client.request(method, path, json=BODIES.get(path.split("?")[0]))


@pytest.mark.parametrize(("method", "path"), list(ROUTES))
async def test_every_route_needs_a_session(
    anonymous: httpx.AsyncClient, method: str, path: str
) -> None:
    assert (await _call(anonymous, method, path)).status_code == 401


async def test_every_route_is_for_administrators(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    for method, path in ROUTES:
        assert (await _call(client, method, path)).status_code == 403, (method, path)


async def test_routes_not_built_answer_501_naming_their_wp(client: httpx.AsyncClient) -> None:
    for (method, path), wp in ROUTES.items():
        if (method, path) in BUILT:
            continue
        response = await _call(client, method, path)
        assert response.status_code == 501, (method, path, response.text)
        assert response.json()["details"] == {"wp": wp}, (method, path)


async def test_ids_beyond_64_bits_are_refused_before_the_route(client: httpx.AsyncClient) -> None:
    for path in ("/api/admin/evaluation/runs/9223372036854775808", "/api/admin/evaluation/runs/0"):
        assert (await client.get(path)).status_code == 422, path
