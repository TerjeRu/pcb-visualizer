"""Board files: photo upload, serving assets and captures, and export to a folder outside the board."""
from __future__ import annotations

import asyncio
import mimetypes

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from ..events import EventConflict, EventError, validate_asset_path
from ..export import FORMATS as EXPORT_FORMATS, ExportError, default_folder, export_board
from ..journal import StorageError
from ..photos import discard, ingest, resolve_file
from .body import body_json, body_limit, read_body
from .errors import error
from .state import State, submit

router = APIRouter()


@router.post("/api/boards/{slug}/assets", status_code=201)
async def upload_photo(slug: str, request: Request, state: State, label: str = "", side: str = "front"):
    """Raw image bytes in the body. Stores the files, then records them with an asset/added event."""
    entry = state.registry.get(slug)
    directory = entry.board.files
    async with read_body(request, body_limit(request.url.path)) as data:
        asset = await asyncio.to_thread(ingest, directory, data, label=label, side=side)
    try:
        stored = await submit(entry, {"type": "asset/added", "asset": asset}, "http")
    except StorageError as exc:
        if exc.code == "not_committed":
            discard(directory, asset)
        raise
    except (EventError, EventConflict):
        discard(directory, asset)
        raise
    return {"event": stored}


@router.post("/api/boards/{slug}/export")
async def export(slug: str, request: Request, state: State):
    """Write the chosen formats to a new folder under ~/pcbv-exports (or $PCBV_EXPORT_DIR)."""
    entry = state.registry.get(slug)
    data = await body_json(request)
    formats = data.get("formats", list(EXPORT_FORMATS))
    redact = data.get("redact", True)
    if not isinstance(formats, list) or not all(isinstance(f, str) for f in formats) or not isinstance(redact, bool):
        raise ExportError("The formats must be a list of names. The redact value must be true or false.")
    result = await asyncio.to_thread(export_board, entry.board.directory, default_folder(slug), formats,
                                     redact=redact, project=entry.board.project, files=entry.board.files,
                                     playbooks_dir=state.playbooks_dir)
    return {"folder": str(result.folder), "files": result.files, "redacted": result.redacted,
            "counts": result.counts, "photosToCheck": result.photos_to_check}


@router.get("/api/boards/{slug}/files/{path:path}")
async def board_file(slug: str, path: str, state: State):
    """Asset files, behind the token like everything else. The app fetches them into blob URLs."""
    entry = state.registry.get(slug)
    parts = path.split("/")
    allowed = parts[0] == "captures" and len(parts) >= 2 and not any(p in ("", ".", "..") for p in parts) and "\\" not in path
    if not allowed:
        try:
            validate_asset_path(path)
        except EventError:
            return error(400, "bad_path", "The app serves files from assets/ and captures/ only.")
    file = resolve_file(entry.board.files, path)
    if file is None:
        return error(404, "not_found", f"There is no file at {path}.")
    handle = file.open()
    def chunks():
        try:
            while chunk := handle.read(65_536):
                yield chunk
        finally:
            handle.close()
    media_type = "text/plain; charset=utf-8" if parts[0] == "captures" else mimetypes.guess_type(path)[0]
    cache = "no-store" if parts[0] == "captures" else "private, max-age=3600"
    return StreamingResponse(chunks(), media_type=media_type,
                             headers={"Cache-Control": cache, "X-Content-Type-Options": "nosniff"},
                             background=BackgroundTask(handle.close))
