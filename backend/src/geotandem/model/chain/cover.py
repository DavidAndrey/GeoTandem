"""Whether a plan carries the conditions its question names (plan-chain-eval,
F21): the chain's silent wrongs are mostly a condition of the question the plan
drops, a subject named as a whole layer where the question restricts it
(F17). Two kinds of condition are found in the question's text, from the
layer profile the model was given and nothing else:

1. a **code** of a confirmed code list, or a boolean attribute, by its stem:
   the code before ``_`` (``kantonsstrasse_a`` ⇒ ``kantonsstrasse``), or the
   first word of its label where the code is shorter than ``MIN_STEM``
   (``fr`` ⇒ ``französisch``), or the boolean attribute's name; a stem inside
   a longer one found at the same place counts as the longer only
   (``Seilbahn`` is no ``Bahn``), a short stem only at the start of a word
   (``WORD_START``). The plan carries it when a value it writes
   holds the stem or the code (``in``, ``compare``, ``text_match``, a boolean
   attribute set), when a condition is on that attribute of the layer (a
   complement: «weder Bus noch Tram» as the other codes), or when a step
   names a single feature of that layer by a text attribute without codes
   («der Bahnhof Bern»: a name is narrower than a class);
2. a **distance** («500 m», «2 km»): the plan writes it, within
   ``TOLERANCE``, as a ``distance_m`` or as a value in the question's own
   unit («länger als 5 km»), «weniger als 300 m» as 299.99 too.

Measured on the recorded answers of `b6` (six models): of 5577 plans that
pass it refuses 3, each one that drops the condition and passes by chance;
of 737 silently wrong plans, 232.

A plan that misses one is refused as ``not_representable``, ``part:
missing``, with the attribute (or ``distance_m``) in ``details.attribute`` and
the last step as the step: the correction (F7) tells the model which
condition its plan lacks. Nothing here reads the data; a profile without code
lists finds distances only.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from geotandem.catalog import ModelProfile
from geotandem.model.schemas import PlannedStep, Refusal

MIN_STEM: Final = 3
"""Shorter stems match inside too many words."""

WORD_START: Final = 4
"""A stem shorter than this counts only at the start of a word: «Bushaltestelle»
names ``bus``, «Omnibus» does not."""

TOLERANCE: Final = 0.01
"""How far a written distance may lie from the question's, relative."""

VALUE_KEYS: Final = ("value", "values", "text", "min", "max")
"""Where a condition holds what it compares with."""

