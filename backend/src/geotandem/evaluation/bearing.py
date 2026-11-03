"""Load-bearing conditions of a case's reference (plan-improve-examples 6.1, 6.3).

A case can only catch an answer that drops a condition if dropping that
condition changes the result. Each condition of a reading is left out in turn
and the query read again on the case's data: a condition whose removal leaves
the same features is *idle*, and an answer without it would pass.

Left out in turn: every condition under ``and`` or ``or`` (an ``and`` or ``or``
left with one argument becomes that argument), a relation's own filter and the
conditions in it, the conditions inside a ``not`` (the ``not`` as a whole
counts as one condition). An ``and`` or ``or`` itself is not a condition; its
arguments are. A ``where`` of a single condition is left out entirely.
"""

from collections.abc import Iterator
from typing import Any

from geotandem.data import DataBackend, Limits
from geotandem.engine import ids_query
from geotandem.evaluation.grade import query_of
from geotandem.evaluation.schemas import EvalCase

Node = dict[str, Any]


def without_one(node: Node) -> Iterator[tuple[Node, Node | None]]:
    """``(condition, node without it)`` for every condition of ``node``;
    ``None`` when nothing is left."""
    op = node["op"]
    if op in ("and", "or"):
        for i, arg in enumerate(node["args"]):
            for condition, rest in without_one(arg):
                args = [*node["args"][:i], *([rest] if rest else []), *node["args"][i + 1 :]]
                yield condition, args[0] if len(args) == 1 else {**node, "args": args}
        return
    yield node, None
    if op == "not":
        for condition, rest in without_one(node["arg"]):
            if rest is not None:
                yield condition, {**node, "arg": rest}
    elif op == "related" and node.get("where"):
        for condition, rest in without_one(node["where"]):
            bare = {k: v for k, v in node.items() if k != "where"}
            yield condition, bare if rest is None else {**bare, "where": rest}


def label(condition: Node) -> str:
    """A condition in a few words, for a test's message."""
    match condition["op"]:
        case "compare":
            return f"{condition['attr']} {condition['cmp']} {condition.get('value')}"
        case "related":
            return f"related {condition['predicate']} {condition['layer']}"
        case op:
            return str(op)


def idle_conditions(case: EvalCase, backend: DataBackend, limits: Limits) -> list[str]:
    """The conditions of ``case``'s readings that change nothing on ``backend``,
    labelled; empty for a case without readings or a ``where``."""
    idle = []
    for reading in case.readings():
        if not reading.get("where"):
            continue
        found = ids_query(query_of(reading, case.schema_version), backend, limits)
        for condition, rest in without_one(reading["where"]):
            dropped = {k: v for k, v in reading.items() if k != "where"}
            if rest is not None:
                dropped["where"] = rest
            if ids_query(query_of(dropped, case.schema_version), backend, limits) == found:
                idle.append(label(condition))
    return idle
