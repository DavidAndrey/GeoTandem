"""Import test files, derived from the sample dataset so results are checkable.

Generated at test time rather than committed: GeoPackage and Excel files
embed timestamps and would never be byte-stable.
"""

import json
import shutil
import warnings
import zipfile
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import openpyxl
import pyogrio.raw
import shapely
from shapely.geometry import MultiLineString, MultiPoint, MultiPolygon, shape

from geotandem.geo import WGS84, reprojector
from geotandem.sample import DATA_DIR

LV95 = 2056


def sample_features(layer: str) -> list[dict[str, Any]]:
    data = json.loads((DATA_DIR / f"{layer}.geojson").read_text("utf-8"))
    features: list[dict[str, Any]] = data["features"]
    return features


def _write(
    path: Path,
    features: list[dict[str, Any]],
    *,
    driver: str,
    crs: int | None,
    layer: str | None = None,
    append: bool = False,
    to: int = WGS84,
) -> None:
    project = reprojector(WGS84, to)
    geometries = [project(shape(f["geometry"])) for f in features]
    with warnings.catch_warnings():
        # Shapefile cuts field names to 10 characters and says so; that is the format.
        warnings.filterwarnings("ignore", "Normalized/laundered field name")
        _raw_write(path, geometries, features, driver, crs, layer, append)


def _raw_write(
    path: Path,
    geometries: list[Any],
    features: list[dict[str, Any]],
    driver: str,
    crs: int | None,
    layer: str | None,
    append: bool,
) -> None:
    names = list(features[0]["properties"])
    if len({g.geom_type for g in geometries}) > 1:  # one geometry type per file layer
        multi = {"Point": MultiPoint, "LineString": MultiLineString, "Polygon": MultiPolygon}
        geometries = [multi[g.geom_type]([g]) if g.geom_type in multi else g for g in geometries]
    pyogrio.raw.write(
        path,
        geometry=shapely.to_wkb(geometries),
        field_data=[np.array([f["properties"][n] for f in features]) for n in names],
        fields=names,
        crs=f"EPSG:{crs}" if crs else None,
        geometry_type=geometries[0].geom_type,
        driver=driver,
        layer=layer,
        append=append,
    )


def make_files(directory: Path) -> dict[str, Path]:
    # GDAL appends to an existing GeoPackage, so a re-run must start empty.
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True)
    files: dict[str, Path] = {}

    # GeoJSON, WGS84: the sample schools with a text, a code and a number attribute.
    schools = [
        {**f, "properties": {k: f["properties"][k] for k in ("name", "typ", "standorte")}}
        for f in sample_features("schulen")
    ]
    files["schulen.geojson"] = directory / "schulen.geojson"
    files["schulen.geojson"].write_text(
        json.dumps({"type": "FeatureCollection", "features": schools}, ensure_ascii=False),
        encoding="utf-8",
    )

    # Shapefile in LV95, zipped, with and without .prj.
    shp_dir = directory / "shp"
    shp_dir.mkdir(exist_ok=True)
    _write(
        shp_dir / "gemeinden.shp",
        sample_features("gemeinden"),
        driver="ESRI Shapefile",
        crs=LV95,
        to=LV95,
    )
    for name, skip in (("gemeinden.zip", None), ("gemeinden_ohne_prj.zip", ".prj")):
        files[name] = directory / name
        with zipfile.ZipFile(files[name], "w") as archive:
            for part in sorted(shp_dir.iterdir()):
                if part.suffix != skip:
                    archive.write(part, part.name)

    # GeoPackage with two layers, LV95.
    files["netz.gpkg"] = directory / "netz.gpkg"
    _write(
        files["netz.gpkg"],
        sample_features("strassen"),
        driver="GPKG",
        crs=LV95,
        layer="strassen",
        to=LV95,
    )
    _write(
        files["netz.gpkg"],
        sample_features("gewaesser"),
        driver="GPKG",
        crs=LV95,
        layer="gewaesser",
        append=True,
        to=LV95,
    )

    # CSV as Swiss/German offices write it: semicolon, decimal comma, Windows-1252,
    # LV95 coordinates of the first 20 schools, one row without coordinates.
    to_lv95 = reprojector(WGS84, LV95)
    lines = ["Nr;Bezeichnung;Höhe ü. M.;E;N"]
    for i, f in enumerate(sample_features("schulen")[:20]):
        p = to_lv95(shape(f["geometry"]))
        lines.append(
            f"{i + 1};Messstelle {i + 1};{450 + i},5;{p.x:.2f};{p.y:.2f}".replace(".", ",")
        )
    lines.append("21;Ohne Lage;500,0;;")
    files["messstellen.csv"] = directory / "messstellen.csv"
    files["messstellen.csv"].write_bytes(("\r\n".join(lines) + "\r\n").encode("cp1252"))

    # Excel keyed by municipality number; two keys without a municipality.
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = "Kennzahlen 2025"
    sheet.append(["Gem-Nr", "Arbeitsplätze", "Stichtag"])
    for f in sample_features("gemeinden"):
        sheet.append([f["properties"]["gem_nr"], f["properties"]["gem_nr"] * 10, date(2025, 1, 1)])
    sheet.append([998, 1, date(2025, 1, 1)])
    sheet.append([999, 2, date(2025, 1, 1)])
    files["kennzahlen.xlsx"] = directory / "kennzahlen.xlsx"
    workbook.save(files["kennzahlen.xlsx"])

    return files


if __name__ == "__main__":
    # Used by the Playwright suite: `python backend/tests/import_files.py <dir>`.
    import sys

    for path in make_files(Path(sys.argv[1])).values():
        print(path)
