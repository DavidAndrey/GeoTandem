"""Stage 1 of bewertung.md 4: the answer's query against a reading (plan E3, D5).

Both queries are brought to one canonical form first, so what only looks
different is not shown: E2's canonical JSON (key order, omitted defaults, ``5``
for ``5.0``); the harmless shapes of E-3 (``and`` or ``or`` of one, ``not`` of
``not``, the rules of ``shapes.plain``); nested ``and`` in ``and`` and ``or``
in ``or`` flattened; the arguments of ``and`` and ``or`` and the values of
``in`` sorted and without repeats; the names of an aggregate's metrics left
out (names of intermediate results may differ). Values are compared as their
JSON, so ``true`` is not ``1``. What is left is listed as ``DiffEntry``:
``source`` for another source layer; ``missing``, ``added`` and ``changed``
for conditions. An empty list means equal after normalisation. The diff
explains, it never judges: a different query may select the same features
(stage 2 decides).

Matching conditions between the trees. Under an ``and`` or ``or`` the
arguments of the reference and the answer are paired in three passes, each in
the canonical order, the first free partner taken:

1. equal conditions (they leave no entry);
2. the same identity: the attribute a condition tests (``attr``), the layer a
   relation or a feature reference names (``layer``); for ``not`` ``not`` and
   the identity of its argument, for a nested ``and``/``or`` its operator and
   the identities of its arguments; else the operator (``bbox``, ``geometry``);
3. for a condition without an attribute, the same operator (``related`` to
   another layer, ``not`` of another condition). A condition on another
   attribute is another condition.

A pair is ``changed`` (operator, value, predicate, distance, layer), or its
difference is looked for further inside (``and``/``or``/``not``; a
relation's own filter, ``where``); what stays unpaired is ``missing`` (the
reference's) or ``added`` (the answer's). Two single conditions follow the same
rule. A single condition against an ``and``/``or`` counts as one argument of
it, so a filter left out of ``and(a, b)`` is ``missing b``, not one change of
everything; ``and`` against ``or`` pairs nothing.

An entry holds the two condition nodes in canonical form, never data: the
values in it are the queries' own constants. A ``changed`` relation is shown
without its ``where``, whose differences are entries of their own. ``path``
addresses the node in the query as given, not in its canonical form: in the
reference as the case stores it, for ``added`` in the answer's query
(``where.args[1].where``); the canonical form carries each node's original
path through the rewrites, which is why it does not call ``shapes.plain``.
Besides ``where``, the parts of a query that decide its features are compared
as a whole (``attribute_join``, ``buffer``, ``spatial_relation``,
``aggregate``, ``columns``, ``order_by``, ``limit``: a computed column can
decide what ``order_by`` and ``limit`` keep); presentation (``select``,
``symbology``, ``output``) is not.
"""

import json
from dataclasses import dataclass
from typing import Any

from geotandem.evaluation.schemas import DiffEntry, DiffKind
from geotandem_query import QueryObject, canonical_json

PARTS = (
    "attribute_join",
    "buffer",
    "spatial_relation",
    "aggregate",
    "columns",
    "order_by",
    "limit",
)
"""Parts besides ``source`` and ``where`` that decide which features a query selects."""
JUNCTIONS = ("and", "or")

Node = dict[str, Any]


@dataclass(frozen=True, eq=False)
class Cond:
    """A condition in canonical form with its path in the query as given;
    equal only to itself (its node is compared with ``_key``)."""

    node: Node
    """Canonical, as compared and shown."""
    path: str
    args: tuple["Cond", ...] = ()
    """Of ``and`` and ``or``."""
    arg: "Cond | None" = None
    """Of ``not``."""
    where: "Cond | None" = None
    """Of ``related``."""


def canonical(query: QueryObject) -> dict[str, Any]:
    """``query`` in the form stage 1 compares."""
    return _form(query)[0]


def diff(reference: QueryObject, answer: QueryObject) -> list[DiffEntry]:
    """What differs between ``answer`` and ``reference`` after normalisation;
    empty when they are equal."""
    (ref, ref_where), (got, got_where) = _form(reference), _form(answer)
    found: list[DiffEntry] = []
    if ref["source"] != got["source"]:
        source = DiffEntry(
            kind="source", path="source", reference=ref["source"], answer=got["source"]
        )
        found.append(source)
    found += _node(ref_where, got_where)
    for part in PARTS:
        want, have = ref.get(part), got.get(part)
        if _key(want) != _key(have):
            found.append(DiffEntry(kind=_kind(want, have), path=part, reference=want, answer=have))
    return found


# --- canonical form ---------------------------------------------------------------


def _form(query: QueryObject) -> tuple[dict[str, Any], Cond | None]:
    data: dict[str, Any] = _compact(json.loads(canonical_json(query)))
    where = _cond(data["where"], "where") if "where" in data else None
    if where is not None:
        data["where"] = where.node
    relation = data.get("spatial_relation")
    if relation is not None and "where" in relation:
        relation["where"] = _cond(relation["where"], "").node
    for column in data.get("columns", []):
        if "where" in column:
            column["where"] = _cond(column["where"], "").node
    aggregate = data.get("aggregate")
    if aggregate is not None:
        aggregate["metrics"] = sorted(
            ({k: v for k, v in m.items() if k != "as"} for m in aggregate["metrics"]), key=_key
        )
    return data, where


