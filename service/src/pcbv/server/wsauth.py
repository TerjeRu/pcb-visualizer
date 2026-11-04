"""The opening step shared by the board and terminal WebSockets."""
from __future__ import annotations

import asyncio

from fastapi import WebSocket, WebSocketDisconnect

from ..board import BoardLocked, BoardNotFound
from ..boards import InvalidSlug
from ..journal import JournalError, StorageError
from ..schema import PROTOCOL_VERSION
from .guard import host_ok, origin_ok
from .state import AppState, Entry

WS_AUTH_TIMEOUT_S = 5


async def ws_authenticate(websocket: WebSocket, slug: str, state: AppState) -> tuple[dict, Entry] | None:
    """Accept, read the first message ({op: auth, token, protocol, ...}) and open the board.
    On any failure the socket is closed with the matching code and the result is None."""
    if not host_ok(websocket.headers) or not origin_ok(websocket.headers):
        await websocket.close(code=1008)
        return None
    await websocket.accept()
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), WS_AUTH_TIMEOUT_S)
    except (TimeoutError, ValueError, WebSocketDisconnect):
        await websocket.close(code=4401)
        return None
    if not isinstance(hello, dict) or hello.get("op") != "auth" or not state.token_ok(hello.get("token")):
        await websocket.close(code=4401)
        return None
    if type(hello.get("protocol")) is not int or hello["protocol"] != PROTOCOL_VERSION:
        await websocket.send_json({"op": "error", "code": "protocol_incompatible", "error": "protocol_incompatible", "message": "The client and service protocols do not match. Reload the app."})
        await websocket.close(code=4409)
        return None
    try:
        return hello, state.registry.get(slug)
    except (InvalidSlug, BoardNotFound):
        await websocket.close(code=4404)
    except BoardLocked:
        await websocket.close(code=1011)
    except (JournalError, StorageError) as exc:
        await websocket.send_json({"op": "error", "code": "recovery_required", "error": "recovery_required", "message": str(exc)})
        await websocket.close(code=1011)
    return None
