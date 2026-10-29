"""The chain's check of a direct answer through the API (plan-check-mode).

With the connection's check mode ``chain``, a direct answer with a query is
asked again with the chain by the application, as a repeat (``compare_of``)
marked ``is_check``; its plan's query (the last step's, D2: no step runs) is
compared with the direct query by feature ids, as the user. The direct
answer's ``check`` says what was found. The model is scripted from the
contract fixture; everything else is the application on the sample data.
"""

import asyncio
import threading
from collections.abc import Sequence
from typing import Any

import httpx
import pytest
from chain_fixtures import (  # noqa: F401 - levels, model, ran: fixtures
    Body,
    Model,
    levels,
    model,
    ran,
    record,
    settle,
)
from fastapi import FastAPI
from model_fixtures import case, completion
from test_model_compare import CHAIN, DIFFERS, REFERENCE, ask, compared
from test_model_enforcement import PROMPT, url

from geotandem.llm import Completion

CONNECTIONS = "/api/admin/llm/connections"
FIGURES = "/api/admin/model-actions/key-figures"
CLARIFICATION = case("clarification")


async def check_mode(client: httpx.AsyncClient, mode: str, **more: Any) -> Body:
    [found] = (await client.get(CONNECTIONS)).json()
    changed = await client.patch(f"{CONNECTIONS}/{found['id']}", json={"check_mode": mode, **more})
    assert changed.status_code == 200, changed.text
    body: Body = changed.json()
    assert body["check_mode"] == mode
    return body


async def settled(client: httpx.AsyncClient, app: FastAPI, action_id: int) -> Body:
    """The answer once its check, started from the answer's own call, ended."""
    for _ in range(200):
        await settle(app)
        answer = await record(client, action_id)
        if (answer["check"] or {}).get("state") != "running":
            return answer
        await asyncio.sleep(0.01)
    raise AssertionError(f"the check of {action_id} never ended")


async def checked(
    client: httpx.AsyncClient, app: FastAPI, model: Model, direct: Body, chain: Body
) -> tuple[Body, Body]:
    """The direct answer ``direct`` asked, the chain's check answering ``chain``;
    both records once settled: the direct answer, its check."""
    model.script(completion(direct), completion(chain))
    asked = await client.post(PROMPT, json={"text": direct["prompt"], "approach": "direct"})
    assert asked.status_code == 202, asked.text
    answer = await settled(client, app, asked.json()["id"])
    assert answer["check"] is not None, answer
    check = await record(client, answer["check"]["action_id"])
    return answer, check


