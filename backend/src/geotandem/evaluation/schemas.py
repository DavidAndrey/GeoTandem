"""The contract of the evaluation, frozen in WP85 (plan E3, sections 1, 2 and 6).

Three groups:

- ``EvalCase`` and ``CaseFile`` are the case format (D2): the harness's case
  as four testplans used it, plus split, data state and origin. The start set
  in ``schema/eval-cases/`` and every export and import use it; its JSON
  schema is written by ``geotandem schema export``. A case file is written
  without ``null`` fields, so every field means what its value says: a field
  is never significant by being present.
- Requests and views are the HTTP interface under ``/api/admin/evaluation``;
  the frontend's types are generated from them (``make gen``).
- The literals name verdicts, flags and comparison words, so the grader, the
  matrix and the interface's words stay one list.

A run is a measurement, not use (D8): nothing here is a model action, and no
view carries rows. An answer's result sets are feature ids, capped, with exact
counts. A run keeps what it measured against, its cases included, so a later
edit changes no run (H7, F-3.18).
"""

from datetime import datetime
from typing import Annotated, Any, Final, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from geotandem.levels.model import MAX_SYSTEM_PROMPT
from geotandem.llm import Effort, Locality
from geotandem.model.schemas import (
    MAX_ID,
    MAX_PROMPT,
    Approach,
    ModelAnswer,
    PromptProfile,
    Refusal,
)
from geotandem_query import SCHEMA_VERSION

CASE_FILE_FORMAT: Final = "geotandem-eval-cases"
CASE_FILE_VERSION: Final = 1
GRADING_VERSION = 1
"""The rules of ``evaluation/grade.py``; a run's label names it (F-3.18), and a
change of a verdict's meaning raises it."""

MAX_CASES = 500
"""Cases of one file, and own cases of one instance."""
MAX_TAGS = 8
MAX_READINGS = 4
"""Fair readings of one question (``gold_any``)."""
MAX_POINTS = 8
"""Measuring points of one run."""
MAX_IDS = 200
"""Feature ids an answer view lists per difference set; the counts are exact."""
BLOCK = 5
"""Repeats of one seed block; a full run has two blocks, a quick test one (D7, O2)."""

RESERVED_IDS = frozenset({"export", "import", "draft-from-action"})
"""Words of the case routes: a case of that id could not be reached."""


def _not_reserved(value: str) -> str:
    if value in RESERVED_IDS:
        raise ValueError(f"'{value}' is reserved")
    return value


CaseId = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z0-9][a-z0-9.-]{0,62}$"),
    AfterValidator(_not_reserved),
]
"""As the harness names its cases (``doc1-primar-koeniz``, ``h31-naehe-wovon``)."""
Tag = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9:-]{0,31}$")]
Id = Annotated[int, Field(ge=1, le=MAX_ID)]
"""A record's id in a body: beyond a 64-bit integer it is 422, never a 500 (E2 review #38)."""
Username = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9._-]{1,62}$")]

Split = Literal["tuning", "confirm"]
"""*Abstimmung*: prompts may be tuned on it; *Bestätigung*: only to confirm (D2)."""
DataState = Literal["sample", "live"]
"""*Beispieldaten*, an isolated copy of the packaged sample, or *Betriebsdaten*,
the live catalog in the starting administrator's view (D1, D4)."""
Origin = Literal["start", "authored", "import", "log"]
"""Shipped with the application, saved from the workplace, imported, or taken
from the model log (``origin_action``). Only the start set says ``start``."""
AnswerKind = Literal["query", "clarification", "cannot_answer"]
OtherApproach = Approach | Literal["none"]
"""What a case demands of the offer of the other approach: that one, or
``none`` (no offer). An unset field checks nothing."""

