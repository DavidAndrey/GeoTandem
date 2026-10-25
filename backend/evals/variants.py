"""Prompt variants for the placement runs (docs/testplan-system-context.md, 5, 6).

The presets the application offers as a connection's prompt profile (plan E3,
D9) are written by its builder (``direct_prompt`` with a ``PromptProfile``):
``--variant p0|p5|p9``, ``--examples 12`` and ``--no-format`` choose the
profile (``prompt_profile``), so harness and application send the same prompt.

The measurement-only variants (P1-P4, P8), which the application does not
offer, rebuild the messages the builder wrote, before they are sent (H-1).
The system message is cut into its sections at their headings (``# …``); the
first section, the level's system prompt, has none and is keyed ``""``. An
example set of this directory (``examples/<name>.txt``, H-2) replaces the
``# Beispiele`` section first.

    uv run python evals/run.py --model gemma4:12b --variant p5 --label p5-gemma4
    uv run python evals/run.py --model gemma4:12b --examples 3 --label p6-3-gemma4
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast, get_args

from geotandem.llm import Completion, Message
from geotandem.model.prompt import prompt_hash
from geotandem.model.result import parse_answer
from geotandem.model.schemas import ExampleSet as AppExamples
from geotandem.model.schemas import Placement, PromptProfile, QueryAnswer
from geotandem_query import QueryObject

__all__ = ["prompt_hash"]  # the application's, as the run header names it (H-5)

HERE = Path(__file__).parent
EXAMPLES_DIR = HERE / "examples"

FORMAT = "# Antwortformat"
EXAMPLES = "# Beispiele"
TALK = "# Gespräch"
SCHEMA_MARK = "\nJSON-Schema der Antwort:\n"
QUESTION = "\n\nFrage: "

Sections = dict[str, str]
"""Heading line → the section's text, heading included, in prompt order."""


def split(system: str) -> Sections:
    """The system message's sections; ``join`` gives it back byte for byte."""
    sections: Sections = {}
    for part in re.split(r"\n\n(?=# )", system):
        heading = part.split("\n", 1)[0] if part.startswith("# ") else ""
        if heading in sections:
            raise ValueError(f"section {heading!r} twice in the system message")
        sections[heading] = part
    return sections


def join(sections: Sections) -> str:
    return "\n\n".join(text for text in sections.values() if text)


@dataclass(frozen=True)
class ExampleSet:
    """A ``# Beispiele`` section taken apart: intro, rules, worked examples."""

    intro: str
    """The heading and the text before the rules (the invented layer profile)."""
    rules: tuple[str, ...]
    """The rule lines (``- …``), V-2 to V-7."""
    shots: tuple[tuple[str, str], ...]
    """(question, answer JSON) per worked example, in order."""

    @classmethod
    def parse(cls, section: str) -> "ExampleSet":
        head, *rest = section.split(QUESTION)
        lines = head.split("\n")
        intro = [line for line in lines if not line.startswith("- ")]
        rules = [line for line in lines if line.startswith("- ")]
        shots = []
        for block in rest:
            question, answer = block.split("\n", 1)
            shots.append((question, answer.strip()))
        return cls("\n".join(intro).rstrip(), tuple(rules), tuple(shots))

    def text(self, *, rules: bool = True, shots: bool = True) -> str:
        parts = [self.intro + ("\n" + "\n".join(self.rules) if rules and self.rules else "")]
        if shots:
            parts += [f"Frage: {q}\n{a}" for q, a in self.shots]
        return "\n\n".join(parts)


APP_EXAMPLES: frozenset[str] = frozenset(get_args(AppExamples)) - {"standard"}
"""Example sets the application offers (``--examples 12``): its builder writes them."""

PLACEMENTS: dict[str, Placement] = {"p0": "P0", "p5": "P5", "p9": "P9"}
"""``--variant`` names of the placements the application offers."""


def prompt_profile(variant: str, examples: str | None, text_only: bool) -> PromptProfile:
    """The application's prompt profile for these options: ``P0`` for a
    measurement-only variant, which then rebuilds what the builder wrote."""
    return PromptProfile(
        examples=cast(AppExamples, examples) if examples in APP_EXAMPLES else "standard",
        placement=PLACEMENTS.get(variant, "P0"),
        output="text" if text_only else "constrained",
    )


