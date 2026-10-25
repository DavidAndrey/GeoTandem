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
from pydantic import BaseModel, ValidationError

from geotandem.codes import CODES
from geotandem.evaluation.schemas import (
    CaseDraft,
    CaseFile,
    ConditionOp,
    EvalCase,
    EvalErrorCode,
    RunRequest,
    case_file_schema,
)
from geotandem_query import QueryObject, models

REPO = Path(__file__).resolve().parents[2]
CASES = REPO / "schema" / "eval-cases"
START = {"tuning": CASES / "start-tuning.json", "confirm": CASES / "start-confirm.json"}
SOURCE = REPO / "backend" / "src" / "geotandem"

PENDING_CODES: dict[str, str] = {
    "no_cases": "WP90",
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

BUILT: set[tuple[str, str]] = {
    route for route, wp in ROUTES.items() if wp in ("WP87", "WP92", "WP94")
}
"""Routes whose WP has landed; their behaviour is tested in the WP's own tests
(WP87: ``test_eval_cases.py``, WP92: ``test_eval_from_log.py``, WP94:
``test_eval_summary.py``)."""

POINT = {"connection_id": 1, "level_id": 1}
CASE = {
    "id": "eigene-1",
    "prompt": "Schulen in Köniz",
    "tags": ["in"],
    "split": "confirm",
    "origin": "authored",
}
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


# --- the start set (D2) --------------------------------------------------------


@pytest.mark.parametrize("split", ["tuning", "confirm"])
def test_the_start_set_survives_a_round_trip_unchanged(split: str) -> None:
    """F-3.13: export and import change nothing (as JSON: same keys and values;
    the key order is the model's); unset fields stay out."""
    text = START[split].read_text("utf-8")
    again = json.loads(_start(split).model_dump_json(exclude_unset=True))
    assert again == json.loads(text)


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
            for gold in case.readings():
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
        {"expect": "clarification", "require": {"source": "schulen", "conditions": [{}]}},
    ],
)
def test_a_case_has_exactly_one_answer(extra: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, **extra})


def test_the_readings_of_a_case_are_its_gold_or_its_fair_readings() -> None:
    """D1: one ``readings()``; an empty reference is a reference too (``is not None``)."""
    cases = {c.id: c for split in START for c in _start(split).cases}
    assert len(cases["doc1-primar-koeniz"].readings()) == 2
    assert cases["n01-tram-zaehlen"].readings() == [cases["n01-tram-zaehlen"].gold]
    assert cases["n15-je-gemeinde"].readings() == []
    whole = EvalCase.model_validate({**CASE, "gold": {}})
    assert whole.readings() == [{}]
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, "gold": {}, "expect": "clarification"})


@pytest.mark.parametrize(
    "extra",
    [
        {"expect": "clarification", "also": ["clarification"]},
        {"expect": "clarification", "also": ["cannot_answer", "cannot_answer"]},
        {"gold": {"source": "schulen"}, "also": ["query"]},
        {"expect": "clarification", "forbid": [""]},
        {"expect": "clarification", "also": ["query", "cannot_answer", "clarification"]},
    ],
    ids=["expect-again", "repeat", "query-of-a-query-case", "empty-word", "too-many"],
)
def test_also_and_forbid_say_something(extra: dict[str, Any]) -> None:
    """B2: ``also`` neither repeats a kind nor the expected one, nor lets any
    query pass a query case; a forbidden word is not empty."""
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, **extra})


def test_a_behaviour_case_may_let_a_query_pass() -> None:
    """``h35-injection-sql``: a harmless query passes beside ``cannot_answer``."""
    case = EvalCase.model_validate({**CASE, "expect": "cannot_answer", "also": ["query"]})
    assert case.also == ["query"]


@pytest.mark.parametrize(
    "extra",
    [
        {"note": "x" * 2001},
        {"forbid": ["x" * 65]},
        {"forbid": [f"w{n}" for n in range(17)]},
        {"data_state": "live", "layers": [{"name": f"l{n}"} for n in range(33)]},
        {"data_state": "live", "layers": [{"name": "x" * 64}]},
        {"data_state": "live", "layers": [{"name": "schulen", "dataset_version": "v" * 65}]},
    ],
    ids=["note", "word", "words", "layers", "layer-name", "dataset-version"],
)
def test_the_fields_of_a_case_are_bounded(extra: dict[str, Any]) -> None:
    """S1: no field of a case grows without bound."""
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, "expect": "clarification", **extra})


def test_the_about_of_a_case_file_is_bounded() -> None:
    with pytest.raises(ValidationError):
        CaseFile.model_validate({"about": "x" * 4001, "cases": []})
    assert all(len(_start(split).about) <= 4000 for split in START)


