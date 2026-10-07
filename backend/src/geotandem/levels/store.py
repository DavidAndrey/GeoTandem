"""Levels in the data core."""

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, selectinload

from geotandem.db import orm
from geotandem.db.spatialite import reading
from geotandem.levels.model import CellMode, Level, OpClass


def _level(row: orm.Level) -> Level:
    cells = {p.op_class: p.mode for p in row.permissions}
    return Level(
        id=row.id,
        name=row.name,
        description=row.description,
        system_prompt=row.system_prompt,
        selectable=row.selectable,
        is_default=row.is_default,
        # A class without a stored cell is off (H2): new classes start refused.
        matrix={c: CellMode(cells.get(c, CellMode.OFF)) for c in OpClass},
    )


def load_levels(engine: Engine) -> list[Level]:
    """All levels in display order."""
    stmt = select(orm.Level).options(selectinload(orm.Level.permissions))
    with Session(reading(engine)) as session:
        return [_level(row) for row in session.scalars(stmt.order_by(orm.Level.position))]
