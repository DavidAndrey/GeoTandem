"""The runs of the evaluation in the data core (plan E3, D8, WP90).

One row per run (``eval_run``) and one per answer (``eval_answer``). A run's
status leaves ``running`` once, by a compare-and-set: ``done`` or ``failed``
from its thread, ``aborted`` from the abort route, ``interrupted`` from the
start-up check. An answer is stored only while its run is ``running``, in the
transaction that counts it, so an answer that arrives after an abort is
dropped. Nothing here holds a key, a prompt's layer profile or a row of the
data: answers carry feature ids and counts.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Engine, and_, func, or_, select, update
from sqlalchemy.orm import Session

from geotandem.connections import Price
from geotandem.db.orm import EvalAnswer, EvalRun
from geotandem.db.spatialite import reading
from geotandem.evaluation.figures import Scored
from geotandem.evaluation.schemas import (
    AnswerView,
    PointView,
    Progress,
    RunCase,
    RunLabel,
    RunRequest,
    RunStatus,
)
from geotandem.model.record.store import utc_now

EXPORT_BATCH = 500
"""Answers the export reads at a time (security review #46)."""


@dataclass(frozen=True)
class StoredRun:
    id: int
    status: RunStatus
    request: RunRequest
    label: RunLabel
    cases: list[RunCase]
    points: list[PointView]
    prices: list[Price | None]
    reference: int
    progress: Progress
    error: str | None
    finished_at: datetime | None

    @property
    def connection_ids(self) -> list[int]:
        return sorted({p.label.connection_id for p in self.points})


@dataclass(frozen=True)
class NewRun:
    request: RunRequest
    label: RunLabel
    cases: list[RunCase]
    points: list[PointView]
    prices: list[Price | None]
    total: int


def _price(data: dict[str, Any] | None) -> Price | None:
    return None if data is None else Price(**data)


def _stored(row: EvalRun) -> StoredRun:
    return StoredRun(
        id=row.id,
        status=row.status,  # type: ignore[arg-type]
        request=RunRequest.model_validate(row.request),
        label=RunLabel.model_validate(row.label),
        cases=[RunCase.model_validate(c) for c in row.cases],
        points=[PointView.model_validate(p) for p in row.points],
        prices=[_price(p) for p in row.prices],
        reference=row.reference,
        progress=Progress(done=row.progress_done, total=row.progress_total),
        error=row.error,
        finished_at=row.finished_at,
    )


def _dump(models: Sequence[Any]) -> list[Any]:
    return [m.model_dump(mode="json") for m in models]


def _answer_view(row: EvalAnswer) -> AnswerView:
    return AnswerView.model_validate(
        {
            "case_id": row.case_id,
            "point": row.point,
            "block": row.block,
            "seed": row.seed,
            "verdict": row.verdict,
            "code": row.code,
            "flags": row.flags,
            "latency_ms": row.latency_ms,
            "prompt_tokens": row.prompt_tokens,
            "completion_tokens": row.completion_tokens,
            "answer": row.answer,
            "refusal": row.refusal,
            "raw": row.raw,
            "reading": row.reading,
            "diff": row.diff,
            "hits": row.hits,
            "reference_hits": row.reference_hits,
            "only_answer": row.only_answer,
            "only_answer_count": row.only_answer_count,
            "only_reference": row.only_reference,
            "only_reference_count": row.only_reference_count,
        }
    )


class RunStore:
    def __init__(self, engine: Engine, clock: Callable[[], datetime] = utc_now) -> None:
        self.engine = engine
        self.clock = clock

    # --- runs ------------------------------------------------------------------

    def create(self, new: NewRun, *, started_by: str, started_at: datetime) -> int:
        connections = sorted({p.label.connection_id for p in new.points})
        row = EvalRun(
            status="running",
            scope=new.request.scope,
            data_state=new.request.data_state,
            request=new.request.model_dump(mode="json"),
            label=new.label.model_dump(mode="json"),
            cases=_dump(new.cases),
            points=_dump(new.points),
            prices=[None if p is None else p.as_json() for p in new.prices],
            connection_ids="," + ",".join(map(str, connections)) + ",",
            case_set_hash=new.label.case_set_hash,
            reference=new.request.reference,
            progress_done=0,
            progress_total=new.total,
            started_by=started_by,
            started_at=started_at,
        )
        with Session(self.engine) as db, db.begin():
            db.add(row)
            db.flush()
            return row.id

    def get(self, run_id: int) -> StoredRun | None:
        with Session(reading(self.engine)) as db:
            row = db.get(EvalRun, run_id)
            return _stored(row) if row else None

    def page(
        self, connection_id: int | None, offset: int, limit: int
    ) -> tuple[list[StoredRun], int]:
        """Newest first; with ``connection_id`` the runs that measured it (O7)."""
        stmt = select(EvalRun)
        if connection_id is not None:
            stmt = stmt.where(EvalRun.connection_ids.contains(f",{connection_id},"))
        with Session(reading(self.engine)) as db:
            total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
            rows = db.scalars(stmt.order_by(EvalRun.id.desc()).offset(offset).limit(limit))
            return [_stored(row) for row in rows], total

    def set_cases(self, run_id: int, cases: Sequence[RunCase], total: int, label: RunLabel) -> None:
        """The cases after their readings were read, with the total they leave
        and the label counted and hashed over the cases asked."""
        with Session(self.engine) as db, db.begin():
            db.execute(
                update(EvalRun)
                .where(EvalRun.id == run_id)
                .values(
                    cases=_dump(cases),
                    progress_total=total,
                    label=label.model_dump(mode="json"),
                    case_set_hash=label.case_set_hash,
                )
            )

    def _leave_running(self, run_id: int, **values: Any) -> bool:
        with Session(self.engine) as db, db.begin():
            done = db.execute(
                update(EvalRun)
                .where(EvalRun.id == run_id, EvalRun.status == "running")
                .values(finished_at=self.clock(), **values)
            )
            return bool(done.rowcount)  # type: ignore[attr-defined]

    def finish(
        self,
        run_id: int,
        status: RunStatus,
        *,
        points: Sequence[PointView] | None = None,
        error: str | None = None,
    ) -> bool:
        """``running`` → ``status``; ``False`` if it was not running any more."""
        values: dict[str, Any] = {"status": status, "error": error}
        if points is not None:
            values["points"] = _dump(points)
        return self._leave_running(run_id, **values)

    def close_running(self) -> list[int]:
        """The start-up check (D8): a ``running`` run has no thread left; it ends
        ``interrupted``, its answers kept."""
        with Session(self.engine) as db, db.begin():
            ids = list(db.scalars(select(EvalRun.id).where(EvalRun.status == "running")))
            if ids:
                db.execute(
                    update(EvalRun)
                    .where(EvalRun.id.in_(ids))
                    .values(status="interrupted", finished_at=self.clock())
                )
            return ids

    # --- answers ---------------------------------------------------------------

    def add_answer(self, run_id: int, connection_id: int, view: AnswerView) -> bool:
        """Store and count one answer while the run is ``running``; ``False``
        (nothing stored) once it is not."""
        row = EvalAnswer(
            run_id=run_id,
            connection_id=connection_id,
            silently_wrong=view.verdict == "wrong" and "no_assumption" in view.flags,
            **view.model_dump(mode="json", exclude={"flags"}),
            flags=list(view.flags),
        )
        with Session(self.engine) as db, db.begin():
            counted = db.execute(
                update(EvalRun)
                .where(EvalRun.id == run_id, EvalRun.status == "running")
                .values(progress_done=EvalRun.progress_done + 1)
            )
            if not counted.rowcount:  # type: ignore[attr-defined]
                return False
            db.add(row)
            return True

    def answers(
        self, run_id: int, case_id: str | None = None, point: int | None = None
    ) -> list[AnswerView]:
        """By point, then case (as stored), then seed."""
        stmt = select(EvalAnswer).where(EvalAnswer.run_id == run_id)
        if case_id is not None:
            stmt = stmt.where(EvalAnswer.case_id == case_id)
        if point is not None:
            stmt = stmt.where(EvalAnswer.point == point)
        stmt = stmt.order_by(EvalAnswer.point, EvalAnswer.id)
        with Session(reading(self.engine)) as db:
            return [_answer_view(row) for row in db.scalars(stmt)]

    def answer_batches(self, run_id: int, size: int = EXPORT_BATCH) -> Iterator[list[AnswerView]]:
        """Every answer of the run, ``size`` at a time in the order of
        ``answers``, each batch read on its own (the export streams them)."""
        after = (-1, 0)
        while True:
            stmt = (
                select(EvalAnswer)
                .where(
                    EvalAnswer.run_id == run_id,
                    or_(
                        EvalAnswer.point > after[0],
                        and_(EvalAnswer.point == after[0], EvalAnswer.id > after[1]),
                    ),
                )
                .order_by(EvalAnswer.point, EvalAnswer.id)
                .limit(size)
            )
            with Session(reading(self.engine)) as db:
                rows = list(db.scalars(stmt))
                batch = [_answer_view(row) for row in rows]
            if not batch:
                return
            yield batch
            after = (rows[-1].point, rows[-1].id)

    def scored(self, run_id: int) -> list[Scored]:
        """What the figures and cells need of every answer of the run."""
        stmt = (
            select(
                EvalAnswer.case_id,
                EvalAnswer.point,
                EvalAnswer.verdict,
                EvalAnswer.code,
                EvalAnswer.flags,
                EvalAnswer.latency_ms,
                EvalAnswer.prompt_tokens,
                EvalAnswer.completion_tokens,
            )
            .where(EvalAnswer.run_id == run_id)
            .order_by(EvalAnswer.id)
        )
        with Session(reading(self.engine)) as db:
            return [
                Scored(
                    case_id=r.case_id,
                    point=r.point,
                    verdict=r.verdict,
                    code=r.code,
                    flags=tuple(r.flags),
                    latency_ms=r.latency_ms,
                    prompt_tokens=r.prompt_tokens,
                    completion_tokens=r.completion_tokens,
                )
                for r in db.execute(stmt)
            ]

    def tokens(self, run_ids: Sequence[int]) -> dict[int, dict[int, tuple[int, int]]]:
        """Run → point → (prompt tokens, completion tokens) so far."""
        stmt = (
            select(
                EvalAnswer.run_id,
                EvalAnswer.point,
                func.coalesce(func.sum(EvalAnswer.prompt_tokens), 0),
                func.coalesce(func.sum(EvalAnswer.completion_tokens), 0),
            )
            .where(EvalAnswer.run_id.in_(list(run_ids)))
            .group_by(EvalAnswer.run_id, EvalAnswer.point)
        )
        found: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        with Session(reading(self.engine)) as db:
            for run_id, point, prompt, completion in db.execute(stmt):
                found[run_id][point] = (int(prompt), int(completion))
        return found

    def last_latencies(self, connection_id: int) -> list[int]:
        """The latencies of the connection's answers in its last run that has any (D12)."""
        with Session(reading(self.engine)) as db:
            last = db.scalar(
                select(func.max(EvalAnswer.run_id)).where(
                    EvalAnswer.connection_id == connection_id, EvalAnswer.latency_ms.is_not(None)
                )
            )
            if last is None:
                return []
            return [
                ms
                for ms in db.scalars(
                    select(EvalAnswer.latency_ms).where(
                        EvalAnswer.run_id == last,
                        EvalAnswer.connection_id == connection_id,
                        EvalAnswer.latency_ms.is_not(None),
                    )
                )
                if ms is not None
            ]
