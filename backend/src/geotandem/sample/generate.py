"""Deterministic generator of the synthetic sample region "Tandemtal" (F-10.5).

Geometry is designed in LV95 (EPSG:2056) metres and written as RFC 7946
GeoJSON in WGS84; the table layer is CSV. Run ``geotandem sample generate``
after changing this file and bump ``DATASET_VERSION``: evaluation runs
(bewertung.md) refer to a fixed data state.

Region: 12 x 9 km, 4 x 3 municipalities with jittered shared corners, a river
("Tand") with a tributary, a few roads, 120 schools, a population table.
"""

import csv
import hashlib
import json
import math
import random
from pathlib import Path
from typing import Any

from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.geometry.base import BaseGeometry

from geotandem.geo import WGS84, reprojector
from geotandem.sample import DATA_DIR

DATASET_VERSION = "tandemtal-1"
SEED = 20260930
LV95 = 2056
X0, Y0 = 2_630_000.0, 1_190_000.0  # south-west corner, central Swiss Plateau
CELL = 3_000.0
COLS, ROWS = 4, 3
COORD_DECIMALS = 7

Rows = list[tuple[BaseGeometry, dict[str, Any]]]

MUNICIPALITIES = [
    "Brunnwil", "Eggberg", "Farnach", "Grundmatt",
    "Hohwil", "Kellenberg", "Lindwil", "Moosegg",
    "Nidfeld", "Oberried", "Rütiwil", "Sonnhalden",
]  # fmt: skip

LAYERS: list[dict[str, Any]] = [
    {
        "name": "gemeinden",
        "title": "Gemeinden",
        "description": "Politische Gemeinden des Tandemtals.",
        "kind": "vector",
        "file": "gemeinden.geojson",
        "attributes": [
            {"name": "gem_nr", "data_type": "integer", "label": "Gemeindenummer",
             "description": "Amtlicher Gemeindeschlüssel, Schlüssel für Sachdaten."},
            {"name": "name", "data_type": "text", "label": "Gemeindename"},
            {"name": "flaeche_km2", "data_type": "real", "label": "Fläche", "unit": "km²"},
        ],
    },
    {
        "name": "gewaesser",
        "title": "Gewässer",
        "description": "Fliessgewässer: der Fluss Tand und der Bruggbach.",
        "kind": "vector",
        "file": "gewaesser.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Name"},
            {"name": "typ", "data_type": "text", "label": "Gewässertyp",
             "value_domain": {"codes": {"fluss": "Fluss", "bach": "Bach"}}},
        ],
    },
    {
        "name": "strassen",
        "title": "Strassen",
        "description": "Haupt- und Nebenstrassen.",
        "kind": "vector",
        "file": "strassen.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Name"},
            {"name": "klasse", "data_type": "text", "label": "Strassenklasse",
             "value_domain": {"codes": {"haupt": "Hauptstrasse", "neben": "Nebenstrasse"}}},
        ],
    },
    {
        "name": "schulen",
        "title": "Schulen",
        "description": "Schulstandorte mit Schulstufe und Anzahl Schülerinnen und Schüler.",
        "kind": "vector",
        "file": "schulen.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Schulname"},
            {"name": "typ", "data_type": "text", "label": "Schulstufe",
             "value_domain": {"codes": {"kindergarten": "Kindergarten", "primar": "Primarschule",
                                        "sekundar": "Sekundarschule"}}},
            {"name": "schueler", "data_type": "integer", "label": "Schülerzahl",
             "unit": "Personen", "value_domain": {"min": 10, "max": 900}},
        ],
    },
    {
        "name": "bevoelkerung",
        "title": "Bevölkerung",
        "description": "Bevölkerungsstatistik je Gemeinde, Stichtag 31.12.2025.",
        "kind": "table",
        "file": "bevoelkerung.csv",
        "attributes": [
            {"name": "gem_nr", "data_type": "integer", "label": "Gemeindenummer",
             "description": "Schlüssel auf gemeinden.gem_nr."},
            {"name": "einwohner", "data_type": "integer", "label": "Einwohner",
             "unit": "Personen"},
            {"name": "anteil_u20", "data_type": "real", "label": "Anteil unter 20 Jahren",
             "unit": "%", "value_domain": {"min": 0, "max": 100}},
        ],
    },
]  # fmt: skip


