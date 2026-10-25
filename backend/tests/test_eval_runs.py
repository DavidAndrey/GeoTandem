"""Runs of the evaluation over HTTP (plan E3, D7, D8, D12, WP90).

The model is scripted per question, seed and model name behind the client
factory, so two connections asked at the same time answer the same way
whatever the order of their calls. A run over a few start cases reproduces
the scripted verdicts in its cells and figures; the comparison words come
for a full run on the confirmation cases only; abort, a restart, one run at a
time, an unconfirmed external connection and a selection without a runnable
case behave as the plan says; stale and invalid cases and a case whose
reading fails are left out as the case's problem; a run writes no model
action; no row value of the live data reaches any prompt (E2 S7).
"""

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator, Callable, Sequence
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_helpers import Events
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session
from test_profile import SENTINELS, sentinel_csv

from geotandem.api.auth import require_admin
from geotandem.app import start
from geotandem.auth.accounts import list_accounts
from geotandem.catalog import get_layer
from geotandem.connections import Price
from geotandem.db.orm import EvalAnswer, EvalRun, Layer, LayerVisibility, ModelAction
from geotandem.evaluation import run as run_module
from geotandem.evaluation.figures import by_currency, cost
from geotandem.evaluation.grade import ReadingRefused
from geotandem.evaluation.run_store import RunStore
from geotandem.evaluation.schemas import EvalCase, RunExport
from geotandem.evaluation.store import CaseStore
from geotandem.importing.run import ImportDecisions, XYReference, run_import
from geotandem.levels import load_levels
from geotandem.llm import Completion, Endpoint, LLMError, Message, ModelInfo, ToolSpec
from geotandem.model.prompt import FIRST
from geotandem.model.schemas import Refusal

RUNS = "/api/admin/evaluation/runs"
CASES = "/api/admin/evaluation/cases"
CONNECTIONS = "/api/admin/llm/connections"
EVALUATION = "/api/admin/evaluation"

Body = dict[str, Any]
Answer = Callable[[int], Body | str | LLMError]
"""What a model answers to one question at a seed: an answer, raw text, or an error."""

TEXT = {"tags": ["text", "per-group"]}
"""Four start cases: ``text-beginnt-bern``, ``n15-je-gemeinde`` (tuning),
``h10-name-bahnhof``, ``h38-je-gemeinde`` (confirm)."""

BERN = {
    "source": "haltestellen",
    "where": {"op": "text_match", "attr": "name", "text": "Bern", "mode": "starts_with"},
}
BAHNHOF = {
    "source": "haltestellen",
    "where": {"op": "text_match", "attr": "name", "text": "Bahnhof", "mode": "contains"},
}
NOWHERE = {
    "source": "haltestellen",
    "where": {"op": "text_match", "attr": "name", "text": "Xyzzy", "mode": "contains"},
}


def query(q: Body, *, assumed: bool = False) -> Body:
    return {
        "kind": "query",
        "explanation": "Ich suche Haltestellen nach ihrem Namen.",
        "assumptions": [{"text": "„Name“ = Haltestellenname"}] if assumed else [],
        "query": {"schema_version": "2", **q},
    }


CANNOT: Body = {"kind": "cannot_answer", "explanation": "Zählen je Gemeinde kann ich nicht."}
ASK: Body = {
    "kind": "clarification",
    "question": "Welche Gemeinden meinen Sie?",
    "options": ["Alle", "Nur Bern"],
}

PROMPTS = {
    "text-beginnt-bern": "Haltestellen, deren Name mit Bern beginnt",
    "n15-je-gemeinde": "Wie viele Schulen gibt es in jeder Gemeinde?",
    "h10-name-bahnhof": "Haltestellen, die «Bahnhof» im Namen haben",
    "h38-je-gemeinde": "Wie viele Haltestellen hat jede Gemeinde?",
}

GOOD: dict[str, Answer] = {
    "text-beginnt-bern": lambda seed: query(NOWHERE) if seed == 3 else query(BERN),
    "n15-je-gemeinde": lambda seed: CANNOT,
    "h10-name-bahnhof": lambda seed: query(BAHNHOF),
    "h38-je-gemeinde": lambda seed: CANNOT,
}
"""Model ``gut``: one silently wrong answer with zero hits (seed 3)."""
WEAK: dict[str, Answer] = {
    "text-beginnt-bern": lambda seed: query(BERN),
    "n15-je-gemeinde": lambda seed: "kein JSON" if seed == 2 else CANNOT,
    "h10-name-bahnhof": lambda seed: query(NOWHERE, assumed=True),
    "h38-je-gemeinde": lambda seed: ASK if seed <= 5 else CANNOT,
}
"""Model ``schwach``: worse on both confirmation cases, one unreadable answer."""

EXPECTED: dict[str, dict[str, dict[str, int]]] = {
    "gut": {
        "text-beginnt-bern": {"pass": 9, "wrong": 1},
        "n15-je-gemeinde": {"pass": 10},
        "h10-name-bahnhof": {"pass": 10},
        "h38-je-gemeinde": {"pass": 10},
    },
    "schwach": {
        "text-beginnt-bern": {"pass": 10},
        "n15-je-gemeinde": {"pass": 9, "error": 1},
        "h10-name-bahnhof": {"wrong": 10},
        "h38-je-gemeinde": {"kind": 5, "pass": 5},
    },
}


