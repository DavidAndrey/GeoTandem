"""Versioned migrations of the administrative schema (F-2.17).

On SQLite, a migration that changes a table in batch mode copies it, drops
the original and renames the copy. With foreign keys enforced, that DROP
fires ``ON DELETE CASCADE`` / ``SET NULL`` on every row referring to the
table: rebuilding ``app_user`` would empty the logins, sessions and saved
queries. So keys are switched off while migrating (SQLite ignores the pragma
inside a transaction, hence before it begins), checked once at the end, and
switched on again.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine


def alembic_config() -> Config:
    config = Config()
    config.set_main_option("script_location", "geotandem.db:migrations")
    return config


@contextmanager
def _keys_unenforced(connection: Connection) -> Iterator[None]:
    """SQLite only: no key actions while migrating, the integrity checked after."""
    if connection.dialect.name != "sqlite":
        yield
        return
    # On the driver's connection: through SQLAlchemy the pragma would open a transaction.
    raw = connection.connection.driver_connection
    assert raw is not None
    raw.execute("PRAGMA foreign_keys = OFF")
    try:
        yield
    finally:
        raw.execute("PRAGMA foreign_keys = ON")


def _check_keys(connection: Connection) -> None:
    if connection.dialect.name != "sqlite":
        return
    broken = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if broken:
        tables = sorted({row[0] for row in broken})
        raise RuntimeError(
            f"The migration left {len(broken)} rows with a broken foreign key"
            f" in {', '.join(tables)}; nothing was changed."
        )


def _run(engine: Engine, step: Callable[[Config], None]) -> None:
    config = alembic_config()
    with engine.connect() as connection, _keys_unenforced(connection), connection.begin():
        config.attributes["connection"] = connection
        step(config)
        _check_keys(connection)


def upgrade(engine: Engine, revision: str = "head") -> None:
    _run(engine, lambda config: command.upgrade(config, revision))


def downgrade(engine: Engine, revision: str) -> None:
    _run(engine, lambda config: command.downgrade(config, revision))


def head() -> str:
    revision = ScriptDirectory.from_config(alembic_config()).get_current_head()
    assert revision is not None
    return revision
