from sqlalchemy import Engine, create_engine

from geotandem.config import Settings
from geotandem.db import spatialite


def make_engine(settings: Settings) -> Engine:
    url = settings.sqlalchemy_url
    if url.startswith("sqlite"):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        # A writer waits up to 30 s for another (an import holds the lock while it stores).
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})
        spatialite.attach(engine, settings.spatialite_library)
        return engine
    raise NotImplementedError("Only SpatiaLite is available; the PostGIS adapter follows in P.1.")
