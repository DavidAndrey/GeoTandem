"""Run an import: source + decisions → managed layer (F-2.3, F-2.5, F-2.6, F-2.10).

Three ways to a geometry, all ending in ``DataBackend.create_layer`` or
``replace_layer`` — the same entry point as the sample loader:

- ``geometry``: the file's own geometries, reprojected to the internal CRS;
- ``xy``: points from two coordinate columns;
- ``key``: the geometry of the feature in an existing layer whose key
  attribute equals the row's key (design B5); the result is a vector layer
  of its own, with ``references`` recording the relation (F-2.9).

Rows that cannot get a geometry are rejected and logged, never dropped
silently. Blocking problems raise ``ImportBlocked`` before anything is stored;
every attempt ends in the log.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any, Literal

import shapely
from geoalchemy2.shape import to_shape
from pydantic import BaseModel, Field
from pyproj import CRS
from pyproj.exceptions import CRSError
from shapely.geometry import Point
from shapely.geometry.base import BaseGeometry
from sqlalchemy import select

from geotandem.catalog import list_layers
from geotandem.data import AttributeSpec, DataBackend, LayerExists, NewLayer
from geotandem.geo import common_geometry_type, reprojector
from geotandem.importing import log
from geotandem.importing.log import ImportRunInfo, RejectedRow, Step
from geotandem.importing.names import RESERVED, identifier
from geotandem.importing.preview import Preview, build_preview, key_text
from geotandem.importing.read import (
    Message,
    ReadOptions,
    Source,
    SourceError,
    detect_format,
    read_source,
)


class GeometryReference(BaseModel):
    mode: Literal["geometry"] = "geometry"
    crs: int | None = None
    """EPSG code; overrides the file's CRS, required if the file names none."""


class XYReference(BaseModel):
    mode: Literal["xy"] = "xy"
    x: str
    y: str
    """Source column names."""
    crs: int


class KeyReference(BaseModel):
    mode: Literal["key"] = "key"
    column: str
    """Source column with the area key."""
    layer: str
    attribute: str


GeoReference = Annotated[
    GeometryReference | XYReference | KeyReference, Field(discriminator="mode")
]


class FieldDecision(BaseModel):
    source_name: str
    name: str | None = None
    """Attribute identifier; the preview's proposal if empty."""
    include: bool = True
    label: str | None = None
    """Defaults to the source name."""
    description: str = ""
    unit: str | None = None
    value_domain: dict[str, Any] | None = None
    for_model: bool = True


class ImportDecisions(BaseModel):
    """What the wizard settled (design D6); everything not given follows the preview."""

    options: ReadOptions = ReadOptions()
    geo: GeoReference = GeometryReference()
    layer_name: str | None = None
    """Identifier of a new layer; the preview's proposal if empty."""
    replace: str | None = None
    """Name of an existing layer whose content is replaced (F-2.7 "Aktualisieren")."""
    title: str | None = None
    description: str = ""
    for_model: bool = True
    fields: list[FieldDecision] | None = None
    """Per source column; columns not listed are imported as proposed."""


class ImportBlocked(SourceError):
    """A decision is missing or contradicts the data; nothing was stored."""


def key_candidates(backend: DataBackend) -> dict[tuple[str, str], set[str]]:
    """Attributes of vector layers that can serve as area key, with their values.

    A key identifies one feature, so only attributes with unique values count.
    Layers made by a key join are skipped altogether: their geometry is a copy
    of the layer they reference, which is the one to join to. Otherwise a
    re-import would be keyed to the previous import of the same table, whose
    unique columns all match themselves.
    """
    candidates: dict[tuple[str, str], set[str]] = {}
    for info in list_layers(backend.engine):
        if info.kind != "vector" or any(a.references for a in info.attributes):
            continue
        table = backend.layer_table(info.name)
        for attribute in info.attributes:
            if attribute.data_type not in ("integer", "text"):
                continue
            with backend.engine.connect() as conn:
                values = [v for v in conn.scalars(select(table.c[attribute.name])) if v is not None]
            keys = {key_text(v) for v in values}
            if values and len(keys) == len(values):
                candidates[(info.name, attribute.name)] = keys
    return candidates


