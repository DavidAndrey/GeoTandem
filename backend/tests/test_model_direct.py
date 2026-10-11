"""The direct query core (plan E2.3-E2.6, WP64): prompt, answer, validation,
representability, against the contract fixture and the real sample data."""

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from model_fixtures import REPO, case, cases, fixture, scripted
from pydantic import TypeAdapter
from test_profile import SENTINELS, sentinel_csv

from geotandem.auth.accounts import Account
from geotandem.auth.visibility import set_visible, view_for
from geotandem.catalog import (
    AttributeUpdate,
    LayerUpdate,
    ModelProfile,
    model_profile,
    update_attribute,
    update_layer,
)
from geotandem.config import Settings
from geotandem.data import DataBackend, Limits
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.engine import count_query, run_query
from geotandem.importing.run import (
    FieldDecision,
    ImportDecisions,
    KeyReference,
    XYReference,
    run_import,
)
from geotandem.levels import CellMode, Level, OpClass, classify
from geotandem.llm import Completion, LLMError
from geotandem.llm.fake import FakeLLMClient
from geotandem.model.direct import DirectAnswer, DirectQuery, direct_prompt
from geotandem.model.errors import ActionError
from geotandem.model.prompt import ANSWER_TOKENS, FollowUp, Turn, build_prompt, estimate_tokens
from geotandem.model.represent import (
    LayerShape,
    NotRepresentable,
    QueryPart,
    count_conditions,
    to_analysis,
    to_query,
)
from geotandem.model.result import answer_format, format_text, parse_answer
from geotandem.model.schemas import (
    MAX_CONDITION_PATH,
    MAX_LISTED,
    MAX_TURNS,
    ModelAnswer,
    QueryAnswer,
    Refusal,
)
from geotandem.model.validate import Validated, validate_model_query
from geotandem.sample import DATA_DIR
from geotandem.sample.load import load_sample
from geotandem.tools import ToolContext
from geotandem_query import QueryObject, canonical_json

LIMITS = Limits(max_features=10_000, timeout_s=10)
AREAS = "gemeinden_steuern"
REFERENCE = json.loads((REPO / "e2e/fixtures/reference-question.json").read_text("utf-8"))
REPRESENT = json.loads((REPO / "schema/model-cases/represent.json").read_text("utf-8"))
CATALOG = {name: LayerShape.model_validate(s) for name, s in REPRESENT["catalog"].items()}
ANSWER = TypeAdapter[Any](ModelAnswer)
SYSTEM_PROMPT = "Du bist der Analyseassistent von GeoTandem. Erfinde keine Layer."


def level(name: str) -> Level:
    found = next(lv for lv in fixture()["levels"] if lv["name"] == name)
    return Level(
        name=name,
        matrix=found["matrix"],
        system_prompt=f"{SYSTEM_PROMPT} Stufe {name}.",
        selectable=found["selectable"],
        is_default=found.get("is_default", False),
    )


LEVELS = ["Assistenz", "Prüfen", "Teilautonom", "Automatisch"]
CHECK = level("Prüfen")


def account(role: str) -> Account:
    now = datetime.now(UTC)
    return Account(
        id=1,
        username=f"a.{role}",
        display_name=role,
        role=role,
        status="active",
        must_change_password=False,
        created_at=now,
        last_login_at=None,
    )


