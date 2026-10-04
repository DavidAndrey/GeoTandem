import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, SETUP_TOKEN
from fastapi import FastAPI

from geotandem.app import create_app
from geotandem.config import Settings
from geotandem.data.interface import DataBackend
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.sample.load import load_sample

# P.2 adds "postgis" here; every test using ``backend`` then runs on both (F-10.7).
BACKENDS = ["spatialite"]


@pytest.fixture(autouse=True)
def cheap_password_hashing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Argon2 with minimal cost: the tests check behaviour, not hash strength."""
    from argon2 import PasswordHasher

    from geotandem.auth import accounts

    monkeypatch.setattr(
        accounts, "_hasher", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1)
    )


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")


@pytest.fixture
def settings_env(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point commands that read the environment (the CLI) at the test's data directory."""
    from geotandem.config import get_settings

    monkeypatch.setenv("GEOTANDEM_DATA_DIR", str(settings.data_dir))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, settings: Settings) -> DataBackend:
    engine = bootstrap(settings)
    return SpatiaLiteBackend(engine, settings.internal_crs)


@pytest.fixture(scope="session", params=BACKENDS)
def sample(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory) -> DataBackend:
    """Backend with the sample dataset, shared by read-only tests."""
    settings = Settings(data_dir=tmp_path_factory.mktemp("sample"))
    backend = SpatiaLiteBackend(bootstrap(settings), settings.internal_crs)
    load_sample(backend)
    return backend


@pytest.fixture(scope="session")
def sample_database(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A migrated data core with the sample, built once and copied per test."""
    settings = Settings(data_dir=tmp_path_factory.mktemp("template"))
    engine = bootstrap(settings)
    load_sample(SpatiaLiteBackend(engine, settings.internal_crs))
    engine.dispose()
    return settings.data_dir / "geotandem.sqlite"


@pytest.fixture
def app(tmp_path: Path, sample_database: Path) -> FastAPI:
    frontend = tmp_path / "dist"
    frontend.mkdir()
    (frontend / "index.html").write_text("<!doctype html><title>GeoTandem</title>")
    (tmp_path / "data").mkdir()
    shutil.copy(sample_database, tmp_path / "data" / "geotandem.sqlite")
    settings = Settings(
        data_dir=tmp_path / "data",
        load_sample_data=True,
        max_features=100,
        frontend_dir=frontend,
        setup_token=SETUP_TOKEN,
    )
    return create_app(settings)


@pytest.fixture
async def anonymous(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """A client that has not signed in, on an instance without accounts."""
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest.fixture
async def client(anonymous: httpx.AsyncClient) -> httpx.AsyncClient:
    """Signed in as the first administrator ("admin")."""
    response = await anonymous.post(
        "/api/auth/setup",
        json={
            "token": SETUP_TOKEN,
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "load_sample": False,
        },
    )
    assert response.status_code == 200, response.text
    return anonymous


@pytest.fixture
def backend_of_client(anonymous: httpx.AsyncClient, app: FastAPI) -> DataBackend:
    """The data core behind ``client``, for arranging state the API cannot reach."""
    backend: DataBackend = app.state.geotandem.backend
    return backend
