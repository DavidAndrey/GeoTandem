"""Versioned migrations of the administrative schema (F-2.17)."""

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine


def alembic_config() -> Config:
    config = Config()
    config.set_main_option("script_location", "geotandem.db:migrations")
    return config


def upgrade(engine: Engine) -> None:
    config = alembic_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