class Model:
    """Every connection's model behind the client factory: answers by model
    name, question and seed; records every call's messages. ``released``
    cleared holds a call from the ``hold_from``-th on; ``asked`` says a held
    call came."""

    def __init__(self, scripts: dict[str, dict[str, Answer]]) -> None:
        self.scripts = scripts
        self.lock = threading.Lock()
        self.calls: list[tuple[str, int, tuple[Message, ...]]] = []
        self.schemas: list[dict[str, Any] | None] = []
        """The constrained output each call asked for (D9: none for output text)."""
        self.endpoints: list[Endpoint] = []
        self.released = threading.Event()
        self.released.set()
        self.asked = threading.Event()
        self.hold_from = 0
        self.deadlines: list[float | None] = []
        self.pause = 0.0
        """Seconds each call takes, so calls in different threads overlap."""
        self.active: set[str] = set()
        self.together: set[frozenset[str]] = set()
        """Models whose calls were in flight at the same time."""

    def __call__(self, endpoint: Endpoint) -> "Client":
        with self.lock:
            self.endpoints.append(endpoint)
        return Client(self, endpoint)

    def answer(
        self, endpoint: Endpoint, messages: Sequence[Message], deadline: float | None = None
    ) -> Completion:
        with self.lock:
            self.calls.append((endpoint.model, endpoint.seed or 0, tuple(messages)))
            self.deadlines.append(deadline)
            held = self.hold_from and len(self.calls) >= self.hold_from
            self.active.add(endpoint.model)
            if len(self.active) > 1:
                self.together.add(frozenset(self.active))
        try:
            return self._answer(endpoint, messages, held=bool(held))
        finally:
            with self.lock:
                self.active.discard(endpoint.model)

    def _answer(self, endpoint: Endpoint, messages: Sequence[Message], *, held: bool) -> Completion:
        if self.pause:
            time.sleep(self.pause)
        if held:
            self.asked.set()
            assert self.released.wait(10), "the test never released the model"
        text = messages[-1].content
        case_id = next(i for i, p in PROMPTS.items() if p == text)
        # Without a seed sent, the script answers as for the first repeat.
        found = self.scripts[endpoint.model][case_id](endpoint.seed or 1)
        if isinstance(found, LLMError):
            raise found
        if isinstance(found, str):
            return Completion(text=found, parse_error="not JSON", latency_ms=7)
        return Completion(
            text=json.dumps(found, ensure_ascii=False),
            parsed=found,
            latency_ms=100 * (endpoint.seed or 0),
            prompt_tokens=1000,
            completion_tokens=50,
        )

    def sent(self) -> str:
        return "\n".join(m.content for _, _, messages in self.calls for m in messages)


class Client:
    def __init__(self, model: Model, endpoint: Endpoint) -> None:
        self.model, self.endpoint = model, endpoint

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
        deadline: float | None = None,
    ) -> Completion:
        with self.model.lock:
            self.model.schemas.append(schema)
        return self.model.answer(self.endpoint, messages, deadline)

    def models(self) -> list[ModelInfo]:
        return []

    def server_version(self) -> str | None:
        return None

    def close(self) -> None:
        pass


async def connect(client: httpx.AsyncClient, name: str, model: str, **fields: Any) -> int:
    response = await client.post(
        CONNECTIONS,
        json={"name": name, "base_url": "http://127.0.0.1:11434/v1", "model": model, **fields},
    )
    assert response.status_code == 201, response.text
    connection_id: int = response.json()["id"]
    return connection_id


def level_id(app: FastAPI) -> int:
    level = next(lv for lv in load_levels(app.state.geotandem.backend.engine) if lv.is_default)
    assert level.id is not None
    return level.id


async def finished(app: FastAPI) -> None:
    await asyncio.to_thread(app.state.geotandem.runs.wait, 20)


async def run_to_end(client: httpx.AsyncClient, app: FastAPI, body: Body) -> Body:
    started = await client.post(RUNS, json=body)
    assert started.status_code == 202, started.text
    assert started.json()["status"] == "running"
    await finished(app)
    view = await client.get(f"{RUNS}/{started.json()['id']}")
    assert view.status_code == 200, view.text
    found: Body = view.json()
    return found


@pytest.fixture
async def model(client: httpx.AsyncClient, app: FastAPI) -> AsyncIterator[Model]:
    fake = Model({"gut": GOOD, "schwach": WEAK})
    app.state.geotandem.client_factory = fake
    yield fake
    fake.released.set()
    await finished(app)


@pytest.fixture
async def two(client: httpx.AsyncClient, app: FastAPI, model: Model) -> Body:
    """A full run request over the four cases: ``gut`` (the reference), ``schwach``."""
    good = await connect(client, "Gut", "gut", request_limit_enabled=True, request_limit_per_day=1)
    weak = await connect(client, "Schwach", "schwach")
    level = level_id(app)
    return {
        "points": [
            {"connection_id": good, "level_id": level},
            {"connection_id": weak, "level_id": level},
        ],
        "cases": TEXT,
    }


def cell_of(view: Body, case_id: str, point: int) -> Body:
    found: Body = next(c for c in view["cells"] if c["case_id"] == case_id and c["point"] == point)
    return found


# --- a run reproduces the script ------------------------------------------------


