"""Signatures of references and the groups of the measurement
(docs/plan-improve-examples.md, 6.4).

A reference is reduced to its **layers** (the subject and the related layers)
and its **shape** (whether the subject is filtered, and each relation with its
predicate, whether it is negated and whether the related layer is filtered),
without values. Its **full** signature is the reading itself, values included.

Every confirm case is put in a group by the nearest tuning case (the pool):

1. a pool case with the same layers and the same shape (another value);
2. one with the same layers, another shape;
3. one with the same shape, other layers;
4. nothing alike.

A confirm case whose full signature a pool case shares is a copy (a
paraphrase); copies are not allowed across the splits. Cases without a
reference (behaviour cases) have no signature and no group.
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from geotandem.evaluation.schemas import EvalCase

Node = dict[str, Any]
Relation = tuple[bool, str, bool]
"""Negated, predicate, related layer filtered."""


@dataclass(frozen=True)
class Signature:
    layers: tuple[str, tuple[str, ...]]
    """The subject, then the related layers, sorted."""
    shape: tuple[bool, tuple[Relation, ...]]
    """Subject filtered, then the relations, sorted."""
    full: str
    """The reading as canonical JSON."""


def signature(reading: Node) -> Signature:
    where = reading.get("where")
    parts = (where["args"] if where["op"] == "and" else [where]) if where else []
    filtered, relations, related = False, [], []
    for part in parts:
        negated = part["op"] == "not" and part["arg"]["op"] == "related"
        node = part["arg"] if negated else part
        if node["op"] == "related":
            relations.append((negated, node["predicate"], "where" in node))
            related.append(node["layer"])
        else:
            filtered = True
    return Signature(
        layers=(reading["source"], tuple(sorted(related))),
        shape=(filtered, tuple(sorted(relations))),
        full=json.dumps(reading, sort_keys=True, ensure_ascii=False),
    )


def group(case: EvalCase, pool: Iterable[EvalCase]) -> int | None:
    """The group (1-4) of ``case`` against ``pool``, from its first reading;
    ``None`` for a case without a reference."""
    if not case.readings():
        return None
    own = signature(case.readings()[0])
    found = [signature(r) for other in pool if other.id != case.id for r in other.readings()]
    if any(s.layers == own.layers and s.shape == own.shape for s in found):
        return 1
    if any(s.layers == own.layers for s in found):
        return 2
    if any(s.shape == own.shape for s in found):
        return 3
    return 4


def copies(confirm: Iterable[EvalCase], pool: Iterable[EvalCase]) -> list[tuple[str, str]]:
    """``(confirm id, pool id)`` for every reading a pool case shares in full."""
    held = {signature(r).full: other.id for other in pool for r in other.readings()}
    return [
        (case.id, held[s])
        for case in confirm
        for s in (signature(r).full for r in case.readings())
        if s in held
    ]
