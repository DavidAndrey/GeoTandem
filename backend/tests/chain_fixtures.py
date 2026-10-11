"""Tool chains for the API tests (plan E2.3-E2.6, WP75).

Plans as the model writes them, a chain stored as the service stores a plan
(``stored_chain``, for records in a state the test needs without a model),
and ``drive``, which walks a chain through the API as the interface does:
approve where it waits, run, wait for the run, until it is done or stopped.
"""

import asyncio
import json
from typing import Any

import httpx
from fastapi import FastAPI
from test_model_enforcement import account_of, url

from geotandem.api.state import AppState
from geotandem.levels import load_levels
from geotandem.llm import Completion
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
