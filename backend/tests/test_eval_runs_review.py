"""Runs of the evaluation: what the WP90 review asked for (plan E3, D8, D12).

Seeds only where the connection sends one, the call's deadline held to the
operating limit, transport errors counted, a question too large never sent, an
unreadable key named, the estimate's latency from the connection test, a
circuit breaker that stops the run, one queue per model host, at most two query slots
per run, a busy database tried again and a row that cannot be closed keeping
the instance busy. The scripted model is ``test_eval_runs.Model``.
"""

import asyncio
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from test_eval_runs import (
    GOLD_OWN,
    GOOD,
    PROMPTS,
    RUNS,
    WEAK,
    Body,
    Model,
    connect,
    finished,
    run_to_end,
)
from test_eval_runs import model as model
from test_eval_runs import two as two

from geotandem.connection_check import CheckResult, CheckStep
from geotandem.evaluation import run as run_module
from geotandem.evaluation.run_store import RunStore
from geotandem.evaluation.schemas import EvalCase
from geotandem.llm import LLMError
from geotandem.vault import Vault

QUICK_TEXT: Body = {"cases": {"tags": ["text"]}, "scope": "quick"}
"""``text-beginnt-bern`` and ``h10-name-bahnhof``, five seeds: ten questions a point."""
ELSEWHERE = "http://localhost:11434/v1"
"""Another model host than the 127.0.0.1 of the fixture's connections."""


def on(two: Body, *connection_ids: int) -> Body:
    """The quick request with one point per connection, at the fixture's level."""
    level = two["points"][0]["level_id"]
    points = [{"connection_id": c, "level_id": level} for c in connection_ids]
    return {**two, **QUICK_TEXT, "points": points}


def ids(two: Body) -> tuple[int, int]:
    good, weak = (p["connection_id"] for p in two["points"])
    return good, weak


