"""App settings and workspace layouts, stored per machine."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from .. import benchcheck, gitsetup
from .. import settings as appsettings
from .. import workspaces
from .body import body_json
from .errors import error
from .state import State, broadcast

router = APIRouter()


@router.get("/api/workspaces")
async def workspaces_get():
    return await asyncio.to_thread(workspaces.load)


@router.post("/api/workspaces")
async def workspaces_put(request: Request):
    data = await body_json(request)
    try:
        return await asyncio.to_thread(workspaces.save, data)
    except workspaces.WorkspaceError as exc:
        return error(422, "invalid_workspaces", str(exc))


@router.get("/api/settings")
async def settings_get(state: State):
    settings = await asyncio.to_thread(appsettings.load, state.registry.root)
    return {**settings, "data_folder": str(state.registry.root.parent)}


@router.get("/api/bench-check")
async def bench_check():
    return {"checks": await asyncio.to_thread(benchcheck.checks)}


@router.post("/api/settings")
async def settings_put(request: Request, state: State):
    """Saves the settings and sends them to every open board connection, so all windows follow. Turning git
    on is refused with 422 `git_not_ready` until the local checks of `GET /api/git` pass."""
    data = await body_json(request)
    boards = state.registry.root
    if data.get("git") == "on" and (await asyncio.to_thread(appsettings.load, boards))["git"] != "on":
        found = await asyncio.to_thread(gitsetup.problems, boards.parent, boards)
        if found:
            return error(422, "git_not_ready", "Git cannot be turned on yet. " + " ".join(f"{line.rstrip('.')}." for line in found))
    try:
        saved = await asyncio.to_thread(appsettings.save, data, state.registry.root)
    except appsettings.SettingsError as exc:
        return error(422, "invalid_settings", str(exc))
    for entry in list(state.registry.entries.values()):
        broadcast(entry, {"op": "settings", "settings": saved})
    return saved