def test_a_required_condition_names_an_operator_of_the_query_schema() -> None:
    """``ConditionOp`` is the ops of ``geotandem_query``'s conditions, no more, no less."""
    ops = {
        member.model_fields["op"].annotation.__args__[0]
        for member in models.__dict__.values()
        if isinstance(member, type)
        and issubclass(member, BaseModel)
        and member.__module__ == models.__name__
        and "op" in member.model_fields
    }
    assert set(get_args(ConditionOp)) == ops


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


def test_a_case_means_the_same_after_a_view_dumped_it_with_nulls() -> None:
    """Review WP85 #1: a view writes every field, ``null`` included; a GET followed
    by a PUT must not change what the case demands."""
    for split in START:
        for case in _start(split).cases:
            assert EvalCase.model_validate(case.model_dump(mode="json")) == case, case.id
            again = json.loads(case.model_dump_json(exclude_none=True))
            assert EvalCase.model_validate(again) == case, case.id


def test_no_offer_of_the_other_approach_is_explicit() -> None:
    """``none`` demands no offer; an unset field checks nothing (D2)."""
    cases = {c.id: c for split in START for c in _start(split).cases}
    assert cases["n15-je-gemeinde"].other_approach == "none"
    assert "other_approach" not in cases["doc1-primar-koeniz"].model_fields_set


def test_start_cases_run_on_the_sample_data_only() -> None:
    with pytest.raises(ValidationError):
        EvalCase.model_validate(
            {**CASE, "origin": "start", "data_state": "live", "expect": "clarification"}
        )


@pytest.mark.parametrize("word", ["export", "import", "draft-from-action"])
def test_route_words_are_no_case_ids(word: str) -> None:
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**CASE, "id": word, "expect": "clarification"})


def test_a_draft_needs_no_id_and_no_tags_and_defaults_to_confirmation() -> None:
    draft = CaseDraft.model_validate(
        {"prompt": "Schulen in Köniz", "origin": "log", "origin_action": 3, "gold": {}}
    )
    assert draft.split == "confirm"
    assert "id" not in CaseDraft.model_fields and "tags" not in CaseDraft.model_fields


def test_ids_in_bodies_are_bounded() -> None:
    """E2 review #38: an id beyond 64 bits would reach SQLite as a 500."""
    with pytest.raises(ValidationError):
        RunRequest.model_validate({"points": [{"connection_id": 2**63, "level_id": 1}]})
    with pytest.raises(ValidationError):
        EvalCase.model_validate(
            {**CASE, "origin": "log", "origin_action": 2**63, "expect": "query"}
        )


def test_live_runs_do_not_take_the_start_set() -> None:
    with pytest.raises(ValidationError):
        RunRequest.model_validate({"points": [POINT], "data_state": "live"})
    RunRequest.model_validate(
        {"points": [POINT], "data_state": "live", "cases": {"origins": ["authored", "log"]}}
    )


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


ROW_LIKE = {"rows", "features", "geometry", "coordinates", "properties", "values", "sample"}
"""Property names that would carry data contents (F-9.3)."""


def _reachable(schema: Any, components: dict[str, Any], seen: set[str]) -> None:
    if isinstance(schema, dict):
        ref = schema.get("$ref")
        if isinstance(ref, str):
            name = ref.rsplit("/", 1)[-1]
            if name not in seen:
                seen.add(name)
                _reachable(components[name], components, seen)
        for value in schema.values():
            _reachable(value, components, seen)
    elif isinstance(schema, list):
        for value in schema:
            _reachable(value, components, seen)


def test_no_view_of_the_evaluation_can_carry_rows(app: FastAPI) -> None:
    """D8, F-9.3: answers carry feature ids, never rows or geometries. Walks every
    schema the evaluation routes reach and fails on a row-like property."""
    spec = app.openapi()
    components = spec["components"]["schemas"]
    seen: set[str] = set()
    for path, methods in spec["paths"].items():
        if path.startswith("/api/admin/evaluation"):
            _reachable(methods, components, seen)
    assert not seen & {"ExecuteResponse", "QueryResult", "FeatureRef"}
    for name in seen:
        props = set(components[name].get("properties", {}))
        assert not props & ROW_LIKE, (name, props & ROW_LIKE)


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
    big = 2**63
    for path in (
        f"/api/admin/evaluation/runs/{big}",
        "/api/admin/evaluation/runs/0",
        f"/api/admin/evaluation/cases/draft-from-action/{big}",
        f"/api/admin/evaluation/runs?connection_id={big}",
        "/api/admin/evaluation/runs/1/answers?case_id=doc1-primar-koeniz&point=8",
    ):
        assert (await client.get(path)).status_code == 422, path
    body = {"points": [{"connection_id": big, "level_id": 1}]}
    assert (await client.post("/api/admin/evaluation/runs", json=body)).status_code == 422
