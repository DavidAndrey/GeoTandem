"""The direct query (*Direktabfrage*, F-5.4): one prompt, one model call, one
answer checked (plan WP64). No HTTP, no store: the prompt flow (WP65) resolves
level and connection, builds the client and the account's layer profile
(``catalog.model_profile`` over the account's view), records the profile's hash
on the ``thinking`` record, and maps errors.

``DirectQuery.run`` returns a ``DirectAnswer``: the parsed answer, and for a
``query`` answer either the validated query with its governance or the
refusal. It raises ``ActionError`` (``context_too_large`` before any call,
``model_unreadable`` after it) and lets the seam's ``LLMError`` (``llm_*``)
pass. Governance follows D1: the classes and the strictest cell at the level;
a class that is ``off`` makes a proposal the user applies by hand, never a
refusal.
"""

from dataclasses import dataclass

from geotandem.catalog import ModelProfile
from geotandem.levels import CellMode, Level, OpClass, strictest
from geotandem.llm import LLMClient
from geotandem.model.prompt import FollowUp, build_prompt
from geotandem.model.result import parse_answer
from geotandem.model.schemas import (
    CannotAnswer,
    Clarification,
    Governance,
    PlanAnswer,
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


@dataclass(frozen=True)
class DirectAnswer:
    answer: QueryAnswer | Clarification | CannotAnswer
    """As the model gave it; a refused query stays in it for the user to see (M3)."""
    query: QueryObject | None
    """The validated query of a ``query`` answer, ``None`` when refused."""
    governance: Governance | None
    refusal: Refusal | None
    tokens_estimate: int
    latency_ms: int
    prompt_tokens: int | None
    completion_tokens: int | None


@dataclass(frozen=True)
class DirectQuery:
    client: LLMClient
    context: ToolContext
    """The account's view (``view_for``), limits and unsupported operations."""
    level: Level
    """The level resolved for the account (H6)."""
    context_length: int | None = None
    """The connection's declared context length (C11); ``None``: not declared."""

    def run(
        self, text: str, *, profile: ModelProfile, follow_up: FollowUp | None = None
    ) -> DirectAnswer:
        """Ask about ``text``. ``profile`` is the account's layer profile: the
        model sees exactly it, and its answer is checked in its world."""
        prompt = build_prompt(
            text,
            approach="direct",
            level=self.level,
            profile=profile,
            follow_up=follow_up,
            context_length=self.context_length,
        )
        completion = self.client.complete(prompt.messages, schema=prompt.schema)
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
            tokens_estimate=prompt.tokens_estimate,
            latency_ms=completion.latency_ms,
            prompt_tokens=completion.prompt_tokens,
            completion_tokens=completion.completion_tokens,
        )
