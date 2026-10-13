"""Prompt variants for the placement runs (docs/testplan-system-context.md, 5, 6).

A variant rebuilds the messages ``direct_prompt`` wrote, before they are sent:
the application stays as it is until a variant wins (H-1). The system message
is cut into its sections at their headings (``# …``); the first section, the
level's system prompt, has none and is keyed ``""``. An example set
(``examples/<name>.txt``, H-2) replaces the ``# Beispiele`` section first.

    uv run python evals/run.py --model gemma4:12b --variant p5 --label p5-gemma4
    uv run python evals/run.py --model gemma4:12b --examples 3 --label p6-3-gemma4
"""

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from geotandem.llm import Completion, Message
from geotandem.model.result import parse_answer
from geotandem.model.schemas import QueryAnswer
from geotandem_query import QueryObject

HERE = Path(__file__).parent
EXAMPLES_DIR = HERE / "examples"

STECKBRIEF = "# Layer-Steckbrief"
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


def load_examples(name: str) -> str:
    """``examples/<name>.txt``, every worked answer checked against the answer
    schema: a set the model could not have written measures nothing."""
    path = EXAMPLES_DIR / f"{name}.txt"
    if not path.is_file():
        known = ", ".join(sorted(p.stem for p in EXAMPLES_DIR.glob("*.txt")))
        raise SystemExit(f"no example set {name!r} in {EXAMPLES_DIR} (known: {known})")
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
"""Takes the messages of a first question (system, user) and returns what is sent."""


def _system(messages: list[Message]) -> tuple[Sections, Message]:
    system, user = messages
    assert system.role == "system" and user.role == "user", "a first question has two messages"
    return split(system.content), user


def _sent(sections: Sections, *rest: Message) -> list[Message]:
    return [Message("system", join(sections)), *rest]


def p0(messages: list[Message]) -> list[Message]:
    """Reference: as the application sends it."""
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


def p5(messages: list[Message]) -> list[Message]:
    """Order: system prompt, examples, layer profile, answer format (with the
    schema), conversation note."""
    sections, user = _system(messages)
    order = ["", EXAMPLES, STECKBRIEF, FORMAT, TALK]
    assert set(order) >= set(sections), f"unexpected sections {set(sections) - set(order)}"
    return _sent({h: sections[h] for h in order if h in sections}, user)


def p8(messages: list[Message]) -> list[Message]:
    """The JSON schema only as constrained output, not as text in the prompt."""
    sections, user = _system(messages)
    format_text, mark, _ = sections[FORMAT].partition(SCHEMA_MARK)
    assert mark, "the answer format holds no schema text"
    sections[FORMAT] = format_text
    return _sent(sections, user)


def p9(messages: list[Message]) -> list[Message]:
    """The first-question note as a system message of its own, right before
    the question: three messages, not two."""
    sections, user = _system(messages)
    note = sections.pop(TALK)
    return _sent(sections, Message("system", note), user)


VARIANTS: dict[str, Variant] = {
    "p0": p0,
    "p1": p1,
    "p2": p2,
    "p3": p3,
    "p4": p4,
    "p5": p5,
    "p8": p8,
    "p9": p9,
}
"""P6 is ``--examples``, P7 an example set on real layers (``--examples``)."""


def with_examples(messages: list[Message], examples: str | None) -> list[Message]:
    """The ``# Beispiele`` section replaced by ``examples``, or dropped for ``""``."""
    if examples is None:
        return messages
    sections, user = _system(messages)
    if EXAMPLES not in sections:
        raise ValueError("the system message has no examples section to replace")
    sections[EXAMPLES] = examples
    return _sent(sections, user)


def prompt_hash(messages: list[Message], schema: object) -> str:
    """Over every message and the schema, as sent: the same hash, the same prompt."""
    sent = [{"role": m.role, "content": m.content} for m in messages]
    blob = json.dumps({"messages": sent, "schema": schema}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()
