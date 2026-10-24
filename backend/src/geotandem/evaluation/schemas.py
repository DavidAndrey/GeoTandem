"""The contract of the evaluation, frozen in WP85 (plan E3, sections 1, 2 and 6).

Three groups:

- ``EvalCase`` and ``CaseFile`` are the case format (D2): the harness's case
  as four testplans used it, plus split, data state and origin. The start set
  in ``schema/eval-cases/`` and every export and import use it; its JSON
  schema is written by ``geotandem schema export``.
- Requests and views are the HTTP interface under ``/api/admin/evaluation``;
  the frontend's types are generated from them (``make gen``).
- The literals name verdicts, flags and comparison words, so the grader, the
  matrix and the interface's words stay one list.

A run is a measurement, not use (D8): nothing here is a model action, and no
view carries rows. An answer's result sets are feature ids, capped.
"""

from datetime import datetime
from typing import Annotated, Any, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from geotandem.levels.model import MAX_SYSTEM_PROMPT
from geotandem.llm import Locality
from geotandem.model.schemas import MAX_PROMPT, Approach, PromptProfile, Refusal

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

CaseId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9.-]{0,62}$")]
"""As the harness names its cases (``doc1-primar-koeniz``, ``h31-naehe-wovon``)."""
Tag = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9:-]{0,31}$")]

Split = Literal["tuning", "confirm"]
"""*Abstimmung*: prompts may be tuned on it; *Bestätigung*: only to confirm (D2)."""
DataState = Literal["sample", "live"]
"""*Beispieldaten*, an isolated copy of the packaged sample, or *Betriebsdaten*,
the live catalog in the starting administrator's view (D1, D4)."""
Origin = Literal["start", "authored", "import", "log"]
"""Shipped with the application, saved from the workplace, imported, or taken
from the model log (``origin_action``)."""
AnswerKind = Literal["query", "clarification", "cannot_answer"]

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
RunStatus = Literal["running", "done", "aborted", "interrupted"]
Word = Literal["better", "worse", "not_proven"]
"""*besser*, *schlechter*, *nicht belegt*: the 95 % interval of the paired
difference lies above 0, below 0, or contains it (D7)."""
EvalErrorCode = Literal[
    "case_invalid",
    "case_id_taken",
    "case_read_only",
    "case_stale",
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

    name: str
    dataset_version: str | None = None


class EvalCase(BaseModel):
    """One question with its right answer (F-3.13, D2). Exactly one of ``gold``,
    ``gold_any``, ``require`` and ``expect``: a query case has a reference
    query, several fair readings or required parts; a behaviour case names the
    expected answer kind. A reference query is stored as the harness writes it,
    without ``schema_version`` and ``output``, against ``schema_version``.

    ``other_approach`` counts only when set: present and ``null`` means the
    answer must not offer the other approach (export keeps unset fields out)."""

    model_config = ConfigDict(extra="forbid")

    id: CaseId
    prompt: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PROMPT)
    ]
    tags: list[Tag] = Field(min_length=1, max_length=MAX_TAGS)
    split: Split
    data_state: DataState = "sample"
    origin: Origin = "start"
    origin_action: int | None = None
    """The model action a ``log`` case was taken from (F-3.14)."""
    schema_version: str = "2"
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
    other_approach: Approach | None = None
    note: str = ""
    """The question's intent, for the person who judges a difference."""
    layers: list[CaseLayer] = []
    """For a live case: the layers its reference uses (D3)."""

    @model_validator(mode="after")
    def _one_answer(self) -> Self:
        given = [k for k in ("gold", "gold_any", "require", "expect") if getattr(self, k)]
        if len(given) != 1:
            raise ValueError(
                f"exactly one of gold, gold_any, require, expect; got {given or 'none'}"
            )
        if (self.origin == "log") != (self.origin_action is not None):
            raise ValueError("origin_action goes with origin 'log', and only with it")
        if self.data_state == "live" and not self.layers and self.expect is None:
            raise ValueError("a live query case names the layers it uses")
        return self


