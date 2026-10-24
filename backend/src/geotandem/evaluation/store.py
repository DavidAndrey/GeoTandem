"""The own cases in the data core (plan E3, D2, WP87).

One row per case (``eval_case``); the start set is never stored, it stays the
files of ``schema/eval-cases`` (``evaluation/cases.py``). A case is kept as
the case file writes it: the fields it was given, without ``null``, so an
export gives back what was stored (F-3.13). The rules a case must meet are
checked before it gets here (``cases.py``); the store keeps ids unique and
the number of cases within the limit it is given, both inside the transaction
that stores them, so two requests at once cannot pass either together.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Engine, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geotandem.db.orm import OwnCase
from geotandem.db.spatialite import reading
from geotandem.evaluation.schemas import DataState, EvalCase, Origin, Split
from geotandem.model.record.store import utc_now


@dataclass(frozen=True)
class StoredCase:
    case: EvalCase
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class CaseFilters:
    """The filters of ``GET /cases``; ``None`` is any."""

    split: Split | None = None
    tag: str | None = None
    origin: Origin | None = None
    data_state: DataState | None = None

    def admits(self, case: EvalCase) -> bool:
        return (
            (self.split is None or case.split == self.split)
            and (self.tag is None or self.tag in case.tags)
            and (self.origin is None or case.origin == self.origin)
            and (self.data_state is None or case.data_state == self.data_state)
        )


class CaseIdTaken(Exception):
    """Another own case has the id (``args[0]``; ``None`` when a request in
    between took one of several)."""


class TooManyCases(Exception):
    """Storing would hold more own cases than allowed; ``args``: held, allowed."""


def body_of(case: EvalCase) -> dict[str, Any]:
    """The case as the case file writes it: the fields it was given, no ``null``."""
    body: dict[str, Any] = case.model_dump(mode="json", exclude_unset=True, exclude_none=True)
    return body


def _stored(row: OwnCase) -> StoredCase:
    return StoredCase(
        case=EvalCase.model_validate(row.body),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class CaseStore:
    def __init__(self, engine: Engine, clock: Callable[[], datetime] = utc_now) -> None:
        self.engine = engine
        self.clock = clock

    def cases(self, filters: CaseFilters | None = None) -> list[StoredCase]:
        """Oldest first. Split, origin and data state are filtered in the
        query, a tag on the case (at most ``MAX_CASES`` of them)."""
        filters = filters or CaseFilters()
        stmt = select(OwnCase).order_by(OwnCase.id)
        if filters.split is not None:
            stmt = stmt.where(OwnCase.split == filters.split)
        if filters.origin is not None:
            stmt = stmt.where(OwnCase.origin == filters.origin)
        if filters.data_state is not None:
            stmt = stmt.where(OwnCase.data_state == filters.data_state)
        with Session(reading(self.engine)) as db:
            found = [_stored(row) for row in db.scalars(stmt)]
        return [s for s in found if filters.admits(s.case)]

    def get(self, case_id: str) -> StoredCase | None:
        with Session(reading(self.engine)) as db:
            row = db.scalar(select(OwnCase).where(OwnCase.case_id == case_id))
            return _stored(row) if row else None

    def ids(self) -> set[str]:
        with Session(reading(self.engine)) as db:
            return set(db.scalars(select(OwnCase.case_id)))

    def add(self, cases: Iterable[EvalCase], *, at_most: int) -> list[StoredCase]:
        """All in one transaction: one id in use and none is stored
        (``CaseIdTaken``), nor any when more than ``at_most`` own cases would
        be held (``TooManyCases``)."""
        now = self.clock()
        rows = [
            OwnCase(
                case_id=case.id,
                split=case.split,
                origin=case.origin,
                data_state=case.data_state,
                body=body_of(case),
                created_at=now,
                updated_at=now,
            )
            for case in cases
        ]
        try:
            with Session(self.engine) as db, db.begin():
                held = db.scalar(select(func.count()).select_from(OwnCase)) or 0
                if held + len(rows) > at_most:
                    raise TooManyCases(held, at_most)
                taken = db.scalar(
                    select(OwnCase.case_id).where(OwnCase.case_id.in_([r.case_id for r in rows]))
                )
                if taken is not None:
                    raise CaseIdTaken(taken)
                db.add_all(rows)
                db.flush()
                return [_stored(row) for row in rows]
        except IntegrityError:
            # Another request stored the id between the check and the insert.
            raise CaseIdTaken(rows[0].case_id if len(rows) == 1 else None) from None

    def replace(self, case_id: str, case: EvalCase) -> StoredCase | None:
        """The case ``case_id`` becomes ``case``, its id too; ``None`` if there is
        none, ``CaseIdTaken`` if the new id is another case's."""
        try:
            with Session(self.engine) as db, db.begin():
                row = db.scalar(select(OwnCase).where(OwnCase.case_id == case_id))
                if row is None:
                    return None
                if case.id != case_id and db.scalar(
                    select(OwnCase.id).where(OwnCase.case_id == case.id)
                ):
                    raise CaseIdTaken(case.id)
                row.case_id = case.id
                row.split = case.split
                row.origin = case.origin
                row.data_state = case.data_state
                row.body = body_of(case)
                row.updated_at = self.clock()
                db.flush()
                return _stored(row)
        except IntegrityError:
            raise CaseIdTaken(case.id) from None

    def delete(self, case_id: str) -> bool:
        with Session(self.engine) as db, db.begin():
            done = db.execute(delete(OwnCase).where(OwnCase.case_id == case_id))
            return bool(done.rowcount)  # type: ignore[attr-defined]
