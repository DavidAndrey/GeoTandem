"""Levels of model support: what the model may do (vision 8.1, plan E2.0)."""

from geotandem.levels.classify import classify
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
from geotandem.levels.store import load_levels

__all__ = [
    "MAX_LEVELS",
    "MAX_SYSTEM_PROMPT",
    "MIN_LEVELS",
    "CellMode",
    "Level",
    "LevelError",
    "OpClass",
    "classify",
    "load_levels",
    "resolve_level",
    "strictest",
    "validate_levels",
]