Verdict = Literal["pass", "wrong", "refused", "kind", "other_approach", "forbidden", "error"]
"""What became of one answer (D6), as the harness grades it: ``pass`` the result
equals a reading (stage 2) or the expected kind came; ``wrong`` another result;
``refused`` the application refused the query (``code``); ``kind`` another
answer kind; ``other_approach`` the wrong offer of the other approach;
``forbidden`` the answer holds a word the case forbids; ``error`` no usable
answer (``code``)."""
Flag = Literal["no_assumption", "zero_hits"]
"""Marks of a ``wrong`` answer (D6). ``wrong`` with ``no_assumption`` is
*still falsch*."""
CaseStatus = Literal["ok", "stale", "dataset_changed"]
"""A live case whose layer is gone or hidden is ``stale`` and left out of runs;
one whose layer was re-imported since is run and marked (D3)."""
RunScope = Literal["full", "quick"]
"""Two seed blocks with the comparison words, or one block without (D7, O2)."""
RunStatus = Literal["running", "done", "aborted", "interrupted", "failed"]
"""``failed``: the run could not start or go on (the sample copy could not be
built, say); its ``error`` says why."""
Word = Literal["better", "worse", "not_proven"]
"""*besser*, *schlechter*, *nicht belegt*: the 95 % interval of the paired
difference lies above 0, below 0, or contains it (D7)."""
EvalErrorCode = Literal[
    "case_invalid",
    "case_id_taken",
    "case_read_only",
    "case_stale",
    "no_cases",
    "action_not_eligible",
    "run_busy",
    "external_not_confirmed",
    "runs_not_comparable",
]
"""The errors of the evaluation routes (WP85); registered in ``codes.py``."""
DiffKind = Literal["source", "missing", "added", "changed"]
"""Stage 1 (D5): another source layer, a condition of the reference the answer
lacks, one it adds, one it changes (operator, value, layer, predicate, distance)."""


# --- the case ------------------------------------------------------------------


class Require(BaseModel):
    """What a query must contain where several readings select different
    features (harness ``require``): the source layer, and per condition the keys
    it must match; ``distance_m`` is a ``[low, high]`` range."""

    model_config = ConfigDict(extra="forbid")

    source: str
    conditions: list[dict[str, Any]] = Field(min_length=1)


class CaseLayer(BaseModel):
    """A layer a live case uses, with its dataset version when the case was made (D3)."""

    model_config = ConfigDict(extra="forbid")

    name: str
    dataset_version: str | None = None


Prompt = Annotated[str, StringConstraints(min_length=1, max_length=MAX_PROMPT, pattern=r"\S")]
"""Kept as written (no stripping), so a file survives a round trip unchanged."""


class _CaseBody(BaseModel):
    """What a case and a draft of one share."""

    model_config = ConfigDict(extra="forbid")

    prompt: Prompt
    data_state: DataState = "sample"
    origin_action: Id | None = None
    """The model action a ``log`` case was taken from (F-3.14)."""
    schema_version: str = SCHEMA_VERSION
    gold: dict[str, Any] | None = None
    gold_any: list[dict[str, Any]] | None = Field(
        default=None, min_length=2, max_length=MAX_READINGS
    )
    require: Require | None = None
    expect: AnswerKind | None = None
    also: list[AnswerKind] = []
    """Further answer kinds that pass (a clarification beside an assumption)."""
    forbid: list[str] = []
    """Words that fail the answer, e.g. an invented layer of the prompt's examples."""
    other_approach: OtherApproach | None = None
    note: str = ""
    """The question's intent, for the person who judges a difference."""
    layers: list[CaseLayer] = []
    """For a live case: the layers its reference uses (D3)."""


class EvalCase(_CaseBody):
    """One question with its right answer (F-3.13, D2). Exactly one of ``gold``,
    ``gold_any``, ``require`` and ``expect``: a query case has a reference
    query, several fair readings or required parts; a behaviour case names the
    expected answer kind. A reference query is stored as the harness writes it,
    without ``schema_version`` and ``output``, against ``schema_version``.

    The JSON schema of the file cannot say "exactly one of"; the application
    checks it, the uniqueness of ids and ``origin_action`` on import."""

    id: CaseId
    tags: list[Tag] = Field(min_length=1, max_length=MAX_TAGS)
    split: Split
    origin: Origin

    @model_validator(mode="after")
    def _rules(self) -> Self:
        given = [k for k in ("gold", "gold_any", "require", "expect") if getattr(self, k)]
        if len(given) != 1:
            found = ", ".join(given) or "none"
            raise ValueError(f"exactly one of gold, gold_any, require, expect; got {found}")
        if (self.origin == "log") != (self.origin_action is not None):
            raise ValueError("origin_action goes with origin 'log', and only with it")
        if self.data_state == "live" and not self.layers and self.expect is None:
            raise ValueError("a live query case names the layers it uses")
        if self.origin == "start" and self.data_state != "sample":
            raise ValueError("a start case runs on the sample data")
        return self


class CaseDraft(_CaseBody):
    """A case not yet saved (V2 prefilled from M16.2, V3): no id and no tags yet;
    the administrator adds them and saves it with ``POST /cases``."""

    split: Split = "confirm"
    """New own cases default to the confirmation split (design review 3)."""
    origin: Literal["authored", "log"]


class CaseFile(BaseModel):
    """The start set, an export, an import: the same JSON (F-10.4), written
    without ``null`` fields."""

    model_config = ConfigDict(extra="forbid")

    format: Literal["geotandem-eval-cases"] = CASE_FILE_FORMAT
    version: Literal[1] = CASE_FILE_VERSION
    about: str = ""
    cases: list[EvalCase] = Field(max_length=MAX_CASES)

    @model_validator(mode="after")
    def _unique(self) -> Self:
        ids = [c.id for c in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("case ids repeat")
        return self


class CaseView(BaseModel):
    case: EvalCase
    status: CaseStatus = "ok"
    status_layers: list[str] = []
    """The layers behind a ``stale`` or ``dataset_changed`` status (V1.2)."""
    read_only: bool
    """A start case: copied, never edited (V2.3)."""
    reference_hits: list[int] | None = None
    """Features of each reading on its data state (V2.3: one per ``gold_any``
    entry); ``None`` for a behaviour or ``require`` case, a stale one, and in a
    list (only the detail computes it)."""
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CasePage(BaseModel):
    items: list[CaseView]
    total: int


class ImportProblem(BaseModel):
    case_id: str | None
    code: str
    message: str


class ImportResult(BaseModel):
    """All or nothing (V1.3): ``imported`` is 0 whenever ``problems`` is not empty."""

    imported: int
    problems: list[ImportProblem] = []


# --- a run -----------------------------------------------------------------------


class MeasuringPoint(BaseModel):
    """A connection, its prompt profile and a level (D9, D10)."""

    model_config = ConfigDict(extra="forbid")

    connection_id: Id
    prompt_profile: PromptProfile | None = None
    """``None``: the connection's own profile."""
    level_id: Id
    system_prompt: Annotated[str, StringConstraints(max_length=MAX_SYSTEM_PROMPT)] | None = None
    """An edited copy of the level's system prompt for this run only (D10)."""


class CaseFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origins: list[Origin] = Field(default=["start"], min_length=1)
    """Start set and/or own cases by how they came (V4.1)."""
    split: Split | None = None
    """``None``: both."""
    tags: list[Tag] = Field(default=[], max_length=MAX_TAGS)
    """Any of them; empty: all."""


class RunRequest(BaseModel):
    """A run as V4 composes it; the run keeps it (``RunView.request``), so
    "Als vollständigen Lauf wiederholen" opens V4 with it."""

    model_config = ConfigDict(extra="forbid")

    points: list[MeasuringPoint] = Field(min_length=1, max_length=MAX_POINTS)
    reference: int = 0
    """Index of the point the others are compared with (D7)."""
    cases: CaseFilter = CaseFilter()
    data_state: DataState = "sample"
    scope: RunScope = "full"
    confirm_external: list[Id] = Field(default=[], max_length=MAX_POINTS)
    """Ids of the external connections the administrator confirmed sending to
    (F-9.4, D12); a run with an external connection not listed is refused."""

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if not 0 <= self.reference < len(self.points):
            raise ValueError("reference must name one of the points")
        if self.data_state == "live" and "start" in self.cases.origins:
            raise ValueError("the start set runs on the sample data, not with live cases")
        return self


class Money(BaseModel):
    amount: float
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]


class ConnectionEstimate(BaseModel):
    connection_id: int
    name: str
    host: str
    locality: Locality
    points: int
    requests: int
    tokens: int
    cost: Money | None
    """``None`` without a price on the connection (O4)."""
    duration_s: int
    """From the median latency of the connection's last run, else its connection test."""


