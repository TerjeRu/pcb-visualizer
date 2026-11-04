"""The checks every request passes before a route sees it.

Security model (single user, local machine):
  * Host header must be a loopback name (blocks DNS rebinding)
  * Origin, when present, must be a loopback web origin or the Tauri shell (blocks other sites)
  * every call except /api/health needs the per-session token
  * board names are slugs confined to the boards root (see boards.py)
"""
from __future__ import annotations

import json
import re
import threading

from fastapi import Request
from fastapi.responses import JSONResponse

from ..board import BoardLocked, BoardNotFound
from ..boards import InvalidSlug
from ..journal import JournalError
from ..net import is_loopback
from ..schema import PROTOCOL_VERSION
from .body import body_limit
from .errors import error

ORIGIN_RE = re.compile(
    r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|tauri://localhost|https?://tauri\.localhost)$"
)
STATIC_HEADERS = {
    # Browsers reject IPv6 literals in CSP sources; 'self' already covers ws:// to the page's own host.
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; "
                               "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                               "frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def host_ok(headers) -> bool:
    host = headers.get("host", "")
    name = (host.rsplit(":", 1)[0] if not host.endswith("]") and ":" in host else host).lower()
    if name.startswith("[") and name.endswith("]"):   # brackets belong around IPv6, and IPv6 needs them
        return ":" in name and is_loopback(name[1:-1])
    return ":" not in name and is_loopback(name)


def origin_ok(headers) -> bool:
    origin = headers.get("origin")
    return origin is None or bool(ORIGIN_RE.match(origin))


class ExposeReceive:
    """Keeps the server's own `receive` in the scope. The `guard` middleware below is a BaseHTTPMiddleware,
    which hides a hang-up from `request.is_disconnected()`; after the body has been read, the raw
    `receive` delivers nothing else, so waiting on it is a reliable way to notice that the client left."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope["pcbv.receive"] = receive
        await self.app(scope, receive, send)


async def watch_disconnect(receive, cancel: threading.Event) -> None:
    """Set `cancel` once the client has gone, so a question nobody waits for makes no more model calls.
    Call it after the request body has been read."""
    while (await receive())["type"] != "http.disconnect":
        pass
    cancel.set()


async def guard(request: Request, call_next):
    state = request.app.state.pcbv
    if not host_ok(request.headers):
        return error(403, "bad_host", "The Host header is not a loopback name.")
    if not origin_ok(request.headers):
        return error(403, "bad_origin", "The Origin header is not allowed.")
    if request.method == "OPTIONS" or request.url.path == "/api/health":
        return await call_next(request)
    if not request.url.path.startswith("/api/"):
        # The front end is just code and carries no secrets, so it needs no token. It is read-only.
        if request.method not in ("GET", "HEAD"):
            return error(405, "method_not_allowed", "Static files are read-only.")
        response = await call_next(request)
        for name, value in STATIC_HEADERS.items():
            response.headers[name] = value
        return response
    auth = request.headers.get("authorization", "")
    redeeming = request.method == "POST" and request.url.path == "/api/session"   # the one call that has no token yet
    if not redeeming and not (auth.startswith("Bearer ") and state.token_ok(auth[7:])):
        return error(401, "unauthorized", "The session token is missing or wrong.")
    limit = body_limit(request.url.path)
    length = request.headers.get("content-length") or "0"
    if not length.isdigit():
        return error(400, "bad_request", "The Content-Length header is not a number.")
    if int(length) > limit:
        return error(413, "too_large", f"The request body is over {limit} bytes.")
    mutation = request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/boards")
    if mutation and request.headers.get("x-pcbv-protocol") != str(PROTOCOL_VERSION):
        return error(409, "protocol_incompatible", "The client and service protocols do not match. Reload the app.")
    parts = request.url.path.split("/")
    entry = state.registry.entries.get(parts[3]) if len(parts) > 3 else None
    if mutation and entry is not None and not entry.board.writable:
        return error(503, "recovery_required", "Reopen the board before you make another change.")
    try:
        response = await call_next(request)
        if mutation and 200 <= response.status_code < 300:
            body = b"".join([chunk async for chunk in response.body_iterator])
            result = json.loads(body)
            parts = request.url.path.split("/")
            slug = parts[3] if len(parts) > 3 else result.get("slug")
            entry = state.registry.entries.get(slug)
            result["warnings"] = entry.board.warnings if entry else []
            if entry and entry.board.warning_details:
                result["warningDetails"] = entry.board.warning_details
            headers = dict(response.headers)
            headers.pop("content-length", None)
            return JSONResponse(result, status_code=response.status_code, headers=headers)
        return response
    except InvalidSlug as exc:
        return error(400, "bad_name", str(exc))
    except BoardNotFound as exc:
        return error(404, "not_found", str(exc))
    except BoardLocked as exc:
        return error(423, "locked", str(exc))
    except FileExistsError as exc:
        return error(409, "exists", str(exc))
    except JournalError as exc:
        return error(503, "recovery_required", str(exc))
