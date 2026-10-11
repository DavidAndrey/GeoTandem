"""The comparison of both approaches through the API (plan E2.3-E2.6, WP76; P7,
design M10).

The model is scripted from the contract fixture behind the client factory;
everything else is the application on the sample data. ``compare`` asks the
same prompt again with the other approach as a new record (``compare_of``)
through the prompt flow; ``comparison`` runs both stored queries as the user
and lists what only one side finds, by feature id and name, with a reason
only where the two queries say it. Effects are observed where they happen:
the engine's query log (``ran``), the calls the model received, the records.
"""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Annotated, Any

import httpx
import pytest
from api_helpers import USER_PASSWORD
from chain_fixtures import SCHOOLS, Body, drive, planned, record, run, settle
from fastapi import Depends, FastAPI
from model_fixtures import case, completion
from test_model_bypass import TOKEN
from test_model_chain_flow import Model, modus_a_ids
from test_model_enforcement import (
    PLAIN,
    PROMPT,
    answer,
    connect,
    fixture_levels,
    import_areas,
    install_levels,
    url,
)

from geotandem.api.model import prompt_flow
from geotandem.api.state import AppState, get_state
from geotandem.catalog import list_layers
from geotandem.data import DataBackend, Limits
from geotandem.model.compare import Labels, name_attribute, reason
from geotandem.model.service import PromptFlow
from geotandem_query import QueryObject

REFERENCE = case("reference")
CHAIN = case("chain_reference")
DIFFERS = case("compare_differs")
FORGED = 999_999


# --- fixtures ----------------------------------------------------------------------


