"""What the service holds while it runs. Every router reaches it through the `State` dependency."""
from __future__ import annotations

import asyncio
import copy
import hmac
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends
from starlette.requests import HTTPConnection

from ..assistant import AssistantService
from ..board import Board
from ..boards import TUTORIAL_SLUG, InvalidSlug, board_path, practice_path, slugify
from ..captures import capture_stopped_patch
from ..settings import assistant_on
from ..limits import ByteBudget, ByteLru, JobSlots
from ..sender import ClientSender, encode
from ..serialmgr import SerialManager
from ..sessioncodes import CodeStore
from ..vdevmanager import VdevManager


@dataclass
class Entry:
    board: Board
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    clients: set[ClientSender] = field(default_factory=set)


class Registry:
    """Boards opened by this service. Opening takes the single-writer lock; closing frees it."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.entries: dict[str, Entry] = {}

    def get(self, slug: str) -> Entry:
        if slug in self.entries:
            return self.entries[slug]
        directory = practice_path() if slug == TUTORIAL_SLUG else board_path(self.root, slug)  # InvalidSlug
        entry = Entry(Board.open(directory))     # BoardNotFound, BoardLocked, JournalError
        self.entries[slug] = entry
        return entry

    def create(self, name: str) -> tuple[str, Entry]:
        slug = slugify(name)
        if slug == TUTORIAL_SLUG:
            raise InvalidSlug("That name is reserved.")
        directory = board_path(self.root, slug)
        entry = Entry(Board.create(directory, name, actor="http", agents_md=assistant_on(self.root)))
        self.entries[slug] = entry
        return slug, entry

    def forget(self, slug: str) -> None:
        """Close a board and drop it, so its folder can be removed."""
        entry = self.entries.pop(slug, None)
        if entry:
            entry.board.close()

    def close_all(self) -> None:
        for entry in self.entries.values():
            entry.board.close()
        self.entries.clear()


@dataclass
class AppState:
    token: str
    registry: Registry
    assistant: AssistantService
    playbooks_dir: Path
    wiki_dir: Path
    uploads: ByteBudget
    jobs: JobSlots
    logic_cache: ByteLru
    codes: CodeStore = field(default_factory=CodeStore)
    serials: SerialManager = field(default_factory=SerialManager)
    terminals: set = field(default_factory=set)
    serial_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    serial_tasks: set[asyncio.Task] = field(default_factory=set)
    logic_loading: dict[tuple[str, str], asyncio.Task] = field(default_factory=dict)
    tutorial_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    vdev: VdevManager = field(default_factory=VdevManager)
    vdev_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def token_ok(self, candidate: Any) -> bool:
        return isinstance(candidate, str) and hmac.compare_digest(candidate.encode(), self.token.encode())

    def serial_lock(self, slug: str) -> asyncio.Lock:
        return self.serial_locks.setdefault(slug, asyncio.Lock())

    def track(self, coro) -> None:
        task = asyncio.create_task(coro)
        self.serial_tasks.add(task)
        task.add_done_callback(self.serial_tasks.discard)

    async def construct_session(self, factory, cleanup):
        task = asyncio.create_task(asyncio.to_thread(factory))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            def dispose(done):
                if not done.cancelled() and done.exception() is None:
                    self.track(asyncio.to_thread(cleanup, done.result()))

            task.add_done_callback(dispose)
            raise

    async def close(self) -> None:
        for session in self.serials.close_all():          # record every open capture as stopped
            try:
                entry = self.registry.get(session.slug)
                await submit(entry, {"type": "capture/stopped", "id": session.id,
                                     "patch": capture_stopped_patch("service stopped", size=session.bytes)},
                             "service", internal=True)
            except Exception:  # noqa: BLE001, S110 - shutting down; the capture file itself is complete
                pass
        await asyncio.to_thread(self.vdev.stop_child)        # an owned virtual board never outlives the service
        for term in list(self.terminals):
            await asyncio.to_thread(term.terminate)
        self.registry.close_all()


async def app_state(connection: HTTPConnection) -> AppState:
    return connection.app.state.pcbv


State = Annotated[AppState, Depends(app_state)]


async def submit(entry: Entry, raw: Any, actor: str, *, internal: bool = False) -> dict:
    """The only write path. One lock per board gives every client the same order.

    `raw` can be a function of the current project that returns the event; it runs under the lock,
    after an outside edit of project.pcb.json is taken in, for a change that must be built from the
    latest state (turning a photo)."""
    async with entry.lock:
        before = entry.board.seq
        storage_before = copy.deepcopy(entry.board.storage)
        try:
            if callable(raw):
                raw = raw(entry.board.latest_project())
            stored = entry.board.apply(raw, actor, internal=internal)
        finally:
            # Includes an outside edit of project.pcb.json recorded just before this event,
            # even when this event itself was then rejected.
            broadcast_changes(entry, before, storage_before)
    return stored


def broadcast_changes(entry, before, storage_before):
    events = entry.board.events_since(before)
    for event in events:
        broadcast(entry, {"op": "event", "event": event, "storage": entry.board.storage})
    if not events and entry.board.storage != storage_before:
        broadcast(entry, {"op": "storage", "storage": entry.board.storage})


def broadcast(entry: Entry, message: dict) -> None:
    """Queue a message for every client of the board. Never waits on a socket."""
    if not entry.clients:
        return
    data = encode(message)
    for client in list(entry.clients):
        if not client.put(data):
            entry.clients.discard(client)
