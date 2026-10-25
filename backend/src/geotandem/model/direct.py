"""The direct query (*Direktabfrage*, F-5.4): one prompt, one model call, one
answer checked (plan WP64). No HTTP, no store: the prompt flow (WP65) resolves
level and connection, builds the client and the account's layer profile
(``catalog.model_profile`` over the account's view), records the profile's hash
on the ``thinking`` record, and maps errors.

``direct_prompt`` builds the messages after the connection's prompt profile
(plan E3, D9; ``context_too_large`` before any call);
``DirectQuery.ask`` sends them and returns a ``DirectAnswer``: the parsed
answer, and for a ``query`` answer either the validated query with its
governance or the refusal. It raises ``ActionError`` (``model_unreadable``)
and lets the seam's ``LLMError`` (``llm_*``) pass. Governance follows D1:
the classes and the strictest cell at the level; a class that is ``off``
makes a proposal the user applies by hand, never a refusal.
"""

from dataclasses import dataclass

from geotandem.catalog import ModelProfile
from geotandem.levels import CellMode, Level, OpClass, strictest
from geotandem.llm import LLMClient
from geotandem.model.prompt import DEFAULT_PROMPT_PROFILE, FollowUp, Prompt, build_prompt
from geotandem.model.result import Tokens, parse_answer
from geotandem.model.schemas import (
    CannotAnswer,
    Clarification,
    Governance,
    PlanAnswer,
    PromptProfile,
    QueryAnswer,
    Refusal,
)
from geotandem.model.validate import Validated, validate_model_query
from geotandem.tools import ToolContext
from geotandem_query import QueryObject


def governance(level: Level, classes: frozenset[OpClass]) -> Governance:
    """What ``level`` decides for an answer touching ``classes`` (H4, D1)."""
    ordered = [c for c in OpClass if c in classes]
    return Governance(
        classes=ordered,
        cell=strictest(level, ordered),
        needs_approval=[c for c in ordered if level.matrix[c] is CellMode.APPROVE],
        off=[c for c in ordered if level.matrix[c] is CellMode.OFF],
    )


def direct_prompt(
    text: str,
    *,
    level: Level,
    profile: ModelProfile,
    follow_up: FollowUp | None = None,
    context_length: int | None = None,
    prompt_profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
) -> Prompt:
    """The messages of a direct query written after ``prompt_profile``, the
    connection's or a run's (D9); ``context_too_large`` before any call."""
    return build_prompt(
        text,
        approach="direct",
        level=level,
        profile=profile,
        follow_up=follow_up,
        context_length=context_length,
        prompt_profile=prompt_profile,
    )


@dataclass(frozen=True)
class DirectAnswer:
    answer: QueryAnswer | Clarification | CannotAnswer
    """As the model gave it; a refused query stays in it for the user to see (M3)."""
    query: QueryObject | None
    """The validated query of a ``query`` answer, ``None`` when refused."""
    governance: Governance | None
    refusal: Refusal | None
    latency_ms: int
    tokens: Tokens


@dataclass(frozen=True)
class DirectQuery:
    client: LLMClient
    context: ToolContext
    """The account's view (``view_for``), limits and unsupported operations."""
    level: Level
    """The level resolved for the account (H6)."""

    def ask(
        self, prompt: Prompt, *, profile: ModelProfile, deadline: float | None = None
    ) -> DirectAnswer:
        """Send a prompt built by ``direct_prompt`` over ``profile``, the
        account's layer profile: the model sees exactly it, and its answer is
        checked in its world. The prompt flow builds the prompt while the
        request is checked, the call follows (P7) and ends by ``deadline``
        (``time.monotonic()``). The schema goes as constrained output only
        when the prompt's profile asks for it (``Prompt.constrained``)."""
        completion = self.client.complete(
            prompt.messages, schema=prompt.constrained, deadline=deadline
        )
        answer = parse_answer(completion, "direct")
        assert not isinstance(answer, PlanAnswer)  # parse_answer took the direct kinds only
        query = refusal = rules = None
        if isinstance(answer, QueryAnswer):
            checked = validate_model_query(answer.query, self.context, profile)
            if isinstance(checked, Validated):
                query, rules = checked.query, governance(self.level, checked.classes)
            else:
                refusal = checked
        return DirectAnswer(
            answer=answer,
            query=query,
            governance=rules,
            refusal=refusal,
            latency_ms=completion.latency_ms,
            tokens=Tokens.of(completion),
        )
