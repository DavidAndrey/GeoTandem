"""The two approaches side by side (design M10, plan WP76, P7): pure rules.

The difference is the application's, from feature ids, never the model's;
the service runs both stored queries as the caller and hands the ids here.
What this module adds:

- the layer a result's features belong to (``result_layer``): the source, or
  the area layer of an aggregate, whose features the aggregate returns;
- a feature's name (``FeatureRef.name``) is the value of the layer's name
  attribute: a text attribute called ``name``, ``bezeichnung`` or ``titel``,
  in that order, the names the interface reads a feature's label from
  (``workplace/layerInfo.ts``). Unlike the interface, which falls back to the
  first text attribute, there is no fallback here: on the sample's
  ``schulen`` that would be ``typ`` ("primar"), a category, not a name. A
  layer without one gives no name (``None``), and the interface shows the id.
- the ``reason`` is data, given only where it follows from the two query
  objects alone: the result layers differ (``source``), or their top-level
  conditions differ one by one (``conditions``): each condition on one side
  matched with the one on the other side about the same attribute or layer
  (``within`` against ``intersects``, 800 m against 500 m, > 1.65 against >
  1.6), or present on one side only. Any other difference (another top-level
  part, a group, an area or a feature as condition, two conditions about the
  same thing) leaves the reason out: never guessed, never the model's words.
  The interface says it in its own words (WP78).
"""

import json
from collections import Counter
from collections.abc import Hashable

from geotandem.catalog import LayerInfo
from geotandem.model.schemas import ConditionChange, ConditionsReason, Reason, SourceReason
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

HIT_PARTS = ("attribute_join", "buffer", "spatial_relation", "aggregate", "columns")
"""Top-level parts besides the source and the conditions that make up the
result; ``order_by`` and ``limit`` too, together."""


def result_layer(query: QueryObject) -> str:
    """The layer whose features ``query`` returns: an aggregate's area layer,
    else the source."""
    return query.aggregate.by_layer if query.aggregate is not None else query.source


def name_attribute(layer: LayerInfo | None) -> str | None:
    """The attribute that names a feature of ``layer``, if it has one."""
    texts = {a.name for a in layer.attributes if a.data_type == "text"} if layer else set()
    return next((name for name in NAME_ATTRIBUTES if name in texts), None)


def _about(c: Condition) -> Hashable | None:
    """What a condition is about: the attribute or the related layer; ``None``
    for one that is no single row of the controls (a group, an area, a feature)."""
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


def reason(left: QueryObject, right: QueryObject) -> Reason | None:
    """Why the hits of ``left`` and ``right`` differ, from the queries alone, or
    ``None`` (module docstring)."""
    if result_layer(left) != result_layer(right):
        return SourceReason(left=result_layer(left), right=result_layer(right))
    if left.source != right.source or _rest(left) != _rest(right):
        return None
    mine, theirs = _conditions(left), _conditions(right)
    gone, came = _only(mine, theirs), _only(theirs, mine)
    old, new = [_about(c) for c in gone], [_about(c) for c in came]
    if None in old + new or len(set(old)) < len(old) or len(set(new)) < len(new):
        return None  # a group, or two conditions about one thing: not one by one
    if not gone and not came:
        return None
    before = dict(zip(old, gone, strict=True))
    changes = [
        ConditionChange(left=before.pop(a, None), right=c) for a, c in zip(new, came, strict=True)
    ]
    changes += [ConditionChange(left=c, right=None) for c in before.values()]
    return ConditionsReason(changes=changes)
