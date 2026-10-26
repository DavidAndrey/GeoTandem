"""The tool chain as an evaluation drives it (docs/plan-chain-eval.md, Phase 0).

The run of ``model.service`` (``PromptFlow._plan``, ``_Runner``) at a level
whose every cell is ``auto``, without its record: one planning call, the plan
checked whole (``check_plan``), the steps counted one at a time in the model's
world (``run_step``), a re-plan after an error or an empty step before the
last, until the chain is done or stops. What a run decides about the model is
``ChainState``, ``check_plan``, ``run_step`` and ``last_complete``, which the
service uses too; only the loop is repeated here, and
``tests/test_eval_chain.py`` holds it to the service's on the same script:
the same calls with the same messages, the same steps, the same end and
result.

A measurement needs neither the record nor approvals and halts (every step
runs, as at *Automatisch*; the level's classes are not consulted), nor the
instance's query slots, the request limit or an abort. It keeps the time
limits: the request's (``CHAIN_TIME_LIMIT_S``) and each call's
(``MODEL_CALL_S``), on its own clock.

``drive`` raises what the planning call raises (``LLMError``, an
``ActionError`` such as ``model_unreadable``), as ``DirectQuery.ask`` does: no
answer came. A re-plan's failure ends the chain instead, as in the service.
``graded`` is the chain's verdict with the application's grader: the result
the record would offer to adopt, for a chain that ran to its end; a stop
before it is ``refused`` with the reason (``refused:replan_limit``).
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from geotandem.catalog import ModelProfile
from geotandem.data import DataBackend, Limits
from geotandem.engine.errors import ResultTooLarge
from geotandem.evaluation.grade import Graded, grade
from geotandem.evaluation.schemas import EvalCase
from geotandem.levels import CellMode
from geotandem.llm import LLMClient, LLMError
from geotandem.model.chain.ask import ChainState, ask, plan
from geotandem.model.chain.plan import CheckedStep
from geotandem.model.chain.run import StepRun, run_step
from geotandem.model.errors import ActionError
from geotandem.model.prompt import Prompt
from geotandem.model.record import ChainStep, last_complete
from geotandem.model.result import Answer, AnswerError, Tokens
from geotandem.model.schemas import (
    CHAIN_TIME_LIMIT_S,
    PlanAnswer,
    Refusal,
    StepStatus,
    StopReason,
)
from geotandem.model.service import MODEL_CALL_S
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

End = Literal["answered", "refused", "done"] | StopReason
"""How the chain ended: the model answered without a plan, its plan was
refused (``refusal``), the steps ran to the end, or a stop (``StopReason``)."""


@dataclass(frozen=True)
class CallTrace:
    """One model call: the planning call (``replan`` 0) or a re-plan."""

    replan: int
    latency_ms: int
    tokens: Tokens
    outcome: str
    """The answer's kind (``plan``, ``clarification``, ``cannot_answer``), or
    ``error:<code>`` for a correction or a re-plan whose call or answer failed."""
    correction: bool = False
    """A correction of a plan the checks refused (``ask.plan``, F7)."""


@dataclass(frozen=True)
class StepTrace:
    """One step that ran."""

    position: int
    tool: str
    arguments: dict[str, Any]
    status: StepStatus
    count: int | None
    code: str | None
    """The error's code as the model saw it (``ModelView.code``)."""
    duration_ms: int
    replan: int
    """The plan the step came with: 0 the first, then each re-plan's."""


@dataclass
class ChainRun:
    answer: Answer
    """The model's last answer that read: the plan, a re-plan, or what it said instead."""
    end: End
    refusal: Refusal | None = None
    """For ``refused`` and a re-plan refused (``replan_limit``, ``step_limit``)."""
    error: dict[str, Any] | None = None
    """A re-plan that failed: its call's or its answer's code."""
    result: QueryObject | None = None
    """What the record would offer to adopt (``last_complete``)."""
    count: int | None = None
    replans: int = 0
    calls: list[CallTrace] = field(default_factory=list)
    steps: list[StepTrace] = field(default_factory=list)

    @property
    def tokens(self) -> Tokens:
        """The calls' tokens added up; ``None`` where no call reported any."""

        def total(values: list[int | None]) -> int | None:
            known = [v for v in values if v is not None]
            return sum(known) if known else None

        return Tokens(
            total([c.tokens.prompt for c in self.calls]),
            total([c.tokens.completion for c in self.calls]),
        )


