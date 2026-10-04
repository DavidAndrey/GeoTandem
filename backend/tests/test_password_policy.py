"""The password policy (security review #12)."""

import hashlib
import unicodedata
from importlib.resources import files

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from geotandem.auth import accounts, password_policy
from geotandem.auth.accounts import AccountError
from geotandem.auth.password_policy import violation
from geotandem.data import DataBackend
from geotandem.db.orm import User

NAMES = ("m.keller", "Maria Keller")


@pytest.mark.parametrize(
    ("password", "code"),
    [
        ("kurz-1234", "password_too_short"),
        ("x" * 1025, "password_too_long"),
        # Common, however disguised: case, leetspeak, umlauts, separators, ends.
        ("P@ssw0rd2024!", "password_common"),
        ("Password12345", "password_common"),
        ("iloveyou1234", "password_common"),
        ("dragon!!!!!!2", "password_common"),
        ("Fußball-12345", "password_common"),  # German list, ß and umlauts folded
        ("passwort-2024!", "password_common"),
        ("Bern2024!!!!", "password_common"),
        # Keyboard rows, sequences, repetitions, few distinct characters.
        ("qwertzuiopas", "password_pattern"),
        ("1qaz2wsx3edc", "password_pattern"),
        ("abcdefghijkl", "password_pattern"),
        ("lkjihgfedcba", "password_pattern"),
        ("123412341234", "password_pattern"),
        ("trustno1trustno1", "password_pattern"),
        ("sommer sommer!", "password_pattern"),
        ("aaaaaaaaaaab", "password_pattern"),
        # The account's own names, and the application's.
        ("m.keller2024!", "password_contains_name"),
        ("Maria-Rocks-2024", "password_contains_name"),
        ("K3ll3r-am-Morgen", "password_contains_name"),
        ("geotandem2024!", "password_contains_name"),
    ],
)
def test_a_weak_password_is_refused_with_its_reason(password: str, code: str) -> None:
    broken = violation(password, NAMES)
    assert broken is not None and broken[0] == code


@pytest.mark.parametrize(
    "password",
    [
        "Aare Brücke am Morgen",  # a passphrase, umlauts and spaces welcome
        "korrekt-pferd-batterie",  # common words, but not as a whole
        "Sonne über Bern 7",
        "Hp8#vQ2!zLr9",
        "Kaffee-und-Gipfeli",
        "maximal-nebel-1987",  # "Max" alone is too short to look for
    ],
)
def test_length_matters_not_composition(password: str) -> None:
    assert violation(password, ("max", "Max Muster")) is None


def test_both_lists_are_read_and_the_common_one_is_unchanged() -> None:
    data = files("geotandem.auth").joinpath("data")
    common = data.joinpath("common-passwords.txt").read_bytes()
    assert hashlib.sha256(common).hexdigest() == (
        "4adb3f0afb4a10cf19ebe48d8c69a46f934bbc8d77c694c210564f9583e7f4ba"
    )  # as recorded in data/README.md
    assert len(common.splitlines()) == 10_000
    assert violation("eyphed-2024!!") is not None  # last entry of the common list
    assert violation("Matterhorn-2024!") is not None  # from the German list


def test_generated_start_passwords_meet_the_policy() -> None:
    for _ in range(200):
        assert violation(accounts.generate_password()) is None


# --- where it applies -------------------------------------------------------------


def test_setting_a_password_follows_the_policy(backend: DataBackend) -> None:
    with pytest.raises(AccountError) as weak:
        accounts.create(backend.engine, "anna", "P@ssw0rd2024!", "user")
    assert weak.value.code == "password_common"
    with pytest.raises(AccountError) as named:
        accounts.create(backend.engine, "anna", "anna-am-morgen-7", "user")
    assert named.value.code == "password_contains_name"
    account = accounts.create(backend.engine, "anna", ADMIN_PASSWORD, "user", display_name="Anna")
    with pytest.raises(AccountError) as changed:
        accounts.change_password(backend.engine, account.id, ADMIN_PASSWORD, "Anna-im-Garten-24")
    assert changed.value.code == "password_contains_name"


async def test_the_interface_gets_the_reason(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/auth/password", json={"current": ADMIN_PASSWORD, "new": "Sommer2024!!!"}
    )
    assert (response.status_code, response.json()["code"]) == (400, "password_common")


def test_the_command_line_follows_the_policy(
    settings_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from geotandem.cli import main

    monkeypatch.setattr("getpass.getpass", lambda prompt="": "Passwort2024!")
    with pytest.raises(SystemExit, match="too common"):
        main(["user", "create", "anna"])


def test_passwords_set_before_hold_until_their_next_change(backend: DataBackend) -> None:
    """Agreed for #12: the policy applies when a password is set, not at sign-in."""
    account = accounts.create(backend.engine, "anna", ADMIN_PASSWORD, "user")
    old = "hallo12345"  # 10 characters and common: allowed until now
    with Session(backend.engine) as session, session.begin():
        session.execute(
            update(User)
            .where(User.id == account.id)
            .values(password_hash=accounts._hasher.hash(old))
        )
    assert accounts.authenticate(backend.engine, "anna", old) is not None


# --- Unicode ------------------------------------------------------------------------


def test_the_same_umlaut_from_any_keyboard_is_the_same_password(backend: DataBackend) -> None:
    composed = "Aare Brücke am Morgen"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    accounts.create(backend.engine, "anna", composed, "user")
    assert accounts.authenticate(backend.engine, "anna", decomposed) is not None


def test_a_hash_from_before_normalization_still_signs_in_and_is_renewed(
    backend: DataBackend,
) -> None:
    typed = unicodedata.normalize("NFD", "Aare Brücke am Morgen")
    account = accounts.create(backend.engine, "anna", ADMIN_PASSWORD, "user")
    with Session(backend.engine) as session, session.begin():
        session.execute(
            update(User)
            .where(User.id == account.id)
            .values(password_hash=accounts._hasher.hash(typed))
        )
    assert accounts.authenticate(backend.engine, "anna", typed) is not None
    with Session(backend.engine) as session:
        renewed = session.scalar(select(User.password_hash).where(User.id == account.id))
    assert accounts._hasher.verify(renewed, password_policy.prepare(typed))


def test_a_new_password_equal_up_to_normalization_counts_as_unchanged() -> None:
    composed = "Aare Brücke am Morgen"
    with pytest.raises(AccountError) as same:
        accounts.check_password(unicodedata.normalize("NFD", composed), old=composed)
    assert same.value.code == "password_unchanged"
