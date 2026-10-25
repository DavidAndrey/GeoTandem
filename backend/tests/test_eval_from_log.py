"""Cases from the model log (plan E3, WP92, F-3.14, decision 2).

A logged direct query the user accepted, or that ran unasked and was not
taken back, becomes the draft of a case without typing its query; a chain, a
follow-up, a refused, answered or open action, an adjusted one, an undone one
and one whose analysis was edited by hand afterwards do not. ``POST /cases`` with ``origin: log``
holds the same rule, so a corrected answer cannot become a case by hand. The
saved case passes against itself: its reference counts what the action's
query counts, and the action's answer grades ``pass``.
"""

from typing import Any

import httpx
import pytest
from api_helpers import USER_PASSWORD
from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.orm import Session
from test_model_log import account, store_of
from test_model_record import ANSWER, APPROVE, CLARIFICATION, PROMPT, STAMP, build, new

from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.db.orm import ModelAction
from geotandem.engine import count_query
from geotandem.evaluation.grade import grade
from geotandem.evaluation.schemas import EvalCase
from geotandem.model.record import ModelActionStore
from geotandem.model.schemas import QueryAnswer
from geotandem_query import QueryObject

CASES = "/api/admin/evaluation/cases"
DRAFT = f"{CASES}/draft-from-action"


