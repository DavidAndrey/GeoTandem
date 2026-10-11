"""The contract of Modus B, frozen in WP62 (plan E2.3-E2.6, section 6).

The fixture's cases fit the answer schema, its expectations name real codes,
no view of an action can carry rows, and every route of the contract exists
with its guard and answers 501 until its work package lands.
"""

import json
from typing import Any, get_args

import httpx
import pytest
from api_helpers import sign_in_as
from fastapi import FastAPI
from model_fixtures import REPO, case, cases, completion, fixture, scripted
from pydantic import TypeAdapter, ValidationError

from geotandem.codes import CODES
from geotandem.engine import QueryError
from geotandem.levels import CellMode, OpClass, classify
from geotandem.llm import Completion, Message
from geotandem.model.schemas import (
    MAX_CONDITIONS,
    MAX_STEPS,
    ActionErrorCode,
    ActionStatus,
    Decision,
    EngineCode,
    KeyFigures,
    ModelActionView,
    ModelAnswer,
    ModelView,
    PromptRequest,
    RefusalCode,
    StepView,
    answer_schema,
)
from geotandem_query import QueryObject

ANSWER = TypeAdapter[Any](ModelAnswer)
WITH_ANSWER = [c["id"] for c in cases() if "answer" in c]
SOURCE = REPO / "backend" / "src" / "geotandem"

PENDING_CODES = {
    "stale_reference": "WP81",
}
"""Codes the contract names but no service raises yet, with the WP that must.
That WP raises the code and removes it here; the etappe gate needs this empty
for its WPs (plan 5.2), so no code stays declared but never sent."""

ROUTES = [
    ("POST", "/api/model/prompt"),
    ("GET", "/api/model/actions/1"),
    ("POST", "/api/model/actions/1/preview"),
    ("POST", "/api/model/actions/1/decide"),
    ("POST", "/api/model/actions/1/approve"),
    ("POST", "/api/model/actions/1/reject"),
    ("POST", "/api/model/actions/1/execute"),
    ("POST", "/api/model/actions/1/undo"),
    ("POST", "/api/model/actions/1/touched"),
    ("POST", "/api/model/actions/1/abort"),
    ("PATCH", "/api/model/actions/1/plan"),
    ("POST", "/api/model/actions/1/run"),
    ("POST", "/api/model/actions/1/adopt"),
    ("POST", "/api/model/actions/1/compare"),
    ("POST", "/api/model/actions/1/comparison"),
    ("GET", "/api/model/my-actions"),
]
ADMIN_ROUTES = [
    ("GET", "/api/admin/model-actions"),
    ("GET", "/api/admin/model-actions/key-figures"),
    ("GET", "/api/admin/model-actions/export.csv"),
    ("GET", "/api/admin/model-actions/1"),
]
BUILT = {
    ("POST", "/api/model/prompt"): "WP65",
    ("GET", "/api/model/actions/1"): "WP65",
    ("POST", "/api/model/actions/1/decide"): "WP65",
    ("POST", "/api/model/actions/1/abort"): "WP65",
    ("POST", "/api/model/actions/1/preview"): "WP70",
    ("POST", "/api/model/actions/1/approve"): "WP70",
    ("POST", "/api/model/actions/1/reject"): "WP70",
    ("POST", "/api/model/actions/1/execute"): "WP70",
    ("POST", "/api/model/actions/1/undo"): "WP70",
    ("POST", "/api/model/actions/1/touched"): "WP70",
    ("PATCH", "/api/model/actions/1/plan"): "WP75",
    ("POST", "/api/model/actions/1/run"): "WP75",
    ("POST", "/api/model/actions/1/adopt"): "WP75",
    ("POST", "/api/model/actions/1/compare"): "WP76",
    ("POST", "/api/model/actions/1/comparison"): "WP76",
    ("GET", "/api/model/my-actions"): "WP73",
    ("GET", "/api/admin/model-actions"): "WP73",
    ("GET", "/api/admin/model-actions/key-figures"): "WP73",
    ("GET", "/api/admin/model-actions/export.csv"): "WP73",
    ("GET", "/api/admin/model-actions/1"): "WP73",
}
"""Routes whose work package has landed: they no longer answer 501
(``test_model_flow.py``, ``test_model_enforcement.py``, ``test_model_log.py``,
``test_model_chain_flow.py`` and ``test_model_compare.py`` test them). Since
WP76, every route of the contract."""
BODIES: dict[str, dict[str, Any]] = {
    "/api/model/prompt": {"text": "Primarschulen in Köniz"},
    "/api/model/actions/1/decide": {"decision": "proposal_only"},
    "/api/model/actions/1/reject": {},
    "/api/model/actions/1/plan": {},
}