def load_examples(name: str) -> str:
    """``examples/<name>.txt``, every worked answer checked against the answer
    schema: a set the model could not have written measures nothing. The sets
    the application offers live with it (``APP_EXAMPLES``)."""
    path = EXAMPLES_DIR / f"{name}.txt"
    if not path.is_file():
        known = ", ".join(sorted(p.stem for p in EXAMPLES_DIR.glob("*.txt")))
        raise SystemExit(
            f"no example set {name!r} in {EXAMPLES_DIR} (known: {known}; "
            f"the application's: {', '.join(sorted(APP_EXAMPLES))})"
        )
    text = path.read_text("utf-8").strip()
    if not text.startswith(EXAMPLES + "\n"):
        raise SystemExit(f"{path} must start with the line {EXAMPLES!r}")
    for question, answer in ExampleSet.parse(text).shots:
        try:
            parsed = parse_answer(Completion(text=answer, parsed=json.loads(answer)), "direct")
            if isinstance(parsed, QueryAnswer):
                QueryObject.model_validate({"schema_version": "2", **parsed.query})
        except Exception as exc:
            raise SystemExit(f"{path}: the answer to {question!r} does not read: {exc}") from None
    return text


Variant = Callable[[list[Message]], list[Message]]
"""Takes the messages of a first question (system, user) as the builder wrote
them under ``P0`` and returns what is sent."""


def _system(messages: list[Message]) -> tuple[Sections, Message]:
    system, user = messages
    assert system.role == "system" and user.role == "user", "a first question has two messages"
    return split(system.content), user


def _sent(sections: Sections, *rest: Message) -> list[Message]:
    return [Message("system", join(sections)), *rest]


def p0(messages: list[Message]) -> list[Message]:
    """As the builder wrote it, the placements P0, P5 and P9 included."""
    return messages


def p1(messages: list[Message]) -> list[Message]:
    """No worked examples; the rules stay."""
    sections, user = _system(messages)
    sections[EXAMPLES] = ExampleSet.parse(sections[EXAMPLES]).text(shots=False)
    return _sent(sections, user)


def p2(messages: list[Message]) -> list[Message]:
    """The worked examples as user/assistant turns before the question; the
    rules stay in the system message (measurement only: E-8)."""
    sections, user = _system(messages)
    examples = ExampleSet.parse(sections[EXAMPLES])
    sections[EXAMPLES] = examples.text(shots=False)
    turns = []
    for question, answer in examples.shots:
        turns += [Message("user", question), Message("assistant", answer)]
    return _sent(sections, *turns, user)


def p3(messages: list[Message]) -> list[Message]:
    """Examples, rules and the first-question note in the user message, before
    ``Frage: <prompt>`` (measurement only: E-8)."""
    sections, user = _system(messages)
    moved = [sections.pop(EXAMPLES), sections.pop(TALK)]
    return _sent(sections, Message("user", "\n\n".join([*moved, "Frage: " + user.content])))


def p4(messages: list[Message]) -> list[Message]:
    """The worked examples without the rules V-2 to V-7."""
    sections, user = _system(messages)
    sections[EXAMPLES] = ExampleSet.parse(sections[EXAMPLES]).text(rules=False)
    return _sent(sections, user)


def p8(messages: list[Message]) -> list[Message]:
    """The JSON schema only as constrained output, not as text in the prompt."""
    sections, user = _system(messages)
    format_text, mark, _ = sections[FORMAT].partition(SCHEMA_MARK)
    assert mark, "the answer format holds no schema text"
    sections[FORMAT] = format_text
    return _sent(sections, user)


VARIANTS: dict[str, Variant] = {
    **dict.fromkeys(PLACEMENTS, p0),
    "p1": p1,
    "p2": p2,
    "p3": p3,
    "p4": p4,
    "p8": p8,
}
"""P0, P5 and P9 are the builder's (``PLACEMENTS``); P6 is ``--examples``, P7
an example set on real layers (``--examples``)."""


def with_examples(messages: list[Message], examples: str | None) -> list[Message]:
    """The ``# Beispiele`` section of the first system message replaced by
    ``examples``, or dropped for ``""``; the messages after it stay."""
    if examples is None:
        return messages
    system, *rest = messages
    assert system.role == "system", "a prompt starts with its system message"
    sections = split(system.content)
    if EXAMPLES not in sections:
        raise ValueError("the system message has no examples section to replace")
    sections[EXAMPLES] = examples
    return _sent(sections, *rest)
