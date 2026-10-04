"""How many queries run at once: per account and in all (security review #5);
how many password checks sign-ins wait for (security review #23).

Each query may take up to the time limit (F-9.6) on one of the server's
worker threads. Without a bound, one account sending many at once could keep
every thread busy, and sign-ins and everyone else's work would wait. A query
holds a slot of its account and one of the instance while it runs. Waiting
for slots happens in the event loop, on no worker thread, for at most the
time limit; then the answer is "busy".
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio

from geotandem.auth.accounts import HashingBusy


class QueriesBusy(Exception):
    """No slot came free in time."""


class QuerySlots:
    def __init__(self, per_account: int, total: int, wait_s: float) -> None:
        self.per_account = per_account
        self.total = total
        self.wait_s = wait_s
        # Created on first use: anyio's primitives belong to the running event loop.
        self._all: anyio.Semaphore | None = None
        self._accounts: dict[int, anyio.Semaphore] = {}

    @asynccontextmanager
    async def hold(self, account_id: int) -> AsyncIterator[None]:
        if self._all is None:
            self._all = anyio.Semaphore(self.total)
        everyone = self._all
        own = self._accounts.setdefault(account_id, anyio.Semaphore(self.per_account))
        got_own = got_all = False
        try:
            # The account's slot first: one account's queue never holds the instance's slots.
            with anyio.move_on_after(self.wait_s):
                await own.acquire()
                got_own = True
                await everyone.acquire()
                got_all = True
            if not got_all:
                raise QueriesBusy
            yield
        finally:
            if got_all:
                everyone.release()
            if got_own:
                own.release()


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
