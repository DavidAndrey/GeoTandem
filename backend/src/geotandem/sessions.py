"""Analysis sessions: save and reopen the analysis state by name (F-4.10, plan E1.7).

A session stores three things (plan E1.7, S5): the frontend's analysis state
as versioned JSON, opaque here apart from its size; the result query object,
validated like any query; and the result stamp computed from that query when
it was saved. Reopening runs the query again and compares stamps — the proof
that a result is reproducible without a model (F-8.9).

Sessions are private (design decision 2): every function takes the owner, and
another owner's session is simply not found.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from geotandem.catalog import list_layers
from geotandem.data import DataBackend
from geotandem.db.orm import AnalysisSession
from geotandem.db.spatialite import reading
from geotandem.engine import QueryError, ResultStamp
from geotandem_query import QueryObject, query_hash

MAX_STATE_BYTES = 1_000_000
"""Protects the data file, e.g. from a drawn polygon with a million vertices (plan D10)."""

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Note = Annotated[str, StringConstraints(max_length=2000)]


class SessionError(Exception):
    """A rule about sessions was violated; ``code`` is stable for the UI."""

    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class SessionWrite(BaseModel):
    """What the interface saves: the whole analysis state and its result query."""

    name: Name
    note: Note = ""
    state_version: Annotated[int, Field(ge=1)]
    state: dict[str, Any] = Field(description="The frontend's analysis state, versioned.")
    query: QueryObject | None = Field(
        default=None, description="The result query object; null without a result layer."
    )


class SessionRename(BaseModel):
    name: Name | None = None
    note: Note | None = None


class SessionStamp(ResultStamp):
    stamped_at: datetime


class SessionSummary(BaseModel):
    id: str
    name: str
    note: str
    result_layer: str | None
    stamp: SessionStamp | None
    data_changed: bool = Field(
        description="A layer of the stamp has a new version or is gone (design C3 'Daten neu')."
    )
    created_at: datetime
    updated_at: datetime
    opened_at: datetime | None


class SessionDetail(SessionSummary):
    state_version: int
    state: dict[str, Any]
    query: QueryObject | None


class Check(BaseModel):
    """The saved stamp against the current data (design C4, C8)."""

    identical: bool = Field(description="Same features as when saved.")
    saved: SessionStamp | None
    current: ResultStamp | None
    changed_layers: list[str] = Field(description="Layers with a new dataset version.")
    missing_layers: list[str] = Field(description="Layers deleted or no longer visible.")
    error: str | None = Field(default=None, description="Why the query no longer runs.")
    state_matches: bool | None = Field(
        default=None,
        description="The query rebuilt from the saved state is the saved query; "
        "null when none was sent.",
    )


class CheckRequest(BaseModel):
    rebuilt: QueryObject | None = Field(
        default=None, description="The result query the interface rebuilt from the state."
    )
    has_result: bool = Field(
        default=False, description="Whether the interface rebuilt a result at all."
    )


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _check_size(state: dict[str, Any]) -> None:
    size = len(json.dumps(state, separators=(",", ":")).encode())
    if size > MAX_STATE_BYTES:
        raise SessionError(
            413,
            "state_too_large",
            f"The analysis state has {size} bytes; at most {MAX_STATE_BYTES} can be saved.",
            size=size,
            max_bytes=MAX_STATE_BYTES,
        )


def _versions(backend: DataBackend) -> dict[str, str | None]:
    """Current dataset version of every layer the account may see."""
    layers = list_layers(backend.engine, only=backend.layer_names())
    return {layer.name: layer.dataset_version for layer in layers}


def _stamp(row: AnalysisSession) -> SessionStamp | None:
    if row.stamp is None or row.stamped_at is None:
        return None
    return SessionStamp(**row.stamp, stamped_at=row.stamped_at)


def _changed(stamp: SessionStamp | None, versions: dict[str, str | None]) -> list[str]:
    if stamp is None:
        return []
    return [
        name
        for name, version in stamp.data_versions.items()
        if name in versions and versions[name] != version
    ]


def _missing(stamp: SessionStamp | None, versions: dict[str, str | None]) -> list[str]:
    if stamp is None:
        return []
    return [name for name in stamp.data_versions if name not in versions]


def _summary(row: AnalysisSession, versions: dict[str, str | None]) -> SessionSummary:
    stamp = _stamp(row)
    return SessionSummary(
        id=row.id,
        name=row.name,
        note=row.note,
        result_layer=(row.query or {}).get("source"),
        stamp=stamp,
        data_changed=bool(_changed(stamp, versions) or _missing(stamp, versions)),
        created_at=row.created_at,
        updated_at=row.updated_at,
        opened_at=row.opened_at,
    )


def _detail(row: AnalysisSession, versions: dict[str, str | None]) -> SessionDetail:
    return SessionDetail(
        **_summary(row, versions).model_dump(),
        state_version=row.state_version,
        state=row.state,
        query=QueryObject.model_validate(row.query) if row.query is not None else None,
    )


def _get(db: Session, owner: int, session_id: str) -> AnalysisSession:
    row = db.get(AnalysisSession, session_id)
    if row is None or row.owner_id != owner:
        # Another owner's session does not exist for this one (design decision 2).
        raise SessionError(404, "not_found", f"No session '{session_id}'.", session=session_id)
    return row


def _ensure_free(db: Session, owner: int, name: str, keep: str | None = None) -> None:
    existing = db.scalar(
        select(AnalysisSession).where(
            AnalysisSession.owner_id == owner, AnalysisSession.name == name
        )
    )
    if existing is not None and existing.id != keep:
        raise SessionError(
            409, "name_taken", f"A session named '{name}' exists already.", existing=existing.id
        )


def _apply(row: AnalysisSession, body: SessionWrite, stamp: ResultStamp | None) -> None:
    _check_size(body.state)
    row.name = body.name
    row.note = body.note
    row.state_version = body.state_version
    row.state = body.state
    row.query = body.query.model_dump(mode="json", by_alias=True) if body.query else None
    row.stamp = stamp.model_dump(mode="json") if stamp else None
    row.stamped_at = _now() if stamp else None
    row.updated_at = _now()


def list_sessions(engine: Engine, owner: int, backend: DataBackend) -> list[SessionSummary]:
    versions = _versions(backend)
    with Session(reading(engine), expire_on_commit=False) as db:
        rows = db.scalars(
            select(AnalysisSession)
            .where(AnalysisSession.owner_id == owner)
            .order_by(AnalysisSession.updated_at.desc(), AnalysisSession.name)
        )
        return [_summary(row, versions) for row in rows]


def get(engine: Engine, owner: int, session_id: str, backend: DataBackend) -> SessionDetail:
    versions = _versions(backend)
    with Session(reading(engine), expire_on_commit=False) as db:
        return _detail(_get(db, owner, session_id), versions)


def last_opened(engine: Engine, owner: int, backend: DataBackend) -> SessionDetail | None:
    """The session to land in after sign-in (design A2, plan D7)."""
    versions = _versions(backend)
    with Session(reading(engine), expire_on_commit=False) as db:
        row = db.scalar(
            select(AnalysisSession)
            .where(AnalysisSession.owner_id == owner)
            .order_by(func.coalesce(AnalysisSession.opened_at, AnalysisSession.updated_at).desc())
            .limit(1)
        )
        return _detail(row, versions) if row else None


def _ensure_room(db: Session, owner: int, limit: int) -> None:
    """At most ``limit`` sessions per account, so no one fills the disk (security review #6).

    Counted in the transaction that adds, which begins IMMEDIATE: two saves at
    once cannot both pass.
    """
    count = db.scalar(
        select(func.count()).select_from(AnalysisSession).where(AnalysisSession.owner_id == owner)
    )
    if count is not None and count >= limit:
        raise SessionError(
            409,
            "too_many_sessions",
            f"You have {count} saved sessions, the most allowed. Delete one first.",
            max=limit,
        )


def create(
    engine: Engine,
    owner: int,
    body: SessionWrite,
    stamp: ResultStamp | None,
    backend: DataBackend,
    *,
    limit: int,
) -> SessionDetail:
    versions = _versions(backend)
    with Session(engine, expire_on_commit=False) as db:
        _ensure_room(db, owner, limit)
        _ensure_free(db, owner, body.name)
        row = AnalysisSession(id=secrets.token_urlsafe(8), owner_id=owner, opened_at=_now())
        _apply(row, body, stamp)
        db.add(row)
        db.commit()
        return _detail(row, versions)


def save(
    engine: Engine,
    owner: int,
    session_id: str,
    body: SessionWrite,
    stamp: ResultStamp | None,
    backend: DataBackend,
) -> SessionDetail:
    """Overwrite a session with the current state ("Speichern")."""
    versions = _versions(backend)
    with Session(engine, expire_on_commit=False) as db:
        row = _get(db, owner, session_id)
        _ensure_free(db, owner, body.name, keep=row.id)
        _apply(row, body, stamp)
        db.commit()
        return _detail(row, versions)


def rename(
    engine: Engine, owner: int, session_id: str, body: SessionRename, backend: DataBackend
) -> SessionSummary:
    versions = _versions(backend)
    with Session(engine, expire_on_commit=False) as db:
        row = _get(db, owner, session_id)
        if body.name is not None:
            _ensure_free(db, owner, body.name, keep=row.id)
            row.name = body.name
        if body.note is not None:
            row.note = body.note
        row.updated_at = _now()
        db.commit()
        return _summary(row, versions)


def duplicate(
    engine: Engine, owner: int, session_id: str, backend: DataBackend, *, limit: int
) -> SessionSummary:
    versions = _versions(backend)
    with Session(engine, expire_on_commit=False) as db:
        source = _get(db, owner, session_id)
        _ensure_room(db, owner, limit)
        taken = set(
            db.scalars(select(AnalysisSession.name).where(AnalysisSession.owner_id == owner))
        )
        name = f"{source.name} (Kopie)"[:120]
        for n in range(2, 1000):
            if name not in taken:
                break
            name = f"{source.name} (Kopie {n})"[-120:]
        copy = AnalysisSession(
            id=secrets.token_urlsafe(8),
            owner_id=owner,
            name=name,
            note=source.note,
            state_version=source.state_version,
            state=source.state,
            query=source.query,
            stamp=source.stamp,
            stamped_at=source.stamped_at,
        )
        db.add(copy)
        db.commit()
        return _summary(copy, versions)


def delete(engine: Engine, owner: int, session_id: str) -> None:
    with Session(engine, expire_on_commit=False) as db:
        db.delete(_get(db, owner, session_id))
        db.commit()


def check(
    engine: Engine,
    owner: int,
    session_id: str,
    backend: DataBackend,
    stamp_of: Callable[[QueryObject], ResultStamp],
    request: CheckRequest | None = None,
) -> Check:
    """Run the saved query again and compare with the saved stamp (design C4, C8).

    ``stamp_of`` stamps a query under the caller's limits and view. Opening a
    session is this check, so it also records the opening (plan D7).
    """
    versions = _versions(backend)
    with Session(engine, expire_on_commit=False) as db:
        row = _get(db, owner, session_id)
        row.opened_at = _now()
        db.commit()
        saved = _stamp(row)
        query = QueryObject.model_validate(row.query) if row.query is not None else None
    missing = _missing(saved, versions)
    if query is not None and query.source not in versions and query.source not in missing:
        missing.insert(0, query.source)
    changed = _changed(saved, versions)
    result = _compare(query, saved, versions, missing, changed, stamp_of)
    if request is not None:
        rebuilt = request.rebuilt if request.has_result else None
        same_presence = (rebuilt is None) == (query is None)
        result.state_matches = same_presence and (
            rebuilt is None or query is None or query_hash(rebuilt) == query_hash(query)
        )
    return result


def _compare(
    query: QueryObject | None,
    saved: SessionStamp | None,
    versions: dict[str, str | None],
    missing: list[str],
    changed: list[str],
    stamp_of: Callable[[QueryObject], ResultStamp],
) -> Check:
    if query is None:
        return Check(
            identical=saved is None,
            saved=saved,
            current=None,
            changed_layers=[],
            missing_layers=[],
        )
    if missing:
        return Check(
            identical=False,
            saved=saved,
            current=None,
            changed_layers=changed,
            missing_layers=missing,
        )
    try:
        current: ResultStamp = stamp_of(query)
    except QueryError as exc:
        return Check(
            identical=False,
            saved=saved,
            current=None,
            changed_layers=changed,
            missing_layers=[],
            error=exc.message,
        )
    identical = saved is not None and (
        (saved.count, saved.ids_hash) == (current.count, current.ids_hash)
    )
    return Check(
        identical=identical,
        saved=saved,
        current=current,
        changed_layers=changed,
        missing_layers=[],
    )