def _compact(value: Any) -> Any:
    """Without ``None`` and empty lists: what is unset is not shown."""
    if isinstance(value, dict):
        return {k: _compact(v) for k, v in value.items() if v is not None and v != []}
    if isinstance(value, list):
        return [_compact(v) for v in value]
    return value


def _key(value: Any) -> str:
    """Compared as JSON: ``true`` and ``1`` differ, key order does not."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _unique(values: list[Any], key: Any = _key) -> list[Any]:
    """Sorted by ``key``, the first of equal ones kept."""
    found: dict[str, Any] = {}
    for value in sorted(values, key=key):
        found.setdefault(key(value), value)
    return list(found.values())


def _cond(raw: Node, path: str) -> Cond:
    op = raw["op"]
    if op in JUNCTIONS:
        args: list[Cond] = []
        for i, arg in enumerate(raw["args"]):
            child = _cond(arg, f"{path}.args[{i}]")
            args += child.args if child.node["op"] == op else [child]
        args = _unique(args, key=lambda c: _key(c.node))
        if len(args) == 1:  # ``and`` of one
            return args[0]
        return Cond({"op": op, "args": [c.node for c in args]}, path, args=tuple(args))
    if op == "not":
        inner = _cond(raw["arg"], f"{path}.arg")
        if inner.arg is not None:  # ``not`` of ``not``
            return inner.arg
        return Cond({"op": op, "arg": inner.node}, path, arg=inner)
    if op == "in":
        return Cond({**raw, "values": _unique(raw["values"])}, path)
    if op == "related" and "where" in raw:
        where = _cond(raw["where"], f"{path}.where")
        return Cond({**raw, "where": where.node}, path, where=where)
    return Cond(raw, path)


# --- the diff ----------------------------------------------------------------------


def _kind(want: Any, have: Any) -> DiffKind:
    if have is None:
        return "missing"
    if want is None:
        return "added"
    return "changed"


def _missing(want: Cond) -> DiffEntry:
    return DiffEntry(kind="missing", path=want.path, reference=want.node)


def _added(have: Cond) -> DiffEntry:
    return DiffEntry(kind="added", path=have.path, answer=have.node)


def _changed(want: Cond, reference: Node, answer: Node) -> DiffEntry:
    return DiffEntry(kind="changed", path=want.path, reference=reference, answer=answer)


def _node(want: Cond | None, have: Cond | None) -> list[DiffEntry]:
    if want is None and have is None:
        return []
    if want is None:
        assert have is not None
        return [_added(have)]
    if have is None:
        return [_missing(want)]
    if _key(want.node) == _key(have.node):
        return []
    junctions = {want.node["op"], have.node["op"]} & set(JUNCTIONS)
    if len(junctions) == 1:
        [junction] = junctions
        return _args(_items(want, junction), _items(have, junction))
    if not any(_paired(key, want, have) for key in KEYS):
        return [_missing(want), _added(have)]
    if want.arg is not None and have.arg is not None:
        return _node(want.arg, have.arg)
    if want.node["op"] == have.node["op"] == "related":
        own_want = {k: v for k, v in want.node.items() if k != "where"}
        own_have = {k: v for k, v in have.node.items() if k != "where"}
        found = []
        if _key(own_want) != _key(own_have):
            found.append(_changed(want, own_want, own_have))
        return found + _node(want.where, have.where)
    return [_changed(want, want.node, have.node)]


def _items(cond: Cond, junction: str) -> list[Cond]:
    return list(cond.args) if cond.node["op"] == junction else [cond]


def _identity(node: Node) -> str:
    if "attr" in node:
        return f"attr:{node['attr']}"
    if "layer" in node:
        return f"layer:{node['layer']}"
    if node["op"] == "not":
        return f"not:{_identity(node['arg'])}"
    if node["op"] in JUNCTIONS:
        return f"{node['op']}:{','.join(sorted(_identity(a) for a in node['args']))}"
    return f"op:{node['op']}"


def _operator(node: Node) -> str | None:
    """A condition on another attribute is another condition, not a change."""
    return None if "attr" in node else str(node["op"])


KEYS = (_identity, _operator)
"""Passes 2 and 3: what pairs two conditions that are not equal."""


def _paired(key: Any, want: Cond, have: Cond) -> bool:
    mine = key(want.node)
    return mine is not None and mine == key(have.node)


def _args(wants: list[Cond], haves: list[Cond]) -> list[DiffEntry]:
    found: list[DiffEntry] = []
    free = list(haves)
    left: list[Cond] = []
    for want in wants:  # pass 1: equal
        same = next((h for h in free if _key(h.node) == _key(want.node)), None)
        if same is None:
            left.append(want)
        else:
            free.remove(same)
    for key in KEYS:
        unpaired: list[Cond] = []
        for want in left:
            partner = next((h for h in free if _paired(key, want, h)), None)
            if partner is None:
                unpaired.append(want)
                continue
            free.remove(partner)
            found += _node(want, partner)
        left = unpaired
    found += [_missing(want) for want in left]
    found += [_added(have) for have in free]
    return found
