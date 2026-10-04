"""Import files from outside: archives, XML, and the reading process (security review #9),
and uploads left waiting (#11)."""

import io
import json
import os
import struct
import time
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from geotandem.importing.isolation import ReadLimits, read_isolated
from geotandem.importing.read import SourceError, read_source
from geotandem.importing.staging import Staging, TooManyPending

MiB = 1024 * 1024
SAMPLE = Path(__file__).parents[1] / "src" / "geotandem" / "sample" / "data"


def zipped(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def patch_entry(path: Path, *, flags: int | None = None, size: int | None = None) -> None:
    """Rewrite the first entry's headers as a crafted archive would: general-purpose
    flags, or the uncompressed size the headers claim."""
    data = bytearray(path.read_bytes())
    local = data.index(b"PK\x03\x04")
    central = data.index(b"PK\x01\x02")
    if flags is not None:
        struct.pack_into("<H", data, local + 6, flags)
        struct.pack_into("<H", data, central + 8, flags)
    if size is not None:
        struct.pack_into("<I", data, local + 22, size)
        struct.pack_into("<I", data, central + 24, size)
    path.write_bytes(bytes(data))


def refused(path: Path, max_unpacked: int = 100 * MiB) -> SourceError:
    with pytest.raises(SourceError) as info:
        read_source(path, path.name, max_unpacked=max_unpacked)
    return info.value


# --- archives ----------------------------------------------------------------------


def test_a_zip_bomb_is_refused_before_it_is_parsed(tmp_path: Path) -> None:
    bomb = zipped(tmp_path / "bombe.zip", {"bombe.shp": bytes(3 * MiB)})
    assert bomb.stat().st_size < 10_000  # zeros compress a thousandfold
    error = refused(bomb, max_unpacked=2 * MiB)
    assert error.code == "archive_too_large"
    assert error.details == {"file": "bombe.zip"}


def test_sizes_the_headers_understate_do_not_pass(tmp_path: Path) -> None:
    """Counted by unpacking: an entry claiming 10 bytes is checked against its checksum."""
    liar = zipped(tmp_path / "luege.zip", {"luege.shp": bytes(3 * MiB)})
    patch_entry(liar, size=10)
    error = refused(liar, max_unpacked=2 * MiB)
    assert error.code == "unreadable"
    assert error.message.startswith("'luege.zip' cannot be read as a zipped shapefile.")


def test_encrypted_nested_and_crowded_archives_are_refused(tmp_path: Path) -> None:
    secret = zipped(tmp_path / "geheim.zip", {"a.shp": b"x"})
    patch_entry(secret, flags=0x1)
    assert refused(secret).code == "archive_encrypted"
    nested = zipped(tmp_path / "verschachtelt.zip", {"innen.zip": b"PK"})
    assert refused(nested).code == "archive_nested"
    crowded = zipped(tmp_path / "voll.zip", {f"f{i}.txt": b"" for i in range(1001)})
    assert refused(crowded).code == "archive_too_many_entries"


def test_an_excel_bomb_is_refused_too(tmp_path: Path) -> None:
    bomb = zipped(tmp_path / "bombe.xlsx", {"xl/worksheets/sheet1.xml": bytes(3 * MiB)})
    assert refused(bomb, max_unpacked=2 * MiB).code == "archive_too_large"


# --- XML in Excel -----------------------------------------------------------------


def test_excel_xml_with_entities_is_refused(tmp_path: Path) -> None:
    """openpyxl parses through defusedxml: no entity expansion ("billion laughs")."""
    import openpyxl.xml

    assert openpyxl.xml.DEFUSEDXML
    workbook = openpyxl.Workbook()
    workbook.active.append(["name", "wert"])
    workbook.active.append(["a", 1])
    plain = tmp_path / "plain.xlsx"
    workbook.save(plain)
    laughs = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData><row><c t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData>'
        "</worksheet>"
    )
    target = tmp_path / "lachen.xlsx"
    with zipfile.ZipFile(plain) as source, zipfile.ZipFile(target, "w") as out:
        for item in source.infolist():
            data = source.read(item)
            out.writestr(item, laughs if item.filename == "xl/worksheets/sheet1.xml" else data)
    assert refused(target).code == "unreadable"
    # Refused for its entities, not for anything else about the file.
    from defusedxml import EntitiesForbidden

    with pytest.raises(ValueError) as raised:
        openpyxl.load_workbook(target, read_only=True)
    cause: BaseException | None = raised.value
    while cause is not None and not isinstance(cause, EntitiesForbidden):
        cause = cause.__cause__ or cause.__context__
    assert isinstance(cause, EntitiesForbidden)


