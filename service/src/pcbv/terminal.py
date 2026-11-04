"""Terminal panel sessions: a shell on a pty in the board folder, captured like `pcbv shell`.

The service starts the person's shell with the board folder as working directory, appends
everything that crosses the pty to `captures/shell/<time>_<id>.log`, and streams output to the
app's xterm.js over a WebSocket. On exit the transcript is scanned with the console recogniser.
"""
from __future__ import annotations

import asyncio
import codecs
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import threading
from collections import deque
from collections.abc import Callable
from pathlib import Path

from .captures import new_capture_id
from .fsutil import Directory, File, open_capture
from .serialmgr import write_capture

CAPTURE_DIR = "captures/shell"
MAX_INPUT = 64_000
MAX_PENDING_INPUT = 256 * 1024
QUEUE_ITEMS = 256
QUEUE_BYTES = 1024 * 1024
LOSS_NOTICE = "\r\n[pcbv: output skipped because the window could not keep up]\r\n"
INPUT_NOTICE = "\r\n[pcbv: input dropped because the program is not reading it]\r\n"


class OutputQueue:
    """Terminal output on its way from the reader thread to the WebSocket sender.

    Bounded by item count and bytes: when it is full the oldest output is dropped and one notice is
    queued for the gap, so `cat /dev/urandom` cannot grow memory. The exit is kept apart from the
    output, so a flood can neither push it out nor be mistaken for it. The thread wakes the loop with
    at most one callback pending at a time, however fast it produces output.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, *, max_items: int = QUEUE_ITEMS, max_bytes: int = QUEUE_BYTES):
        self._loop, self._max_items, self._max_bytes = loop, max_items, max_bytes
        self._items: deque[tuple[str, int]] = deque()
        self._bytes = 0
        self._lost = False
        self._exit: int | None = None
        self._exited = False
        self._wake_pending = False
        self._lock = threading.Lock()
        self._ready = asyncio.Event()

    def put(self, text: str) -> None:
        """Any thread."""
        size = len(text.encode("utf-8", errors="replace"))
        with self._lock:
            self._items.append((text, size))
            self._bytes += size
            while len(self._items) > self._max_items or self._bytes > self._max_bytes:
                self._bytes -= self._items.popleft()[1]
                self._lost = True
        self._wake()

    def close(self, code: int) -> None:
        """Any thread. The exit code is delivered after the queued output."""
        with self._lock:
            self._exit, self._exited = code, True
        self._wake()

    def _wake(self) -> None:
        with self._lock:
            if self._wake_pending:
                return
            self._wake_pending = True
        try:
            self._loop.call_soon_threadsafe(self._signal)
        except RuntimeError:                         # the loop is already closed: nothing left to tell
            pass

    def _signal(self) -> None:
        with self._lock:
            self._wake_pending = False
        self._ready.set()

    async def get(self) -> tuple[str, str | int]:
        """("output", text), or ("exit", code) once the output is drained."""
        await asyncio.sleep(0)                       # a flood must not keep the loop from reading the window's input
        while True:
            with self._lock:
                if self._lost:
                    self._lost = False
                    return "output", LOSS_NOTICE
                if self._items:
                    text, size = self._items.popleft()
                    self._bytes -= size
                    return "output", text
                if self._exited:
                    return "exit", self._exit
                self._ready.clear()
            await self._ready.wait()


class TerminalSession:
    def __init__(self, *, board_dir: Path, slug: str, cols: int, rows: int,
                 on_output: Callable[[str], None], on_exit: Callable[[int], None]):
        self.slug = slug
        self.id, self.rel_path = new_capture_id(CAPTURE_DIR, "log")
        self.file_path = File(board_dir, self.rel_path)
        self._log = open_capture(board_dir, self.rel_path)
        self.bytes = 0
        self._on_output, self._on_exit = on_output, on_exit
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._pending = bytearray()
        self._input = threading.Condition()
        self._closing = False
        self._refused = False
        try:
            self._master, slave = pty.openpty()
        except BaseException:
            self._log.close()
            raise
        self.recording_error = None
        try:
            # Only the master: input is written from a thread that must notice the close, and must never
            # hang in a write because the shell stopped reading. The shell's side stays blocking.
            os.set_blocking(self._master, False)
            self.resize(cols, rows)
            shell = os.environ.get("SHELL") or "/bin/sh"
            env = {**os.environ, "PCBV_BOARD": slug, "PCBV_CAPTURE": self.id, "TERM": "xterm-256color"}
            with Directory(board_dir) as directory:
                self._process = subprocess.Popen(  # noqa: S603 - the person's own login shell, no shell string
                    [shell, "-l"], cwd=f"/proc/self/fd/{directory.fd}", env=env, stdin=slave, stdout=slave, stderr=slave,
                    start_new_session=True, close_fds=True, pass_fds=(directory.fd,))
        except BaseException:
            self._close_fds()
            raise
        finally:
            os.close(slave)
        self._writer = threading.Thread(target=self._write_loop, name=f"terminal-{self.id}-input", daemon=True)
        self._thread = threading.Thread(target=self._read_loop, name=f"terminal-{self.id}", daemon=True)
        try:
            self._writer.start()
            self._thread.start()
        except BaseException:
            try:
                os.killpg(self._process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            self._process.wait()
            self._stop_writer()
            self._close_fds()
            raise

    def _read_loop(self) -> None:
        poller = select.poll()
        poller.register(self._master, select.POLLIN)
        try:
            while True:
                poller.poll()
                try:
                    data = os.read(self._master, 4096)
                except BlockingIOError:
                    continue
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    break
                write_capture(self._log, data)
                self.bytes += len(data)
                self._on_output(self._decoder.decode(data))
        except OSError as exc:
            self.recording_error = f"recording error: {exc}"
        finally:
            with self._input:
                self._closing = True
                self._input.notify()
            if self._process.poll() is None:
                try:
                    os.killpg(self._process.pid, signal.SIGHUP)
                except (ProcessLookupError, PermissionError):
                    pass
            try:
                code = self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self._process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                code = self._process.wait()
            self._stop_writer()
            self._close_fds()
            self._on_exit(code)

    def _stop_writer(self) -> None:
        # Joined before the master is closed: a writer still running could otherwise write into
        # whatever file the next open() gets the same descriptor number for.
        with self._input:
            self._closing = True
            self._input.notify()
        if self._writer.ident is not None:
            self._writer.join()

    def _write_loop(self) -> None:
        poller = select.poll()
        poller.register(self._master, select.POLLOUT)
        while True:
            with self._input:
                while not self._pending and not self._closing:
                    self._input.wait()
                if self._closing:
                    return
                chunk = bytes(self._pending[:65536])
            try:
                written = os.write(self._master, chunk)
            except BlockingIOError:
                poller.poll(200)
                continue
            except OSError:
                with self._input:
                    self._pending.clear()
                    self._refused = False
                return
            with self._input:
                del self._pending[:written]
                if not self._pending:
                    self._refused = False

    def write(self, text: str) -> None:
        """Event loop. Queues the input for the writer thread and never waits on the pty."""
        data = text.encode("utf-8", errors="replace")      # a lone surrogate must not end the session
        if len(data) > MAX_INPUT:
            cut = MAX_INPUT
            while cut and data[cut] & 0xC0 == 0x80:      # a UTF-8 continuation byte: the cut is inside a character
                cut -= 1
            data = data[:cut]
        with self._input:
            if self._closing or self.recording_error:
                return
            if len(self._pending) + len(data) <= MAX_PENDING_INPUT:
                self._pending += data
                self._input.notify()
                return
            notify, self._refused = not self._refused, True
        if notify:
            self._on_output(INPUT_NOTICE)

    def resize(self, cols: int, rows: int) -> None:
        cols = max(10, min(int(cols), 500))
        rows = max(3, min(int(rows), 200))
        try:
            fcntl.ioctl(self._master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def _close_fds(self) -> None:
        for closer in (lambda: os.close(self._master), self._log.close):
            try:
                closer()
            except OSError:
                pass

    def terminate(self) -> None:
        """End the shell and everything it started (it runs in its own session)."""
        if self._process.poll() is None:
            try:
                os.killpg(self._process.pid, signal.SIGHUP)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self._process.pid, signal.SIGKILL)
        self._thread.join(timeout=2)
