"""Schema migrations (F-2.17): every revision carries existing data along."""

from typing import Any

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text

from geotandem.config import Settings
from geotandem.db import migrate
from geotandem.db.engine import make_engine
from geotandem.db.orm import Base


def _include(obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any) -> bool:
    if type_ == "table":
        return name in Base.metadata.tables
    return True


def test_orm_matches_migrations(settings: Settings) -> None:
    """The ORM and the migration chain describe the same schema."""
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"include_object": _include})
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_upgrade_from_e12_keeps_layers_and_attributes(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine, "0001")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO layer (id, name, title, description, kind, feature_count, source)"
                " VALUES (1, 'old', 'Alt', '', 'table', 0, '')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO layer_attribute"
                " (layer_id, name, position, data_type, label, description)"
                " VALUES (1, 'code', 0, 'integer', 'Code', '')"
            )
        )

    migrate.upgrade(engine)

    with engine.connect() as conn:
        layer = conn.execute(text("SELECT for_model, updated_at FROM layer")).one()
        attribute = conn.execute(
            text('SELECT label, for_model, "references" FROM layer_attribute')
        ).one()
    assert layer.for_model == 1 and layer.updated_at is not None
    assert tuple(attribute) == ("Code", 1, None)


def test_downgrade_to_e12_keeps_attributes(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO layer (id, name, title, description, kind, feature_count, source)"
                " VALUES (1, 'old', 'Alt', '', 'table', 0, '')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO layer_attribute"
                " (layer_id, name, position, data_type, label, description)"
                " VALUES (1, 'code', 0, 'integer', 'Code', '')"
            )
        )

    migrate.downgrade(engine, "0001")

    assert "import_run" not in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM layer_attribute")) == 1
