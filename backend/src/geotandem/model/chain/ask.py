"""What a chain says to the model and hears back (P4, D9, plan WP74).

The one module of the chain that talks to the model, and it never touches an
engine result: what it knows of a step is the step's ``ModelView``
(``view.model_view``) and nothing else. ``tests/test_model_chain.py`` holds it
to that: it imports nothing of the engine and reads no attribute a result or
an error carries.

Planning is one call (P4): the system message and the prompt of
``prompt.build_prompt`` with the chain's answer format. A plan the checks
refuse (``check_plan``) gets one correction (``plan``, plan-chain-eval F7):
the plan the model gave and a user message with the ``ModelView`` of the
step the refusal names, asking for the whole plan again; nothing ran, so
nothing stays. A re-plan continues that conversation: the plan the model
gave, as it gave it, and a user message with the ``ModelView`` of every step
that ran, asking for the remaining steps only; the completed steps stay (P4).

``ChainState`` keeps the rules of a run that concern the model: which step is
next, when a re-plan is due (an error, or an empty step before the last; not
an empty last step) and when none is left (``MAX_REPLANS``). Who runs the
steps, stores them and stops for approval is the caller (WP75).
"""

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal

from geotandem.catalog import ModelProfile
from geotandem.llm import LLMClient, LLMError, Message
from geotandem.model.chain.plan import CheckedStep, check_plan
from geotandem.model.chain.view import refused_step
from geotandem.model.errors import ActionError
from geotandem.model.prompt import Prompt, fit
from geotandem.model.result import NO_TOKENS, Answer, AnswerError, Tokens, parse_answer
from geotandem.model.schemas import MAX_REPLANS, MAX_STEPS, ModelView, PlanAnswer, Refusal
from geotandem.tools import ToolContext

After = Literal["next", "replan", "done", "stopped"]
"""What follows a step: the next one, a re-plan, the end, or a stop because a
re-plan is due and none is left."""

MAX_CORRECTIONS: Final = 1
"""Calls after a first plan the checks refused (F7). Each is a model call the
request limit counts, as a re-plan is; none counts against ``MAX_REPLANS``."""


def ask(
    client: LLMClient,
    messages: Sequence[Message],
    schema: dict[str, Any],
    deadline: float | None = None,
) -> tuple[Answer, Tokens]:
    """One model call of the chain, with what it cost; ``model_unreadable`` as
    for the direct query (an ``AnswerError``, which carries the tokens)."""
    completion = client.complete(messages, schema=schema, deadline=deadline)
    return parse_answer(completion, "chain"), Tokens.of(completion)


def said(answer: PlanAnswer) -> str:
    """The model's plan, as the next turn repeats it: its own words only."""
    return json.dumps(answer.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))


Seen = tuple[int, str, ModelView]
"""A step that ran: its position, its tool and what the model saw of it."""


def correction_message(position: int, tool: str, view: ModelView) -> str:
    """The correction's input (F7): the refused step as a step that ran is
    shown in a re-plan's, and the whole plan asked for again."""
    shown = json.dumps(view.model_dump(exclude_none=True), separators=(",", ":"))
    return (
        "Die Prüfung hat den Plan abgewiesen; kein Schritt wurde ausgeführt.\n"
        f"Schritt {position} ({tool}): {shown}\n"
        "Plane neu: antworte mit dem ganzen Plan, die Schritte zählen ab Schritt 1."
    )


@dataclass(frozen=True)
class PlanCall:
    """One call of the planning: the first, or a correction."""

    latency_ms: int
    tokens: Tokens
    outcome: str
    """The answer's kind, or ``error:<code>`` for a correction that failed."""


@dataclass(frozen=True)
class Planned:
    """The planning (P4, F7): the model's last answer that read, the plan
    checked whole (``None`` for an answer that is no plan), every call."""

    answer: Answer
    checked: list[CheckedStep] | Refusal | None
    calls: tuple[PlanCall, ...]

    @property
    def tokens(self) -> Tokens:
        """The calls' tokens added up; ``None`` where no call reported any."""
        prompts = [c.tokens.prompt for c in self.calls if c.tokens.prompt is not None]
        answers = [c.tokens.completion for c in self.calls if c.tokens.completion is not None]
        return Tokens(sum(prompts) if prompts else None, sum(answers) if answers else None)


def _nothing() -> None:
    """No check before a correction (the harness: no request limit)."""