def preview_file(path: Path, file_name: str, options: ReadOptions, backend: DataBackend) -> Preview:
    source = read_source(path, file_name, options)
    return build_preview(
        source,
        backend.internal_srid,
        taken_layer_names=backend.layer_names(),
        key_candidates=key_candidates(backend) if not source.is_vector else None,
    )


def run_import(
    path: Path,
    file_name: str,
    decisions: ImportDecisions,
    backend: DataBackend,
    actor: str | None = None,
) -> ImportRunInfo:
    """Import ``path``; always returns the log entry, also for a blocked attempt."""
    mode: log.ImportMode = "replace" if decisions.replace else "create"
    run_id = log.start(
        backend.engine,
        source_name=file_name,
        source_format=_format_label(file_name),
        mode=mode,
        layer_name=decisions.replace or decisions.layer_name,
        actor=actor,
        decisions=decisions.model_dump(mode="json"),
    )
    steps: list[Step] = []
    source: Source | None = None
    try:
        with _timed(steps, "read"):
            source = read_source(path, file_name, decisions.options)
            preview = build_preview(
                source, backend.internal_srid, taken_layer_names=backend.layer_names()
            )
        with _timed(steps, "check"):
            plan = _plan(source, preview, decisions, backend)
        with _timed(steps, "geometry"):
            rows, rejected, warnings = _rows(source, plan, backend)
        if not rows:
            raise ImportBlocked("no_importable_rows", "No record could be given a geometry.")
        new_layer = NewLayer(
            name=plan.layer_name,
            title=plan.title,
            description=decisions.description,
            kind="vector",
            attributes=plan.attributes,
            rows=rows,
            source=f"file:{file_name}",
            dataset_version=f"import-{run_id}",
            geometry_type=common_geometry_type(g for g, _ in rows),
            for_model=decisions.for_model,
        )
        with _timed(steps, "store"):
            if decisions.replace:
                count = backend.replace_layer(decisions.replace, new_layer)
            else:
                try:
                    count = backend.create_layer(new_layer)
                except LayerExists as exc:  # another import took the name since _plan
                    raise ImportBlocked("layer_exists", str(exc)) from exc
    except SourceError as exc:
        return log.finish(
            backend.engine,
            run_id,
            status="failed",
            read_count=source.record_count if source else 0,
            errors=[Message(code=exc.code, message=exc.message)],
            warnings=source.notes if source else [],
            steps=steps,
        )
    except Exception:
        # Not the file's fault: the entry must not stay "running" (design D7);
        # the error itself goes on to the server log.
        log.finish(
            backend.engine,
            run_id,
            status="failed",
            read_count=source.record_count if source else 0,
            errors=[Message(code="internal_error", message="The import stopped unexpectedly.")],
            steps=steps,
        )
        raise
    # The preview's hint about a missing geo-reference only helps the wizard
    # before deciding; here the decision has been made and checked (_plan).
    hints = {"no_geo_reference_found"}
    warnings = [*(w for w in preview.warnings if w.code not in hints), *warnings]
    return log.finish(
        backend.engine,
        run_id,
        status="warning" if warnings or rejected else "ok",
        read_count=source.record_count,
        imported_count=count,
        rejected=rejected,
        warnings=warnings,
        steps=steps,
        layer_name=plan.layer_name,
    )


def abort(engine: Any, file_name: str, actor: str | None = None) -> ImportRunInfo:
    """Log a wizard closed without importing (design D7: aborted attempts are kept)."""
    run_id = log.start(
        engine,
        source_name=file_name,
        source_format=_format_label(file_name),
        mode="create",
        layer_name=None,
        actor=actor,
    )
    return log.finish(engine, run_id, status="aborted")


# --- planning -----------------------------------------------------------------


class _Plan(BaseModel):
    layer_name: str
    title: str
    attributes: list[AttributeSpec]
    columns: list[str]
    """Source column per attribute, same order."""
    geo: GeoReference
    source_crs: int | None

    model_config = {"arbitrary_types_allowed": True}


