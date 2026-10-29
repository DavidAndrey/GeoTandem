"""The log of model actions over HTTP (plan WP73, D4, design M16).

Users read their own entries and nothing else: not another account's by id,
not in their list, not through any route of the administrators' log (403).
Administrators read every entry with its prompt; list, key figures and CSV
follow the same filters, the key figures of the contract fixture come out of
the API built from records, and no CSV cell can start a formula.
"""

import codecs
import csv
import io
import re
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from typing import Any

import httpx
import pytest
from api_helpers import USER_PASSWORD
from fastapi import FastAPI
from model_fixtures import REPO, fixture
from sqlalchemy import update
from sqlalchemy.orm import Session
from test_model_record import CONNECTION, LEVEL, build, new

from geotandem.api import model_log
from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.db.orm import ModelAction
from geotandem.model.record import ModelActionStore
from geotandem.model.record.export import COLUMNS, safe_cell
from geotandem.model.schemas import MAX_PAGE

LOG = "/api/admin/model-actions"
MINE = "/api/model/my-actions"
ADMIN_ROUTES = [LOG, f"{LOG}/key-figures", f"{LOG}/export.csv"]

SignIn = Callable[[str], Awaitable[httpx.AsyncClient]]


@pytest.fixture
async def sign_in(client: httpx.AsyncClient, app: FastAPI) -> AsyncIterator[SignIn]:
    """A further client signed in as a new user, created by ``client`` (an admin)."""
    made: list[httpx.AsyncClient] = []

    async def make(name: str) -> httpx.AsyncClient:
        created = await client.post("/api/admin/users", json={"username": name, "role": "user"})
        assert created.status_code == 201, created.text
        first = created.json()["start_password"]
        other = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        made.append(other)
        await other.post("/api/auth/login", json={"username": name, "password": first})
        changed = await other.post(
            "/api/auth/password", json={"current": first, "new": USER_PASSWORD}
        )
        assert changed.status_code == 204, changed.text
        return other

    yield make
    for other in made:
        await other.aclose()


def store_of(app: FastAPI) -> ModelActionStore:
    return ModelActionStore(app.state.geotandem.backend.engine)


def account(app: FastAPI, username: str) -> Account:
    engine = app.state.geotandem.backend.engine
    return next(a for a in accounts.list_accounts(engine) if a.username == username)


def created_at(app: FastAPI, action_id: int, moment: datetime) -> None:
    with Session(app.state.geotandem.backend.engine) as db, db.begin():
        db.execute(update(ModelAction).where(ModelAction.id == action_id).values(created_at=moment))


def rows(response: httpx.Response) -> list[dict[str, str]]:
    text = response.content.decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text, newline=""), delimiter=";"))


# --- who sees what (D4) ---------------------------------------------------------


async def test_a_user_reads_only_their_own_entries(
    client: httpx.AsyncClient, app: FastAPI, sign_in: SignIn
) -> None:
    anna_client = await sign_in("anna")
    await sign_in("beat")
    store = store_of(app)
    anna, beat, admin = (account(app, n) for n in ("anna", "beat", "admin"))
    own = build(store, anna, "accepted")
    theirs = build(store, beat, "rejected", prompt="Beats geheime Frage")
    admins = build(store, admin, "adjusted")

    mine = await anna_client.get(MINE)
    assert mine.status_code == 200, mine.text
    assert [item["id"] for item in mine.json()["items"]] == [own]
    assert mine.json()["total"] == 1
    assert "Beats geheime Frage" not in mine.text
    # By id, as for sessions: another account's record does not exist (404, not 403).
    other = await anna_client.get(f"/api/model/actions/{theirs}")
    assert (other.status_code, other.json()["code"]) == (404, "not_found")
    assert "Beats geheime Frage" not in other.text
    # The administrators' log is closed to users altogether, the CSV included.
    for path in [*ADMIN_ROUTES, f"{LOG}/{theirs}", f"{LOG}/{own}", f"{LOG}/999999"]:
        refused = await anna_client.get(path)
        assert refused.status_code == 403, path
        assert "Beats geheime Frage" not in refused.text

    # An administrator's own list is theirs too; the log holds every account's.
    assert [i["id"] for i in (await client.get(MINE)).json()["items"]] == [admins]
    everything = (await client.get(LOG)).json()
    assert {i["id"] for i in everything["items"]} == {own, theirs, admins}
    detail = await client.get(f"{LOG}/{theirs}")
    assert detail.status_code == 200, detail.text
    assert (detail.json()["account"], detail.json()["prompt"]) == ("beat", "Beats geheime Frage")
    assert [r["prompt"] for r in rows(await client.get(f"{LOG}/export.csv"))].count(
        "Beats geheime Frage"
    ) == 1
    missing = await client.get(f"{LOG}/999999")
    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")


