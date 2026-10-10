"""What a chain says to the model and hears back (P4, D9, plan WP74).

The one module of the chain that talks to the model, and it never touches an
engine result: what it knows of a step is the step's ``ModelView``
(``view.model_view``) and nothing else. ``tests/test_model_chain.py`` holds it
to that: it imports nothing of the engine and reads no attribute a result or
an error carries.

Planning is one call (P4): the system message and the prompt of
``prompt.build_prompt`` with the chain's answer format. A re-plan continues
that conversation: the plan the model gave, as it gave it, and a user message
with the ``ModelView`` of every step that ran, asking for the remaining steps
only; the completed steps stay (P4).

``ChainState`` keeps the rules of a run that concern the model: which step is
next, when a re-plan is due (an error, or an empty step before the last; not
an empty last step) and when none is left (``MAX_REPLANS``). Who runs the
steps, stores them and stops for approval is the caller (WP75).
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from geotandem.catalog import ModelProfile
from geotandem.llm import LLMClient, Message
from geotandem.model.chain.plan import CheckedStep, check_plan
from geotandem.model.prompt import Prompt
from geotandem.model.result import Answer, parse_answer
from geotandem.model.schemas import MAX_REPLANS, MAX_STEPS, ModelView, PlanAnswer, Refusal
from geotandem.tools import ToolContext

After = Literal["next", "replan", "done", "stopped"]
"""What follows a step: the next one, a re-plan, the end, or a stop because a
re-plan is due and none is left."""


def ask(
    client: LLMClient,
    messages: Sequence[Message],
    schema: dict[str, Any],
    deadline: float | None = None,
) -> Answer:
    """One model call of the chain; ``model_unreadable`` as for the direct query."""
    completion = client.complete(messages, schema=dict(schema), deadline=deadline)
    return parse_answer(completion, "chain")


def said(answer: PlanAnswer) -> str:
    """The model's plan, as the next turn repeats it: its own words only."""
    return json.dumps(answer.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))


Seen = tuple[int, str, ModelView]
"""A step that ran: its position, its tool and what the model saw of it."""


def replan_message(seen: Sequence[Seen], completed: int) -> str:
    """The re-plan's input (P4): per step that ran, its tool and its ``ModelView``."""
    lines = ["Ergebnis der ausgeführten Schritte:"]
    for position, tool, view in seen:
        shown = json.dumps(view.model_dump(exclude_none=True), separators=(",", ":"))
        lines.append(f"Schritt {position} ({tool}): {shown}")
    if completed:
        lines.append(
            f"Die Schritte 1 bis {completed} bleiben. Plane die übrigen neu: antworte mit "
            f"einem Plan, der nur die neuen Schritte enthält; sie zählen ab Schritt "
            f"{completed + 1} und dürfen die Schritte 1 bis {completed} nennen. Zusammen "
            f"höchstens {MAX_STEPS} Schritte."
        )
    else:
        lines.append(f"Plane die Schritte neu, höchstens {MAX_STEPS}.")
    return "\n".join(lines)


@dataclass
class ChainState:
    """The run of one chain as far as the model is concerned."""

    prompt: Prompt
    answer: PlanAnswer
    steps: list[CheckedStep]
    """The plan as it stands: the completed steps, then the remaining ones."""
    seen: dict[int, tuple[str, ModelView]] = field(default_factory=dict)
    """Position → tool and what the model saw of the step's last run."""
    completed: int = 0
    """Steps that ran and stay: the re-plan keeps them (P4)."""
    replans: int = 0
    turns: list[Message] = field(default_factory=list)
    """The conversation after the prompt: each plan and each re-plan input."""

    @property
    def next(self) -> CheckedStep | None:
        return self.steps[self.completed] if self.completed < len(self.steps) else None

    def ran(self, step: CheckedStep, view: ModelView) -> After:
        """What follows ``step``, which the model saw as ``view``."""
        self.seen[step.position] = (step.step.tool, view)
        last = step.position == len(self.steps)
        if view.outcome == "ok":
            self.completed += 1
            if last:
                return "done"
            if not view.empty:
                return "next"
        return "replan" if self.replans < MAX_REPLANS else "stopped"

    def replan_messages(self) -> tuple[Message, ...]:
        """The re-plan call's messages: the conversation so far and the views.
        Each call counts, whether its answer is used or not (P4)."""
        self.replans += 1
        seen = [(position, *self.seen[position]) for position in sorted(self.seen)]
        self.turns += [
            Message("assistant", said(self.answer)),
            Message("user", replan_message(seen, self.completed)),
        ]
        return (*self.prompt.messages, *self.turns)

    def revise(
        self, answer: PlanAnswer, context: ToolContext, profile: ModelProfile
    ) -> Refusal | None:
        """The re-plan's steps after the completed ones; a refusal changes nothing."""
        kept = self.steps[: self.completed]
        found = check_plan(answer.steps, context, profile, done=kept)
        if isinstance(found, Refusal):
            return found
        self.answer = answer
        self.steps = [*kept, *found]
        return None
