"""Zip archives among the import files, looked at before anything parses them
(security review #9): a zipped shapefile, and an Excel workbook, which is one too.

A few hundred kilobytes can unpack to gigabytes (a zip bomb). GDAL and openpyxl
unpack as they read, so the archive is checked first, in plain Python: how many
entries, whether encrypted or nested, and how much it unpacks to — counted by
unpacking, as the sizes in the headers are the sender's word. A header that
understates its entry fails the checksum and the archive is refused.
"""

from __future__ import annotations

import zipfile
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 1_000
NESTED = frozenset({".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar"})
_CHUNK = 1024 * 1024


def problem(path: Path, max_unpacked: int, allow_nested: bool) -> tuple[str, str] | None:
    """Why the archive at ``path`` is refused, as ``(code, message)``; ``None`` if it is not.

    ``allow_nested``: an Excel workbook has no archives inside, a shapefile neither;
    both pass ``False``. Kept as a parameter for formats to come.
    """
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES:
                return (
                    "archive_too_many_entries",
                    f"The archive has {len(entries)} entries, at most {MAX_ENTRIES} are read.",
                )
            for entry in entries:
                if entry.flag_bits & 0x1:
                    return "archive_encrypted", "The archive is encrypted; it cannot be read."
                if not allow_nested and PurePosixPath(entry.filename).suffix.lower() in NESTED:
                    return (
                        "archive_nested",
                        "The archive contains another archive; please unpack it first.",
                    )
            too_large = (
                "archive_too_large",
                f"The archive unpacks to more than {max_unpacked // (1024 * 1024)} MB.",
            )
            if sum(entry.file_size for entry in entries) > max_unpacked:
                return too_large
            unpacked = 0
            for entry in entries:
                if entry.is_dir():
                    continue
                with archive.open(entry) as data:
                    while chunk := data.read(_CHUNK):
                        unpacked += len(chunk)
                        if unpacked > max_unpacked:
                            return too_large
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, OSError, EOFError):
        # Damaged, overlapping entries, a checksum that does not match, or an unknown method.
        return "unreadable", "The archive is damaged or uses a method that cannot be read."
    return None
