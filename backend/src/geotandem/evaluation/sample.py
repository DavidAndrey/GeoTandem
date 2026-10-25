"""The sample data state, built (plan E3, D1): a fresh SpatiaLite file loaded
with the packaged sample data, as the application's sample cases and the
harness (``evals/run.py``, ``regrade.py``) run on it.

The one way to build it: a temporary directory, its own database URL (so a
configured ``database_url`` is never touched), the migrations, the sample,
and optionally a metadata-ablation mode (``profiles.py``, Phase 4). The
application opens it again read-only (``cases.sample_backend``); the harness
reads it as built.
"""

import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import Engine

from geotandem.config import Settings
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.evaluation.profiles import strip
from geotandem.sample.load import load_sample


@dataclass(frozen=True)
class BuiltSample:
    directory: Path
    """The temporary directory; the caller removes it when done."""
    path: Path
    """The SpatiaLite file."""
    settings: Settings
    """``settings`` with the file's own URL."""
    engine: Engine
    backend: SpatiaLiteBackend


def build_sample(
    settings: Settings, *, prefix: str = "geotandem-eval-sample-", profile: str = "full"
) -> BuiltSample:
    """A temporary SpatiaLite file, migrated and loaded with the packaged sample,
    its metadata stripped by ``profile`` (``profiles.PROFILES``); the directory
    is removed at once if building fails."""
    directory = Path(tempfile.mkdtemp(prefix=prefix))
    path = directory / "sample.sqlite"
    own = settings.model_copy(update={"data_dir": directory, "database_url": f"sqlite:///{path}"})
    engine: Engine | None = None
    try:
        engine = bootstrap(own)
        backend = SpatiaLiteBackend(engine, own.internal_crs)
        load_sample(backend)
        strip(engine, profile)
    except BaseException:
        if engine is not None:
            engine.dispose()
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return BuiltSample(directory, path, own, engine, backend)
