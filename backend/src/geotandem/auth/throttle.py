"""Brake on password guessing (security review #2).

Failed sign-ins are counted per client address and username, and per client
address alone, within a sliding window. Past either limit, sign-in is refused
until the oldest failure leaves the window — also with the right password, or
the refusal would tell which guess was right. A success clears the count for
its username and address, never the address's own: one valid account must not
reset the brake for guesses at others.

An IPv6 client is counted by its /64: one customer is usually given a whole
/64 and could otherwise take a fresh address, and a fresh count, for every
guess (security review #22).

Guesses at one username spread over many addresses are counted too, across
all of them. Past that limit sign-in is not refused but paced: one password
check per ``pace_s`` for that username. A browser that has signed in to the
account before (``auth/device.py``) is not paced, so whoever floods a username
slows the guessing down, not its owner (security review #27).

The counts live in memory: one process serves the instance (F-9.7), and a
restart starting afresh is acceptable for a brake.
"""

from __future__ import annotations

import ipaddress
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass

WINDOW_S = 15 * 60
MAX_KEYS = 100_000
"""Bound on remembered keys; past it, expired ones are dropped, then the oldest."""
IPV6_PREFIX = 64
"""What one IPv6 client is usually given, and so counted as one."""
PACE_S = 30.0
"""Past the limit per username: one password check this often for it."""


class Braked(Exception):
    """Refused before any password is checked: too many failures."""

    def __init__(self, retry_after_s: float, limit: str) -> None:
        super().__init__(retry_after_s, limit)
        self.retry_after_s = retry_after_s
        self.limit = limit
        """Which one: ``account`` (username and address), ``address`` or ``username``."""


Key = tuple[str | None, str | None]


@dataclass(frozen=True)
class Keys:
    account: Key
    """This username from this client."""
    address: Key
    """This client, whatever the username."""
    username: Key
    """This username, from any client."""

    def __iter__(self) -> Iterator[Key]:
        return iter((self.account, self.address, self.username))


class LoginThrottle:
    def __init__(
        self,
        per_account: int,
        per_address: int,
        per_username: int | None = None,
        window_s: float = WINDOW_S,
        pace_s: float = PACE_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.per_account = per_account
        self.per_address = per_address
        self.per_username = per_username
        """``None``: guesses at a username from many clients are not paced."""
        self.window_s = window_s
        self.pace_s = pace_s
        self._clock = clock
        self._failures: dict[Key, deque[float]] = {}
        self._lock = threading.Lock()

    def attempt(self, address: str, username: str, *, known_device: bool = False) -> Attempt:
        """Check and count an attempt in one step; raises ``Braked``.

        It counts as a failure from the start, so attempts running at once all
        count against the limit; checked first and counted after, each would
        pass the check before any had failed (security review #24). The
        ``Attempt`` then says how it ended. ``known_device``: the client has
        signed in to this username before, and is not paced.
        """
        now = self._clock()
        keys = _keys(address, username)
        with self._lock:
            braked = self._braked(keys, now, known_device)
            if braked is not None:
                raise braked
            self._add(keys, now)
        return Attempt(self, keys, now)

    def retry_after(
        self, address: str, username: str, *, known_device: bool = False
    ) -> float | None:
        """Seconds until ``username`` may be tried from ``address`` again; ``None``: now."""
        now = self._clock()
        with self._lock:
            braked = self._braked(_keys(address, username), now, known_device)
        return None if braked is None else braked.retry_after_s

    def _braked(self, keys: Keys, now: float, known_device: bool) -> Braked | None:
        waits = [
            (self._wait(keys.account, self.per_account, now), "account"),
            (self._wait(keys.address, self.per_address, now), "address"),
        ]
        if not known_device:
            waits.append((self._pace(keys.username, now), "username"))
        due = [(wait, limit) for wait, limit in waits if wait is not None]
        return Braked(*max(due)) if due else None

    def _add(self, keys: Keys, now: float) -> None:
        if len(self._failures) >= MAX_KEYS:
            self._prune(now)
        for key in keys:
            self._failures.setdefault(key, deque()).append(now)

    def _discard(self, key: Key, at: float) -> None:
        """Take back one failure counted at ``at``, if still in the window."""
        times = self._failures.get(key)
        if times is None:
            return
        try:
            times.remove(at)
        except ValueError:
            return
        if not times:
            del self._failures[key]

    def _live(self, key: Key, now: float) -> deque[float] | None:
        """The failures of ``key`` still in the window."""
        times = self._failures.get(key)
        if times is None:
            return None
        while times and times[0] <= now - self.window_s:
            times.popleft()
        if not times:
            del self._failures[key]
            return None
        return times

    def _wait(self, key: Key, limit: int, now: float) -> float | None:
        times = self._live(key, now)
        if times is None or len(times) < limit:
            return None
        # Free again once enough failures have left the window.
        return times[-limit] + self.window_s - now

    def _pace(self, key: Key, now: float) -> float | None:
        if self.per_username is None:
            return None
        times = self._live(key, now)
        if times is None or len(times) < self.per_username:
            return None
        # Past the limit: free again ``pace_s`` after the latest attempt.
        wait = times[-1] + self.pace_s - now
        return wait if wait > 0 else None

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_s
        for key in [k for k, t in self._failures.items() if t[-1] <= cutoff]:
            del self._failures[key]
        if len(self._failures) >= MAX_KEYS:
            by_age = sorted(self._failures, key=lambda k: self._failures[k][-1])
            for key in by_age[: len(by_age) // 2]:
                del self._failures[key]


class Attempt:
    """One attempt, counted as a failure until it says otherwise.

    As a context manager: left without ``failed`` or ``succeeded`` (e.g. busy, or
    a rule about the new password), the attempt is taken back, as it tested no
    password.
    """

    def __init__(self, throttle: LoginThrottle, keys: Keys, at: float) -> None:
        self._throttle = throttle
        self._keys = keys
        self._at = at
        self._open = True

    def failed(self) -> None:
        """The password was wrong: the attempt stays counted."""
        self._open = False

    def succeeded(self) -> None:
        """Clears the count for its username and address. Never the address's own,
        nor the username's from everywhere: only this attempt is taken back from those."""
        with self._throttle._lock:
            self._throttle._failures.pop(self._keys.account, None)
            self._throttle._discard(self._keys.address, self._at)
            self._throttle._discard(self._keys.username, self._at)
        self._open = False

    def cancel(self) -> None:
        if not self._open:
            return
        with self._throttle._lock:
            for key in self._keys:
                self._throttle._discard(key, self._at)
        self._open = False

    def __enter__(self) -> Attempt:
        return self

    def __exit__(self, *_: object) -> None:
        self.cancel()


def _keys(address: str, username: str) -> Keys:
    who, name = client(address), _name(username)
    return Keys(account=(who, name), address=(who, None), username=(None, name))


def client(address: str) -> str:
    """Who counts as one client: an IPv4 address, or the /64 of an IPv6 one.

    An IPv4 address in IPv6 form (``::ffff:192.0.2.1``) counts as itself;
    anything that is not an address (``unknown``) is kept as it is.
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return address
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(ip), IPV6_PREFIX), strict=False))
    return str(ip)


def _name(username: str) -> str:
    # As accounts normalise it, and bounded: the key must not grow with the input.
    return username.strip().lower()[:64]
