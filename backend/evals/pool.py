"""Examples from the pool of tuning cases, for the arms of the measurement
(docs/plan-improve-examples.md, 6.5). Harness only, no application change.

- **Pool:** the tuning cases of every case file with a reference (``gold``,
  the first reading of ``gold_any``). Each becomes a worked example of both
  approaches: the direct answer is its reference as a query; the chain's plan
  is derived from it mechanically (``as_plan``, section 1 of the plan). A
  reference the chain's tools cannot write (``not`` around ``contains`` or
  ``intersects``, a relation inside ``or``) has no plan and stays out of the
  pool, so every arm's examples go to both calls of the check alike.
- **Arms:** ``a`` today's fixed set; ``b`` three pool cases drawn at random,
  seeded per case and seed; ``c`` three chosen by the selector (``choose``,
  section 2: layers named, then cue words for the shape). B and C keep the
  rules and two of the fixed examples, the first and the one that declines:
  pool cases only show queries.
- A case is never its own example (leave one out); confirm cases never are.

Step texts are written from the layer profile's labels («Haltestellen: Bahn,
höchstens 300 m von Schulen»); the last one is also the explanation, as the
cases have no words of their own for it.
"""

import hashlib
import json
import random
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

from variants import EXAMPLES, ExampleSet, join, split

from geotandem.catalog import LayerProfile, ModelProfile
from geotandem.evaluation.schemas import EvalCase
from geotandem.llm import Message

Arm = Literal["a", "b", "c"]
ARMS: Final[tuple[Arm, ...]] = ("a", "b", "c")
COUNT: Final = 3
"""Pool examples per question in arms B and C (section 1: up to three)."""

POOL_INTRO: Final = (
    "Die folgenden Beispiele sind geprüfte Fragen an die Layer des Layer-Steckbriefs. "
    "Auch sie sind kein Teil des Gesprächs."
)

Node = dict[str, Any]


# --- the plan of a reference ------------------------------------------------------


def _parts(where: Node | None) -> list[Node]:
    if where is None:
        return []
    return list(where["args"]) if where["op"] == "and" else [where]


def _relates(node: Node) -> bool:
    if node["op"] == "related":
        return True
    return any(_relates(n) for n in node.get("args", [])) or (
        "arg" in node and _relates(node["arg"])
    )


def _conjoin(parts: Sequence[Node]) -> Node | None:
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else {"op": "and", "args": list(parts)}


class Words:
    """Step texts from the layer profile's labels: «Haltestellen: Bahn»."""

    def __init__(self, profile: ModelProfile) -> None:
        self.layers = {layer.name: layer for layer in profile.layers}

    def condition(self, layer: str, node: Node) -> str:
        attributes = {a.name: a for a in self.layers[layer].attributes}
        op = node["op"]
        if op in ("and", "or"):
            joiner = ", " if op == "and" else " oder "
            return joiner.join(self.condition(layer, n) for n in node["args"])
        if op == "not":
            return "nicht " + self.condition(layer, node["arg"])
        attribute = attributes[node["attr"]]
        codes = attribute.codes or {}
        if op == "in":
            return " oder ".join(codes.get(v, str(v)) for v in node["values"])
        value = node.get("value")
        if op != "compare":
            return f"{attribute.label} {op} {value}" if value is not None else attribute.label
        if attribute.type == "boolean":
            return attribute.label if value else "ohne " + attribute.label.removeprefix("Mit ")
        if node["cmp"] == "eq":
            return codes.get(str(value), str(value))
        unit = f" {attribute.unit}" if attribute.unit else ""
        cmp = {"lt": "unter", "le": "höchstens", "gt": "über", "ge": "mindestens"}.get(
            node["cmp"], node["cmp"]
        )
        return f"{attribute.label} {cmp} {value}{unit}"

    def of(self, layer: str, where: Node | None) -> str:
        title = self.layers[layer].title
        return f"{title}: {self.condition(layer, where)}" if where else title


Relation = tuple[bool, Node]
"""Negated, and the ``related`` node."""


def _taken_apart(reading: Node) -> tuple[list[Node], list[Relation]] | None:
    """The subject's attribute conditions and its relations; ``None`` for a
    relation inside ``or`` or inside a related layer's filter."""
    attributes, relations = [], []
    for part in _parts(reading.get("where")):
        negated = part["op"] == "not" and part["arg"]["op"] == "related"
        node = part["arg"] if negated else part
        if node["op"] == "related":
            if "where" in node and _relates(node["where"]):
                return None
            relations.append((negated, node))
        elif _relates(part):
            return None
        else:
            attributes.append(part)
    return attributes, relations


def _target(relation: Relation, steps: list[Node], words: Words) -> int | str:
    """What the spatial step of ``relation`` relates to: a buffer for a
    negated distance, a filter for a filtered layer (added to ``steps``), or
    the whole layer by its name."""
    negated, node = relation
    layer, where = node["layer"], node.get("where")
    if negated and node["predicate"] == "dwithin":
        arguments = {"layer": layer, "distance_m": node["distance_m"]} | (
            {"where": where} if where else {}
        )
        text = f"{node['distance_m']:g} m um {words.of(layer, where)}"
        steps.append({"text": text, "tool": "buffer", "arguments": arguments})
    elif where:
        arguments = {"layer": layer, "where": where}
        steps.append({"text": words.of(layer, where), "tool": "filter", "arguments": arguments})
    else:
        return str(layer)
    return len(steps)


