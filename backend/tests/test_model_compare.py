"""The comparison of both approaches through the API (plan E2.3-E2.6, WP76; P7,
design M10).

The model is scripted from the contract fixture behind the client factory;
everything else is the application on the sample data. ``compare`` asks the
same prompt again with the other approach as a new record (``compare_of``)
through the prompt flow, always stored ``proposed``; ``comparison`` runs both
stored queries as the user and lists what only one side finds, by feature id
and name, with a reason, as data, only where the two queries show it.
Effects are observed where they happen: the engine's query log (``ran``),
the calls the model received, the records.
"""

import asyncio
import math
from collections.abc import AsyncIterator, Iterator
from dataclasses import replace
from typing import Annotated, Any

import httpx
import pytest
from api_helpers import USER_PASSWORD
from chain_fixtures import (  # noqa: F401 - levels, model, ran: fixtures
    SCHOOLS,
    Body,
    Model,
    drive,
    levels,
    model,
    planned,
    ran,
    record,
    run,
    settle,
)
from fastapi import Depends, FastAPI
from model_fixtures import case, completion
from test_model_bypass import TOKEN
from test_model_chain_flow import modus_a_ids
from test_model_enforcement import PLAIN, PROMPT, account_of, answer, url

from geotandem.api.model import prompt_flow
from geotandem.api.state import AppState, get_state
from geotandem.auth.visibility import set_visible
from geotandem.catalog import list_layers
from geotandem.data import Limits
from geotandem.engine import execute as engine_execute
from geotandem.levels import classify, load_levels
from geotandem.model.compare import name_attribute, reason, result_layer
from geotandem.model.direct import governance
from geotandem.model.record import (
    ModelActionStore,
    NewAction,
    connection_snapshot,
    level_snapshot,
)
from geotandem.model.schemas import QueryAnswer
from geotandem.model.service import PromptFlow
from geotandem_query import QueryObject

REFERENCE = case("reference")
CHAIN = case("chain_reference")
DIFFERS = case("compare_differs")
FORGED = 999_999
OPTIONS = "/api/llm/options"


# --- fixtures and helpers ------------------------------------------------------------


