"""Roles and layer visibility, enforced in the backend (F-2.7, F-3.1, F-3.12).

The interface is not the guard: every rule here is checked against the HTTP
API directly, as a client that ignores the UI would see it.
"""

import json
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, sign_in, sign_in_as
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from import_files import make_files

from geotandem.api.auth import require_account, require_admin, require_session
from geotandem.app import create_app
from geotandem.config import Settings

GOLDEN = Path(__file__).parent / "golden"

READ_ROUTES = [
    ("GET", "/api/layers", None),
    ("GET", "/api/layers/schulen", None),
    ("POST", "/api/query", {"source": "schulen", "output": "table", "limit": 1}),
    ("POST", "/api/query/validate", {"source": "schulen"}),
    ("POST", "/api/query/count", {"queries": [{"source": "schulen"}]}),
    ("POST", "/api/query/ids", {"source": "schulen"}),
    ("GET", "/api/tools", None),
    ("GET", "/api/config/map", None),
    ("GET", "/api/sessions", None),
    ("GET", "/api/queries", None),
]
ADMIN_ROUTES = [
    ("GET", "/api/admin/system", None),
    ("GET", "/api/admin/layers", None),
    ("PATCH", "/api/admin/layers/schulen", {"title": "X"}),
    ("DELETE", "/api/admin/layers/schulen", None),
    ("GET", "/api/admin/layers/schulen/profile", None),
    ("GET", "/api/admin/import-log", None),
    ("GET", "/api/admin/users", None),
    ("POST", "/api/admin/users", {"username": "x.y"}),
    ("GET", "/api/admin/visibility", None),
    ("PUT", "/api/admin/visibility", {"layer": "schulen", "role": "user", "visible": False}),
]
PUBLIC_ROUTES = [
    ("GET", "/api/health", None),
    ("GET", "/api/schema/query-object", None),
    ("GET", "/api/auth/setup", None),
]


async def call(client: httpx.AsyncClient, method: str, path: str, body: Any) -> httpx.Response:
    return await client.request(method, path, json=body)


def golden(name: str) -> dict[str, Any]:
    query: dict[str, Any] = json.loads((GOLDEN / f"{name}.query.json").read_text("utf-8"))
    return query


async def hide(admin: httpx.AsyncClient, layer: str) -> None:
    response = await admin.put(
        "/api/admin/visibility", json={"layer": layer, "role": "user", "visible": False}
    )
    assert response.status_code == 200


# --- who may call what --------------------------------------------------------


@pytest.mark.parametrize(("method", "path", "body"), READ_ROUTES + ADMIN_ROUTES)
async def test_anonymous_is_turned_away(
    anonymous: httpx.AsyncClient, method: str, path: str, body: Any
) -> None:
    response = await call(anonymous, method, path, body)
    assert (response.status_code, response.json()["code"]) == (401, "not_authenticated")


@pytest.mark.parametrize(("method", "path", "body"), PUBLIC_ROUTES)
async def test_public_routes(
    anonymous: httpx.AsyncClient, method: str, path: str, body: Any
) -> None:
    assert (await call(anonymous, method, path, body)).status_code == 200


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_ROUTES)
async def test_user_cannot_administrate(
    client: httpx.AsyncClient, method: str, path: str, body: Any
) -> None:
    await sign_in_as(client, "m.keller")
    response = await call(client, method, path, body)
    assert (response.status_code, response.json()["code"]) == (403, "forbidden")


@pytest.mark.parametrize(("method", "path", "body"), READ_ROUTES)
async def test_user_can_work(client: httpx.AsyncClient, method: str, path: str, body: Any) -> None:
    await sign_in_as(client, "m.keller")
    assert (await call(client, method, path, body)).status_code == 200


async def test_start_password_must_be_changed_first(client: httpx.AsyncClient) -> None:
    created = (await client.post("/api/admin/users", json={"username": "m.keller"})).json()
    await sign_in(client, "m.keller", created["start_password"])
    me = (await client.get("/api/auth/me")).json()
    assert me["must_change_password"] is True
    blocked = await client.get("/api/layers")
    assert (blocked.status_code, blocked.json()["code"]) == (403, "password_change_required")
    await client.post(
        "/api/auth/password", json={"current": created["start_password"], "new": USER_PASSWORD}
    )
    assert (await client.get("/api/layers")).status_code == 200


