"""Fixed budgets for memory and concurrent work, shared by the routes.

Nothing here waits: a request that does not fit is refused with WorkBusy so the queue of waiting
work cannot itself grow. Budgets are bookkeeping on declared sizes; they are not a bound on the
whole process, since parsing makes transient copies of what was admitted.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager

MiB = 1024 * 1024

UPLOAD_BUDGET = 400 * MiB          # request bodies being read right now, all routes together
JOB_SLOTS = 2                      # logic import, decode and cache-miss loads at the same time
LOGIC_CACHE_BYTES = 400 * MiB      # retained samples of parsed captures
LOGIC_CACHE_ENTRIES = 2
VISION_CACHE_BYTES = 64 * MiB      # decoded pixels of photos prepared for the assistant


class WorkBusy(Exception):
    """The service is at one of its fixed limits. Maps to HTTP 429."""


class BodyTooLarge(Exception):
    """A request body passed the limit for its route. Maps to HTTP 413."""


class ByteBudget:
    def __init__(self, limit: int):
        self.limit = limit
        self.used = 0

    def reserve(self, size: int) -> None:
        if self.used + size > self.limit:
            raise WorkBusy("The service is busy with other uploads; try again in a moment")
        self.used += size

    def release(self, size: int) -> None:
        self.used = max(0, self.used - size)


class JobSlots:
    def __init__(self, limit: int):
        self.limit = limit
        self.active = 0

    @contextmanager
    def hold(self) -> Iterator[None]:
        if self.active >= self.limit:
            raise WorkBusy("The service is already importing or decoding captures; try again in a moment")
        self.active += 1
        try:
            yield
        finally:
            self.active -= 1


class ByteLru[K, V]:
    """Least recently used values under an entry count and a byte budget. A single value larger
    than the budget is not kept."""

    def __init__(self, max_bytes: int, size: Callable[[V], int], max_entries: int | None = None):
        self.max_bytes, self.max_entries, self._size = max_bytes, max_entries, size
        self._items: OrderedDict[K, tuple[V, int]] = OrderedDict()
        self._lock = threading.Lock()

    @property
    def bytes(self) -> int:
        return sum(size for _, size in self._items.values())

    def __len__(self) -> int:
        return len(self._items)

    def __contains__(self, key: K) -> bool:
        return key in self._items

    def get(self, key: K) -> V | None:
        with self._lock:
            found = self._items.get(key)
            if found is None:
                return None
            self._items.move_to_end(key)
            return found[0]

    def put(self, key: K, value: V) -> None:
        size = self._size(value)
        with self._lock:
            self._items.pop(key, None)
            if size > self.max_bytes:
                return
            self._items[key] = (value, size)
            total = sum(s for _, s in self._items.values())
            while len(self._items) > 1 and (total > self.max_bytes or (self.max_entries and len(self._items) > self.max_entries)):
                _, (_, dropped) = self._items.popitem(last=False)
                total -= dropped