async def test_the_detail_is_the_record_as_it_was(client: httpx.AsyncClient, app: FastAPI) -> None:
    store = store_of(app)
    action_id = build(store, account(app, "admin"), "accepted")
    body = (await client.get(f"{LOG}/{action_id}")).json()
    assert body["level"] == LEVEL.model_dump(mode="json")
    assert body["connection"] == CONNECTION.model_dump(mode="json")
    assert body["decision"] == "accepted"
    assert body["stamp"]["count"] == 10
    # Naive UTC as the record holds it (the frontend reads it with parseTimestamp).
    assert "T" in body["created_at"]
    assert not body["created_at"].endswith("Z")
    assert "+" not in body["created_at"]
    # Compact, as the editor writes a query: no unset field.
    assert "attribute_join" not in body["query"]


async def test_a_row_names_the_reason_of_a_rejection_and_the_code_of_a_refusal(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    store = store_of(app)
    admin = account(app, "admin")
    refused = build(store, admin, "refused")
    rejected = build(store, admin, "proposed")
    store.reject(admin, rejected, "wrong_value")
    items = {i["id"]: i for i in (await client.get(LOG)).json()["items"]}
    assert (items[refused]["refusal_code"], items[refused]["reject_reason"]) == (
        "unknown_layer",
        None,
    )
    assert (items[rejected]["reject_reason"], items[rejected]["refusal_code"]) == (
        "wrong_value",
        None,
    )
    mine = {i["id"]: i for i in (await client.get(MINE)).json()["items"]}
    assert mine[rejected]["reject_reason"] == "wrong_value"


# --- key figures (plan section 2) -----------------------------------------------


async def test_key_figures_through_the_api_equal_the_fixture(
    client: httpx.AsyncClient, app: FastAPI, sign_in: SignIn
) -> None:
    await sign_in("anna")
    await sign_in("beat")
    store = store_of(app)
    anna, beat = account(app, "anna"), account(app, "beat")
    figures = fixture()["key_figures"]
    counts = dict(figures["decisions"])
    # The fixture counts undone ones inside their decision; build them apart.
    counts["auto"] -= counts["auto_undone"]
    counts["accepted"] -= counts["accepted_undone"]
    for n, (end, count) in enumerate(sorted(counts.items())):
        for i in range(count):
            build(store, anna if (n + i) % 2 else beat, end)
    new(store, anna, supersede=False)  # still thinking: no decision, not counted

    response = await client.get(f"{LOG}/key-figures")
    assert response.status_code == 200, response.text
    expect = {k: v for k, v in figures["expect"].items() if not k.startswith("_")}
    # The fixture has no checks (plan-check-mode): none was started.
    assert response.json() == expect | {"checks": None}
    listed = (await client.get(LOG, params={"limit": MAX_PAGE})).json()
    assert listed["total"] == sum(counts.values()) + 1


async def test_without_records_nothing_is_decided(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"{LOG}/key-figures")).json()
    assert body["proposals"] == 0
    assert body["acceptance_rate"] is None


# --- filters and paging -----------------------------------------------------------


async def test_list_figures_and_csv_follow_the_same_filters(
    client: httpx.AsyncClient, app: FastAPI, sign_in: SignIn
) -> None:
    await sign_in("anna")
    store = store_of(app)
    anna, admin = account(app, "anna"), account(app, "admin")
    accepted = build(store, anna, "accepted")
    chain = build(store, anna, "rejected", approach="chain")
    level = build(store, admin, "auto_undone", level=LEVEL.model_copy(update={"id": 9}))
    connection = build(store, admin, "adjusted", connection=CONNECTION.model_copy(update={"id": 7}))
    old = build(store, anna, "superseded")
    created_at(app, old, datetime(2020, 1, 1, 12, 0))

    cases: list[tuple[dict[str, Any], set[int]]] = [
        ({}, {accepted, chain, level, connection, old}),
        ({"approach": "chain"}, {chain}),
        ({"approach": "direct"}, {accepted, level, connection, old}),
        ({"level_id": 9}, {level}),
        ({"connection_id": 7}, {connection}),
        ({"account": "anna"}, {accepted, chain, old}),
        ({"from": "2021-01-01T00:00:00"}, {accepted, chain, level, connection}),
        ({"to": "2021-01-01T00:00:00"}, {old}),
        # A time with a zone is turned into the record's naive UTC.
        ({"from": "2020-01-01T12:30:00+02:00", "to": "2020-01-01T12:00:01Z"}, {old}),
        ({"from": "2020-01-01T12:00:01Z"}, {accepted, chain, level, connection}),
        ({"account": "anna", "approach": "chain"}, {chain}),
        ({"level_id": 12345}, set()),
    ]
    for params, expect in cases:
        listed = (await client.get(LOG, params=params)).json()
        assert {i["id"] for i in listed["items"]} == expect, params
        assert listed["total"] == len(expect), params
        figures = (await client.get(f"{LOG}/key-figures", params=params)).json()
        assert figures["proposals"] == len(expect), params
        exported = rows(await client.get(f"{LOG}/export.csv", params=params))
        assert {int(r["id"]) for r in exported} == expect, params

    assert (await client.get(LOG, params={"approach": "other"})).status_code == 422
    assert (await client.get(LOG, params={"from": "gestern"})).status_code == 422


