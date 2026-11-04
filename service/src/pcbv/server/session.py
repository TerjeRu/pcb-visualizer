"""Health, and the one-time codes that let another window of the app get the session token."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..schema import PROTOCOL_VERSION
from ..sessioncodes import CODE_TTL_S, CodesFull
from .body import body_json
from .state import State

router = APIRouter()
no_store = {"Cache-Control": "no-store"}


@router.get("/api/health")
async def health():
    return {"ok": True, "version": __version__, "protocol": PROTOCOL_VERSION}


@router.post("/api/session/code")
async def session_code(state: State):
    """A one-time code for opening another window. Needs the token like every other call."""
    try:
        code = state.codes.mint()
    except CodesFull as exc:
        return JSONResponse({"error": "session_busy", "message": str(exc)}, status_code=429, headers=no_store)
    return JSONResponse({"code": code, "expiresIn": CODE_TTL_S}, headers=no_store)


@router.post("/api/session")
async def session_redeem(request: Request, state: State):
    """{code}: exchanges a live code, once, for the token. The only call that needs no token."""
    data = await body_json(request)
    if set(data) != {"code"} or not state.codes.redeem(data["code"]):
        return JSONResponse({"error": "invalid_code", "message": "the code is wrong, expired or already used"},
                            status_code=401, headers=no_store)
    return JSONResponse({"token": state.token}, headers=no_store)
