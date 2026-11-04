"""`pcbv shell`: a shell in the board folder whose whole session is captured.

Everything that crosses the terminal, what you type and what comes back, is appended to
`captures/shell/<time>_<id>.log` in the board folder, like `script(1)`. The session is recorded
as a capture (kind "shell") through the running service, or straight into the board folder when
no service runs. When the shell exits, the transcript is scanned with the same recogniser as
serial consoles, so running `tio` inside pcbv shell satisfies the same playbook checks.
"""
from __future__ import annotations

import fcntl
import errno
import os
import pty
import signal
import struct
import sys
import termios
import tty
from pathlib import Path

from .captures import capture_stopped_patch, new_capture_id
from .fsutil import File, open_capture
from .board import Board
from .boards import board_path
from .edits import HttpWriter
from .schema import now_iso
from .serialmgr import scan_stream, write_capture


class RecordingError(Exception):
    pass


def _start_local(root: Path, slug: str, label: str) -> dict:
    capture_id, path = new_capture_id("captures/shell", "log")
    capture = {"id": capture_id, "kind": "shell", "path": path, "label": label, "started": now_iso()}
    with Board.open(board_path(root, slug)) as board:
        board.apply({"type": "capture/started", "capture": capture}, "cli", internal=True)
    return capture


def _stop_local(root: Path, slug: str, capture: dict, transcript: Path, reason: str = "closed") -> None:
    try:
        with File(board_path(root, slug), str(transcript.relative_to(board_path(root, slug)))).open() as stream:
            size, seen = scan_stream(stream)
    except FileNotFoundError:
        size, seen = 0, []
    patch = capture_stopped_patch(reason, size=size, kind="shell", seen=seen)
    with Board.open(board_path(root, slug)) as board:
        board.apply({"type": "capture/stopped", "id": capture["id"], "patch": patch}, "cli", internal=True)


def _copy_winsize(target_fd: int) -> None:
    try:
        size = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass                              # not a terminal (tests, pipes): keep the default size


def _spawn(argv, read) -> int:
    pid, master = pty.fork()
    if pid == 0:
        os.execlp(argv[0], *argv)  # noqa: S606 - the person's chosen shell and arguments
    previous = None
    try:
        try:
            previous = termios.tcgetattr(0)
            tty.setraw(0)
        except termios.error:
            previous = None
        pty._copy(master, read, pty._read)
    except BaseException:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        raise
    finally:
        try:
            if previous is not None:
                termios.tcsetattr(0, termios.TCSAFLUSH, previous)
        finally:
            os.close(master)
            _, status = os.waitpid(pid, 0)
    return status


def run(root: Path, slug: str, service: dict | None, command: str | None = None, out=print) -> int:
    directory = board_path(root, slug)
    if not directory.is_dir():
        raise FileNotFoundError(f"no board called {slug!r} in {root}")
    label = f"pcbv shell: {command}" if command else "pcbv shell"
    writer = HttpWriter(service, slug) if service else None
    capture = writer._call("/shell", {"label": label})["capture"] if writer else _start_local(root, slug, label)
    transcript = directory / capture["path"]

    shell = os.environ.get("SHELL") or "/bin/sh"
    argv = [shell, "-c", command] if command else [shell]
    os.environ.update({"PCBV_BOARD": slug, "PCBV_CAPTURE": capture["id"]})
    if not command:
        out(f"Recording this shell to {capture['path']} in board {slug}. Type exit to stop.")

    master = {}

    def on_resize(_signum, _frame):
        if "fd" in master:
            _copy_winsize(master["fd"])

    previous = signal.signal(signal.SIGWINCH, on_resize)
    cwd = os.getcwd()
    reason = "closed"
    try:
        os.chdir(directory)
        with open_capture(directory, capture["path"]) as log:
            def read(fd: int) -> bytes:
                if "fd" not in master:
                    master["fd"] = fd
                    _copy_winsize(fd)
                try:
                    data = os.read(fd, 4096)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        raise
                    raise RecordingError(f"capture read failed: {exc}") from exc
                try:
                    write_capture(log, data)
                except OSError as exc:
                    raise RecordingError(f"capture recording failed: {exc}") from exc
                return data

            try:
                status = _spawn(argv, read)
            except RecordingError:
                reason = "recording error"
                raise
    finally:
        os.chdir(cwd)
        signal.signal(signal.SIGWINCH, previous)
        if writer:
            writer._call(f"/shell/{capture['id']}/stop", {"reason": reason})
        else:
            _stop_local(root, slug, capture, transcript, reason)
    if not command:
        out(f"Shell recording saved: {capture['path']}")
    return os.waitstatus_to_exitcode(status) if isinstance(status, int) else 0
