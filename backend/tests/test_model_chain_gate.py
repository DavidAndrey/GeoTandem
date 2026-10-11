"""The tool chain at the E2.5 gate (plan E2.3-E2.6, 5.2, 5.4).

The security review's findings on the chain (``security-review.md``, #42 and
#43) and the integrated review's: a chain's steps and stamps count against
the instance's query slots; a level changed since the plan governs no new
model call, a re-plan counts against the request limit; what a stop says
of a re-plan refused; and the decisions the review found covered by the
end-to-end test only, each through the API here.
"""

import asyncio
import threading
from collections.abc import Callable
from dataclasses import replace
from typing import Annotated, Any

import httpx
import pytest
from chain_fixtures import (  # noqa: F401 - levels, model, ran: fixtures
    BUFFER,
    MUNICIPALITIES,
    NOWHERE,
    SCHOOLS,
    Body,
    Model,
    drive,
    hits,
    levels,
    model,
    planned,
    ran,
    record,
    run,
    settle,
    statuses,
    within,
)
from fastapi import Depends, FastAPI
from model_fixtures import case, completion
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_model_chain_flow import (
    COUNTS,
    EMPTY_THEN,
    Clock,
    Held,
    ask_chain,
    choose,
    reference_plan,
    same_query,
    with_clock,
)
from test_model_enforcement import PROMPT, fixture_levels, install_levels, matrix, url

from geotandem.api.model import prompt_flow
from geotandem.api.slots import QuerySlots
from geotandem.api.state import AppState, get_state
from geotandem.app import start
from geotandem.db.orm import ModelAction, ModelCall
from geotandem.model.service import MODEL_CALL_S, PromptFlow

CONNECTIONS = "/api/admin/llm/connections"


class Gate:
    """The instance's slots as a chain's thread takes them, the wait capped for
    the test; how many the chain held at once at most, and the waits asked."""

    def __init__(self, slots: QuerySlots, wait_s: float) -> None:
        self.slots = slots
        self.wait_s = wait_s
        self.held = 0
        self.most = 0
        self.waits: list[float] = []
        self._lock = threading.Lock()

    def take_thread(self, wait_s: float, stop: Callable[[], bool] = lambda: False) -> bool:
        self.waits.append(wait_s)
        got = self.slots.take_thread(min(wait_s, self.wait_s), stop)
        if got:
            with self._lock:
                self.held += 1
                self.most = max(self.most, self.held)
        return got

    def give_back_thread(self) -> None:
        with self._lock:
            self.held -= 1
        self.slots.give_back_thread()


def use_slots(app: FastAPI, total: int, wait_s: float) -> tuple[QuerySlots, Gate]:
    """The instance with ``total`` query slots; the chain's waits capped at ``wait_s``."""
    slots = QuerySlots(per_account=4, total=total, wait_s=wait_s)
    app.state.geotandem.query_slots = slots
    gate = Gate(slots, wait_s)

    def flow(state: Annotated[AppState, Depends(get_state)]) -> PromptFlow:
        return replace(prompt_flow(state), gate=gate)

    app.dependency_overrides[prompt_flow] = flow
    return slots, gate


async def connection(client: httpx.AsyncClient) -> Body:
    [found] = (await client.get(CONNECTIONS)).json()
    body: Body = found
    return body


# --- #42: a chain's steps and stamps take the instance's query slots ------------------