async def test_a_run_reproduces_the_scripted_verdicts(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    view = await run_to_end(client, app, two)
    assert view["status"] == "done", view
    assert view["progress"] == {"done": 80, "total": 80}
    assert [rc["case"]["id"] for rc in view["cases"]] == list(PROMPTS)
    for point, name in enumerate(("gut", "schwach")):
        for case_id, verdicts in EXPECTED[name].items():
            cell = cell_of(view, case_id, point)
            assert cell["verdicts"] == verdicts, (name, case_id)
            assert (cell["passed"], cell["answers"]) == (verdicts.get("pass", 0), 10)
    assert cell_of(view, "text-beginnt-bern", 0)["silently_wrong"] == 1
    assert cell_of(view, "h10-name-bahnhof", 1)["silently_wrong"] == 0  # it assumed
    # Seeds 1 to 10 in two blocks, at the connection's temperature (D7).
    assert sorted({e.seed for e in model.endpoints}) == list(range(1, 11))
    assert {e.temperature for e in model.endpoints} == {0}


async def test_the_figures_of_each_point(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    view = await run_to_end(client, app, two)
    good, weak = (p["figures"] for p in view["points"])
    assert (good["passed"], good["answers"]) == (39, 40)
    assert good["by_split"] == {
        "tuning": {"passed": 19, "answers": 20},
        "confirm": {"passed": 20, "answers": 20},
    }
    assert good["by_tag"]["text"] == {"passed": 19, "answers": 20}
    assert good["by_tag"]["per-group"] == {"passed": 20, "answers": 20}
    assert (good["rate_tuning"], good["rate_confirm"]) == (95.0, 100.0)
    assert (good["silently_wrong"], good["zero_hits"], good["unreadable"]) == (1, 1, 0)
    assert (good["behaviour_met"], good["behaviour_answers"]) == (20, 20)
    assert (good["latency_median_ms"], good["latency_p90_ms"]) == (550, 900)
    assert (good["prompt_tokens"], good["completion_tokens"]) == (40_000, 2_000)
    assert good["cost"] is None and good["limited"] == 0 and good["errors"] == {}
    assert weak["unreadable"] == 1 and weak["errors"] == {"model_unreadable": 1}
    assert (weak["silently_wrong"], weak["zero_hits"]) == (0, 10)
    assert (weak["behaviour_met"], weak["behaviour_answers"]) == (14, 20)
    assert weak["rate_confirm"] == 25.0
    # The answer that did not read keeps its tokens unknown, its text and time.
    unread = await client.get(
        f"{RUNS}/{view['id']}/answers", params={"case_id": "n15-je-gemeinde", "point": 1}
    )
    second = next(a for a in unread.json() if a["seed"] == 2)
    assert (second["verdict"], second["code"]) == ("error", "model_unreadable")
    assert (second["raw"], second["latency_ms"], second["answer"]) == ("kein JSON", 7, None)


async def test_the_comparison_is_taken_on_the_confirmation_cases(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Design review 1: ``schwach`` is better on a tuning case but worse on
    both confirmation cases; the words follow the confirmation cases only."""
    view = await run_to_end(client, app, two)
    reference, other = (p["comparison"] for p in view["points"])
    assert reference is None
    assert other["cases"] == 2
    assert (other["better"], other["worse"], other["same"]) == (0, 2, 0)
    assert other["mean"] == -75.0
    assert other["word"] == "worse"


async def test_a_quick_test_runs_one_block_without_comparison_words(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    view = await run_to_end(client, app, {**two, "scope": "quick"})
    assert view["status"] == "done"
    assert view["label"]["seeds"] == [1, 2, 3, 4, 5]
    assert view["progress"]["total"] == 40
    assert all(p["comparison"] is None for p in view["points"])
    assert all(p["figures"] is not None for p in view["points"])
    blocks = await client.get(
        f"{RUNS}/{view['id']}/answers", params={"case_id": "h10-name-bahnhof", "point": 0}
    )
    assert {a["block"] for a in blocks.json()} == {1}


async def test_the_label_records_what_the_run_measured_against(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    view = await run_to_end(client, app, two)
    label = view["label"]
    assert label["data_state"] == "sample" and label["sample_version"]
    assert (label["account"], label["started_by"], label["scope"]) == ("admin", "admin", "full")
    assert label["cases"] == 4 and len(label["case_set_hash"]) == 64
    assert label["profile"]["layers"] > 0
    assert label["query_schema"] == "2" and label["grading_version"] == 1
    point = view["points"][1]["label"]
    assert (point["connection_name"], point["model"], point["host"]) == (
        "Schwach",
        "schwach",
        "127.0.0.1",
    )
    assert point["prompt_profile"] == {
        "examples": "standard",
        "placement": "P0",
        "output": "constrained",
    }
    assert point["system_prompt"] is None


async def test_no_figures_while_the_run_runs(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Design review 5: cells as they come, the column heads only once done."""
    model.hold_from = 3
    model.released.clear()
    started = await client.post(RUNS, json={**two, "points": two["points"][:1]})
    assert await asyncio.to_thread(model.asked.wait, 10)
    view = (await client.get(f"{RUNS}/{started.json()['id']}")).json()
    assert view["status"] == "running"
    assert all(p["figures"] is None and p["comparison"] is None for p in view["points"])
    assert view["progress"] == {"done": 2, "total": 40}
    assert len(view["cells"]) == 1 and view["cells"][0]["answers"] == 2
    model.released.set()
    await finished(app)


async def test_an_edited_system_prompt_is_used_and_kept_with_the_run(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D10: a copy for this run only; the level itself is unchanged."""
    edited = "Antworte besonders vorsichtig. MARKE-4711"
    point = {**two["points"][0], "system_prompt": edited}
    view = await run_to_end(client, app, {**two, "points": [point], "scope": "quick"})
    label = view["points"][0]["label"]
    assert label["system_prompt"] == edited
    assert all(messages[0].content.startswith(edited) for _, _, messages in model.calls)
    level = next(lv for lv in load_levels(app.state.geotandem.backend.engine) if lv.is_default)
    assert "MARKE-4711" not in level.system_prompt


async def test_a_run_writes_no_model_action_and_ignores_the_request_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D8, D12: ``gut`` allows 1 request a day; the run asks it 40 times."""
    view = await run_to_end(client, app, two)
    assert view["status"] == "done"
    assert sum(1 for m, _, _ in model.calls if m == "gut") == 40
    with Session(app.state.geotandem.backend.engine) as db:
        assert db.scalar(select(func.count()).select_from(ModelAction)) == 0


# --- the run's lifecycle (D8) ---------------------------------------------------


async def test_abort_stops_before_the_next_question_and_keeps_the_answers(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    model.hold_from = 5
    model.released.clear()
    started = await client.post(RUNS, json={**two, "points": two["points"][:1]})
    run_id = started.json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)
    aborted = await client.post(f"{RUNS}/{run_id}/abort")
    assert aborted.status_code == 200, aborted.text
    assert aborted.json()["status"] == "aborted" and aborted.json()["finished_at"]
    model.released.set()
    await finished(app)
    view = (await client.get(f"{RUNS}/{run_id}")).json()
    assert view["status"] == "aborted"
    assert view["progress"]["done"] == 4  # the held answer is dropped
    assert all(p["figures"] is None for p in view["points"])
    assert len(model.calls) == 5  # nothing asked after the abort
    again = await client.post(f"{RUNS}/{run_id}/abort")
    assert again.json()["status"] == "aborted"


async def test_a_run_that_breaks_ends_failed_and_frees_the_instance(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    def broken(seed: int) -> Body:
        raise RuntimeError(PROMPTS["h10-name-bahnhof"])

    model.scripts["schwach"] = {**WEAK, "h10-name-bahnhof": broken}
    view = await run_to_end(client, app, two)
    assert (view["status"], view["error"]) == ("failed", "internal_error")
    assert all(p["figures"] is None for p in view["points"])
    again = await client.post(RUNS, json={**two, "points": two["points"][:1], "scope": "quick"})
    assert again.status_code == 202, again.text
    await finished(app)


async def test_one_run_at_a_time(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    model.hold_from = 1
    model.released.clear()
    first = await client.post(RUNS, json=two)
    assert await asyncio.to_thread(model.asked.wait, 10)
    second = await client.post(RUNS, json=two)
    assert second.status_code == 409, second.text
    assert second.json()["code"] == "run_busy"
    assert second.json()["details"]["run"] == first.json()["id"]
    model.released.set()
    await finished(app)
    third = await client.post(RUNS, json={**two, "scope": "quick"})
    assert third.status_code == 202, third.text
    await finished(app)


async def test_a_restart_closes_a_running_run_interrupted(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    model.hold_from = 4
    model.released.clear()
    started = await client.post(RUNS, json={**two, "points": two["points"][:1]})
    run_id = started.json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)

    state = start(app.state.geotandem.settings)  # the next process, on the same data core

    with Session(state.backend.engine) as db:
        row = db.get(EvalRun, run_id)
        assert row is not None and row.status == "interrupted" and row.finished_at is not None
    stored = RunStore(state.backend.engine).get(run_id)
    assert stored is not None and stored.progress.done == 3
    state.model_calls.shutdown()
    state.backend.engine.dispose()
    model.released.set()
    await finished(app)
    view = (await client.get(f"{RUNS}/{run_id}")).json()
    assert (view["status"], view["progress"]["done"]) == ("interrupted", 3)


async def test_an_external_connection_needs_the_confirmation_of_this_request(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """F-9.4, D12: the estimate names the host, the start refuses without it."""
    cloud = await connect(client, "Cloud", "gut", base_url="https://api.example.com/v1")
    point = {"connection_id": cloud, "level_id": level_id(app)}
    body = {**two, "points": [two["points"][0], point], "scope": "quick"}
    estimate = (await client.post(f"{RUNS}/estimate", json=body)).json()
    assert estimate["external_hosts"] == ["api.example.com"]
    refused = await client.post(RUNS, json=body)
    assert refused.status_code == 400, refused.text
    assert refused.json()["code"] == "external_not_confirmed"
    assert refused.json()["details"]["host"] == "api.example.com"
    assert refused.json()["details"]["reason"] == "missing"
    # Security review #49: the confirmation names the host it was given for.
    confirmed = {
        **body,
        "confirm_external": [cloud],
        "confirm_external_hosts": estimate["external_hosts"],
    }
    edited = await client.patch(
        f"{CONNECTIONS}/{cloud}", json={"base_url": "https://anderswo.example.org/v1"}
    )
    assert edited.status_code == 200, edited.text
    moved = await client.post(RUNS, json=confirmed)
    assert moved.status_code == 400, moved.text
    assert moved.json()["code"] == "external_not_confirmed"
    assert moved.json()["details"]["reason"] == "changed"
    assert moved.json()["details"]["host"] == "anderswo.example.org"
    ids_only = await client.post(RUNS, json={**body, "confirm_external": [cloud]})
    assert ids_only.json()["details"]["reason"] == "changed"
    assert model.calls == []
    back = await client.patch(
        f"{CONNECTIONS}/{cloud}", json={"base_url": "https://api.example.com/v1"}
    )
    assert back.status_code == 200, back.text
    view = await run_to_end(client, app, confirmed)
    assert view["status"] == "done"


async def test_a_selection_without_a_runnable_case_is_refused(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    for cases in ({"tags": ["kein-solcher-tag"]}, {"origins": ["authored"]}):
        for path in (RUNS, f"{RUNS}/estimate"):
            refused = await client.post(path, json={**two, "cases": cases})
            assert refused.status_code == 400, refused.text
            assert refused.json()["code"] == "no_cases"
    assert (await client.get(RUNS)).json()["total"] == 0


async def test_an_unknown_connection_or_level_is_not_found(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    for point in ({"connection_id": 999, "level_id": 1}, {**two["points"][0], "level_id": 999}):
        refused = await client.post(RUNS, json={**two, "points": [point]})
        assert refused.status_code == 404, refused.text


# --- cases that do not run (D3) ---------------------------------------------------


GOLD_OWN = {
    "id": "eigene-bern",
    "prompt": PROMPTS["text-beginnt-bern"],
    "tags": ["text"],
    "split": "tuning",
    "origin": "authored",
    "gold": BERN,
}


async def test_stale_and_invalid_cases_are_listed_but_not_asked(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    created = await client.post(CASES, json=GOLD_OWN)
    assert created.status_code == 201, created.text
    # A reference that no longer passes the checks, as an older version could leave it.
    broken = EvalCase.model_validate(
        {
            **GOLD_OWN,
            "id": "eigene-kaputt",
            "prompt": PROMPTS["h10-name-bahnhof"],
            "gold": {"source": "haltestellen", "where": {**BAHNHOF["where"], "attr": "fehlt"}},
        }
    )
    CaseStore(app.state.geotandem.backend.engine).add([broken], at_most=100)
    body = {**two, "cases": {"origins": ["authored"]}, "scope": "quick"}
    view = await run_to_end(client, app, body)
    statuses = {rc["case"]["id"]: rc["status"] for rc in view["cases"]}
    assert statuses == {"eigene-bern": "ok", "eigene-kaputt": "invalid"}
    assert view["label"]["cases"] == 1
    assert {c["case_id"] for c in view["cells"]} == {"eigene-bern"}
    assert view["progress"]["total"] == 10


async def test_a_stale_live_case_is_left_out(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    engine = app.state.geotandem.backend.engine
    info = get_layer(engine, "haltestellen")
    assert info is not None
    live = {
        **GOLD_OWN,
        "id": "live-bern",
        "data_state": "live",
        "layers": [{"name": "haltestellen", "dataset_version": info.dataset_version}],
    }
    assert (await client.post(CASES, json=live)).status_code == 201
    body = {**two, "cases": {"origins": ["authored"]}, "data_state": "live", "scope": "quick"}
    ran = await run_to_end(client, app, body)
    assert ran["status"] == "done" and ran["label"]["cases"] == 1
    assert ran["label"]["dataset_versions"] == {"haltestellen": info.dataset_version}
    assert ran["label"]["sample_version"] is None
    deleted = await client.delete("/api/admin/layers/haltestellen")
    assert deleted.status_code == 204, deleted.text
    refused = await client.post(RUNS, json=body)
    assert refused.status_code == 400 and refused.json()["code"] == "no_cases"


async def test_a_failing_reading_is_the_cases_problem(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    two: Body,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Open for E3.3: a reading that cannot be read at run time skips the case,
    marked ``invalid`` in the run, and blames no answer."""
    real = run_module.reading_ids

    def reading_ids(case: EvalCase, *args: Any) -> Any:
        if case.id == "h10-name-bahnhof":
            raise ReadingRefused(0, Refusal(code="unknown_attribute", message="gone"))
        return real(case, *args)

    monkeypatch.setattr(run_module, "reading_ids", reading_ids)
    view = await run_to_end(client, app, {**two, "scope": "quick"})
    assert view["status"] == "done"
    statuses = {rc["case"]["id"]: rc["status"] for rc in view["cases"]}
    assert statuses["h10-name-bahnhof"] == "invalid"
    assert "h10-name-bahnhof" not in {c["case_id"] for c in view["cells"]}
    assert view["progress"] == {"done": 30, "total": 30}
    assert all(PROMPTS["h10-name-bahnhof"] != msgs[-1].content for _, _, msgs in model.calls)
    # The comparison has one confirmation case left.
    assert view["points"][0]["figures"]["by_split"]["confirm"]["answers"] == 5
    # The label counts and hashes the cases asked (review B1), the list too.
    asked = [rc["case"] for rc in view["cases"] if rc["status"] != "invalid"]
    expected = run_module.case_set_hash(EvalCase.model_validate(c) for c in asked)
    assert (view["label"]["cases"], view["label"]["case_set_hash"]) == (3, expected)
    summary = (await client.get(RUNS)).json()["items"][0]
    assert (summary["cases"], summary["case_set_hash"]) == (3, expected)
    with Session(app.state.geotandem.backend.engine) as db:
        row = db.get(EvalRun, view["id"])
        assert row is not None and row.case_set_hash == expected


async def test_a_run_whose_every_reading_fails_ends_failed_without_cases(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    two: Body,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reading_ids(case: EvalCase, *args: Any) -> Any:
        raise ReadingRefused(0, Refusal(code="unknown_attribute", message="gone"))

    monkeypatch.setattr(run_module, "reading_ids", reading_ids)
    body = {**two, "cases": {"tags": ["text"]}, "scope": "quick"}
    view = await run_to_end(client, app, body)
    assert (view["status"], view["error"]) == ("failed", "no_cases")
    assert view["label"]["cases"] == 0 and model.calls == []


# --- no row value in a prompt (E2 S7) ------------------------------------------


async def test_no_row_value_reaches_a_prompt_of_a_live_run(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body, tmp_path: Path
) -> None:
    backend = app.state.geotandem.backend
    stops = backend.layer_table("haltestellen")
    with backend.engine.begin() as db:
        db.execute(update(stops).values(name=stops.c.name + f" {SENTINELS[0]}"))
    run = run_import(
        sentinel_csv(tmp_path),
        "sentinel.csv",
        ImportDecisions(
            layer_name="zz_geheim",
            title="Geheim",
            geo=XYReference(x="E", y="N", crs=2056),
            for_model=False,
        ),
        backend,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run
    info = get_layer(backend.engine, "haltestellen")
    assert info is not None
    live = {
        **GOLD_OWN,
        "id": "live-bern",
        "data_state": "live",
        "layers": [{"name": "haltestellen", "dataset_version": info.dataset_version}],
    }
    assert (await client.post(CASES, json=live)).status_code == 201
    body = {**two, "cases": {"origins": ["authored"]}, "data_state": "live"}
    view = await run_to_end(client, app, body)
    assert view["status"] == "done" and len(model.calls) == 20
    sent = model.sent()
    assert "haltestellen" in sent  # the profile went, the rows did not
    assert [s for s in SENTINELS if s in sent] == []
    assert "zz_geheim" not in sent


# --- reading a run ----------------------------------------------------------------


async def test_the_answers_of_a_case_at_a_point(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    view = await run_to_end(client, app, two)
    url = f"{RUNS}/{view['id']}/answers"
    found = (await client.get(url, params={"case_id": "text-beginnt-bern", "point": 0})).json()
    assert [a["seed"] for a in found] == list(range(1, 11))
    assert [a["block"] for a in found] == [1] * 5 + [2] * 5
    wrong = found[2]
    assert (wrong["verdict"], wrong["flags"]) == ("wrong", ["no_assumption", "zero_hits"])
    assert wrong["hits"] == 0 and wrong["reference_hits"] == wrong["only_reference_count"] > 0
    assert wrong["diff"] and wrong["answer"]["kind"] == "query"
    assert (wrong["prompt_tokens"], wrong["completion_tokens"], wrong["latency_ms"]) == (
        1000,
        50,
        300,
    )
    right = found[0]
    assert (right["verdict"], right["diff"], right["reading"]) == ("pass", [], 0)
    for params in (
        {"case_id": "doc1-primar-koeniz", "point": 0},
        {"case_id": "h10-name-bahnhof", "point": 2},
    ):
        assert (await client.get(url, params=params)).status_code == 404
    missing = await client.get(
        f"{RUNS}/999/answers", params={"case_id": "h10-name-bahnhof", "point": 0}
    )
    assert missing.status_code == 404


async def test_the_export_holds_the_run_and_every_answer(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    view = await run_to_end(client, app, {**two, "scope": "quick"})
    exported = await client.get(f"{RUNS}/{view['id']}/export")
    assert exported.status_code == 200, exported.text
    body = exported.json()
    assert body["run"]["id"] == view["id"] and len(body["answers"]) == 40
    # Every key of the schema, the required nullable ones too (``RunExport``).
    RunExport.model_validate(body)
    assert all("latency_ms" in a and "answer" in a for a in body["answers"])
    assert "error" in body["run"] and body["run"]["error"] is None
    assert body["answers"] == [
        a
        for point in range(2)
        for case_id in PROMPTS
        for a in (
            await client.get(
                f"{RUNS}/{view['id']}/answers", params={"case_id": case_id, "point": point}
            )
        ).json()
    ]
    assert (await client.get(f"{RUNS}/999/export")).status_code == 404


async def test_the_export_is_read_and_written_in_batches(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    two: Body,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Security review #46: a few answers at a time, never the whole run at once."""
    view = await run_to_end(client, app, {**two, "scope": "quick"})
    seen: list[int] = []
    real = RunStore.answer_batches

    def counted(self: RunStore, run_id: int, size: int = 7) -> Any:
        for batch in real(self, run_id, 7):
            seen.append(len(batch))
            yield batch

    monkeypatch.setattr(RunStore, "answer_batches", counted)
    exported = await client.get(f"{RUNS}/{view['id']}/export")
    assert exported.status_code == 200, exported.text
    assert len(exported.json()["answers"]) == 40
    assert seen == [7] * 5 + [5]


async def test_the_list_of_runs_and_a_connections_runs(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    first = await run_to_end(client, app, {**two, "points": two["points"][:1], "scope": "quick"})
    second = await run_to_end(client, app, two)
    page = (await client.get(RUNS)).json()
    assert page["total"] == 2
    assert [item["id"] for item in page["items"]] == [second["id"], first["id"]]
    newest = page["items"][0]
    assert newest["points"] == 2 and newest["cases"] == 4
    assert newest["reference_rate"] == 95.0 and newest["status"] == "done"
    weak = two["points"][1]["connection_id"]
    mine = (await client.get(RUNS, params={"connection_id": weak})).json()
    assert [item["id"] for item in mine["items"]] == [second["id"]]
    assert (await client.get(f"{RUNS}/999")).status_code == 404


# --- two runs side by side (D7) ----------------------------------------------------


async def test_two_complete_runs_over_the_same_cases_are_compared(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    good, weak = two["points"]
    before = await run_to_end(client, app, {**two, "points": [weak]})
    after = await run_to_end(client, app, {**two, "points": [weak, good]})
    compared = await client.post(
        "/api/admin/evaluation/comparison", json={"run": after["id"], "against": before["id"]}
    )
    assert compared.status_code == 200, compared.text
    rows = compared.json()["points"]
    assert len(rows) == 1  # only the point both ran
    row = rows[0]
    assert row["label"]["connection_name"] == "Schwach"
    assert row["rate"] == row["rate_against"] == 95.0
    assert row["comparison"]["word"] == "not_proven"
    assert row["comparison"]["same"] == 2


async def test_runs_not_comparable(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    full = await run_to_end(client, app, two)
    other_cases = await run_to_end(client, app, {**two, "cases": {"tags": ["text"]}})
    model.hold_from = 1
    model.released.clear()
    running = await client.post(RUNS, json=two)
    assert await asyncio.to_thread(model.asked.wait, 10)
    for against in (other_cases["id"], running.json()["id"]):
        refused = await client.post(
            "/api/admin/evaluation/comparison", json={"run": full["id"], "against": against}
        )
        assert refused.status_code == 409, refused.text
        assert refused.json()["code"] == "runs_not_comparable"
    model.released.set()
    await finished(app)
    missing = await client.post(
        "/api/admin/evaluation/comparison", json={"run": full["id"], "against": 999}
    )
    assert missing.status_code == 404


# --- the estimate (D12) ------------------------------------------------------------


async def test_the_estimate_counts_requests_tokens_and_time_per_connection(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    good, weak = two["points"]
    body = {**two, "points": [good, weak, {**weak, "system_prompt": "Kurz."}]}
    first = (await client.post(f"{RUNS}/estimate", json=body)).json()
    assert first["cases"] == 4 and first["requests"] == 120
    by_id = {e["connection_id"]: e for e in first["connections"]}
    assert (by_id[good["connection_id"]]["points"], by_id[good["connection_id"]]["requests"]) == (
        1,
        40,
    )
    assert by_id[weak["connection_id"]]["requests"] == 80
    # No run and no test yet: the default latency per request, marked so.
    assert by_id[weak["connection_id"]]["duration_s"] == 80 * run_module.DEFAULT_LATENCY_S
    assert not any(e["duration_measured"] for e in first["connections"])
    # Both connections are on 127.0.0.1: one queue, so their times add up (D8).
    assert first["duration_s"] == 120 * run_module.DEFAULT_LATENCY_S
    assert all(e["cost"] is None for e in first["connections"]) and first["cost"] == []
    assert first["external_hosts"] == []
    assert by_id[good["connection_id"]]["tokens"] > 40 * run_module.ANSWER_ESTIMATE
    assert first["tokens"] == sum(e["tokens"] for e in first["connections"])
    assert model.calls == []  # no model call

    await run_to_end(client, app, {**two, "points": [good], "scope": "quick"})
    # Now the median latency of the connection's last run: 100 ms times the seed, 1 to 5.
    after = (await client.post(f"{RUNS}/estimate", json=body)).json()
    by_id = {e["connection_id"]: e for e in after["connections"]}
    assert by_id[good["connection_id"]]["duration_s"] == 12
    assert by_id[good["connection_id"]]["duration_measured"] is True
    assert by_id[weak["connection_id"]]["duration_s"] == 80 * run_module.DEFAULT_LATENCY_S
    assert by_id[weak["connection_id"]]["duration_measured"] is False
    assert after["duration_s"] == 12 + 80 * run_module.DEFAULT_LATENCY_S
    # On another host the weak connection runs at the same time: the longer one counts.
    patched = await client.patch(
        f"{CONNECTIONS}/{weak['connection_id']}", json={"base_url": "http://localhost:11434/v1"}
    )
    assert patched.status_code == 200, patched.text
    apart = (await client.post(f"{RUNS}/estimate", json=body)).json()
    assert apart["duration_s"] == 80 * run_module.DEFAULT_LATENCY_S


async def test_the_key_goes_to_the_call_and_nowhere_else(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    two: Body,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """C8: the run's endpoint carries the key; no row, view or log line does."""
    key = "sk-geheim-4711-schluessel"
    keyed = await connect(client, "Mit Schluessel", "gut", api_key=key)
    caplog.set_level("DEBUG")
    body = {**two, "points": [{**two["points"][0], "connection_id": keyed}], "scope": "quick"}
    view = await run_to_end(client, app, body)
    assert view["status"] == "done"
    assert {e.api_key for e in model.endpoints} == {key}
    exported = (await client.get(f"{RUNS}/{view['id']}/export")).text
    with Session(app.state.geotandem.backend.engine) as db:
        row = db.get(EvalRun, view["id"])
        assert row is not None
        stored = json.dumps([row.request, row.label, row.points, row.prices])
    assert key not in exported and key not in stored and key not in caplog.text
    assert PROMPTS["h10-name-bahnhof"] not in caplog.text  # nor a question (C15)


# --- prompt profiles and prices (D9, D12, O4; WP91) ---------------------------------


async def test_a_point_sends_its_prompt_profile(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """A point's own profile is measured without changing the connection: P9
    sends three messages, the user message the question alone; output text
    sends no constrained output."""
    own = {"examples": "12", "placement": "P9", "output": "text"}
    point = {**two["points"][0], "prompt_profile": own}
    view = await run_to_end(client, app, {**two, "points": [point], "scope": "quick"})
    assert view["status"] == "done", view
    assert view["points"][0]["label"]["prompt_profile"] == own
    assert model.calls and all(
        [m.role for m in messages] == ["system", "system", "user"]
        and messages[1] == Message("system", FIRST)
        and messages[2].content in PROMPTS.values()
        for _, _, messages in model.calls
    )
    assert set(map(json.dumps, model.schemas)) == {"null"}
    connection = (await client.get(f"{CONNECTIONS}/{point['connection_id']}")).json()
    assert connection["prompt_profile"]["placement"] == "P0"  # the connection is unchanged


async def test_a_point_without_a_profile_takes_the_connections(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    good = two["points"][0]
    own = {"examples": "standard", "placement": "P5", "output": "constrained"}
    patched = await client.patch(
        f"{CONNECTIONS}/{good['connection_id']}", json={"prompt_profile": own}
    )
    assert patched.status_code == 200, patched.text
    view = await run_to_end(client, app, {**two, "points": [good], "scope": "quick"})
    assert view["points"][0]["label"]["prompt_profile"] == own
    for _, _, messages in model.calls:
        system = messages[0].content
        assert system.index("# Beispiele") < system.index("# Layer-Steckbrief")
    assert model.schemas and all(s is not None for s in model.schemas)


async def test_cost_and_estimate_in_money_from_the_connections_prices(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """The scripted answers report 1000 tokens in and 50 out: at 1 and 2 CHF
    per million each costs 0.0011 CHF."""
    good = two["points"][0]
    priced = {"price_input_per_mtok": 1, "price_output_per_mtok": 2, "price_currency": "CHF"}
    patched = await client.patch(f"{CONNECTIONS}/{good['connection_id']}", json=priced)
    assert patched.status_code == 200, patched.text
    body = {**two, "points": [good], "scope": "quick"}
    estimate = (await client.post(f"{RUNS}/estimate", json=body)).json()
    [connection] = estimate["connections"]
    assert connection["cost"]["currency"] == "CHF" and connection["cost"]["amount"] > 0
    assert estimate["cost"] == [connection["cost"]]

    view = await run_to_end(client, app, body)
    answers = view["points"][0]["figures"]["answers"]
    assert view["points"][0]["figures"]["cost"] == {
        "amount": round(answers * 0.0011, 4),
        "currency": "CHF",
    }


def test_figures_cost_money_with_a_price() -> None:
    price = Price(input_per_million=0.8, output_per_million=4.0, currency="USD")
    found = cost(price, 1_000_000, 100_000)
    assert found is not None and found.amount == 1.2
    assert cost(None, 1, 1) is None
    assert by_currency([found, found, None])[0].amount == 2.4


# --- Gate E3 -----------------------------------------------------------------------


async def test_a_start_and_an_abort_are_security_events(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body, events: Events
) -> None:
    """Security review #50: which connections, which external hosts were
    confirmed, how many requests, on which data; never a prompt."""
    cloud = await connect(client, "Cloud", "gut", base_url="https://api.example.com/v1")
    point = {"connection_id": cloud, "level_id": level_id(app)}
    body = {
        **two,
        "points": [two["points"][0], point],
        "scope": "quick",
        "confirm_external": [cloud],
        "confirm_external_hosts": ["api.example.com"],
    }
    events.clear()
    model.hold_from = 3
    model.released.clear()
    started = await client.post(RUNS, json=body)
    assert started.status_code == 202, started.text
    run_id = started.json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)
    assert (await client.post(f"{RUNS}/{run_id}/abort")).status_code == 200
    assert (await client.post(f"{RUNS}/{run_id}/abort")).status_code == 200  # once is logged
    model.released.set()
    await finished(app)
    found = [e for e in events if e["event"].startswith("evaluation_run")]
    assert [e["event"] for e in found] == ["evaluation_run_started", "evaluation_run_aborted"]
    begun, aborted = found
    assert {k: begun[k] for k in begun if k not in ("address", "method", "path")} == {
        "event": "evaluation_run_started",
        "username": "admin",
        "run": run_id,
        "connection_ids": sorted([two["points"][0]["connection_id"], cloud]),
        "external_hosts": ["api.example.com"],
        "requests": 40,
        "data_state": "sample",
        "scope": "quick",
    }
    assert (aborted["run"], aborted["username"]) == (run_id, "admin")
    logged = json.dumps(events)
    assert all(prompt not in logged for prompt in PROMPTS.values())


async def test_a_case_whose_dataset_changed_runs_and_is_marked(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D3: run, marked ``dataset_changed``, its layer's version as it is now in the label."""
    engine = app.state.geotandem.backend.engine
    info = get_layer(engine, "haltestellen")
    assert info is not None
    live = {
        **GOLD_OWN,
        "id": "live-bern",
        "data_state": "live",
        "layers": [{"name": "haltestellen", "dataset_version": info.dataset_version}],
    }
    assert (await client.post(CASES, json=live)).status_code == 201
    with Session(engine) as db, db.begin():
        db.execute(update(Layer).where(Layer.name == "haltestellen").values(dataset_version="neu"))
    body = {**two, "cases": {"origins": ["authored"]}, "data_state": "live", "scope": "quick"}
    view = await run_to_end(client, app, body)
    assert view["status"] == "done"
    assert [(rc["case"]["id"], rc["status"]) for rc in view["cases"]] == [
        ("live-bern", "dataset_changed")
    ]
    assert view["label"]["cases"] == 1
    assert cell_of(view, "live-bern", 0)["answers"] == 5
    assert view["label"]["dataset_versions"] == {"haltestellen": "neu"}


async def test_the_labels_profile_is_the_summary_of_its_data_state(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D11: the run records what ``GET /profile-summary`` shows for the same data state."""
    sample = await run_to_end(client, app, {**two, "scope": "quick"})
    summary = await client.get(f"{EVALUATION}/profile-summary", params={"data_state": "sample"})
    assert sample["label"]["profile"] == summary.json()
    info = get_layer(app.state.geotandem.backend.engine, "haltestellen")
    assert info is not None
    live = {
        **GOLD_OWN,
        "id": "live-bern",
        "data_state": "live",
        "layers": [{"name": "haltestellen", "dataset_version": info.dataset_version}],
    }
    assert (await client.post(CASES, json=live)).status_code == 201
    body = {**two, "cases": {"origins": ["authored"]}, "data_state": "live", "scope": "quick"}
    ran = await run_to_end(client, app, body)
    summary = await client.get(f"{EVALUATION}/profile-summary", params={"data_state": "live"})
    assert ran["label"]["profile"] == summary.json()


async def test_a_live_run_uses_the_view_of_the_account_that_starts_it(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D4: an account whose role does not see ``haltestellen`` finds its case
    stale and its profile without the layer; the label names the account."""
    engine = app.state.geotandem.backend.engine
    created = await client.post("/api/admin/users", json={"username": "m.keller", "role": "user"})
    assert created.status_code == 201, created.text
    info, schulen = get_layer(engine, "haltestellen"), get_layer(engine, "schulen")
    assert info is not None and schulen is not None
    stops = {
        **GOLD_OWN,
        "id": "live-bern",
        "data_state": "live",
        "layers": [{"name": "haltestellen", "dataset_version": info.dataset_version}],
    }
    schools = {
        **GOLD_OWN,
        "id": "live-schulen",
        "prompt": PROMPTS["n15-je-gemeinde"],
        "data_state": "live",
        "gold": {"source": "schulen"},
        "layers": [{"name": "schulen", "dataset_version": schulen.dataset_version}],
    }
    for case in (stops, schools):
        assert (await client.post(CASES, json=case)).status_code == 201
    with Session(engine) as db, db.begin():
        layer = db.scalar(select(Layer.id).where(Layer.name == "haltestellen"))
        db.execute(
            delete(LayerVisibility).where(
                LayerVisibility.layer_id == layer, LayerVisibility.role == "user"
            )
        )
    keller = next(a for a in list_accounts(engine) if a.username == "m.keller")
    restricted = await client.get(
        f"{EVALUATION}/profile-summary", params={"data_state": "live", "account": "m.keller"}
    )
    own = await client.get(f"{EVALUATION}/profile-summary", params={"data_state": "live"})
    assert restricted.json()["layers"] < own.json()["layers"]
    app.dependency_overrides[require_admin] = lambda: keller
    try:
        body = {**two, "cases": {"origins": ["authored"]}, "data_state": "live", "scope": "quick"}
        view = await run_to_end(client, app, body)
    finally:
        del app.dependency_overrides[require_admin]
    assert view["status"] == "done", view
    statuses = {rc["case"]["id"]: rc["status"] for rc in view["cases"]}
    assert statuses == {"live-bern": "stale", "live-schulen": "ok"}
    assert (view["label"]["account"], view["label"]["started_by"]) == ("m.keller", "m.keller")
    assert view["label"]["profile"] == restricted.json()
    assert "# haltestellen" not in model.sent() and "haltestellen" not in model.sent()


async def test_a_large_refused_query_is_stored_bounded(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Security review #45: a run keeps an answer as the record does; a refused
    query of 1 MB is kept as ``{"omitted": "too large"}``."""
    huge = {
        "source": "haltestellen",
        "where": {"op": "text_match", "attr": "fehlt", "text": "x" * 1_000_000, "mode": "contains"},
    }
    model.scripts["gut"] = {**GOOD, "h10-name-bahnhof": lambda seed: query(huge)}
    view = await run_to_end(client, app, {**two, "points": two["points"][:1], "scope": "quick"})
    assert view["status"] == "done"
    found = await client.get(
        f"{RUNS}/{view['id']}/answers", params={"case_id": "h10-name-bahnhof", "point": 0}
    )
    first = found.json()[0]
    assert first["verdict"] == "refused", first["verdict"]
    assert first["answer"]["query"] == {"omitted": "too large"}
    with Session(app.state.geotandem.backend.engine) as db:
        longest = db.scalar(select(func.max(func.length(EvalAnswer.answer))))
        assert longest is not None and longest < 64 * 1024


async def test_points_are_matched_on_their_whole_snapshot(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """Section 2: a connection edited between two runs (here its temperature) is
    another measuring point; its rates are not put side by side."""
    good, weak = two["points"]
    before = await run_to_end(client, app, {**two, "points": [weak, good]})
    patched = await client.patch(
        f"{CONNECTIONS}/{weak['connection_id']}", json={"temperature": 0.5}
    )
    assert patched.status_code == 200, patched.text
    after = await run_to_end(client, app, {**two, "points": [good, weak]})
    compared = await client.post(
        f"{EVALUATION}/comparison", json={"run": after["id"], "against": before["id"]}
    )
    assert compared.status_code == 200, compared.text
    rows = compared.json()["points"]
    assert [(r["label"]["connection_name"], r["point"], r["point_against"]) for r in rows] == [
        ("Gut", 0, 1)
    ]


async def test_a_quick_test_against_a_full_run_has_no_words(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """D7, O2: one block is no sample for the comparison words."""
    weak = two["points"][1]
    full = await run_to_end(client, app, {**two, "points": [weak]})
    quick = await run_to_end(client, app, {**two, "points": [weak], "scope": "quick"})
    for run, against in ((full, quick), (quick, full)):
        compared = await client.post(
            f"{EVALUATION}/comparison", json={"run": run["id"], "against": against["id"]}
        )
        assert compared.status_code == 200, compared.text
        [row] = compared.json()["points"]
        assert row["comparison"] is None and row["rate"] is not None


async def test_a_run_without_tuning_cases_heads_with_its_confirmation_rate(
    client: httpx.AsyncClient, app: FastAPI, model: Model, two: Body
) -> None:
    """The list shows the reference point's rate on Bestätigung, named so."""
    body = {**two, "cases": {**TEXT, "split": "confirm"}, "scope": "quick"}
    view = await run_to_end(client, app, body)
    figures = view["points"][0]["figures"]
    assert figures["rate_tuning"] is None and figures["rate_confirm"] == 100.0
    [summary] = (await client.get(RUNS)).json()["items"]
    assert (summary["reference_rate"], summary["reference_split"]) == (100.0, "confirm")
    full = await run_to_end(client, app, {**two, "scope": "quick"})
    newest = (await client.get(RUNS)).json()["items"][0]
    assert newest["id"] == full["id"]
    assert (newest["reference_rate"], newest["reference_split"]) == (90.0, "tuning")
