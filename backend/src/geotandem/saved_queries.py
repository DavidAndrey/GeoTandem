"""Saved queries: a result layer with its conditions, by name, shareable (plan E1.7b).

A saved query stores, like a session (plan E1.7, S5), the query part of the
analysis state as versioned JSON, opaque here, and the result query object,
validated like any query. Unlike a session it can be **shared**: readable by
every account that sees all its layers (Q4), changeable only by its owner;
anyone else saves a copy (design C6).
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import Engine, func, or_, select
from sqlalchemy.orm import Session, contains_eager

from geotandem.data import DataBackend
from geotandem.db.orm import AnalysisSession, SavedQuery
from geotandem.db.spatialite import reading
from geotandem_query import QueryObject
from geotandem_query import models as m

MAX_STATE_BYTES = 200_000
"""A query's state is a condition tree and a restriction; far below a session's."""

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class SavedQueryError(Exception):
    """A rule about saved queries was violated; ``code`` is stable for the UI."""

    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class SavedQueryWrite(BaseModel):
    name: Name
    shared: bool = False
    state_version: Annotated[int, Field(ge=1)]
    state: dict[str, Any] = Field(description="Result layer, condition tree, restriction.")
    query: QueryObject = Field(description="The result query object.")


class SavedQueryPatch(BaseModel):
    name: Name | None = None
    shared: bool | None = None


class Conditions(BaseModel):
    """Leaf conditions of the query, as design C6 shows them ("1 A · 2 R")."""

    attribute: int
    spatial: int
    restriction: bool


class SavedQuerySummary(BaseModel):
    id: str
    name: str
    owner: str
    mine: bool
    shared: bool
    result_layer: str
    conditions: Conditions
    query: QueryObject = Field(description="The result query object, e.g. to count its hits.")
    created_at: datetime
    updated_at: datetime


class SavedQueryDetail(SavedQuerySummary):
    state_version: int
    state: dict[str, Any]


class Usage(BaseModel):
    sessions: int = Field(description="Sessions of any account that refer to this query.")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def conditions(query: QueryObject) -> Conditions:
    attribute = spatial = 0
    restriction = False

    def walk(c: m.Condition) -> None:
        nonlocal attribute, spatial, restriction
        match c:
            case m.And() | m.Or():
                for arg in c.args:
                    walk(arg)
            case m.Not():
                walk(c.arg)
            case m.RelatedTopological() | m.RelatedByDistance() | m.NearFeature():
                spatial += 1
            case m.BBox() | m.GeometryFilter():
                restriction = True
            case _:
                attribute += 1

    if query.where is not None:
        walk(query.where)
    return Conditions(attribute=attribute, spatial=spatial, restriction=restriction)


def _check(body: SavedQueryWrite) -> None:
    q = body.query
    if q.buffer or q.attribute_join or q.aggregate or q.spatial_relation:
        # Plan E1.7b, Q2: a derived result would need its recipe too.
        raise SavedQueryError(
            400,
            "conditions_only",
            "A saved query is a layer with conditions; buffer, join and aggregation "
            "belong to derived layers and cannot be saved with it.",
        )
    size = len(json.dumps(body.state, separators=(",", ":")).encode())
    if size > MAX_STATE_BYTES:
        raise SavedQueryError(
            413,
            "state_too_large",
            f"The query state has {size} bytes; at most {MAX_STATE_BYTES} can be saved.",
            size=size,
            max_bytes=MAX_STATE_BYTES,
        )


def _summary(row: SavedQuery, viewer: int) -> SavedQuerySummary:
    query = QueryObject.model_validate(row.query)
    return SavedQuerySummary(
        id=row.id,
        name=row.name,
        owner=row.owner.display_name or row.owner.username,
        mine=row.owner_id == viewer,
        shared=row.shared,
        result_layer=query.source,
        conditions=conditions(query),
        query=query,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _detail(row: SavedQuery, viewer: int) -> SavedQueryDetail:
    return SavedQueryDetail(
        **_summary(row, viewer).model_dump(),
        state_version=row.state_version,
        state=row.state,
    )


def _readable(row: SavedQuery | None, viewer: int, visible: set[str]) -> bool:
    if row is None:
        return False
    if row.owner_id == viewer:
        return True
    return row.shared and set(row.layers) <= visible


def _get(db: Session, query_id: str, viewer: int, visible: set[str]) -> SavedQuery:
    row = db.get(SavedQuery, query_id)
    if not _readable(row, viewer, visible):
        # Neither someone else's private query nor a shared one on hidden layers exists (Q4).
        raise SavedQueryError(404, "not_found", f"No saved query '{query_id}'.", query=query_id)
    assert row is not None
    return row


def _own(db: Session, query_id: str, viewer: int, visible: set[str]) -> SavedQuery:
    row = _get(db, query_id, viewer, visible)
    if row.owner_id != viewer:
        raise SavedQueryError(
            403,
            "not_owner",
            "Only its owner changes a shared query; save a copy instead.",
            query=query_id,
        )
    return row


def _ensure_free(db: Session, owner: int, name: str, keep: str | None = None) -> None:
    existing = db.scalar(
        select(SavedQuery).where(SavedQuery.owner_id == owner, SavedQuery.name == name)
    )
    if existing is not None and existing.id != keep:
        raise SavedQueryError(
            409, "name_taken", f"A query named '{name}' exists already.", existing=existing.id
        )


def _free_name(db: Session, owner: int, name: str) -> str:
    taken = set(db.scalars(select(SavedQuery.name).where(SavedQuery.owner_id == owner)))
    candidate = name
    for n in range(1, 1000):
        if candidate not in taken:
            return candidate
        suffix = " (Kopie)" if n == 1 else f" (Kopie {n})"
        candidate = name[: 120 - len(suffix)] + suffix
    return f"{name[:100]} {secrets.token_hex(4)}"


def list_queries(engine: Engine, viewer: int, backend: DataBackend) -> list[SavedQuerySummary]:
    visible = set(backend.layer_names())
    with Session(reading(engine)) as db:
        rows = db.scalars(
            select(SavedQuery)
            .where(or_(SavedQuery.owner_id == viewer, SavedQuery.shared.is_(True)))
            .join(SavedQuery.owner)
            .options(contains_eager(SavedQuery.owner))  # one query, not one per owner
            .order_by(SavedQuery.name)
        )
        return [_summary(row, viewer) for row in rows if _readable(row, viewer, visible)]


def get(engine: Engine, viewer: int, query_id: str, backend: DataBackend) -> SavedQueryDetail:
    visible = set(backend.layer_names())
    with Session(reading(engine)) as db:
        return _detail(_get(db, query_id, viewer, visible), viewer)


def create(
    engine: Engine, owner: int, body: SavedQueryWrite, layers: list[str]
) -> SavedQueryDetail:
    """``layers`` come from compiling ``body.query`` under the owner's view."""
    _check(body)
    with Session(engine, expire_on_commit=False) as db:
        _ensure_free(db, owner, body.name)
        row = SavedQuery(
            id=secrets.token_urlsafe(8),
            owner_id=owner,
            name=body.name,
            shared=body.shared,
            state_version=body.state_version,
            state=body.state,
            query=body.query.model_dump(mode="json", by_alias=True),
            layers=layers,
        )
        db.add(row)
        db.commit()
        db.refresh(row, ["owner", "created_at", "updated_at"])
        return _detail(row, owner)


