import pytest
from sqlalchemy import inspect, text

from geotandem.config import Settings
from geotandem.db import migrate
from geotandem.db.bootstrap import ConfigurationError, bootstrap


def test_first_start_creates_spatialite_file_and_schema(settings: Settings) -> None:
    db_file = settings.data_dir / "geotandem.sqlite"
    assert not db_file.exists()

    engine = bootstrap(settings)

    assert db_file.exists()
    tables = set(inspect(engine).get_table_names())
    assert {"layer", "layer_attribute", "app_meta", "alembic_version"} <= tables
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT CheckSpatialMetaData()")) > 0
        assert conn.scalar(text("SELECT version_num FROM alembic_version")) == migrate.head()
        # The EPSG table is loaded, so reprojection works.
        x = conn.scalar(text("SELECT ST_X(ST_Transform(MakePoint(7.44, 46.95, 4326), 2056))"))
        assert 2_600_000 < x < 2_601_000


def test_repeated_start_is_idempotent(settings: Settings) -> None:
    bootstrap(settings).dispose()
    engine = bootstrap(settings)
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT value FROM app_meta WHERE key='internal_crs'")) == "2056"


def test_internal_crs_cannot_change_after_first_start(settings: Settings) -> None:
    bootstrap(settings).dispose()
    with pytest.raises(ConfigurationError, match="cannot change"):
        bootstrap(settings.model_copy(update={"internal_crs": 25832}))


def test_config_file_and_env(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    config_file = tmp_path / "geotandem.toml"
    config_file.write_text("max_features = 50\nquery_timeout_s = 3\n")
    monkeypatch.setenv("GEOTANDEM_CONFIG_FILE", str(config_file))
    monkeypatch.setenv("GEOTANDEM_QUERY_TIMEOUT_S", "7")
    s = Settings()
    assert s.max_features == 50  # from file
    assert s.query_timeout_s == 7  # env beats file
