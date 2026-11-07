"""Board files: photo upload, serving assets and captures, and export to a folder outside the board."""
from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from ..events import EventConflict, EventError, validate_asset_path
from ..export import FORMATS as EXPORT_FORMATS, ExportError, default_folder, export_board, export_root
from ..journal import StorageError
from ..geometry import turn_events
from ..photos import discard, ingest, resolve_file, rotate
from ..reveal import reveal
from .body import body_json, body_limit, read_body
from .errors import NotFound, error
from .state import State, submit

router = APIRouter()


@router.post("/api/boards/{slug}/assets", status_code=201)
async def upload_photo(slug: str, request: Request, state: State, label: str = ""):
    """Raw image bytes in the body. Stores the files, then records them with an asset/added event."""
    entry = state.registry.get(slug)
    directory = entry.board.files
    photos = sum(1 for a in entry.board.project.get("assets", []) if a.get("kind", "image") == "image")
    async with read_body(request, body_limit(request.url.path)) as data:
        asset = await asyncio.to_thread(ingest, directory, data, label=label.strip() or f"Photo {photos + 1}")
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


@router.post("/api/boards/{slug}/assets/{asset_id}/rotate")
async def rotate_photo(slug: str, asset_id: str, request: Request, state: State):
    """Body {"turns": 1} (right) or {"turns": -1} (left). Writes a turned copy, then one board/batch
    that moves the photo's markers, callouts, header grids and component boxes with it."""
    entry = state.registry.get(slug)
    turns = (await body_json(request)).get("turns")
    if isinstance(turns, bool) or not isinstance(turns, int) or turns not in (1, -1):
        raise EventError("turns must be 1 (rotate right) or -1 (rotate left)")
    asset = next((a for a in entry.board.project["assets"] if a.get("id") == asset_id), None)
    if asset is None:
        raise NotFound(f"There is no photo {asset_id}.")
    if not asset.get("width") or not asset.get("height"):
        raise EventConflict("This photo has no recorded size, so it cannot be rotated.")
    turn_events(entry.board.project, asset_id, turns, asset["path"])     # refuses a photo with too many marks first
    directory = entry.board.files
    path = await asyncio.to_thread(rotate, directory, asset, turns)
    seen = {key: asset.get(key) for key in ("path", "width", "height", "rotation")}

    def build(project):
        current = next((a for a in project["assets"] if a.get("id") == asset_id), None)
        if current is None or {key: current.get(key) for key in seen} != seen:
            raise EventConflict("The photo changed while it was rotated. Try again.")
        return {"type": "board/batch", "events": turn_events(project, asset_id, turns, path)}
    try:
        stored = await submit(entry, build, "http")
    except BaseException as exc:
        # Only commit_unknown may have recorded the new copy; every other failure left it unused.
        if not (isinstance(exc, StorageError) and exc.code == "commit_unknown"):
            discard(directory, {"path": path})
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


@router.post("/api/exports/reveal")
async def reveal_export(request: Request, state: State):
    """Open an export folder in the file manager. Only a folder directly under the export root is opened."""
    data = await body_json(request)
    folder = data.get("folder")
    if not isinstance(folder, str) or not folder or "\0" in folder:
        return error(400, "bad_path", "The folder must be text.")
    root = export_root().expanduser().resolve()
    target = Path(folder).resolve()
    if target.parent != root or not target.is_dir():
        return error(400, "bad_path", "The app opens only an export folder.")
    return {"opened": await asyncio.to_thread(reveal, target)}


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