def drive(
    client: LLMClient,
    prompt: Prompt,
    context: ToolContext,
    profile: ModelProfile,
    *,
    context_length: int | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> ChainRun:
    """The chain of ``prompt`` (built with ``approach="chain"``) in the world of
    ``profile`` over the read-only view of ``context``, to its end."""
    started = clock()
    deadline = started + CHAIN_TIME_LIMIT_S
    planned = plan(
        client,
        prompt,
        context,
        profile,
        started + MODEL_CALL_S,
        context_length=context_length,
        clock=clock,
    )
    calls = [
        CallTrace(0, c.latency_ms, c.tokens, c.outcome, correction=i > 0)
        for i, c in enumerate(planned.calls)
    ]
    answer, checked = planned.answer, planned.checked
    if not isinstance(answer, PlanAnswer):
        return ChainRun(answer, "answered", calls=calls)
    assert checked is not None
    if isinstance(checked, Refusal):
        return ChainRun(answer, "refused", refusal=checked, calls=calls)
    state = ChainState(prompt, answer, checked, context_length=context_length)
    return _Loop(state, client, context, profile, clock, deadline, calls).go()


@dataclass
class _Loop:
    """``_Runner.go`` and ``_Runner.replan`` of the service, all cells ``auto``."""

    state: ChainState
    client: LLMClient
    context: ToolContext
    profile: ModelProfile
    clock: Callable[[], float]
    deadline: float
    calls: list[CallTrace]
    ran: list[ChainStep] = field(default_factory=list)
    steps: list[StepTrace] = field(default_factory=list)

    def go(self) -> ChainRun:
        state = self.state
        while (step := state.next) is not None:
            if self.late():
                return self.stop("time_limit")
            last = step.position == state.steps[-1].position
            run = run_step(step, self.context, self.profile, last=last)
            self.keep(step, run)
            if isinstance(run.error, ResultTooLarge):
                return self.stop("result_too_large")
            after = state.ran(step, run.view)
            if after == "done":
                return self.stop("done")
            if after == "stopped":
                return self.stop("replan_limit")
            if after == "replan" and (stopped := self.replan()) is not None:
                return stopped
        return self.stop("done")

    def late(self) -> bool:
        return self.clock() >= self.deadline

    def keep(self, step: CheckedStep, run: StepRun) -> None:
        status: StepStatus = "error" if run.error else "empty" if run.count == 0 else "ok"
        planned = step.step
        self.ran.append(
            ChainStep(
                position=step.position,
                text=planned.text,
                tool=planned.tool,
                arguments=planned.arguments,
                query=step.query,
                classes=step.classes,
                cell=CellMode.AUTO,
                status=status,
                count=run.count,
            )
        )
        self.steps.append(
            StepTrace(
                step.position,
                planned.tool,
                planned.arguments,
                status,
                run.count,
                run.view.code,
                run.duration_ms,
                self.state.replans,
            )
        )

    def replan(self) -> ChainRun | None:
        """A re-plan (``_Runner.replan``); the end when the chain stops at it."""
        state = self.state
        if self.late():
            return self.stop("time_limit")
        started = self.clock()
        replan = state.replans + 1
        try:
            messages = state.replan_messages()
            deadline = min(self.deadline, started + MODEL_CALL_S)
            answer, tokens = ask(self.client, messages, state.prompt.schema, deadline)
        except LLMError as exc:
            self.failed(replan, started, Tokens(), exc.code)
            if self.late():
                return self.stop("time_limit")
            return self.stop("replan_limit", error=_error(exc.code, cause=exc.cause))
        except ActionError as exc:  # context_too_large, model_unreadable
            spent = exc.tokens if isinstance(exc, AnswerError) else Tokens()
            self.failed(replan, started, spent, exc.code)
            return self.stop("replan_limit", error=_error(exc.code, **exc.details))
        self.calls.append(CallTrace(replan, _ms(self.clock() - started), tokens, answer.kind))
        if not isinstance(answer, PlanAnswer):
            return self.stop("replan_limit", error=_error("model_unreadable", kind=answer.kind))
        refused = state.revise(answer, self.context, self.profile)
        if refused is not None:
            reason: StopReason = "step_limit" if refused.code == "step_limit" else "replan_limit"
            return self.stop(reason, refusal=refused)
        return None

    def failed(self, replan: int, started: float, tokens: Tokens, code: str) -> None:
        self.calls.append(CallTrace(replan, _ms(self.clock() - started), tokens, f"error:{code}"))

    def stop(
        self,
        end: End,
        refusal: Refusal | None = None,
        error: dict[str, Any] | None = None,
    ) -> ChainRun:
        found = last_complete(self.ran, self.context.limits.max_features)
        return ChainRun(
            self.state.answer,
            end,
            refusal=refusal,
            error=error,
            result=found.query if found else None,
            count=found.count if found else None,
            replans=self.state.replans,
            calls=self.calls,
            steps=self.steps,
        )


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


def _error(code: str, **details: Any) -> dict[str, Any]:
    return {"code": code, "details": details}


def graded(
    case: EvalCase,
    run: ChainRun,
    backend: DataBackend,
    limits: Limits,
    readings: list[list[int]] | None = None,
) -> Graded:
    """The chain's verdict (``grade``): a behaviour case on the answer, a query
    case on the result of a chain that ran to its end, ``refused`` with the
    reason for one that stopped before."""
    if case.expect is None and run.end not in ("answered", "refused", "done"):
        return Graded("refused", f"refused:{run.end}", run.end)
    return grade(case, run.answer, run.refusal, run.result, backend, limits, readings)