_DISTANCE: Final = re.compile(r"(\d+(?:[.,]\d+)?)[\s-]{0,3}(km|m)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Mention:
    """A condition the question names by ``stem``: an attribute of a layer and
    the strings a value that carries it holds."""

    stem: str
    layer: str
    attribute: str
    accepted: frozenset[str]


def mentions(question: str, profile: ModelProfile) -> list[Mention]:
    """The codes and boolean attributes ``question`` names (1)."""
    by_stem: dict[str, list[Mention]] = {}
    for layer in profile.layers:
        for attribute in layer.attributes:
            if attribute.type == "boolean":
                stem = attribute.name.lower()
                by_stem.setdefault(stem, []).append(
                    Mention(stem, layer.name, attribute.name, frozenset({stem}))
                )
            for code, label in (attribute.codes or {}).items():
                stem = code.split("_")[0].lower()
                if len(stem) < MIN_STEM:
                    stem = (label.split() or [""])[0].lower()
                if len(stem) >= MIN_STEM:
                    accepted = frozenset({stem, code.lower()})
                    by_stem.setdefault(stem, []).append(
                        Mention(stem, layer.name, attribute.name, accepted)
                    )
    text = question.lower()
    spans = [
        (m.start(), m.end(), stem)
        for stem in by_stem
        for m in re.finditer(("(?<!\\w)" if len(stem) < WORD_START else "") + re.escape(stem), text)
    ]
    found = {
        stem
        for start, end, stem in spans
        if not any(s <= start and end <= e and (s, e) != (start, end) for s, e, _ in spans)
    }
    return [mention for stem in sorted(found) for mention in by_stem[stem]]


def distances(question: str) -> list[tuple[float, float]]:
    """Each distance ``question`` names: the number as written and in metres (2)."""
    out = []
    for number, unit in _DISTANCE.findall(question):
        value = float(number.replace(",", "."))
        out.append((value, value * 1000 if unit.lower() == "km" else value))
    return out


@dataclass
class _Written:
    """What the steps write, values and names, never the data."""

    texts: set[str] = field(default_factory=set)
    numbers: set[float] = field(default_factory=set)
    """Values and distances, as written."""
    conditions: set[tuple[str | None, str]] = field(default_factory=set)
    """Attributes a condition is on, with the step's layer (``None``: a step
    that names its input by number)."""
    named: set[str] = field(default_factory=set)
    """Layers a step filters by a text attribute without codes."""

    def value(self, item: Any, layer: str | None, attribute: Any, plain: set[str]) -> None:
        if isinstance(attribute, str):
            self.conditions.add((layer, attribute))
        if isinstance(item, bool):
            if isinstance(attribute, str):
                self.texts.add(attribute.lower())
        elif isinstance(item, str):
            self.texts.add(item.lower())
            if layer is not None and attribute in plain:
                self.named.add(layer)
        elif isinstance(item, int | float):
            self.numbers.add(float(item))


def _walk(node: Any, layer: str | None, plain: set[str], out: _Written) -> None:
    if isinstance(node, Mapping):
        for key, value in node.items():
            if key in VALUE_KEYS:
                for item in value if isinstance(value, list) else [value]:
                    out.value(item, layer, node.get("attr"), plain)
            elif key == "distance_m" and isinstance(value, int | float):
                out.numbers.add(float(value))
            else:
                _walk(value, layer, plain, out)
    elif isinstance(node, list):
        for item in node:
            _walk(item, layer, plain, out)


def _written(steps: Sequence[PlannedStep], profile: ModelProfile) -> _Written:
    plain = {
        layer.name: {a.name for a in layer.attributes if a.type == "text" and not a.codes}
        for layer in profile.layers
    }
    out = _Written()
    for step in steps:
        layer = step.arguments.get("layer")
        layer = layer if isinstance(layer, str) else None
        _walk(step.arguments, layer, plain.get(layer, set()) if layer else set(), out)
    return out


def _carried(mention: Mention, written: _Written) -> bool:
    """A value holds the code (or a code holds the value), a condition is on the
    attribute (a complement: «weder Bus noch Tram» as the other codes), or a step
    names a single feature of the layer."""
    if mention.layer in written.named:
        return True
    if {(mention.layer, mention.attribute), (None, mention.attribute)} & written.conditions:
        return True
    return any(
        accepted in text or (len(text) >= MIN_STEM and text in accepted)
        for accepted in mention.accepted
        for text in written.texts
    )


def _near(target: float, numbers: set[float]) -> bool:
    """A number within ``TOLERANCE`` of ``target``: «weniger als 300 m» as 299.99."""
    return any(abs(n - target) <= max(1.0, TOLERANCE * target) for n in numbers)


def missing(question: str, steps: Sequence[PlannedStep], profile: ModelProfile) -> list[str]:
    """The attributes (``distance_m`` for a distance) of the conditions
    ``question`` names that ``steps`` do not carry, each once."""
    written = _written(steps, profile)
    by_stem: dict[str, list[Mention]] = {}
    for mention in mentions(question, profile):
        by_stem.setdefault(mention.stem, []).append(mention)
    lacking = [
        group[0].attribute
        for group in by_stem.values()
        if not any(_carried(m, written) for m in group)
    ]
    if any(
        not _near(metres, written.numbers) and not _near(number, written.numbers)
        for number, metres in distances(question)
    ):
        lacking.append("distance_m")
    return list(dict.fromkeys(lacking))


def check_cover(
    question: str, steps: Sequence[PlannedStep], profile: ModelProfile, last: int
) -> Refusal | None:
    """``not_representable``, ``part: missing`` for the first condition of
    ``question`` that ``steps`` lack, at step ``last``; ``None`` if none."""
    found = missing(question, steps, profile)
    if not found:
        return None
    lacking = found[0]
    return Refusal(
        code="not_representable",
        message=f"The question names a condition on '{lacking}' that no step of the plan writes.",
        details={"step": last, "part": "missing", "attribute": lacking},
    )
