"""The contract of Modus B, frozen in WP62 (plan E2.3-E2.6, section 6).

Three groups, each with one reader:

- ``ModelAnswer`` is how the application reads the model's reply (D7): the
  query inside stays raw JSON, because whether it is a valid query object is
  for the application to decide (D1, D3), and a rejected one is kept for the
  user to inspect (design M3). ``answer_schema()`` is what the prompt demands:
  the same union with the query-object schema in place, so a model with
  constrained output is held to it. It is part of the prompt the application
  writes, never of the editable system prompt.
- Requests and views are the HTTP interface; the frontend's types are
  generated from them (``make gen``).
- The code literals name every refusal and every error of the model path, so
  the catalog in ``codes.py`` and the interface's words stay complete.

No view of an action carries rows. Rows leave only in ``ExecuteResponse``, to
the user, and a step's ``model_view`` holds only what D9 allows.
"""

from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    field_serializer,
    model_validator,
)

from geotandem.engine.result import QueryResult, ResultStamp
from geotandem.levels import CellMode, OpClass
from geotandem.llm import Locality
from geotandem_query import QueryObject, compact

MAX_PROMPT = 4000
"""Characters of one prompt."""
MAX_TURNS = 6
"""Earlier answers the follow-up context reaches back (D8, P6)."""
MAX_CONDITIONS = 8
"""Leaf conditions of a model-built query object, and of the analysis a
follow-up starts from (design M3.2, P6); ``and``/``or``/``not`` do not count."""
MAX_STEPS = 8
"""Steps of one tool chain, re-planned steps included (F-3.9, P4)."""
MAX_REPLANS = 2
"""Re-plan calls of one tool chain (P4)."""
CHAIN_TIME_LIMIT_S = 300
"""Wall clock of one tool-chain request (P4)."""
MAX_PAGE = 200
"""Rows of one page of the log."""

Approach = Literal["direct", "chain"]
"""*Direktabfrage* or *Werkzeugkette* (F-5.4), chosen per request."""

Reference = Literal["none", "last_answer", "hand_edited"]
"""What a follow-up builds on (P6): derived by the server, never sent by the client."""

ActionStatus = Literal[
    "thinking",
    "refused",
    "answered",
    "proposed",
    "approved",
    "running",
    "done",
    "limited",
    "applied",
    "rejected",
    "superseded",
    "undone",
    "aborted",
    "failed",
]
"""Where an action stands (plan 1.2).

- ``thinking``: the model call runs; ``POST /prompt`` answers with it (202) and
  the client polls, so the call can be aborted.
- ``refused``: the application refused the answer (D1, D3). ``answered``: a
  clarification or a cannot-answer, nothing proposed. Neither is a decision.
- ``proposed``: waits for a decision (also a chain stopped before a step).
- ``approved``: may execute or run; an answer whose cell is ``auto`` arrives
  here without a question and the client executes it at once (D2).
- ``running``: chain steps run. ``done``: a chain finished. ``limited``: a
  chain stopped early (``stop_reason``: a limit, an abort, a restart); in both
  its result waits to be adopted, or is superseded by the next prompt.
- ``applied``: the result is the analysis (executed, adopted, or by hand).
- ``rejected``, ``superseded``, ``undone``, ``aborted`` (a direct query
  cancelled while thinking), ``failed``: final.
"""

Decision = Literal[
    "accepted",
    "adjusted",
    "rejected",
    "superseded",
    "auto",
    "proposal_only",
    "aborted",
    "failed",
]
"""How an action ended (plan section 2); set once, ``None`` while open and for
``refused`` and ``answered``. A proposal on a level with ``off`` parts ends as
``proposal_only`` whether it is applied by hand or overtaken by the next
prompt (``applied_by_hand`` tells which), never as ``superseded``."""

RejectReason = Literal["misunderstood", "wrong_layer", "wrong_value", "other"]
"""The optional chip of a rejection (design M5.3)."""

