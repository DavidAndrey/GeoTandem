"""The one place where SpatiaLite is loaded and initialised (tech-stack 3.3)."""

import sqlite3
from typing import Any

from geoalchemy2.admin.dialects.sqlite import init_spatialite
from sqlalchemy import Engine, event


def attach(engine: Engine, library: str) -> None:
    """Load SpatiaLite on every new connection; initialise metadata on a new file."""

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn: sqlite3.Connection, _record: Any) -> None:
        dbapi_conn.enable_load_extension(True)
        try:
            dbapi_conn.load_extension(library)
        finally:
            dbapi_conn.enable_load_extension(False)
        # Loads the EPSG table so ST_Transform works; a no-op on an initialised file.
        init_spatialite(dbapi_conn, transaction=True)
        dbapi_conn.execute("PRAGMA foreign_keys = ON")
