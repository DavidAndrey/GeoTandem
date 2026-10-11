"""How many queries run at once: per account and in all (security review #5);
how many password checks sign-ins wait for (security review #23).

Each query may take up to the time limit (F-9.6) on one of the server's
worker threads. Without a bound, one account sending many at once could keep
every thread busy, and sign-ins and everyone else's work would wait. A query
holds a slot of its account and one of the instance while it runs. Waiting
for slots happens in the event loop, on no worker thread, for at most the
time limit; then the answer is "busy". A tool chain's steps and stamps, which
run in a thread of their own and not in a request, take from the same count
of the instance (review #42).
"""

from __future__ import annotations

import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import anyio

from geotandem.auth.accounts import HashingBusy


class QueriesBusy(Exception):
    """No slot came free in time."""


POLL_S = (0.005, 0.05)
"""How a request waiting in the event loop for an instance slot looks again:
from the first value, doubling, to the second (``QuerySlots.hold``)."""


class QuerySlots:
    """The instance's count is shared by requests (in the event loop) and by the
    threads of tool chains (``take_thread``, security review #42): a chain's
    step and its result's stamp run outside any request, and count as a query
    of the instance all the same. The count is a plain counter under a lock, so
    both sides can take from it; a request waits for it in the event loop
    (looking again every few milliseconds, on no worker thread), a chain's
    thread waits on a condition."""

    def __init__(self, per_account: int, total: int, wait_s: float) -> None:
        self.per_account = per_account
        self.total = total
        self.wait_s = wait_s
        self._free = total
        self._changed = threading.Condition()
        # Created on first use: anyio's primitives belong to the running event loop.
        self._accounts: dict[int, anyio.Semaphore] = {}

    def _try_take(self) -> bool:
        with self._changed:
            if self._free == 0:
                return False
            self._free -= 1
            return True

    def _give_back(self) -> None:
        with self._changed:
            if self._free >= self.total:
                raise RuntimeError("a query slot given back twice")
            self._free += 1
            self._changed.notify()

    @property
    def free(self) -> int:
        """The instance's slots free now (tests, the security review's checks)."""
        with self._changed:
            return self._free

    @asynccontextmanager
    async def hold(self, account_id: int) -> AsyncIterator[None]:
        own = self._accounts.setdefault(account_id, anyio.Semaphore(self.per_account))
        got_own = got_all = False
        try:
            # The account's slot first: one account's queue never holds the instance's slots.
            with anyio.move_on_after(self.wait_s):
                await own.acquire()
                got_own = True
                pause = POLL_S[0]
                while not self._try_take():
                    await anyio.sleep(pause)
                    pause = min(pause * 2, POLL_S[1])
                got_all = True
            if not got_all:
                raise QueriesBusy
            yield
        finally:
            if got_all:
                self._give_back()
            if got_own:
                own.release()

    def take_thread(self, wait_s: float, stop: Callable[[], bool] = lambda: False) -> bool:
        """One of the instance's slots for a thread outside any request (a
        chain's step or stamp): waits up to ``wait_s``, or until ``stop()``
        says so; ``False`` when none came free. Given back by ``give_back_thread``."""
        deadline = time.monotonic() + wait_s
        with self._changed:
            while self._free == 0:
                left = deadline - time.monotonic()
                if left <= 0 or stop():
                    return False
                self._changed.wait(min(left, POLL_S[1]))
            self._free -= 1
            return True

    def give_back_thread(self) -> None:
        self._give_back()


class HashingSlots:
    """Password checks of sign-in, setup and password change, waited for in the event loop.

    The check itself is bounded in ``accounts`` (``MAX_HASHING``), but a request
    waiting there holds a worker thread for up to ``HASHING_WAIT_S``: a flood of
    sign-ins, no account needed, would take every thread and stall the whole
    API. Here a request waits on no thread and reaches one only with a slot.
    """

    def __init__(self, total: int, wait_s: float) -> None:
        self.total = total
        self.wait_s = wait_s
        self._all: anyio.Semaphore | None = None  # see QuerySlots

    @asynccontextmanager
    async def hold(self) -> AsyncIterator[None]:
        if self._all is None:
            self._all = anyio.Semaphore(self.total)
        slots = self._all
        got = False
        try:
            with anyio.move_on_after(self.wait_s):
                await slots.acquire()
                got = True
            if not got:
                raise HashingBusy
            yield
        finally:
            if got:
                slots.release()
