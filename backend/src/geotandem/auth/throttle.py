"""Brake on password guessing (security review #2).

Failed sign-ins are counted per client address and username, and per client
address alone, within a sliding window. Past either limit, sign-in is refused
until the oldest failure leaves the window — also with the right password, or
the refusal would tell which guess was right. A success clears the count for
its username and address, never the address's own: one valid account must not
reset the brake for guesses at others.

The counts live in memory: one process serves the instance (F-9.7), and a
restart starting afresh is acceptable for a brake.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable

WINDOW_S = 15 * 60
MAX_KEYS = 100_000
"""Bound on remembered keys; past it, expired ones are dropped, then the oldest."""


class LoginThrottle:
    def __init__(
        self,
        per_account: int,
        per_address: int,
        window_s: float = WINDOW_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.per_account = per_account
        self.per_address = per_address
        self.window_s = window_s
        self._clock = clock
        self._failures: dict[tuple[str, str | None], deque[float]] = {}
        self._lock = threading.Lock()

    def retry_after(self, address: str, username: str) -> float | None:
        """Seconds until ``username`` may be tried from ``address`` again; ``None``: now."""
        now = self._clock()
        with self._lock:
            waits = [
                self._wait(key, limit, now)
                for key, limit in (
                    ((address, _name(username)), self.per_account),
                    ((address, None), self.per_address),
                )
            ]
        return max((w for w in waits if w is not None), default=None)

    def failed(self, address: str, username: str) -> None:
        now = self._clock()
        with self._lock:
            if len(self._failures) >= MAX_KEYS:
                self._prune(now)
            for key in ((address, _name(username)), (address, None)):
                self._failures.setdefault(key, deque()).append(now)

    def succeeded(self, address: str, username: str) -> None:
        with self._lock:
            self._failures.pop((address, _name(username)), None)

    def _wait(self, key: tuple[str, str | None], limit: int, now: float) -> float | None:
        times = self._failures.get(key)
        if times is None:
            return None
        while times and times[0] <= now - self.window_s:
            times.popleft()
        if not times:
            del self._failures[key]
            return None
        if len(times) < limit:
            return None
        # Free again once enough failures have left the window.
        return times[-limit] + self.window_s - now

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_s
        for key in [k for k, t in self._failures.items() if t[-1] <= cutoff]:
            del self._failures[key]
        if len(self._failures) >= MAX_KEYS:
            by_age = sorted(self._failures, key=lambda k: self._failures[k][-1])
            for key in by_age[: len(by_age) // 2]:
                del self._failures[key]


def _name(username: str) -> str:
    # As accounts normalise it, and bounded: the key must not grow with the input.
    return username.strip().lower()[:64]