async def test_pages_are_bounded_newest_first_and_do_not_overlap(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    store = store_of(app)
    admin = account(app, "admin")
    made = [new(store, admin, supersede=False).id for _ in range(7)]
    newest_first = made[::-1]  # same second: the id decides

    pages = []
    for offset in (0, 3, 6):
        page = (await client.get(LOG, params={"offset": offset, "limit": 3})).json()
        assert page["total"] == 7
        pages.append([item["id"] for item in page["items"]])
    assert pages == [newest_first[0:3], newest_first[3:6], newest_first[6:]]
    beyond = (await client.get(LOG, params={"offset": 50})).json()
    assert (beyond["items"], beyond["total"]) == ([], 7)
    assert [i["id"] for i in (await client.get(MINE, params={"limit": 2})).json()["items"]] == (
        newest_first[:2]
    )

    for path in (LOG, MINE):
        assert (await client.get(path, params={"limit": MAX_PAGE})).status_code == 200
        for bad in ({"limit": MAX_PAGE + 1}, {"limit": 0}, {"offset": -1}):
            assert (await client.get(path, params=bad)).status_code == 422, (path, bad)


# --- the CSV ------------------------------------------------------------------------


FULLWIDTH_EQUALS = chr(0xFF1D)
INJECTIONS = [
    '=HYPERLINK("http://x.example","klick")',
    "+41 79 000 00 00",
    "-2+3",
    "@SUM(A1:A2)",
    "\t=1+1",
    "\r=1+1",
    # Split by a spreadsheet at ";" (de-CH Excel) or ",": a formula mid-cell.
    "x;=1+1",
    "x,=1+1",
    'Schulen;=WEBSERVICE("http://x.example")',
    "a; -1",
    # Caught only after white space and NFKC normalisation.
    " =1+1",
    f"{FULLWIDTH_EQUALS}1+1",
    "\n=1",
]
SEPARATORS = re.compile(r"[;,\t\r\n]")


def starts_no_formula(cell: str) -> bool:
    """The cell, and every piece a spreadsheet might split it into, starts with
    no formula character once normalised and stripped (the integrator's rule)."""
    return not any(
        unicodedata.normalize("NFKC", piece).lstrip().startswith(("=", "+", "-", "@"))
        for piece in [cell, *SEPARATORS.split(cell)]
    )


@pytest.mark.parametrize("text", INJECTIONS)
def test_a_cell_that_could_start_a_formula_is_text(text: str) -> None:
    cell = safe_cell(text)
    assert starts_no_formula(cell), cell
    assert cell.replace("'", "") == text  # quotes added, nothing else changed


def test_cells_written_and_read_back_start_no_formula() -> None:
    out = io.StringIO()
    cells = [safe_cell(text) for text in INJECTIONS]
    csv.writer(out, delimiter=";", quoting=csv.QUOTE_ALL).writerow(cells)
    read = next(csv.reader(io.StringIO(out.getvalue(), newline=""), delimiter=";"))
    assert read == cells
    assert all(starts_no_formula(cell) for cell in read)


@pytest.mark.parametrize(
    ("value", "cell"),
    [
        ("x;=1+1", "x;'=1+1"),
        (" =1+1", "' =1+1"),
        (f"{FULLWIDTH_EQUALS}1+1", f"'{FULLWIDTH_EQUALS}1+1"),
        ("\n=1", "\n'=1"),
        ("-2+3", "'-2+3"),
        ("500 m, nicht mehr", "500 m, nicht mehr"),
        ("Schulen in Köniz", "Schulen in Köniz"),
        ("Wert = 3", "Wert = 3"),
        ("a@b", "a@b"),
        (None, ""),
        (True, "true"),
        (False, "false"),
        (10, "10"),
        (datetime(2026, 10, 10, 14, 5), "2026-10-10T14:05:00"),
    ],
)
def test_other_cells_are_written_as_they_are(value: Any, cell: str) -> None:
    assert safe_cell(value) == cell


async def test_the_csv_is_a_safe_download_of_the_log(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    store = store_of(app)
    admin = account(app, "admin")
    quoted = 'Schulen, "nahe" am See\nzweite Zeile'
    for prompt in [*INJECTIONS, quoted]:
        build(store, admin, "rejected", prompt=prompt)
    build(
        store,
        admin,
        "accepted",
        prompt="Kitas",
        level=LEVEL.model_copy(update={"name": "=Stufe"}),
        connection=CONNECTION.model_copy(update={"name": "@Anbindung"}),
    )

    response = await client.get(f"{LOG}/export.csv")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"].startswith(
        'attachment; filename="modellprotokoll-'
    )
    assert response.headers["content-disposition"].endswith('.csv"')
    assert response.content.startswith(codecs.BOM_UTF8)
    text = response.content.decode("utf-8-sig")
    assert text.splitlines()[0] == ";".join(f'"{name}"' for name, _ in COLUMNS)

    found = rows(response)
    prompts = [r["prompt"] for r in found]
    assert sorted(prompts) == sorted(safe_cell(p) for p in [*INJECTIONS, quoted, "Kitas"])
    assert quoted in prompts
    kitas = next(r for r in found if r["prompt"] == "Kitas")
    assert (kitas["level_name"], kitas["connection_name"]) == ("'=Stufe", "'@Anbindung")
    assert (kitas["decision"], kitas["hits"], kitas["applied_by_hand"]) == (
        "accepted",
        "10",
        "false",
    )
    assert kitas["level_matrix"].startswith("catalog=approve query=approve")
    assert datetime.fromisoformat(kitas["created_at_utc"]).tzinfo is None
    # Read back with the csv module, no cell of any row starts a formula,
    # whichever column it is in and wherever a spreadsheet might split it.
    for row in found:
        for name, cell in row.items():
            assert starts_no_formula(cell), (name, cell)


async def test_an_empty_log_is_a_header_line(client: httpx.AsyncClient) -> None:
    response = await client.get(f"{LOG}/export.csv")
    assert response.status_code == 200, response.text
    assert rows(response) == []
    assert response.content.decode("utf-8-sig").count("\r\n") == 1


async def test_an_export_beyond_the_cap_is_refused(
    client: httpx.AsyncClient, app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(model_log, "MAX_EXPORT_ROWS", 2)
    store = store_of(app)
    admin = account(app, "admin")
    for approach in ("direct", "direct", "chain"):
        build(store, admin, "accepted", approach=approach)

    refused = await client.get(f"{LOG}/export.csv")
    assert refused.status_code == 413, refused.text
    body = refused.json()
    assert (body["code"], body["details"]["max"], body["details"]["rows"]) == (
        "export_too_large",
        2,
        3,
    )
    narrowed = await client.get(f"{LOG}/export.csv", params={"approach": "direct"})
    assert narrowed.status_code == 200, narrowed.text
    assert len(rows(narrowed)) == 2


async def test_the_export_reads_in_chunks_newest_first(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    store = store_of(app)
    admin = account(app, "admin")
    made = [new(store, admin, supersede=False).id for _ in range(5)]
    for action_id in made[:2]:  # two at the same time: the id decides between them
        created_at(app, action_id, datetime(2000, 1, 1, 12, 0))
    expect = [made[4], made[3], made[2], made[1], made[0]]
    assert [v.id for v in store.export(admin)] == expect
    assert [v.id for v in store.export(admin, chunk=2)] == expect
    assert [v.id for v in store.export(admin, chunk=1, limit=3)] == expect[:3]
    assert store.count(admin) == 5


def test_the_frontend_knows_the_cap() -> None:
    """One cap, repeated where the page decides whether to offer the CSV."""
    source = (REPO / "frontend" / "src" / "model" / "log" / "queries.ts").read_text("utf-8")
    assert f"MAX_EXPORT_ROWS = {model_log.MAX_EXPORT_ROWS:_}" in source