async def test_off_by_default_no_check_is_asked(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    [found] = (await client.get(CONNECTIONS)).json()
    assert found["check_mode"] == "off"
    answer = await ask(client, app, model, REFERENCE)
    await settle(app)
    assert (await record(client, answer["id"]))["check"] is None
    assert len(model.fake.calls) == 1


async def test_the_same_result_is_marked_same_without_running_a_step(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """The chain's plan of the reference question finds the direct query's ten
    schools: ``same``. The check waits ``proposed`` beside the answer, no step
    ran; it is left out of the key figures' proposals and counted apart."""
    await check_mode(client, "chain")
    answer, check = await checked(client, app, model, REFERENCE, CHAIN)

    hits = REFERENCE["expect"]["hits"]
    assert answer["check"] == {
        "state": "same",
        "action_id": check["id"],
        "direct_hits": hits,
        "chain_hits": hits,
    }
    assert answer["status"] == "proposed"  # the answer is as it was: waiting
    assert (check["is_check"], check["compare_of"], check["approach"]) == (
        True,
        answer["id"],
        "chain",
    )
    assert check["status"] == "proposed"
    assert {step["status"] for step in check["steps"]} == {"planned"}
    assert len(model.fake.calls) == 2
    assert model.fake.calls[1].messages[-1].content == model.fake.calls[0].messages[-1].content

    figures = (await client.get(FIGURES)).json()
    assert figures["proposals"] == 0  # neither is decided yet; the check never counts
    assert figures["checks"] == {
        "checked": 1,
        "same": 1,
        "differs": 0,
        "not_checked": 0,
        "taken": 0,
    }


async def test_a_different_plan_is_marked_and_compared_by_its_plan(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """The fixture's other reading: ``differs`` with both counts; the
    comparison opens on the check and compares the plan's query, as the
    manual comparison of the same two answers does after a run."""
    await check_mode(client, "chain")
    answer, check = await checked(client, app, model, REFERENCE, DIFFERS)

    expect = DIFFERS["expect"]["comparison"]
    assert answer["check"]["state"] == "differs"
    assert (answer["check"]["direct_hits"], answer["check"]["chain_hits"]) == (
        expect["left_hits"],
        expect["right_hits"],
    )
    body = await compared(client, check["id"])
    assert (body["left_action_id"], body["right_action_id"]) == (answer["id"], check["id"])
    assert body["only_left"] == expect["only_left"]
    assert body["only_right"] == expect["only_right"]
    assert body["reason"] == expect["reason"]


async def test_a_check_without_a_plan_leaves_the_answer_not_checked(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    await check_mode(client, "chain")
    answer, check = await checked(client, app, model, REFERENCE, CLARIFICATION)
    assert answer["check"] == {
        "state": "not_checked",
        "action_id": check["id"],
        "direct_hits": None,
        "chain_hits": None,
    }
    assert check["status"] == "answered"


async def test_the_check_counts_against_the_request_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """D5: with a limit of 1 the direct prompt uses it; the check is not
    admitted, no record is made, the answer is ``not_checked``."""
    await check_mode(client, "chain", request_limit_enabled=True, request_limit_per_day=1)
    answer = await ask(client, app, model, REFERENCE)
    answer = await settled(client, app, answer["id"])
    assert answer["check"] == {
        "state": "not_checked",
        "action_id": None,
        "direct_hits": None,
        "chain_hits": None,
    }
    assert len(model.fake.calls) == 1


class _HoldSecond(Model):
    """The model answers the first call at once and holds every later one
    until ``go`` is set: the check thinks while the test sends a prompt."""

    def __init__(self, model: Model) -> None:
        self.__dict__.update(model.__dict__)
        self.go = threading.Event()
        self.waiting = threading.Event()

    def complete(self, messages: Sequence[Any], **more: Any) -> Completion:
        if self.fake.calls:
            self.waiting.set()
            assert self.go.wait(10), "the test never let the check go on"
        return self.fake.complete(messages, **more)


@pytest.mark.parametrize("approach", ["direct", "chain"])
async def test_a_new_prompt_aborts_a_check_still_thinking(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], approach: str
) -> None:
    """D3: the check holds no account; the next prompt is not refused (409),
    it aborts the check, whose late answer is dropped, and the answer it
    checked stays ``not_checked``."""
    await check_mode(client, "chain")
    held = _HoldSecond(model)
    app.state.geotandem.client_factory = held
    held.script(completion(REFERENCE), completion(CHAIN))
    first = await client.post(PROMPT, json={"text": REFERENCE["prompt"], "approach": "direct"})
    assert first.status_code == 202, first.text
    assert held.waiting.wait(10)
    answer = await record(client, first.json()["id"])
    for _ in range(100):  # the mark names its check once the check is recorded
        if answer["check"]["action_id"] is not None:
            break
        await asyncio.sleep(0.01)
        answer = await record(client, first.json()["id"])
    assert answer["check"]["state"] == "running"
    check_id = answer["check"]["action_id"]

    held.script(completion(CHAIN if approach == "chain" else REFERENCE))
    second = await client.post(PROMPT, json={"text": "Noch eine Frage", "approach": approach})
    assert second.status_code == 202, second.text
    held.go.set()
    await settled(client, app, answer["id"])

    check = await record(client, check_id)
    assert (check["status"], check["decision"]) == ("aborted", "aborted")
    assert (await record(client, answer["id"]))["check"]["state"] == "not_checked"


async def test_a_check_is_no_repeat_target_of_its_own(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """A check's own record is never checked again, and a manual comparison
    of the answer still starts a repeat of its own."""
    await check_mode(client, "chain")
    answer, check = await checked(client, app, model, REFERENCE, CHAIN)
    assert check["check"] is None
    model.script(completion(CHAIN))
    started = await client.post(url(answer["id"], "compare"))
    assert started.status_code == 202, started.text
    await settle(app)
    repeat = await record(client, started.json()["id"])
    assert (repeat["is_check"], repeat["compare_of"]) == (False, answer["id"])
    assert repeat["check"] is None
    assert len(model.fake.calls) == 3