async def test_no_seed_is_sent_to_a_connection_without_one(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Review B2: the repeat is still numbered, the endpoint gets no seed."""
    seedless = await connect(client, "Ohne Seed", "gut", seed=None)
    view = await run_to_end(client, app, on(two, seedless))
    assert view["status"] == "done"
    assert {e.seed for e in model.endpoints} == {None}
    found = await client.get(
        f"{RUNS}/{view['id']}/answers", params={"case_id": "h10-name-bahnhof", "point": 0}
    )
    assert [a["seed"] for a in found.json()] == [1, 2, 3, 4, 5]


async def test_a_call_ends_by_the_operating_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Review B3: a connection's timeout of 600 s is held to ``MODEL_CALL_S``."""
    slow = await connect(client, "Langsam", "gut", timeout_s=600)
    before = time.monotonic()
    view = await run_to_end(client, app, on(two, slow))
    after = time.monotonic()
    assert view["status"] == "done"
    assert {e.timeout_s for e in model.endpoints} == {run_module.MODEL_CALL_S}
    for deadline in model.deadlines:
        assert deadline is not None
        assert before < deadline <= after + run_module.MODEL_CALL_S


async def test_transport_errors_are_counted_by_code_and_as_limited(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    def slow(seed: int) -> LLMError:
        return LLMError("llm_timeout", "scripted")

    model.scripts["schwach"] = {**WEAK, "text-beginnt-bern": slow}
    view = await run_to_end(client, app, on(two, ids(two)[1]))
    figures = view["points"][0]["figures"]
    assert figures["errors"] == {"llm_timeout": 5}
    assert (figures["limited"], figures["unreadable"]) == (5, 0)
    found = await client.get(
        f"{RUNS}/{view['id']}/answers", params={"case_id": "text-beginnt-bern", "point": 0}
    )
    first = found.json()[0]
    assert (first["verdict"], first["code"]) == ("error", "llm_timeout")
    assert (first["latency_ms"], first["raw"], first["answer"]) == (None, None, None)


async def test_a_question_too_large_for_the_context_is_stored_and_never_sent(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    small = await connect(client, "Klein", "gut", context_length=256)
    estimate = (await client.post(f"{RUNS}/estimate", json=on(two, small))).json()
    assert (estimate["requests"], estimate["tokens"], estimate["duration_s"]) == (0, 0, 0)
    view = await run_to_end(client, app, on(two, small))
    assert view["status"] == "done"
    assert model.calls == []
    assert view["points"][0]["figures"]["errors"] == {"context_too_large": 10}


async def test_a_key_this_instance_cannot_open_is_refused_naming_the_connection(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Review S2."""
    keyed = await connect(client, "Fremd", "gut", api_key="sk-fremd-1234")
    foreign = Vault.open(Path(app.state.geotandem.settings.data_dir) / "anders").encrypt("x")
    with Session(app.state.geotandem.backend.engine) as db, db.begin():
        db.execute(
            text("UPDATE llm_connection SET api_key = :k WHERE id = :i"),
            {"k": foreign, "i": keyed},
        )
    refused = await client.post(RUNS, json=on(two, keyed))
    assert refused.status_code == 409, refused.text
    assert refused.json()["code"] == "credentials_unreadable"
    assert refused.json()["details"] == {"connection_id": keyed, "connection": "Fremd"}


async def test_the_estimate_falls_back_on_the_connection_test(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    good, _ = ids(two)
    tested = CheckResult(
        ok=True,
        tested_at=datetime.now(UTC),
        steps=[CheckStep(name="json_schema", status="ok", details={"latency_ms": 2500})],
    )
    app.state.geotandem.connections.record_test(good, tested)
    estimate = (await client.post(f"{RUNS}/estimate", json=on(two, good))).json()
    assert estimate["connections"][0]["duration_s"] == 25  # 10 requests at 2.5 s


async def test_a_repeated_failure_of_the_endpoint_stops_the_whole_run(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Five refused keys in a row on one host stop the run at once: the other
    host's queue asks no further question (nothing more is spent); the run
    ends ``failed`` and names the host and its connections."""
    tripped = threading.Event()
    refusals = 0

    def refused(seed: int) -> LLMError:
        nonlocal refusals
        refusals += 1
        if refusals == run_module.BREAKER_AFTER:
            tripped.set()
        return LLMError("llm_unauthorized", "scripted")

    def after_the_trip(answer: Callable[[int], Any]) -> Callable[[int], Any]:
        def waiting(seed: int) -> Any:
            assert tripped.wait(10), "the other queue never tripped"
            time.sleep(0.2)  # the tripped queue stores its fifth answer and stops the run
            return answer(seed)

        return waiting

    model.scripts["schwach"] = dict.fromkeys(PROMPTS, refused)
    model.scripts["gut"] = {case: after_the_trip(answer) for case, answer in GOOD.items()}
    elsewhere = await connect(client, "Anderswo", "schwach", base_url=ELSEWHERE)
    view = await run_to_end(client, app, on(two, ids(two)[0], elsewhere))
    assert (view["status"], view["error"]) == ("failed", "llm_unauthorized")
    assert sum(1 for m, _, _ in model.calls if m == "schwach") == 5
    # The question in flight at the trip was sent; none is asked after it, and
    # its answer, graded only while the run goes on, is dropped.
    assert sum(1 for m, _, _ in model.calls if m == "gut") == 1
    assert view["progress"]["done"] == 5
    assert view["stopped"] == [
        {"host": "localhost", "connection_ids": [elsewhere], "code": "llm_unauthorized"}
    ]
    assert all(p["figures"] is None for p in view["points"])


async def test_points_on_one_host_queue_and_hosts_run_at_the_same_time(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D8: ``gut`` and ``schwach`` share 127.0.0.1, ``fern`` is on localhost."""
    model.scripts["fern"] = GOOD
    far = await connect(client, "Fern", "fern", base_url=ELSEWHERE)
    model.pause = 0.02
    view = await run_to_end(client, app, on(two, *ids(two), far))
    assert view["status"] == "done"
    assert not any({"gut", "schwach"} <= pair for pair in model.together)
    assert any("fern" in pair for pair in model.together)


async def test_one_queue_asks_case_by_case_at_each_point(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """An aborted run has its cases at the points of a queue paired."""
    await run_to_end(client, app, on(two, *ids(two)))
    order = [(m, msgs[-1].content) for m, _, msgs in model.calls]
    first = PROMPTS["text-beginnt-bern"]
    assert order[:10] == [("gut", first)] * 5 + [("schwach", first)] * 5


class SpySlots:
    """The instance's query slots, counting what a run takes and holds."""

    def __init__(self, slots: Any) -> None:
        self.slots = slots
        self.lock = threading.Lock()
        self.taken = 0
        self.held = 0
        self.most = 0

    def take_thread(self, wait_s: float, stop: Callable[[], bool] = lambda: False) -> bool:
        got: bool = self.slots.take_thread(wait_s, stop)
        if got:
            with self.lock:
                self.taken += 1
                self.held += 1
                self.most = max(self.most, self.held)
            time.sleep(0.002)
        return got

    def give_back_thread(self) -> None:
        with self.lock:
            self.held -= 1
        self.slots.give_back_thread()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.slots, name)


async def test_readings_and_grading_take_a_query_slot_two_at_most(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Review #42, C2: each reading and each grading holds one of the instance's
    slots; the run never more than two at once, so requests keep theirs."""
    real = app.state.geotandem.query_slots
    far = await connect(client, "Fern", "gut", base_url=ELSEWHERE)
    spy = SpySlots(real)
    app.state.geotandem.query_slots = spy
    try:
        view = await run_to_end(client, app, on(two, ids(two)[0], far))
    finally:
        app.state.geotandem.query_slots = real
    assert view["status"] == "done"
    assert spy.taken == 2 + 20  # two readings, twenty gradings
    assert spy.held == 0
    assert 1 <= spy.most <= run_module.RUN_SLOTS
    assert real.free == real.total


async def test_abort_then_start_says_the_run_is_finishing(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Review C5."""
    model.hold_from = 1
    model.released.clear()
    started = await client.post(RUNS, json=on(two, ids(two)[0]))
    assert await asyncio.to_thread(model.asked.wait, 10)
    await client.post(f"{RUNS}/{started.json()['id']}/abort")
    busy = await client.post(RUNS, json=on(two, ids(two)[0]))
    assert busy.status_code == 409
    assert busy.json()["details"] == {"run": started.json()["id"], "reason": "finishing"}
    model.released.set()
    await finished(app)


def _locked() -> OperationalError:
    return OperationalError("UPDATE eval_run", {}, Exception("database is locked"))


async def test_a_busy_database_is_tried_again(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    two: Body,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real = RunStore.add_answer
    failed: list[int] = []

    def add_answer(self: RunStore, *args: Any) -> bool:
        if not failed:
            failed.append(1)
            raise _locked()
        return real(self, *args)

    monkeypatch.setattr(RunStore, "add_answer", add_answer)
    view = await run_to_end(client, app, on(two, ids(two)[0]))
    assert view["status"] == "done"
    assert view["progress"]["done"] == 10


async def test_a_run_whose_row_cannot_be_closed_keeps_the_instance_busy(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    two: Body,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review C3: no second run over a row left ``running``; the next start
    closes it first."""
    real = RunStore.finish

    def finish(self: RunStore, *args: Any, **kwargs: Any) -> bool:
        raise _locked()

    monkeypatch.setattr(RunStore, "finish", finish)
    body = on(two, ids(two)[0])
    stuck = await run_to_end(client, app, body)
    assert stuck["status"] == "running"
    busy = await client.post(RUNS, json=body)
    assert busy.status_code == 409
    assert busy.json()["details"] == {"run": stuck["id"], "reason": "finishing"}
    monkeypatch.setattr(RunStore, "finish", real)
    again = await run_to_end(client, app, body)
    assert again["status"] == "done"
    closed = (await client.get(f"{RUNS}/{stuck['id']}")).json()
    assert closed["status"] == "done"
    assert closed["points"][0]["figures"] is not None


def test_tags_and_note_do_not_change_the_case_set_hash() -> None:
    case = EvalCase.model_validate({**GOLD_OWN, "note": "alt"})
    same = case.model_copy(update={"tags": ["anders"], "note": "neu"})
    other = case.model_copy(update={"prompt": "Haltestellen, die mit Bern anfangen"})
    assert run_module.case_set_hash([case]) == run_module.case_set_hash([same])
    assert run_module.case_set_hash([case]) != run_module.case_set_hash([other])
    assert len(run_module.case_set_hash([case])) == 64