def with_sample(directory: Path) -> DataBackend:
    settings = Settings(data_dir=directory)
    backend = SpatiaLiteBackend(bootstrap(settings), settings.internal_crs)
    load_sample(backend)
    # The tax rate lives in a table, keyed onto the municipalities (e2e ensureAreaLayer).
    run = run_import(
        DATA_DIR / "gemeindedaten.csv",
        "gemeindedaten.csv",
        ImportDecisions(
            layer_name=AREAS,
            title="Steuern je Gemeinde",
            geo=KeyReference(column="gem_nr", layer="gemeinden", attribute="gem_nr"),
            fields=[FieldDecision(source_name="steueranlage", label="Steueranlage")],
        ),
        backend,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run
    return backend


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> DataBackend:
    return with_sample(tmp_path_factory.mktemp("direct"))


def context_of(backend: DataBackend, role: str = "admin") -> ToolContext:
    view = view_for(backend, account(role))
    return ToolContext(view, LIMITS, frozenset(backend.missing_functions()))


def profile_of(backend: DataBackend, role: str = "admin") -> ModelProfile:
    """What WP65 does: the account's profile, over its view (S3)."""
    view = view_for(backend, account(role))
    return model_profile(backend.engine, view.layer_names())


def check(backend: DataBackend, raw: dict[str, Any], role: str = "admin") -> Validated | Refusal:
    return validate_model_query(raw, context_of(backend, role), profile_of(backend, role))


@pytest.fixture
def hidden(world: DataBackend) -> Iterator[str]:
    """The fixture's ``hidden_layer`` setup: a sample layer withdrawn from users."""
    setup = case("hidden_layer")["setup"]
    set_visible(world.engine, setup["layer"], setup["hide_from_role"], False)
    yield setup["layer"]
    set_visible(world.engine, setup["layer"], setup["hide_from_role"], True)


def ask(
    world: DataBackend,
    case_id: str,
    *,
    role: str = "admin",
    on: Level = CHECK,
    follow_up: FollowUp | None = None,
    context_length: int | None = None,
) -> tuple[DirectAnswer, FakeLLMClient]:
    model = scripted(case_id)
    direct = DirectQuery(model, context_of(world, role), on)
    prompt = case(case_id)["prompt"]
    profile = profile_of(world, role)
    return run_direct(direct, prompt, profile, follow_up, context_length), model


def run_direct(
    direct: DirectQuery,
    text: str,
    profile: ModelProfile,
    follow_up: FollowUp | None = None,
    context_length: int | None = None,
) -> DirectAnswer:
    """What the prompt flow does: build the prompt, then ask."""
    prompt = direct_prompt(
        text,
        level=direct.level,
        profile=profile,
        follow_up=follow_up,
        context_length=context_length,
    )
    return direct.ask(prompt, profile=profile)


def follow_up_of(c: dict[str, Any]) -> FollowUp | None:
    if "parent" not in c:
        return None
    parent = case(c["parent"])
    turn = Turn.of(parent["prompt"], QueryAnswer.model_validate(parent["answer"]))
    analysis = QueryObject.model_validate(c["analysis"]) if "analysis" in c else None
    reference = c["expect"].get("reference", "last_answer")
    return FollowUp(analysis=analysis, reference=reference, turns=[turn])


# --- every fixture case on the direct path ----------------------------------------

DIRECT = [c["id"] for c in cases() if c["approach"] == "direct" and ("answer" in c or "raw" in c)]


@pytest.mark.parametrize("case_id", DIRECT)
def test_every_direct_case_ends_as_the_fixture_says(
    world: DataBackend, case_id: str, request: pytest.FixtureRequest
) -> None:
    c = case(case_id)
    expect = c["expect"]
    role = c.get("account_role", "admin")
    if "hide_from_role" in c.get("setup", {}):
        request.getfixturevalue("hidden")
    if "error_code" in expect:
        with pytest.raises(ActionError) as caught:
            ask(world, case_id, role=role)
        assert caught.value.code == expect["error_code"]
        return
    result, model = ask(world, case_id, role=role, follow_up=follow_up_of(c))
    assert len(model.calls) == 1
    assert result.answer.kind == c["answer"]["kind"]
    if "refusal_code" in expect:
        assert result.refusal is not None and result.query is None
        assert result.refusal.code == expect["refusal_code"], result.refusal
        assert result.answer == ANSWER.validate_python(c["answer"])  # kept for the user (M3)
        if "details" in expect:
            details = {k: v for k, v in expect["details"].items() if not k.startswith("_")}
            assert result.refusal.details == details
    elif expect["status"] == "answered":
        assert result.answer.kind in ("clarification", "cannot_answer")
        assert (result.query, result.refusal, result.governance) == (None, None, None)
    else:
        assert result.refusal is None and result.query is not None
        assert result.query == QueryObject.model_validate(c["answer"]["query"])
        if "classes" in expect:
            assert classify(result.query) == {OpClass(x) for x in expect["classes"]}


def same_refusal(missing: Refusal | None, concealed: Refusal | None, gone: str, name: str) -> None:
    """Design M3.1: same code, same details, same words but for the name."""
    assert missing is not None and concealed is not None
    assert missing.code == concealed.code
    assert missing.details.keys() == concealed.details.keys()
    assert {k: v for k, v in missing.details.items() if v != gone} == {
        k: v for k, v in concealed.details.items() if v != name
    }
    assert missing.message.replace(gone, "?") == concealed.message.replace(name, "?")


def test_a_hidden_layer_is_refused_like_a_missing_one(world: DataBackend, hidden: str) -> None:
    missing, _ = ask(world, "unknown_layer", role="user")
    concealed, _ = ask(world, "hidden_layer", role="user")
    assert concealed.refusal is not None and concealed.refusal.code == "unknown_layer"
    assert hidden not in concealed.refusal.details["available"]
    same_refusal(missing.refusal, concealed.refusal, "kitas", hidden)
    # The layer exists: an administrator's model gets the same answer through.
    admin, _ = ask(world, "hidden_layer")
    assert admin.refusal is None and admin.query is not None


@pytest.fixture
def not_for_model(world: DataBackend) -> Iterator[tuple[str, str]]:
    """A layer and an attribute the administrator kept from the model (S3)."""
    update_layer(world.engine, "haltestellen", LayerUpdate(for_model=False))
    update_attribute(world.engine, "schulen", "standorte", AttributeUpdate(for_model=False))
    yield "haltestellen", "standorte"
    update_layer(world.engine, "haltestellen", LayerUpdate(for_model=True))
    update_attribute(world.engine, "schulen", "standorte", AttributeUpdate(for_model=True))


def test_what_the_model_must_not_know_is_unknown(
    world: DataBackend, not_for_model: tuple[str, str]
) -> None:
    layer, attribute = not_for_model
    missing, _ = ask(world, "unknown_layer")
    kept, _ = ask(world, "hidden_layer")  # haltestellen, visible to the administrator
    assert kept.refusal is not None and kept.refusal.code == "unknown_layer"
    assert layer not in kept.refusal.details["available"]
    same_refusal(missing.refusal, kept.refusal, "kitas", layer)
    gone = check(world, {"source": "schulen", "where": cmp("farbe", "gt", 1)})
    unreleased = check(world, {"source": "schulen", "where": cmp(attribute, "gt", 1)})
    assert isinstance(unreleased, Refusal) and unreleased.code == "unknown_attribute"
    assert attribute not in unreleased.details["available"]
    assert isinstance(gone, Refusal)
    same_refusal(gone, unreleased, "farbe", attribute)


def test_transport_errors_pass_from_the_seam(world: DataBackend) -> None:
    for case_id in ("unreachable", "timeout"):
        with pytest.raises(LLMError) as caught:
            ask(world, case_id)
        assert caught.value.code == case(case_id)["expect"]["error_code"]


# --- the reference question -----------------------------------------------------------


def test_the_reference_answer_is_the_e1_query_and_finds_10_of_137(world: DataBackend) -> None:
    result, _ = ask(world, "reference")
    expect = case("reference")["expect"]
    assert result.query is not None
    assert canonical_json(result.query) == canonical_json(QueryObject.model_validate(REFERENCE))
    assert classify(result.query) == {OpClass.QUERY, OpClass.SPATIAL}
    assert result.governance is not None
    assert result.governance.classes == [OpClass.QUERY, OpClass.SPATIAL]
    hits = run_query(result.query, world, LIMITS).meta.feature_count
    total = count_query(QueryObject(source=result.query.source), world, LIMITS)
    assert (hits, total) == (expect["hits"], expect["total"]) == (10, 137)


@pytest.mark.parametrize("name", LEVELS)
def test_the_level_governs_but_never_refuses(world: DataBackend, name: str) -> None:
    """D1: ``off`` still gives a proposal; ``auto`` at every class arrives approved."""
    result, _ = ask(world, "reference", on=level(name))
    assert result.refusal is None and result.governance is not None
    expected = case("reference")["expect"]["status"][name]
    assert (result.governance.cell is CellMode.AUTO) == (expected == "approved")
    both = [OpClass.QUERY, OpClass.SPATIAL]
    assert result.governance.off == (both if name == "Assistenz" else [])
    assert result.governance.needs_approval == (both if name == "Prüfen" else [])


# --- refusals in detail -----------------------------------------------------------------------


def cmp(attr: str, op: str, value: Any) -> dict[str, Any]:
    return {"op": "compare", "attr": attr, "cmp": op, "value": value}


def test_a_write_shaped_answer_is_refused_by_the_schema(world: DataBackend) -> None:
    """F-9.5: ``delete`` is not ignored but refused."""
    result, _ = ask(world, "write_shaped")
    assert result.refusal is not None and result.refusal.code == "model_query_invalid"
    errors = result.refusal.details["errors"]
    assert {
        "loc": ["delete"],
        "msg": "Extra inputs are not permitted",
        "type": "extra_forbidden",
    } in errors


def test_rows_count_and_connectives_do_not(world: DataBackend) -> None:
    """The limit counts the rows of the analysis (``count_conditions``)."""
    nested: dict[str, Any] = {
        "source": "schulen",
        "where": {
            "op": "not",
            "arg": {"op": "or", "args": [cmp("standorte", "gt", i) for i in range(7)]},
        },
    }
    # Seven rows and a date-free relation with its filter: eight.
    road = cmp("klasse", "eq", "kantonsstrasse_b")
    nested["where"]["arg"]["args"].append(
        {
            "op": "related",
            "layer": "strassen",
            "predicate": "dwithin",
            "distance_m": 9,
            "where": road,
        }
    )
    assert isinstance(check(world, nested), Validated)
    nested["where"]["arg"]["args"].append({"op": "is_null", "attr": "name"})
    refused = check(world, nested)
    assert isinstance(refused, Refusal) and refused.code == "limit_exceeded"
    assert refused.details == {"limit": "conditions", "value": 9, "max": 8}


def test_engine_codes_pass_through(world: DataBackend) -> None:
    match = {"op": "text_match", "attr": "standorte", "text": "1"}
    text = check(world, {"source": "schulen", "where": match})
    assert isinstance(text, Refusal) and text.code == "attribute_not_text"
    unknown = check(world, {"source": "schulen", "where": cmp("farbe", "eq", 1)})
    assert isinstance(unknown, Refusal) and unknown.code == "unknown_attribute"


@pytest.mark.parametrize(
    ("where", "part"),
    [
        (cmp("name", "lt", "M"), "compare"),  # text has no ordering in the editor
        (
            {
                "op": "related",
                "layer": "gemeinden",
                "predicate": "within",
                "where": {"op": "not", "arg": cmp("name", "eq", "Bern")},
            },
            "related",
        ),
        (
            {"op": "related", "layer": "schulen", "predicate": "dwithin", "distance_m": 50},
            "related",
        ),
        ({"op": "near_feature", "layer": "schulen", "fid": 1}, "near_feature"),
    ],
)
def test_what_the_controls_cannot_show_is_refused(
    world: DataBackend, where: dict[str, Any], part: str
) -> None:
    refused = check(world, {"source": "schulen", "where": where})
    assert isinstance(refused, Refusal) and refused.code == "not_representable"
    assert refused.details == {"part": part}


def test_not_representable_names_the_part(world: DataBackend) -> None:
    result, _ = ask(world, "not_representable")
    assert result.refusal is not None
    assert result.refusal.details == {"part": "order_by"}


# --- reading the answer ---------------------------------------------------------------------


def test_the_direct_format_offers_what_the_controls_show() -> None:
    schema = answer_format("direct")
    defs = schema["$defs"]
    kinds = {defs[v["$ref"].split("/")[-1]]["properties"]["kind"]["const"] for v in schema["oneOf"]}
    assert kinds == {"query", "clarification", "cannot_answer"}
    assert set(schema["discriminator"]["mapping"]) == kinds
    assert "Compare" in defs and "RelatedByDistance" in defs
    for gone in ("PlanAnswer", "BBox", "GeometryFilter", "Buffer", "AttributeJoin", "OrderBy"):
        assert gone not in defs
    query = defs["QueryObject"]["properties"]
    assert set(query) == {"schema_version", "source", "where", "output"}
    assert query["output"]["const"] == "map"
    assert defs["TextMatch"]["properties"]["mode"]["enum"] == [
        "contains",
        "starts_with",
        "ends_with",
    ]
    assert '"title"' not in format_text("direct")
    assert schema == answer_format("direct") and schema is not answer_format("direct")
    chain = answer_format("chain")["$defs"]
    assert "PlanAnswer" in chain and "QueryObject" not in chain


def test_what_a_refusal_or_an_unreadable_answer_keeps_is_bounded(world: DataBackend) -> None:
    """Review #35: the first ``MAX_LISTED`` errors and how many there were; an
    assumption's path into the where tree of at most ``MAX_CONDITION_PATH``."""
    extra = {f"x{i}": 1 for i in range(MAX_LISTED + 10)}
    refused = check(world, {"schema_version": "2", "source": "schulen", **extra})
    assert isinstance(refused, Refusal) and refused.code == "model_query_invalid"
    assert len(refused.details["errors"]) == MAX_LISTED
    assert refused.details["error_count"] == MAX_LISTED + 10

    many = {"kind": "clarification", "question": "Wie?", "options": ["a", "b"], **extra}
    with pytest.raises(ActionError) as caught:
        parse_answer(Completion(text=json.dumps(many)), "direct")
    cause = caught.value.details["cause"]
    assert cause.count("extra_forbidden") == MAX_LISTED and cause.endswith("; and 10 more")

    for length, readable in ((MAX_CONDITION_PATH, True), (MAX_CONDITION_PATH + 1, False)):
        assumption = {"text": "Primar", "condition": [0] * length}
        text = json.dumps(
            {"kind": "query", "explanation": "x", "query": {}, "assumptions": [assumption]}
        )
        if readable:
            parse_answer(Completion(text=text), "direct")
        else:
            with pytest.raises(ActionError) as caught:
                parse_answer(Completion(text=text), "direct")
            assert caught.value.details["cause"] == "query.assumptions.0.condition: too_long"


DEEP = '{"kind":"query","explanation":"x","query":' + '{"a":' * 100_000 + "1" + "}" * 100_001


@pytest.mark.parametrize(
    ("text", "cause"),
    [
        ("Hier sind die Primarschulen in Köniz", "not JSON: Expecting value at char 0"),
        ('{"kind": "query", "explanation": "x"}', "query.query: missing"),
        (
            '{"kind": "clarification", "question": "Wie?", "options": ["a","b","c","d","e"]}',
            "clarification.options: too_long",
        ),
        (
            json.dumps(case("chain_reference")["answer"]),
            "answer kind 'plan' is not one of the direct approach",
        ),
        (f'{{"kind": "{SENTINELS[0]}"}}', "(answer): union_tag_invalid"),
        (
            f'{{"kind": "query", "explanation": "x", "query": {{}}, "{SENTINELS[1]}": 1}}',
            "query.?: extra_forbidden",
        ),
        (DEEP, "nested too deeply"),
    ],
)
def test_an_unreadable_answer_names_its_cause_never_its_text(text: str, cause: str) -> None:
    with pytest.raises(ActionError) as caught:
        parse_answer(Completion(text=text), "direct")
    assert caught.value.code == "model_unreadable"
    assert caught.value.details["cause"] == cause
    assert [s for s in SENTINELS if s in json.dumps(caught.value.details)] == []


# --- the prompt ---------------------------------------------------------------------------


def test_the_prompt_holds_level_profile_and_format(world: DataBackend) -> None:
    _, model = ask(world, "reference")
    [call] = model.calls
    system, user = call.messages
    profile = profile_of(world)
    prompt = direct_prompt(case("reference")["prompt"], level=CHECK, profile=profile)
    assert system.role == "system" and user.role == "user"
    assert system.content.startswith(CHECK.system_prompt)
    assert profile.text in system.content and profile.text
    assert format_text("direct") in system.content
    assert call.schema == answer_format("direct")
    assert user.content == case("reference")["prompt"]
    assert prompt.messages == call.messages
    assert prompt.tokens_estimate == estimate_tokens(call.messages)
    assert prompt.tokens_estimate > ANSWER_TOKENS


def test_the_profile_is_the_accounts(world: DataBackend, hidden: str) -> None:
    _, model = ask(world, "clarification", role="user")
    system = model.calls[0].messages[0].content
    assert f'"name":"{hidden}"' not in system
    assert f'"name":"{AREAS}"' not in system  # imported, not released for users yet
    assert '"name":"schulen"' in system


def test_follow_up_turns_carry_words_never_queries(world: DataBackend) -> None:
    parent = case("reference")
    answer = QueryAnswer.model_validate(parent["answer"])
    turns = [
        Turn.of(f"Frage {i}", answer, decision="rejected", reject_reason="wrong_layer")
        for i in range(MAX_TURNS + 1)
    ]
    turns.append(Turn.of("Frage 7", answer, refusal="unknown_layer"))
    analysis = QueryObject.model_validate(case("follow_up_hand_edited")["analysis"])
    follow_up = FollowUp(analysis=analysis, reference="hand_edited", turns=turns)
    _, model = ask(world, "follow_up_hand_edited", follow_up=follow_up)
    messages = model.calls[0].messages
    assert [m.role for m in messages] == ["system"] + ["user", "assistant"] * MAX_TURNS + ["user"]
    assert messages[1].content == "Frage 2"  # the oldest two left the context
    for message in messages[2:-1:2]:  # the assistant's own words only
        assert answer.explanation in message.content
        assert "„nahe“ = höchstens 500 m" in message.content
        assert "abgelehnt" not in message.content and "abgewiesen" not in message.content
        assert '"source"' not in message.content and "kantonsstrasse_b" not in message.content
    for message in messages[3:-1:2]:  # the user's decision opens the next prompt
        assert message.content.startswith("Hinweis: ")
        assert "abgelehnt (falscher Layer)" in message.content
    last = messages[-1].content
    assert "von der Anwendung abgewiesen (unknown_layer)" in last
    assert canonical_json(analysis) in last
    assert "von Hand geändert" in last
    assert last.endswith(case("follow_up_hand_edited")["prompt"])


def test_turns_of_other_answers() -> None:
    clarification = parse_answer(
        Completion(text=json.dumps(case("clarification")["answer"])), "direct"
    )
    assert (
        Turn.of("?", clarification).answer == "Wie nahe ist „in der Nähe“? (250 m · 500 m · 1 km)"
    )
    cannot = parse_answer(Completion(text=json.dumps(case("cannot_answer")["answer"])), "direct")
    assert "Layer mit Lärmwerten" in (Turn.of("?", cannot).answer or "")
    assert Turn.of("?", None).answer is None


def test_too_large_a_context_is_refused_before_any_call(world: DataBackend) -> None:
    c = case("context_too_large")
    model = FakeLLMClient()
    direct = DirectQuery(model, context_of(world), CHECK)
    with pytest.raises(ActionError) as caught:
        run_direct(
            direct, c["prompt"], profile_of(world), context_length=c["setup"]["context_length"]
        )
    assert caught.value.code == c["expect"]["error_code"]
    assert caught.value.status == c["expect"]["http"]
    assert caught.value.details["context_length"] == 200
    assert caught.value.details["tokens_estimate"] > 200
    assert model.calls == []


def test_the_budget_counts_the_turns(world: DataBackend) -> None:
    profile = profile_of(world)
    alone = build_prompt("?", approach="direct", level=CHECK, profile=profile)
    follow_up = FollowUp(turns=[Turn("x" * 3000, "y" * 3000)])
    longer = build_prompt("?", approach="direct", level=CHECK, profile=profile, follow_up=follow_up)
    assert longer.tokens_estimate == alone.tokens_estimate + 2000
    with pytest.raises(ActionError):
        build_prompt(
            "?",
            approach="direct",
            level=CHECK,
            profile=profile,
            follow_up=follow_up,
            context_length=longer.tokens_estimate - 1,
        )


def test_no_row_value_reaches_the_model(tmp_path: Path) -> None:
    """S7 extended to every message of the direct path (WP64 done-when)."""
    backend = with_sample(tmp_path / "data")
    run = run_import(
        sentinel_csv(tmp_path),
        "sentinel.csv",
        ImportDecisions(
            layer_name="sentinel",
            title="Sentinel",
            geo=XYReference(x="E", y="N", crs=2056),
        ),
        backend,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run
    sentinel_query = {
        "kind": "query",
        "explanation": "Alle Punkte des Sentinel-Layers mit einer Kategorie.",
        "assumptions": [],
        "query": {
            "source": "sentinel",
            "where": {"op": "not", "arg": {"op": "is_null", "attr": "kategorie"}},
        },
    }
    unknown = {**sentinel_query, "query": {"source": "sentinel", "where": cmp("farbe", "eq", 1)}}
    model = FakeLLMClient(
        script=[Completion(text=json.dumps(a)) for a in (sentinel_query, unknown)]
    )
    direct = DirectQuery(model, context_of(backend), CHECK)
    parent = case("reference")
    follow_up = FollowUp(
        analysis=QueryObject.model_validate(REFERENCE),
        reference="last_answer",
        turns=[Turn.of(parent["prompt"], QueryAnswer.model_validate(parent["answer"]))],
    )
    profile = profile_of(backend)
    first = run_direct(direct, "Welche Punkte haben eine Kategorie?", profile, follow_up)
    second = run_direct(direct, "Und nach Farbe?", profile, follow_up)
    assert first.query is not None  # the layer is there and the query valid
    assert second.refusal is not None and second.refusal.code == "unknown_attribute"
    sent = "".join(m.content for call in model.calls for m in call.messages)
    sent += json.dumps([call.schema for call in model.calls])
    assert '"name":"sentinel"' in sent and '"name":"kategorie"' in sent
    assert [s for s in SENTINELS if s in sent] == []
    assert [s for s in SENTINELS if s in repr(first) + repr(second)] == []


# --- representability (D3) --------------------------------------------------------------------


def test_the_shared_list_holds_the_reference_question() -> None:
    [reference] = [c for c in REPRESENT["representable"] if c.get("query_equals")]
    assert reference["query_equals"] == "e2e/fixtures/reference-question.json"
    assert reference["query"] == REFERENCE
    not_representable = case("not_representable")["answer"]["query"]
    assert not_representable in [c["query"] for c in REPRESENT["not_representable"]]


def test_the_shared_catalog_agrees_with_the_sample(world: DataBackend) -> None:
    """The list's types are inputs; where a layer is the sample's, they must agree."""
    profile = model_profile(world.engine, world.layer_names())
    real = {layer.name: {a.name: a.type for a in layer.attributes} for layer in profile.layers}
    for name, shape in CATALOG.items():
        for attr, field_type in shape.attributes.items():
            if attr in real.get(name, {}):
                assert real[name][attr] == field_type, (name, attr)


@pytest.mark.parametrize("item", REPRESENT["representable"], ids=lambda c: c["id"])
def test_queries_the_controls_write_are_representable(item: dict[str, Any]) -> None:
    query = QueryObject.model_validate(item["query"])
    part = to_analysis(query, CATALOG)
    assert part == QueryPart.model_validate(item["analysis"])
    assert count_conditions(part) == item["conditions"]
    assert canonical_json(to_query(part)) == canonical_json(query)
    assert to_analysis(to_query(part), CATALOG) == part  # analysis → query → analysis


@pytest.mark.parametrize("item", REPRESENT["not_representable"], ids=lambda c: c["id"])
def test_queries_the_controls_cannot_write_are_not(item: dict[str, Any]) -> None:
    query = QueryObject.model_validate(item["query"])
    with pytest.raises(NotRepresentable) as caught:
        to_analysis(query, CATALOG)
    assert caught.value.part == item["part"]


def test_incomplete_rows_drop_out_of_the_query() -> None:
    """As in query.ts: a half-made row sends nothing, so it never comes back."""
    part = QueryPart.model_validate(
        {
            "result": "schulen",
            "tree": {
                "kind": "group",
                "children": [
                    {"kind": "attribute", "attr": "name", "operator": "eq", "value": ""},
                    {"kind": "spatial", "operator": "near", "layer": "strassen"},
                    {"kind": "reference", "layer": "haltestellen", "fid": None},
                    {"kind": "group", "op": "or", "children": []},
                    {"kind": "attribute", "attr": "typ", "operator": "in", "values": ["primar"]},
                ],
            },
        }
    )
    query = to_query(part)
    assert query.model_dump(exclude_defaults=True) == {
        "source": "schulen",
        "where": {"op": "in", "attr": "typ", "values": ["primar"]},
    }
