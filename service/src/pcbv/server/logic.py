"""Logic captures: import, the waveform view, UART decoding and comparing a decode with a console capture."""
from __future__ import annotations

import asyncio
import secrets

from fastapi import APIRouter, Request

from ..captures import find_capture, new_capture_id
from ..events import EventError
from ..fsutil import Directory
from .. import logic as logicmod
from ..photos import resolve_file
from ..schema import now_iso
from ..serialmgr import scan_text
from .body import body_json, body_limit, read_body
from .errors import NotFound, error
from .state import AppState, Entry, State, submit

router = APIRouter()


def logic_record(entry: Entry, capture_id: str) -> dict:
    record = find_capture(entry.board.project, capture_id, ("logic",))
    if record is None:
        raise NotFound(f"There is no logic capture {capture_id!r}.")
    return record


async def logic_capture(state: AppState, entry: Entry, slug: str, capture_id: str) -> tuple[dict, logicmod.Capture]:
    """The parsed samples, from the cache or read from the board. Only the event loop touches the
    cache; the file read and parse run in a thread, once per capture however many requests wait."""
    record = logic_record(entry, capture_id)
    key = (slug, capture_id)
    cap = state.logic_cache.get(key)
    if cap is None:
        task = state.logic_loading.get(key)
        if task is None:
            file = resolve_file(entry.board.files, record["path"])
            if file is None:
                raise NotFound(f"The file for {capture_id!r} is missing.")

            async def load() -> logicmod.Capture:
                with state.jobs.hold():
                    loaded = await asyncio.to_thread(lambda: logicmod.read_sr(file.read_bytes()))
                state.logic_cache.put(key, loaded)
                return loaded

            task = state.logic_loading[key] = asyncio.create_task(load())
            task.add_done_callback(lambda done: (state.logic_loading.pop(key, None), done.cancelled() or done.exception()))
        cap = await asyncio.shield(task)
    return record, cap


def decode_and_store(entry: Entry, record: dict, cap: logicmod.Capture, channel: int, baud: int) -> dict:
    result = logicmod.decode_uart(cap, channel, baud)
    text = result["bytes"].decode("utf-8", errors="replace")
    rel = record["path"].rsplit(".", 1)[0] + f".D{channel}.{secrets.token_hex(16)}.txt"
    with Directory(entry.board.files) as directory:
        directory.create_bytes(rel, text.encode())
    return {"channel": channel, "name": cap.channels[channel], "baud": baud, "bytes": len(result["bytes"]),
            "errors": result["errors"], "text": rel, "seen": scan_text(text)}


def store_capture(entry: Entry, rel: str, raw: bytes) -> None:
    with Directory(entry.board.files) as directory:
        directory.create_bytes(rel, raw)


@router.post("/api/boards/{slug}/logic", status_code=201)
async def logic_import(slug: str, request: Request, state: State, name: str = "capture.sr", samplerate: str = ""):
    """Raw .sr or CSV in the body. Stores it as .sr, records it, and decodes channels that carry UART."""
    entry = state.registry.get(slug)
    with state.jobs.hold():                      # refuse before reading a body this big
        async with read_body(request, body_limit(request.url.path)) as data:
            rate = logicmod.parse_rate(samplerate) if samplerate else None
            cap = await asyncio.to_thread(logicmod.read_capture, data, name, rate)
            capture_id, rel = new_capture_id("captures/logic", "sr")
            raw = data if data[:2] == b"PK" else await asyncio.to_thread(logicmod.write_sr, cap)
            await asyncio.to_thread(store_capture, entry, rel, raw)
            stored_bytes = len(raw)
            del data, raw                        # the budget is released below; the buffer must go with it
        now = now_iso()
        record = {"id": capture_id, "kind": "logic", "path": rel, "label": str(name)[:80], "samplerate": cap.samplerate,
                  "channels": cap.channels, "samples": len(cap.samples), "duration": round(cap.duration, 4),
                  "started": now, "stopped": now, "bytes": stored_bytes}
        await submit(entry, {"type": "capture/started", "capture": record}, "web", internal=True)
        state.logic_cache.put((slug, capture_id), cap)
        decoded = []
        for channel in range(len(cap.channels)):
            baud = await asyncio.to_thread(logicmod.estimate_baud, cap, channel)
            if not baud:
                continue
            try:
                result = await asyncio.to_thread(decode_and_store, entry, record, cap, channel, baud)
            except logicmod.LogicError:         # a guessed speed the sample rate cannot resolve: not a UART
                continue
            if result["bytes"] and result["errors"] * 10 <= result["bytes"]:
                decoded.append(result)
        if decoded:
            await submit(entry, {"type": "capture/updated", "id": capture_id, "patch": {"decoded": decoded}},
                         "service", internal=True)
        return {"capture": {**record, "decoded": decoded}}


