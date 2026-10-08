"""Levels of model support: what the model may do (vision 8.1, plan E2.0)."""

from geotandem.levels.classify import allowed, classify, classify_parts
from geotandem.levels.model import (
    MAX_LEVELS,
    MAX_SYSTEM_PROMPT,
    MIN_LEVELS,
    CellMode,
    Level,
    LevelError,
    OpClass,
    resolve_level,
    strictest,
    validate_levels,
)
from geotandem.levels.store import (
    UnknownLevel,
    active_level,
    choose_level,
    chosen_level_id,
    load_levels,
    save_levels,
)

__all__ = [
    "MAX_LEVELS",
    "MAX_SYSTEM_PROMPT",
    "MIN_LEVELS",
    "CellMode",
    "Level",
    "LevelError",
    "OpClass",
    "UnknownLevel",
    "active_level",
    "allowed",
    "choose_level",
    "chosen_level_id",
    "classify",
    "classify_parts",
    "load_levels",
    "resolve_level",
    "save_levels",
    "strictest",
    "validate_levels",
]