def _spatial(relation: Relation, of: int | str, target: int | str) -> tuple[str, Node, str]:
    """The spatial step of ``relation``: its tool, arguments and words."""
    negated, node = relation
    predicate = node["predicate"]
    if negated:
        distance = node.get("distance_m")
        phrase = f"weiter als {distance:g} m von" if distance else "ausserhalb"
        return "outside", {"of": of, "in": target}, phrase
    if predicate == "dwithin":
        distance = node["distance_m"]
        return (
            "near",
            {"of": of, "to": target, "distance_m": distance},
            f"höchstens {distance:g} m von",
        )
    key = {"within": "in", "contains": "has", "intersects": "with"}[predicate]
    phrase = {"within": "in", "contains": "mit", "intersects": "schneidet"}[predicate]
    return predicate, {"of": of, key: target}, phrase


def _writable(relation: Relation, subject: str, words: Words) -> bool:
    """Whether a tool writes ``relation``: of a negation only ``within``
    (``outside``) and, for points, ``dwithin`` (``outside`` of a buffer)."""
    negated, node = relation
    if not negated or node["predicate"] == "within":
        return True
    points = words.layers[subject].geometry_type == "Point"
    return node["predicate"] == "dwithin" and points


def as_plan(reading: Node, words: Words) -> list[Node] | None:
    """The chain's steps for ``reading``, as section 1 of the plan derives them:
    the related layers' filters first, then the subject's, then one spatial
    step per relation on the step before. ``None`` when the chain's tools
    cannot write it (``_taken_apart``, ``_writable``)."""
    subject = reading["source"]
    found = _taken_apart(reading)
    if found is None or not all(_writable(r, subject, words) for r in found[1]):
        return None
    attributes, relations = found
    steps: list[Node] = []
    targets = [_target(relation, steps, words) for relation in relations]
    current: int | str = subject
    text = words.of(subject, _conjoin(attributes))
    if attributes:
        arguments = {"layer": subject, "where": _conjoin(attributes)}
        steps.append({"text": text, "tool": "filter", "arguments": arguments})
        current = len(steps)
    for relation, target in zip(relations, targets, strict=True):
        tool, arguments, phrase = _spatial(relation, current, target)
        text = f"{text}, {phrase} {words.of(relation[1]['layer'], relation[1].get('where'))}"
        steps.append({"text": text, "tool": tool, "arguments": arguments})
        current = len(steps)
    return steps


# --- the pool ---------------------------------------------------------------------


@dataclass(frozen=True)
class Example:
    case: str
    """The pool case's id."""
    question: str
    reading: Node
    plan: tuple[Node, ...]

    def shot(self, approach: Literal["direct", "chain"]) -> tuple[str, str]:
        """(question, answer JSON) as the fixed set writes them."""
        answer: Node = {"kind": "query" if approach == "direct" else "plan"}
        answer |= {"explanation": self.plan[-1]["text"] + ".", "assumptions": []}
        if approach == "direct":
            answer["query"] = self.reading | {"output": "map"}
        else:
            answer["steps"] = list(self.plan)
        return self.question, json.dumps(answer, ensure_ascii=False, separators=(",", ":"))


def pool_of(cases: Iterable[EvalCase], profile: ModelProfile) -> list[Example]:
    """Every tuning case with a reference the chain can write too, by id."""
    words = Words(profile)
    found = []
    for case in cases:
        if case.split != "tuning" or not case.readings():
            continue
        reading = case.readings()[0]
        plan = as_plan(reading, words)
        if plan:
            found.append(Example(case.id, case.prompt, reading, tuple(plan)))
    return sorted(found, key=lambda e: e.case)


