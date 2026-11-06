"""The pool of examples chosen per question (docs/plan-improve-examples.md 5
and 6.5; ``geotandem.model.pool``, the arms in ``evals/pool.py``).

Every pool example teaches what its case's reference does: its direct answer
and its plan read as answers, the plan passes the application's checks and
selects the reference's features on the sample data. The pool and the cases
left out of it are pinned, so a new tuning case shows up here. The draw and
the choice never hand a case its own answer.
"""

import importlib.util
import json
import sys
from types import ModuleType

import pytest
from model_fixtures import REPO

from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.engine import ids_query
from geotandem.evaluation.cases import (
    World,
    behaviour_set,
    chain_set,
    layer_set,
    sample_world,
    start_set,
)
from geotandem.evaluation.grade import query_of
from geotandem.levels.store import load_levels
from geotandem.llm import Completion, Message
from geotandem.model.chain.plan import check_plan
from geotandem.model.pool import (
    COUNT,
    Example,
    Words,
    as_plan,
    choose,
    cued,
    named,
    pool_hash,
    pool_of,
)
from geotandem.model.prompt import build_prompt
from geotandem.model.result import parse_answer
from geotandem.model.schemas import Approach, PlannedStep, PromptProfile, Refusal

LIMITS = Limits(max_features=10_000, timeout_s=10)
CASES = (*start_set(), *chain_set(), *layer_set())

NO_PLAN = [
    # «ohne» around contains or intersects: the chain has no tool for it.
    "doc4-ohne-sek",
    "ml11-gemeinde-sek-ohne-aare",
    "ml24-bach-bahn-ohne-nationalstrasse",
    "ml63-grosse-gemeinde-ohne-sek",
    "ml64-grosse-gemeinde-ohne-sek",
    # Farther than a distance from a road: ``outside`` a buffer takes points only.
    "ml37-nationalstrasse-ohne-schule",
    "ml38-kantonsstrasse-ohne-schule",
]
POOL_SIZE = 62
MEASURED = "c8fd1b3e8b23a6f54fa9b979d43a724a4aea1c17"
"""The start of the pool's hash in every arm C run of the measurement
(``pool_sha256``, examples-benchmarks.md): the application's pool is that one."""

Pool = list[Example]


def harness() -> ModuleType:
    """``evals/pool.py``, as ``evals/run.py`` imports it: the arms."""
    evals = REPO / "backend" / "evals"
    sys.path.insert(0, str(evals))
    try:
        spec = importlib.util.spec_from_file_location("pool", evals / "pool.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(evals))
    return module


pool_module = harness()


@pytest.fixture(scope="module")
def world() -> World:
    return sample_world(Settings(), LIMITS)


@pytest.fixture(scope="module")
def pool(world: World) -> Pool:
    return pool_of(CASES, world.profile)


def test_the_pool_is_every_tuning_case_with_a_reference_the_chain_can_write(
    pool: Pool, world: World
) -> None:
    words = Words(world.profile)
    tuning = [c for c in CASES if c.split == "tuning" and c.readings()]
    left = [c.id for c in tuning if as_plan(c.readings()[0], words) is None]
    assert sorted(left) == sorted(NO_PLAN)
    assert len(pool) == POOL_SIZE == len(tuning) - len(NO_PLAN)
    assert {e.case for e in pool} <= {c.id for c in tuning}
    assert pool_hash(pool).startswith(MEASURED)


def test_every_example_reads_and_its_plan_selects_the_reference(pool: Pool, world: World) -> None:
    backend = world.context.backend
    for example in pool:
        for approach in ("direct", "chain"):
            _, answer = example.shot(approach)
            parse_answer(Completion(text=answer, parsed=json.loads(answer)), approach)
        steps = [PlannedStep.model_validate(step) for step in example.plan]
        checked = check_plan(steps, world.context, world.profile)
        assert not isinstance(checked, Refusal), (example.case, checked)
        found = ids_query(checked[-1].query, backend, LIMITS)
        assert found == ids_query(query_of(example.reading, "2"), backend, LIMITS), example.case


def test_a_case_never_gets_itself_and_the_draw_is_fixed_per_case_and_seed(pool: Pool) -> None:
    for example in pool:
        drawn = pool_module.draw(pool, example.case, 1)
        assert len(drawn) == COUNT
        assert example not in drawn
        assert drawn == pool_module.draw(pool, example.case, 1)
    assert pool_module.draw(pool, pool[0].case, 1) != pool_module.draw(pool, pool[0].case, 2)


def test_the_selector_reads_the_question_and_the_profile_only(pool: Pool, world: World) -> None:
    question = "Welche Bushaltestellen liegen höchstens 200 m von einer Nationalstrasse?"
    assert named(question, world.profile) == ["haltestellen", "strassen"]
    assert cued(question, ["haltestellen", "strassen"], world.profile) == {
        "filter-subject",
        "near",
    }
    chosen = choose(question, "any", pool, world.profile)
    assert chosen[0].case == "ml55-bus-nahe-nationalstrasse"
    own = choose(question, "ml55-bus-nahe-nationalstrasse", pool, world.profile)
    assert "ml55-bus-nahe-nationalstrasse" not in [e.case for e in own]


def test_b_and_c_keep_the_rules_and_two_fixed_examples(pool: Pool, world: World) -> None:
    level = next(lv for lv in load_levels(world.context.backend.engine) if lv.is_default)
    prompt = build_prompt("Frage?", approach="chain", level=level, profile=world.profile)
    sent = pool_module.with_pool(list(prompt.messages), pool[:3], "chain")
    fixed = pool_module.split(prompt.messages[0].content)[pool_module.EXAMPLES]
    section = pool_module.split(sent[0].content)[pool_module.EXAMPLES]
    rules = [line for line in fixed.split("\n") if line.startswith("- ")]
    assert all(rule in section for rule in rules)
    assert "Welche Eichen stehen in der Altstadt?" in section
    assert "Wie viele Sitzbänke gibt es?" in section
    assert "Öffentliche Sekundarschulhäuser" not in section
    assert all(e.question in section for e in pool[:3])
    assert sent[1:] == [Message(m.role, m.content) for m in prompt.messages[1:]]


@pytest.mark.parametrize("approach", ["direct", "chain"])
def test_the_application_writes_the_measured_prompt(
    pool: Pool, world: World, approach: Approach
) -> None:
    """For every measured question: the builder with the chosen examples sends
    what arm C sent, the default prompt with its examples rebuilt by
    ``with_pool`` (plan-improve-examples 5, WP3). The chain's prompt is the
    check's planning call."""
    level = next(lv for lv in load_levels(world.context.backend.engine) if lv.is_default)
    eigene = PromptProfile(examples="eigene") if approach == "direct" else PromptProfile()
    measured = [c for c in (*CASES, *behaviour_set()) if c.split == "confirm"]
    for case in measured:
        chosen = choose(case.prompt, case.id, pool, world.profile)
        default = build_prompt(case.prompt, approach=approach, level=level, profile=world.profile)
        sent = build_prompt(
            case.prompt,
            approach=approach,
            level=level,
            profile=world.profile,
            prompt_profile=eigene,
            chosen=chosen,
        )
        expected = pool_module.with_pool(list(default.messages), chosen, approach)
        assert [Message(m.role, m.content) for m in sent.messages] == expected, case.id
