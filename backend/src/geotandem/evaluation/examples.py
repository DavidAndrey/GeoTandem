"""The examples a prompt may be given (docs/plan-improve-examples.md 5, D2 and
D6): the pool of ``model.pool``, built for one prompt's world.

- **Cases:** the tuning cases of the files the measurement drew its pool from
  (``shipped_cases``: the start set, the chain's cases, the cases across
  layers), and own cases the caller passes in. Confirm cases never.
- **World:** each case is assessed on the world the prompt is written for
  (``assess_case``, D3), so a case is shown only if it is ``ok`` or
  ``dataset_changed`` there. A case naming a layer the account cannot see
  fails the checks on that world and is ``invalid``, never shown (S3).
- **External connections** (F-9.3, section 4): an own case's reference goes
  out only if every value in it is a number, a yes or no, or a code of the
  attribute's confirmed code list (the profile holds only confirmed ones,
  S2). The shipped cases are open data (6.2) and go to every connection.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from geotandem.catalog import ModelProfile
from geotandem.config import Settings
from geotandem.data import DataBackend, Limits, Op
from geotandem.evaluation.cases import (
    World,
    assess_case,
    cases_dir,
    chain_set,
    layer_set,
    prompt_world,
    start_cases,
)
from geotandem.evaluation.schemas import CaseStatus, EvalCase
from geotandem.llm import Locality
from geotandem.model.pool import Example, choose, pool_of

SHOWN: Final[frozenset[CaseStatus]] = frozenset({"ok", "dataset_changed"})
"""The statuses of a case that may be an example (D6)."""

Node = dict[str, Any]


def shipped_cases(settings: Settings) -> tuple[EvalCase, ...]:
    """The cases of the measurement's pool, as the measurement read them
    (``evals/run.py``): start set, chain cases, cases across layers."""
    directory = cases_dir(settings).resolve()
    return (*start_cases(settings), *chain_set(directory), *layer_set(directory))


def _codes(profile: ModelProfile, layer: str, attr: str) -> frozenset[str]:
    return frozenset(
        code
        for lp in profile.layers
        if lp.name == layer
        for a in lp.attributes
        if a.name == attr
        for code in (a.codes or {})
    )


def _plain(value: object, profile: ModelProfile, layer: str, attr: str) -> bool:
    """A number, a yes or no, or a confirmed code of ``attr``."""
    if isinstance(value, bool | int | float):
        return True
    return isinstance(value, str) and value in _codes(profile, layer, attr)


def _shareable(node: Node, profile: ModelProfile, layer: str) -> bool:
    match node["op"]:
        case "and" | "or":
            return all(_shareable(n, profile, layer) for n in node["args"])
        case "not":
            return _shareable(node["arg"], profile, layer)
        case "compare":
            return _plain(node["value"], profile, layer, node["attr"])
        case "in":
            return all(_plain(v, profile, layer, node["attr"]) for v in node["values"])
        case "between" | "is_null":
            return True
        case "related":
            where = node.get("where")
            return where is None or _shareable(where, profile, node["layer"])
        case _:
            # A text, a drawn geometry, a feature id, a box: data, or a place.
            return False


def shareable(reading: Node, profile: ModelProfile) -> bool:
    """Whether ``reading`` holds no data contents (section 4); anything beside
    the source and the condition counts as content."""
    if set(reading) - {"source", "where"}:
        return False
    where = reading.get("where")
    return where is None or _shareable(where, profile, reading["source"])


def example_pool(
    cases: Iterable[EvalCase],
    world: World,
    locality: Locality,
    shipped: Sequence[EvalCase] = (),
) -> list[Example]:
    """The pool of a prompt written for ``world``: ``shipped`` cases and own
    ``cases``, tuning only, shown on that world, an own case's reference
    shareable on an external connection, and written by the chain too
    (``pool_of``). Only a case's first reading is shown, so only it is read."""
    shipped_ids = {case.id for case in shipped}

    def admits(case: EvalCase) -> bool:
        if case.split != "tuning" or not case.readings():
            return False
        if assess_case(case, world, count=False)[0] not in SHOWN:
            return False
        own = case.id not in shipped_ids
        return not own or locality == "local" or shareable(case.readings()[0], world.profile)

    own = [case for case in cases if case.id not in shipped_ids]
    return pool_of([case for case in (*shipped, *own) if admits(case)], world.profile)


@dataclass(frozen=True)
class Chooser:
    """The examples of a question in operation (``PromptFlow.examples``): the
    pool of the prompt's world, then ``choose``. A question is no case, so no
    example is left out for it."""

    settings: Settings
    limits: Limits
    unsupported: frozenset[Op]

    def __call__(
        self, view: DataBackend, profile: ModelProfile, locality: Locality, question: str
    ) -> list[Example]:
        world = prompt_world(view, profile, self.limits, self.unsupported)
        pool = example_pool((), world, locality, shipped_cases(self.settings))
        return choose(question, "", pool, profile)