def plan(
    client: LLMClient,
    prompt: Prompt,
    context: ToolContext,
    profile: ModelProfile,
    deadline: float | None,
    *,
    context_length: int | None = None,
    before_correction: Callable[[], None] = _nothing,
    clock: Callable[[], float] = time.monotonic,
) -> Planned:
    """The planning call, checked whole in the world of ``profile``, and up to
    ``MAX_CORRECTIONS`` corrections of a plan the checks refused, all within
    ``deadline``. The first call raises what ``ask`` raises. A correction is
    left out when it does not fit the connection's context or
    ``before_correction`` refuses it (the request limit, ``quota_exceeded``);
    when its call fails or its answer does not read, the refusal before it
    stands. An answer that is no plan ends the planning, as the first call's."""

    def call(messages: Sequence[Message]) -> tuple[Answer, Tokens, int]:
        started = clock()
        answer, tokens = ask(client, messages, prompt.schema, deadline)
        return answer, tokens, round((clock() - started) * 1000)

    answer, tokens, latency = call(prompt.messages)
    calls = [PlanCall(latency, tokens, answer.kind)]
    checked = check_plan(answer.steps, context, profile) if isinstance(answer, PlanAnswer) else None
    while isinstance(checked, Refusal) and len(calls) <= MAX_CORRECTIONS:
        assert isinstance(answer, PlanAnswer)
        message = correction_message(*refused_step(checked, answer.steps))
        messages = (*prompt.messages, Message("assistant", said(answer)), Message("user", message))
        try:
            fit(messages, context_length)
            before_correction()
        except ActionError:  # context_too_large, quota_exceeded: no call is made
            break
        started = clock()
        try:
            again, tokens, latency = call(messages)
        except (LLMError, ActionError) as exc:
            spent = exc.tokens if isinstance(exc, AnswerError) else NO_TOKENS
            failed = round((clock() - started) * 1000)
            calls.append(PlanCall(failed, spent, f"error:{exc.code}"))
            break
        calls.append(PlanCall(latency, tokens, again.kind))
        answer = again
        if not isinstance(answer, PlanAnswer):
            checked = None
            break
        checked = check_plan(answer.steps, context, profile)
    return Planned(answer, checked, tuple(calls))


def _named(positions: Sequence[int]) -> str:
    """``1 bis 3`` for the first steps in a row, else ``1, 2 und 4``."""
    if list(positions) == list(range(1, len(positions) + 1)):
        return f"1 bis {len(positions)}"
    names = [str(p) for p in positions]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " und " + names[-1]


def replan_message(
    seen: Sequence[Seen],
    kept: Sequence[int] = (),
    first: int = 1,
    left: int = MAX_STEPS,
    edits: str | None = None,
) -> str:
    """The re-plan's input (P4): per step that ran, its tool and its ``ModelView``;
    the user's changes to the plan before it ran (``edits``, their own words
    and values, never the data's); the steps that stay (``kept``), where the
    new ones start counting (``first``) and how many may come (``left``)."""
    lines = ["Ergebnis der ausgeführten Schritte:"]
    for position, tool, view in seen:
        shown = json.dumps(view.model_dump(exclude_none=True), separators=(",", ":"))
        lines.append(f"Schritt {position} ({tool}): {shown}")
    if edits:
        lines.append(edits)
    if kept:
        named = _named(kept)
        lines.append(
            f"Die Schritte {named} bleiben. Plane die übrigen neu: antworte mit einem Plan, "
            f"der nur die neuen Schritte enthält; sie zählen ab Schritt {first} und dürfen "
            f"die Schritte {named} nennen. Höchstens {left} neue Schritte."
        )
    else:
        lines.append(
            f"Kein Schritt bleibt. Plane die Schritte neu: sie zählen ab Schritt {first}; "
            f"höchstens {left} Schritte."
        )
    return "\n".join(lines)


def kept_turns(state: "ChainState") -> list[list[str]]:
    """``state.turns`` as the record keeps them (``model_action.turns``):
    ``[role, text]``, a re-plan's input with the hash of the layer profile it
    was asked with (``asked_with``)."""
    return [
        [turn.role, turn.content, *([state.asked_with[i]] if i in state.asked_with else [])]
        for i, turn in enumerate(state.turns)
    ]


