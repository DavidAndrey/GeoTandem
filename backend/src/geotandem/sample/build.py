"""The sample dataset "Bern-Mittelland" from open data of the canton of Bern (F-10.5).

Real data, so features line up with the swisstopo basemap. Source: Amt für
Geoinformation des Kantons Bern (AGI), published on opendata.swiss under
"terms_open" (free use, including commercial).

Two steps, so a running instance never needs the network:

- ``fetch`` downloads the source GeoPackages into a cache directory. It runs
  only on request: ``geotandem sample update``.
- ``build`` derives the committed files in ``sample/data`` from that cache:
  restricted to the Verwaltungskreis Bern-Mittelland, reshaped to the
  attributes in ``LAYERS``, written as RFC 7946 GeoJSON in WGS84 plus CSV.
  ``geotandem sample update --offline`` reruns it from the cache.

The dataset version is the fetch date; the manifest pins every source by
SHA-256. Evaluation runs (bewertung.md) refer to a fixed data state, so an
update is a deliberate change: rerun the golden tests afterwards.
"""

import csv
import hashlib
import json
import os
import shutil
import urllib.request
import warnings
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pyogrio.raw
import shapely
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

from geotandem.geo import WGS84, reprojector
from geotandem.sample import DATA_DIR

LV95 = 2056
REGION = 246  # Verwaltungskreis Bern-Mittelland
REGION_NAME = "bern-mittelland"
COORD_DECIMALS = 7
LINE_TOLERANCE_M = 2.0
MIN_SIDE_STREAM_M = 5_000.0  # Nebengewässer shorter than this are left out
MIN_MAIN_RIVER_M = 500.0  # drops slivers where a river touches the clip border
CLIP_MARGIN_M = 1_000.0  # lines are clipped this far outside, so border rivers stay whole

DOWNLOAD_URL = "https://geofiles.be.ch/geoportal/pub/download/{code}/{name}.gpkg.zip"
DETAIL_URL = (
    "https://www.agi.dij.be.ch/de/start/geoportal/geodaten/detail.html?type=geoproduct&code={code}"
)
SOURCES = {
    "GENGRZ5": "Politische Grenzen generalisiert",
    "GNBE": "Gewässernetz des Kantons Bern",
    "UESN": "Übergeordnetes Strassennetz des Kantons Bern",
    "OEVSCHUL": "Volksschulen",
    "OEVTP": "Öffentlicher Verkehr",
    "ADMGDE": "Gemeindedaten",
    "STEUERN": "Steueranlagen pro Gemeinde",
}
LICENSE = "opendata.swiss terms_open"
FETCHED = "fetched.json"
USER_AGENT = "geotandem-sample-update"

Rows = list[tuple[BaseGeometry, dict[str, Any]]]

ROAD_CLASSES = {
    "nationalstrasse": (9, 10, 11, 12, 13),
    "kantonsstrasse_a": (1, 2),
    "kantonsstrasse_b": (3,),
    "kantonsstrasse_c": (4,),
    "gemeindestrasse": (19,),
}  # UESN "kategorie"; ramps, cycle paths and planned roads are left out
TRANSPORT = {1: "bahn", 2: "bus", 4: "tram", 5: "seilbahn", 6: "schiff"}  # 3 = night line
STOP_CATEGORY = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI"}  # 0 = none