class CaseFile(BaseModel):
    """The start set, an export, an import: the same JSON (F-10.4)."""

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
    read_only: bool
    """A start case: copied, never edited (V2.3)."""
    reference_hits: int | None = None
    """Features of the reference on its data state; ``None`` for a behaviour case
    or a stale one, and in a list (only the detail computes it)."""
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

    connection_id: int
    prompt_profile: PromptProfile | None = None
    """``None``: the connection's own profile."""
    level_id: int
    system_prompt: Annotated[str, StringConstraints(max_length=MAX_SYSTEM_PROMPT)] | None = None
    """An edited copy of the level's system prompt for this run only (D10)."""


class CaseFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: bool = True
    own: bool = False
    split: Split | None = None
    """``None``: both."""
    tags: list[Tag] = []
    """Any of them; empty: all."""


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    points: list[MeasuringPoint] = Field(min_length=1, max_length=MAX_POINTS)
    reference: int = 0
    """Index of the point the others are compared with (D7)."""
    cases: CaseFilter = CaseFilter()
    data_state: DataState = "sample"
    scope: RunScope = "full"
    confirm_external: list[int] = []
    """Ids of the external connections the administrator confirmed sending to
    (F-9.4, D12); a run with an external connection not listed is refused."""

    @model_validator(mode="after")
    def _reference_exists(self) -> Self:
        if not 0 <= self.reference < len(self.points):
            raise ValueError("reference must name one of the points")
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
    """What a layer lacks, in the order of care of Phase 4 (D11)."""

    layer: str
    title: str
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
    reasoning_effort: str
    prompt_profile: PromptProfile
    level_name: str
    system_prompt_hash: str
    system_prompt_edited: bool


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
    split: Split | None
    tags: list[str]
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


class PointFigures(BaseModel):
    """Section 2 of the plan, for one measuring point."""

    passed: int
    answers: int
    rate_tuning: float | None
    """Pass rate on the ``tuning`` cases, the column's headline (design review 1)."""
    silently_wrong: int
    zero_hits: int
    unreadable: int
    errors: dict[str, int] = {}
    """``error`` and ``refused`` answers by code."""
    behaviour_met: int
    behaviour_cases: int
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
    label: RunLabel
    points: list[PointView]
    reference: int
    progress: Progress
    cost_so_far: list[Money] = []
    cells: list[Cell]
    finished_at: datetime | None = None


class RunSummary(BaseModel):
    id: int
    status: RunStatus
    scope: RunScope
    data_state: DataState
    started_at: datetime
    started_by: str
    points: int
    cases: int
    reference_rate: float | None
    cost: list[Money] = []


class RunPage(BaseModel):
    items: list[RunSummary]
    total: int


class DiffEntry(BaseModel):
    """One difference of an answer's query to the reference (stage 1, D5)."""

    kind: DiffKind
    path: str
    """Where in the condition tree, e.g. ``where.args[1].where``."""
    reference: Any = None
    answer: Any = None


class AnswerView(BaseModel):
    """One answer of one repeat (V7). ``answer`` is the model's answer as read;
    rows never: the result sets are feature ids, capped at ``MAX_IDS``."""

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
    answer: dict[str, Any] | None
    refusal: Refusal | None = None
    raw: str | None = None
    """The verbatim text of an unreadable answer (V7.4)."""
    diff: list[DiffEntry] | None = None
    """``None`` for a behaviour case or an answer without a query."""
    hits: int | None = None
    reference_hits: int | None = None
    only_answer: list[int] = []
    only_reference: list[int] = []


class CompareRequest(BaseModel):
    """Two complete runs over the same cases, side by side (V6.6, D7)."""

    model_config = ConfigDict(extra="forbid")

    run: int
    against: int


class RunComparisonRow(BaseModel):
    label: PointLabel
    rate: float | None
    rate_against: float | None
    comparison: PointComparison | None


class RunComparison(BaseModel):
    run: int
    against: int
    rows: list[RunComparisonRow]
    """Measuring points present in both runs, matched by connection, prompt
    profile, level and system prompt hash."""


class RunExport(BaseModel):
    run: RunView
    answers: list[AnswerView]


CASE_FILE_SCHEMA_ID = (
    f"https://geotandem.local/schema/eval-cases/case-file-v{CASE_FILE_VERSION}.json"
)


def case_file_schema() -> dict[str, Any]:
    """The JSON schema of ``CaseFile``, the versioned artefact beside the start set."""
    schema = CaseFile.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = CASE_FILE_SCHEMA_ID
    return schema