class CostEstimate(BaseModel):
    """What a run will ask before it starts (D12). Connections run in parallel,
    so ``duration_s`` is the longest of them (D8)."""

    cases: int
    connections: list[ConnectionEstimate]
    requests: int
    tokens: int
    cost: list[Money]
    """Per currency, of the connections with a price."""
    duration_s: int
    external_hosts: list[str]
    """Hosts the layer profile and the questions would go to (F-9.3, F-9.4)."""


class LayerGaps(BaseModel):
    """What a layer lacks, in the order of care of Phase 4 (D11), with the totals
    the shares of V8.1 are taken of."""

    layer: str
    title: str
    attributes: int
    text_attributes: int
    unconfirmed_codes: list[str]
    """Text attributes with a proposed code list not yet confirmed: the largest effect."""
    unlabelled: list[str]
    """Attributes whose label is their column name."""
    undescribed: list[str]
    """Attributes without a description; ``""`` stands for the layer itself."""


class ProfileSummary(BaseModel):
    """How complete the metadata the model sees is (D11, V8)."""

    profile_hash: str
    layers: int
    attributes: int
    labelled: int
    text_attributes: int
    text_with_codes: int
    described: int
    """Layers and attributes with a description, out of ``layers + attributes``."""
    gaps: list[LayerGaps]
    """Layers with something missing; empty when complete."""


class PointLabel(BaseModel):
    """A measuring point as it was (H7): later edits change no run."""

    connection_id: int
    connection_name: str
    model: str
    host: str
    locality: Locality
    temperature: float
    reasoning_effort: Effort
    prompt_profile: PromptProfile
    level_id: int
    level_name: str
    system_prompt_hash: str
    system_prompt: str | None = None
    """The edited copy this run used (D10); ``None``: the level's own."""


class RunCase(BaseModel):
    """A case as the run asked it (H7): the matrix, V7 and the export read it
    here, not from the case store, which may have changed since."""

    id: str
    prompt: str
    tags: list[str]
    split: Split
    origin: Origin
    readings: list[dict[str, Any]] = []
    """The reference query or the fair readings; empty for other cases."""
    require: Require | None = None
    expect: AnswerKind | None = None
    status: CaseStatus = "ok"
    """``dataset_changed``: run, but its layer was re-imported since the case was made."""


class RunLabel(BaseModel):
    """What a run measured against (F-3.18): without it a figure is worthless
    after the next version change."""

    query_schema: str
    grading_version: int
    data_state: DataState
    sample_version: str | None
    """For ``sample``: the version of the packaged sample data."""
    dataset_versions: dict[str, str | None] = {}
    """For ``live``: each layer used, with its dataset version."""
    profile: ProfileSummary
    account: str
    """Whose view a live run used (D4)."""
    scope: RunScope
    seeds: list[int]
    cases: int
    case_set_hash: str
    """Over the ids and references of the cases: two runs with the same hash
    asked the same questions (V5.1 *Gegenüberstellen*)."""
    started_at: datetime
    started_by: str


class PointComparison(BaseModel):
    """One column against the reference column, paired per case (D7). Taken on
    the ``confirm`` cases; ``None`` in a quick test or without them."""

    cases: int
    better: int
    worse: int
    same: int
    mean: float
    """Mean difference of the per-case pass rate, in percentage points."""
    low: float
    high: float
    """The 95 % bootstrap interval of ``mean``."""
    p_sign: float
    word: Word


class Tally(BaseModel):
    passed: int
    answers: int


class PointFigures(BaseModel):
    """Section 2 of the plan, for one measuring point; counts are answers (a
    case counts once per repeat)."""

    passed: int
    answers: int
    """Over all cases of the run."""
    by_split: dict[Split, Tally]
    by_tag: dict[str, Tally]
    rate_tuning: float | None
    """Pass rate on the ``tuning`` cases, the column's headline (design review 1)."""
    rate_confirm: float | None
    silently_wrong: int
    zero_hits: int
    unreadable: int
    errors: dict[str, int] = {}
    """``error`` and ``refused`` answers by code."""
    behaviour_met: int
    behaviour_answers: int
    limited: int
    """Answers that ran into a limit (timeout, a query limit)."""
    latency_median_ms: int | None
    latency_p90_ms: int | None
    prompt_tokens: int
    completion_tokens: int
    cost: Money | None