StopReason = Literal["step_limit", "time_limit", "result_too_large", "aborted", "interrupted"]
"""Why a chain stopped before its end (design M9.4, M9.5; ``interrupted``: the
application restarted while it ran, P4)."""

EngineCode = Literal[
    "invalid_query",
    "unknown_layer",
    "unknown_attribute",
    "unsupported_operation",
    "result_too_large",
    "query_timeout",
    "query_too_complex",
    "invalid_query_geometry",
    "name_clash",
    "key_type_mismatch",
    "attribute_not_text",
    "attribute_not_numeric",
    "wrong_value_type",
]
"""The engine's codes, as a failed step reports them to the model (D9)."""

RefusalCode = Literal[
    "invalid_query",
    "unknown_layer",
    "unknown_attribute",
    "unsupported_operation",
    "query_too_complex",
    "invalid_query_geometry",
    "name_clash",
    "key_type_mismatch",
    "attribute_not_text",
    "attribute_not_numeric",
    "wrong_value_type",
    "model_query_invalid",
    "limit_exceeded",
    "not_representable",
    "step_limit",
]
"""Why the application refused a model's answer (D1, D3, design M3). Every
validation code of the engine (``EngineCode`` but ``result_too_large`` and
``query_timeout``, which only a run raises) passes through with its meaning:
``unknown_layer`` covers a layer that does not exist, one hidden from the
account and one not released for the model, as everywhere else, so a prompt
cannot probe for them; ``query_too_complex`` is the engine's bound for any
query, while ``limit_exceeded`` is the stricter bound of the model path
(``MAX_CONDITIONS``)."""

ActionErrorCode = Literal[
    "not_implemented",
    "context_too_large",
    "stale_reference",
    "model_unreadable",
    "quota_exceeded",
    "not_approved",
    "already_decided",
    "class_not_allowed",
    "nothing_to_undo",
    "undo_blocked",
    "time_limit",
]
"""Errors of the model routes beyond the shared ones (``not_found``, ``llm_*``,
``result_too_large``, ``query_timeout``, ``schema_violation``)."""

Prompt = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PROMPT)
]
Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]
Name = Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")]


# --- What the model returns (D7) -------------------------------------------


class _Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Assumption(_Answer):
    """One assumption, shown with ≈ (F-5.12, design M2, M12.1)."""

    text: Short
    condition: list[int] | None = Field(
        default=None,
        description="Path of indexes into the query's where tree; lets 'ändern' open it.",
    )


class QueryAnswer(_Answer):
    kind: Literal["query"]
    explanation: Short
    """One to three sentences: how the model read the question."""
    assumptions: list[Assumption] = Field(default=[], max_length=8)
    query: dict[str, Any]
    """Raw: validated by the application, kept even when refused (design M3)."""


class Clarification(_Answer):
    """Only when no sensible assumption exists (D5, design M12.2)."""

    kind: Literal["clarification"]
    question: Short
    options: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] = Field(
        min_length=2, max_length=4
    )


class CannotAnswer(_Answer):
    """Nothing to propose (design M13). With ``other_approach`` the answer offers
    to try the other way of working (D6); without, it says what is missing."""

    kind: Literal["cannot_answer"]
    explanation: Short
    missing: list[Short] = Field(default=[], max_length=8)
    other_approach: Approach | None = None


class PlannedStep(_Answer):
    text: Short
    """The step in words, as the plan shows it (design M8)."""
    tool: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    arguments: dict[str, Any]


class PlanAnswer(_Answer):
    """A tool chain, planned in one call as structured output (P4)."""

    kind: Literal["plan"]
    explanation: Short
    assumptions: list[Assumption] = Field(default=[], max_length=8)
    steps: list[PlannedStep] = Field(min_length=1)
    """At most ``MAX_STEPS``: more is refused with ``step_limit``, not cut."""


ModelAnswer = Annotated[
    QueryAnswer | Clarification | CannotAnswer | PlanAnswer, Field(discriminator="kind")
]


