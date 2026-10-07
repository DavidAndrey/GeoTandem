"""Levels of model support (vision 8.1, plan E2.0 H1-H9).

A level says, per operation class, whether the model may do something:
``off`` (refused), ``approve`` (shown for approval first, F-6.2) or ``auto``
(runs at once, visible and undoable, F-6.3, F-6.4). The administrator defines
one to four of them. Their order only orders the display: no level is
"higher" than another, so no rule has to stay monotonic.
"""

from collections.abc import Iterable, Sequence
from enum import StrEnum
from typing import Annotated, Any, Self

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator


class OpClass(StrEnum):
    """What an operation does, fixed in code (H2). ``export`` joins with E5,
    ``external`` with E6; writes are no class, the model path has none (F-9.5)."""

    CATALOG = "catalog"
    QUERY = "query"
    SPATIAL = "spatial"
    DERIVE = "derive"
    DISPLAY = "display"


class CellMode(StrEnum):
    OFF = "off"
    APPROVE = "approve"
    AUTO = "auto"


_STRICTNESS = {CellMode.AUTO: 0, CellMode.APPROVE: 1, CellMode.OFF: 2}

MIN_LEVELS = 1
MAX_LEVELS = 4
MAX_SYSTEM_PROMPT = 8000

LevelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]


class LevelError(Exception):
    """A rule about the set of levels was violated; ``code`` is stable for the UI."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class Level(BaseModel):
    """One level. In a set, the list order is the display order (H1)."""

    model_config = ConfigDict(frozen=True)

    id: int | None = None
    """Stable across edits (H7); ``None`` for a level not stored yet."""
    name: LevelName
    description: Annotated[str, StringConstraints(max_length=500)] = ""
    system_prompt: Annotated[str, StringConstraints(max_length=MAX_SYSTEM_PROMPT)] = ""
    """Shapes the model's behaviour on this level (F-3.6); used from E2.3 on."""
    selectable: bool = False
    """Users may choose it (F-3.8); administrators may use every level (H6)."""
    is_default: bool = False
    matrix: dict[OpClass, CellMode]

    @model_validator(mode="after")
    def _complete(self) -> Self:
        missing = [c.value for c in OpClass if c not in self.matrix]
        if missing:
            raise ValueError(f"matrix lacks the classes {', '.join(missing)}")
        return self


def validate_levels(levels: Sequence[Level]) -> None:
    """The rules a set of levels keeps together (H1, H6, H7)."""
    if not MIN_LEVELS <= len(levels) <= MAX_LEVELS:
        raise LevelError(
            "level_count",
            f"There must be {MIN_LEVELS} to {MAX_LEVELS} levels, not {len(levels)}.",
            min=MIN_LEVELS,
            max=MAX_LEVELS,
            count=len(levels),
        )
    seen: set[str] = set()
    for level in levels:
        key = level.name.casefold()
        if key in seen:
            raise LevelError(
                "level_name_taken", f"Two levels are named '{level.name}'.", name=level.name
            )
        seen.add(key)
    defaults = [level for level in levels if level.is_default]
    if len(defaults) != 1:
        raise LevelError(
            "default_level_count",
            f"Exactly one level must be the default, not {len(defaults)}.",
            count=len(defaults),
        )
    if not defaults[0].selectable:
        # Also keeps one selectable level: the last one cannot go (H7).
        raise LevelError(
            "default_not_selectable",
            f"The default level '{defaults[0].name}' must be selectable.",
            name=defaults[0].name,
        )


def strictest(level: Level, classes: Iterable[OpClass]) -> CellMode:
    """The cell that governs an action touching ``classes`` (H4)."""
    modes = [level.matrix[c] for c in classes]
    if not modes:
        raise ValueError("an action touches at least one operation class")
    return max(modes, key=_STRICTNESS.__getitem__)


def resolve_level(levels: Sequence[Level], *, admin: bool, chosen_id: int | None) -> Level:
    """The level an account works on: its choice while that still exists and is
    open to it, else the default (H6, H7). Checked on every model action."""
    default = next(level for level in levels if level.is_default)
    for level in levels:
        if level.id == chosen_id and (level.selectable or admin):
            return level
    return default
