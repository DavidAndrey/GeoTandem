"""The two approaches side by side (design M10, plan WP76, P7): pure rules.

The difference is the application's, from feature ids, never the model's;
the service runs both stored queries as the caller and hands the ids here.
What this module adds is the words:

- a feature's name (``FeatureRef.name``) is the value of the layer's name
  attribute: a text attribute called ``name``, ``bezeichnung`` or ``titel``,
  in that order, the names the interface reads a feature's label from
  (``workplace/layerInfo.ts``). Unlike the interface, which falls back to the
  first text attribute, there is no fallback here: on the sample's
  ``schulen`` that would be ``typ`` ("primar"), a category, not a name. A
  layer without one gives no name (``None``), and the interface shows the id.
- the ``reason`` is said only where it follows from the two query objects
  alone: the result layers differ, or their conditions differ one by one, each
  condition on one side matched with the one on the other side about the same
  attribute or layer (``within`` against ``intersects``, 800 m against 500 m,
  > 1.65 against > 1.6), or present on one side only. Any other difference
  (another top-level part, a group, a condition the controls cannot say, two
  conditions about the same thing) leaves the reason out: never guessed, and
  never the model's words. The words are the editor's (``editor/describe.ts``),
  in German like the interface, since the field is the text the dialog shows.
"""

import json
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass

from geotandem.catalog import LayerInfo
from geotandem.model.schemas import Approach
from geotandem_query import And as AllOf
from geotandem_query import (
    Between,
    Compare,
    Condition,
    InList,
    IsNull,
    Not,
    QueryObject,
    RelatedByDistance,
    RelatedTopological,
    TextMatch,
)

NAME_ATTRIBUTES = ("name", "bezeichnung", "titel")
"""Attributes that name a feature, in this order (``labelAttribute`` of the interface)."""

APPROACH = {"direct": "Direktabfrage", "chain": "Werkzeugkette"}
RELATION = {"within": "liegt in", "intersects": "schneidet", "contains": "enthält"}
CMP = {"eq": "=", "ne": "≠", "lt": "<", "le": "≤", "gt": ">", "ge": "≥"}
TEXT = {
    "contains": "enthält",
    "starts_with": "beginnt mit",
    "ends_with": "endet mit",
    "equals": "=",
}

HIT_PARTS = ("attribute_join", "buffer", "spatial_relation", "aggregate")
"""Top-level parts besides the source and the conditions that decide the hits;
``order_by`` and ``limit`` too, together."""


def name_attribute(layer: LayerInfo | None) -> str | None:
    """The attribute that names a feature of ``layer``, if it has one."""
    texts = {a.name for a in layer.attributes if a.data_type == "text"} if layer else set()
    return next((name for name in NAME_ATTRIBUTES if name in texts), None)


@dataclass(frozen=True)
class Labels:
    """Layer titles and attribute labels as the caller's catalog has them."""

    layers: dict[str, LayerInfo]

    @classmethod
    def of(cls, layers: Iterable[LayerInfo]) -> "Labels":
        return cls({layer.name: layer for layer in layers})

    def layer(self, name: str) -> str:
        found = self.layers.get(name)
        return found.title if found and found.title else name

    def attribute(self, layer: str, name: str) -> str:
        found = self.layers.get(layer)
        attribute = next((a for a in found.attributes if a.name == name), None) if found else None
        return attribute.label if attribute and attribute.label else name


def _value(value: object) -> str:
    if isinstance(value, bool):
        return "ja" if value else "nein"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _filtered(base: str, where: Condition | None, layer: str, labels: Labels) -> str | None:
    if where is None:
        return base
    inner = describe(where, layer, labels)
    return None if inner is None else f"{base} ({inner})"