class _PromptedQueryAnswer(QueryAnswer):
    model_config = ConfigDict(title="QueryAnswer")
    query: QueryObject  # type: ignore[assignment]


def answer_schema() -> dict[str, Any]:
    """The output format the prompt demands (D7): ``ModelAnswer`` with the
    query-object schema in place of the raw query."""
    union = Annotated[
        _PromptedQueryAnswer | Clarification | CannotAnswer | PlanAnswer,
        Field(discriminator="kind"),
    ]
    schema: dict[str, Any] = TypeAdapter[Any](union).json_schema()
    return schema


# --- Requests --------------------------------------------------------------


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PromptRequest(_Request):
    """A prompt. No earlier turns: the server builds them from the parent chain (P6)."""

    text: Prompt
    approach: Approach = "direct"
    parent_action_id: int | None = None
    """The answer this follows; ``None`` for a fresh question ("ohne Bezug", design M11.1)."""
    analysis: QueryObject | None = None
    """The current analysis; sent with a parent and only then."""

    @model_validator(mode="after")
    def _analysis_needs_a_parent(self) -> Self:
        if self.analysis is not None and self.parent_action_id is None:
            raise ValueError("analysis is sent only with parent_action_id")
        return self


class DecideRequest(_Request):
    """The hand-over cases (P1, D2): applied by hand, or edited and applied via Modus A."""

    decision: Literal["proposal_only", "adjusted"]
    applied_by_hand: bool = False
    query: QueryObject | None = None
    """For ``adjusted``: what the user applied instead; logged, never executed here."""


class RejectRequest(_Request):
    reason: RejectReason | None = None


class StepEdit(_Request):
    position: int
    arguments: dict[str, Any]


class PlanEdit(_Request):
    """Change values or remove steps; never add one (design decision 17)."""

    change: list[StepEdit] = []
    remove: list[int] = []


# --- Views -----------------------------------------------------------------


class LevelSnapshot(BaseModel):
    """The level as it was when the prompt was sent (H7, M7.3)."""

    id: int
    name: str
    matrix: dict[OpClass, CellMode]
    prompt_hash: str


class ConnectionSnapshot(BaseModel):
    id: int
    name: str
    model: str
    host: str
    locality: Locality


class Refusal(BaseModel):
    code: RefusalCode
    message: str
    details: dict[str, Any] = {}


class Governance(BaseModel):
    """What the level decides for this answer (H4, D1, design M6.3, M7.1)."""

    classes: list[OpClass]
    cell: CellMode
    """The strictest cell among ``classes``: the whole answer follows it."""
    needs_approval: list[OpClass]
    off: list[OpClass]
    """Non-empty: the model may only propose; the user applies by hand (D1)."""


class ModelView(BaseModel):
    """What the model learns of a step (D9). Every field is a flag, a count, a
    code or a name taken from the model's own query: nothing here can hold a
    row, a geometry, an extent or an attribute value (D10)."""

    model_config = ConfigDict(extra="forbid")

    outcome: Literal["ok", "error"]
    code: EngineCode | RefusalCode | None = None
    part: Name | None = None
    """The layer or attribute of the model's query the error is about."""
    empty: bool | None = None
    count: int | None = None


StepStatus = Literal["planned", "waiting", "running", "ok", "error", "empty", "skipped", "removed"]


class StepView(BaseModel):
    position: int
    text: str
    tool: str
    arguments: dict[str, Any]
    classes: list[OpClass]
    """A step whose query mixes parts touches several classes (H4)."""
    cell: CellMode
    """The strictest cell among ``classes`` at the level as it was."""
    status: StepStatus
    revised: bool = False
    """Changed by a re-plan (P4)."""
    hits: int | None = None
    """For the user; the model sees ``model_view`` only."""
    stamp: ResultStamp | None = None
    layer: str | None = None
    """The intermediate layer this step made, for the dimmed map (design M9.1)."""
    model_view: ModelView | None = None
    duration_ms: int | None = None