LAYERS: list[dict[str, Any]] = [
    {
        "name": "gemeinden",
        "title": "Gemeinden",
        "description": "Politische Gemeinden des Verwaltungskreises Bern-Mittelland "
                       "(AGI: Politische Grenzen generalisiert).",
        "kind": "vector",
        "file": "gemeinden.geojson",
        "attributes": [
            {"name": "gem_nr", "data_type": "integer", "label": "Gemeindenummer",
             "description": "BFS-Gemeindenummer, Schlüssel für Sachdaten."},
            {"name": "name", "data_type": "text", "label": "Gemeindename"},
            {"name": "flaeche_km2", "data_type": "real", "label": "Fläche", "unit": "km²"},
        ],
    },
    {
        "name": "gewaesser",
        "title": "Gewässer",
        "description": "Fliessgewässer: alle Hauptgewässer und Nebengewässer ab 5 km Länge, "
                       "je zusammenhängender Abschnitt, bis 1 km über die Kreisgrenze "
                       "(AGI: Gewässernetz des Kantons Bern).",
        "kind": "vector",
        "file": "gewaesser.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Name"},
            {"name": "typ", "data_type": "text", "label": "Gewässerklasse",
             "value_domain": {"codes": {"haupt": "Hauptgewässer", "neben": "Nebengewässer"}}},
            {"name": "laenge_km", "data_type": "real", "label": "Länge im Gebiet",
             "unit": "km"},
        ],
    },
    {
        "name": "strassen",
        "title": "Strassen",
        "description": "Übergeordnetes Strassennetz, je Strassenachse, bis 1 km über die "
                       "Kreisgrenze "
                       "(AGI: Übergeordnetes Strassennetz des Kantons Bern).",
        "kind": "vector",
        "file": "strassen.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Achsname"},
            {"name": "nummer", "data_type": "text", "label": "Achsnummer"},
            {"name": "klasse", "data_type": "text", "label": "Strassenklasse",
             "value_domain": {"codes": {
                 "nationalstrasse": "Nationalstrasse",
                 "kantonsstrasse_a": "Kantonsstrasse Kategorie A",
                 "kantonsstrasse_b": "Kantonsstrasse Kategorie B",
                 "kantonsstrasse_c": "Kantonsstrasse Kategorie C",
                 "gemeindestrasse": "Wichtige Gemeindestrasse"}}},
        ],
    },
    {
        "name": "schulen",
        "title": "Schulen",
        "description": "Öffentliche Volksschulen mit angebotenen Stufen (AGI: Volksschulen).",
        "kind": "vector",
        "file": "schulen.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Schulname"},
            {"name": "gem_nr", "data_type": "integer", "label": "Gemeindenummer",
             "description": "Schulgemeinde; Schlüssel auf gemeinden.gem_nr."},
            {"name": "typ", "data_type": "text", "label": "Höchste Schulstufe",
             "value_domain": {"codes": {"kindergarten": "Kindergarten", "primar": "Primarstufe",
                                        "sekundar": "Sekundarstufe I",
                                        "spezial": "Nur besondere Förderung"}}},
            {"name": "kindergarten", "data_type": "boolean", "label": "Mit Kindergarten"},
            {"name": "primarstufe", "data_type": "boolean", "label": "Mit Primarstufe"},
            {"name": "sekundarstufe", "data_type": "boolean", "label": "Mit Sekundarstufe I"},
            {"name": "sprache", "data_type": "text", "label": "Unterrichtssprache",
             "value_domain": {"codes": {"de": "Deutsch", "fr": "Französisch"}}},
            {"name": "standorte", "data_type": "integer", "label": "Anzahl Schulhäuser",
             "value_domain": {"min": 0, "max": 50}},
        ],
    },
    {
        "name": "haltestellen",
        "title": "Haltestellen",
        "description": "Haltestellen des öffentlichen Verkehrs ohne Nachtlinien, mit Kategorie "
                       "nach kantonalem Richtplan und Einzugsgebiet (AGI: Öffentlicher Verkehr).",
        "kind": "vector",
        "file": "haltestellen.geojson",
        "attributes": [
            {"name": "name", "data_type": "text", "label": "Haltestelle"},
            {"name": "verkehrsmittel", "data_type": "text", "label": "Verkehrsmittel",
             "value_domain": {"codes": {"bahn": "Bahn", "tram": "Tram", "bus": "Bus",
                                        "seilbahn": "Seilbahn", "schiff": "Schiff"}}},
            {"name": "kategorie", "data_type": "text", "label": "Haltestellenkategorie",
             "description": "I (beste) bis VI, leer wenn ohne Kategorie; Grundlage der "
                            "ÖV-Erschliessungsgüteklasse.",
             "value_domain": {"codes": {c: c for c in STOP_CATEGORY.values()}}},
            {"name": "einwohner", "data_type": "integer", "label": "Einwohner im Einzugsgebiet",
             "unit": "Personen"},
            {"name": "arbeitsplaetze", "data_type": "integer",
             "label": "Arbeitsplätze im Einzugsgebiet", "unit": "Stellen"},
        ],
    },
    {
        "name": "gemeindedaten",
        "title": "Gemeindedaten",
        "description": "Einwohnerzahl und Steuern je Gemeinde "
                       "(AGI: Gemeindedaten, Steueranlagen pro Gemeinde).",
        "kind": "table",
        "file": "gemeindedaten.csv",
        "attributes": [
            {"name": "gem_nr", "data_type": "integer", "label": "Gemeindenummer",
             "description": "Schlüssel auf gemeinden.gem_nr."},
            {"name": "einwohner", "data_type": "integer", "label": "Einwohner",
             "unit": "Personen"},
            {"name": "steueranlage", "data_type": "real", "label": "Steueranlage",
             "description": "Vielfaches der einfachen Steuer."},
            {"name": "steuerpflichtige", "data_type": "integer", "label": "Steuerpflichtige",
             "unit": "Personen"},
            {"name": "steuerjahr", "data_type": "integer", "label": "Steuerjahr"},
        ],
    },
]  # fmt: skip


