"""Versioned migrations of the administrative schema (F-2.17)."""

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine


def alembic_config() -> Config:
    config = Config()
    config.set_main_option("script_location", "geotandem.db:migrations")
    return config


def upgrade(engine: Engine, revision: str = "head") -> None:
    config = alembic_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, revision)


def downgrade(engine: Engine, revision: str) -> None:
    config = alembic_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, revision)


def head() -> str:
    revision = ScriptDirectory.from_config(alembic_config()).get_current_head()
    assert revision is not None
    return revision