def _plan(
    source: Source, preview: Preview, decisions: ImportDecisions, backend: DataBackend
) -> _Plan:
    geo = decisions.geo
    existing = set(backend.layer_names())
    if decisions.replace:
        if decisions.replace not in existing:
            raise ImportBlocked("unknown_layer", f"There is no layer '{decisions.replace}'.")
        layer_name = decisions.replace
    else:
        layer_name = decisions.layer_name or preview.layer_name
        _check_identifier(layer_name, "layer name")
        if layer_name in existing:
            raise ImportBlocked("layer_exists", f"A layer '{layer_name}' already exists.")

    source_crs: int | None = None
    if isinstance(geo, GeometryReference):
        if not source.is_vector:
            raise ImportBlocked(
                "no_geometry_in_source", "A table needs coordinate columns or an area key."
            )
        source_crs = geo.crs or source.crs
        if source_crs is None:
            raise ImportBlocked("crs_unknown", "Choose the coordinate reference system.")
    elif isinstance(geo, XYReference):
        source_crs = geo.crs
        for name in (geo.x, geo.y):
            column = _source_column(source, name)
            if column.data_type not in ("integer", "real"):
                raise ImportBlocked(
                    "coordinates_not_numeric", f"Column '{name}' does not hold numbers."
                )
    else:
        _source_column(source, geo.column)
        try:
            target = backend.layer_table(geo.layer)
        except KeyError:
            raise ImportBlocked("unknown_layer", f"There is no layer '{geo.layer}'.") from None
        if "geom" not in target.c or geo.attribute not in target.c:
            raise ImportBlocked(
                "invalid_key_target",
                f"'{geo.layer}.{geo.attribute}' is not an attribute of a geometry layer.",
            )
    if source_crs is not None:
        _check_crs(source_crs)

    by_source = {d.source_name: d for d in decisions.fields or []}
    unknown = set(by_source) - {c.source_name for c in preview.columns}
    if unknown:
        raise ImportBlocked("unknown_column", f"Unknown columns: {', '.join(sorted(unknown))}.")
    attributes: list[AttributeSpec] = []
    columns: list[str] = []
    for proposal in preview.columns:
        decision = by_source.get(proposal.source_name, FieldDecision(source_name=""))
        if not decision.include:
            continue
        name = decision.name or proposal.name
        _check_identifier(name, "attribute name")
        if name in RESERVED or name in {a.name for a in attributes}:
            raise ImportBlocked("duplicate_attribute", f"Attribute name '{name}' is taken.")
        references = None
        if isinstance(geo, KeyReference) and proposal.source_name == geo.column:
            references = f"{geo.layer}.{geo.attribute}"
        attributes.append(
            AttributeSpec(
                name=name,
                data_type=proposal.data_type,
                label=decision.label or proposal.source_name,
                description=decision.description,
                unit=decision.unit,
                value_domain=decision.value_domain
                if decision.value_domain is not None
                else proposal.value_domain,
                for_model=decision.for_model,
                references=references,
            )
        )
        columns.append(proposal.source_name)
    return _Plan(
        layer_name=layer_name,
        title=decisions.title or preview.title,
        attributes=attributes,
        columns=columns,
        geo=geo,
        source_crs=source_crs,
    )


def _source_column(source: Source, name: str) -> Any:
    try:
        return source.column(name)
    except KeyError:
        raise ImportBlocked("unknown_column", f"The file has no column '{name}'.") from None


def _check_identifier(name: str, what: str) -> None:
    if identifier(name) != name:
        raise ImportBlocked(
            "invalid_name",
            f"'{name}' is not a valid {what}: lower-case letters, digits and underscores, "
            "not starting with a digit.",
        )


def _check_crs(epsg: int) -> None:
    try:
        CRS.from_epsg(epsg)
    except CRSError:
        raise ImportBlocked("crs_unknown", f"EPSG:{epsg} is not a known CRS.") from None


# --- rows ---------------------------------------------------------------------


Row = tuple[BaseGeometry | None, dict[str, Any]]