def pool_hash(pool: Sequence[Example]) -> str:
    """Over the pool's ids, questions and readings: the run label's (section 5)."""
    blob = json.dumps([[e.case, e.question, e.reading] for e in pool], sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def draw(pool: Sequence[Example], case: str, seed: int, k: int = COUNT) -> list[Example]:
    """Arm B: ``k`` pool cases at random, not ``case`` itself; the same for a
    case and seed in every run, model and approach."""
    others = [e for e in pool if e.case != case]
    return random.Random(f"{case}:{seed}").sample(others, k)


# --- the selector (section 2) -------------------------------------------------------

CUES: Final[dict[str, tuple[str, ...]]] = {
    "near": (
        r"\bnähe\b",
        r"\bnahe\b",
        r"umkreis",
        r"höchstens",
        r"näher als",
        r"weiter als",
        r"entfernt",
        r"vorbei",
        r"\d+\s*k?m\b",
    ),
    "negation": (
        r"ausserhalb",
        r"\bohne\b",
        r"\bnicht\b",
        r"\bkein",
        r"weiter als",
        r"mehr als \d+\s*k?m",
    ),
    "contains": (
        r"\bmit (einer|einem|mindestens)\b",
        r"\bha(t|ben) (eine|einen|ein)\b",
        r"in denen",
        r"in welchen",
        r"enthalten",
    ),
    "within": (r"\bin\b", r"innerhalb"),
    "intersects": (
        r"\bdurch",
        r"quer",
        r"kreuz",
        r"schneid",
        r"\ban (der|dem|einem|einer)\b",
        r"entlang",
    ),
}
"""German cue words of each operation (section 2); ``within`` and
``intersects`` are added to the plan's list, the shapes of the pool have them.
A count has no pool case, ``buffer`` is ``near`` in a direct query."""


def operations(reading: Node) -> frozenset[str]:
    """The operations a reference shows, in the cues' names, and
    ``filter-subject`` for a condition on the subject itself."""
    found = set()
    for part in _parts(reading.get("where")):
        negated = part["op"] == "not" and part["arg"]["op"] == "related"
        node = part["arg"] if negated else part
        if node["op"] != "related":
            found.add("filter-subject")
            continue
        found.add("near" if node["predicate"] == "dwithin" else node["predicate"])
        if negated:
            found.add("negation")
    return frozenset(found)


def _stems(layer: LayerProfile) -> list[str]:
    """What names the layer in a question: its title without a plural «n», its
    code labels and its yes/no attributes («Mit Primarstufe» ⇒ «primarstufe»);
    nothing shorter than three letters."""
    stems = [layer.title.lower().removesuffix("n")]
    for a in layer.attributes:
        if a.type == "boolean":
            stems.append(a.label.lower().removeprefix("mit "))
        stems += [label.lower() for label in (a.codes or {}).values()]
    return [s for s in stems if len(s) >= 3]


def named(question: str, profile: ModelProfile) -> list[str]:
    """The layers ``question`` names, in the order it first names them."""
    text = question.lower()
    found = []
    for layer in profile.layers:
        places = [text.find(s) for s in _stems(layer) if s in text]
        if places:
            found.append((min(places), layer.name))
    return [name for _, name in sorted(found)]


def cued(question: str, layers: Sequence[str], profile: ModelProfile) -> frozenset[str]:
    """The operations ``question`` cues; ``filter-subject`` when the subject's
    word is a compound or a code or yes/no label of it is named."""
    text = question.lower()
    found = {op for op, cues in CUES.items() if any(re.search(c, text) for c in cues)}
    if layers:
        layer = next(lp for lp in profile.layers if lp.name == layers[0])
        title, *labels = _stems(layer)
        compound = re.search(rf"\w+{re.escape(title)}", text)
        if compound or any(label in text for label in labels):
            found.add("filter-subject")
    return frozenset(found)


def choose(
    question: str, case: str, pool: Sequence[Example], profile: ModelProfile, k: int = COUNT
) -> list[Example]:
    """Arm C: the ``k`` pool cases nearest ``question``, never ``case`` itself.
    Ranked by the subject named first, then the other layers in common, then
    the operations in common, and fewer operations the question does not cue;
    ties by id. Only the question and the profile are read, never the case."""
    layers = named(question, profile)
    ops = cued(question, layers, profile)

    def rank(example: Example) -> tuple[int, int, int, int]:
        theirs = [example.reading["source"]] + [
            n["layer"]
            for p in _parts(example.reading.get("where"))
            for n in [p["arg"] if p["op"] == "not" else p]
            if n["op"] == "related"
        ]
        shown = operations(example.reading)
        subject = int(bool(layers) and theirs[0] == layers[0])
        return (
            -subject,
            -len(set(theirs[1:]) & set(layers[1:])),
            -len(shown & ops),
            len(shown - ops),
        )

    others = [e for e in pool if e.case != case]
    return sorted(others, key=lambda e: (rank(e), e.case))[:k]


# --- the section ------------------------------------------------------------------

BASE: Final = (0, -1)
"""The fixed examples B and C keep: the first and the last, which declines."""


def section(fixed: str, examples: Sequence[Example], approach: Literal["direct", "chain"]) -> str:
    """``fixed`` (a ``# Beispiele`` section) with its worked examples cut to
    ``BASE`` and the pool's ``examples`` after them."""
    parsed = ExampleSet.parse(fixed)
    base = [parsed.shots[i] for i in BASE]
    kept = ExampleSet(parsed.intro, parsed.rules, tuple(base)).text()
    pool = [f"Frage: {q}\n{a}" for q, a in (e.shot(approach) for e in examples)]
    return "\n\n".join([kept, POOL_INTRO, *pool])


def with_pool(
    messages: Sequence[Message], examples: Sequence[Example], approach: Literal["direct", "chain"]
) -> list[Message]:
    """The messages with their ``# Beispiele`` section rebuilt by ``section``."""
    system, *rest = messages
    sections = split(system.content)
    sections[EXAMPLES] = section(sections[EXAMPLES], examples, approach)
    return [Message("system", join(sections)), *rest]
