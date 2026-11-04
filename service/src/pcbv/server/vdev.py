"""The virtual board for practice: start and stop `pcbv vdev` from the app."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter

from ..vdevmanager import NotOwned, VdevError
from .errors import error
from .state import State

router = APIRouter()


@router.get("/api/vdev")
async def vdev_status(state: State):
    return await asyncio.to_thread(state.vdev.status)


@router.post("/api/vdev/start")
async def vdev_start(state: State):
    try:
        async with state.vdev_lock:
            return await asyncio.to_thread(state.vdev.start)
    except VdevError as problem:
        return error(500, "vdev_failed", str(problem))


@router.post("/api/vdev/stop")
async def vdev_stop(state: State):
    try:
        async with state.vdev_lock:
            return await asyncio.to_thread(state.vdev.stop)
    except NotOwned as problem:
        return error(409, "vdev_not_owned", str(problem))
