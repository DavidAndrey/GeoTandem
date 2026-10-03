"""Import preview (F-2.4) and the proposals the wizard starts from (design D6).

Pure: everything the data core knows (existing layer names, key values of
geometry layers) is passed in, so the preview is testable without one.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Iterable, Mapping
from pathlib import PurePath
from typing import Any

import shapely
from pydantic import BaseModel
from pyproj import CRS, Transformer

from geotandem.data.interface import AttributeType
from geotandem.geo import WGS84, common_geometry_type
from geotandem.importing.names import identifier, unique_identifiers
from geotandem.importing.read import Column, Format, Message, ReadOptions, Source

SAMPLE_ROWS = 10
SAMPLE_VALUES = 5
MAX_CODES = 20
MIN_KEY_MATCH = 0.5

_X = re.compile(r"^(x|lon|lng|long|longitude|laenge|e|east|easting|ost|rechtswert)(_.*)?$|.*_x$")
_Y = re.compile(r"^(y|lat|latitude|breite|n|north|northing|nord|hochwert)(_.*)?$|.*_y$")


class ColumnPreview(BaseModel):
    source_name: str
    name: str
    """Proposed attribute name (an identifier, see ``names``)."""
    data_type: AttributeType
    null_count: int
    distinct_count: int
    samples: list[Any]
    value_domain: dict[str, Any] | None
    """Proposed range (``min``/``max``) or code list (``codes``), F-2.8."""


class XYProposal(BaseModel):
    x: str
    y: str
    crs: int | None
    """Guessed from the value range; ``None`` if neither WGS84 nor the internal CRS fits."""


class KeyProposal(BaseModel):
    column: str
    layer: str
    attribute: str
    matched: int
    total: int
    """Rows with a key value; ``matched`` of them find a feature (design B5 "36 / 38")."""


class Preview(BaseModel):
    format: Format
    file_name: str
    options: ReadOptions
    sublayers: list[str]
    record_count: int
    layer_name: str
    """Proposed identifier of the new layer."""
    title: str
    geometry_type: str | None
    crs: int | None
    crs_label: str | None
    bbox: list[float] | None
    """In the source CRS."""
    bbox_wgs84: list[float] | None
    columns: list[ColumnPreview]
    xy: XYProposal | None
    keys: list[KeyProposal]
    sample_rows: list[dict[str, Any]]
    """First rows, keyed by proposed attribute name."""
    warnings: list[Message]
    errors: list[Message]
    """Conditions that block the import until a decision resolves them (design D11)."""


def build_preview(
    source: Source,
    internal_srid: int,
    taken_layer_names: Collection[str] = (),
    key_candidates: Mapping[tuple[str, str], Collection[str]] | None = None,
) -> Preview:
    names = unique_identifiers([c.name for c in source.columns])
    # A GeoPackage layer name says more than the file name; an Excel sheet name rarely does.
    stem = source.options.sublayer if source.format in ("gpkg", "shapefile") else None
    title = stem or PurePath(source.file_name).stem
    layer_name = unique_identifiers([title], taken=taken_layer_names, fallback="layer")[0]
    warnings = list(source.notes)
    errors: list[Message] = []

    geometry_type = bbox = bbox_wgs84 = None
    xy = None
    keys: list[KeyProposal] = []
    if source.geometries is not None:
        geometry_type, bbox, bbox_wgs84 = _geometry_facts(source, warnings, errors)
    else:
        xy = propose_xy(source.columns, internal_srid)
        keys = propose_keys(source.columns, key_candidates or {})
        if xy is None and not keys:
            warnings.append(
                Message(
                    code="no_geo_reference_found",
                    message="No coordinate columns or matching area key were recognised; "
                    "choose them by hand.",
                )
            )
    if source.record_count == 0:
        errors.append(Message(code="no_rows", message="The file contains no records."))

    return Preview(
        format=source.format,
        file_name=source.file_name,
        options=source.options,
        sublayers=source.sublayers,
        record_count=source.record_count,
        layer_name=layer_name,
        title=title,
        geometry_type=geometry_type,
        crs=source.crs,
        crs_label=source.crs_label,
        bbox=bbox,
        bbox_wgs84=bbox_wgs84,
        columns=[_column(c, n) for c, n in zip(source.columns, names, strict=True)],
        xy=xy,
        keys=keys,
        sample_rows=[
            {n: c.values[i] for c, n in zip(source.columns, names, strict=True)}
            for i in range(min(SAMPLE_ROWS, source.record_count))
        ],
        warnings=warnings,
        errors=errors,
    )


def _geometry_facts(
    source: Source, warnings: list[Message], errors: list[Message]
) -> tuple[str | None, list[float] | None, list[float] | None]:
    assert source.geometries is not None
    present = [g for g in source.geometries if g is not None and not g.is_empty]
    missing = source.record_count - len(present)
    if missing:
        warnings.append(
            Message(
                code="missing_geometry",
                message=f"{missing} records have no geometry and will not be imported.",
                count=missing,
            )
        )
    if not present:
        if source.record_count:
            errors.append(Message(code="no_geometry", message="No record has a geometry."))
        return None, None, None
    invalid = int((~shapely.is_valid(present)).sum())
    if invalid:
        warnings.append(
            Message(
                code="invalid_geometry",
                message=f"{invalid} geometries are invalid and will be repaired.",
                count=invalid,
            )
        )
    geometry_type = common_geometry_type(present)
    if geometry_type == "Geometry":
        warnings.append(
            Message(
                code="mixed_geometry_types",
                message="The file mixes geometry types; the layer gets a generic geometry type.",
            )
        )
    if source.crs is None:
        errors.append(
            Message(
                code="crs_unknown",
                message="The coordinate reference system is not identifiable; choose it."
                if source.crs_label
                else "The file names no coordinate reference system; choose it.",
            )
        )
    bounds = [round(float(v), 7) for v in shapely.total_bounds(present)]
    return geometry_type, bounds, _to_wgs84(bounds, source.crs)


def _to_wgs84(bounds: list[float], crs: int | None) -> list[float] | None:
    if crs is None:
        return None
    if crs == WGS84:
        return bounds
    transformer = Transformer.from_crs(crs, WGS84, always_xy=True)
    left, bottom, right, top = bounds
    return [round(v, 7) for v in transformer.transform_bounds(left, bottom, right, top)]


def _column(column: Column, name: str) -> ColumnPreview:
    present = [v for v in column.values if v is not None]
    distinct = set(present)
    return ColumnPreview(
        source_name=column.name,
        name=name,
        data_type=column.data_type,
        null_count=len(column.values) - len(present),
        distinct_count=len(distinct),
        samples=list(dict.fromkeys(present))[:SAMPLE_VALUES],
        value_domain=propose_value_domain(column.data_type, present, distinct),
    )


def propose_value_domain(
    data_type: AttributeType, present: list[Any], distinct: set[Any]
) -> dict[str, Any] | None:
    if not present:
        return None
    if data_type in ("integer", "real"):
        return {"min": min(present), "max": max(present)}
    if (
        data_type == "text"
        and 2 <= len(distinct) <= MAX_CODES
        and len(distinct) <= len(present) / 2
    ):
        return {"codes": {v: v for v in sorted(distinct)}}
    return None


# --- geo-reference proposals --------------------------------------------------


def propose_xy(columns: Iterable[Column], internal_srid: int) -> XYProposal | None:
    numeric = [c for c in columns if c.data_type in ("integer", "real")]
    xs = [c for c in numeric if _X.match(identifier(c.name))]
    ys = [c for c in numeric if _Y.match(identifier(c.name))]
    if not xs or not ys:
        return None
    x, y = xs[0], ys[0]
    return XYProposal(x=x.name, y=y.name, crs=guess_crs(x.values, y.values, internal_srid))


def guess_crs(xs: list[Any], ys: list[Any], internal_srid: int) -> int | None:
    pairs = [(x, y) for x, y in zip(xs, ys, strict=True) if x is not None and y is not None]
    if not pairs:
        return None
    min_x, max_x = min(p[0] for p in pairs), max(p[0] for p in pairs)
    min_y, max_y = min(p[1] for p in pairs), max(p[1] for p in pairs)
    if min_x >= -180 and max_x <= 180 and min_y >= -90 and max_y <= 90:
        return WGS84
    area = CRS.from_epsg(internal_srid).area_of_use
    if area is not None:
        to_internal = Transformer.from_crs(WGS84, internal_srid, always_xy=True)
        left, bottom, right, top = to_internal.transform_bounds(*area.bounds)
        if left <= min_x and max_x <= right and bottom <= min_y and max_y <= top:
            return internal_srid
    return None


def key_text(value: Any) -> str:
    """Key values compare as text, so ``12`` (integer) matches ``"12"`` (text)."""
    return str(value).strip()


def propose_keys(
    columns: Iterable[Column], candidates: Mapping[tuple[str, str], Collection[str]]
) -> list[KeyProposal]:
    proposals = []
    for column in columns:
        if column.data_type not in ("integer", "text"):
            continue
        keys = [key_text(v) for v in column.values if v is not None]
        if not keys:
            continue
        for (layer, attribute), values in candidates.items():
            matched = sum(1 for k in keys if k in values)
            if matched / len(keys) >= MIN_KEY_MATCH:
                proposals.append(
                    KeyProposal(
                        column=column.name,
                        layer=layer,
                        attribute=attribute,
                        matched=matched,
                        total=len(keys),
                    )
                )
    return sorted(proposals, key=lambda p: (-p.matched / p.total, p.column, p.layer))
