"""Tool chains for the API tests (plan E2.3-E2.6, WP75).

Plans as the model writes them, a chain stored as the service stores a plan
(``stored_chain``, for records in a state the test needs without a model),
and ``drive``, which walks a chain through the API as the interface does:
approve where it waits, run, wait for the run, until it is done or stopped.
The fixtures ``model``, ``levels`` and ``ran`` serve the chain's and the
comparison's tests (imported there by name).
"""

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from test_model_enforcement import (
    account_of,
    connect,
    fixture_levels,
    import_areas,
    install_levels,
    url,
)

from geotandem.api.state import AppState
from geotandem.data import DataBackend, Limits
from geotandem.levels import load_levels
from geotandem.llm import Completion, Endpoint, Message, ModelInfo, ToolSpec
from geotandem.llm.fake import FakeLLMClient
from geotandem.model.chain.plan import chain_governance, check_plan
from geotandem.model.record import (
    ModelActionStore,
    NewAction,
    connection_snapshot,
    level_snapshot,
)
from geotandem.model.schemas import PlanAnswer
from geotandem.model.service import new_step, profile_for

Body = dict[str, Any]
Step = tuple[str, Body]

PRIMAR: Body = {"op": "in", "attr": "typ", "values": ["primar"]}
NOWHERE: Body = {"op": "in", "attr": "typ", "values": ["keine"]}
ROADS_B: Body = {"op": "compare", "attr": "klasse", "cmp": "eq", "value": "kantonsstrasse_b"}
GEMEINDEN: Body = {"op": "compare", "attr": "gem_nr", "cmp": "gt", "value": 0}

SCHOOLS: Step = ("filter", {"layer": "schulen", "where": PRIMAR})
"""62 primary schools; classes ``{query}``."""
NO_SCHOOLS: Step = ("filter", {"layer": "schulen", "where": NOWHERE})
"""No school: an empty step."""
MUNICIPALITIES: Step = ("filter", {"layer": "gemeinden", "where": GEMEINDEN})
BUFFER: Step = (
    "buffer",
    {"layer": "strassen", "distance_m": 500, "where": ROADS_B},
)
"""Classes ``{derive, query}``."""


def within(of: int, in_: int) -> Step:
    """Classes ``{spatial}``."""
    return ("within", {"of": of, "in": in_})


def plan(*steps: Step, why: str = "Schritt für Schritt.") -> Body:
    return {
        "kind": "plan",
        "explanation": why,
        "assumptions": [],
        "steps": [
            {"text": f"Schritt {i}: {tool}", "tool": tool, "arguments": arguments}
            for i, (tool, arguments) in enumerate(steps, 1)
        ],
    }


def planned(*steps: Step, why: str = "Schritt für Schritt.") -> Completion:
    """The model's answer: a plan of ``steps``."""
    body = plan(*steps, why=why)
    return Completion(text=json.dumps(body, ensure_ascii=False), parsed=body)


def stored_chain(app: FastAPI, username: str, level_name: str, *steps: Step) -> int:
    """A chain of ``steps`` as the service stores a plan (``PromptFlow._keep``):
    checked whole in the account's world, governed by ``level_name`` as it is
    now, each step with its cell. Never supersedes."""
    state: AppState = app.state.geotandem
    engine = state.backend.engine
    who = account_of(app, username)
    level = next(lv for lv in load_levels(engine) if lv.name == level_name)
    connection = state.connections.active(who.id)
    assert connection is not None
    view, profile = profile_for(state.backend, who)
    answer = PlanAnswer.model_validate(plan(*steps))
    checked = check_plan(answer.steps, state.tool_context(view), profile)
    assert isinstance(checked, list), checked
    store = ModelActionStore(engine)
    new = NewAction(
        prompt="Primarschulen Schritt für Schritt",
        approach="chain",
        level=level_snapshot(level),
        connection=connection_snapshot(connection),
        profile_hash=profile.hash,
        level_prompt=level.system_prompt,
    )
    action = store.create(who, new, supersede=False)
    store.propose(
        who,
        action.id,
        answer,
        query=None,
        governance=chain_governance(level, checked),
        latency_ms=1,
        steps=[new_step(level, step) for step in checked],
    )
    return action.id


async def settle(app: FastAPI) -> None:
    """Until every model call and chain run started so far has ended."""
    await asyncio.to_thread(app.state.geotandem.model_calls.wait, 10)


async def record(client: httpx.AsyncClient, action_id: int) -> Body:
    response = await client.get(url(action_id))
    assert response.status_code == 200, response.text
    body: Body = response.json()
    return body


async def run(client: httpx.AsyncClient, app: FastAPI, action_id: int) -> Body:
    """``run`` (202, ``running``), then the record once the run stopped."""
    started = await client.post(url(action_id, "run"))
    assert started.status_code == 202, started.text
    assert started.json()["status"] == "running"
    await settle(app)
    return await record(client, action_id)


async def drive(client: httpx.AsyncClient, app: FastAPI, action_id: int) -> tuple[Body, int]:
    """The chain through the API as the interface walks it: approve where it
    waits (``proposed``), run when approved, until it is done or stopped. The
    record then, and how many approvals it took."""
    approvals = 0
    for _ in range(12):
        current = await record(client, action_id)
        if current["status"] == "proposed":
            approved = await client.post(url(action_id, "approve"))
            assert approved.status_code == 200, approved.text
            approvals += 1
        elif current["status"] == "approved":
            await run(client, app, action_id)
        else:
            return current, approvals
    raise AssertionError(f"chain {action_id} did not end")


def hits(view: Body) -> list[int | None]:
    return [step["hits"] for step in view["steps"]]


def statuses(view: Body) -> list[str]:
    return [step["status"] for step in view["steps"]]


# --- fixtures: the model, the levels, the engine's query log ---------------------


class Model:
    """The model behind the client factory: ``fake`` answers what the test
    scripts and records every call; ``released`` cleared holds a call."""

    def __init__(self) -> None:
        self.fake = FakeLLMClient()
        self.asked = threading.Event()
        self.released = threading.Event()
        self.released.set()

    def __call__(self, endpoint: Endpoint) -> "Model":
        return self

    def script(self, *answers: Completion) -> None:
        self.fake.script.extend(answers)

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
        deadline: float | None = None,
    ) -> Completion:
        self.asked.set()
        assert self.released.wait(10), "the test never released the model"
        return self.fake.complete(
            messages, schema=schema, schema_name=schema_name, tools=tools, deadline=deadline
        )

    def models(self) -> list[ModelInfo]:
        return []

    def server_version(self) -> str | None:
        return None

    def close(self) -> None:
        pass


@pytest.fixture
async def model(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[Model]:
    fake = Model()
    app.state.geotandem.client_factory = fake
    yield fake
    fake.released.set()
    await settle(app)


@pytest.fixture
async def levels(client: httpx.AsyncClient, app: FastAPI) -> dict[str, int]:
    """A connection, the fixture's levels and the tax rates of the reference question."""
    await connect(client)
    import_areas(app.state.geotandem.backend)
    return await install_levels(client, fixture_levels())


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
