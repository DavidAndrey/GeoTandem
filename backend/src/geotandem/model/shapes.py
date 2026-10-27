"""Shapes that mean the same, written the way the controls write them
(testplan E-3).

A model may write a condition in a shape the controls never send: an ``and``
or ``or`` of one argument, ``not`` of a ``not``. Such a query means exactly
what its plain form means, and ``represent.to_analysis`` would refuse it
(``not_representable``) for the shape alone. ``plain`` rewrites it before the
query is checked; the record keeps the plain query, the answer the model's
own (design M3), so what the user sees is what runs.

A relation's filter of ``not`` around one comparison is written as the
comparison it means (``ne`` for ``not eq``): the controls cannot negate a
relation's filter, but have every comparison operator (plan-chain-eval, F12).

Nothing else is rewritten: a shape that changes the meaning, or one the
controls cannot show in any form, is still checked and refused as before.
"""

from typing import Any

from geotandem_query import QueryObject


def _plain(node: Any) -> Any:
    if not isinstance(node, dict):
        return node
    op = node.get("op")
    if op in ("and", "or"):
        args = [_plain(arg) for arg in node["args"]]
        return args[0] if len(args) == 1 else {**node, "args": args}
    if op == "not":
        arg = _plain(node["arg"])
        if isinstance(arg, dict) and arg.get("op") == "not":
            return arg["arg"]
        return {**node, "arg": arg}
    if op == "related" and node.get("where") is not None:
        return {**node, "where": _affirmed(_plain(node["where"]))}
    return node


COMPLEMENT = {"eq": "ne", "ne": "eq", "lt": "ge", "ge": "lt", "le": "gt", "gt": "le"}
"""A comparison and its negation: the same rows in SQL, where a missing value
fails both (``NULL = v`` and ``NOT (NULL = v)`` are both unknown)."""


def _affirmed(where: Any) -> Any:
    """A relation's filter ``not`` of one comparison as the comparison it
    means (plan-chain-eval, F12): the controls show a relation's filter as one
    row without a NICHT toggle, but with every comparison operator."""
    if isinstance(where, dict) and where.get("op") == "not":
        arg = where["arg"]
        if isinstance(arg, dict) and arg.get("op") == "compare":
            return {**arg, "cmp": COMPLEMENT[arg["cmp"]]}
    return where


def plain(query: QueryObject) -> QueryObject:
    """``query`` in its plain shape; the same object when it is plain already."""
    data = query.model_dump(mode="json", by_alias=True)
    where = _plain(data["where"])
    if where == data["where"]:
        return query
    return QueryObject.model_validate({**data, "where": where})
