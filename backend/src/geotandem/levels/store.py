"""Levels in the data core."""

from collections.abc import Sequence

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, selectinload

from geotandem.db import orm
from geotandem.db.spatialite import reading
from geotandem.levels.model import CellMode, Level, OpClass, validate_levels


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


class UnknownLevel(LookupError):
    """A level id in a change that is not stored (deleted meanwhile, or made up)."""

    def __init__(self, level_id: int) -> None:
        super().__init__(level_id)
        self.level_id = level_id


def save_levels(engine: Engine, levels: Sequence[Level]) -> list[Level]:
    """Replace the whole set in one transaction, so its rules hold together (H1, H7).

    A level with an id keeps it; one without is new; a stored level the set no
    longer names is deleted, and accounts that chose it fall back to the default.
    """
    validate_levels(levels)
    with Session(engine) as session, session.begin():
        stored = {
            row.id: row
            for row in session.scalars(
                select(orm.Level).options(selectinload(orm.Level.permissions))
            )
        }
        for level in levels:
            if level.id is not None and level.id not in stored:
                raise UnknownLevel(level.id)
        kept = {level.id for level in levels}
        for level_id, row in stored.items():
            if level_id not in kept:
                session.delete(row)
        for position, level in enumerate(levels):
            row = stored[level.id] if level.id is not None else orm.Level()
            row.name = level.name
            row.description = level.description
            row.system_prompt = level.system_prompt
            row.position = position
            row.selectable = level.selectable
            row.is_default = level.is_default
            cells = {p.op_class: p for p in row.permissions}
            for op_class, mode in level.matrix.items():
                if op_class in cells:
                    cells[op_class].mode = mode
                else:
                    row.permissions.append(orm.LevelPermission(op_class=op_class, mode=mode))
            session.add(row)
    return load_levels(engine)
