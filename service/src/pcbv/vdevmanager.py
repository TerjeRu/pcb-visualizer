"""Runs the virtual board (`pcbv vdev`) for the app, as a child process the service owns.

A child process, not a thread: `vdev.run` installs signal handlers, which only work in a main thread.
The child gets PCBV_STOP_WITH_PID, so it ends with the service even after `kill -9` on the service.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from .serialmgr import vdev_link

START_WAIT = 5.0
STOP_WAIT = 2.0
STDERR_LINES = 5


class VdevError(Exception):
    """A start that failed; the message holds the first lines the child printed."""


class NotOwned(Exception):
    """Stop was asked for a virtual board this service did not start."""


def link_is_live(link: Path | None = None) -> bool:
    """The test `list_ports()` uses: a symlink whose pty still exists."""
    link = link or vdev_link()
    return link.is_symlink() and Path(os.path.realpath(link)).exists()


class VdevManager:
    def __init__(self):
        self.child: subprocess.Popen | None = None

    def _owned_child(self) -> subprocess.Popen | None:
        if self.child is not None and self.child.poll() is not None:
            self.child = None
        return self.child

    def status(self) -> dict:
        running = link_is_live()
        return {"running": running, "owned": running and self._owned_child() is not None, "path": str(vdev_link())}

    def start(self) -> dict:
        """Starts the virtual board unless one runs already (then nothing starts)."""
        if link_is_live():
            return self.status()
        self._owned_child()
        if self.child is not None:                   # alive but its link is gone: do not leave two
            self.stop_child()
        env = {**os.environ, "PCBV_STOP_WITH_PID": str(os.getpid())}
        child = subprocess.Popen([sys.executable, "-I", "-m", "pcbv", "vdev"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.child = child
        deadline = time.monotonic() + START_WAIT
        while time.monotonic() < deadline:
            if link_is_live():
                return self.status()
            if child.poll() is not None:
                break
            time.sleep(0.05)
        if self.child is child:
            self.child = None
        raise VdevError(end_child(child) or "The virtual board did not start.")

    def stop(self) -> dict:
        """Stops a virtual board this manager started; refuses one started elsewhere."""
        if self._owned_child() is None:
            if link_is_live():
                raise NotOwned("The virtual board was started outside the app.")
            return self.status()
        self.stop_child()
        return self.status()

    def stop_child(self) -> str:
        """SIGTERM, wait, then SIGKILL; also what the service does on shutdown. Returns the child's first stderr lines."""
        child, self.child = self.child, None
        return end_child(child) if child is not None else ""


def end_child(child: subprocess.Popen) -> str:
    """Ends one child (a failed start holds its own, as `status()` may already have let go of it)."""
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(STOP_WAIT)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    text = ""
    if child.stderr:
        try:
            text = "\n".join(child.stderr.read().splitlines()[:STDERR_LINES])
        except (OSError, ValueError):
            pass
        child.stderr.close()
    return text
