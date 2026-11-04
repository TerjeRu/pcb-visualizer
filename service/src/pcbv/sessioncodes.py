"""One-time codes that stand in for the session token when a window is opened.

A code is minted by an authenticated caller, lives for 60 seconds and is redeemed once, in exchange for the
token. It keeps the long-lived token out of launch arguments and navigation URLs; during its lifetime it is
still a credential. Codes live in memory only and die with the service.
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections.abc import Callable

CODE_TTL_S = 60
MAX_LIVE_CODES = 128


class CodesFull(RuntimeError):
    """Too many unredeemed codes are alive."""


class CodeStore:
    def __init__(self, clock: Callable[[], float] | None = None, ttl: float = CODE_TTL_S, capacity: int = MAX_LIVE_CODES):
        self._clock, self._ttl, self._capacity = clock or (lambda: time.monotonic()), ttl, capacity
        self._live: dict[str, float] = {}          # sha-256 of the code -> expiry on the monotonic clock
        self._lock = threading.Lock()

    @staticmethod
    def _key(code: str) -> str:
        return hashlib.sha256(code.encode()).hexdigest()

    def _prune(self, now: float) -> None:
        for key in [k for k, expiry in self._live.items() if expiry <= now]:
            del self._live[key]

    def mint(self) -> str:
        with self._lock:
            self._prune(self._clock())
            if len(self._live) >= self._capacity:
                raise CodesFull("too many unused codes; wait a minute")
            code = secrets.token_urlsafe(32)
            self._live[self._key(code)] = self._clock() + self._ttl
            return code

    def redeem(self, code: object) -> bool:
        """True exactly once for a live code; the code is gone either way."""
        if not isinstance(code, str) or not 1 <= len(code) <= 128:
            return False
        with self._lock:
            expiry = self._live.pop(self._key(code), None)
            return expiry is not None and expiry > self._clock()

    def __len__(self) -> int:
        with self._lock:
            self._prune(self._clock())
            return len(self._live)
