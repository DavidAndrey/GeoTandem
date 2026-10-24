"""Stage 1 of bewertung.md 4: the answer's query against a reading (plan E3, D5).

Both queries are brought to one canonical form first, so what only looks
different is not shown: E2's canonical JSON (key order, omitted defaults, ``5``
for ``5.0``), the harmless shapes of E-3 (``shapes.plain``: ``and`` of one,
``not`` of ``not``), nested ``and`` in ``and`` and ``or`` in ``or`` flattened,
the arguments of ``and`` and ``or`` and the values of ``in`` sorted. What is
left is listed as ``DiffEntry``: ``source`` for another source layer;
``missing``, ``added`` and ``changed`` for conditions. An empty list means
equal after normalisation. The diff explains, it never judges: a different
query may select the same features (stage 2 decides).

Matching conditions between the trees. Under an ``and`` or ``or`` the
arguments of the reference and the answer are paired in three passes, each in
the canonical order, the first free partner taken:

1. equal conditions (they leave no entry);
2. the same identity: the attribute a condition tests (``attr``), the layer a
   relation or a feature reference names (``layer``), else the operator
   (``and``, ``or``, ``not``, ``bbox``, ``geometry``);
3. for a condition without an attribute, the same operator (``related`` to
   another layer). A condition on another attribute is another condition.

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
points into the canonical tree of the reference, for ``added`` into the
answer's (``where.args[1].where``). Besides ``where``, the parts of a query
that decide its features are compared as a whole (``attribute_join``,
``buffer``, ``spatial_relation``, ``aggregate``, ``order_by``, ``limit``);
presentation (``select``, ``columns``, ``symbology``, ``output``) is not.
"""

import json
from typing import Any

from geotandem.evaluation.schemas import DiffEntry, DiffKind
from geotandem.model.shapes import plain
from geotandem_query import QueryObject, canonical_json

PARTS = ("attribute_join", "buffer", "spatial_relation", "aggregate", "order_by", "limit")
"""Parts besides ``source`` and ``where`` that decide which features a query selects."""
JUNCTIONS = ("and", "or")

Node = dict[str, Any]
Item = tuple[Node, str]
"""A condition with its path in its tree."""


def canonical(query: QueryObject) -> dict[str, Any]:
    """``query`` in the form stage 1 compares: canonical JSON of its plain
    shape, without unset fields, junctions flattened and sorted."""
    data: dict[str, Any] = _compact(json.loads(canonical_json(plain(query))))
    if "where" in data:
        data["where"] = _sorted(data["where"])
    return data


def diff(reference: QueryObject, answer: QueryObject) -> list[DiffEntry]:
    """What differs between ``answer`` and ``reference`` after normalisation;
    empty when they are equal."""
    ref, got = canonical(reference), canonical(answer)
    found: list[DiffEntry] = []
    if ref["source"] != got["source"]:
        source = DiffEntry(
            kind="source", path="source", reference=ref["source"], answer=got["source"]
        )
        found.append(source)
    found += _node(ref.get("where"), got.get("where"), "where", "where")
    for part in PARTS:
        want, have = ref.get(part), got.get(part)
        if want != have:
            found.append(_entry(_kind(want, have), part, part, want, have))
    return found


# --- canonical form ---------------------------------------------------------------


def _compact(value: Any) -> Any:
    """Without ``None`` and empty lists: what is unset is not shown."""
    if isinstance(value, dict):
        return {k: _compact(v) for k, v in value.items() if v is not None and v != []}
    if isinstance(value, list):
        return [_compact(v) for v in value]
    return value


def _key(node: Any) -> str:
    return json.dumps(node, sort_keys=True, ensure_ascii=False)


def _sorted(node: Node) -> Node:
    op = node["op"]
    if op in JUNCTIONS:
        args: list[Node] = []
        for arg in (_sorted(a) for a in node["args"]):
            args += arg["args"] if arg["op"] == op else [arg]
        return {**node, "args": sorted(args, key=_key)}
    if op == "not":
        return {**node, "arg": _sorted(node["arg"])}
    if op == "in":
        return {**node, "values": sorted(node["values"], key=_key)}
    if op == "related" and "where" in node:
        return {**node, "where": _sorted(node["where"])}
    return node


# --- the diff ----------------------------------------------------------------------


def _kind(want: Any, have: Any) -> DiffKind:
    if have is None:
        return "missing"
    if want is None:
        return "added"
    return "changed"


def _entry(kind: DiffKind, ref_path: str, got_path: str, want: Any, have: Any) -> DiffEntry:
    return DiffEntry(
        kind=kind, path=got_path if kind == "added" else ref_path, reference=want, answer=have
    )


def _node(want: Node | None, have: Node | None, ref_path: str, got_path: str) -> list[DiffEntry]:
    if want == have:
        return []
    if want is None or have is None:
        return [_entry(_kind(want, have), ref_path, got_path, want, have)]
    junctions = {want["op"], have["op"]} & set(JUNCTIONS)
    if len(junctions) == 1:
        [junction] = junctions
        return _args(_items(want, junction, ref_path), _items(have, junction, got_path))
    if not any(key(want) is not None and key(want) == key(have) for key in KEYS):
        return [
            _entry("missing", ref_path, got_path, want, None),
            _entry("added", ref_path, got_path, None, have),
        ]
    if want["op"] == "not":
        return _node(want["arg"], have["arg"], f"{ref_path}.arg", f"{got_path}.arg")
    if want["op"] == "related":
        own_want = {k: v for k, v in want.items() if k != "where"}
        own_have = {k: v for k, v in have.items() if k != "where"}
        found = []
        if own_want != own_have:
            found.append(_entry("changed", ref_path, got_path, own_want, own_have))
        return found + _node(
            want.get("where"), have.get("where"), f"{ref_path}.where", f"{got_path}.where"
        )
    return [_entry("changed", ref_path, got_path, want, have)]


def _items(node: Node, junction: str, path: str) -> list[Item]:
    if node["op"] == junction:
        return [(arg, f"{path}.args[{i}]") for i, arg in enumerate(node["args"])]
    return [(node, path)]


def _identity(node: Node) -> str:
    if "attr" in node:
        return f"attr:{node['attr']}"
    if "layer" in node:
        return f"layer:{node['layer']}"
    return f"op:{node['op']}"


def _operator(node: Node) -> str | None:
    """A condition on another attribute is another condition, not a change."""
    return None if "attr" in node else str(node["op"])


KEYS = (_identity, _operator)
"""Passes 2 and 3: what pairs two conditions that are not equal."""


def _args(wants: list[Item], haves: list[Item]) -> list[DiffEntry]:
    found: list[DiffEntry] = []
    free = list(haves)
    left: list[Item] = []
    for want in wants:  # pass 1: equal
        same = next((h for h in free if h[0] == want[0]), None)
        if same is None:
            left.append(want)
        else:
            free.remove(same)
    for key in KEYS:
        unpaired: list[Item] = []
        for want in left:
            mine = key(want[0])
            partner = next((h for h in free if mine is not None and key(h[0]) == mine), None)
            if partner is None:
                unpaired.append(want)
                continue
            free.remove(partner)
            found += _node(want[0], partner[0], want[1], partner[1])
        left = unpaired
    found += [_entry("missing", path, path, node, None) for node, path in left]
    found += [_entry("added", path, path, None, node) for node, path in free]
    return found