# --- fetch (network, on request only) ------------------------------------------


def fetch(cache: Path) -> dict[str, Any]:
    """Download every source into ``cache`` and record when and what was fetched."""
    cache.mkdir(parents=True, exist_ok=True)
    files = {}
    for code in SOURCES:
        url = DOWNLOAD_URL.format(code=code, name=code.lower())
        target = _archive(cache, code)
        partial = target.with_suffix(".part")
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=300) as response, partial.open("wb") as f:
            shutil.copyfileobj(response, f)
        partial.replace(target)
        files[code] = _sha256(target)
    fetched = {"date": datetime.now(UTC).date().isoformat(), "files": files}
    (cache / FETCHED).write_text(json.dumps(fetched, indent=2) + "\n", encoding="utf-8")
    return fetched


def _archive(cache: Path, code: str) -> Path:
    return cache / f"{code.lower()}.gpkg.zip"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# --- build (offline) -----------------------------------------------------------


class Sources:
    """Read access to the fetched GeoPackages, checked against ``fetched.json``."""

    def __init__(self, cache: Path) -> None:
        path = cache / FETCHED
        if not path.exists():
            raise FileNotFoundError(f"no fetched sources in {cache}; run without --offline")
        self.cache = cache
        self.fetched: dict[str, Any] = json.loads(path.read_text("utf-8"))
        for code, digest in self.fetched["files"].items():
            if _sha256(_archive(cache, code)) != digest:
                raise ValueError(f"{_archive(cache, code)} does not match {FETCHED}")

    def read(
        self, code: str, table: str, *, geometry: bool = True, **kwargs: Any
    ) -> list[tuple[BaseGeometry | None, dict[str, Any]]]:
        path = f"/vsizip/{_archive(self.cache, code)}/{code}.gpkg"
        layer = f"geodb.{code.lower()}_{table}_vw"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # "TEXT (20)" field formats
            warnings.simplefilter("ignore", DeprecationWarning)  # pyogrio on NumPy datetimes
            meta, _, geoms, fields = pyogrio.raw.read(
                path, layer=layer, read_geometry=geometry, **kwargs
            )
        names = list(meta["fields"])
        count = len(fields[0]) if len(fields) else len(geoms)
        shapes = shapely.from_wkb(geoms) if geometry else [None] * count
        return [
            (shapes[i], {n: _plain(column[i]) for n, column in zip(names, fields, strict=True)})
            for i in range(count)
        ]


def _plain(value: Any) -> Any:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, str):
        value = " ".join(value.replace("\xa0", " ").split()) or None
    return value


def municipalities(src: Sources) -> Rows:
    rows = src.read("GENGRZ5", "geng5", where=f"vkreisnr = {REGION} AND see = 0")
    result = [
        (geom, {"gem_nr": a["bfsnr"], "name": a["gemname"],
                "flaeche_km2": round(geom.area / 1e6, 3)})
        for geom, a in rows if geom is not None
    ]  # fmt: skip
    return sorted(result, key=lambda r: r[1]["gem_nr"])


