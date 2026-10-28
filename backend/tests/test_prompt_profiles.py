"""Prompt profiles (plan E3, D9, WP91): the builder writes the presets the
harness measured, byte for byte, and the client gets the output mode."""

import importlib.util
import json
import sys
from types import ModuleType
from typing import Any

import pytest
from model_fixtures import REPO, case, scripted

from geotandem.catalog import ModelProfile, model_profile
from geotandem.data import DataBackend, Limits
from geotandem.db import orm
from geotandem.levels import Level
from geotandem.levels.store import load_levels
from geotandem.llm import Completion
from geotandem.model.direct import DirectQuery, direct_prompt
from geotandem.model.prompt import (
    DEFAULT_PROMPT_PROFILE,
    FIRST,
    FollowUp,
    Turn,
    build_prompt,
    examples_section,
    prompt_hash,
)
from geotandem.model.result import answer_format, parse_answer
from geotandem.model.schemas import Approach, OutputMode, PromptProfile, QueryAnswer
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

PLACEHOLDER = "{prompt}"
"""The harness's placeholder question: its hash names a run's template (H-5)."""

MEASURED = {
    (None, "p0"): "55e708badb92a05fae633636946292a947435f6553903966482311dd9c6a2eb2",
    (None, "p5"): "136ced31e60bcfdc889b4fcbd8cf0bc3581c8d59a39ffb811e5dc4622ab188d7",
    (None, "p9"): "941c23f5db4c25ce135fdce7941702c9293f1ca8b045e5a9c64c7375c196d1af",
    ("12", "p0"): "202caab912ea03673337ac614505a08abc64da8d7a05edbf798d7dce77dc124c",
    ("12", "p5"): "30a87140a28e10dab6e705f398707411ccdf140344ec8dba4aefaff31601e62c",
    ("12", "p9"): "c2d8f95a8fa6ceb8a383195b3f2d018f28397dd0937993e860f5ae5dc61a46e5",
}
"""``prompt_sha256`` of ``evals/run.py --variant V [--examples 12]`` on the sample
data and the default level, taken with the harness's own variants (``p5``,
``p9``, ``with_examples``) before they moved into the builder. P0 is the hash
of every run of testplan-system-context and benchmarks.md."""


