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


def test_upgrade_to_e20_seeds_levels_and_keeps_accounts(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine, "0005")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password) VALUES ('anna', 'Anna', 'x', 'user', 'active', 0)"
            )
        )

    migrate.upgrade(engine)

    with engine.connect() as conn:
        assert conn.execute(text("SELECT username, level_id FROM app_user")).one() == ("anna", None)
        assert conn.scalar(text("SELECT count(*) FROM level")) == 3
        assert conn.scalar(text("SELECT count(*) FROM level_permission")) == 15


def test_a_deleted_level_clears_the_choice(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        level_id = conn.scalar(text("SELECT id FROM level WHERE name = 'Assistenz'"))
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password, level_id)"
                " VALUES ('anna', '', 'x', 'user', 'active', 0, :id)"
            ),
            {"id": level_id},
        )
        conn.execute(text("DELETE FROM level WHERE id = :id"), {"id": level_id})
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT level_id FROM app_user")) is None
        assert (
            conn.scalar(
                text("SELECT count(*) FROM level_permission WHERE level_id = :id"), {"id": level_id}
            )
            == 0
        )


def test_downgrade_from_e20_keeps_accounts(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password, level_id) VALUES ('anna', '', 'x', 'user', 'active', 0, 1)"
            )
        )

    migrate.downgrade(engine, "0005")

    assert "level" not in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT username FROM app_user")) == "anna"