def waters(src: Sources, clip: BaseGeometry) -> Rows:
    """Rivers and canals, merged per name and split into connected stretches.

    Piped and bridged sections are kept, so a river is not cut where it passes
    under a road.
    """
    columns = ["oname", "objektart", "klass"]
    parts: dict[str, list[tuple[BaseGeometry, bool]]] = defaultdict(list)
    for geom, a in src.read("GNBE", "gnbeab", bbox=clip.bounds, columns=columns):
        if geom is None or not a["oname"] or a["objektart"] not in (5, 8):
            continue  # 5 = Fliessgewässer, 8 = Kanal
        if a["klass"] in (1, 2):  # Hauptgewässer, Nebengewässer
            parts[a["oname"]].append((geom, a["klass"] == 1))
    result = []
    for name, segments in parts.items():
        main = shapely.union_all([g for g, is_main in segments if is_main])
        merged = shapely.line_merge(shapely.union_all([g for g, _ in segments]))
        for stretch in _connected(shapely.intersection(merged, clip)):
            is_main = not main.is_empty and stretch.intersects(main)
            if stretch.length < (MIN_MAIN_RIVER_M if is_main else MIN_SIDE_STREAM_M):
                continue
            result.append(
                (stretch.simplify(LINE_TOLERANCE_M),
                 {"name": name, "typ": "haupt" if is_main else "neben",
                  "laenge_km": round(stretch.length / 1000, 2)})
            )  # fmt: skip
    return sorted(result, key=lambda r: (r[1]["name"], r[0].bounds))


def _connected(geom: BaseGeometry) -> list[BaseGeometry]:
    """Group the line parts of ``geom`` into touching clusters, one geometry each."""
    lines = [g for g in shapely.get_parts(geom) if g.geom_type == "LineString" and g.length > 0]
    group = list(range(len(lines)))

    def root(i: int) -> int:
        while group[i] != i:
            group[i] = group[group[i]]
            i = group[i]
        return i

    if not lines:
        return []
    tree = shapely.STRtree(lines)
    for i, j in zip(
        *tree.query(np.array(lines, dtype=object), predicate="intersects"), strict=True
    ):
        group[root(int(i))] = root(int(j))
    clusters: dict[int, list[BaseGeometry]] = defaultdict(list)
    for i, line in enumerate(lines):
        clusters[root(i)].append(line)
    return [shapely.line_merge(shapely.union_all(c)) for c in clusters.values()]


def roads(src: Sources, clip: BaseGeometry) -> Rows:
    klasse = {code: name for name, codes in ROAD_CLASSES.items() for code in codes}
    axes: dict[tuple[str, str, str], list[BaseGeometry]] = defaultdict(list)
    for geom, a in src.read("UESN", "uesnab", bbox=clip.bounds):
        if geom is not None and a["kategorie"] in klasse:
            key = (klasse[a["kategorie"]], a["uesnaxt_axnummer"], a["uesnaxt_axname"])
            axes[key].append(geom)
    order = list(ROAD_CLASSES)
    result = []
    for (cls, nummer, name), geoms in axes.items():
        clipped = shapely.intersection(shapely.line_merge(shapely.union_all(geoms)), clip)
        if clipped.length > 0:
            result.append(
                (_lines(clipped).simplify(LINE_TOLERANCE_M),
                 {"name": name, "nummer": nummer, "klasse": cls})
            )  # fmt: skip
    return sorted(result, key=lambda r: (order.index(r[1]["klasse"]), r[1]["nummer"] or ""))


def _lines(geom: BaseGeometry) -> BaseGeometry:
    """Only the linear parts: a clip can leave single points on the region border."""
    parts = [g for g in shapely.get_parts(geom) if g.geom_type == "LineString"]
    return shapely.line_merge(shapely.MultiLineString(parts)) if len(parts) > 1 else parts[0]


def schools(src: Sources, region: BaseGeometry) -> Rows:
    sites: dict[int, int] = defaultdict(int)
    for _, a in src.read("OEVSCHUL", "schulsto", geometry=False, columns=["soekey"]):
        sites[a["soekey"]] += 1
    result = []
    for geom, a in src.read("OEVSCHUL", "soe", bbox=region.bounds):
        if geom is None or not region.contains(geom):
            continue
        offers = {k for k, v in a.items() if v == "TRUE"}
        kindergarten = bool(offers & {"kindergart", "basisstufe"})
        primar = bool(offers & {"primschul", "basisstufe", "cycleelem"})
        sekundar = bool(offers & {"realschul", "sekschul"})
        typ = ("sekundar" if sekundar else "primar" if primar
               else "kindergarten" if kindergarten else "spezial")  # fmt: skip
        result.append(
            (a["soekey"], geom,
             {"name": a["soename"], "gem_nr": a["bfsnr"], "typ": typ,
              "kindergarten": kindergarten, "primarstufe": primar, "sekundarstufe": sekundar,
              "sprache": "fr" if a["sprache"] == 1 else "de", "standorte": sites[a["soekey"]]})
        )  # fmt: skip
    return [(geom, attrs) for _, geom, attrs in sorted(result, key=lambda r: r[0])]