def _rows(
    source: Source, plan: _Plan, backend: DataBackend
) -> tuple[list[Row], list[RejectedRow], list[Message]]:
    columns = [source.column(c) for c in plan.columns]
    names = [a.name for a in plan.attributes]

    def attributes(i: int) -> dict[str, Any]:
        return {n: c.values[i] for n, c in zip(names, columns, strict=True)}

    warnings: list[Message] = []
    geometry_of = _geometry_source(source, plan, backend, warnings)
    rows: list[Row] = []
    rejected: list[RejectedRow] = []
    repaired = 0
    for i in range(source.record_count):
        geometry, reason = geometry_of(i)
        if geometry is None:
            rejected.append(RejectedRow(row=i + 1, reason=reason or "", values=attributes(i)))
            continue
        if not geometry.is_valid:
            geometry = shapely.make_valid(geometry, method="structure", keep_collapsed=False)
            repaired += 1
            if geometry.is_empty:
                rejected.append(
                    RejectedRow(row=i + 1, reason="invalid_geometry", values=attributes(i))
                )
                continue
        rows.append((geometry, attributes(i)))

    if repaired:
        warnings.append(
            Message(
                code="repaired", message=f"{repaired} geometries were repaired.", count=repaired
            )
        )
    if rejected:
        warnings.append(
            Message(
                code="rejected_rows",
                message=f"{len(rejected)} records were not imported.",
                count=len(rejected),
            )
        )
    return rows, rejected, warnings


def _geometry_source(
    source: Source, plan: _Plan, backend: DataBackend, warnings: list[Message]
) -> Callable[[int], tuple[BaseGeometry | None, str | None]]:
    geo = plan.geo
    if isinstance(geo, KeyReference):
        return _key_lookup(source, geo, backend, warnings)
    assert plan.source_crs is not None
    project = reprojector(plan.source_crs, backend.internal_srid)

    def checked(geometry: BaseGeometry) -> tuple[BaseGeometry | None, str | None]:
        result = project(geometry)
        if not all(math.isfinite(v) for v in result.bounds):
            return None, "outside_crs"
        return result, None

    if isinstance(geo, XYReference):
        xs, ys = source.column(geo.x).values, source.column(geo.y).values

        def from_xy(i: int) -> tuple[BaseGeometry | None, str | None]:
            if xs[i] is None or ys[i] is None:
                return None, "missing_coordinates"
            return checked(Point(xs[i], ys[i]))

        return from_xy

    geometries = source.geometries or []

    def from_file(i: int) -> tuple[BaseGeometry | None, str | None]:
        geometry = geometries[i]
        if geometry is None or geometry.is_empty:
            return None, "missing_geometry"
        return checked(geometry)

    return from_file


def _key_lookup(
    source: Source, geo: KeyReference, backend: DataBackend, warnings: list[Message]
) -> Callable[[int], tuple[BaseGeometry | None, str | None]]:
    table = backend.layer_table(geo.layer)
    targets: dict[str, BaseGeometry] = {}
    ambiguous = 0
    with backend.engine.connect() as conn:
        found = conn.execute(select(table.c[geo.attribute], table.c.geom).order_by(table.c.fid))
        for key, geom in found:
            if key is None or geom is None:
                continue
            if key_text(key) in targets:
                ambiguous += 1
            else:
                targets[key_text(key)] = to_shape(geom)
    if ambiguous:
        warnings.append(
            Message(
                code="ambiguous_key_target",
                message=f"{ambiguous} key values occur more than once in '{geo.layer}'; "
                "the first feature is used.",
                count=ambiguous,
            )
        )
    keys = source.column(geo.column).values
    present = [key_text(k) for k in keys if k is not None]
    duplicates = len(present) - len(set(present))
    if duplicates:
        warnings.append(
            Message(
                code="duplicate_keys",
                message=f"{duplicates} rows repeat a key; they share the same geometry.",
                count=duplicates,
                column=geo.column,
            )
        )

    def lookup(i: int) -> tuple[BaseGeometry | None, str | None]:
        if keys[i] is None:
            return None, "missing_key"
        geometry = targets.get(key_text(keys[i]))
        return (geometry, None) if geometry is not None else (None, "key_not_found")

    return lookup


# --- helpers ------------------------------------------------------------------


@contextmanager
def _timed(steps: list[Step], name: str) -> Iterator[None]:
    start = time.perf_counter()
    try:
        yield
    finally:
        steps.append(Step(step=name, ms=round((time.perf_counter() - start) * 1000, 1)))


def _format_label(file_name: str) -> str:
    try:
        return detect_format(file_name)
    except SourceError:
        return "unknown"
