"""Reading and previewing import files (F-2.1 to F-2.4), without a data core."""

import json
from pathlib import Path

import pytest
from import_files import LV95, make_files, sample_features

from geotandem.importing import ReadOptions, SourceError, build_preview, read_source
from geotandem.importing.names import identifier, unique_identifiers
from geotandem.importing.values import infer

GEMEINDEN_KEYS = {
    ("gemeinden", "gem_nr"): {str(f["properties"]["gem_nr"]) for f in sample_features("gemeinden")}
}


@pytest.fixture(scope="module")
def files(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    return make_files(tmp_path_factory.mktemp("import"))


def preview(path: Path, options: ReadOptions | None = None, **kwargs):  # type: ignore[no-untyped-def]
    return build_preview(read_source(path, path.name, options), LV95, **kwargs)


# --- names --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Einwohner (2024)", "einwohner_2024"),
        ("Höhe ü. M.", "hoehe_ue_m"),
        ("Straße", "strasse"),
        ("2025", "feld_2025"),
        ("  ", "feld"),
        ("Résumé", "resume"),
        ("x" * 80, "x" * 63),
    ],
)
def test_identifier(text: str, expected: str) -> None:
    assert identifier(text) == expected


def test_unique_identifiers_avoid_reserved_and_duplicates() -> None:
    assert unique_identifiers(["fid", "Name", "name", "NAME", "geom"]) == [
        "fid_2",
        "name",
        "name_2",
        "name_3",
        "geom_2",
    ]


# --- type inference -----------------------------------------------------------


@pytest.mark.parametrize(
    ("cells", "data_type", "values"),
    [
        (["1", "2", ""], "integer", [1, 2, None]),
        (["0999", "1203"], "text", ["0999", "1203"]),  # area key keeps its zeros
        (["3,5", "4", "-0,25"], "real", [3.5, 4.0, -0.25]),
        (["3.5", "1e3"], "real", [3.5, 1000.0]),
        (["true", "FALSE"], "boolean", [True, False]),
        (["1", "a"], "text", ["1", "a"]),
        ([None, " "], "text", [None, None]),
        ([1, 2.5], "real", [1.0, 2.5]),
        ([3.0, "x"], "text", ["3", "x"]),
        (["99999999999999999999"], "text", ["99999999999999999999"]),
    ],
)
def test_infer(cells: list[object], data_type: str, values: list[object]) -> None:
    assert infer(cells)[:2] == (data_type, values)


# --- vector -------------------------------------------------------------------


def test_geojson(files: dict[str, Path]) -> None:
    p = preview(files["schulen.geojson"])
    assert (p.format, p.record_count, p.geometry_type, p.crs) == ("geojson", 137, "Point", 4326)
    assert [(c.name, c.data_type) for c in p.columns] == [
        ("name", "text"),
        ("typ", "text"),
        ("standorte", "integer"),
    ]
    typ = p.columns[1]
    assert typ.value_domain == {
        "codes": {c: c for c in ("kindergarten", "primar", "sekundar", "spezial")}
    }
    assert p.columns[2].value_domain is not None and set(p.columns[2].value_domain) == {
        "min",
        "max",
    }
    assert p.bbox_wgs84 == p.bbox
    assert (p.layer_name, p.title) == ("schulen", "schulen")
    assert p.errors == [] and p.warnings == []


def test_shapefile_zip_with_prj(files: dict[str, Path]) -> None:
    p = preview(files["gemeinden.zip"])
    assert (p.format, p.record_count, p.crs) == ("shapefile", 74, LV95)
    assert p.geometry_type in ("Polygon", "MultiPolygon")
    assert p.bbox_wgs84 is not None and 7 < p.bbox_wgs84[0] < 8
    assert p.errors == []


def test_shapefile_without_prj_needs_a_crs(files: dict[str, Path]) -> None:
    p = preview(files["gemeinden_ohne_prj.zip"])
    assert p.crs is None and p.bbox_wgs84 is None
    assert [e.code for e in p.errors] == ["crs_unknown"]


