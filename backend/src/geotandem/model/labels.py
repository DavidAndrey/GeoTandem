"""A code's label where its code belongs, read as the code (testplan E-2).

An attribute with a code list (``codes`` in the layer profile, S2) holds the
codes; the profile gives each its label. Models write the label or the code
in another case ("Bahn" for ``bahn``, "Primarstufe" for ``primar``) more often
than any other mistake (docs/testplan-initial-llm-run.md, 5). The model knows
both from its profile, so the reading is the user's too: ``as_codes`` replaces
such a value by its code before the query is checked, and the record keeps the
query with the code. The controls show a code by its label, so what the user
sees does not change.

Only a value that is no code of its attribute and matches exactly one code or
label, ignoring case and whether words are joined by spaces, underscores or
hyphens ("sekundarstufe_i" for "Sekundarstufe I"), is replaced; any other
value stays and is checked as before. Equality and list conditions only
(``compare`` with ``eq``/``ne``, ``in``): an order or a text match on a code
means something else. A relation's filter is read against the related
layer's codes.
"""

import re
from collections.abc import Mapping
from typing import Any

from geotandem.catalog import ModelProfile
from geotandem_query import QueryObject

Codes = Mapping[str, Mapping[str, Mapping[str, str]]]
"""Layer → attribute → code → label."""


def codes_of(profile: ModelProfile) -> dict[str, dict[str, dict[str, str]]]:
    """The code lists of the profile's layers."""
    return {
        layer.name: {a.name: a.codes for a in layer.attributes if a.codes}
        for layer in profile.layers
    }


def _plain(text: str) -> str:
    """Case, and spaces, underscores and hyphens between words, ignored."""
    return " ".join(re.split(r"[\s_-]+", text.casefold())).strip()


def _code(value: Any, codes: Mapping[str, str]) -> Any:
    if not isinstance(value, str) or value in codes:
        return value
    wanted = _plain(value)
    found = {code for code, label in codes.items() if wanted in (_plain(code), _plain(label))}
    return found.pop() if len(found) == 1 else value


def _condition(node: Any, layer: str, codes: Codes) -> Any:
    if not isinstance(node, dict):
        return node
    op = node.get("op")
    if op in ("and", "or"):
        return {**node, "args": [_condition(arg, layer, codes) for arg in node["args"]]}
    if op == "not":
        return {**node, "arg": _condition(node["arg"], layer, codes)}
    if op == "related" and node.get("where") is not None:
        return {**node, "where": _condition(node["where"], node["layer"], codes)}
    attribute = codes.get(layer, {}).get(node.get("attr", ""))
    if attribute is None:
        return node
    if op == "compare" and node["cmp"] in ("eq", "ne"):
        return {**node, "value": _code(node["value"], attribute)}
    if op == "in":
        return {**node, "values": [_code(v, attribute) for v in node["values"]]}
    return node


def as_codes(query: QueryObject, profile: ModelProfile) -> QueryObject:
    """``query`` with each label in place of a code replaced by the code; the
    same object when there is none."""
    data = query.model_dump(mode="json", by_alias=True)
    where = _condition(data["where"], query.source, codes_of(profile))
    if where == data["where"]:
        return query
    return QueryObject.model_validate({**data, "where": where})
