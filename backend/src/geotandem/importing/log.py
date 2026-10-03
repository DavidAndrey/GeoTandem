"""Import log (F-2.10): every attempt, successful, failed or aborted (design D7, D8, D11).

Each entry is written in its own transaction, apart from the data it
describes, so a failed import still leaves its trace.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from geotandem.db.orm import ImportRun
from geotandem.importing.read import Message

REJECTED_SAMPLE_LIMIT = 1000

ImportMode = Literal["create", "replace"]
ImportStatus = Literal["running", "ok", "warning", "failed", "aborted"]


class Step(BaseModel):
    step: str
    ms: float


class RejectedRow(BaseModel):
    row: int
    """1-based record number in the source."""
    reason: str
    values: dict[str, Any]


class ImportRunSummary(BaseModel):
    id: int
    started_at: datetime
    finished_at: datetime | None
    actor: str | None
    source_name: str
    source_format: str
    layer_name: str | None
    mode: ImportMode
    status: ImportStatus
    read_count: int
    imported_count: int
    rejected_count: int


class ImportRunInfo(ImportRunSummary):
    decisions: dict[str, Any]
    warnings: list[Message]
    errors: list[Message]
    steps: list[Step]
    rejected_sample: list[RejectedRow]


def start(
    engine: Engine,
    *,
    source_name: str,
    source_format: str,
    mode: ImportMode,
    layer_name: str | None,
    actor: str | None,
    decisions: dict[str, Any] | None = None,
) -> int:
    with Session(engine) as session, session.begin():
        run = ImportRun(
            source_name=source_name,
            source_format=source_format,
            mode=mode,
            layer_name=layer_name,
            actor=actor,
            status="running",
            decisions=decisions or {},
        )
        session.add(run)
        session.flush()
        return run.id


def finish(
    engine: Engine,
    run_id: int,
    *,
    status: ImportStatus,
    read_count: int = 0,
    imported_count: int = 0,
    rejected: list[RejectedRow] | None = None,
    rejected_count: int | None = None,
    warnings: list[Message] | None = None,
    errors: list[Message] | None = None,
    steps: list[Step] | None = None,
    layer_name: str | None = None,
    decisions: dict[str, Any] | None = None,
) -> ImportRunInfo:
    rejected = rejected or []
    with Session(engine) as session, session.begin():
        run = session.get_one(ImportRun, run_id)
        run.status = status
        run.finished_at = session.scalar(select(func.current_timestamp()))
        run.read_count = read_count
        run.imported_count = imported_count
        run.rejected_count = len(rejected) if rejected_count is None else rejected_count
        run.rejected_sample = [r.model_dump(mode="json") for r in rejected[:REJECTED_SAMPLE_LIMIT]]
        run.warnings = [m.model_dump(mode="json") for m in warnings or []]
        run.errors = [m.model_dump(mode="json") for m in errors or []]
        run.steps = [s.model_dump(mode="json") for s in steps or []]
        if layer_name is not None:
            run.layer_name = layer_name
        if decisions is not None:
            run.decisions = decisions
        session.flush()
        return _info(run)


def get(engine: Engine, run_id: int) -> ImportRunInfo | None:
    with Session(engine) as session:
        run = session.get(ImportRun, run_id)
        return _info(run) if run else None


def recent(
    engine: Engine,
    *,
    status: ImportStatus | None = None,
    layer_name: str | None = None,
    limit: int = 200,
) -> list[ImportRunSummary]:
    stmt = select(ImportRun).order_by(ImportRun.id.desc()).limit(limit)
    if status is not None:
        stmt = stmt.where(ImportRun.status == status)
    if layer_name is not None:
        stmt = stmt.where(ImportRun.layer_name == layer_name)
    with Session(engine) as session:
        return [
            ImportRunSummary.model_validate(r, from_attributes=True) for r in session.scalars(stmt)
        ]


def last_per_layer(engine: Engine) -> dict[str, ImportRunSummary]:
    """The latest finished attempt per layer, for the catalog (design D2 "Letzter Import")."""
    latest = (
        select(func.max(ImportRun.id))
        .where(ImportRun.layer_name.is_not(None), ImportRun.status != "running")
        .group_by(ImportRun.layer_name)
    )
    with Session(engine) as session:
        runs = session.scalars(select(ImportRun).where(ImportRun.id.in_(latest)))
        return {
            r.layer_name: ImportRunSummary.model_validate(r, from_attributes=True)
            for r in runs
            if r.layer_name
        }


def fail_stale(engine: Engine) -> int:
    """Mark attempts left ``running`` by a crash or restart as failed."""
    with Session(engine) as session, session.begin():
        stale = list(session.scalars(select(ImportRun).where(ImportRun.status == "running")))
        for run in stale:
            run.status = "failed"
            run.errors = [
                Message(
                    code="interrupted", message="The application stopped during the import."
                ).model_dump()
            ]
        return len(stale)


def _info(run: ImportRun) -> ImportRunInfo:
    return ImportRunInfo.model_validate(run, from_attributes=True)
