"""Local service: HTTP for commands, WebSocket for live state, 127.0.0.1 only.

`create_app` builds the shared state, adds the checks in `guard.py` and includes one router per area.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..assistant import AssistantService
from ..limits import JOB_SLOTS, LOGIC_CACHE_BYTES, LOGIC_CACHE_ENTRIES, UPLOAD_BUDGET, ByteBudget, ByteLru, JobSlots
from . import assistant, boards, files, git, logic, serial, session, settings, terminal, tutorial, vdev, wiki
from .errors import install_handlers
from .guard import ORIGIN_RE, ExposeReceive, guard, watch_disconnect
from .state import AppState, Registry

__all__ = ["ROUTERS", "create_app", "watch_disconnect"]
ROUTERS = tuple(area.router for area in (session, wiki, serial, vdev, terminal, logic, assistant, settings, git, boards, tutorial, files))


def create_app(root: Path, token: str, static_dir: Path | None = None, playbooks_dir: Path | None = None,
               keystore=None) -> FastAPI:
    state = AppState(
        token=token,
        registry=Registry(root),
        assistant=AssistantService(keystore),
        # The data repo's own playbooks sit next to the boards root: ~/hw/playbooks for ~/hw/boards.
        playbooks_dir=Path(playbooks_dir) if playbooks_dir else Path(root).parent / "playbooks",
        wiki_dir=Path(root).parent / "wiki",
        uploads=ByteBudget(UPLOAD_BUDGET),
        jobs=JobSlots(JOB_SLOTS),
        logic_cache=ByteLru(LOGIC_CACHE_BYTES, lambda cap: len(cap.samples), LOGIC_CACHE_ENTRIES),
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await state.close()

    app = FastAPI(title="pcbv", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.pcbv = state
    app.state.registry = state.registry
    app.state.logic_cache = state.logic_cache
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ORIGIN_RE.pattern,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-PCBV-Protocol"],
    )
    app.middleware("http")(guard)
    install_handlers(app)
    for router in ROUTERS:
        app.include_router(router)

    # Mounted last so every /api route above wins. StaticFiles refuses paths that leave the folder and,
    # by default, symlinks that point outside it.
    if static_dir is not None:
        app.mount("/", StaticFiles(directory=Path(static_dir), html=True), name="app")

    app.add_middleware(ExposeReceive)          # added last, so outermost: it must see the server's own receive
    return app
