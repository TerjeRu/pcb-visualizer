"""One ordered, bounded outbox per board WebSocket.

Everything a client receives goes through its outbox: catch-up, snapshot, events, replies and console
output. `put` only appends, so the board lock is never held across network I/O, and one task per client
does the sending. A client that falls behind a budget, or whose socket stops accepting data, is closed
with 4408 and dropped; it resyncs on reconnect.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from collections import deque
from collections.abc import Awaitable, Callable

MiB = 1024 * 1024

MAX_QUEUED_MESSAGES = 256
MAX_QUEUED_BYTES = 8 * MiB
SEND_DEADLINE_S = 5.0

SLOW_CLIENT = 4408
OVERFLOW_REASON = "slow-client"
TOO_LARGE_REASON = "board-too-large"
TOO_LARGE_NOTICE = {"op": "error", "code": "board_too_large", "error": "board_too_large",
                    "message": "Board too large to send"}


def encode(message: dict) -> str:
    """JSON text for the wire. ASCII only, so its length is also its size in bytes."""
    return json.dumps(message, separators=(",", ":"))


class ClientSender:
    def __init__(self, send: Callable[[str], Awaitable[None]], close: Callable[[int, str], Awaitable[None]], *,
                 max_messages: int | None = None, max_bytes: int | None = None, deadline_s: float | None = None):
        self._send = send
        self._close = close
        self.max_messages = MAX_QUEUED_MESSAGES if max_messages is None else max_messages
        self.max_bytes = MAX_QUEUED_BYTES if max_bytes is None else max_bytes
        self.deadline_s = SEND_DEADLINE_S if deadline_s is None else deadline_s
        self._queue: deque[str] = deque()
        self._bytes = 0
        self._wake = asyncio.Event()
        self._final: tuple[int, str] | None = None

    @property
    def closing(self) -> bool:
        return self._final is not None

    def put(self, data: str) -> bool:
        """Queue encoded text. False when the client is being closed, including because of this message."""
        if self._final is not None:
            return False
        size = len(data)
        if size > self.max_bytes:
            self.close_after(SLOW_CLIENT, TOO_LARGE_REASON, drop=True)
            self._queue.append(encode(TOO_LARGE_NOTICE))
            return False
        if len(self._queue) >= self.max_messages or self._bytes + size > self.max_bytes:
            self.close_after(SLOW_CLIENT, OVERFLOW_REASON, drop=True)
            return False
        self._queue.append(data)
        self._bytes += size
        self._wake.set()
        return True

    def close_after(self, code: int, reason: str = "", *, drop: bool = False) -> None:
        """Close once the queue is sent, or at once when `drop` is set and queued messages are discarded."""
        if self._final is not None:
            return
        self._final = (code, reason)
        if drop:
            self._queue.clear()
            self._bytes = 0
        self._wake.set()

    async def run(self) -> None:
        """Send until the queue is empty and a close is due, or until the socket fails."""
        while True:
            if self._queue:
                data = self._queue.popleft()
                self._bytes -= len(data)
                try:
                    await asyncio.wait_for(self._send(data), self.deadline_s)
                except TimeoutError:
                    await self._close_quietly(SLOW_CLIENT, OVERFLOW_REASON)
                    return
                except Exception:  # noqa: BLE001 - the socket is gone; the receive side ends the handler
                    return
            elif self._final is not None:
                await self._close_quietly(*self._final)
                return
            else:
                self._wake.clear()
                await self._wake.wait()

    async def _close_quietly(self, code: int, reason: str) -> None:
        with contextlib.suppress(Exception):  # nothing more can be done for a socket that will not close
            await asyncio.wait_for(self._close(code, reason), self.deadline_s)
