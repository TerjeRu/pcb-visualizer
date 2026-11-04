"""Git setup for the data folder: its status and the five setup steps."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from .. import gitsetup
from .. import settings as appsettings
from .body import body_json
from .errors import error
from .state import State

router = APIRouter()


def _folders(state: State):
    boards = state.registry.root
    return boards.parent, boards


@router.get("/api/git")
async def git_status(state: State):
    """{ok, detail}: `ok` when every local check passes; `detail` lists tools, repository, guard, ignored
    originals, the remote (credentials hidden), the last commit time and `problems`."""
    folder, boards = _folders(state)
    setting = (await asyncio.to_thread(appsettings.load, boards))["git"]
    return await asyncio.to_thread(gitsetup.status, folder, boards, setting)


@router.post("/api/git/setup")
async def git_setup(request: Request, state: State):
    """{step: check|init|ignore|remote|sync, url?, replace?}. Returns {ok, detail}; a step that cannot
    finish says why with ok false. One step runs at a time; a second request meanwhile gets 409 `git_busy`."""
    data = await body_json(request)
    folder, boards = _folders(state)

    def work():
        if not gitsetup.busy.acquire(blocking=False):
            return None
        try:
            return gitsetup.run_step(folder, boards, data.get("step"), data)
        finally:
            gitsetup.busy.release()

    try:
        result = await asyncio.to_thread(work)
    except gitsetup.SetupError as exc:
        return error(422, "invalid_git_setup", str(exc))
    if result is None:
        return error(409, "git_busy", "Another git setup step is running. Wait for it to finish.")
    return result