class ModelActionView(BaseModel):
    """One action record as its owner or an administrator sees it (D4). Never
    rows: those leave only in ``ExecuteResponse``."""

    id: int
    account: str
    created_at: datetime
    decided_at: datetime | None
    prompt: str
    approach: Approach
    status: ActionStatus
    decision: Decision | None
    reject_reason: RejectReason | None = None
    applied_by_hand: bool = False
    undone_at: datetime | None = None
    previewed_at: datetime | None = None
    parent_action_id: int | None = None
    reference: Reference = "none"
    compare_of: int | None = None
    """The action this one repeats with the other approach (design M10)."""
    level: LevelSnapshot
    connection: ConnectionSnapshot
    profile_hash: str
    prompt_hash: str
    answer: ModelAnswer | None = None
    """``None`` while thinking, and after a model or transport error."""
    query: QueryObject | None = None
    """The validated query of a ``query`` answer, or a chain's result as one query
    object: what ``execute`` and ``adopt`` run, and nothing else (D2)."""
    applied_query: QueryObject | None = None
    """For ``adjusted``: what the user applied instead, through Modus A. Logged
    as the user's, never as the model's, and never executed by this path."""
    governance: Governance | None = None
    refusal: Refusal | None = None
    error: dict[str, Any] | None = None
    """``{code, message, details}`` of a model or limit error (design M14)."""
    steps: list[StepView] = []
    replans: int = 0
    stop_reason: StopReason | None = None
    stamp: ResultStamp | None = None
    latency_ms: int | None = None

    @field_serializer("query", "applied_query")
    def _as_written(self, query: QueryObject | None):  # type: ignore[no-untyped-def]
        """As the editor writes a query (``compact``): no unset field, no empty
        default. Unannotated, so the schema stays the query object's."""
        return None if query is None else compact(query)


class ExecuteResponse(BaseModel):
    """The only answer that carries rows: to the user, after ``execute`` or
    ``adopt`` (D2). The record keeps the stamp, not the features."""

    action: ModelActionView
    result: QueryResult


class ModelActionSummary(BaseModel):
    """A row of the log (design M16.1, M16.3)."""

    id: int
    account: str
    created_at: datetime
    prompt: str
    approach: Approach
    level_name: str
    connection_name: str
    locality: Locality
    status: ActionStatus
    decision: Decision | None
    reject_reason: RejectReason | None
    """The chip of a rejection (design M5.3), as the log's column shows it."""
    refusal_code: RefusalCode | None
    """Why the application refused the answer (design M3), as the log's column shows it."""
    hits: int | None


class ModelActionPage(BaseModel):
    items: list[ModelActionSummary]
    total: int


class ActionPreview(BaseModel):
    """The user's preview before approval (P2): never shown to the model."""

    count: int
    total: int
    ids: list[int]


class FeatureRef(BaseModel):
    id: int
    name: str | None


class Comparison(BaseModel):
    """The two approaches side by side (design M10); the difference is the
    application's, computed from feature ids, never the model's."""

    left_action_id: int
    right_action_id: int
    left: ResultStamp
    right: ResultStamp
    only_left: list[FeatureRef]
    only_right: list[FeatureRef]
    reason: str | None = None


class NotCounted(BaseModel):
    refused: int
    aborted: int
    failed: int


class KeyFigures(BaseModel):
    """Plan section 2, for the filters given (design M16.1)."""

    proposals: int
    accepted: int
    adjusted: int
    rejected: int
    superseded: int
    proposal_only: int
    auto: int
    undone: int
    """Of ``auto``."""
    undone_after_approval: int
    """Of ``accepted``: taken back after the user approved it."""
    acceptance_rate: float | None
    """(accepted + adjusted) / (accepted + adjusted + rejected + superseded),
    rounded to four decimals; ``None`` while nothing is decided."""
    not_counted: NotCounted
