"""Encrypted storage of credentials (F-9.2, plan E2.1, C8).

The key is made at first start in ``DATA_DIR/secret.key``, readable by the
application's user only. Zero setup, at a price the README states: a backup
of the data directory holds the key next to what it protects.

A secret is decrypted only when an adapter is built for a call. Without the
key that encrypted it — the file deleted, replaced, or not restored — the
application still starts; the secret reports ``credentials_unreadable``.
"""

import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

KEY_FILE = "secret.key"

log = logging.getLogger(__name__)


class CredentialsUnreadable(Exception):
    """A stored secret the current key cannot open."""

    code = "credentials_unreadable"


class Vault:
    def __init__(self, key: bytes) -> None:
        self._fernet = Fernet(key)

    @classmethod
    def open(cls, data_dir: Path) -> "Vault":
        """The instance's key, made on first use with mode 0600."""
        path = data_dir / KEY_FILE
        data_dir.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return cls(path.read_bytes().strip())
        with os.fdopen(fd, "wb") as file:
            file.write(Fernet.generate_key())
        log.warning(
            "created %s: it encrypts stored API keys; back it up with the data, keep it private",
            path,
        )
        return cls(path.read_bytes().strip())

    def encrypt(self, secret: str) -> str:
        return self._fernet.encrypt(secret.encode()).decode("ascii")

    def decrypt(self, token: str) -> str:
        try:
            return self._fernet.decrypt(token.encode("ascii")).decode()
        except (InvalidToken, ValueError):
            raise CredentialsUnreadable(
                "A stored credential cannot be decrypted with this instance's secret.key."
            ) from None