def save(
    engine: Engine,
    owner: int,
    query_id: str,
    body: SavedQueryWrite,
    layers: list[str],
    backend: DataBackend,
) -> SavedQueryDetail:
    _check(body)
    visible = set(backend.layer_names())
    with Session(engine, expire_on_commit=False) as db:
        row = _own(db, query_id, owner, visible)
        _ensure_free(db, owner, body.name, keep=row.id)
        row.name = body.name
        row.shared = body.shared
        row.state_version = body.state_version
        row.state = body.state
        row.query = body.query.model_dump(mode="json", by_alias=True)
        row.layers = layers
        row.updated_at = _now()
        db.commit()
        db.refresh(row, ["owner"])
        return _detail(row, owner)


def patch(
    engine: Engine, owner: int, query_id: str, body: SavedQueryPatch, backend: DataBackend
) -> SavedQuerySummary:
    visible = set(backend.layer_names())
    with Session(engine, expire_on_commit=False) as db:
        row = _own(db, query_id, owner, visible)
        if body.name is not None:
            _ensure_free(db, owner, body.name, keep=row.id)
            row.name = body.name
        if body.shared is not None:
            row.shared = body.shared
        row.updated_at = _now()
        db.commit()
        db.refresh(row, ["owner"])
        return _summary(row, owner)


def duplicate(
    engine: Engine, viewer: int, query_id: str, backend: DataBackend
) -> SavedQuerySummary:
    """A private copy for the viewer, of an own or a shared query (design C6)."""
    visible = set(backend.layer_names())
    with Session(engine, expire_on_commit=False) as db:
        source = _get(db, query_id, viewer, visible)
        copy = SavedQuery(
            id=secrets.token_urlsafe(8),
            owner_id=viewer,
            name=_free_name(db, viewer, source.name),
            shared=False,
            state_version=source.state_version,
            state=source.state,
            query=source.query,
            layers=source.layers,
        )
        db.add(copy)
        db.commit()
        db.refresh(copy, ["owner", "created_at", "updated_at"])
        return _summary(copy, viewer)


def usage(engine: Engine, viewer: int, query_id: str, backend: DataBackend) -> Usage:
    """How many sessions — of any account — refer to it; a count, never whose (Q7)."""
    visible = set(backend.layer_names())
    with Session(reading(engine)) as db:
        _get(db, query_id, viewer, visible)
        count = db.scalar(
            select(func.count())
            .select_from(AnalysisSession)
            .where(AnalysisSession.state["query"]["id"].as_string() == query_id)
        )
        return Usage(sessions=count or 0)


def delete(engine: Engine, owner: int, query_id: str, backend: DataBackend) -> None:
    """Sessions keep their own conditions; only their link to the name goes (Q6)."""
    visible = set(backend.layer_names())
    with Session(engine) as db:
        db.delete(_own(db, query_id, owner, visible))
        db.commit()
