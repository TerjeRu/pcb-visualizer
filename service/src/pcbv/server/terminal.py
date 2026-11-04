"""Shell captures: `pcbv shell` through HTTP, and the Terminal panel's shell over a WebSocket."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from ..captures import capture_stopped_patch, find_capture, new_capture_id
from ..journal import StorageError
from ..photos import resolve_file
from ..schema import now_iso
from ..serialmgr import scan_stream
from ..terminal import OutputQueue, TerminalSession
from .body import body_json
from .errors import error
from .state import State, submit
from .wsauth import ws_authenticate

router = APIRouter()


@router.post("/api/boards/{slug}/shell", status_code=201)
async def shell_start(slug: str, request: Request, state: State):
    """pcbv shell asks for a capture; the service picks the path and records capture/started."""
    entry = state.registry.get(slug)
    data = await body_json(request)
    capture_id, path = new_capture_id("captures/shell", "log")
    capture = {"id": capture_id, "kind": "shell", "path": path,
               "label": str(data.get("label") or "pcbv shell")[:80], "started": now_iso()}
    await submit(entry, {"type": "capture/started", "capture": capture}, "cli", internal=True)
    return {"capture": capture}


@router.post("/api/boards/{slug}/shell/{capture_id}/stop")
async def shell_stop(slug: str, capture_id: str, request: Request, state: State):
    """Reads the finished transcript, recognises what it can, records capture/stopped."""
    entry = state.registry.get(slug)
    data = await body_json(request)
    reason = data.get("reason", "closed")
    if reason not in ("closed", "recording error"):
        return error(422, "bad_request", "The reason must be closed or recording error.")
    capture = find_capture(entry.board.project, capture_id, ("shell",))
    if capture is None:
        return error(404, "not_found", f"There is no shell capture {capture_id!r}.")
    file = resolve_file(entry.board.files, capture["path"])
    if file:
        with file.open() as stream:
            size, seen = scan_stream(stream)
    else:
        size, seen = 0, []
    patch = capture_stopped_patch(reason, size=size, kind="shell", seen=seen)
    stored = await submit(entry, {"type": "capture/stopped", "id": capture_id, "patch": patch}, "cli", internal=True)
    return {"event": stored}


@router.websocket("/api/boards/{slug}/terminal")
async def terminal_socket(websocket: WebSocket, slug: str, state: State):
    """A shell in the board folder for the Terminal panel, captured like pcbv shell.
    First message {op: auth, token, cols, rows}; then {op: input, data} and {op: resize, cols, rows}."""
    authenticated = await ws_authenticate(websocket, slug, state)
    if authenticated is None:
        return
    hello, entry = authenticated

    outbox = OutputQueue(asyncio.get_running_loop())

    def size(value, default):
        return value if isinstance(value, int) and not isinstance(value, bool) else default

    if not entry.board.writable:
        await websocket.send_json({"op": "error", "code": "recovery_required", "error": "recovery_required",
                                   "message": "Reopen the board before starting a shell", "storage": entry.board.storage})
        await websocket.close(code=1011)
        return

    session = await state.construct_session(lambda: TerminalSession(
        board_dir=entry.board.files, slug=slug, cols=size(hello.get("cols"), 80), rows=size(hello.get("rows"), 24),
        on_output=outbox.put, on_exit=outbox.close), lambda session: session.terminate())
    state.terminals.add(session)
    capture = {"id": session.id, "kind": "shell", "path": session.rel_path, "label": "Terminal panel", "started": now_iso()}
    try:
        await submit(entry, {"type": "capture/started", "capture": capture}, "web", internal=True)
    except StorageError as exc:
        await asyncio.to_thread(session.terminate)
        state.terminals.discard(session)
        await websocket.send_json({"op": "error", "error": exc.code, "code": exc.code, "message": str(exc)})
        await websocket.close(code=1011)
        return
    except BaseException:
        await asyncio.to_thread(session.terminate)
        state.terminals.discard(session)
        raise
    async def record_stop() -> None:
        await asyncio.to_thread(session.terminate)
        state.terminals.discard(session)
        try:
            with session.file_path.open() as stream:
                _, seen = scan_stream(stream)
        except OSError as exc:
            seen = []
            session.recording_error = session.recording_error or f"capture read error: {exc}"
        patch = capture_stopped_patch(session.recording_error or "closed", size=session.bytes, kind="shell", seen=seen)
        await submit(entry, {"type": "capture/stopped", "id": session.id, "patch": patch}, "web", internal=True)

    stopping: list[asyncio.Task] = []

    async def finish() -> None:
        # One shared task, shielded: a disconnect that cancels the sender mid-way must not lose the stop.
        if not stopping:
            stopping.append(asyncio.create_task(record_stop()))
        await asyncio.shield(stopping[0])

    try:
        await websocket.send_json({"op": "started", "capture": capture})
    except BaseException:
        await finish()
        raise

    async def sender():
        while True:
            kind, value = await outbox.get()
            if kind == "output":
                if value:
                    await websocket.send_json({"op": "output", "data": value})
            else:
                try:
                    await finish()
                except StorageError as exc:
                    await websocket.send_json({"op": "error", "error": exc.code, "message": str(exc)})
                    await websocket.close(code=1011)
                    return
                if session.recording_error:
                    await websocket.send_json({"op": "error", "error": "recording_error", "message": session.recording_error})
                    await websocket.close(code=1011)
                    return
                await websocket.send_json({"op": "exit", "code": value})
                await websocket.close(code=1000)
                return

    send_task = asyncio.create_task(sender())
    try:
        while not send_task.done():
            receive = asyncio.create_task(websocket.receive_json())
            done, _ = await asyncio.wait({receive, send_task}, return_when=asyncio.FIRST_COMPLETED)
            if receive not in done:
                receive.cancel()
                break
            message = receive.result()
            op = message.get("op") if isinstance(message, dict) else None
            if op == "input" and isinstance(message.get("data"), str):
                session.write(message["data"])
            elif op == "resize":
                session.resize(size(message.get("cols"), 80), size(message.get("rows"), 24))
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        send_task.cancel()
        try:
            await finish()
        except StorageError:
            pass
