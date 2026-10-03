"""Concurrent requests on one SQLite file (one process, several threads).

Every write transaction reads before it writes. With deferred transactions two
of them deadlock on the lock upgrade, and SQLite answers "database is locked"
at once instead of waiting.
"""

from concurrent.futures import ThreadPoolExecutor

from geotandem.auth import accounts, visibility
from geotandem.catalog import list_layers
from geotandem.data import DataBackend, Limits
from geotandem.engine import run_query
from geotandem.sample.load import load_sample
from geotandem_query import QueryObject

PASSWORD = "korrekt-pferd-batterie"


def test_parallel_reads_and_writes_do_not_lock(backend: DataBackend) -> None:
    load_sample(backend)
    engine = backend.engine
    for i in range(8):
        accounts.create(engine, f"user{i}", PASSWORD, "user")
    query = QueryObject.model_validate({"source": "schulen", "output": "table"})

    def work(i: int) -> None:
        for round_ in range(10):
            assert accounts.authenticate(engine, f"user{i}", PASSWORD) is not None  # writes
            visibility.set_visible(engine, "strassen", "user", (i + round_) % 2 == 0)  # writes
            list_layers(engine)  # reads
            run_query(query, backend, Limits(max_features=1000, timeout_s=10))  # reads

    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in [pool.submit(work, i) for i in range(8)]:
            future.result()