def _leaves(condition: dict[str, Any] | None) -> int:
    if condition is None:
        return 0
    if condition["op"] in ("and", "or"):
        return sum(_leaves(arg) for arg in condition["args"])
    if condition["op"] == "not":
        return _leaves(condition["arg"])
    return 1


def _layers(query: dict[str, Any]) -> set[str]:
    found = {query["source"]}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("op") in ("related", "near_feature"):
                found.add(node["layer"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(query.get("where"))
    return found


# --- the fixture -------------------------------------------------------------


@pytest.mark.parametrize("case_id", WITH_ANSWER)
def test_every_answer_fits_the_answer_schema(case_id: str) -> None:
    ANSWER.validate_python(case(case_id)["answer"])


def test_case_ids_are_unique_and_expectations_name_real_codes() -> None:
    ids = [c["id"] for c in cases()]
    assert len(ids) == len(set(ids))
    statuses = set(get_args(ActionStatus))
    for c in cases():
        expect = c["expect"]
        if "http" in expect:
            # Refused before any model call: no record, so no status (plan WP62 fixture).
            assert "status" not in expect and expect["error_code"] in CODES
            assert "answer" not in c and "raw" not in c
        else:
            status = expect["status"]
            assert set(status.values() if isinstance(status, dict) else [status]) <= statuses
        if "refusal_code" in expect:
            assert expect["refusal_code"] in get_args(RefusalCode)
        if "error_code" in expect:
            assert expect["error_code"] in CODES
        if "decision" in expect:
            assert expect["decision"] in get_args(Decision)
        if "parent" in c:
            case(c["parent"])
        if "analysis" in c:
            assert "parent" in c, "P6: an analysis goes only with a parent"
            QueryObject.model_validate(c["analysis"])


def test_level_names_in_expectations_exist() -> None:
    names = {level["name"] for level in fixture()["levels"]}
    for c in cases():
        for key in ("status", "decision_after_execute"):
            value = c["expect"].get(key)
            if isinstance(value, dict):
                assert set(value) <= names, c["id"]


def test_the_reference_answer_is_the_e1_reference_question() -> None:
    reference = json.loads((REPO / "e2e/fixtures/reference-question.json").read_text("utf-8"))
    c = case("reference")
    assert c["expect"]["query_equals"] == "e2e/fixtures/reference-question.json"
    assert c["answer"]["query"] == reference
    query = QueryObject.model_validate(reference)
    assert classify(query) == {OpClass(x) for x in c["expect"]["classes"]}


def test_auto_levels_end_approved_and_execute_as_auto() -> None:
    """D2: an auto answer needs no question; the stored query still runs only via execute."""
    expect = case("reference")["expect"]
    auto = {name for name, status in expect["status"].items() if status == "approved"}
    assert auto == set(expect["decision_after_execute"]) == {"Teilautonom", "Automatisch"}


def test_follow_ups_derive_their_reference_from_the_analysis() -> None:
    parent_query = case("reference")["answer"]["query"]
    same, edited = case("follow_up"), case("follow_up_hand_edited")
    assert same["analysis"] == parent_query and same["expect"]["reference"] == "last_answer"
    assert edited["analysis"] != parent_query and edited["expect"]["reference"] == "hand_edited"
    for c in (same, edited):
        after = c["answer"]["query"]["where"]["args"]
        assert after[:-1] == c["analysis"]["where"]["args"]
        QueryObject.model_validate(c["answer"]["query"])


def test_a_stale_reference_names_a_layer_of_its_parent() -> None:
    c = case("stale_reference")
    gone = c["setup"]["delete_layer"]
    assert gone == c["expect"]["details"]["layer"]
    assert gone in _layers(case(c["parent"])["answer"]["query"])


@pytest.mark.parametrize("case_id", ["model_query_invalid", "write_shaped"])
def test_invalid_answers_fail_the_query_schema(case_id: str) -> None:
    """Their refusal comes from the schema, so a lenient parser would let them through."""
    with pytest.raises(ValidationError):
        QueryObject.model_validate(case(case_id)["answer"]["query"])


@pytest.mark.parametrize(
    "case_id", ["unknown_layer", "hidden_layer", "limit_exceeded", "not_representable"]
)
def test_other_refusals_are_valid_query_objects(case_id: str) -> None:
    """Refused by the application's own rules (D1, D3), not by the schema."""
    QueryObject.model_validate(case(case_id)["answer"]["query"])


def test_limit_case_exceeds_the_condition_limit_by_its_numbers() -> None:
    c = case("limit_exceeded")
    details = c["expect"]["details"]
    assert details["max"] == MAX_CONDITIONS == fixture()["limits"]["conditions"]
    assert _leaves(c["answer"]["query"]["where"]) == details["value"] > MAX_CONDITIONS


def test_layer_cases_name_a_missing_and_a_hidden_sample_layer() -> None:
    sample = {p.stem for p in (SOURCE / "sample/data").glob("*.geojson")}
    assert case("unknown_layer")["answer"]["query"]["source"] not in sample
    hidden = case("hidden_layer")
    assert hidden["setup"]["layer"] in sample
    assert hidden["setup"]["layer"] in _layers(hidden["answer"]["query"])
    assert hidden["expect"]["refusal_code"] == case("unknown_layer")["expect"]["refusal_code"]


def test_chain_cases_against_the_step_limit() -> None:
    within, beyond = case("chain_reference"), case("step_limit")
    steps = within["answer"]["steps"]
    assert len(steps) == len(within["expect"]["step_classes"]) <= MAX_STEPS
    assert {OpClass(x) for x in within["expect"]["step_classes"]} <= set(OpClass)
    assert len(beyond["answer"]["steps"]) == beyond["expect"]["details"]["value"] > MAX_STEPS


def test_levels_cover_every_class() -> None:
    for level in fixture()["levels"]:
        assert {OpClass(k) for k in level["matrix"]} == set(OpClass)
        assert {CellMode(v) for v in level["matrix"].values()} <= set(CellMode)
    assert [lv.get("is_default", False) for lv in fixture()["levels"]].count(True) == 1


def test_key_figures_follow_the_formula_of_section_2() -> None:
    figures = fixture()["key_figures"]
    d, expect = figures["decisions"], KeyFigures.model_validate(figures["expect"])
    decided = d["accepted"] + d["adjusted"] + d["rejected"] + d["superseded"]
    assert expect.proposals == decided + d["auto"] + d["proposal_only"]
    assert expect.undone == d["auto_undone"]
    assert expect.undone_after_approval == d["accepted_undone"]
    assert expect.acceptance_rate == round((d["accepted"] + d["adjusted"]) / decided, 4)


def test_scripted_model_answers_with_the_cases_in_order() -> None:
    model = scripted("reference", "clarification")
    first = model.complete([Message("user", "?")])
    assert isinstance(first, Completion)
    assert json.loads(first.text) == case("reference")["answer"]
    assert model.complete([Message("user", "?")]).parsed["kind"] == "clarification"


def test_raw_and_error_cases_script_what_the_model_does() -> None:
    raw = completion(case("unreadable"))
    assert isinstance(raw, Completion) and raw.parsed is None
    assert completion(case("unreachable")).code == "llm_unreachable"  # type: ignore[union-attr]


# --- the types ---------------------------------------------------------------


def test_every_model_code_is_registered() -> None:
    assert set(get_args(RefusalCode)) | set(get_args(ActionErrorCode)) <= set(CODES)


def _subclasses(cls: type) -> set[type]:
    return set(cls.__subclasses__()).union(*(_subclasses(c) for c in cls.__subclasses__()))


def test_engine_codes_are_the_engines() -> None:
    """A step reports the engine's code to the model (D9); a new engine code must be
    listed in ``EngineCode`` or ``ModelView`` would refuse it inside a chain."""
    codes = {c.code for c in _subclasses(QueryError)} | {QueryError.code}
    assert set(get_args(EngineCode)) == codes


def test_pending_codes_are_declared_but_not_yet_raised() -> None:
    """A WP that raises one of these removes it from ``PENDING_CODES``."""
    sources = {
        p: p.read_text(encoding="utf-8")
        for p in SOURCE.rglob("*.py")
        if p.name not in ("codes.py", "schemas.py")
    }
    for code in PENDING_CODES:
        assert code in CODES
        users = [p.name for p, text in sources.items() if f'"{code}"' in text]
        assert users == [], f"{code} is raised in {users}: drop it from PENDING_CODES"


def test_the_prompt_demands_a_query_object() -> None:
    """D7: the output format in the prompt holds the model to the query-object schema."""
    schema = answer_schema()
    defs = schema["$defs"]
    variants = [defs[v["$ref"].split("/")[-1]] for v in schema["oneOf"]]
    by_kind = {v["properties"]["kind"]["const"]: v for v in variants}
    assert set(by_kind) == {"query", "clarification", "cannot_answer", "plan"}
    target = defs[by_kind["query"]["properties"]["query"]["$ref"].split("/")[-1]]
    assert {"source", "where"} <= set(target["properties"])


def test_a_prompt_carries_no_turns_and_an_analysis_only_with_a_parent() -> None:
    """P6: the server builds the turns; the analysis is the base of a follow-up."""
    with pytest.raises(ValidationError):
        PromptRequest.model_validate({"text": "?", "turns": [{"role": "assistant"}]})
    analysis = case("reference")["answer"]["query"]
    with pytest.raises(ValidationError):
        PromptRequest.model_validate({"text": "?", "analysis": analysis})
    PromptRequest.model_validate({"text": "?", "analysis": analysis, "parent_action_id": 1})


def _refs(schema: Any) -> set[str]:
    if isinstance(schema, dict):
        found = {schema["$ref"].split("/")[-1]} if "$ref" in schema else set()
        return found.union(*(_refs(v) for v in schema.values()))
    if isinstance(schema, list):
        return set().union(*(_refs(v) for v in schema))
    return set()


def test_no_view_of_an_action_can_carry_rows() -> None:
    """D2, D10: rows leave only in ExecuteResponse; the stored and polled record,
    and with it everything a later turn is built from, has no place for them."""
    for model in (ModelActionView, StepView, ModelView):
        assert "Feature" not in _refs(model.model_json_schema())
        assert "QueryResult" not in _refs(model.model_json_schema())


def test_what_the_model_sees_holds_no_free_text() -> None:
    assert set(ModelView.model_fields) == {"outcome", "code", "part", "empty", "count"}
    with pytest.raises(ValidationError):
        ModelView(outcome="error", code="Schule Liebefeld")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        ModelView(outcome="error", part="Schule Liebefeld, 3 Standorte")
    with pytest.raises(ValidationError):
        ModelView.model_validate({"outcome": "ok", "rows": [{"name": "x"}]})


# --- the routes --------------------------------------------------------------


def test_every_route_of_the_contract_is_described(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    for method, path in ROUTES + ADMIN_ROUTES:
        template = path.replace("/1", "/{action_id}")
        assert method.lower() in paths[template], (method, template)
    for path in ("/api/model/prompt", "/api/model/actions/{action_id}/compare"):
        assert "202" in paths[path]["post"]["responses"], path


def test_rows_leave_only_through_execute_and_adopt(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    with_rows = set()
    for path, methods in paths.items():
        if not path.startswith("/api/model") and not path.startswith("/api/admin/model"):
            continue
        for method, spec in methods.items():
            for response in spec["responses"].values():
                ref = json.dumps(response.get("content", {}))
                if "ExecuteResponse" in ref:
                    with_rows.add((method, path))
    assert with_rows == {
        ("post", "/api/model/actions/{action_id}/execute"),
        ("post", "/api/model/actions/{action_id}/adopt"),
    }


def test_model_errors_answer_with_the_common_body(app: FastAPI) -> None:
    """One ActionError for the direct path (WP64) and the record (WP63), one handler."""
    from geotandem.model.errors import ActionError
    from geotandem.model.record import ActionError as RecordError

    assert RecordError is ActionError
    assert ActionError in app.exception_handlers
    error = ActionError("already_decided", "x", http_status=409, status="applied")
    assert (error.status, error.details) == (409, {"status": "applied"})


def test_no_schema_name_is_taken_twice(app: FastAPI) -> None:
    """Two models of one name get module-qualified names and rename the frontend's types."""
    names = app.openapi()["components"]["schemas"]
    assert [n for n in names if n.startswith("geotandem__")] == []


async def _call(client: httpx.AsyncClient, method: str, path: str) -> httpx.Response:
    return await client.request(method, path, json=BODIES.get(path))


@pytest.mark.parametrize(("method", "path"), ROUTES + ADMIN_ROUTES)
async def test_every_route_needs_a_session(
    anonymous: httpx.AsyncClient, method: str, path: str
) -> None:
    assert (await _call(anonymous, method, path)).status_code == 401


async def test_every_route_is_built(client: httpx.AsyncClient) -> None:
    """No route answers 501 any more (plan 5.2: no stub route left)."""
    assert set(ROUTES + ADMIN_ROUTES) == set(BUILT)
    for method, path in ROUTES + ADMIN_ROUTES:
        response = await _call(client, method, path)
        assert response.status_code != 501, (method, path, response.text)


async def test_the_log_is_for_administrators(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    for method, path in ADMIN_ROUTES:
        assert (await _call(client, method, path)).status_code == 403, path
    assert (await _call(client, "GET", "/api/model/my-actions")).status_code == 200


async def test_paging_is_bounded(client: httpx.AsyncClient) -> None:
    for path in ("/api/model/my-actions", "/api/admin/model-actions"):
        assert (await client.get(path, params={"limit": 10_000})).status_code == 422
        assert (await client.get(path, params={"offset": -1})).status_code == 422