NEAR = {
    "schema_version": "2",
    "source": "schulen",
    "output": "map",
    "where": {
        "op": "and",
        "args": [
            {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"},
            {"op": "related", "layer": "strassen", "predicate": "dwithin", "distance_m": 300},
        ],
    },
}
"""A query on layers the administrator's model sees in the live catalog (the
fixture's ``reference`` also names ``gemeinden_steuern``, which it does not)."""


def accepted(app: FastAPI, query: dict[str, Any]) -> tuple[int, QueryAnswer, QueryObject]:
    """A direct query of the administrator, proposed with ``query`` and accepted."""
    store, admin = admin_store(app)
    answer = QueryAnswer(kind="query", explanation="Primarschulen nahe einer Strasse.", query=query)
    checked = QueryObject.model_validate(query)
    action_id = new(store, admin, supersede=False).id
    store.propose(admin, action_id, answer, query=checked, governance=APPROVE, latency_ms=900)
    store.approve(admin, action_id)
    store.execute(admin, action_id, STAMP)
    return action_id, answer, checked


def admin_store(app: FastAPI) -> tuple[ModelActionStore, Account]:
    return store_of(app), account(app, "admin")


def action(app: FastAPI, end: str, **fields: Any) -> int:
    """A record of the administrator that ends in ``end`` (``test_model_record.build``)."""
    store, admin = admin_store(app)
    return build(store, admin, end, **fields)


def as_case(draft: dict[str, Any], **extra: Any) -> dict[str, Any]:
    """The draft as the administrator saves it: with an id and a tag."""
    return {**draft, "id": "aus-protokoll", "tags": ["protokoll"], **extra}


async def test_an_accepted_direct_query_becomes_a_draft(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    action_id = action(app, "accepted")
    response = await client.get(f"{DRAFT}/{action_id}")
    assert response.status_code == 200, response.text
    reference = {k: v for k, v in ANSWER.query.items() if k not in ("schema_version", "output")}
    assert response.json() == {
        "prompt": PROMPT,
        "data_state": "live",
        "origin_action": action_id,
        "schema_version": "2",
        "gold": reference,
        "gold_any": None,
        "require": None,
        "expect": None,
        "also": [],
        "forbid": [],
        "other_approach": None,
        "note": "",
        "layers": [
            {"name": "gemeinden_steuern", "dataset_version": None},
            {"name": "schulen", "dataset_version": None},
            {"name": "strassen", "dataset_version": None},
        ],
        "split": "confirm",
        "origin": "log",
    }


async def test_an_auto_query_not_undone_becomes_a_draft(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    action_id = action(app, "auto")
    response = await client.get(f"{DRAFT}/{action_id}")
    assert response.status_code == 200, response.text
    assert response.json()["origin_action"] == action_id


async def test_the_draft_stores_nothing(client: httpx.AsyncClient, app: FastAPI) -> None:
    await client.get(f"{DRAFT}/{action(app, 'accepted')}")
    listed = (await client.get(CASES, params={"origin": "log"})).json()
    assert listed["total"] == 0


def touched(app: FastAPI) -> int:
    """Accepted, then the analysis was edited by hand (design rule 7)."""
    store, admin = admin_store(app)
    action_id = build(store, admin, "accepted")
    store.touch(admin, action_id)
    return action_id


def answered(app: FastAPI) -> int:
    """A clarification: nothing proposed, no decision."""
    store, admin = admin_store(app)
    action_id = new(store, admin, supersede=False).id
    store.answer(admin, action_id, CLARIFICATION)
    return action_id


def without_query(app: FastAPI) -> int:
    """Accepted, but the record holds no query (a state the flow does not
    reach; the rule must not lean on that)."""
    action_id = action(app, "accepted")
    with Session(app.state.geotandem.backend.engine) as db, db.begin():
        db.execute(update(ModelAction).where(ModelAction.id == action_id).values(query=None))
    return action_id


def follow_up(app: FastAPI) -> int:
    """An accepted follow-up of an accepted direct query."""
    parent = action(app, "accepted")
    return action(app, "accepted", parent_action_id=parent)


INELIGIBLE: dict[str, tuple[Any, str, str | None]] = {
    "follow-up": (follow_up, "follow_up", "accepted"),
    "answered": (answered, "decision", None),
    "no query": (without_query, "no_query", "accepted"),
    "adjusted": (lambda app: action(app, "adjusted"), "decision", "adjusted"),
    "auto undone": (lambda app: action(app, "auto_undone"), "undone", "auto"),
    "accepted undone": (lambda app: action(app, "accepted_undone"), "undone", "accepted"),
    "chain": (lambda app: action(app, "accepted", approach="chain"), "approach", "accepted"),
    "refused": (lambda app: action(app, "refused"), "decision", None),
    "rejected": (lambda app: action(app, "rejected"), "decision", "rejected"),
    "proposal only": (lambda app: action(app, "proposal_only"), "decision", "proposal_only"),
    "touched": (touched, "touched", "accepted"),
}


@pytest.mark.parametrize("kind", list(INELIGIBLE))
async def test_other_actions_give_no_draft(
    client: httpx.AsyncClient, app: FastAPI, kind: str
) -> None:
    make, reason, decision = INELIGIBLE[kind]
    action_id = make(app)
    response = await client.get(f"{DRAFT}/{action_id}")
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "action_not_eligible"
    assert body["details"]["decision"] == decision
    assert body["details"]["reason"] == reason
    assert body["details"]["action_id"] == action_id


async def test_an_action_of_another_account_is_taken_as_the_log_shows_it(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """D4: administrators read every account's log; the case is the administrator's."""
    engine = app.state.geotandem.backend.engine
    anna = accounts.create(engine, "anna", USER_PASSWORD, "user")
    action_id = build(store_of(app), anna, "accepted")
    response = await client.get(f"{DRAFT}/{action_id}")
    assert response.status_code == 200, response.text
    assert response.json()["origin_action"] == action_id


async def test_an_unknown_action_is_not_found(client: httpx.AsyncClient) -> None:
    response = await client.get(f"{DRAFT}/4711")
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


async def test_the_draft_saved_becomes_a_case_that_passes_against_itself(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    action_id, answer, query = accepted(app, NEAR)
    draft = (await client.get(f"{DRAFT}/{action_id}")).json()
    assert draft["layers"] == [
        {"name": "schulen", "dataset_version": None},
        {"name": "strassen", "dataset_version": None},
    ]
    response = await client.post(CASES, json=as_case(draft))
    assert response.status_code == 201, response.text
    view = response.json()
    case = EvalCase.model_validate(view["case"])
    assert (case.origin, case.origin_action, case.split) == ("log", action_id, "confirm")
    assert all(layer.dataset_version for layer in case.layers)  # stamped on save (D3)
    state = app.state.geotandem
    assert view["status"] == "ok"
    assert view["reference_hits"] == [count_query(query, state.backend, state.limits)]
    graded = grade(case, answer, None, query, state.backend, state.limits)
    assert graded.verdict == "pass"


@pytest.mark.parametrize("kind", ["adjusted", "auto undone", "chain", "touched", "follow-up"])
async def test_a_log_case_of_an_ineligible_action_is_refused_by_hand(
    client: httpx.AsyncClient, app: FastAPI, kind: str
) -> None:
    eligible = (await client.get(f"{DRAFT}/{accepted(app, NEAR)[0]}")).json()
    make, reason, decision = INELIGIBLE[kind]
    action_id = make(app)
    response = await client.post(CASES, json=as_case(eligible, origin_action=action_id))
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "action_not_eligible"
    assert (body["details"]["decision"], body["details"]["reason"]) == (decision, reason)
    assert body["details"]["case_id"] == "aus-protokoll"


async def test_an_edit_may_not_move_a_case_to_an_ineligible_action(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    store, admin = admin_store(app)
    action_id = accepted(app, NEAR)[0]
    draft = (await client.get(f"{DRAFT}/{action_id}")).json()
    assert (await client.post(CASES, json=as_case(draft))).status_code == 201

    # What became of the action afterwards does not lock its case.
    store.touch(admin, action_id)
    kept = await client.put(f"{CASES}/aus-protokoll", json=as_case(draft, note="geprüft"))
    assert kept.status_code == 200, kept.text

    other = action(app, "adjusted")
    moved = await client.put(f"{CASES}/aus-protokoll", json=as_case(draft, origin_action=other))
    assert moved.status_code == 409, moved.text
    assert moved.json()["code"] == "action_not_eligible"


async def test_an_edit_may_not_turn_an_authored_case_into_one_of_an_ineligible_action(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    draft = (await client.get(f"{DRAFT}/{accepted(app, NEAR)[0]}")).json()
    authored = as_case(draft, origin="authored", origin_action=None)
    assert (await client.post(CASES, json=authored)).status_code == 201

    other = action(app, "auto_undone")
    response = await client.put(
        f"{CASES}/aus-protokoll", json={**authored, "origin": "log", "origin_action": other}
    )
    assert response.status_code == 409, response.text
    assert response.json()["details"]["reason"] == "undone"