async def test_a_saturated_instance_stops_a_chain_step_rather_than_exceed_the_cap(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Every slot of the instance taken by other queries: the step waits for one
    up to the query time limit, then the run stops ``limited`` before it,
    ``interrupted`` with ``busy`` naming the step; nothing ran in the engine."""
    slots, gate = use_slots(app, total=1, wait_s=0.2)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    assert slots.take_thread(0)  # the instance's one slot, another query's
    ran.clear()

    ended = await run(client, app, approved["id"])

    assert (ended["status"], ended["stop_reason"]) == ("limited", "interrupted")
    assert ended["error"]["code"] == "busy" and ended["error"]["details"] == {"step": 1}
    assert statuses(ended) == ["skipped"] * 5
    assert ran == [] and gate.most == 0
    assert gate.waits[0] == app.state.geotandem.limits.timeout_s  # as long as Modus A waits
    slots.give_back_thread()
    assert slots.free == 1


async def test_a_chain_step_waits_for_a_slot_and_never_holds_more_than_one(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """A slot that comes free while the step waits: the run goes on and ends
    ``done``; the chain never holds more than one slot at once, and gives
    every slot back (the stamp's included)."""
    slots, gate = use_slots(app, total=1, wait_s=5)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    assert slots.take_thread(0)
    started = await client.post(url(approved["id"], "run"))
    assert started.status_code == 202, started.text
    await asyncio.sleep(0.3)
    waiting = await record(client, approved["id"])
    assert waiting["status"] == "running" and statuses(waiting)[0] == "planned"
    slots.give_back_thread()
    await settle(app)

    done = await record(client, approved["id"])
    assert (done["status"], hits(done)) == ("done", COUNTS)
    assert gate.most == 1 and gate.held == 0 and slots.free == 1
    assert len(gate.waits) == len(COUNTS) + 1  # every step and the stamp


async def test_an_abort_without_a_free_slot_leaves_the_result_unstamped(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """The abort of a halted chain answers at once: it waits for no slot, and
    without one its result is offered unstamped; ``adopt`` stamps it."""
    slots, _ = use_slots(app, total=1, wait_s=5)
    await choose(client, levels["Teilautonom"])
    proposed = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    halted = await run(client, app, proposed["id"])
    assert halted["status"] == "proposed"
    assert slots.take_thread(0)
    ran.clear()

    aborted = await client.post(url(proposed["id"], "abort"))

    assert aborted.status_code == 200, aborted.text
    body = aborted.json()
    assert (body["status"], body["stop_reason"], body["stamp"]) == ("limited", "aborted", None)
    assert same_query(body["query"], body["steps"][0]["query"]) and ran == []
    slots.give_back_thread()
    adopted = await client.post(url(proposed["id"], "adopt"))
    assert adopted.status_code == 200, adopted.text
    assert adopted.json()["action"]["stamp"]["count"] == COUNTS[0]


# --- #43: the level now, and the request limit for every call --------------------------


async def test_run_after_a_halt_under_a_changed_level_stops_the_chain(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """Halted before the buffer, the level is edited; approving the halt is the
    record's own (M7.3), but ``run`` goes no further: ``limited``,
    ``level_not_available`` with ``reason: changed``, its last complete result
    adoptable, no step and no model call."""
    await choose(client, levels["Teilautonom"])
    proposed = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    halted = await run(client, app, proposed["id"])
    assert halted["status"] == "proposed" and statuses(halted)[1] == "waiting"
    every = {c: "auto" for c in ("catalog", "query", "spatial", "derive", "display")}
    await install_levels(
        client,
        [{**lv, "matrix": every} if lv["name"] == "Teilautonom" else lv for lv in fixture_levels()],
    )
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    calls = len(model.fake.calls)
    ran.clear()

    response = await client.post(url(proposed["id"], "run"))

    assert response.status_code == 202, response.text
    ended = response.json()
    assert (ended["status"], ended["stop_reason"]) == ("limited", "replan_limit")
    assert ended["error"]["code"] == "level_not_available"
    assert ended["error"]["details"] == {"reason": "changed"}
    assert statuses(ended) == ["ok"] + ["skipped"] * 4
    assert ended["stamp"]["count"] == COUNTS[0]
    assert len(ran) == 1 and len(model.fake.calls) == calls  # the stamp only
    await settle(app)
    assert (await client.post(url(proposed["id"], "adopt"))).status_code == 200


async def test_re_plans_count_against_the_request_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """P5 counts every model call on its day: the chain's plan and its first
    re-plan use the limit of 2; the second re-plan is refused before its
    call (``quota_exceeded`` with the limit), and so is the next prompt."""
    await choose(client, levels["Automatisch"])
    found = await connection(client)
    limited = await client.patch(
        f"{CONNECTIONS}/{found['id']}",
        json={"request_limit_enabled": True, "request_limit_per_day": 2},
    )
    assert limited.status_code == 200, limited.text
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(planned(("filter", {"of": 1, "where": NOWHERE}), MUNICIPALITIES, within(3, 4)))

    ended, _ = await drive(client, app, approved["id"])

    assert (ended["status"], ended["stop_reason"]) == ("limited", "replan_limit")
    assert ended["error"]["code"] == "quota_exceeded"
    assert ended["error"]["details"] == {"limit": 2, "connection": found["name"]}
    assert len(model.fake.calls) == 2
    with Session(app.state.geotandem.backend.engine) as db:
        assert db.scalar(select(func.count()).select_from(ModelCall)) == 1
    again = await client.post(PROMPT, json={"text": "Schulen?", "approach": "chain"})
    assert (again.status_code, again.json()["code"]) == (429, "quota_exceeded")


# --- what a stop says of a re-plan refused (integrated review, item A) -----------------


async def test_a_re_plan_that_brings_an_off_step_names_level_and_class(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """The plan touches no ``off`` class and runs at once; its re-plan brings a
    buffer, whose ``derive`` is ``off``: the run stops before the re-plan's
    steps, ``class_not_allowed``, and the user's view names the level, the
    class and the step (the words of the interface need them), nothing more."""
    own = {"name": "Ohne Ableiten", "selectable": True, "matrix": matrix(derive="off")}
    ids = await install_levels(client, [*fixture_levels()[1:], own])
    await choose(client, ids["Ohne Ableiten"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    assert approved["status"] == "approved"
    model.script(planned(BUFFER, within(1, 3)))

    ended, _ = await drive(client, app, approved["id"])

    assert (ended["status"], ended["stop_reason"], ended["replans"]) == (
        "limited",
        "replan_limit",
        1,
    )
    assert ended["error"]["code"] == "class_not_allowed"
    assert ended["error"]["details"] == {
        "level": "Ohne Ableiten",
        "op_class": "derive",
        "part": "derive",
        "step": 3,
    }
    assert statuses(ended) == ["ok", "empty", "skipped", "skipped"]  # no buffer step came in


async def test_a_re_plan_answered_without_a_plan_says_so(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """A clarification instead of a re-plan stops the run with
    ``model_unreadable``, told apart from re-plans used up (no error)."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(completion(case("clarification")))
    ended, _ = await drive(client, app, approved["id"])
    assert (ended["status"], ended["stop_reason"], ended["replans"]) == (
        "limited",
        "replan_limit",
        1,
    )
    assert ended["error"]["code"] == "model_unreadable" and ended["error"]["details"] == {}


@pytest.mark.parametrize("when", ["plan", "re-plan"])
async def test_no_chain_ends_in_a_buffer(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], when: str
) -> None:
    """D3, decided in the WP74 review: a buffer as the last step is refused as
    ``not_representable`` (``part: buffer``), at planning as a refusal, at a
    re-plan as the run's stop, naming the step."""
    await choose(client, levels["Automatisch"])
    if when == "plan":
        refused = await ask_chain(client, app, model, planned(SCHOOLS, BUFFER))
        assert refused["status"] == "refused"
        assert refused["refusal"]["code"] == "not_representable"
        assert refused["refusal"]["details"] == {"step": 2, "part": "buffer"}
        return
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(planned(MUNICIPALITIES, BUFFER))
    ended, _ = await drive(client, app, approved["id"])
    assert (ended["status"], ended["stop_reason"]) == ("limited", "replan_limit")
    assert ended["error"]["code"] == "not_representable"
    assert ended["error"]["details"] == {"step": 4, "part": "buffer"}


# --- decisions covered by the API, not only end to end -------------------------------


async def test_a_body_sent_to_run_or_adopt_is_ignored(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """D2: the stored record governs; a plan, a status or a query sent along
    with ``run`` or ``adopt`` changes nothing."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    forged: Body = {
        "steps": [{"text": "x", "tool": "filter", "arguments": {"layer": "gemeinden"}}],
        "status": "done",
        "query": {"source": "gemeinden"},
    }
    started = await client.post(url(approved["id"], "run"), json=forged)
    assert started.status_code == 202, started.text
    await settle(app)
    done = await record(client, approved["id"])
    assert (done["status"], hits(done)) == ("done", COUNTS)
    adopted = await client.post(url(approved["id"], "adopt"), json=forged)
    assert adopted.status_code == 200, adopted.text
    assert adopted.json()["action"]["stamp"]["count"] == COUNTS[-1]
    assert len(adopted.json()["result"]["features"]) == COUNTS[-1]


async def test_run_at_a_halt_needs_the_approval_again(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """P4: halted before a step whose cell is ``approve``, the chain waits; a
    ``run`` without that approval is ``not_approved`` and runs nothing."""
    await choose(client, levels["Teilautonom"])
    proposed = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    halted = await run(client, app, proposed["id"])
    assert halted["status"] == "proposed"
    ran.clear()
    again = await client.post(url(proposed["id"], "run"))
    assert (again.status_code, again.json()["code"]) == (409, "not_approved")
    assert ran == [] and await record(client, proposed["id"]) == halted


@pytest.mark.parametrize(
    ("start_s", "fails"), [(MODEL_CALL_S - 0.001, False), (MODEL_CALL_S, True)]
)
async def test_a_re_plans_own_call_has_120_seconds(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    start_s: float,
    fails: bool,
) -> None:
    """The re-plan's call has its own 120 s, well inside the request's 300 s:
    at 120 s it never reaches the model, and the run stops ``replan_limit``
    with ``llm_timeout`` (not ``time_limit``)."""
    clock = Clock()
    with_clock(app, clock, model)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(planned(MUNICIPALITIES, within(1, 3)))
    model.released.clear()
    model.asked.clear()
    assert (await client.post(url(approved["id"], "run"))).status_code == 202
    assert await asyncio.to_thread(model.asked.wait, 10)
    clock.now += start_s
    model.released.set()
    await settle(app)
    ended = await record(client, approved["id"])
    if fails:
        assert (ended["status"], ended["stop_reason"]) == ("limited", "replan_limit")
        assert ended["error"]["code"] == "llm_timeout"
    else:
        assert ended["status"] == "done"


async def test_a_chain_prompt_needs_an_enabled_connection(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """C14: no record, no model call."""
    found = await connection(client)
    off = await client.patch(f"{CONNECTIONS}/{found['id']}", json={"enabled": False})
    assert off.status_code == 200, off.text
    response = await client.post(PROMPT, json={"text": "Schulen?", "approach": "chain"})
    assert (response.status_code, response.json()["code"]) == (409, "connection_not_available")
    assert model.fake.calls == []
    with Session(app.state.geotandem.backend.engine) as db:
        assert db.scalar(select(func.count()).select_from(ModelAction)) == 0


async def test_the_start_up_hook_closes_a_running_chain(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P7 through the application's own start (``app.start``), not the check
    alone: a chain running when the process went down is ``limited``,
    ``interrupted``, its last complete result adoptable."""
    held = Held(monkeypatch, 4)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(approved["id"], "run"))).status_code == 202
    await held.wait()

    restarted: Any = await asyncio.to_thread(start, app.state.geotandem.settings)
    try:
        ended = await record(client, approved["id"])
        assert (ended["status"], ended["stop_reason"]) == ("limited", "interrupted")
        assert statuses(ended) == ["ok", "ok", "ok", "skipped", "skipped"]
        assert same_query(ended["query"], ended["steps"][2]["query"])
    finally:
        held.release.set()
        await settle(app)
        restarted.model_calls.shutdown()
        restarted.backend.engine.dispose()
    assert (await client.post(url(approved["id"], "adopt"))).status_code == 200