@pytest.fixture
async def model(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[Model]:
    fake = Model()
    app.state.geotandem.client_factory = fake
    yield fake
    fake.released.set()
    await settle(app)


@pytest.fixture
async def levels(client: httpx.AsyncClient, app: FastAPI) -> dict[str, int]:
    """A connection, the fixture's levels (Prüfen the default) and the tax rates."""
    await connect(client)
    import_areas(app.state.geotandem.backend)
    return await install_levels(client, fixture_levels())


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


@pytest.fixture
def ran(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The engine's query log: every statement the data core executes."""
    log: list[str] = []
    backend_type = type(app.state.geotandem.backend)
    original = backend_type.execute

    def execute(self: DataBackend, stmt: Any, limits: Limits) -> list[dict[str, Any]]:
        log.append(str(stmt))
        return original(self, stmt, limits)

    monkeypatch.setattr(backend_type, "execute", execute)
    return log


# --- helpers -----------------------------------------------------------------------


async def ask(
    client: httpx.AsyncClient, app: FastAPI, model: Model, c: Body, approach: str = "direct"
) -> Body:
    """The fixture's prompt, ``c``'s answer from the model; the record once answered."""
    model.script(completion(c))
    response = await client.post(PROMPT, json={"text": c["prompt"], "approach": approach})
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
    """``compare`` (202, ``thinking``) with ``c``'s answer; the repeat once answered."""
    model.script(completion(c))
    started = await client.post(url(original["id"], "compare"))
    assert started.status_code == 202, started.text
    thinking = started.json()
    other = "chain" if original["approach"] == "direct" else "direct"
    assert (thinking["status"], thinking["approach"]) == ("thinking", other)
    assert (thinking["compare_of"], thinking["prompt"]) == (original["id"], original["prompt"])
    await settle(app)
    return await record(client, thinking["id"])


async def compared(client: httpx.AsyncClient, action_id: int) -> Body:
    response = await client.get(url(action_id, "comparison"))
    assert response.status_code == 200, response.text
    body: Body = response.json()
    return body


def said(model: Model) -> str:
    """Everything the model has been sent."""
    return "\n".join(m.content for call in model.fake.calls for m in call.messages)


# --- the equal case (design M10.2, plan WP76 done-when) ---------------------------------


async def test_the_reference_question_compares_equal_both_ways(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Asked directly and repeated as a chain, and the other way round: 10 = 10,
    the same schools, nothing only on one side, no reason. The record compared
    stays as it was (the left side); the comparison asks no model."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    assert (chain["status"], chain["level"]["name"]) == ("proposed", "Prüfen")
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
    assert second["status"] == "proposed"
    assert (await record(client, first["id"]))["status"] == "done"
    body = await compared(client, second["id"])
    assert (body["left_action_id"], body["right_action_id"]) == (first["id"], second["id"])
    assert body["left"]["count"] == body["right"]["count"] == 10
    assert (body["only_left"], body["only_right"], body["reason"]) == ([], [], None)

    # A repeat sends the model what the same prompt sends: nothing of the record
    # it repeats, nothing of a result. Calls: the direct prompt, its repeat as a
    # chain, the chain prompt, its repeat as a direct query; no other.
    asked = [call.messages for call in model.fake.calls]
    assert len(asked) == 4
    assert asked[1] == asked[2] and asked[3] == asked[0]


# --- the differing case (design M10.3) ------------------------------------------------


async def test_a_differing_chain_lists_the_difference_by_id_name_and_reason(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """The fixture's chain takes "nahe" as 800 m and "hohe Steueranlage" as over
    1.65: one school only left, two only right, each with its name, and the
    reason read from the two queries. The ids are the application's: those
    the user's own runs of both queries find (Modus A)."""
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


def labels(app: FastAPI) -> Labels:
    return Labels.of(list_layers(app.state.geotandem.backend.engine))


def where(*conditions: Body) -> QueryObject:
    return QueryObject.model_validate(
        {"source": "schulen", "where": {"op": "and", "args": list(conditions)}}
    )


PRIMAR: Body = {"op": "in", "attr": "typ", "values": ["primar"]}
INSIDE: Body = {"op": "related", "layer": "gemeinden", "predicate": "within"}


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        # A relation's predicate, as the plan's example.
        (
            [PRIMAR, INSIDE],
            [PRIMAR, {**INSIDE, "predicate": "intersects"}],
            "Werkzeugkette: „schneidet Gemeinden“ statt „liegt in Gemeinden“",
        ),
        # A value, a condition on one side only, the other way round.
        (
            [PRIMAR, {"op": "compare", "attr": "standorte", "cmp": "ge", "value": 2}],
            [PRIMAR, {"op": "compare", "attr": "standorte", "cmp": "ge", "value": 3}],
            "Werkzeugkette: „Anzahl Schulhäuser ≥ 3“ statt „Anzahl Schulhäuser ≥ 2“",
        ),
        ([PRIMAR, INSIDE], [PRIMAR], "„liegt in Gemeinden“ nur in der Direktabfrage"),
        (
            [PRIMAR],
            [PRIMAR, {"op": "not", "arg": INSIDE}],
            "„liegt ausserhalb Gemeinden“ nur in der Werkzeugkette",
        ),
        # Order alone is no difference; a group or two changes about one thing are not said.
        ([PRIMAR, INSIDE], [INSIDE, PRIMAR], None),
        (
            [PRIMAR],
            [{"op": "or", "args": [PRIMAR, {"op": "is_null", "attr": "typ"}]}],
            None,
        ),
    ],
)
async def test_the_reason_follows_from_the_two_queries_only(
    client: httpx.AsyncClient,
    app: FastAPI,
    left: list[Body],
    right: list[Body],
    expected: str | None,
) -> None:
    assert reason(where(*left), where(*right), ("direct", "chain"), labels(app)) == expected


async def test_the_name_is_the_layers_name_attribute_or_none(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """``schulen`` names its schools; a layer of codes and numbers names none,
    and the first text attribute (``typ``: "primar") is no name."""
    layers = labels(app).layers
    assert name_attribute(layers["schulen"]) == "name"
    assert name_attribute(layers["gemeindedaten"]) is None


async def test_the_comparison_keeps_the_result_size_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Both id lists stay within the result-size limit: 10 hits pass a limit of
    10 exactly, a limit of 9 stops at the first side (413), names unread."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    done, _ = await drive(client, app, chain["id"])

    def bounded(max_features: int) -> None:
        def flow(state: Annotated[AppState, Depends(get_state)]) -> PromptFlow:
            limits = Limits(max_features=max_features, timeout_s=10)
            return replace(prompt_flow(state), limits=limits)

        app.dependency_overrides[prompt_flow] = flow

    bounded(10)
    assert (await compared(client, done["id"]))["right"]["count"] == 10
    bounded(9)
    ran.clear()
    over = await client.get(url(done["id"], "comparison"))
    assert (over.status_code, over.json()["code"]) == (413, "result_too_large")
    assert len(ran) == 1


# --- not finished, not compared, nothing to compare ----------------------------------


async def test_a_side_without_a_result_is_not_compared_yet(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """409 while the repeat is thinking and while its plan waits for approval;
    404 for a record never compared. Nothing runs."""
    direct = await applied(client, app, model)
    never = await client.get(url(direct["id"], "comparison"))
    assert (never.status_code, never.json()["code"]) == (404, "not_found")

    model.script(completion(CHAIN))
    model.released.clear()
    started = await client.post(url(direct["id"], "compare"))
    assert started.status_code == 202, started.text
    repeat_id = started.json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)
    ran.clear()
    for target in (repeat_id, direct["id"]):
        early = await client.get(url(target, "comparison"))
        assert (early.status_code, early.json()["code"]) == (409, "not_approved")
        assert early.json()["details"] == {"id": repeat_id, "status": "thinking"}
    model.released.set()
    await settle(app)
    waits = await client.get(url(repeat_id, "comparison"))
    assert (waits.status_code, waits.json()["details"]["status"]) == (409, "proposed")
    assert ran == []


async def test_only_a_record_with_a_result_is_compared(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Nothing to compare: a clarification (an answer, nothing to decide), a
    plan not run, a proposal-only answer (D1: its query is not run for the
    user, as the preview's is not), a forged id. No record, no model call."""

    async def refused(target: int, status: int, code: str) -> None:
        calls, count = len(model.fake.calls), await records()
        response = await client.post(url(target, "compare"))
        assert (response.status_code, response.json()["code"]) == (status, code), target
        assert len(model.fake.calls) == calls and await records() == count

    async def records() -> int:
        total: int = (await client.get("/api/model/my-actions")).json()["total"]
        return total

    await refused(
        (await ask(client, app, model, case("clarification")))["id"], 409, "already_decided"
    )
    await refused(
        (await ask(client, app, model, CHAIN, approach="chain"))["id"], 409, "not_approved"
    )
    await client.put("/api/llm/options", json={"level_id": levels["Assistenz"]})
    hand_only = await ask(client, app, model, REFERENCE)
    assert hand_only["proposal_only"]
    await refused(hand_only["id"], 409, "class_not_allowed")
    await refused(FORGED, 404, "not_found")
    assert ran == []


# --- taking a side (design: "Diese übernehmen ... gilt als Freigabe") -------------------


async def test_taking_a_side_keeps_that_records_own_approval(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """*Diese übernehmen* is the side's own ``adopt`` or ``execute``: the
    comparison opens no way around its level. Under *Prüfen* the repeated
    chain is neither run nor adopted, nor its comparison shown, before the
    person approves it; a token approves and adopts nothing."""
    direct = await applied(client, app, model)
    chain = await repeat(client, app, model, direct, CHAIN)
    ran.clear()
    for method, step, code in (
        ("POST", "adopt", "not_approved"),
        ("POST", "run", "not_approved"),
        ("POST", "execute", "not_approved"),
        ("GET", "comparison", "not_approved"),
    ):
        response = await client.request(method, url(chain["id"], step))
        assert (response.status_code, response.json()["code"]) == (409, code), step
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
    await client.put("/api/llm/options", json={"level_id": levels["Teilautonom"]})
    direct = await ask(client, app, model, REFERENCE)
    assert direct["status"] == "approved"
    chain = await repeat(client, app, model, direct, CHAIN)
    assert (await client.post(url(chain["id"], "approve"))).status_code == 200
    halted = await run(client, app, chain["id"])
    assert (halted["status"], halted["steps"][1]["status"]) == ("proposed", "waiting")
    for method, step in (("GET", "comparison"), ("POST", "adopt")):
        response = await client.request(method, url(chain["id"], step))
        assert (response.status_code, response.json()["code"]) == (409, "not_approved"), step
    done, approvals = await drive(client, app, chain["id"])
    assert (done["status"], approvals) == ("done", 1)
    assert (await compared(client, done["id"]))["only_left"] == []
    # The direct side is still the auto answer it was: executed, it is ``auto``.
    executed = await client.post(url(direct["id"], "execute"))
    assert executed.json()["action"]["decision"] == "auto"


async def test_a_direct_repeat_waits_for_its_approval(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """The chain first, the direct query repeated under *Prüfen*: its query is
    compared (as the preview counts it, for the person), but executed only
    once approved."""
    first = await ask(client, app, model, CHAIN, approach="chain")
    first, _ = await drive(client, app, first["id"])
    second = await repeat(client, app, model, first, REFERENCE)
    assert (await compared(client, second["id"]))["right"]["count"] == 10
    ran.clear()
    early = await client.post(url(second["id"], "execute"))
    assert (early.status_code, early.json()["code"]) == (409, "not_approved")
    assert ran == []
    assert (await client.post(url(second["id"], "approve"))).status_code == 200
    executed = await client.post(url(second["id"], "execute"))
    assert executed.json()["action"]["decision"] == "accepted"


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
        for method, step in (("POST", "compare"), ("GET", "comparison")):
            response = await client.request(method, url(target, step))
            assert (response.status_code, response.json()["code"]) == (404, "not_found")
    assert len(model.fake.calls) == calls and ran == []
