"""Serial consoles: open, close, detect the speed and send lines, with every session recorded as a capture."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from .. import distro
from ..captures import capture_stopped_patch
from ..events import EventError
from ..journal import StorageError
from ..schema import now_iso
from ..serialmgr import (BAUD_RATES, MAX_LINE, PortNotAllowed, destructive_reason, forbidden_command_character,
                         list_ports, probe_bauds)
from .body import body_json
from .errors import error
from .state import AppState, Entry, State, broadcast, submit

router = APIRouter()
KEYS = {"enter": b"\r", "ctrl-c": b"\x03", "space": b" ", "ctrl-d": b"\x04"}


def serial_state(state: AppState, slug: str) -> dict | None:
    session = state.serials.for_board(slug)
    if not session:
        return None
    described = session.describe()
    if session._stop.is_set():
        described["recordingError"] = f"{getattr(session, 'end_reason', 'Console stopped')}; retry disconnect or reopen the board."
    return described


async def end_session(state: AppState, entry: Entry, session, reason: str) -> None:
    session.end_reason = reason
    try:
        await submit(entry, {"type": "capture/stopped", "id": session.id,
                             "patch": capture_stopped_patch(reason, size=session.bytes, seen=sorted(session.detector.seen))},
                     "service", internal=True)
    except StorageError:
        described = {**session.describe(), "recordingError": f"{reason}; capture stop could not be saved. Retry disconnect or reopen the board."}
        broadcast(entry, {"op": "serial", "state": described, "reason": described["recordingError"]})
        raise
    state.serials.forget(session)
    broadcast(entry, {"op": "serial", "state": None, "reason": reason})


def validate_serial_session(state: AppState, slug: str, data: dict):
    identity = data.get("sessionId")
    try:
        valid = isinstance(identity, str) and 1 <= len(identity.encode("utf-8")) <= 128
    except UnicodeEncodeError:
        valid = False
    if not valid:
        return None, error(422, "bad_request", "The sessionId must be 1 to 128 UTF-8 bytes.")
    if not state.registry.get(slug).board.writable:
        return None, error(409, "recovery_required", "Reopen the board before you send text to the Console.")
    session = state.serials.for_board(slug)
    if session is None or session.id != identity or session._stop.is_set():
        return None, error(409, "session_stale", "The console session changed or closed. Reconnect, then confirm again.")
    return session, None


@router.get("/api/serial/ports")
async def serial_ports(state: State):
    ports = await asyncio.to_thread(list_ports)
    return {"ports": ports, "bauds": list(BAUD_RATES), "sessions": [s.describe() for s in state.serials.all_sessions()]}


@router.post("/api/boards/{slug}/serial", status_code=201)
async def serial_open(slug: str, request: Request, state: State):
    serials = state.serials
    async with state.serial_lock(slug):
        entry = state.registry.get(slug)
        data = await body_json(request)
        baud = data.get("baud")
        if baud not in BAUD_RATES:
            raise EventError(f"The speed must be one of: {', '.join(map(str, BAUD_RATES))}.")
        if serials.for_board(slug):
            raise FileExistsError("This board already has a console open. Close it first.")
        for capture in entry.board.project.get("captures", []):
            if capture.get("kind") == "serial" and not capture.get("stopped"):
                await submit(entry, {"type": "capture/stopped", "id": capture["id"],
                                     "patch": capture_stopped_patch("interrupted")},
                             "service", internal=True)
        try:
            port = await asyncio.to_thread(serials.resolve, data.get("port"))
        except PortNotAllowed as exc:
            return error(400, "bad_port", str(exc))
        loop = asyncio.get_running_loop()
        holder = {}
        outbox: asyncio.Queue = asyncio.Queue()

        async def send_output() -> None:
            while True:
                text = await outbox.get()
                try:
                    if text is None:
                        return
                    broadcast(entry, {"op": "serial-data", "captureId": holder["s"].id, "text": text})
                finally:
                    outbox.task_done()

        def on_text(text: str) -> None:          # reader thread
            if text:
                loop.call_soon_threadsafe(outbox.put_nowait, text)

        async def record_seen(kinds: list[str]) -> None:
            async with state.serial_lock(slug):
                if serials.for_board(slug) is holder["s"] and not holder["s"]._stop.is_set():
                    await submit(entry, {"type": "capture/updated", "id": holder["s"].id, "patch": {"seen": kinds}},
                                 "service", internal=True)

        def on_seen(kinds: list[str]) -> None:   # reader thread, something recognisable appeared
            loop.call_soon_threadsafe(lambda: state.track(record_seen(kinds)))

        async def finish_failed(reason: str) -> None:
            try:
                await outbox.join()
                async with state.serial_lock(slug):
                    if serials.for_board(slug) is holder["s"]:
                        await end_session(state, entry, holder["s"], reason)
            except StorageError:
                pass
            finally:
                if not holder["s"].output_closed:
                    holder["s"].output_closed = True
                    outbox.put_nowait(None)

        def on_end(reason: str) -> None:         # reader thread, port unplugged or failed
            loop.call_soon_threadsafe(lambda: state.track(finish_failed(reason)))

        try:
            def discard_open(session):
                serials.forget(session)
                session.close()

            session = await state.construct_session(lambda: serials.open(
                board_dir=entry.board.files, slug=slug, port=port, baud=baud, on_text=on_text, on_end=on_end,
                on_seen=on_seen), discard_open)
        except OSError as exc:
            hint = ""
            if "ermission" in str(exc):
                group = distro.group_of(port["path"]) or distro.serial_group()
                hint = f" Add yourself to the {group} group with: sudo usermod -aG {group} $USER. Then log in again."
            return error(409, "port_busy", f"The service could not open {port['label']}: {str(exc).rstrip('.')}.{hint}")
        holder["s"] = session
        capture = {"id": session.id, "kind": "serial", "path": session.rel_path, "port": port["path"],
                   "label": port["label"], "byPath": port["byPath"], "baud": baud, "started": now_iso()}
        try:
            await submit(entry, {"type": "capture/started", "capture": capture}, "service", internal=True)
        except BaseException:
            serials.forget(session)
            session.close()
            raise
        session.outbox = outbox
        session.output_closed = False
        state.track(send_output())
        try:
            broadcast(entry, {"op": "serial", "state": session.describe(), "backlog": ""})
            session.start()
        except BaseException:
            outbox.put_nowait(None)
            session.close()
            await end_session(state, entry, session, "startup failed")
            raise
        return {"state": session.describe()}


@router.post("/api/boards/{slug}/serial/close")
async def serial_close(slug: str, state: State):
    async with state.serial_lock(slug):
        entry = state.registry.get(slug)
        session = state.serials.for_board(slug)
        if session is None:
            return error(404, "not_found", "No console is open for this board.")
        await asyncio.to_thread(session.close)
        if not session.output_closed:
            await session.outbox.join()
            session.output_closed = True
            session.outbox.put_nowait(None)
        await end_session(state, entry, session, getattr(session, "end_reason", "closed"))
        return {"state": None}


@router.post("/api/boards/{slug}/serial/detect")
async def serial_detect(slug: str, request: Request, state: State):
    """Try the common speeds on a port and rank them by how readable the output is."""
    state.registry.get(slug)
    data = await body_json(request)
    try:
        port = await asyncio.to_thread(state.serials.resolve, data.get("port"))
    except PortNotAllowed as exc:
        return error(400, "bad_port", str(exc))
    if port["path"] in state.serials.sessions:
        raise FileExistsError(f"{port['label']} is open. Disconnect before you detect the speed.")
    seconds = data.get("seconds", 1.5)
    seconds = min(max(float(seconds), 0.5), 3.0) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) else 1.5
    results = await asyncio.to_thread(probe_bauds, port["path"], seconds=seconds)
    best = results[0] if results and results[0]["score"] >= 0.85 else None
    return {"results": results, "best": best["baud"] if best else None}


@router.post("/api/boards/{slug}/serial/write")
async def serial_write(slug: str, request: Request, state: State):
    """{line, confirm?} sends a line plus Enter; {key} sends one special key. Lines that can
    change the device are refused until they are sent again with confirm: true."""
    async with state.serial_lock(slug):
        state.registry.get(slug)
        data = await body_json(request)
        session, failure = validate_serial_session(state, slug, data)
        if failure:
            return failure
        if "key" in data:
            key = KEYS.get(data["key"])
            if key is None:
                raise EventError(f"The key must be one of: {', '.join(KEYS)}.")
            try:
                await asyncio.to_thread(session.write_raw, key)
            except OSError:
                if session._stop.is_set():
                    return error(409, "session_stale", "The console session has closed")
                raise
            return {"sent": data["key"]}
        line = data.get("line")
        if not isinstance(line, str) or len(line) > MAX_LINE or "\n" in line or "\r" in line:
            raise EventError(f"The line must be one line of at most {MAX_LINE} characters.")
        if problem := forbidden_command_character(line):
            return error(422, "bad_request", problem)
        reason = destructive_reason(line)
        if reason and data.get("confirm") is not True:
            return error(409, "confirm_required", f"This command {reason}. It can make the board unusable. "
                                                  "Make a verified backup, then confirm.")
        try:
            await asyncio.to_thread(session.write_line, line)
        except OSError:
            if session._stop.is_set():
                return error(409, "session_stale", "The console session has closed")
            raise
        return {"sent": line, "destructive": bool(reason)}
