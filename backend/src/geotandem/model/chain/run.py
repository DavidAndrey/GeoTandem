"""A chain's steps run (P4, D9, plan WP74): counted and stamped, never fetched.

A step's query object runs in the model's world (``ModelWorld``: the account's
read-only view, narrowed to its layer profile) as a stamp
(``engine.stamp_query``): count, hash of the ids, provenance. No row, no
geometry and no attribute value is read into the application, let alone
handed on; an intermediate result is that stamp and its query object, never a
table (the dimmed layers of design M9.1 draw the query object). The stamp is
for the user; the model gets ``model_view`` of it, and of an error only its
code and the name it is about.

``run_chain`` is the whole run without a store, as tests and a caller that
keeps nothing need it: plan, check, run each step, re-plan when due. The
application's run (WP75) takes the same pieces one at a time: ``run_step``,
``ChainState`` and ``ask``, with its store, its approvals and its time limits
around them.
"""

import time
from dataclasses import dataclass, field

from geotandem.catalog import ModelProfile
from geotandem.engine import QueryError, ResultStamp, stamp_query
from geotandem.llm import LLMClient
from geotandem.model.chain.ask import After, ChainState, ask
from geotandem.model.chain.plan import CheckedStep, check_plan
from geotandem.model.chain.view import StepResult, model_view
from geotandem.model.prompt import Prompt
from geotandem.model.result import Answer
from geotandem.model.schemas import ModelView, PlanAnswer, Refusal
from geotandem.model.validate import ModelWorld
from geotandem.tools import ToolContext


@dataclass(frozen=True)
class StepRun:
    step: CheckedStep
    stamp: ResultStamp | None
    """For the user (``StepView``); ``None`` when the step failed."""
    error: QueryError | None
    """For the user and the log; its text never reaches the model."""
    view: ModelView
    """For the model: ``model_view`` of the stamp or the error."""
    duration_ms: int


def run_step(step: CheckedStep, context: ToolContext, profile: ModelProfile) -> StepRun:
    """Count and stamp ``step`` in the world of ``profile``, the account's layer
    profile as it is now, over the read-only view ``context`` holds."""
    started = time.perf_counter()
    world = ModelWorld(context.backend, profile)
    stamp: ResultStamp | None = None
    error: QueryError | None = None
    try:
        stamp = stamp_query(step.query, world, context.limits, context.unsupported)
    except QueryError as exc:
        error = exc
    outcome = stamp if stamp is not None else error
    assert outcome is not None
    view = model_view(StepResult(step.step.arguments, outcome))
    duration = round((time.perf_counter() - started) * 1000)
    return StepRun(step, stamp, error, view, duration)


@dataclass
class ChainOutcome:
    """A chain run to its end, or as far as it came."""

    answer: Answer
    """The last answer: a plan, or what the model said instead."""
    runs: list[StepRun] = field(default_factory=list)
    refusal: Refusal | None = None
    """The plan, or a re-plan, did not pass ``check_plan``."""
    after: After | None = None
    """How the last step ended: ``done`` when the chain reached its end,
    ``stopped`` when a re-plan was due and none was left."""
    replans: int = 0

    @property
    def result(self) -> StepRun | None:
        """The last step's run, when the chain reached its end."""
        return self.runs[-1] if self.after == "done" else None


def run_chain(
    client: LLMClient,
    prompt: Prompt,
    context: ToolContext,
    profile: ModelProfile,
    *,
    deadline: float | None = None,
) -> ChainOutcome:
    """Plan, check, run every step, re-plan after an error or an empty step
    before the last, at most ``MAX_REPLANS`` times (P4)."""
    answer = ask(client, prompt.messages, prompt.schema, deadline)
    outcome = ChainOutcome(answer)
    if not isinstance(answer, PlanAnswer):
        return outcome
    checked = check_plan(answer.steps, context, profile)
    if isinstance(checked, Refusal):
        outcome.refusal = checked
        return outcome
    state = ChainState(prompt, answer, checked)
    while (step := state.next) is not None:
        run = run_step(step, context, profile)
        outcome.runs.append(run)
        outcome.after = after = state.ran(step, run.view)
        if after == "stopped":
            break
        if after != "replan":
            continue
        answer = ask(client, state.replan_messages(), prompt.schema, deadline)
        outcome.answer, outcome.replans = answer, state.replans
        if not isinstance(answer, PlanAnswer):
            break
        refused = state.revise(answer, context, profile)
        if refused is not None:
            outcome.refusal = refused
            break
    return outcome
