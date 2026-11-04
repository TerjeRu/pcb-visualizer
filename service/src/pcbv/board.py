"""A board folder: journal (truth), project.pcb.json (derived snapshot), single-writer lock.

    <board>/
      project.pcb.json        snapshot of the current state, plain JSON that scripts and editors can read
      assets/                 photos
      journal/events.jsonl    append-only event log, the source of truth
      .pcbv/lock              held while a Board is open (one writer at a time)
      .pcbv/snapshot.sha256   hash of the last snapshot this service wrote (rebuildable cache)
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .fsutil import Directory, ensure_directory
from .hints import command
from .events import (
    EventError,
    EventConflict,
    validate_project,
    check_against_state,
    validate_event,
)
from .journal import Journal, JournalError, StorageError, read_journal, repair_tail
from .reducer import apply_event
from .schema import (
    ASSET_DIR,
    DEFAULT_PROJECT_FILE,
    Project,
    SCHEMA_VERSION,
    ProjectShapeError,
    check_project_shape,
    create_project,
    now_iso,
    serialize_project,
)

JOURNAL_REL = Path("journal") / "events.jsonl"
CACHE_DIR = ".pcbv"
LOCK_FILE = "lock"
SNAPSHOT_HASH_FILE = "snapshot.sha256"
ACTOR_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
# Creation and replacement preserve the supplied meta.modified timestamp.
NON_MUTATING = {"project/created", "project/replaced"}


class BoardLocked(RuntimeError):
    """Another process (normally the service) already has this board open for writing."""


class BoardNotFound(FileNotFoundError):
    pass


def fold(project: Project, event: dict) -> Project:
    """Apply one stored event. meta.modified is derived from the event time, never from the clock."""
    result = apply_event(project, event)
    if event["type"] not in NON_MUTATING:
        result["meta"]["modified"] = event["ts"]
    return result


def replay(events: list[dict]) -> Project:
    if not events or events[0].get("type") != "project/created":
        raise JournalError("journal does not start with a project/created event")
    project: Project | None = None
    for event in events:
        try:
            raw = {k: v for k, v in event.items() if k not in {"journalVersion", "seq", "ts", "actor", "proposalId"}}
            if "proposalId" in event and (event.get("type") != "board/batch" or not isinstance(event["proposalId"], str) or not 1 <= len(event["proposalId"].encode()) <= 128):
                raise EventError("invalid proposal receipt")
            payload = validate_event(raw, internal=True)
            if project is not None:
                _stage(project, payload, internal=True)
            project = fold(project, event) if project is not None else apply_event({}, event)
        except Exception as exc:  # noqa: BLE001 - any failure here means the journal is unusable
            raise JournalError(f"cannot replay event seq {event.get('seq')}: {exc}") from exc
    assert project is not None  # noqa: S101 - narrows the type; the loop always sets it
    return project


def _stage(project, event, *, internal=False):
    staged = project
    for child in event["events"] if event["type"] == "board/batch" else [event]:
        validate_event(child, internal=internal)
        check_against_state(staged, child)
        staged = apply_event(staged, child)
        validate_project(staged)
    return staged


def _check_snapshot_version(directory):
    try:
        raw = json.loads(_read_confined(directory, DEFAULT_PROJECT_FILE))
    except (FileNotFoundError, ValueError):
        return
    if isinstance(raw, dict) and raw.get("format") == "pcb-visualizer-project":
        if type(raw.get("schemaVersion")) is not int or raw["schemaVersion"] != SCHEMA_VERSION:
            found = json.dumps(raw["schemaVersion"]) if "schemaVersion" in raw else "missing"
            raise JournalError(
                f"unsupported snapshot version {found}; this service reads snapshot version {SCHEMA_VERSION}. "
                f"Recreate the test board with {command('new')} or {command('demo')}"
            )


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_confined(root, relative):
    with Directory(root) as files:
        return files.read_bytes(relative)


def snapshot_status(board_dir: Path, state: Project) -> tuple[str, Project | None]:
    """Compare project.pcb.json with the state rebuilt from the journal.

    in-sync        file parses and equals the state
    missing        no file
    corrupt        file does not parse or is not a project this service can own
    stale          file differs but is exactly what this service last wrote (a crash left it behind)
    external-edit  file differs and is not ours: somebody (a script, an editor) changed it
    """
    try:
        data = _read_confined(board_dir, DEFAULT_PROJECT_FILE)
    except FileNotFoundError:
        return "missing", None
    try:
        parsed = check_project_shape(json.loads(data))
    except (json.JSONDecodeError, UnicodeDecodeError, ProjectShapeError):
        return "corrupt", None
    if parsed == state:
        return "in-sync", parsed
    try:
        if _read_confined(board_dir, f"{CACHE_DIR}/{SNAPSHOT_HASH_FILE}").decode().strip() == _sha(data):
            return "stale", parsed
    except (FileNotFoundError, UnicodeDecodeError):
        pass
    return "external-edit", parsed


@dataclass
class Board:
    directory: Path
    project: Project
    events: list[dict]
    warnings: list[str] = field(default_factory=list)
    _journal: Journal | None = None
    _lock_fd: int | None = None
    writable: bool = True
    warning_details: dict = field(default_factory=dict)
    _snapshot_dirty: bool = False
    files: Directory | None = field(default=None, repr=False)

    @classmethod
    def create(cls, directory: Path, name: str, *, actor: str = "cli", agents_md: bool = True) -> Board:
        """`agents_md` is False while the assistant setting is off: the board then gets no briefing for agents."""
        directory = Path(directory)
        if directory.exists() and any(directory.iterdir()):
            raise FileExistsError(f"{directory} already exists and is not empty")
        ensure_directory(directory)
        with Directory(directory) as files, Directory(directory.parent) as parent:
            os.fsync(files.fd)
            os.fsync(parent.fd)
            for sub in (ASSET_DIR, JOURNAL_REL.parent, CACHE_DIR):
                with files.subdirectory(sub, create=True):
                    pass
        stamp = now_iso()
        first = {
            "journalVersion": 2, "seq": 1, "ts": stamp, "actor": actor, "type": "project/created",
            "project": create_project(name, now=stamp),
        }
        with Directory(directory) as files:
            journal = Journal(directory / JOURNAL_REL, root=files)
            try:
                journal.append(first)
            finally:
                journal.close()
        if agents_md:
            write_agents_md(directory, name)
        return cls.open(directory)

    @classmethod
    def open(cls, directory: Path) -> Board:
        directory = Path(directory)
        journal_path = directory / JOURNAL_REL
        try:
            files = Directory(directory)
        except FileNotFoundError:
            raise BoardNotFound(f"{directory} is not a board") from None
        lock_fd = None
        board = None
        try:
            try:
                preflight = read_journal(journal_path, root=files)
            except FileNotFoundError:
                raise BoardNotFound(f"{directory} is not a board (no {JOURNAL_REL})") from None
            replay(preflight.events)
            _check_snapshot_version(files)
            lock_fd = cls._acquire_lock(directory, files=files)
            read = read_journal(journal_path, root=files)
            warnings: list[str] = []
            state = replay(read.events)
            _check_snapshot_version(files)
            if read.torn_tail:
                repair_tail(journal_path, read, root=files)
                warnings.append("journal ended in an incomplete line (crash during a write); it was repaired")
            board = cls(directory, state, list(read.events), warnings, None, lock_fd, files=files)
            board._journal = Journal(journal_path, root=files)
            board._reconcile_snapshot(reopening=True)
            return board
        except BaseException:
            if board is not None and board._journal is not None:
                board._journal.close()
            if lock_fd is not None:
                os.close(lock_fd)
            files.close()
            raise

    @staticmethod
    def _acquire_lock(directory: Path, *, files=None) -> int:
        with Directory(files if files is not None else directory) as files:
            fd = files.open(f"{CACHE_DIR}/{LOCK_FILE}", os.O_CREAT | os.O_RDWR, create_parents=True)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise BoardLocked(f"{directory.name} is open in another process") from None
        return fd

    def close(self) -> None:
        if self._journal:
            self._journal.close()
            self._journal = None
        if self._lock_fd is not None:
            os.close(self._lock_fd)  # closing releases the flock
            self._lock_fd = None
        if self.files is not None:
            self.files.close()
            self.files = None

    def __enter__(self) -> Board:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @property
    def seq(self) -> int:
        return len(self.events)

    def events_since(self, seq: int) -> list[dict]:
        return self.events[seq:]

    def apply(self, raw: dict, actor: str = "unknown", *, internal: bool = False, _proposal_id: str | None = None) -> dict:
        """Validate, append to the journal, update state and snapshot. Returns the stored event.

        Raises EventError (malformed) or EventConflict (does not fit the project).
        On either, the event itself leaves no trace. An outside edit found on the way is still
        recorded (see _reconcile_snapshot), so callers should broadcast events_since(seq_before).
        """
        if not self.writable:
            raise StorageError("recovery_required", "Reopen the board before attempting another mutation")
        if not isinstance(actor, str) or not ACTOR_RE.match(actor):
            raise EventError("actor must be 1-32 chars of a-z, 0-9, '_' or '-'")
        self._reconcile_snapshot()
        event = validate_event(raw, internal=internal)   # internal: events only the service may write
        # A script or an editor can still write project.pcb.json directly. Absorb any
        # such edit first, so it is recorded in the journal and the new event applies on top of it.
        _stage(self.project, event, internal=internal)
        stored = {"journalVersion": 2, "seq": self.seq + 1, "ts": now_iso(), "actor": actor, **event}
        if _proposal_id is not None:
            if event["type"] != "board/batch" or not isinstance(_proposal_id, str) or not 1 <= len(_proposal_id.encode()) <= 128:
                raise EventError("proposal ID must be 1 to 128 UTF-8 bytes on a batch")
            stored["proposalId"] = _proposal_id
        try:
            new_project = fold(self.project, stored)
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise EventError(f"{event['type']} does not fit the project data: {exc}") from exc
        assert self._journal is not None, "board is closed"  # noqa: S101 - callers never apply to a closed board
        self._commit(stored, new_project)
        self._maintain_snapshot()
        return stored

    def _commit(self, stored: dict, project: Project) -> None:
        try:
            self._journal.append(stored)
        except ValueError as exc:
            raise EventError(str(exc)) from exc
        except StorageError as exc:
            if exc.code == "commit_unknown":
                self.writable = False
            raise
        self.events.append(stored)
        self.project = project

    def _maintain_snapshot(self) -> None:
        try:
            self._write_snapshot()
        except OSError:
            self._snapshot_dirty = True
            if "snapshot_dirty" not in self.warnings:
                self.warnings.append("snapshot_dirty")
        else:
            self._snapshot_dirty = False
            self.warnings[:] = [w for w in self.warnings if w != "snapshot_dirty"]

    @property
    def storage(self):
        result = {"writable": self.writable, "warnings": list(self.warnings)}
        if self.warning_details:
            result["warningDetails"] = self.warning_details
        return result

    def _write_snapshot(self) -> None:
        data = serialize_project(self.project).encode()
        with Directory(self.files) as files:
            files.atomic_write(DEFAULT_PROJECT_FILE, data)
            files.atomic_write(f"{CACHE_DIR}/{SNAPSHOT_HASH_FILE}", (_sha(data) + "\n").encode())

    def _preserve_snapshot(self) -> None:
        with Directory(self.files) as files:
            data = files.read_bytes(DEFAULT_PROJECT_FILE)
            relative = f".pcbv/recovery/snapshot-{_sha(data)}.json"
            try:
                try:
                    files.create_bytes(relative, data)
                except FileExistsError:
                    if files.read_bytes(relative) != data:
                        raise StorageError("recovery_required", "Snapshot recovery entry conflicts with the saved bytes") from None
                fd = files.open(relative)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                with files.parent(relative) as (parent, _):
                    os.fsync(parent)
            except OSError as exc:
                raise StorageError("recovery_required", "Cannot preserve the outside snapshot; it was left untouched") from exc
        if "external_edit_preserved" not in self.warnings:
            self.warnings.append("external_edit_preserved")
        self.warning_details["external_edit_preserved"] = {"path": relative}

    def _reconcile_snapshot(self, *, reopening=False) -> None:
        _check_snapshot_version(self.files)
        status, parsed = snapshot_status(self.files, self.project)
        if status == "in-sync":
            if self._snapshot_dirty:
                self._maintain_snapshot()
            return
        uncertain_snapshot = reopening or self._snapshot_dirty
        if status == "external-edit" and uncertain_snapshot:
            state = {}
            for event in self.events:
                state = fold(state, event)
                if state == parsed:
                    status = "stale"
                    break
        if status == "corrupt" or status == "external-edit" and uncertain_snapshot:
            self._preserve_snapshot()
        elif status == "external-edit":
            try:
                event = validate_event({"type": "project/replaced", "project": parsed}, internal=True)
            except (EventError, EventConflict, ProjectShapeError):
                self._preserve_snapshot()
                self._maintain_snapshot()
                return
            stored = {"journalVersion": 2, "seq": self.seq + 1, "ts": now_iso(), "actor": "external", **event}
            self._commit(stored, fold(self.project, stored))
            self.warnings.append(f"project.pcb.json was edited outside the service; the edit was recorded as event {stored['seq']}")
        self._maintain_snapshot()


def inspect_board(directory: Path) -> dict:
    """Describe a board without taking the lock or changing anything (safe while the service runs)."""
    directory = Path(directory)
    journal_path = directory / JOURNAL_REL
    if not journal_path.exists():
        raise BoardNotFound(f"{directory} is not a board (no {JOURNAL_REL})")
    with Directory(directory) as files:
        read = read_journal(journal_path, root=files)
        state = replay(read.events)
        _check_snapshot_version(files)
        status, _ = snapshot_status(files, state)
        in_use = False
        try:
            probe = files.open(f"{CACHE_DIR}/{LOCK_FILE}", os.O_RDWR)
        except FileNotFoundError:
            probe = None
    if probe is not None:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(probe, fcntl.LOCK_UN)
        except BlockingIOError:
            in_use = True
        finally:
            os.close(probe)
    return {
        "name": state["meta"].get("name", ""),
        "id": state["meta"].get("id", ""),
        "device": state["meta"].get("device", ""),
        "modified": state["meta"].get("modified", ""),
        "seq": len(read.events),
        "counts": {k: len(state[k]) for k in ("assets", "markers", "schematics", "components")},
        "snapshot": status,
        "journal_torn_tail": read.torn_tail,
        "open_in_service": in_use,
    }


def write_agents_md(directory: Path, name: str, *, overwrite: bool = False) -> bool:
    """Write the AGENTS.md briefing for coding agents. Returns False when one exists and is kept."""
    from importlib import resources

    path = Path(directory) / "AGENTS.md"
    if path.exists() and not overwrite:
        return False
    template = (resources.files("pcbv") / "template" / "AGENTS.md").read_text(encoding="utf-8")
    with Directory(directory) as files:
        files.atomic_write("AGENTS.md", template.replace("{name}", name).replace("{slug}", Path(directory).name).encode())
    return True
