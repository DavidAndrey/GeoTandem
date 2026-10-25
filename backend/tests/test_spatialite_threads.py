"""SpatiaLite connections set up and close one at a time (plan E3, risk R1).

Overflow connections of the pool, closed by several request threads together,
corrupted the heap in the gate ("double free or corruption", exit 139); the
fault handler traced it to ``QueuePool._do_return_conn`` → ``do_close``.
"""

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import text

from geotandem.config import Settings
from geotandem.db import spatialite
from geotandem.db.bootstrap import bootstrap


def test_connections_are_spatialite_connections(tmp_path: Path) -> None:
    engine = bootstrap(Settings(data_dir=tmp_path))
    with engine.connect() as conn:
        assert isinstance(conn.connection.dbapi_connection, spatialite.SpatiaLiteConnection)


def test_a_connection_closes_under_the_lock(tmp_path: Path) -> None:
    engine = bootstrap(Settings(data_dir=tmp_path))
    with engine.connect() as conn:
        raw = conn.connection.dbapi_connection
    assert spatialite.NATIVE.acquire(timeout=1)
    try:
        closer = threading.Thread(target=raw.close)
        closer.start()
        closer.join(timeout=0.5)
        assert closer.is_alive(), "close() did not wait for the lock"
    finally:
        spatialite.NATIVE.release()
    closer.join(timeout=5)
    assert not closer.is_alive()


def test_many_threads_open_and_close_overflow_connections(tmp_path: Path) -> None:
    """More threads than the pool keeps: overflow connections open and close
    together, as under a burst of requests; the process survives and every
    connection works."""
    engine = bootstrap(Settings(data_dir=tmp_path))
    engine.dispose()

    def use(_: int) -> str:
        with engine.connect() as conn:
            return str(conn.execute(text("select spatialite_version()")).scalar())

    with ThreadPoolExecutor(max_workers=24) as pool:
        versions = set(pool.map(use, range(400)))
    assert len(versions) == 1