def _corners(rng: random.Random) -> dict[tuple[int, int], tuple[float, float]]:
    """Grid corners; interior ones jittered so neighbours share exact vertices."""
    corners = {}
    for i in range(COLS + 1):
        for j in range(ROWS + 1):
            x, y = X0 + i * CELL, Y0 + j * CELL
            if 0 < i < COLS:
                x += rng.uniform(-600, 600)
            if 0 < j < ROWS:
                y += rng.uniform(-600, 600)
            corners[i, j] = (round(x, 1), round(y, 1))
    return corners


def municipalities(rng: random.Random) -> Rows:
    c = _corners(rng)
    result = []
    for j in range(ROWS):
        for i in range(COLS):
            n = j * COLS + i
            poly = Polygon([c[i, j], c[i + 1, j], c[i + 1, j + 1], c[i, j + 1]])
            result.append(
                (poly, {"gem_nr": 101 + n, "name": MUNICIPALITIES[n],
                        "flaeche_km2": round(poly.area / 1e6, 3)})
            )  # fmt: skip
    return result


def waters() -> Rows:
    tand = LineString(
        [(X0 - 500 + k * 200, Y0 + 4_500 + 1_500 * math.sin(k * 200 / 2_000)) for k in range(66)]
    )
    brugg = LineString(
        [(X0 + 7_400 + 400 * math.sin(k / 3), Y0 + 9_500 - k * 250) for k in range(21)]
    )
    return [(tand, {"name": "Tand", "typ": "fluss"}), (brugg, {"name": "Bruggbach", "typ": "bach"})]


def roads() -> Rows:
    return [
        (LineString([(X0 - 200, Y0 + 800), (X0 + 6_000, Y0 + 4_000), (X0 + 12_200, Y0 + 8_600)]),
         {"name": "Talstrasse", "klasse": "haupt"}),
        (LineString([(X0 + 3_000, Y0 - 200), (X0 + 3_300, Y0 + 9_200)]),
         {"name": "Eggbergstrasse", "klasse": "neben"}),
        (LineString([(X0 + 9_000, Y0 + 9_200), (X0 + 8_600, Y0 + 5_000), (X0 + 10_500, Y0 - 200)]),
         {"name": "Riedweg", "klasse": "neben"}),
    ]  # fmt: skip


def schools(rng: random.Random) -> Rows:
    kinds = ["kindergarten", "primar", "sekundar"]
    sizes = {"kindergarten": (10, 60), "primar": (80, 450), "sekundar": (200, 900)}
    result = []
    for k in range(120):
        typ = rng.choices(kinds, weights=[3, 5, 2])[0]
        x = X0 + rng.uniform(100, COLS * CELL - 100)
        y = Y0 + rng.uniform(100, ROWS * CELL - 100)
        result.append(
            (Point(round(x, 1), round(y, 1)),
             {"name": f"Schule {k + 1:03d}", "typ": typ, "schueler": rng.randint(*sizes[typ])})
        )  # fmt: skip
    return result


def population(rng: random.Random, gem: Rows) -> list[dict[str, Any]]:
    return [
        {"gem_nr": attrs["gem_nr"],
         "einwohner": rng.randint(800, 12_000),
         "anteil_u20": round(rng.uniform(15, 28), 1)}
        for _, attrs in gem
    ]  # fmt: skip


def _feature_collection(rows: Rows) -> str:
    to_wgs84 = reprojector(LV95, WGS84)
    features = []
    for geom, attrs in rows:
        g = mapping(to_wgs84(geom))
        g["coordinates"] = _round(g["coordinates"])
        features.append({"type": "Feature", "properties": attrs, "geometry": g})
    return json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, COORD_DECIMALS)
    return [_round(v) for v in value]


def generate(target: Path = DATA_DIR) -> dict[str, Any]:
    """Write all files plus ``metadata.json`` and ``manifest.json``; return the manifest."""
    rng = random.Random(SEED)
    gem = municipalities(rng)
    contents = {
        "gemeinden.geojson": _feature_collection(gem),
        "gewaesser.geojson": _feature_collection(waters()),
        "strassen.geojson": _feature_collection(roads()),
        "schulen.geojson": _feature_collection(schools(rng)),
    }
    rows = population(rng, gem)
    target.mkdir(parents=True, exist_ok=True)
    with (target / "bevoelkerung.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    for name, content in contents.items():
        (target / name).write_text(content + "\n", encoding="utf-8")
    metadata = {"version": DATASET_VERSION, "source_crs": WGS84, "layers": LAYERS}
    (target / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    files = sorted([*contents, "bevoelkerung.csv", "metadata.json"])
    manifest = {
        "version": DATASET_VERSION,
        "files": {f: hashlib.sha256((target / f).read_bytes()).hexdigest() for f in files},
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest
