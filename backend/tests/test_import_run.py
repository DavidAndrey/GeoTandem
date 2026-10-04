"""Running imports (F-2.3, F-2.5, F-2.6, F-2.10): every path ends as a managed
layer with spatial index and metadata, every attempt ends in the log."""

import json
from pathlib import Path
from typing import Any

import pytest
from import_files import LV95, make_files, sample_features
from shapely.geometry import shape
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from geotandem.catalog import get_layer
from geotandem.data import DataBackend, Limits
from geotandem.db.orm import Layer, LayerAttribute
from geotandem.engine import run_query
from geotandem.importing import log
from geotandem.importing.run import (
    FieldDecision,
    GeometryReference,
    ImportDecisions,
    KeyReference,
    XYReference,
    abort,
    key_candidates,
    run_import,
)
from geotandem.sample import DATA_DIR
from geotandem.sample.load import load_sample
from geotandem_query import QueryObject

LIMITS = Limits(max_features=1000, timeout_s=10)


@pytest.fixture(scope="module")
def files(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return make_files(tmp_path_factory.mktemp("import"))


@pytest.fixture
def sample_backend(backend: DataBackend) -> DataBackend:
    load_sample(backend)
    return backend


def imported(backend: DataBackend, files: dict[str, Path], name: str, **decisions: Any):  # type: ignore[no-untyped-def]
    return run_import(files[name], name, ImportDecisions(**decisions), backend, actor="admin")


def has_rtree(backend: DataBackend, layer: str) -> bool:
    with backend.engine.connect() as conn:
        return conn.scalar(select(func.CheckSpatialIndex(f"lyr_{layer}", "geom"))) == 1


def features(backend: DataBackend, layer: str) -> list[Any]:
    query = QueryObject.model_validate({"source": layer, "output": "map"})
    return run_query(query, backend, LIMITS).features


# --- the three paths ----------------------------------------------------------


def test_vector_file_wgs84_round_trip(backend: DataBackend, files: dict[str, Path]) -> None:
    run = imported(backend, files, "schulen.geojson", layer_name="schulen_neu")

    assert (run.status, run.read_count, run.imported_count, run.rejected_count) == (
        "ok",
        137,
        137,
        0,
    )
    assert (run.layer_name, run.mode, run.actor) == ("schulen_neu", "create", "admin")
    assert [s.step for s in run.steps] == ["read", "check", "geometry", "store"]
    assert has_rtree(backend, "schulen_neu")
    info = get_layer(backend.engine, "schulen_neu")
    assert info is not None
    assert (info.geometry_type, info.dataset_version) == ("Point", f"import-{run.id}")
    assert [(a.name, a.label) for a in info.attributes] == [
        ("name", "name"),
        ("typ", "typ"),
        ("standorte", "standorte"),
    ]
    # WGS84 → internal CRS → WGS84 stays within about 1 cm (1e-7 degrees).
    source = sample_features("schulen")
    for feature, expected in zip(features(backend, "schulen_neu"), source, strict=True):
        assert shape(feature.geometry).equals_exact(shape(expected["geometry"]), 1e-7)


def test_shapefile_lv95(backend: DataBackend, files: dict[str, Path]) -> None:
    run = imported(backend, files, "gemeinden.zip", title="Gemeinden (Shapefile)")
    assert run.status == "ok" and run.imported_count == 74
    assert has_rtree(backend, "gemeinden")
    info = get_layer(backend.engine, "gemeinden")
    assert info is not None and info.title == "Gemeinden (Shapefile)"
    # Shapefile cut the field name to ten characters; the label keeps it readable.
    assert "flaeche_km" in [a.name for a in info.attributes]


def test_csv_with_xy_columns(backend: DataBackend, files: dict[str, Path]) -> None:
    run = imported(
        backend,
        files,
        "messstellen.csv",
        geo=XYReference(x="E", y="N", crs=LV95),
        fields=[FieldDecision(source_name="Höhe ü. M.", unit="m ü. M.", description="Höhe")],
    )
    assert (run.status, run.read_count, run.imported_count, run.rejected_count) == (
        "warning",
        21,
        20,
        1,
    )
    assert [(r.row, r.reason, r.values["bezeichnung"]) for r in run.rejected_sample] == [
        (21, "missing_coordinates", "Ohne Lage")
    ]
    assert [w.code for w in run.warnings] == ["encoding_fallback", "rejected_rows"]
    assert has_rtree(backend, "messstellen")
    info = get_layer(backend.engine, "messstellen")
    assert info is not None
    hoehe = next(a for a in info.attributes if a.name == "hoehe_ue_m")
    assert (hoehe.label, hoehe.unit, hoehe.data_type) == ("Höhe ü. M.", "m ü. M.", "real")
    assert hoehe.value_domain == {"min": 450.5, "max": 500.0}
    # The points are the schools the file was made from.
    schools = [shape(f["geometry"]) for f in sample_features("schulen")[:20]]
    for feature, school in zip(features(backend, "messstellen"), schools, strict=True):
        assert shape(feature.geometry).distance(school) < 1e-6


def test_table_with_area_key(sample_backend: DataBackend, files: dict[str, Path]) -> None:
    backend = sample_backend
    run = imported(
        backend,
        files,
        "kennzahlen.xlsx",
        geo=KeyReference(column="Gem-Nr", layer="gemeinden", attribute="gem_nr"),
    )
    assert (run.status, run.imported_count, run.rejected_count) == ("warning", 74, 2)
    assert {r.reason for r in run.rejected_sample} == {"key_not_found"}
    assert has_rtree(backend, "kennzahlen")
    info = get_layer(backend.engine, "kennzahlen")
    assert info is not None and info.geometry_type == "MultiPolygon"  # a few have exclaves
    key = next(a for a in info.attributes if a.name == "gem_nr")
    assert key.data_type == "integer"
    with Session(backend.engine) as session:
        references = session.scalar(
            select(LayerAttribute.references)
            .join(Layer)
            .where(Layer.name == "kennzahlen", LayerAttribute.name == "gem_nr")
        )
    assert references == "gemeinden.gem_nr"
    # Same geometry as the municipality it was keyed to.
    by_nr = {f.properties["gem_nr"]: shape(f.geometry) for f in features(backend, "gemeinden")}
    for feature in features(backend, "kennzahlen"):
        assert shape(feature.geometry).equals(by_nr[feature.properties["gem_nr"]])
    # A query over the new layer joins back on the key.
    query = QueryObject.model_validate(
        {
            "source": "kennzahlen",
            "where": {"op": "compare", "attr": "arbeitsplaetze", "cmp": "ge", "value": 8800},
            "output": "table",
        }
    )
    assert len(run_query(query, backend, LIMITS).features) == 4  # gem_nr 880 to 889


# --- decisions and failures ---------------------------------------------------


def test_missing_crs_blocks_and_is_logged(backend: DataBackend, files: dict[str, Path]) -> None:
    run = imported(backend, files, "gemeinden_ohne_prj.zip")
    assert (run.status, [e.code for e in run.errors]) == ("failed", ["crs_unknown"])
    assert backend.layer_names() == []

    run = imported(backend, files, "gemeinden_ohne_prj.zip", geo=GeometryReference(crs=LV95))
    # The layer is named after the .shp inside the zip, not after the zip.
    assert run.status == "ok" and backend.layer_names() == ["gemeinden"]


@pytest.mark.parametrize(
    ("decisions", "code"),
    [
        ({"layer_name": "Schulen Neu"}, "invalid_name"),
        ({"layer_name": "gemeinden"}, "layer_exists"),
        ({"replace": "gibtsnicht"}, "unknown_layer"),
        ({"fields": [{"source_name": "gibtsnicht"}]}, "unknown_column"),
        ({"fields": [{"source_name": "typ", "name": "name"}]}, "duplicate_attribute"),
        ({"geo": {"mode": "geometry", "crs": 999999}}, "crs_unknown"),
        ({"geo": {"mode": "xy", "x": "name", "y": "typ", "crs": 2056}}, "coordinates_not_numeric"),
    ],
)
def test_blocking_decisions(
    sample_backend: DataBackend,
    files: dict[str, Path],
    decisions: dict[str, Any],
    code: str,
) -> None:
    before = sample_backend.layer_names()
    run = imported(sample_backend, files, "schulen.geojson", **decisions)
    assert (run.status, [e.code for e in run.errors]) == ("failed", [code])
    assert sample_backend.layer_names() == before


def test_import_losing_the_race_for_a_name_fails_cleanly(
    backend: DataBackend, files: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The name was free when checked, then another import committed it first."""
    first = imported(backend, files, "schulen.geojson")
    monkeypatch.setattr(backend, "layer_names", lambda: [])
    second = imported(backend, files, "schulen.geojson")
    monkeypatch.undo()
    assert first.status == "ok"
    assert (second.status, [e.code for e in second.errors]) == ("failed", ["layer_exists"])
    assert len(features(backend, "schulen")) == 137


def test_key_target_must_be_a_geometry_layer(
    sample_backend: DataBackend, files: dict[str, Path]
) -> None:
    run = imported(
        sample_backend,
        files,
        "kennzahlen.xlsx",
        geo=KeyReference(column="Gem-Nr", layer="gemeindedaten", attribute="gem_nr"),
    )
    assert [e.code for e in run.errors] == ["invalid_key_target"]


def test_excluded_fields_are_not_imported(backend: DataBackend, files: dict[str, Path]) -> None:
    imported(
        backend,
        files,
        "schulen.geojson",
        fields=[
            FieldDecision(source_name="standorte", include=False),
            FieldDecision(source_name="typ", name="schulart", label="Schulart", for_model=False),
        ],
    )
    info = get_layer(backend.engine, "schulen")
    assert info is not None
    assert [(a.name, a.label) for a in info.attributes] == [
        ("name", "name"),
        ("schulart", "Schulart"),
    ]


def test_columns_named_alike_keep_their_own_values(backend: DataBackend, tmp_path: Path) -> None:
    table = tmp_path / "doppelt.csv"
    table.write_text(
        "Name;Wert;Name;E;N\nAare;1;Fluss;2600000;1200000\nGürbe;2;Bach;2601000;1200000\n",
        "utf-8",
    )
    run = run_import(
        table,
        table.name,
        ImportDecisions(
            geo=XYReference(x="E", y="N", crs=LV95),
            fields=[FieldDecision(source_name="Name (2)", label="Art")],
        ),
        backend,
    )
    assert run.status == "warning"
    assert "duplicate_header" in [w.code for w in run.warnings]
    info = get_layer(backend.engine, "doppelt")
    assert info is not None
    assert [(a.name, a.label) for a in info.attributes][:3] == [
        ("name", "Name"),
        ("wert", "Wert"),
        ("name_2", "Art"),
    ]
    rows = backend.execute(select(backend.layer_table("doppelt")), LIMITS)
    assert [(r["name"], r["name_2"]) for r in rows] == [("Aare", "Fluss"), ("Gürbe", "Bach")]


def test_an_unexpected_error_still_ends_the_log_entry(
    backend: DataBackend, files: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fails(_: object) -> int:
        raise RuntimeError("database is locked")

    monkeypatch.setattr(backend, "create_layer", fails)
    with pytest.raises(RuntimeError):
        imported(backend, files, "schulen.geojson", layer_name="schulen_neu")
    last = log.recent(backend.engine)[0]
    assert (last.status, last.layer_name) == ("failed", "schulen_neu")


def test_unreadable_file_is_logged(backend: DataBackend, tmp_path: Path) -> None:
    broken = tmp_path / "kaputt.gpkg"
    broken.write_bytes(b"nope")
    run = run_import(broken, broken.name, ImportDecisions(), backend)
    assert (run.status, run.source_format, [e.code for e in run.errors]) == (
        "failed",
        "gpkg",
        ["unreadable"],
    )


# --- replace (F-2.7 "Aktualisieren") ------------------------------------------


def test_replace_from_file(backend: DataBackend, files: dict[str, Path]) -> None:
    first = imported(backend, files, "schulen.geojson")
    second = imported(
        backend,
        files,
        "messstellen.csv",
        replace="schulen",
        geo=XYReference(x="E", y="N", crs=LV95),
    )
    assert (second.status, second.mode, second.layer_name) == ("warning", "replace", "schulen")
    info = get_layer(backend.engine, "schulen")
    assert info is not None
    assert (info.feature_count, info.dataset_version) == (20, f"import-{second.id}")
    assert info.dataset_version != f"import-{first.id}"
    assert has_rtree(backend, "schulen")


# --- the log ------------------------------------------------------------------


def test_log_lists_attempts_newest_first(backend: DataBackend, files: dict[str, Path]) -> None:
    imported(backend, files, "schulen.geojson")
    imported(backend, files, "gemeinden_ohne_prj.zip")
    abort(backend.engine, "netz.gpkg", actor="admin")

    runs = log.recent(backend.engine)
    assert [(r.source_name, r.status) for r in runs] == [
        ("netz.gpkg", "aborted"),
        ("gemeinden_ohne_prj.zip", "failed"),
        ("schulen.geojson", "ok"),
    ]
    assert [r.source_name for r in log.recent(backend.engine, status="failed")] == [
        "gemeinden_ohne_prj.zip"
    ]
    # A blocked new layer never existed, so only "schulen" has a last import.
    assert set(log.last_per_layer(backend.engine)) == {"schulen"}


def test_interrupted_runs_are_marked_failed(backend: DataBackend) -> None:
    run_id = log.start(
        backend.engine,
        source_name="x.csv",
        source_format="csv",
        mode="create",
        layer_name=None,
        actor=None,
    )
    assert log.fail_stale(backend.engine) == 1
    run = log.get(backend.engine, run_id)
    assert run is not None and (run.status, run.errors[0].code) == ("failed", "interrupted")


def test_sample_load_is_logged(sample_backend: DataBackend) -> None:
    runs = log.recent(sample_backend.engine)
    assert sorted(r.layer_name or "" for r in runs) == sorted(sample_backend.layer_names())
    assert {r.status for r in runs} == {"ok"}


def test_invalid_geometry_is_repaired_missing_one_rejected(
    backend: DataBackend, tmp_path: Path
) -> None:
    bowtie = [[7, 46], [7.01, 46.01], [7.01, 46], [7, 46.01], [7, 46]]
    path = tmp_path / "kaputt.geojson"
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"n": 1},
                        "geometry": {"type": "Polygon", "coordinates": [bowtie]},
                    },
                    {"type": "Feature", "properties": {"n": 2}, "geometry": None},
                ],
            }
        )
    )
    run = run_import(path, path.name, ImportDecisions(), backend)
    assert (run.status, run.imported_count, run.rejected_count) == ("warning", 1, 1)
    assert [r.reason for r in run.rejected_sample] == ["missing_geometry"]
    assert {"repaired", "rejected_rows"} <= {w.code for w in run.warnings}
    info = get_layer(backend.engine, "kaputt")
    assert info is not None and info.geometry_type == "MultiPolygon"
    with backend.engine.connect() as conn:
        assert (
            conn.scalar(select(func.min(func.ST_IsValid(backend.layer_table("kaputt").c.geom))))
            == 1
        )


def test_key_candidates_are_unique_and_not_key_join_copies(
    sample_backend: DataBackend, files: dict[str, Path]
) -> None:
    imported(
        sample_backend,
        files,
        "kennzahlen.xlsx",
        geo=KeyReference(column="Gem-Nr", layer="gemeinden", attribute="gem_nr"),
    )
    candidates = key_candidates(sample_backend)
    assert ("gemeinden", "gem_nr") in candidates
    assert ("schulen", "typ") not in candidates  # repeats: not a key
    # A key-join layer is no key target, not even with its unique columns:
    # a re-import of the same table must still be keyed to gemeinden.
    assert not any(layer == "kennzahlen" for layer, _ in candidates)


def test_key_candidates_are_read_once_per_dataset_version(
    sample_backend: DataBackend, files: dict[str, Path]
) -> None:
    reads: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_: Any) -> None:
        if "FROM lyr_" in statement:
            reads.append(statement)

    event.listen(sample_backend.engine, "before_cursor_execute", record)
    try:
        first = key_candidates(sample_backend)
        assert reads
        reads.clear()
        assert key_candidates(sample_backend) == first
        assert reads == []  # nothing changed: nothing read
        imported(sample_backend, files, "schulen.geojson", replace="schulen")
        reads.clear()
        key_candidates(sample_backend)
        assert [r for r in reads if "lyr_schulen" in r]  # the replaced layer only
        assert not [r for r in reads if "lyr_gemeinden" in r]
    finally:
        event.remove(sample_backend.engine, "before_cursor_execute", record)


def test_decided_key_import_is_clean(sample_backend: DataBackend) -> None:
    """The preview's "no geo-reference found" is a wizard hint, not an import warning."""
    path = DATA_DIR / "gemeindedaten.csv"
    run = run_import(
        path,
        path.name,
        ImportDecisions(geo=KeyReference(column="gem_nr", layer="gemeinden", attribute="gem_nr")),
        sample_backend,
    )
    assert (run.status, run.imported_count, run.warnings) == ("ok", 74, [])
