import pytest
from shapely.affinity import translate
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from sqlalchemy import func, insert, select

from geotandem.data import AttributeSpec, DataBackend, Limits, NewLayer, QueryTimeout

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