PUBLIC = {
    ("GET", "/api/health"),
    ("GET", "/api/schema/query-object"),
    ("GET", "/api/auth/setup"),
    ("POST", "/api/auth/setup"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
}
"""Routes anyone may call; every other one needs an account (security review #21)."""
OWN_ACCOUNT = {("GET", "/api/auth/me"), ("POST", "/api/auth/password")}
"""Also with the start password still unchanged (design A4)."""


def _routes(routes: Iterable[Any]) -> Iterator[APIRoute]:
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
        elif hasattr(route, "original_router"):  # an included router (FastAPI 0.14x)
            yield from _routes(route.original_router.routes)


def _calls(dependant: Dependant) -> Iterator[Any]:
    yield dependant.call
    for dependency in dependant.dependencies:
        yield from _calls(dependency)


def test_every_route_requires_what_it_should() -> None:
    """Read from the application itself, so a new route cannot slip by unlisted."""
    app = create_app(Settings())
    found: dict[tuple[str, str], set[Any]] = {
        (method, route.path): set(_calls(route.dependant))
        for route in _routes(app.routes)
        for method in route.methods
    }
    documented = {
        (method.upper(), path) for path, item in app.openapi()["paths"].items() for method in item
    }
    assert set(found) == documented  # the walk saw every route

    wrong = []
    for (method, path), calls in sorted(found.items()):
        if (method, path) in PUBLIC:
            expected = None
        elif (method, path) in OWN_ACCOUNT:
            expected = require_session
        elif path.startswith("/api/admin/"):
            expected = require_admin
        else:
            expected = require_account
        guards = {require_session, require_account, require_admin} & calls
        if (expected is None and guards) or (expected is not None and expected not in calls):
            wrong.append(f"{method} {path}: needs {expected and expected.__name__}")
    assert not wrong, "\n".join(wrong)


# --- what a user sees (acceptance E1.4) ---------------------------------------


async def test_two_roles_see_different_layers(client: httpx.AsyncClient) -> None:
    await hide(client, "strassen")
    admin_layers = [layer["name"] for layer in (await client.get("/api/layers")).json()]
    await sign_in_as(client, "m.keller")
    user_layers = [layer["name"] for layer in (await client.get("/api/layers")).json()]

    assert "strassen" in admin_layers
    assert "strassen" not in user_layers
    assert set(user_layers) == set(admin_layers) - {"strassen"}


async def test_only_administrators_learn_where_a_layer_came_from(
    client: httpx.AsyncClient,
) -> None:
    """An upload's file name may say more than the layer's title (security review #20)."""
    assert (await client.get("/api/layers/schulen")).json()["source"].startswith("sample:")
    await sign_in_as(client, "m.keller")
    assert (await client.get("/api/layers/schulen")).json()["source"] is None
    assert {layer["source"] for layer in (await client.get("/api/layers")).json()} == {None}


async def test_hidden_layer_looks_like_an_unknown_one(client: httpx.AsyncClient) -> None:
    await hide(client, "strassen")
    await sign_in_as(client, "m.keller")
    single = await client.get("/api/layers/strassen")
    assert (single.status_code, single.json()["code"]) == (404, "unknown_layer")
    query = await client.post("/api/query", json={"source": "strassen"})
    body = query.json()
    assert (query.status_code, body["code"]) == (400, "unknown_layer")
    assert "strassen" not in body["details"]["available"]
    assert "strassen" not in body["message"].split("Available:")[1]


@pytest.mark.parametrize(
    ("golden_query", "hidden"),
    [
        ("schools_near_river", "gewaesser"),  # spatial relation
        ("large_municipalities", "gemeindedaten"),  # attribute join
        ("schools_per_municipality", "schulen"),  # aggregation
        ("secondary_schools_in_moosseedorf_near_motorway", "strassen"),  # condition only
    ],
)
async def test_hidden_layer_cannot_be_used_as_a_condition(
    client: httpx.AsyncClient, golden_query: str, hidden: str
) -> None:
    query = golden(golden_query)
    assert (await client.post("/api/query", json=query)).status_code == 200  # admin
    await hide(client, hidden)
    await sign_in_as(client, "m.keller")
    for path, body in (
        ("/api/query", query),
        ("/api/query/validate", query),
        ("/api/query/count", {"queries": [query]}),
        ("/api/query/ids", query),
    ):
        response = await client.post(path, json=body)
        assert (response.status_code, response.json()["code"]) == (400, "unknown_layer")
        assert response.json()["details"]["layer"] == hidden


async def test_new_import_starts_hidden_until_released(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    files = make_files(tmp_path / "files")
    staged = await client.post(
        "/api/admin/imports",
        files={"file": ("schulen.geojson", files["schulen.geojson"].read_bytes())},
    )
    import_id = staged.json()["import_id"]
    run = (
        await client.post(
            f"/api/admin/imports/{import_id}/commit", json={"layer_name": "schulen_neu"}
        )
    ).json()
    assert (run["status"], run["actor"]) == ("ok", "admin")
    matrix = {
        row["layer"]: row["roles"] for row in (await client.get("/api/admin/visibility")).json()
    }
    assert matrix["schulen_neu"] == {"admin": True, "user": False}
    assert matrix["schulen"] == {"admin": True, "user": True}  # sample: released

    await sign_in_as(client, "m.keller")
    assert (await client.get("/api/layers/schulen_neu")).status_code == 404
    await sign_in(client, "admin", ADMIN_PASSWORD)
    await client.put(
        "/api/admin/visibility", json={"layer": "schulen_neu", "role": "user", "visible": True}
    )
    await sign_in(client, "m.keller", USER_PASSWORD)
    assert (await client.get("/api/layers/schulen_neu")).status_code == 200


async def test_admin_role_is_not_configurable(client: httpx.AsyncClient) -> None:
    response = await client.put(
        "/api/admin/visibility", json={"layer": "schulen", "role": "admin", "visible": False}
    )
    assert response.status_code == 422
    unknown = await client.put(
        "/api/admin/visibility", json={"layer": "nope", "role": "user", "visible": True}
    )
    assert unknown.status_code == 404


# --- account administration (design D9) ---------------------------------------


async def test_user_administration(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/admin/users", json={"username": "M.Keller", "display_name": "Mara Keller"}
    )
    assert created.status_code == 201
    body = created.json()
    assert body["account"]["username"] == "m.keller"
    assert body["account"]["must_change_password"] is True
    assert len(body["start_password"]) >= 10

    taken = await client.post("/api/admin/users", json={"username": "m.keller"})
    assert taken.json()["code"] == "username_taken"

    promoted = await client.patch("/api/admin/users/m.keller", json={"role": "admin"})
    assert promoted.json()["role"] == "admin"
    users = (await client.get("/api/admin/users")).json()
    assert [(u["username"], u["role"]) for u in users] == [
        ("admin", "admin"),
        ("m.keller", "admin"),
    ]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/admin/users/admin", {"role": "user"}),
        ("PATCH", "/api/admin/users/admin", {"status": "locked"}),
        ("DELETE", "/api/admin/users/admin", None),
    ],
)
async def test_last_admin_stays(
    client: httpx.AsyncClient, method: str, path: str, body: Any
) -> None:
    response = await call(client, method, path, body)
    assert (response.status_code, response.json()["code"]) == (400, "last_admin")
    # With a second administrator the same change is allowed.
    await client.post("/api/admin/users", json={"username": "zweit", "role": "admin"})
    locked = await client.patch("/api/admin/users/zweit", json={"status": "locked"})
    assert locked.status_code == 200  # a locked admin does not count as the remaining one
    response = await call(client, method, path, body)
    assert response.json()["code"] == "last_admin"


async def test_locking_ends_the_session(client: httpx.AsyncClient, app: Any) -> None:
    await sign_in_as(client, "m.keller")
    user_cookie = dict(client.cookies)
    await sign_in(client, "admin", ADMIN_PASSWORD)
    await client.patch("/api/admin/users/m.keller", json={"status": "locked"})
    client.cookies.clear()
    client.cookies.update(user_cookie)
    assert (await client.get("/api/layers")).status_code == 401


async def test_reset_password(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    await sign_in(client, "admin", ADMIN_PASSWORD)
    # The name as typed, with a stray space: the account is found all the same.
    response = await client.post("/api/admin/users/%20M.Keller/reset-password")
    assert response.status_code == 200, response.text
    reset = response.json()
    assert reset["account"]["username"] == "m.keller"
    assert reset["account"]["must_change_password"] is True
    client.cookies.clear()
    old = await client.post(
        "/api/auth/login", json={"username": "m.keller", "password": USER_PASSWORD}
    )
    assert old.status_code == 401
    await sign_in(client, "m.keller", reset["start_password"])
    assert (await client.get("/api/layers")).json()["code"] == "password_change_required"
