from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from shapely.affinity import translate
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from sqlalchemy import Table, func, insert, select
from sqlalchemy.orm import Session

from geotandem.catalog import get_layer
from geotandem.data import (
    AttributeSpec,
    DataBackend,
    LayerExists,
    Limits,
    NewLayer,
    QueryTimeout,
)
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.orm import Layer
from geotandem.engine import run_query
from geotandem_query import QueryObject

LIMITS = Limits(max_features=1000, timeout_s=5)
X0, Y0 = 2_600_000, 1_200_000


def points(backend: DataBackend, n: int = 10) -> None:
    backend.create_layer(
        NewLayer(
            name="pts",
            title="Punkte",
            kind="vector",
            attributes=[AttributeSpec("value", "integer"), AttributeSpec("label", "text")],
            rows=[(Point(X0 + i * 100, Y0), {"value": i, "label": f"p{i}"}) for i in range(n)],
        )
    )


def test_create_layer_registers_table_index_and_metadata(backend: DataBackend) -> None:
    points(backend)
    assert backend.layer_names() == ["pts"]
    table = backend.layer_table("pts")
    rows = backend.execute(select(table.c.fid, table.c.value).order_by(table.c.fid), LIMITS)
    assert [r["value"] for r in rows] == list(range(10))
    with backend.engine.connect() as conn:
        assert conn.scalar(select(func.CheckSpatialIndex("lyr_pts", "geom"))) == 1


def test_mixed_single_and_multi_polygons_become_multi(backend: DataBackend) -> None:
    square = Polygon([(X0, Y0), (X0 + 1, Y0), (X0 + 1, Y0 + 1), (X0, Y0 + 1)])
    backend.create_layer(
        NewLayer(
            name="areas",
            title="Flächen",
            kind="vector",
            attributes=[],
            rows=[(square, {}), (MultiPolygon([square, translate(square, 10, 0)]), {})],
        )
    )
    table = backend.layer_table("areas")
    types = backend.execute(select(func.GeometryType(table.c.geom)), LIMITS)
    assert {next(iter(r.values())) for r in types} == {"MULTIPOLYGON"}


def test_table_layer_has_no_geometry(backend: DataBackend) -> None:
    backend.create_layer(
        NewLayer(
            name="stats",
            title="Statistik",
            kind="table",
            attributes=[AttributeSpec("code", "integer"), AttributeSpec("pop", "integer")],
            rows=[(None, {"code": 1, "pop": 10})],
        )
    )
    assert "geom" not in backend.layer_table("stats").c


def test_index_prefilter_matches_full_scan(backend: DataBackend) -> None:
    points(backend, 50)
    backend.create_layer(
        NewLayer(
            name="line",
            title="Linie",
            kind="vector",
            attributes=[],
            rows=[(LineString([(X0 + 1000, Y0 - 50), (X0 + 1000, Y0 + 50)]), {})],
        )
    )
    pts, line = backend.layer_table("pts"), backend.layer_table("line")
    d = backend.dialect

    def near(prefilter: bool) -> list[int]:
        cond = [d.dwithin(line.c.geom, pts.c.geom, 250)]
        if prefilter:
            cond.append(d.index_candidates(line, pts.c.geom, 250))  # type: ignore[arg-type]
        exists = select(line.c.fid).where(*cond).exists()
        return [r["fid"] for r in backend.execute(select(pts.c.fid).where(exists), LIMITS)]

    assert near(prefilter=True) == near(prefilter=False) == [9, 10, 11, 12, 13]


def test_execute_is_read_only(backend: DataBackend) -> None:
    points(backend)
    table = backend.layer_table("pts")
    stmt = insert(table).values(value=99).returning(table.c.fid)
    with pytest.raises(Exception, match="readonly"):
        backend.execute(stmt, LIMITS)  # type: ignore[arg-type]


def test_execute_times_out(backend: DataBackend) -> None:
    points(backend, 200)
    a = backend.layer_table("pts").alias("a")
    b = backend.layer_table("pts").alias("b")
    c = backend.layer_table("pts").alias("c")
    stmt = select(func.count()).select_from(a).join(b, a.c.fid != b.c.fid).join(c, c.c.fid > 0)
    with pytest.raises(QueryTimeout):
        backend.execute(stmt, Limits(max_features=10, timeout_s=0.05))


def test_all_operations_supported(backend: DataBackend) -> None:
    assert backend.missing_functions() == {}


# --- replace (F-2.7 "Aktualisieren") ------------------------------------------


def _curate(backend: DataBackend) -> None:
    with Session(backend.engine) as session, session.begin():
        layer = session.scalar(select(Layer).where(Layer.name == "pts"))
        assert layer is not None
        layer.title = "Messpunkte"
        layer.for_model = False
        for attribute in layer.attributes:
            attribute.label = f"Bezeichnung {attribute.name}"
            attribute.unit = "m"


