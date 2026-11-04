"""Ending a process when another one ends (PCBV_STOP_WITH_PID), shared by `pcbv serve` and `pcbv vdev`."""
from __future__ import annotations

import os
import select
import signal
import threading

MAX_PID = 2**22


def watched_pid() -> int | None:
    """The process whose end ends this service (PCBV_STOP_WITH_PID); `ValueError` when it is not a process id."""
    text = os.environ.get("PCBV_STOP_WITH_PID", "")
    if not text:
        return None
    if not (text.isascii() and text.isdigit()) or not 2 <= int(text) <= MAX_PID:
        raise ValueError(text)
    return int(text)


def stop_when_process_ends(fd: int) -> None:
    """Sends this process SIGTERM once the process behind the pidfd has ended, which takes the normal shutdown path."""
    def wait() -> None:
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        poller.poll()
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=wait, name="stop-with-app", daemon=True).start()