def stops(src: Sources, region: BaseGeometry) -> Rows:
    result = []
    for geom, a in src.read("OEVTP", "halt", bbox=region.bounds):
        if geom is None or a["vkmtyp"] not in TRANSPORT or not region.contains(geom):
            continue
        result.append(
            (a["haltnr"], geom,
             {"name": a["haltbez"], "verkehrsmittel": TRANSPORT[a["vkmtyp"]],
              "kategorie": STOP_CATEGORY.get(a["egk"]), "einwohner": a["bevoelk"],
              "arbeitsplaetze": a["arbeitspl"]})
        )  # fmt: skip
    return [(geom, attrs) for _, geom, attrs in sorted(result, key=lambda r: (r[0], r[2]["name"]))]


def municipal_data(src: Sources, numbers: list[int]) -> list[dict[str, Any]]:
    wanted = ", ".join(map(str, numbers))
    people = {
        a["bfsnr"]: a["espop"]
        for _, a in src.read("ADMGDE", "gdedat", geometry=False, where=f"bfsnr IN ({wanted})")
    }
    taxes = {
        a["bfsnr"]: a
        for _, a in src.read("STEUERN", "steuanl", geometry=False, where=f"bfsnr IN ({wanted})")
    }
    return [
        {"gem_nr": n, "einwohner": people[n], "steueranlage": taxes[n]["steuanlg"],
         "steuerpflichtige": taxes[n]["spflicht"], "steuerjahr": taxes[n]["steujahr"]}
        for n in numbers
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


def build(cache: Path, target: Path = DATA_DIR) -> dict[str, Any]:
    """Write all files plus ``metadata.json`` and ``manifest.json``; return the manifest."""
    src = Sources(cache)
    gem = municipalities(src)
    region = shapely.union_all([g for g, _ in gem])
    clip = region.buffer(CLIP_MARGIN_M)
    contents = {
        "gemeinden.geojson": _feature_collection(gem),
        "gewaesser.geojson": _feature_collection(waters(src, clip)),
        "strassen.geojson": _feature_collection(roads(src, clip)),
        "schulen.geojson": _feature_collection(schools(src, region)),
        "haltestellen.geojson": _feature_collection(stops(src, region)),
    }
    rows = municipal_data(src, [a["gem_nr"] for _, a in gem])
    version = f"{REGION_NAME}-{src.fetched['date']}"

    target.mkdir(parents=True, exist_ok=True)
    for old in [*target.glob("*.geojson"), *target.glob("*.csv"), *target.glob("*.json")]:
        old.unlink()  # files of a previous dataset with other layers
    with (target / "gemeindedaten.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    for name, content in contents.items():
        (target / name).write_text(content + "\n", encoding="utf-8")
    sources = [
        {"code": code, "title": title, "url": DETAIL_URL.format(code=code),
         "download": DOWNLOAD_URL.format(code=code, name=code.lower()),
         "sha256": src.fetched["files"][code]}
        for code, title in SOURCES.items()
    ]  # fmt: skip
    metadata = {
        "version": version,
        "source_crs": WGS84,
        "attribution": "Amt für Geoinformation des Kantons Bern (AGI)",
        "license": LICENSE,
        "sources": sources,
        "layers": LAYERS,
    }
    (target / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    files = sorted([*contents, "gemeindedaten.csv", "metadata.json"])
    manifest = {
        "version": version,
        "files": {f: hashlib.sha256((target / f).read_bytes()).hexdigest() for f in files},
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def default_cache() -> Path:
    """Downloaded sources live outside the repository: about 100 MB, not committed."""
    base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    return Path(base) / "geotandem" / "sample-sources"
