"""A chain's steps run (P4, D9, plan WP74): counted, never fetched.

A step's query object runs in the model's world (``ModelWorld``: the account's
read-only view, narrowed to its layer profile) as a count
(``engine.count_query``): no row, no geometry, no attribute value and no id
list is read. The count is the user's hit count and, through
``model_view``, all the model learns of the step; of an error, its code and
the name it is about. An intermediate result is that count and its query
object, never a table (the dimmed layers of design M9.1 draw the query
object).

Only the result that can be adopted gets a stamp (``engine.stamp_query``:
count, hash of the ids, provenance): the last complete step, once the run
ends, and only while its count is within the result-size limit
(``Limits.max_features``). A last step beyond it stops the run with
``result_too_large``.

``run_chain`` is the whole run without a store, as tests and a caller that
keeps nothing need it: plan, check, run each step, re-plan when due, within
the request's deadline (P4: checked before every step and every re-plan call;
past it the run stops with ``time_limit``). The application's run (WP75)
takes the same pieces one at a time: ``run_step``, ``adoptable``,
``ChainState`` and ``ask``, with its store, its approvals and its time limits
around them.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from geotandem.catalog import ModelProfile
from geotandem.engine import QueryError, ResultStamp, count_query, stamp_query
from geotandem.engine.errors import ResultTooLarge
from geotandem.llm import LLMClient
from geotandem.model.chain.ask import After, ChainState, ask
from geotandem.model.chain.plan import CheckedStep, check_plan
from geotandem.model.chain.view import StepResult, model_view
from geotandem.model.prompt import Prompt
from geotandem.model.result import Answer
from geotandem.model.schemas import ModelView, PlanAnswer, Refusal, StopReason
from geotandem.model.validate import ModelWorld
from geotandem.tools import ToolContext


@dataclass(frozen=True)
class StepRun:
    step: CheckedStep
    count: int | None
    """The hits, for the user (``StepView.hits``); ``None`` when the step failed."""
    error: QueryError | None
    """For the user and the log; its text never reaches the model."""
    view: ModelView
    """For the model: ``model_view`` of the count or the error."""
    duration_ms: int
    stamp: ResultStamp | None = None
    """The adoptable result's only (``adoptable``)."""


def run_step(
    step: CheckedStep, context: ToolContext, profile: ModelProfile, *, last: bool = False
) -> StepRun:
    """Count ``step`` in the world of ``profile``, the account's layer profile as
    it is now, over the read-only view ``context`` holds. The ``last`` step of
    the plan fails with ``result_too_large`` beyond the result-size limit: its
    result is the one to adopt."""
    started = time.perf_counter()
    world = ModelWorld(context.backend, profile)
    count: int | None = None
    error: QueryError | None = None
    try:
        count = count_query(step.query, world, context.limits, context.unsupported)
        limit = context.limits.max_features
        if last and count > limit:
            raise ResultTooLarge(
                f"The result has {count} features, more than {limit}.",
                max_features=limit,
                count=count,
            )
    except QueryError as exc:
        count, error = None, exc
    outcome = count if count is not None else error
    assert outcome is not None
    view = model_view(StepResult(step.step.arguments, outcome))
    duration = round((time.perf_counter() - started) * 1000)
    return StepRun(step, count, error, view, duration)


def adoptable(runs: list[StepRun], context: ToolContext, profile: ModelProfile) -> StepRun | None:
    """The last complete step that is no buffer (D3), with its stamp, when its
    count is within the result-size limit; ``None`` when there is none to adopt."""
    counted = [
        (run, run.count) for run in runs if run.count is not None and run.step.query.buffer is None
    ]
    if not counted or counted[-1][1] > context.limits.max_features:
        return None
    run = counted[-1][0]
    world = ModelWorld(context.backend, profile)
    stamp = stamp_query(run.step.query, world, context.limits, context.unsupported)
    return replace(run, stamp=stamp)


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
    stop_reason: StopReason | None = None
    """A limit stopped the run (P4): ``time_limit``, ``result_too_large``."""
    replans: int = 0
    adopted: StepRun | None = None
    """The result that can be adopted, stamped (``adoptable``)."""

    @property
    def result(self) -> StepRun | None:
        """The last step's run, when the chain reached its end."""
        return self.adopted if self.after == "done" and self.stop_reason is None else None


def run_chain(
    client: LLMClient,
    prompt: Prompt,
    context: ToolContext,
    profile: ModelProfile,
    *,
    deadline: float | None = None,
    context_length: int | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> ChainOutcome:
    """Plan, check, run every step, re-plan after an error or an empty step
    before the last, at most ``MAX_REPLANS`` times (P4). ``deadline`` is the
    request's (``clock``, ``CHAIN_TIME_LIMIT_S`` from its start): checked
    before every step and every re-plan call, and the model calls' own."""

    def late() -> bool:
        return deadline is not None and clock() >= deadline

    answer = ask(client, prompt.messages, prompt.schema, deadline)
    outcome = ChainOutcome(answer)
    if not isinstance(answer, PlanAnswer):
        return outcome
    checked = check_plan(answer.steps, context, profile)
    if isinstance(checked, Refusal):
        outcome.refusal = checked
        return outcome
    state = ChainState(prompt, answer, checked, context_length=context_length)
    while (step := state.next) is not None:
        if late():
            outcome.stop_reason = "time_limit"
            break
        run = run_step(step, context, profile, last=step.position == len(state.steps))
        outcome.runs.append(run)
        if isinstance(run.error, ResultTooLarge):
            outcome.stop_reason = "result_too_large"
            break
        outcome.after = after = state.ran(step, run.view)
        if after != "replan":
            if after == "stopped":
                break
            continue
        if late():
            outcome.stop_reason = "time_limit"
            break
        answer = ask(client, state.replan_messages(), prompt.schema, deadline)
        outcome.answer, outcome.replans = answer, state.replans
        if not isinstance(answer, PlanAnswer):
            break
        refused = state.revise(answer, context, profile)
        if refused is not None:
            outcome.refusal = refused
            break
    outcome.adopted = adoptable(outcome.runs, context, profile)
    return outcome
