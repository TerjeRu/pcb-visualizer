"""Boards and their events: list, create, read, apply, and the live board WebSocket."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from .. import settings as appsettings
from ..boards import list_boards
from ..datarepo import board_history
from ..events import EventConflict, EventError
from ..journal import StorageError
from ..reveal import reveal
from ..sender import ClientSender, encode
from .body import body_json
from .serial import serial_state
from .state import State, submit
from .wsauth import ws_authenticate

router = APIRouter()
CLIENT_ACTORS = ("web", "cli", "http", "ws")
RECENT_EVENTS = 50


def client_actor(value: Any, default: str) -> str:
    actor = default if value is None else value
    if actor not in CLIENT_ACTORS:
        raise EventError(f"The actor must be one of: {', '.join(CLIENT_ACTORS)}.")
    return actor


@router.get("/api/boards")
async def boards(state: State):
    return {"boards": list_boards(state.registry.root)}


@router.post("/api/boards", status_code=201)
async def create_board(request: Request, state: State):
    data = await body_json(request)
    name = data.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise EventError("The name must be text of 1 to 120 characters.")
    slug, entry = state.registry.create(name.strip())
    return {"slug": slug, "seq": entry.board.seq}


@router.get("/api/boards/{slug}")
async def board_state(slug: str, state: State):
    entry = state.registry.get(slug)
    return {"slug": slug, "seq": entry.board.seq, "project": entry.board.project,
            "warnings": entry.board.warnings, "storage": entry.board.storage,
            "directory": str(entry.board.directory)}


@router.get("/api/boards/{slug}/events")
async def board_events(slug: str, state: State, since: int = 0):
    entry = state.registry.get(slug)
    if since < 0 or since > entry.board.seq:
        raise EventConflict(f"The since value {since} is outside the range 0 to {entry.board.seq}.")
    return {"seq": entry.board.seq, "events": entry.board.events_since(since)}


@router.post("/api/boards/{slug}/events", status_code=201)
async def post_event(slug: str, request: Request, state: State):
    entry = state.registry.get(slug)
    data = await body_json(request)
    stored = await submit(entry, data.get("event"), client_actor(data.get("actor"), "http"))
    return {"event": stored}


@router.get("/api/boards/{slug}/commits")
async def board_commits(slug: str, state: State):
    """Commits in the data repo that touched this board's folder, newest first (up to 200). Empty while git is off."""
    entry = state.registry.get(slug)
    if (await asyncio.to_thread(appsettings.load, state.registry.root))["git"] != "on":
        return {"commits": []}
    return {"commits": await asyncio.to_thread(board_history, entry.board.directory)}


@router.post("/api/boards/{slug}/reveal")
async def reveal_board(slug: str, state: State):
    """Open the board's folder in the file manager. Takes no input: the path is the service's own."""
    entry = state.registry.get(slug)
    return {"opened": await asyncio.to_thread(reveal, entry.board.directory)}


@router.websocket("/api/boards/{slug}/ws")
async def board_socket(websocket: WebSocket, slug: str, state: State):
    authenticated = await ws_authenticate(websocket, slug, state)
    if authenticated is None:
        return
    hello, entry = authenticated
    try:
        actor = client_actor(hello.get("actor"), "ws")
    except EventError as exc:
        await websocket.send_json({"op": "error", "code": "invalid_event", "error": "invalid_event", "message": str(exc)})
        await websocket.close(code=4400)
        return
    sender = ClientSender(websocket.send_text, lambda code, reason: websocket.close(code=code, reason=reason))
    sender_task = asyncio.create_task(sender.run())
    receive_task = None
    try:
        since = hello.get("sinceSeq")
        async with entry.lock:  # nothing can be applied between the catch-up and joining the stream
            board = entry.board
            resume = None
            if isinstance(since, int) and not isinstance(since, bool) and 0 <= since <= board.seq:
                resume = [encode({"op": "ready", "mode": "resume", "seq": board.seq, "storage": board.storage}),
                          *(encode({"op": "event", "event": event}) for event in board.events_since(since))]
                # A catch-up the outbox cannot hold would overflow on every reconnect; a snapshot always fits.
                if len(resume) > sender.max_messages // 2 or sum(map(len, resume)) > sender.max_bytes // 2:
                    resume = None
            if resume is not None:
                for data in resume:
                    sender.put(data)
            else:
                # The last events come along so a freshly opened app can show recent history.
                recent = board.events_since(max(0, board.seq - RECENT_EVENTS))
                sender.put(encode({"op": "snapshot", "seq": board.seq, "project": board.project, "recent": recent, "storage": board.storage}))
            session = state.serials.for_board(slug)
            sender.put(encode({"op": "serial", "state": serial_state(state, slug),
                               "backlog": session.backlog_text() if session else ""}))
            entry.clients.add(sender)

        async def receive_messages() -> None:
            try:
                while True:
                    try:
                        message = await websocket.receive_json()
                    except ValueError:
                        sender.close_after(4400)
                        return
                    op = message.get("op") if isinstance(message, dict) else None
                    msg_id = message.get("id") if isinstance(message, dict) else None
                    if op == "ping":
                        sender.put(encode({"op": "pong", "id": msg_id}))
                    elif op == "apply":
                        try:
                            stored = await submit(entry, message.get("event"), client_actor(message.get("actor"), actor))
                        except StorageError as exc:
                            sender.put(encode({"op": "error", "id": msg_id, "code": exc.code, "error": exc.code, "message": str(exc), "storage": entry.board.storage}))
                        except EventError as exc:
                            sender.put(encode({"op": "error", "id": msg_id, "code": "invalid_event", "message": str(exc)}))
                        except EventConflict as exc:
                            sender.put(encode({"op": "error", "id": msg_id, "code": "conflict", "message": str(exc)}))
                        else:
                            sender.put(encode({"op": "ack", "id": msg_id, "seq": stored["seq"], "warnings": entry.board.warnings, "storage": entry.board.storage, **({"warningDetails": entry.board.warning_details} if entry.board.warning_details else {})}))
                    else:
                        sender.put(encode({"op": "error", "id": msg_id, "code": "invalid_event",
                                           "message": f"unknown op {op!r}"}))
            except WebSocketDisconnect:
                pass

        receive_task = asyncio.create_task(receive_messages())
        await asyncio.wait({sender_task, receive_task}, return_when=asyncio.FIRST_COMPLETED)
        if sender.closing and not sender_task.done():
            await asyncio.wait({sender_task})  # a close we asked for still has to go out
    finally:
        entry.clients.discard(sender)
        tasks = [task for task in (receive_task, sender_task) if task is not None]
        for task in tasks:
            task.cancel()
        # Not gather: when this handler is cancelled too, gather raises the cancellation of the tasks
        # cancelled here instead of its own, and the server running the handler cannot recognise it.
        await asyncio.wait(tasks)
    if receive_task is not None and not receive_task.cancelled() and receive_task.exception():
        raise receive_task.exception()