def restored_turns(stored: Sequence[Sequence[str]]) -> tuple[list[Message], dict[int, str]]:
    """The record's turns as the next re-plan continues them, with the profile
    hash of each re-plan's input."""
    turns = [Message("assistant" if t[0] == "assistant" else "user", t[1]) for t in stored]
    return turns, {i: t[2] for i, t in enumerate(stored) if len(t) > 2}


def edits_message(removed: Sequence[int], changed: Sequence[tuple[int, dict[str, Any]]]) -> str:
    """What the user changed of the model's plan before it ran (design M8.3)."""
    lines = ["Der Anwender hat den Plan vor dem Lauf angepasst:"]
    if removed:
        lines.append(f"Entfernt: Schritt {_named(removed)}.")
    for position, arguments in changed:
        shown = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
        lines.append(f"Schritt {position} mit den Werten des Anwenders: {shown}")
    return "\n".join(lines)


@dataclass
class ChainState:
    """The run of one chain as far as the model is concerned. Positions are
    stable: a step the user removed keeps its place (it is not among
    ``steps``), and a re-plan's steps continue after the step that ran last,
    so one that failed keeps its place too."""

    prompt: Prompt
    answer: PlanAnswer
    """The plan the model gave last, as it gave it."""
    steps: list[CheckedStep]
    """The plan as it stands: the completed steps, then the remaining ones."""
    seen: dict[int, tuple[str, ModelView]] = field(default_factory=dict)
    """Position → tool and what the model saw of the step's last run."""
    completed: int = 0
    """Steps that ran and stay: the re-plan keeps them (P4)."""
    replans: int = 0
    turns: list[Message] = field(default_factory=list)
    """The conversation after the prompt: each plan the model gave and each
    re-plan's input, starting with the plan."""
    context_length: int | None = None
    """The connection's, as for the first call (``prompt.fit``)."""
    spent: int = 0
    """Steps that ran, failed ones included: with a re-plan's at most ``MAX_STEPS`` (P4)."""
    last: int = 0
    """The position of the step that ran last: a re-plan's steps continue after it."""
    edits: str | None = None
    """The user's changes to the plan (``edits_message``), told with the first re-plan."""
    profile_hash: str | None = None
    """The layer profile the next re-plan is asked with (the run time's)."""
    asked_with: dict[int, str] = field(default_factory=dict)
    """Turn index → the profile hash a re-plan's input was asked with."""

    def __post_init__(self) -> None:
        if not self.turns:
            self.turns = [Message("assistant", said(self.answer))]

    @property
    def next(self) -> CheckedStep | None:
        return self.steps[self.completed] if self.completed < len(self.steps) else None

    def ran(self, step: CheckedStep, view: ModelView) -> After:
        """What follows ``step``, which the model saw as ``view``."""
        self.seen[step.position] = (step.step.tool, view)
        self.spent += 1
        self.last = step.position
        last = step.position == self.steps[-1].position
        if view.outcome == "ok":
            self.completed += 1
            if last:
                return "done"
            if not view.empty:
                return "next"
        return "replan" if self.replans < MAX_REPLANS else "stopped"

    def replan_messages(self) -> tuple[Message, ...]:
        """The re-plan call's messages: the conversation so far and the views.
        Each call counts, whether its answer is used or not (P4); one that does
        not fit the connection's context is ``context_too_large``."""
        self.replans += 1
        seen = [(position, *self.seen[position]) for position in sorted(self.seen)]
        kept = [step.position for step in self.steps[: self.completed]]
        message = replan_message(seen, kept, self.last + 1, MAX_STEPS - self.spent, self.edits)
        self.edits = None
        self.turns.append(Message("user", message))
        if self.profile_hash is not None:
            self.asked_with[len(self.turns) - 1] = self.profile_hash
        messages = (*self.prompt.messages, *self.turns)
        fit(messages, self.context_length)
        return messages

    def revise(
        self, answer: PlanAnswer, context: ToolContext, profile: ModelProfile
    ) -> Refusal | None:
        """The re-plan's steps after the completed ones, counted on after the
        step that ran last; a refusal changes nothing."""
        kept = self.steps[: self.completed]
        first = self.last + 1
        positions = [first + i for i in range(len(answer.steps))]
        found = check_plan(
            answer.steps, context, profile, done=kept, positions=positions, spent=self.spent
        )
        if isinstance(found, Refusal):
            return found
        self.answer = answer
        self.steps = [*kept, *found]
        self.turns.append(Message("assistant", said(answer)))
        return None

    @property
    def remaining(self) -> list[CheckedStep]:
        return self.steps[self.completed :]
