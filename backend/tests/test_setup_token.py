"""Setting up needs a token from the installation (security review #1)."""

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, SETUP_TOKEN
from fastapi import FastAPI
from pydantic import ValidationError

from geotandem.app import create_app
from geotandem.config import Settings

LOGGER = "geotandem.auth.setup_token"


async def set_up(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.post(
        "/api/auth/setup",
        json={
            "token": token,
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "load_sample": False,
        },
    )


async def started(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


async def test_reaching_the_address_is_not_enough(anonymous: httpx.AsyncClient) -> None:
    for token in ("", "geraten-geraten-geraten", SETUP_TOKEN + "x"):
        response = await set_up(anonymous, token)
        assert (response.status_code, response.json()["code"]) == (403, "setup_token_invalid")
    assert (await anonymous.get("/api/auth/setup")).json()["needs_setup"] is True
    missing = await anonymous.post(
        "/api/auth/setup", json={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert (missing.status_code, missing.json()["code"]) == (422, "schema_violation")


async def test_the_token_sets_up_once(anonymous: httpx.AsyncClient, app: FastAPI) -> None:
    assert (await set_up(anonymous, SETUP_TOKEN)).status_code == 200
    assert app.state.geotandem.setup_token is None  # used up
    again = await set_up(anonymous, SETUP_TOKEN)
    assert (again.status_code, again.json()["code"]) == (409, "setup_closed")


async def test_guessing_the_token_is_braked(anonymous: httpx.AsyncClient) -> None:
    for _ in range(10):
        assert (await set_up(anonymous, "geraten-geraten-geraten")).status_code == 403
    braked = await set_up(anonymous, SETUP_TOKEN)
    assert (braked.status_code, braked.json()["code"]) == (429, "too_many_attempts")


async def test_without_a_configured_token_one_is_made_and_logged(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    app = create_app(Settings(data_dir=tmp_path / "data"))
    with caplog.at_level("WARNING", logger=LOGGER):
        async for client in started(app):
            token = app.state.geotandem.setup_token
            assert token is not None and len(token) >= 24
            # In the log, and in a link whose fragment no server ever receives.
            assert f"Setup token: {token}" in caplog.text
            assert f"/einrichtung#token={token}" in caplog.text
            assert (await set_up(client, token)).status_code == 200


async def test_each_start_makes_a_new_token_until_set_up(tmp_path: Path) -> None:
    tokens = []
    for _ in range(2):
        app = create_app(Settings(data_dir=tmp_path / "data"))
        async for _client in started(app):
            tokens.append(app.state.geotandem.setup_token)
    assert None not in tokens and tokens[0] != tokens[1]


async def test_a_configured_token_is_never_printed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    app = create_app(Settings(data_dir=tmp_path / "data", setup_token=SETUP_TOKEN))
    with caplog.at_level("WARNING", logger=LOGGER):
        async for client in started(app):
            assert "GEOTANDEM_SETUP_TOKEN" in caplog.text
            assert SETUP_TOKEN not in caplog.text
            assert (await set_up(client, SETUP_TOKEN)).status_code == 200
    assert SETUP_TOKEN not in repr(app.state.geotandem.settings)


async def test_an_instance_with_accounts_has_no_token(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    settings = Settings(data_dir=tmp_path / "data", setup_token=SETUP_TOKEN)
    async for client in started(create_app(settings)):
        await set_up(client, SETUP_TOKEN)
    caplog.clear()
    app = create_app(settings)
    with caplog.at_level("WARNING", logger=LOGGER):
        async for _client in started(app):
            assert app.state.geotandem.setup_token is None
    assert "No administrator yet" not in caplog.text


def test_a_configured_token_must_be_long() -> None:
    with pytest.raises(ValidationError):
        Settings(setup_token="kurz")


def test_an_empty_token_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEOTANDEM_SETUP_TOKEN", "")  # as compose.yaml passes it on
    assert Settings().setup_token is None
