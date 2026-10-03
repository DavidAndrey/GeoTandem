"""The one place where SpatiaLite is loaded and initialised (tech-stack 3.3)."""

import sqlite3
from typing import Any

from geoalchemy2.admin.dialects.sqlite import init_spatialite
from sqlalchemy import Connection, Engine, event


def attach(engine: Engine, library: str) -> None:
    """Load SpatiaLite on every new connection; initialise metadata on a new file.

    Also makes DDL transactional. pysqlite by default only issues BEGIN before
    DML, so DROP/CREATE TABLE inside ``session.begin()`` committed on the spot
    and a failed layer replace or migration left half-done work behind. The
    driver's own transaction handling is switched off and SQLAlchemy emits
    BEGIN itself (SQLAlchemy docs, "Serializable isolation / Savepoints /
    Transactional DDL" for pysqlite).
    """

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
        dbapi_conn.isolation_level = None

    @event.listens_for(engine, "begin")
    def _on_begin(conn: Connection) -> None:
        conn.exec_driver_sql("BEGIN")