# --- the reading process -----------------------------------------------------------


def test_a_file_is_read_in_a_process_of_its_own() -> None:
    source = read_isolated(SAMPLE / "schulen.geojson", "schulen.geojson", None, ReadLimits())
    assert source.record_count > 0 and source.is_vector


def test_refusals_come_back_from_the_reading_process(tmp_path: Path) -> None:
    bomb = zipped(tmp_path / "bombe.zip", {"bombe.shp": bytes(3 * MiB)})
    with pytest.raises(SourceError) as info:
        read_isolated(bomb, bomb.name, None, ReadLimits(unpacked_mb=2))
    assert (info.value.code, info.value.details) == ("archive_too_large", {"file": "bombe.zip"})


def test_drivers_stay_restricted_in_the_reading_process(tmp_path: Path) -> None:
    """The child imports GDAL afresh; it must restrict the drivers too (F-2.1)."""
    secret = tmp_path / "secret.csv"
    secret.write_text("geheim,wert\na,1\n", "utf-8")
    vrt = tmp_path / "vrt.geojson"
    vrt.write_text(
        f'<OGRVRTDataSource><OGRVRTLayer name="s"><SrcDataSource>{secret}'
        "</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>",
        "utf-8",
    )
    with pytest.raises(SourceError) as info:
        read_isolated(vrt, vrt.name, None, ReadLimits())
    assert info.value.code == "unreadable"


@pytest.mark.parametrize(
    ("limits", "code"),
    [
        (ReadLimits(memory_mb=600), "unreadable"),  # below what the libraries take
        (ReadLimits(cpu_s=0), "unreadable"),  # killed at once for its CPU time
        (ReadLimits(wall_s=0.001), "too_slow"),
    ],
)
def test_a_reading_process_that_fails_ends_in_an_answer(limits: ReadLimits, code: str) -> None:
    started = time.monotonic()
    with pytest.raises(SourceError) as info:
        read_isolated(SAMPLE / "gemeinden.geojson", "gemeinden.geojson", None, limits)
    assert info.value.code in (code, "too_large")
    assert time.monotonic() - started < 30
    # And the next file reads as usual.
    assert read_isolated(SAMPLE / "schulen.geojson", "schulen.geojson", None, ReadLimits())


# --- uploads left waiting (#11) ----------------------------------------------------


def test_expired_uploads_go_before_a_new_one(tmp_path: Path) -> None:
    staging = Staging(tmp_path)
    old = staging.save("alt.csv", io.BytesIO(b"a\n1\n"), MiB)
    day_ago = time.time() - 25 * 3600
    os.utime(tmp_path / old, (day_ago, day_ago))
    new = staging.save("neu.csv", io.BytesIO(b"a\n1\n"), MiB)
    assert sorted(p.name for p in tmp_path.iterdir()) == [new]


def test_uploads_waiting_at_once_are_capped(tmp_path: Path) -> None:
    staging = Staging(tmp_path, max_pending=2)
    first = staging.save("a.csv", io.BytesIO(b"a\n1\n"), MiB)
    staging.save("b.csv", io.BytesIO(b"a\n1\n"), MiB)
    with pytest.raises(TooManyPending):
        staging.save("c.csv", io.BytesIO(b"a\n1\n"), MiB)
    staging.delete(first)
    staging.save("c.csv", io.BytesIO(b"a\n1\n"), MiB)


async def test_the_wizard_is_told_to_finish_waiting_uploads(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    app.state.geotandem.staging.max_pending = 1
    files = {"file": ("orte.csv", b"name;wert\na;1\n", "text/csv")}
    assert (await client.post("/api/admin/imports", files=files)).status_code == 200
    second = await client.post("/api/admin/imports", files=files)
    assert (second.status_code, second.json()["code"]) == (409, "too_many_pending_imports")
    assert json.loads(second.text)["details"] == {"max": 1}