class PointView(BaseModel):
    label: PointLabel
    figures: PointFigures | None
    """``None`` until the run is done (design review 5)."""
    comparison: PointComparison | None


class Cell(BaseModel):
    """One case at one measuring point: passes of the repeats and the rest's mix."""

    case_id: str
    point: int
    passed: int
    answers: int
    verdicts: dict[Verdict, int]
    silently_wrong: int


class Progress(BaseModel):
    done: int
    total: int


class RunView(BaseModel):
    id: int
    status: RunStatus
    request: RunRequest
    label: RunLabel
    cases: list[RunCase]
    points: list[PointView]
    reference: int
    progress: Progress
    cost_so_far: list[Money] = []
    cells: list[Cell]
    error: str | None = None
    """Why a ``failed`` run stopped, as a code (``no_cases``, a transport code)."""
    finished_at: datetime | None = None


class RunSummary(BaseModel):
    id: int
    status: RunStatus
    scope: RunScope
    data_state: DataState
    started_at: datetime
    started_by: str
    points: int
    connection_ids: list[int]
    """For "zuletzt bewertet" on the connections page (O7)."""
    cases: int
    case_set_hash: str
    reference_rate: float | None
    cost: list[Money] = []


class RunPage(BaseModel):
    items: list[RunSummary]
    total: int


class DiffEntry(BaseModel):
    """One difference of an answer's query to the reference (stage 1, D5): the
    two condition nodes, never data."""

    kind: DiffKind
    path: str
    """Where in the condition tree, e.g. ``where.args[1].where``."""
    reference: Any = None
    answer: Any = None


class AnswerView(BaseModel):
    """One answer of one repeat (V7). ``answer`` is the model's answer as read;
    rows never: the result sets are feature ids, capped at ``MAX_IDS``, with
    exact counts."""

    case_id: str
    point: int
    block: int
    seed: int
    verdict: Verdict
    code: str | None = None
    """For ``refused`` and ``error``: the code; for ``kind``: the kind given."""
    flags: list[Flag] = []
    latency_ms: int | None
    prompt_tokens: int | None
    completion_tokens: int | None
    answer: ModelAnswer | None
    refusal: Refusal | None = None
    raw: str | None = None
    """The verbatim text of an unreadable answer (V7.4)."""
    reading: int | None = None
    """The reading the diff and ``reference_hits`` refer to: the one passed, or
    the nearest; ``None`` for a case without readings."""
    diff: list[DiffEntry] | None = None
    """``None`` for a case without readings or an answer without a query."""
    hits: int | None = None
    reference_hits: int | None = None
    only_answer: list[int] = Field(default=[], max_length=MAX_IDS)
    only_answer_count: int = 0
    only_reference: list[int] = Field(default=[], max_length=MAX_IDS)
    only_reference_count: int = 0


class CompareRequest(BaseModel):
    """Two complete runs over the same cases, side by side (V6.6, D7)."""

    model_config = ConfigDict(extra="forbid")

    run: Id
    against: Id

    @model_validator(mode="after")
    def _two(self) -> Self:
        if self.run == self.against:
            raise ValueError("a run is compared with another run")
        return self


class RunComparisonRow(BaseModel):
    label: PointLabel
    rate: float | None
    rate_against: float | None
    comparison: PointComparison | None


class RunComparison(BaseModel):
    run: int
    against: int
    points: list[RunComparisonRow]
    """Measuring points present in both runs, matched by connection, prompt
    profile, level and system prompt hash."""


class RunExport(BaseModel):
    run: RunView
    answers: list[AnswerView]


CASE_FILE_SCHEMA_ID = (
    f"https://geotandem.local/schema/eval-cases/case-file-v{CASE_FILE_VERSION}.json"
)


def case_file_schema() -> dict[str, Any]:
    """The JSON schema of ``CaseFile``, the versioned artefact beside the start set.
    It is weaker than the model: "exactly one of", unique ids and the origin
    rules are the application's checks (``EvalCase``)."""
    schema = CaseFile.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = CASE_FILE_SCHEMA_ID
    return schema
