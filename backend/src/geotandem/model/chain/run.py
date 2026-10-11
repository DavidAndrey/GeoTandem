"""A chain's steps run (P4, D9, plan WP74): counted, never fetched.

A step's query object runs in the model's world (``ModelWorld``: the account's
read-only view, narrowed to its layer profile) as a count
(``engine.count_query``): no row, no geometry, no attribute value and no id
list is read. The count is the user's hit count and, through
``model_view``, all the model learns of the step; of an error, its code and
the name it is about. An intermediate result is that count and its query
object, never a table (the dimmed layers of design M9.1 draw the query
object).

Only the result that can be adopted gets a stamp (``stamp``: count, hash of
the ids, provenance): the one the record offers once the run ended
(``record.last_complete``). A last step beyond the result-size limit
(``Limits.max_features``) stops the run with ``result_too_large``.

The run itself, with its store, its approvals, its re-plans and its time
limits, is the application's (``model.service``): one run loop, there.
"""

import time
from dataclasses import dataclass

from geotandem.catalog import ModelProfile
from geotandem.engine import QueryError, ResultStamp, count_query, stamp_query
from geotandem.engine.errors import ResultTooLarge
from geotandem.model.chain.plan import CheckedStep
from geotandem.model.chain.view import StepResult, model_view
from geotandem.model.schemas import ModelView
from geotandem.model.validate import ModelWorld
from geotandem.tools import ToolContext
from geotandem_query import QueryObject


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


def stamp(query: QueryObject, context: ToolContext, profile: ModelProfile) -> ResultStamp:
    """The stamp of the result a chain offers to adopt, in the model's world."""
    world = ModelWorld(context.backend, profile)
    return stamp_query(query, world, context.limits, context.unsupported)
