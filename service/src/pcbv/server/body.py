"""Request bodies: the size limit for each path, and reading a body within it and the upload budget."""
from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager

from fastapi import Request

from ..events import EventError
from ..limits import BodyTooLarge
from ..photos import MAX_PHOTO_BYTES

MAX_BODY_BYTES = 2_000_000
MAX_SESSION_BODY_BYTES = 1024
MAX_GIT_BODY_BYTES = 4096
MAX_REVEAL_BODY_BYTES = 4096
MAX_ROTATE_BODY_BYTES = 64
MAX_LOGIC_BYTES = 250_000_000
UPLOAD_PATH_RE = re.compile(r"^/api/boards/[^/]+/assets$")
LOGIC_UPLOAD_RE = re.compile(r"^/api/boards/[^/]+/logic$")
ROTATE_PATH_RE = re.compile(r"^/api/boards/[^/]+/assets/[^/]+/rotate$")


def body_limit(path: str) -> int:
    if path == "/api/session":
        return MAX_SESSION_BODY_BYTES
    if path == "/api/git/setup":
        return MAX_GIT_BODY_BYTES
    if path == "/api/exports/reveal":
        return MAX_REVEAL_BODY_BYTES
    if UPLOAD_PATH_RE.match(path):
        return MAX_PHOTO_BYTES
    if ROTATE_PATH_RE.match(path):
        return MAX_ROTATE_BODY_BYTES
    return MAX_LOGIC_BYTES if LOGIC_UPLOAD_RE.match(path) else MAX_BODY_BYTES


@asynccontextmanager
async def read_body(request: Request, limit: int):
    """The whole body, counted as it arrives (Content-Length can be missing or wrong), held against
    the shared upload budget until the caller is done with the buffer."""
    uploads = request.app.state.pcbv.uploads
    declared = request.headers.get("content-length", "")
    reserved = min(int(declared), limit) if declared.isdigit() else 0
    uploads.reserve(reserved)
    try:
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > limit:
                raise BodyTooLarge(f"The request body is over {limit} bytes.")
            if len(data) > reserved:
                uploads.reserve(len(data) - reserved)
                reserved = len(data)
        body = bytes(data)
        del data
        yield body
    finally:
        uploads.release(reserved)


async def body_json(request: Request) -> dict:
    async with read_body(request, body_limit(request.url.path)) as raw:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
            raise EventError("The body is not valid JSON.") from None
    if not isinstance(data, dict):
        raise EventError("The body must be a JSON object.")
    return data
