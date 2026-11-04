"""Append-only event journal (JSON Lines), the source of truth for a board.

Guarantees:
  * every appended event is flushed and fsynced before append() returns
  * sequence numbers are 1, 2, 3, ... with no gaps
  * a torn final line (crash mid-write) is detected and can be repaired
  * damage anywhere else is never repaired silently: it raises JournalError
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .fsutil import Directory, write_all
from .hints import command


class JournalError(RuntimeError):
    """The journal is damaged in a way that must not be guessed around."""


@dataclass
class JournalRead:
    events: list[dict]
    torn_tail: bool          # final suffix without a newline was ignored
    valid_bytes: int         # length of the intact prefix (where a repair truncates to)


def read_journal(path: Path, *, root: Directory | None = None) -> JournalRead:
    with Directory(root if root is not None else path.parent) as directory:
        data = directory.read_bytes("journal/events.jsonl" if root is not None else path.name)
    events: list[dict] = []
    valid = 0
    torn = False
    lines = data.split(b"\n")
    # split() leaves a final element: empty if the file ends in "\n", otherwise a partial line.
    complete, tail = lines[:-1], lines[-1]
    for number, raw in enumerate(complete, start=1):
        event = _parse_line(raw, number, path)
        _check_seq(event, len(events) + 1, number, path)
        events.append(event)
        valid += len(raw) + 1
    if tail:
        torn = True
    return JournalRead(events, torn, valid)


def _parse_line(raw: bytes, number: int, path: Path) -> dict:
    try:
        event = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise JournalError(f"{path.name} line {number} is not valid JSON: {exc}") from exc
    if not isinstance(event, dict) or type(event.get("seq")) is not int:
        raise JournalError(f"{path.name} line {number} is not an event object with a seq")
    if type(event.get("journalVersion")) is not int or event["journalVersion"] != 2:
        found = json.dumps(event["journalVersion"]) if "journalVersion" in event else "missing"
        raise JournalError(
            f"unsupported journal version {found} at seq {event['seq']}; this service reads journal version 2. "
            f"Recreate the test board with {command('new')} or {command('demo')}"
        )
    if len(raw) + 1 > 1_000_000 or not isinstance(event.get("ts"), str) or not isinstance(event.get("actor"), str):
        raise JournalError(f"invalid envelope at seq {event.get('seq')}")
    return event


def _check_seq(event: dict, expected: int, number: int, path: Path) -> None:
    if event["seq"] != expected:
        raise JournalError(
            f"{path.name} line {number} has seq {event['seq']}, expected {expected} "
            "(a line was lost, duplicated or reordered)"
        )


def repair_tail(path: Path, read: JournalRead, *, root: Directory | None = None) -> None:
    """Discard the suffix without a newline and durably retain the intact prefix."""
    if not read.torn_tail:
        return
    with Directory(root if root is not None else path.parent) as directory:
        fd = directory.open("journal/events.jsonl" if root is not None else path.name, os.O_RDWR)
        try:
            os.ftruncate(fd, read.valid_bytes)
            os.fsync(fd)
        finally:
            os.close(fd)


class StorageError(OSError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class Journal:
    def __init__(self, path: Path, *, root: Directory | None = None):
        self.path = path
        self._directory = root.subdirectory("journal") if root is not None else Directory(path.parent)
        self._fd = None
        try:
            self._fd = self._directory.open(path.name, os.O_CREAT | os.O_APPEND | os.O_RDWR)
            os.fsync(self._fd)
            os.fsync(self._directory.fd)
        except OSError as exc:
            self.close()
            raise StorageError("recovery_required", "Cannot establish journal durability; reopen the board") from exc
        self.frozen = False

    def append(self, event: dict) -> None:
        if self.frozen:
            raise StorageError("recovery_required", "Reopen the board to resolve its journal outcome")
        line = (json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode()
        if len(line) > 1_000_000:
            raise ValueError("stored record exceeds 1000000 UTF-8 bytes")
        offset = os.lseek(self._fd, 0, os.SEEK_END)
        try:
            write_all(self._fd, line)
            os.fsync(self._fd)
        except OSError as exc:
            try:
                os.ftruncate(self._fd, offset)
                os.fsync(self._fd)
                if os.fstat(self._fd).st_size != offset:
                    raise OSError("rollback size verification failed")
                os.close(self._fd)
                self._fd = None
                self._fd = self._directory.open(self.path.name, os.O_APPEND | os.O_RDWR)
            except OSError:
                self.frozen = True
                raise StorageError("commit_unknown", "Journal rollback could not be verified; reopen the board before writing") from exc
            raise StorageError("not_committed", "Journal write failed and was durably rolled back") from exc

    def close(self) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        self._directory.close()
