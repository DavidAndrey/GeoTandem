"""Request guards of the application itself (security review #3, #4, #7, #8)."""

import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, SETUP_TOKEN, sign_in, sign_in_as
from fastapi import FastAPI

from geotandem.api.guards import NONCE_PLACEHOLDER, MiB, content_security_policy
from geotandem.auth import sessions
from geotandem.basemap import resolve


def configure(app: FastAPI, **changes: Any) -> None:
    state = app.state.geotandem
    state.settings = state.settings.model_copy(update=changes)


def csv_upload(size: int) -> dict[str, Any]:
    body = b"name;wert\n" + b"a;1\n" * (size // 4)
    return {"file": ("gross.csv", body, "text/csv")}


# --- #3: request size ------------------------------------------------------------


async def test_a_large_body_is_refused_before_sign_in(anonymous: httpx.AsyncClient) -> None:
    password = "x" * (3 * MiB)
    response = await anonymous.post(
        "/api/auth/login", json={"username": "admin", "password": password}
    )
    assert (response.status_code, response.json()["code"]) == (413, "request_too_large")
    assert response.json()["details"] == {"max_mb": 2}


async def test_a_body_without_length_is_counted(anonymous: httpx.AsyncClient) -> None:
    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(3):
            yield b"x" * MiB

    response = await anonymous.post(
        "/api/auth/login", content=chunks(), headers={"content-type": "application/json"}
    )
    assert "content-length" not in response.request.headers
    assert (response.status_code, response.json()["code"]) == (413, "request_too_large")


async def test_an_upload_without_admin_session_gets_the_small_limit(
    client: httpx.AsyncClient,
) -> None:
    await sign_in_as(client, "m.keller")
    as_user = await client.post("/api/admin/imports", files=csv_upload(3 * MiB))
    assert (as_user.status_code, as_user.json()["code"]) == (413, "request_too_large")
    client.cookies.clear()
    anonymous = await client.post("/api/admin/imports", files=csv_upload(3 * MiB))
    assert (anonymous.status_code, anonymous.json()["code"]) == (413, "request_too_large")
    # Small enough: the route itself refuses, as before.
    small = await client.post("/api/admin/imports", files=csv_upload(1000))
    assert small.status_code == 401


async def test_an_administrator_uploads_up_to_the_import_limit(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    configure(app, max_import_mb=4)
    accepted = await client.post("/api/admin/imports", files=csv_upload(3 * MiB))
    assert accepted.status_code == 200, accepted.text
    refused = await client.post("/api/admin/imports", files=csv_upload(6 * MiB))
    assert (refused.status_code, refused.json()["code"]) == (413, "upload_too_large")
    assert refused.json()["details"] == {"max_mb": 4}


async def test_the_general_limit_is_a_setting(anonymous: httpx.AsyncClient, app: FastAPI) -> None:
    configure(app, max_request_mb=0.001)
    response = await anonymous.post(
        "/api/auth/login", json={"username": "admin", "password": "x" * 2000}
    )
    assert response.status_code == 413


# --- #8: cross-site requests -----------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example"},
        {"origin": "http://test.evil.example"},
        {"sec-fetch-site": "cross-site"},
        {"sec-fetch-site": "same-site"},  # a sibling subdomain
    ],
)
async def test_changes_from_other_sites_are_refused(
    client: httpx.AsyncClient, headers: dict[str, str]
) -> None:
    response = await client.post("/api/auth/logout", headers=headers)
    assert (response.status_code, response.json()["code"]) == (403, "cross_origin")
    assert (await client.get("/api/auth/me")).status_code == 200  # still signed in


async def test_own_and_unnamed_origins_pass(client: httpx.AsyncClient) -> None:
    own = {"origin": "http://test", "sec-fetch-site": "same-origin"}
    assert (await client.post("/api/query/validate", json={}, headers=own)).status_code == 422
    assert (await client.post("/api/query/validate", json={})).status_code == 422
    # Reading is not a change: a cross-site GET gets its normal answer.
    foreign = await client.get("/api/layers", headers={"origin": "https://evil.example"})
    assert foreign.status_code == 200


# --- #4, #7: response headers ----------------------------------------------------


async def test_every_answer_carries_the_security_headers(anonymous: httpx.AsyncClient) -> None:
    for response in [
        await anonymous.get("/"),
        await anonymous.get("/api/health"),
        await anonymous.get("/api/layers"),  # a refusal
    ]:
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["referrer-policy"] == "same-origin"
        csp = response.headers["content-security-policy"]
        assert "default-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp
        assert "strict-transport-security" not in response.headers  # plain HTTP


