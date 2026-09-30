from pathlib import Path

import pytest

from geotandem.config import Settings
from geotandem.data.interface import DataBackend
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.sample.load import load_sample

# P.2 adds "postgis" here; every test using ``backend`` then runs on both (F-10.7).
BACKENDS = ["spatialite"]


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")


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