@pytest.fixture
async def other(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[httpx.AsyncClient]:
    """A second user, ``b.muster``, in a client of their own."""
    created = await client.post("/api/admin/users", json={"username": "b.muster", "role": "user"})
    assert created.status_code == 201, created.text
    first = created.json()["start_password"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as them:
        await them.post("/api/auth/login", json={"username": "b.muster", "password": first})
        changed = await them.post(
            "/api/auth/password", json={"current": first, "new": USER_PASSWORD}
        )
        assert changed.status_code == 204, changed.text
        yield them


async def ask(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    c: Body,
    approach: str = "direct",
    **more: Any,
) -> Body:
    """The fixture's prompt, ``c``'s answer from the model; the record once answered."""
    model.script(completion(c))
    body = {"text": c["prompt"], "approach": approach, **more}
    response = await client.post(PROMPT, json=body)
    assert response.status_code == 202, response.text
    await settle(app)
    return await record(client, response.json()["id"])


async def applied(client: httpx.AsyncClient, app: FastAPI, model: Model) -> Body:
    """The reference question asked directly under *Prüfen*, approved and executed."""
    proposed = await ask(client, app, model, REFERENCE)
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    executed = await client.post(url(proposed["id"], "execute"))
    assert executed.status_code == 200, executed.text
    body: Body = executed.json()["action"]
    return body


async def repeat(
    client: httpx.AsyncClient, app: FastAPI, model: Model, original: Body, c: Body
) -> Body:
    """``compare`` (202, ``thinking``) with ``c``'s answer; the repeat once
    answered, which waits for the person (``proposed``) whatever the level."""
    model.script(completion(c))
    started = await client.post(url(original["id"], "compare"))
    assert started.status_code == 202, started.text
    thinking = started.json()
    other = "chain" if original["approach"] == "direct" else "direct"
    assert (thinking["status"], thinking["approach"]) == ("thinking", other)
    assert (thinking["compare_of"], thinking["prompt"]) == (original["id"], original["prompt"])
    await settle(app)
    found = await record(client, thinking["id"])
    assert found["status"] == "proposed", found
    return found


async def compared(client: httpx.AsyncClient, action_id: int) -> Body:
    response = await client.post(url(action_id, "comparison"))
    assert response.status_code == 200, response.text
    body: Body = response.json()
    return body


async def refused(
    client: httpx.AsyncClient, method: str, action_id: int, step: str, status: int, code: str
) -> Body:
    response = await client.request(method, url(action_id, step))
    assert (response.status_code, response.json()["code"]) == (status, code), response.text
    body: Body = response.json()
    return body


def said(model: Model) -> str:
    """Everything the model has been sent."""
    return "\n".join(m.content for call in model.fake.calls for m in call.messages)


def stored(app: FastAPI, username: str, query: Body, *, compare_of: int | None = None) -> int:
    """A direct record of ``query`` under *Prüfen*, as the service stores an
    answer (``PromptFlow._keep``), without a model: for queries the model path
    does not write (an aggregate)."""
    state: AppState = app.state.geotandem
    who = account_of(app, username)
    level = next(lv for lv in load_levels(state.backend.engine) if lv.name == "Prüfen")
    connection = state.connections.active(who.id)
    assert connection is not None
    store = ModelActionStore(state.backend.engine)
    new = NewAction(
        prompt="Schulen und Gemeinden",
        approach="direct",
        level=level_snapshot(level),
        connection=connection_snapshot(connection),
        profile_hash="p" * 64,
        compare_of=compare_of,
    )
    action = store.create(who, new, supersede=False)
    parsed = QueryObject.model_validate(query)
    store.propose(
        who,
        action.id,
        QueryAnswer(kind="query", explanation="So.", query=query),
        query=parsed,
        governance=governance(level, classify(parsed)),
        latency_ms=1,
    )
    return action.id


def with_flow(app: FastAPI, **changes: Any) -> None:
    """The prompt flow with ``changes`` (limits, clock) for the next requests."""

    def flow(state: Annotated[AppState, Depends(get_state)]) -> PromptFlow:
        return replace(prompt_flow(state), **changes)

    app.dependency_overrides[prompt_flow] = flow


# --- the equal case (design M10.2, plan WP76 done-when) ---------------------------------


async def test_the_reference_question_compares_equal_both_ways(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Asked directly and repeated as a chain, and the other way round: 10 = 10,
    the same schools, nothing only on one side, no reason. The record compared
    stays as it was (the left side); the comparison asks no model, and the
    repeat's model input is the same prompt's."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    assert chain["level"]["name"] == "Prüfen"
    assert (await record(client, direct["id"]))["status"] == "applied"  # not superseded
    done, approvals = await drive(client, app, chain["id"])
    assert (done["status"], approvals) == ("done", 1)
    calls = len(model.fake.calls)
    ran.clear()

    body = await compared(client, done["id"])

    assert (body["left_action_id"], body["right_action_id"]) == (direct["id"], done["id"])
    assert body["left"]["count"] == body["right"]["count"] == REFERENCE["expect"]["hits"]
    assert body["left"]["ids_hash"] == body["right"]["ids_hash"]
    assert body["left"] == direct["stamp"]  # the same query on the same data
    assert (body["only_left"], body["only_right"], body["reason"]) == ([], [], None)
    assert len(ran) == 2  # one id list per side; no names, since nothing differs
    assert len(model.fake.calls) == calls
    # Named by the record compared, the comparison is the same.
    assert await compared(client, direct["id"]) == body

    # The chain first (M9.3 "Mit Direktabfrage vergleichen"), then the direct query.
    first = await ask(client, app, model, CHAIN, approach="chain")
    first, _ = await drive(client, app, first["id"])
    second = await repeat(client, app, model, first, REFERENCE)
    assert (await record(client, first["id"]))["status"] == "done"
    body = await compared(client, second["id"])
    assert (body["left_action_id"], body["right_action_id"]) == (first["id"], second["id"])
    assert body["left"]["count"] == body["right"]["count"] == 10
    assert (body["only_left"], body["only_right"], body["reason"]) == ([], [], None)
    # The waiting side's ids were shown: logged as a preview (P2 rule 4).
    assert (await record(client, second["id"]))["previewed_at"] is not None
    assert (await record(client, first["id"]))["previewed_at"] is None

    # A repeat sends the model what the same prompt sends: nothing of the record
    # it repeats, nothing of a result. Calls: the direct prompt, its repeat as a
    # chain, the chain prompt, its repeat as a direct query; no other.
    asked = [call.messages for call in model.fake.calls]
    assert len(asked) == 4
    assert asked[1] == asked[2] and asked[3] == asked[0]


async def test_the_comparison_is_a_post_under_the_origin_check(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Review #41: the comparison writes ``previewed_at`` on a waiting side, so
    it is a ``POST`` the origin check covers, as the preview is (#39): a
    cross-site one runs nothing and leaves ``previewed_at`` unset; a ``GET``
    is no route."""
    first = await ask(client, app, model, CHAIN, approach="chain")
    first, _ = await drive(client, app, first["id"])
    second = await repeat(client, app, model, first, REFERENCE)
    ran.clear()

    assert (await client.get(url(second["id"], "comparison"))).status_code in (404, 405)
    elsewhere = await client.post(
        url(second["id"], "comparison"), headers={"Origin": "https://evil.example"}
    )
    assert elsewhere.status_code == 403
    assert ran == []
    assert (await record(client, second["id"]))["previewed_at"] is None

    await compared(client, second["id"])
    assert (await record(client, second["id"]))["previewed_at"] is not None


# --- the differing case (design M10.3) ------------------------------------------------


async def test_a_differing_chain_lists_the_difference_by_id_name_and_reason(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """The fixture's chain takes "nahe" as 800 m and "hohe Steueranlage" as over
    1.65: one school only left, two only right, each with its name, and the
    reason: the two conditions that differ, as data. The ids are the
    application's: those the user's own runs of both queries find (Modus A)."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, DIFFERS)
    done, _ = await drive(client, app, chain["id"])
    assert done["status"] == "done"
    assert done["stamp"]["count"] == DIFFERS["expect"]["hits"]
    calls = len(model.fake.calls)
    ran.clear()

    body = await compared(client, done["id"])

    expect = DIFFERS["expect"]["comparison"]
    assert (body["left"]["count"], body["right"]["count"]) == (
        expect["left_hits"],
        expect["right_hits"],
    )
    assert body["only_left"] == expect["only_left"]
    assert body["only_right"] == expect["only_right"]
    assert body["reason"] == expect["reason"]
    assert len(ran) == 3  # two id lists, one read of the names of the three that differ
    assert len(model.fake.calls) == calls

    left = set(await modus_a_ids(client, REFERENCE["answer"]["query"]))
    right = set(await modus_a_ids(client, done["query"]))
    assert [f["id"] for f in body["only_left"]] == sorted(left - right)
    assert [f["id"] for f in body["only_right"]] == sorted(right - left)
    # Nothing of the comparison reaches the model: its last call was the plan.
    names = [f["name"] for f in body["only_left"] + body["only_right"]]
    assert names and not any(name in said(model) for name in names)


def where(*conditions: Body, **more: Any) -> QueryObject:
    return QueryObject.model_validate(
        {"source": "schulen", "where": {"op": "and", "args": list(conditions)}, **more}
    )


PRIMAR: Body = {"op": "in", "attr": "typ", "values": ["primar"]}
INSIDE: Body = {"op": "related", "layer": "gemeinden", "predicate": "within"}
CROSSES: Body = {**INSIDE, "predicate": "intersects"}
TWO: Body = {"op": "compare", "attr": "standorte", "cmp": "ge", "value": 2}
THREE: Body = {**TWO, "value": 3}
OUTSIDE: Body = {"op": "not", "arg": INSIDE}
AREAS: Body = {"by_layer": "gemeinden", "metrics": [{"fn": "count", "as": "schulen"}]}


def changes(*pairs: tuple[Body | None, Body | None]) -> Body:
    """A ``conditions`` reason as dumped without ``None``: a missing side is left out."""
    return {
        "kind": "conditions",
        "changes": [
            {side: c for side, c in (("left", a), ("right", b)) if c is not None} for a, b in pairs
        ],
    }


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        # A relation's predicate, as the plan's example; a value.
        (where(PRIMAR, INSIDE), where(PRIMAR, CROSSES), changes((INSIDE, CROSSES))),
        (where(PRIMAR, TWO), where(PRIMAR, THREE), changes((TWO, THREE))),
        # A condition on one side only, either way; a pair and a single at once.
        (where(PRIMAR, INSIDE), where(PRIMAR), changes((INSIDE, None))),
        (where(PRIMAR), where(PRIMAR, OUTSIDE), changes((None, OUTSIDE))),
        (where(PRIMAR, TWO, INSIDE), where(PRIMAR, THREE), changes((TWO, THREE), (INSIDE, None))),
        # Another result layer: an aggregate returns its area layer's features.
        (
            where(PRIMAR),
            where(PRIMAR, aggregate=AREAS),
            {"kind": "source", "left": "schulen", "right": "gemeinden"},
        ),
        # Not said: order alone, a group, two changes about one thing, another part.
        (where(PRIMAR, INSIDE), where(INSIDE, PRIMAR), None),
        (where(PRIMAR), where({"op": "or", "args": [PRIMAR, TWO]}), None),
        (where(PRIMAR, TWO), where(PRIMAR, THREE, {**TWO, "cmp": "le"}), None),
        (
            where(PRIMAR),
            where(PRIMAR, columns=[{"fn": "distance_to", "name": "d", "layer": "strassen"}]),
            None,
        ),
    ],
)
def test_the_reason_follows_from_the_two_queries_only(
    left: QueryObject, right: QueryObject, expected: Body | None
) -> None:
    found = reason(left, right)
    assert (None if found is None else found.model_dump(mode="json", exclude_none=True)) == expected


def test_an_aggregate_returns_its_area_layers_features() -> None:
    assert result_layer(where(PRIMAR, aggregate=AREAS)) == "gemeinden"
    assert result_layer(where(PRIMAR)) == "schulen"


async def test_the_name_is_the_layers_name_attribute_or_none(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """``schulen`` names its schools; a table of codes and numbers names none,
    and the first text attribute (``typ``: "primar") is no name."""
    layers = {i.name: i for i in list_layers(app.state.geotandem.backend.engine)}
    assert name_attribute(layers["schulen"]) == "name"
    assert name_attribute(layers["gemeindedaten"]) is None


async def test_an_aggregate_side_is_compared_by_its_area_layers_features(
    client: httpx.AsyncClient,
    app: FastAPI,
    levels: dict[str, int],
    ran: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Schools on one side, municipalities (the aggregate's features) on the
    other: no id is "the same" across layers, every one is listed with its
    layer's name, the names read a chunk of ids at a time; the reason is the
    result layer. Both sides wait, so both are logged as previewed."""
    monkeypatch.setattr(engine_execute, "IN_CHUNK", 25)
    schools = {"schema_version": "2", **PLAIN}
    areas = {**schools, "aggregate": AREAS}
    left = stored(app, "admin", schools)
    right = stored(app, "admin", areas, compare_of=left)
    ran.clear()

    body = await compared(client, right)

    municipalities = body["right"]["count"]
    assert (body["left"]["count"], len(body["only_left"])) == (62, 62)
    assert len(body["only_right"]) == municipalities > 0
    assert all(f["name"] for f in body["only_left"] + body["only_right"])
    assert body["reason"] == {"kind": "source", "left": "schulen", "right": "gemeinden"}
    assert len(ran) == 2 + math.ceil(62 / 25) + math.ceil(municipalities / 25)
    for side in (left, right):
        assert (await record(client, side))["previewed_at"] is not None


# --- the limits of the reads -----------------------------------------------------------


async def test_the_comparison_keeps_the_result_size_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Both id lists stay within the result-size limit: 10 hits pass a limit of
    10 exactly; under a limit of 9 the first side stops (413) after reading
    one id beyond it, never all, and no name is read."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    done, _ = await drive(client, app, chain["id"])
    with_flow(app, limits=Limits(max_features=10, timeout_s=10))
    assert (await compared(client, done["id"]))["right"]["count"] == 10

    with_flow(app, limits=Limits(max_features=9, timeout_s=10))
    ran.clear()
    await refused(client, "POST", done["id"], "comparison", 413, "result_too_large")
    assert len(ran) == 1 and "LIMIT" in ran[0]


async def test_the_comparison_has_one_time_budget(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """All reads of one comparison share the query time limit (10 s): on a
    clock that moves 6 s per look, the second side is over it; the error
    names the budget, not the slice that was left."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    done, _ = await drive(client, app, chain["id"])
    ticks: Iterator[int] = iter(range(0, 10_000, 6))
    with_flow(app, monotonic=lambda: float(next(ticks)))
    ran.clear()

    over = await refused(client, "POST", done["id"], "comparison", 504, "query_timeout")

    assert over["details"]["timeout_s"] == 10
    assert len(ran) == 1


async def test_a_layer_hidden_since_is_unknown_and_names_nothing(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    ran: list[str],
    other: httpx.AsyncClient,
) -> None:
    """The comparison runs as the user now: a layer withdrawn from their role
    after both answers is ``unknown_layer``, and nothing is read."""
    model.script(answer(PLAIN), planned(SCHOOLS))
    asked = await other.post(PROMPT, json={"text": "Schulen"})
    await settle(app)
    mine = await record(other, asked.json()["id"])
    started = await other.post(url(mine["id"], "compare"))
    await settle(app)
    done, _ = await drive(other, app, started.json()["id"])
    assert (await compared(other, done["id"]))["only_left"] == []
    set_visible(app.state.geotandem.backend.engine, "schulen", "user", False)
    ran.clear()

    await refused(other, "POST", done["id"], "comparison", 400, "unknown_layer")
    assert ran == []


# --- not finished, nothing to compare, which repeat --------------------------------------


async def test_a_side_without_a_result_is_not_compared_yet(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """409 ``not_approved`` while the repeat is thinking and while its plan
    waits for approval; 404 for a record never compared. Nothing runs."""
    direct = await applied(client, app, model)
    await refused(client, "POST", direct["id"], "comparison", 404, "not_found")

    model.script(completion(CHAIN))
    model.released.clear()
    started = await client.post(url(direct["id"], "compare"))
    assert started.status_code == 202, started.text
    repeat_id = started.json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)
    ran.clear()
    for target in (repeat_id, direct["id"]):
        early = await refused(client, "POST", target, "comparison", 409, "not_approved")
        assert early["details"] == {"id": repeat_id, "status": "thinking"}
    model.released.set()
    await settle(app)
    waits = await refused(client, "POST", repeat_id, "comparison", 409, "not_approved")
    assert waits["details"]["status"] == "proposed"
    assert ran == []


async def test_a_repeat_that_ended_without_a_result_is_nothing_to_compare(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Two repeats of one record: a later one that failed says so for good
    (``nothing_to_compare``), while the record compared still shows its newest
    repeat with a result; a repeat is not repeated in turn."""
    direct = await applied(client, app, model)
    first = await repeat(client, app, model, direct, CHAIN)
    first, _ = await drive(client, app, first["id"])
    model.script(completion(case("unreachable")))
    started = await client.post(url(direct["id"], "compare"))
    assert started.status_code == 202, started.text
    await settle(app)
    failed = started.json()["id"]
    assert (await record(client, failed))["status"] == "failed"

    gone = await refused(client, "POST", failed, "comparison", 409, "nothing_to_compare")
    assert gone["details"] == {"id": failed, "status": "failed"}
    assert (await compared(client, direct["id"]))["right_action_id"] == first["id"]
    assert (await compared(client, first["id"]))["left_action_id"] == direct["id"]
    # A third repeat with a result is the newest the record compared shows.
    third = await repeat(client, app, model, direct, DIFFERS)
    third, _ = await drive(client, app, third["id"])
    assert (await compared(client, direct["id"]))["right_action_id"] == third["id"]
    calls = len(model.fake.calls)
    again = await refused(client, "POST", first["id"], "compare", 409, "repeat_of_repeat")
    assert again["details"]["compare_of"] == direct["id"]
    assert len(model.fake.calls) == calls


async def test_only_a_record_with_a_result_is_compared(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Nothing to compare: a clarification (``nothing_to_compare``), a plan not
    run (not yet), a proposal-only answer (D1: its query is not run for the
    user, as the preview's is not), a forged id. No record, no model call."""

    async def records() -> int:
        total: int = (await client.get("/api/model/my-actions")).json()["total"]
        return total

    async def not_compared(target: int, status: int, code: str) -> None:
        calls, count = len(model.fake.calls), await records()
        await refused(client, "POST", target, "compare", status, code)
        assert len(model.fake.calls) == calls and await records() == count

    clarified = await ask(client, app, model, case("clarification"))
    await not_compared(clarified["id"], 409, "nothing_to_compare")
    plan = await ask(client, app, model, CHAIN, approach="chain")
    await not_compared(plan["id"], 409, "not_approved")
    await client.put(OPTIONS, json={"level_id": levels["Assistenz"]})
    hand_only = await ask(client, app, model, REFERENCE)
    assert hand_only["proposal_only"]
    await not_compared(hand_only["id"], 409, "class_not_allowed")
    await not_compared(FORGED, 404, "not_found")
    assert ran == []


async def test_a_follow_up_is_repeated_with_its_parent(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """P6: the repeat of a follow-up follows the same parent, so the model gets
    the same turns (the clarification it answers)."""
    clarified = await ask(client, app, model, case("clarification"))
    follow = await ask(client, app, model, REFERENCE, parent_action_id=clarified["id"])
    assert follow["parent_action_id"] == clarified["id"]
    again = await repeat(client, app, model, follow, CHAIN)
    assert again["parent_action_id"] == clarified["id"]
    question = case("clarification")["answer"]["question"]
    *_, follow_call, repeat_call = model.fake.calls
    for call in (follow_call, repeat_call):
        assert question in "\n".join(m.content for m in call.messages)


async def test_the_repeat_of_a_follow_up_asks_with_its_analysis(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """P6, E2.6 gate review: changed by hand (500 ⇒ 300 m) before the follow-up,
    the repeat answers the same question: the same analysis, the same
    reference, the same note to the model."""
    edited = case("follow_up_hand_edited")
    parent = await ask(client, app, model, REFERENCE)
    follow = await ask(
        client, app, model, edited, parent_action_id=parent["id"], analysis=edited["analysis"]
    )
    assert follow["reference"] == "hand_edited"

    again = await repeat(client, app, model, follow, CHAIN)

    assert (again["parent_action_id"], again["reference"]) == (parent["id"], "hand_edited")
    *_, follow_call, repeat_call = model.fake.calls
    for call in (follow_call, repeat_call):
        question = call.messages[-1].content
        assert '"distance_m":300' in question and "von Hand geändert" in question


# --- taking a side (design: "Diese übernehmen ... gilt als Freigabe") -------------------


async def test_under_automatisch_a_repeat_waits_and_is_taken_as_accepted(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Every cell ``auto``: the first answer applies at once (``auto``), but its
    repeat waits ``proposed``, so nothing of it applies before the person has
    compared; taking it is approve and run and adopt (a chain) or approve and
    execute (a direct query), and that is ``accepted``."""
    await client.put(OPTIONS, json={"level_id": levels["Automatisch"]})
    direct = await ask(client, app, model, REFERENCE)
    assert direct["status"] == "approved"
    executed = await client.post(url(direct["id"], "execute"))
    assert executed.json()["action"]["decision"] == "auto"
    chain = await repeat(client, app, model, direct, CHAIN)
    assert chain["governance"]["cell"] == "auto"
    ran.clear()
    for method, step in (("POST", "run"), ("POST", "adopt"), ("POST", "comparison")):
        await refused(client, method, chain["id"], step, 409, "not_approved")
    assert ran == []
    done, approvals = await drive(client, app, chain["id"])
    assert (done["status"], approvals) == ("done", 1)
    await compared(client, done["id"])
    adopted = await client.post(url(done["id"], "adopt"))
    assert adopted.json()["action"]["decision"] == "accepted"

    # The other way round: the chain first, its direct repeat.
    first = await ask(client, app, model, CHAIN, approach="chain")
    assert first["status"] == "approved"
    first, _ = await drive(client, app, first["id"])
    direct_repeat = await repeat(client, app, model, first, REFERENCE)
    await compared(client, direct_repeat["id"])
    await refused(client, "POST", direct_repeat["id"], "execute", 409, "not_approved")
    assert (await client.post(url(direct_repeat["id"], "approve"))).status_code == 200
    executed = await client.post(url(direct_repeat["id"], "execute"))
    assert executed.json()["action"]["decision"] == "accepted"


async def test_taking_a_side_keeps_that_records_own_approval(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """*Diese übernehmen* is the side's own approval and ``adopt``: the
    comparison opens no way around its level. Under *Prüfen* the repeated
    chain is neither run nor adopted, nor its comparison shown, before the
    person approves it; a token approves and adopts nothing."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    ran.clear()
    for method, step in (
        ("POST", "adopt"),
        ("POST", "run"),
        ("POST", "execute"),
        ("POST", "comparison"),
    ):
        await refused(client, method, chain["id"], step, 409, "not_approved")
    for step in ("approve", "adopt"):
        token = await client.post(url(chain["id"], step), headers=TOKEN)
        assert (token.status_code, token.json()["code"]) == (403, "session_required"), step
    assert ran == [] and (await record(client, chain["id"]))["status"] == "proposed"

    done, approvals = await drive(client, app, chain["id"])
    assert approvals == 1
    await compared(client, done["id"])
    token = await client.post(url(done["id"], "adopt"), headers=TOKEN)
    assert (token.status_code, token.json()["code"]) == (403, "session_required")
    adopted = await client.post(url(done["id"], "adopt"))
    assert adopted.status_code == 200, adopted.text
    assert (adopted.json()["action"]["status"], adopted.json()["action"]["decision"]) == (
        "applied",
        "accepted",
    )
    assert (await record(client, direct["id"]))["decision"] == "accepted"  # as it was


async def test_a_chain_taken_from_the_comparison_still_halts_where_its_level_says(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """*Teilautonom*: the direct answer arrives ``approved`` (auto) and waits
    beside its repeat; the chain halts before the buffer (``derive`` needs
    approval), and while it halts there is no comparison and nothing to adopt."""
    await client.put(OPTIONS, json={"level_id": levels["Teilautonom"]})
    direct = await ask(client, app, model, REFERENCE)
    assert direct["status"] == "approved"
    chain = await repeat(client, app, model, direct, CHAIN)
    assert (await client.post(url(chain["id"], "approve"))).status_code == 200
    halted = await run(client, app, chain["id"])
    assert (halted["status"], halted["steps"][1]["status"]) == ("proposed", "waiting")
    for method, step in (("POST", "comparison"), ("POST", "adopt")):
        await refused(client, method, chain["id"], step, 409, "not_approved")
    done, approvals = await drive(client, app, chain["id"])
    assert (done["status"], approvals) == ("done", 1)
    assert (await compared(client, done["id"]))["only_left"] == []
    # The direct side is still the auto answer it was: executed, it is ``auto``.
    executed = await client.post(url(direct["id"], "execute"))
    assert executed.json()["action"]["decision"] == "auto"


# --- other accounts --------------------------------------------------------------------


async def test_another_accounts_comparison_does_not_exist(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    ran: list[str],
    other: httpx.AsyncClient,
) -> None:
    """Neither side of another account's comparison is found (404, an
    administrator's too); no model call, no record, nothing runs."""
    model.script(answer(PLAIN), planned(SCHOOLS))
    asked = await other.post(PROMPT, json={"text": "Schulen"})
    await settle(app)
    mine = await record(other, asked.json()["id"])
    started = await other.post(url(mine["id"], "compare"))
    assert started.status_code == 202, started.text
    await settle(app)
    calls = len(model.fake.calls)
    ran.clear()
    for target in (mine["id"], started.json()["id"]):
        for method, step in (("POST", "compare"), ("POST", "comparison")):
            await refused(client, method, target, step, 404, "not_found")
    assert len(model.fake.calls) == calls and ran == []
