"""First start and every start: bring the data core to the current version."""

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from geotandem.config import Settings
from geotandem.db import migrate
from geotandem.db.engine import make_engine
from geotandem.db.orm import AppMeta

INTERNAL_CRS_KEY = "internal_crs"


class ConfigurationError(RuntimeError):
    pass


def ensure_internal_crs(engine: Engine, configured: int) -> int:
    """Record the internal CRS on first start; refuse a later change (F-2.5)."""
    with Session(engine) as session, session.begin():
        stored = session.scalar(select(AppMeta.value).where(AppMeta.key == INTERNAL_CRS_KEY))
        if stored is None:
            session.add(AppMeta(key=INTERNAL_CRS_KEY, value=str(configured)))
            return configured
    if int(stored) != configured:
        raise ConfigurationError(
            f"The data core uses EPSG:{stored} as internal CRS, but EPSG:{configured} is "
            "configured. The internal CRS cannot change after the first start."
        )
    return configured


def bootstrap(settings: Settings) -> Engine:
    """Create the SpatiaLite file if needed and migrate it to head (F-2.12, F-2.17)."""
    engine = make_engine(settings)
    migrate.upgrade(engine)
    ensure_internal_crs(engine, settings.internal_crs)
    return engine
