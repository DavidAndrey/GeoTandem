"""Levels in the data core."""

from collections.abc import Sequence

from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session, selectinload

from geotandem.db import orm
from geotandem.db.spatialite import reading
from geotandem.levels.model import (
    CellMode,
    Level,
    LevelError,
    OpClass,
    resolve_level,
    validate_levels,
)


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


def chosen_level_id(engine: Engine, user_id: int) -> int | None:
    """The account's stored choice, whether or not it still counts (H7)."""
    with Session(reading(engine)) as session:
        return session.scalar(select(orm.User.level_id).where(orm.User.id == user_id))


def active_level(engine: Engine, user_id: int, *, admin: bool) -> Level:
    """The level a model action of this account works on, resolved on every use (H6, H7)."""
    return resolve_level(
        load_levels(engine), admin=admin, chosen_id=chosen_level_id(engine, user_id)
    )


def choose_level(engine: Engine, user_id: int, level_id: int | None, *, admin: bool) -> None:
    """Store the account's choice; ``None`` means the default. A level users may not
    choose is refused, checked here and not only in the interface (H6)."""
    if level_id is not None:
        level = next((lv for lv in load_levels(engine) if lv.id == level_id), None)
        if level is None or not (level.selectable or admin):
            raise LevelError(
                "level_not_available", "That level is not open to this account.", id=level_id
            )
    with Session(engine) as session, session.begin():
        session.execute(update(orm.User).where(orm.User.id == user_id).values(level_id=level_id))
