"""The tutorial's practice board: create it, or build it again from scratch."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter

from .. import tutorial
from ..boards import TUTORIAL_SLUG
from .errors import error
from .state import State

router = APIRouter()
BUSY = "Close the Console or Terminal session on the practice board first."


def session_open(state) -> bool:
    return state.serials.for_board(TUTORIAL_SLUG) is not None or any(
        getattr(term, "slug", None) == TUTORIAL_SLUG for term in state.terminals)


@router.post("/api/tutorial/board", status_code=201)
async def tutorial_board(state: State):
    """Create the practice board if it is missing. Answers with its slug either way."""
    async with state.tutorial_lock:
        await asyncio.to_thread(tutorial.create_tutorial)
    return {"slug": TUTORIAL_SLUG}


@router.post("/api/tutorial/board/reset", status_code=201)
async def tutorial_reset(state: State):
    """Delete the practice board and build it again. Refused while a serial or terminal session is open on it."""
    async with state.tutorial_lock:
        if session_open(state):
            return error(409, "session_open", BUSY)
        entry = state.registry.entries.get(TUTORIAL_SLUG)
        if entry:
            for client in list(entry.clients):
                client.close_after(4400, "The practice board was rebuilt.", drop=True)
            entry.clients.clear()
        state.registry.forget(TUTORIAL_SLUG)
        await asyncio.to_thread(tutorial.reset_tutorial)
    return {"slug": TUTORIAL_SLUG}