async def test_over_https_the_cookie_is_secure_and_hsts_is_sent(app: FastAPI) -> None:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            response = await client.post(
                "/api/auth/setup",
                json={
                    "token": SETUP_TOKEN,
                    "username": "admin",
                    "password": ADMIN_PASSWORD,
                    "load_sample": False,
                },
            )
            assert response.status_code == 200
            assert response.headers["strict-transport-security"] == "max-age=31536000"
            cookie = response.headers["set-cookie"]
            # __Host-: no other host can plant this cookie (security review #18).
            assert cookie.startswith(f"{sessions.SECURE_COOKIE}=") and "Secure" in cookie


async def test_over_https_a_cookie_without_the_host_prefix_is_ignored(app: FastAPI) -> None:
    """A sibling subdomain may set ``geotandem_session`` for the parent domain; over
    HTTPS only the ``__Host-`` cookie counts (security review #18)."""
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            await client.post(
                "/api/auth/setup",
                json={
                    "token": SETUP_TOKEN,
                    "username": "admin",
                    "password": ADMIN_PASSWORD,
                    "load_sample": False,
                },
            )
            token = client.cookies[sessions.SECURE_COOKIE]
            assert (await client.get("/api/auth/me")).status_code == 200

            client.cookies.clear()
            client.cookies.set(sessions.COOKIE, token)  # as a planted cookie would arrive
            assert (await client.get("/api/auth/me")).status_code == 401

            client.cookies.clear()
            client.cookies.set(sessions.SECURE_COOKIE, token)
            response = await client.post("/api/auth/logout")
            removal = response.headers["set-cookie"]
            assert removal.startswith(f'{sessions.SECURE_COOKIE}=""') and "Secure" in removal


async def test_over_plain_http_the_cookie_follows_the_setting(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    await sign_in(client, "admin", ADMIN_PASSWORD)
    configure(app, cookie_secure=True)
    response = await client.post(
        "/api/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert "Secure" in response.headers["set-cookie"]


async def test_api_answers_are_not_cached(client: httpx.AsyncClient) -> None:
    """Start passwords, analysis states and data stay out of caches (security review #17)."""
    created = await client.post("/api/admin/users", json={"username": "m.keller"})
    assert "start_password" in created.json()
    for response in [
        created,
        await client.get("/api/sessions"),
        await client.get("/api/health"),
        await client.get("/api/admin/nothing"),  # a refusal
    ]:
        assert response.headers["cache-control"] == "no-store"


def test_the_policy_allows_images_from_the_tile_server_only() -> None:
    assert "img-src 'self' data:;" in content_security_policy(None, "n")
    swisstopo = content_security_policy(resolve("swisstopo-grau"), "n")
    assert "img-src 'self' data: https://wmts.geo.admin.ch;" in swisstopo
    own = content_security_policy(resolve("https://{s}.tiles.example.org/{z}/{x}/{y}.png"), "n")
    assert "img-src 'self' data: https://*.tiles.example.org;" in own


async def test_the_page_carries_a_fresh_style_nonce_on_every_load(
    anonymous: httpx.AsyncClient, tmp_path: Path
) -> None:
    (tmp_path / "dist" / "index.html").write_text(
        f'<meta property="csp-nonce" nonce="{NONCE_PLACEHOLDER}"><div id="root"></div>'
    )
    nonces = []
    for path in ("/", "/admin/system"):  # the page itself and a client route
        response = await anonymous.get(path)
        [nonce] = re.findall(r'nonce="([^"]+)"', response.text)
        assert f"style-src 'self' 'nonce-{nonce}'" in response.headers["content-security-policy"]
        assert response.headers["cache-control"] == "no-store"
        nonces.append(nonce)
    assert len(set(nonces)) == 2 and NONCE_PLACEHOLDER not in nonces
    # Scripts have no nonce: only files from the instance run.
    assert "script-src" not in response.headers["content-security-policy"]


def test_the_frontend_build_writes_the_placeholder_the_server_replaces() -> None:
    config = Path(__file__).parents[2] / "frontend" / "vite.config.ts"
    assert f"cspNonce: '{NONCE_PLACEHOLDER}'" in config.read_text()


async def test_api_documentation_is_off_by_default(anonymous: httpx.AsyncClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        response = await anonymous.get(path)
        assert response.headers["content-type"].startswith("text/html")  # the app's page
        assert "swagger" not in response.text.lower()
        assert '"openapi"' not in response.text


def test_the_server_does_not_name_itself(monkeypatch: pytest.MonkeyPatch) -> None:
    import uvicorn

    from geotandem.cli import main

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append(kwargs))
    main(["serve", "--port", "8123"])
    [options] = calls
    assert options["server_header"] is False