def harness() -> ModuleType:
    """``evals/variants.py``, as ``evals/run.py`` imports it."""
    evals = REPO / "backend" / "evals"
    sys.path.insert(0, str(evals))
    try:
        spec = importlib.util.spec_from_file_location("variants", evals / "variants.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(evals))
    return module


@pytest.fixture(scope="module")
def template(sample: DataBackend) -> tuple[ModelProfile, Level]:
    """What ``evals/run.py`` builds its prompts over: the sample's full profile
    and the default level."""
    engine = sample.engine  # type: ignore[attr-defined]
    profile = model_profile(engine, sample.layer_names())
    level = next(lv for lv in load_levels(engine) if lv.is_default)
    return profile, level


@pytest.mark.parametrize(("examples", "variant"), list(MEASURED))
@pytest.mark.parametrize("text_only", [False, True], ids=["constrained", "text"])
def test_each_preset_sends_what_the_harness_measured(
    template: tuple[ModelProfile, Level], examples: str | None, variant: str, text_only: bool
) -> None:
    """The harness's options name the profile (``variants.prompt_profile``) and
    the builder writes it; the hash is the one measured. The output mode is not
    in the hash (the run header names it apart): ``text`` only drops the
    constrained output."""
    profile, level = template
    variants = harness()
    chosen = variants.prompt_profile(variant, examples, text_only)
    prompt = direct_prompt(PLACEHOLDER, level=level, profile=profile, prompt_profile=chosen)
    assert prompt_hash(prompt.messages, prompt.schema) == MEASURED[examples, variant]
    assert variants.prompt_hash is prompt_hash
    assert prompt.messages[-1].content == PLACEHOLDER
    assert len(prompt.messages) == (3 if variant == "p9" else 2)
    assert prompt.constrained == (None if text_only else answer_format("direct"))


def test_the_default_profile_is_todays_prompt(template: tuple[ModelProfile, Level]) -> None:
    profile, level = template
    default = direct_prompt(PLACEHOLDER, level=level, profile=profile)
    assert PromptProfile() == DEFAULT_PROMPT_PROFILE
    assert prompt_hash(default.messages, default.schema) == MEASURED[None, "p0"]
    assert default.constrained == default.schema


def test_every_worked_answer_of_the_twelve_is_a_valid_answer() -> None:
    """As for the standard set (test_model_direct): the set moved from the
    harness into the application, which checks its answers here."""
    section = examples_section("12")
    answers = [json.loads(line) for line in section.splitlines() if line.startswith("{")]
    assert len(answers) == 12
    for answer in answers:
        parsed = parse_answer(Completion(text=json.dumps(answer)), "direct")
        if isinstance(parsed, QueryAnswer):
            QueryObject.model_validate({"schema_version": "2", **parsed.query})
    assert not (REPO / "backend" / "evals" / "examples" / "12.txt").exists()


def bare() -> ModelProfile:
    profile = ModelProfile(layers=[], hash="", size_chars=0, tokens_estimate=0)
    profile._text = "{}"
    return profile


def built(level: Level, text: str = "Frage", **kwargs: Any) -> list[str]:
    prompt = build_prompt(text, approach="direct", level=level, profile=bare(), **kwargs)
    return [f"{m.role}: {m.content}" for m in prompt.messages]


def test_p5_puts_the_examples_before_the_layer_profile(
    template: tuple[ModelProfile, Level],
) -> None:
    _, level = template
    [s0, _] = built(level)
    [s5, _] = built(level, prompt_profile=PromptProfile(placement="P5"))
    assert s0.index("# Layer-Steckbrief") < s0.index("# Antwortformat") < s0.index("# Beispiele")
    assert s5.index("# Beispiele") < s5.index("# Layer-Steckbrief") < s5.index("# Antwortformat")
    assert sorted(s0.split("\n\n")) == sorted(s5.split("\n\n"))
    assert s5.endswith(FIRST)


def test_p9_only_moves_the_note_of_a_first_question(
    template: tuple[ModelProfile, Level],
) -> None:
    """A follow-up has no note, so P9 writes it as P0 does."""
    _, level = template
    p9 = PromptProfile(placement="P9")
    system, note, user = built(level, prompt_profile=p9)
    assert note == f"system: {FIRST}" and FIRST not in system
    assert user == "user: Frage"
    follow = FollowUp(turns=[Turn("Frage 1", "Antwort 1")])
    assert built(level, "Frage 2", follow_up=follow, prompt_profile=p9) == built(
        level, "Frage 2", follow_up=follow
    )


def test_the_twelve_replace_the_standard_examples(template: tuple[ModelProfile, Level]) -> None:
    _, level = template
    [standard, _] = built(level)
    [twelve, _] = built(level, prompt_profile=PromptProfile(examples="12"))
    assert examples_section("standard") in standard and examples_section("12") not in standard
    assert twelve == standard.replace(examples_section("standard"), examples_section("12"))


def test_the_chain_keeps_the_default(template: tuple[ModelProfile, Level]) -> None:
    _, level = template
    with pytest.raises(ValueError, match="direct query only"):
        build_prompt(
            "Frage",
            approach="chain",
            level=level,
            profile=bare(),
            prompt_profile=PromptProfile(placement="P9"),
        )


@pytest.mark.parametrize("output", ["constrained", "text"])
def test_the_client_gets_the_output_mode(
    sample: DataBackend, template: tuple[ModelProfile, Level], output: OutputMode
) -> None:
    """``text``: the schema only as text in the prompt, no constrained output (H-8)."""
    profile, level = template
    model = scripted("reference")
    direct = DirectQuery(model, ToolContext(backend=sample, limits=Limits(1000, 10)), level)
    prompt = direct_prompt(
        case("reference")["prompt"],
        level=level,
        profile=profile,
        prompt_profile=PromptProfile(output=output),
    )
    direct.ask(prompt, profile=profile)
    [call] = model.calls
    assert call.schema == (answer_format("direct") if output == "constrained" else None)
    assert "JSON-Schema der Antwort" in call.messages[0].content


FOLLOW_UP_MEASURED = {
    "direct": "21e9e146cb74bbb92d35463f3c96a00585301495d503d81519b5e6c8d54b8e68",
    "chain": "c3eb9e38f3b0c064e6ae526423fcd0523fad67a0e0c90732312937a54dd56a2f",
}
"""``prompt_hash`` of ``follow_up()`` under the default profile, taken with the
builder as it was before WP91 (``ep-3`` at the tag ``e3.2``). The chain's taken
again on purpose: with its answer format per tool (plan-chain-eval, F6;
``7cf5b3fa…acf``), its rules and worked examples (F10; ``92e17509…669``), a
whole layer by name in a spatial step (F11; ``4097ed86…ffb7``), the tool
``contains`` with the rules of Phase 2 (F13, F15, F16; ``62d4028b…26fb``) and
a restricted subject named by its step (F17, F18); it was ``3450a1a2…88db``
before all of them."""


def follow_up() -> FollowUp:
    """A follow-up with a turn, a decision and the current analysis (P6)."""
    turn = Turn(
        "Welche Schulen gibt es?", "Alle Schulen.", ("Schulen jeder Stufe.",), decision="accepted"
    )
    analysis = QueryObject.model_validate(
        {"schema_version": "2", "source": "schulen", "output": "map"}
    )
    return FollowUp(analysis=analysis, reference="last_answer", turns=[turn])


@pytest.mark.parametrize("approach", ["direct", "chain"])
def test_a_follow_up_under_the_default_is_todays_prompt(
    template: tuple[ModelProfile, Level], approach: Approach
) -> None:
    profile, level = template
    prompt = build_prompt(
        "Nur Primarschulen", approach=approach, level=level, profile=profile, follow_up=follow_up()
    )
    assert prompt_hash(prompt.messages, prompt.schema) == FOLLOW_UP_MEASURED[approach]
    assert [m.role for m in prompt.messages] == ["system", "user", "assistant", "user"]


def test_a_follow_up_under_p5_and_the_twelve(template: tuple[ModelProfile, Level]) -> None:
    """The examples before the layer profile, the twelve in place of the
    standard set, and no first-question note: the prompt builds on a turn."""
    profile, level = template
    asked = {"approach": "direct", "level": level, "profile": profile}
    chosen = PromptProfile(examples="12", placement="P5")
    prompt = build_prompt(
        "Nur Primarschulen", follow_up=follow_up(), prompt_profile=chosen, **asked
    )
    default = build_prompt("Nur Primarschulen", follow_up=follow_up(), **asked)
    system = prompt.messages[0].content
    assert system.index(examples_section("12")) < system.index("# Layer-Steckbrief")
    assert examples_section("standard") not in system
    assert all(FIRST not in m.content for m in prompt.messages)
    assert prompt.messages[1:] == default.messages[1:]


def test_the_stored_default_is_the_contracts() -> None:
    """The ORM's and the migration's server default are ``PromptProfile()``."""
    path = REPO / "backend/src/geotandem/db/migrations/versions/0017_connection_prompt_profile.py"
    spec = importlib.util.spec_from_file_location("m0017", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    expected = PromptProfile().model_dump()
    assert json.loads(orm.DEFAULT_PROMPT_PROFILE) == expected
    assert json.loads(migration.DEFAULT_PROMPT_PROFILE) == expected
    assert DEFAULT_PROMPT_PROFILE.model_dump() == expected