@router.get("/api/boards/{slug}/logic/{capture_id}/edges")
async def logic_edges(slug: str, capture_id: str, state: State, start: int = 0, end: int = -1, bins: int = 0):
    """Edges in the window, or, when there are too many and `bins` is given, a per-column summary."""
    entry = state.registry.get(slug)
    _, cap = await logic_capture(state, entry, slug, capture_id)
    stop = len(cap.samples) if end < 0 else end
    view = await asyncio.to_thread(logicmod.edges, cap, start, stop)
    if view["truncated"] and bins > 0:
        return await asyncio.to_thread(logicmod.activity, cap, start, stop, bins)
    return view


@router.post("/api/boards/{slug}/logic/{capture_id}/decode")
async def logic_decode(slug: str, capture_id: str, request: Request, state: State):
    """{channel, baud} (baud 0 or missing: estimate it). Replaces the decode for that channel."""
    entry = state.registry.get(slug)
    data = await body_json(request)
    record, cap = await logic_capture(state, entry, slug, capture_id)
    channel, baud = data.get("channel", 0), data.get("baud") or 0
    if not isinstance(channel, int) or isinstance(channel, bool) or not 0 <= channel < len(cap.channels):
        raise EventError(f"The channel must be a number from 0 to {len(cap.channels) - 1}.")
    if not isinstance(baud, int) or isinstance(baud, bool) or baud < 0:
        raise EventError("The speed must be a positive whole number in baud, or 0 to estimate it.")
    with state.jobs.hold():
        baud = baud or await asyncio.to_thread(logicmod.estimate_baud, cap, channel)
        if not baud:
            return error(422, "no_baud", "The service cannot find the speed from this channel. Choose a speed.")
        result = await asyncio.to_thread(decode_and_store, entry, record, cap, channel, baud)
    decoded = [d for d in record.get("decoded", []) if d.get("channel") != channel] + [result]
    await submit(entry, {"type": "capture/updated", "id": capture_id, "patch": {"decoded": decoded}},
                 "web", internal=True)
    preview = resolve_file(entry.board.files, result["text"]).read_text(encoding="utf-8")[:4000]
    return {"decoded": result, "preview": preview}


@router.post("/api/boards/{slug}/logic/{capture_id}/compare")
async def logic_compare(slug: str, capture_id: str, request: Request, state: State):
    """{channel, with}: compare a decoded channel with a serial or shell capture of the same boot."""
    entry = state.registry.get(slug)
    data = await body_json(request)
    record = logic_record(entry, capture_id)
    decoded = next((d for d in record.get("decoded", []) if d.get("channel") == data.get("channel")), None)
    other = find_capture(entry.board.project, data.get("with"), ("serial", "shell"))
    if decoded is None or other is None:
        return error(404, "not_found", "Decode the channel first. Then choose a console capture or a shell capture.")
    mine = resolve_file(entry.board.files, decoded["text"])
    theirs = resolve_file(entry.board.files, other["path"])
    if mine is None or theirs is None:
        return error(404, "not_found", "A capture file is missing.")
    result = await asyncio.to_thread(logicmod.compare_text, mine.read_text(errors="replace"),
                                     theirs.read_bytes().decode("utf-8", errors="replace"))
    comparison = {"channel": decoded["channel"], "with": other["id"], **result}
    await submit(entry, {"type": "capture/updated", "id": capture_id, "patch": {"compare": comparison}},
                 "web", internal=True)
    return {"compare": comparison}
