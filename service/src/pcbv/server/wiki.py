"""Wiki pages and figures, and playbooks: read from disk on every call."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import FileResponse

from ..playbooks import load_all as load_playbooks
from ..wiki import get_figure, get_page, list_pages
from .errors import error
from .state import State

router = APIRouter()


@router.get("/api/playbooks")
async def playbooks(state: State):
    """Read from disk on every call, so an edited playbook shows up on the next app load."""
    found, problems = await asyncio.to_thread(load_playbooks, state.playbooks_dir)
    return {"playbooks": found, "problems": problems}


@router.get("/api/wiki")
async def wiki_index(state: State):
    return {"pages": await asyncio.to_thread(list_pages, state.wiki_dir)}


@router.get("/api/wiki/figures/{file}")
async def wiki_figure(file: str, state: State):
    found = await asyncio.to_thread(get_figure, file, state.wiki_dir)
    if found is None:
        return error(404, "not_found", f"There is no wiki figure called {file!r}.")
    path, media_type = found
    # An SVG opened on its own must not run script or load anything.
    return FileResponse(path, media_type=media_type, headers={
        "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})


@router.get("/api/wiki/{name}")
async def wiki_page(name: str, state: State):
    page = await asyncio.to_thread(get_page, name, state.wiki_dir)
    if page is None:
        return error(404, "not_found", f"There is no wiki page called {name!r}. Create {state.wiki_dir}/{name}.md to add it.")
    return page
