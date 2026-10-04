"""Device cookies: a browser that has signed in to an account before (security review #27)."""

from geotandem.auth.device import Devices


def test_a_device_cookie_is_known_for_its_username_only() -> None:
    devices = Devices()
    cookie = devices.issue("anna")
    assert devices.knows(cookie, "anna")
    assert devices.knows(cookie, " Anna ")  # as accounts normalise it
    assert not devices.knows(cookie, "bert")
    assert not devices.knows(None, "anna")
    assert not devices.knows("", "anna")


def test_a_forged_or_foreign_device_cookie_is_not_known() -> None:
    devices = Devices()
    nonce, _, mac = devices.issue("anna").partition(".")
    assert not devices.knows(f"{nonce}.{'0' * len(mac)}", "anna")
    assert not devices.knows(f"x{nonce}.{mac}", "anna")
    assert not devices.knows(mac, "anna")
    assert not Devices().knows(devices.issue("anna"), "anna")  # another key, e.g. a restart