def test_replace_keeps_identity_and_curated_metadata(backend: DataBackend) -> None:
    points(backend)
    _curate(backend)
    with Session(backend.engine) as session:
        layer_id = session.scalar(select(Layer.id).where(Layer.name == "pts"))

    count = backend.replace_layer(
        "pts",
        NewLayer(
            name="ignored",
            title="ignored",
            kind="vector",
            attributes=[AttributeSpec("value", "real"), AttributeSpec("extra", "text", label="X")],
            rows=[(Point(X0, Y0 + i * 10), {"value": i / 2, "extra": "e"}) for i in range(3)],
            source="file:v2.gpkg",
            dataset_version="v2",
        ),
    )

    assert count == 3
    info = get_layer(backend.engine, "pts")
    assert info is not None
    assert (info.title, info.feature_count, info.dataset_version) == ("Messpunkte", 3, "v2")
    assert [(a.name, a.data_type, a.label, a.unit) for a in info.attributes] == [
        ("value", "real", "Bezeichnung value", "m"),
        ("extra", "text", "X", None),
    ]
    with Session(backend.engine) as session:
        layer = session.scalar(select(Layer).where(Layer.name == "pts"))
        assert layer is not None
        assert (layer.id, layer.for_model, layer.source) == (layer_id, False, "file:v2.gpkg")
    table = backend.layer_table("pts")
    assert "label" not in table.c
    rows = backend.execute(select(table.c.value).order_by(table.c.fid), LIMITS)
    assert [r["value"] for r in rows] == [0, 0.5, 1]
    with backend.engine.connect() as conn:
        assert conn.scalar(select(func.CheckSpatialIndex("lyr_pts", "geom"))) == 1


def test_replace_changes_data_version_of_query_results(backend: DataBackend) -> None:
    """A result names the data it came from (F-8.9); a replace must show there."""
    points(backend)
    query = QueryObject.model_validate({"source": "pts", "output": "table"})
    before = run_query(query, backend, LIMITS)
    backend.replace_layer(
        "pts",
        NewLayer(
            name="pts",
            title="",
            kind="vector",
            attributes=[AttributeSpec("value", "integer")],
            rows=[(Point(X0, Y0), {"value": 1})],
            dataset_version="v2",
        ),
    )
    after = run_query(query, backend, LIMITS)
    assert before.meta.data_versions == {"pts": None}
    assert after.meta.data_versions == {"pts": "v2"}
    assert after.meta.query_hash == before.meta.query_hash


def test_failed_replace_leaves_layer_untouched(backend: DataBackend) -> None:
    points(backend)
    with pytest.raises(ValueError, match="declared Point"):
        backend.replace_layer(
            "pts",
            NewLayer(
                name="pts",
                title="",
                kind="vector",
                attributes=[],
                rows=[(LineString([(X0, Y0), (X0 + 1, Y0)]), {})],
                geometry_type="Point",
            ),
        )
    table = backend.layer_table("pts")
    assert len(backend.execute(select(table.c.fid), LIMITS)) == 10


def test_declared_multi_type_promotes_single_geometries(backend: DataBackend) -> None:
    backend.create_layer(
        NewLayer(
            name="mp",
            title="",
            kind="vector",
            attributes=[],
            rows=[(Point(X0, Y0), {})],
            geometry_type="MultiPoint",
        )
    )
    table = backend.layer_table("mp")
    types = backend.execute(select(func.GeometryType(table.c.geom)), LIMITS)
    assert [next(iter(r.values())) for r in types] == ["MULTIPOINT"]


def test_replace_failing_mid_transaction_rolls_back_the_drop(
    backend: DataBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    points(backend)

    def broken_insert(*args: object) -> None:
        raise RuntimeError("disk full")

    monkeypatch.setattr(backend, "_insert", broken_insert)
    with pytest.raises(RuntimeError, match="disk full"):
        backend.replace_layer(
            "pts",
            NewLayer(name="pts", title="", kind="vector", attributes=[], rows=[]),
        )
    monkeypatch.undo()

    table = backend.layer_table("pts")
    assert "value" in table.c
    assert len(backend.execute(select(table.c.fid), LIMITS)) == 10
    with backend.engine.connect() as conn:
        assert conn.scalar(select(func.CheckSpatialIndex("lyr_pts", "geom"))) == 1


def test_vector_rows_without_geometry_are_stored_with_null(backend: DataBackend) -> None:
    backend.create_layer(
        NewLayer(
            name="gaps",
            title="",
            kind="vector",
            attributes=[AttributeSpec("n", "integer")],
            rows=[(Point(X0, Y0), {"n": 1}), (None, {"n": 2}), (Point(X0, Y0 + 1), {"n": 3})],
        )
    )
    table = backend.layer_table("gaps")
    rows = backend.execute(select(table.c.n).where(table.c.geom.is_(None)), LIMITS)
    assert [r["n"] for r in rows] == [2]


def test_creating_a_taken_name_is_refused_and_keeps_the_layer(backend: DataBackend) -> None:
    points(backend)
    table = backend.layer_table("pts")  # cached, as after any query
    with pytest.raises(LayerExists):
        points(backend, n=3)
    assert backend.layer_table("pts") is table
    assert len(backend.execute(select(table.c.fid), LIMITS)) == 10


def test_parallel_creates_of_one_name_leave_one_layer(backend: DataBackend) -> None:
    """Two imports committing the same name at once (the second used to answer 500)."""
    start = Barrier(4)

    def create(n: int) -> int:
        start.wait()
        points(backend, n=n)
        return n

    outcomes: list[int | str] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for future in [pool.submit(create, n) for n in (1, 2, 3, 4)]:
            try:
                outcomes.append(future.result())
            except LayerExists:
                outcomes.append("exists")
    winners = [o for o in outcomes if o != "exists"]
    assert len(winners) == 1
    table = backend.layer_table("pts")
    assert len(backend.execute(select(table.c.fid), LIMITS)) == winners[0]


def test_parallel_first_access_defines_the_table_once(backend: DataBackend) -> None:
    points(backend)
    for _ in range(20):
        fresh = SpatiaLiteBackend(backend.engine, backend.internal_srid)  # nothing cached
        start = Barrier(8)

        def load(_: int, fresh: SpatiaLiteBackend = fresh, start: Barrier = start) -> Table:
            start.wait()
            return fresh.layer_table("pts")

        with ThreadPoolExecutor(max_workers=8) as pool:
            tables = list(pool.map(load, range(8)))
        assert all(t is tables[0] for t in tables)