def test_geopackage_layers(files: dict[str, Path]) -> None:
    p = preview(files["netz.gpkg"])
    assert p.sublayers == ["strassen", "gewaesser"]
    assert (p.options.sublayer, p.record_count, p.title) == ("strassen", 179, "strassen")
    p = preview(files["netz.gpkg"], ReadOptions(sublayer="gewaesser"))
    assert (p.record_count, p.layer_name) == (66, "gewaesser")
    with pytest.raises(SourceError) as info:
        preview(files["netz.gpkg"], ReadOptions(sublayer="bahn"))
    assert info.value.code == "unknown_sublayer"


def test_invalid_and_missing_geometries_are_warnings(tmp_path: Path) -> None:
    bowtie = [[7, 46], [8, 47], [8, 46], [7, 47], [7, 46]]
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
    p = preview(path)
    assert sorted(w.code for w in p.warnings) == ["invalid_geometry", "missing_geometry"]
    assert p.errors == []


def test_taken_layer_name_gets_a_suffix(files: dict[str, Path]) -> None:
    assert (
        preview(files["schulen.geojson"], taken_layer_names={"schulen"}).layer_name == "schulen_2"
    )


# --- tabular ------------------------------------------------------------------


def test_csv_semicolon_comma_cp1252(files: dict[str, Path]) -> None:
    p = preview(files["messstellen.csv"])
    assert (p.options.delimiter, p.options.encoding) == (";", "cp1252")
    assert [w.code for w in p.warnings] == ["encoding_fallback"]
    assert [(c.source_name, c.name, c.data_type) for c in p.columns] == [
        ("Nr", "nr", "integer"),
        ("Bezeichnung", "bezeichnung", "text"),
        ("Höhe ü. M.", "hoehe_ue_m", "real"),
        ("E", "e", "real"),
        ("N", "n", "real"),
    ]
    assert p.xy is not None and (p.xy.x, p.xy.y, p.xy.crs) == ("E", "N", LV95)
    assert p.geometry_type is None and p.record_count == 21
    assert p.sample_rows[0]["hoehe_ue_m"] == 450.5


def test_csv_options_override_detection(files: dict[str, Path]) -> None:
    p = preview(files["messstellen.csv"], ReadOptions(delimiter=",", encoding="cp1252"))
    assert len(p.columns) == 1 or any(w.code == "single_column" for w in p.warnings)
    with pytest.raises(SourceError) as info:
        preview(files["messstellen.csv"], ReadOptions(encoding="utf-8"))
    assert info.value.code == "unreadable_encoding"


def test_xlsx_key_proposal_and_dates(files: dict[str, Path]) -> None:
    p = preview(files["kennzahlen.xlsx"], key_candidates=GEMEINDEN_KEYS)
    assert (p.sublayers, p.title) == (["Kennzahlen 2025"], "kennzahlen")
    assert [(c.name, c.data_type) for c in p.columns] == [
        ("gem_nr", "integer"),
        ("arbeitsplaetze", "integer"),
        ("stichtag", "date"),
    ]
    assert [(k.column, k.layer, k.attribute, k.matched, k.total) for k in p.keys] == [
        ("Gem-Nr", "gemeinden", "gem_nr", 74, 76)
    ]
    # Excel keeps dates as datetimes at midnight: they are dates (plan E1.8, G3).
    assert p.warnings == []
    assert str(p.sample_rows[0]["stichtag"]) == "2025-01-01"
    assert p.xy is None


def test_table_without_geo_reference_warns(tmp_path: Path) -> None:
    path = tmp_path / "liste.csv"
    path.write_text("a,b\n1,2\n", "utf-8")
    p = preview(path)
    assert [w.code for w in p.warnings] == ["no_geo_reference_found"]


# --- unreadable ---------------------------------------------------------------


def test_unsupported_and_unreadable_files(tmp_path: Path) -> None:
    with pytest.raises(SourceError) as info:
        read_source(tmp_path / "x.dxf", "x.dxf")
    assert info.value.code == "unsupported_format"
    broken = tmp_path / "kaputt.gpkg"
    broken.write_bytes(b"not a geopackage")
    with pytest.raises(SourceError) as info:
        read_source(broken, broken.name)
    assert info.value.code == "unreadable"
    empty = tmp_path / "leer.csv"
    empty.write_text("", "utf-8")
    with pytest.raises(SourceError) as info:
        read_source(empty, empty.name)
    assert info.value.code == "empty"