def describe(c: Condition, layer: str, labels: Labels) -> str | None:
    """One condition on ``layer`` in the editor's words; ``None`` for one the
    controls do not say as one row (a group, an area, a feature)."""
    match c:
        case Compare():
            return f"{labels.attribute(layer, c.attr)} {CMP[c.cmp]} {_value(c.value)}"
        case Between():
            field = labels.attribute(layer, c.attr)
            return f"{field} zwischen {_value(c.min)} – {_value(c.max)}"  # noqa: RUF001
        case InList():
            values = ", ".join(_value(v) for v in c.values)
            return f"{labels.attribute(layer, c.attr)} ist eins von {values}"
        case TextMatch():
            return f"{labels.attribute(layer, c.attr)} {TEXT[c.mode]} {c.text}"
        case IsNull():
            return f"{labels.attribute(layer, c.attr)} ist leer"
        case RelatedByDistance():
            near = f"≤ {_value(c.distance_m)} m zu {labels.layer(c.layer)}"
            return _filtered(near, c.where, c.layer, labels)
        case RelatedTopological():
            related = f"{RELATION[c.predicate]} {labels.layer(c.layer)}"
            return _filtered(related, c.where, c.layer, labels)
        case Not(arg=RelatedTopological(predicate="within") as inside):
            outside = f"liegt ausserhalb {labels.layer(inside.layer)}"
            return _filtered(outside, inside.where, inside.layer, labels)
        case Not(arg=RelatedByDistance() as near):
            far = f"> {_value(near.distance_m)} m zu {labels.layer(near.layer)}"
            return _filtered(far, near.where, near.layer, labels)
        case Not():
            inner = describe(c.arg, layer, labels)
            return None if inner is None else f"nicht {inner}"
        case _:
            return None


def _about(c: Condition) -> tuple[str, str] | None:
    """What a condition is about: the attribute or the related layer."""
    match c:
        case Not():
            return _about(c.arg)
        case RelatedByDistance() | RelatedTopological():
            return ("layer", c.layer)
        case Compare() | Between() | InList() | TextMatch() | IsNull():
            return ("attribute", c.attr)
        case _:
            return None


def _conditions(query: QueryObject) -> list[Condition]:
    """The conditions all of which a hit meets: the top-level ``and``'s."""
    if query.where is None:
        return []
    return list(query.where.args) if isinstance(query.where, AllOf) else [query.where]


def _key(c: Condition) -> str:
    return json.dumps(c.model_dump(mode="json", by_alias=True), sort_keys=True)


def _rest(query: QueryObject) -> str:
    parts = query.model_dump(mode="json", by_alias=True, include=set(HIT_PARTS))
    if query.limit is not None:
        parts |= query.model_dump(mode="json", by_alias=True, include={"order_by", "limit"})
    return json.dumps(parts, sort_keys=True)


def _only(ours: list[Condition], theirs: list[Condition]) -> list[Condition]:
    """``ours`` less those ``theirs`` has too, one for one."""
    left = Counter(_key(c) for c in theirs)
    found = []
    for c in ours:
        key = _key(c)
        if left[key]:
            left[key] -= 1
        else:
            found.append(c)
    return found


def reason(
    left: QueryObject,
    right: QueryObject,
    approaches: tuple[Approach, Approach],
    labels: Labels,
) -> str | None:
    """Why the hits of ``left`` and ``right`` differ, from the queries alone, or
    ``None`` (module docstring). Said from the right side, the repeat:
    "Werkzeugkette: „schneidet …“ statt „liegt in …“"."""
    if approaches[0] != approaches[1]:
        name = APPROACH[approaches[1]]
        only_right, only_left = (f"nur in der {APPROACH[a]}" for a in approaches[::-1])
    else:
        name, only_right, only_left = "Rechts", "nur rechts", "nur links"
    if left.source != right.source:
        now, then = labels.layer(right.source), labels.layer(left.source)
        return f"{name}: Ergebnis aus „{now}“ statt „{then}“"
    if _rest(left) != _rest(right):
        return None
    mine, theirs = _conditions(right), _conditions(left)
    added, missing = _only(mine, theirs), _only(theirs, mine)
    new, old = [_about(c) for c in added], [_about(c) for c in missing]
    if None in new + old or len(set(new)) < len(new) or len(set(old)) < len(old):
        return None  # a group, or two conditions about one thing: not one by one
    layer = left.source
    before = dict(zip(old, missing, strict=True))
    parts: list[str | None] = []
    for about, c in zip(new, added, strict=True):
        said = describe(c, layer, labels)
        replaced = before.pop(about, None)
        if replaced is None:
            parts.append(said and f"„{said}“ {only_right}")
        else:
            was = describe(replaced, layer, labels)
            parts.append(said and was and f"{name}: „{said}“ statt „{was}“")
    for c in before.values():
        said = describe(c, layer, labels)
        parts.append(said and f"„{said}“ {only_left}")
    if not parts or not all(parts):
        return None
    return "; ".join(p for p in parts if p)
