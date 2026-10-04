"""Reading an import file in a process of its own (security review #9).

An import file comes from outside and is parsed by native code: GDAL for
GeoJSON, shapefiles and GeoPackages (a GeoPackage is a whole SQLite database),
openpyxl for Excel. A file built to exhaust memory, to loop, or to hit a bug in
those parsers would take the server down with it. So the file is read in a
child process with an address-space and a CPU-time limit, and a wall-clock
limit on top. Whatever happens there, the server answers: "cannot be read".

What it does not do: the child runs as the same user, so it is no sandbox
against code execution; it bounds the damage of the far likelier failures.
"""

from __future__ import annotations

import logging
import multiprocessing
import resource
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from geotandem.importing.read import MAX_UNPACKED, ReadOptions, Source, SourceError, read_source

log = logging.getLogger(__name__)
MiB = 1024 * 1024


@dataclass(frozen=True)
class ReadLimits:
    memory_mb: int = 4096
    """Address space of the reading process; the libraries alone take about 1.4 GB."""
    cpu_s: int = 300
    wall_s: float = 360.0
    unpacked_mb: int = MAX_UNPACKED // MiB
    """What a zipped shapefile or an Excel workbook may unpack to."""


_context: Any = None


def _forkserver() -> Any:
    """Children forked from a small server that has imported the readers once:
    quick to start, and never a fork of the web server with its threads."""
    global _context
    if _context is None:
        context = multiprocessing.get_context("forkserver")
        context.set_forkserver_preload(["geotandem.importing.read"])
        _context = context
    return _context


def read_isolated(
    path: Path, file_name: str, options: ReadOptions | None, limits: ReadLimits
) -> Source:
    """``read_source`` in a child process under ``limits``; raises ``SourceError``."""
    pool = ProcessPoolExecutor(
        max_workers=1,
        mp_context=_forkserver(),
        initializer=_limit,
        initargs=(limits.memory_mb, limits.cpu_s),
    )
    try:
        future = pool.submit(_read, str(path), file_name, options, limits.unpacked_mb * MiB)
        try:
            outcome = future.result(timeout=limits.wall_s)
        except FutureTimeout:
            _kill(pool)
            log.warning("import file %r: reading stopped after %g s", file_name, limits.wall_s)
            raise SourceError(
                "too_slow", f"Reading '{file_name}' took too long and was stopped.", file=file_name
            ) from None
        except Exception as exc:
            # BrokenProcessPool: killed for its CPU time, or the parser crashed. Anything
            # else, e.g. no memory left to send the result back, ends the same way.
            log.warning("import file %r: reading failed in its process: %r", file_name, exc)
            raise SourceError(
                "unreadable",
                f"'{file_name}' could not be read: reading it failed or took too long.",
                file=file_name,
            ) from None
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    if outcome[0] == "error":
        _, code, message, details = outcome
        raise SourceError(code, message, **details)
    source: Source = outcome[1]
    return source


def _limit(memory_mb: int, cpu_s: int) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (memory_mb * MiB, memory_mb * MiB))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 5))


def _read(
    path: str, file_name: str, options: ReadOptions | None, max_unpacked: int
) -> tuple[Any, ...]:
    """In the child. Results as plain tuples: an exception with extra arguments
    does not come back through pickling whole."""
    try:
        return ("ok", read_source(Path(path), file_name, options, max_unpacked))
    except SourceError as exc:
        return ("error", exc.code, exc.message, exc.details)
    except MemoryError:
        return (
            "error",
            "too_large",
            f"'{file_name}' needs more memory to read than an import may use.",
            {"file": file_name},
        )


def _kill(pool: ProcessPoolExecutor) -> None:
    kill = getattr(pool, "kill_workers", None)  # Python 3.14
    if kill is not None:
        kill()
        return
    for process in list(getattr(pool, "_processes", {}).values()):  # pragma: no cover
        process.kill()
