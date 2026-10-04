"""Uploaded files waiting for their import decisions (design D6).

One directory per upload under ``<data_dir>/staging/<id>/``, holding the file
under its original name. An upload lives until it is imported, aborted, or
older than ``MAX_AGE``: removed at the next start and before every new upload,
so abandoned uploads cannot pile up on a long-running instance; at most
``max_pending`` wait at once (security review #11).
"""

from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path, PurePath
from typing import BinaryIO

MAX_AGE_S = 24 * 3600
MAX_PENDING = 20
_CHUNK = 1024 * 1024


class UploadTooLarge(Exception):
    pass


class TooManyPending(Exception):
    """``max_pending`` uploads are waiting for their decisions already."""


class UnknownUpload(KeyError):
    pass


class Staging:
    def __init__(self, root: Path, max_pending: int = MAX_PENDING) -> None:
        self.root = root
        self.max_pending = max_pending

    def pending(self) -> int:
        return sum(1 for d in self.root.iterdir() if d.is_dir()) if self.root.is_dir() else 0

    def save(self, file_name: str, data: BinaryIO, max_bytes: int) -> str:
        """Copy an upload into staging; refuse it beyond ``max_bytes`` or ``max_pending``."""
        self.cleanup()
        if self.pending() >= self.max_pending:
            raise TooManyPending(self.max_pending)
        name = PurePath(file_name.replace("\\", "/")).name
        if name in ("", ".", ".."):  # "a/.." keeps ".." as its last part
            name = "upload"
        upload_id = uuid.uuid4().hex
        directory = self.root / upload_id
        directory.mkdir(parents=True)
        written = 0
        try:
            with (directory / name).open("wb") as out:
                while chunk := data.read(_CHUNK):
                    written += len(chunk)
                    if written > max_bytes:
                        raise UploadTooLarge(max_bytes)
                    out.write(chunk)
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        return upload_id

    def path(self, upload_id: str) -> Path:
        """The staged file. Raises ``UnknownUpload``."""
        if not upload_id.isalnum():
            raise UnknownUpload(upload_id)
        directory = self.root / upload_id
        files = list(directory.iterdir()) if directory.is_dir() else []
        if len(files) != 1:
            raise UnknownUpload(upload_id)
        return files[0]

    def delete(self, upload_id: str) -> None:
        path = self.path(upload_id)
        shutil.rmtree(path.parent, ignore_errors=True)

    def cleanup(self, max_age_s: float = MAX_AGE_S) -> int:
        if not self.root.is_dir():
            return 0
        cutoff = time.time() - max_age_s
        removed = 0
        for directory in self.root.iterdir():
            if directory.is_dir() and directory.stat().st_mtime < cutoff:
                shutil.rmtree(directory, ignore_errors=True)
                removed += 1
        return removed
