"""The one place where SpatiaLite is loaded and initialised (tech-stack 3.3)."""

import sqlite3
from typing import Any

from geoalchemy2.admin.dialects.sqlite import init_spatialite
from sqlalchemy import Connection, Engine, event

READ_ONLY = "geotandem_read_only"
"""Execution option for connections that never write; they need no write lock."""


def attach(engine: Engine, library: str) -> None:
    """Load SpatiaLite on every new connection; initialise metadata on a new file.

    Transactions are SQLAlchemy's, not the driver's: pysqlite issues BEGIN only
    before DML, so DROP/CREATE TABLE inside ``session.begin()`` used to commit
    on the spot. With the driver's handling switched off, SQLAlchemy emits
    BEGIN itself (SQLAlchemy docs, "Serializable isolation / Savepoints /
    Transactional DDL" for pysqlite).

    That BEGIN is IMMEDIATE: our write transactions read first, and two
    deferred transactions upgrading to a write lock deadlock, which SQLite
    answers with "database is locked" at once instead of waiting. Only
    connections marked ``READ_ONLY`` (the analysis queries) begin DEFERRED.
    WAL lets those readers run beside a writer without blocking either.
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
        dbapi_conn.execute("PRAGMA journal_mode = WAL")
        dbapi_conn.isolation_level = None

    @event.listens_for(engine, "begin")
    def _on_begin(conn: Connection) -> None:
        read_only = conn.get_execution_options().get(READ_ONLY, False)
        conn.exec_driver_sql("BEGIN DEFERRED" if read_only else "BEGIN IMMEDIATE")
