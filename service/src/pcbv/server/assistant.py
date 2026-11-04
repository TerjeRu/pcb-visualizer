"""The bench assistant: settings and keys, questions, conversations and the proposals it makes."""
from __future__ import annotations

import asyncio
import copy
import threading

from fastapi import APIRouter, Depends, Request

from .. import settings as appsettings
from ..assistant import AssistantError, AssistantOff, load_settings, suggestion_events
from ..assistant_tools import ToolContext
from ..datarepo import board_history
from ..events import EventError
from .body import body_json
from .errors import error
from .guard import watch_disconnect
from .serial import validate_serial_session
from .state import State, broadcast_changes

ASSISTANT_OFF = "The assistant is off. Turn it on in the settings to use it."


async def require_assistant(state: State) -> None:
    """Every route in this file answers 409 `assistant_off` while the setting is off, so no model call,
    key or conversation can be reached. A new route here is covered without remembering this."""
    if (await asyncio.to_thread(appsettings.load, state.registry.root))["assistant"] != "on":
        raise AssistantOff(ASSISTANT_OFF)


router = APIRouter(dependencies=[Depends(require_assistant)])


@router.get("/api/assistant")
async def assistant_get(state: State):
    """Profiles (without keys), whether each has a key, running usage and whether a keyring exists."""
    return await asyncio.to_thread(state.assistant.view)


@router.post("/api/assistant/settings")
async def assistant_settings(request: Request, state: State):
    """The view, plus `keys_cleared`: profiles whose stored key was deleted because their endpoint changed."""
    return await asyncio.to_thread(state.assistant.update_settings, await body_json(request))


@router.post("/api/assistant/keys/{profile}")
async def assistant_key(profile: str, request: Request, state: State):
    """{key} stores the profile's API key in the system keyring; {key: null} removes it. Never read back."""
    data = await body_json(request)
    await asyncio.to_thread(state.assistant.set_key, profile, data.get("key"))
    return {"profile": profile, "key_set": data.get("key") is not None}


@router.post("/api/assistant/test/{profile}")
async def assistant_test(profile: str, state: State):
    """One short question to the profile's saved server, with no board data. {ok, model, totals} or {ok: false, message}."""
    return await asyncio.to_thread(state.assistant.test, profile)


@router.post("/api/boards/{slug}/assistant/chat")
async def assistant_chat(slug: str, request: Request, state: State):
    """{message, profile?, conversation?, context?}: one question, answered with the tools."""
    entry = state.registry.get(slug)
    data = await body_json(request)
    board = entry.board
    snapshot = copy.deepcopy(board.project)          # the thread reads a steady copy, not the live state
    saved = await asyncio.to_thread(appsettings.load, state.registry.root)
    git_on = saved["git"] == "on"
    ctx = ToolContext(slug=slug, directory=board.directory, files=board.files, project=lambda: snapshot, seq=lambda: board.seq,
                      events=board.events_since, commits=lambda: board_history(board.directory, 10) if git_on else [],
                      playbooks_dir=state.playbooks_dir, wiki_dir=state.wiki_dir)
    profile = data.get("profile") or load_settings()["default"]
    guidance = saved["guidance"]
    cancel = threading.Event()
    root = state.registry.root
    watcher = asyncio.create_task(watch_disconnect(request.scope["pcbv.receive"], cancel))
    try:
        return await asyncio.to_thread(lambda: state.assistant.turn(
            ctx, profile=profile, conversation=data.get("conversation", "main"), message=data.get("message"),
            context=data.get("context"), guidance=guidance, cancel=cancel,
            permitted=lambda: appsettings.load(root)["assistant"] == "on"))
    except asyncio.CancelledError:
        cancel.set()                              # the worker keeps its slot until it notices
        raise
    finally:
        watcher.cancel()


@router.get("/api/boards/{slug}/assistant/conversation")
async def assistant_conversation(slug: str, state: State, conversation: str = "main"):
    state.registry.get(slug)
    return {"messages": state.assistant.transcript(slug, conversation)}


@router.post("/api/boards/{slug}/assistant/reset")
async def assistant_reset(slug: str, request: Request, state: State):
    state.registry.get(slug)
    data = await body_json(request)
    state.assistant.reset(slug, data.get("conversation", "main"))
    return {"reset": True}


@router.get("/api/boards/{slug}/assistant/proposals")
async def assistant_proposals(slug: str, state: State):
    state.registry.get(slug)
    return {"proposals": state.assistant.list_proposals(slug)}


@router.post("/api/boards/{slug}/assistant/proposals/{proposal_id}")
async def assistant_decide(slug: str, proposal_id: str, request: Request, state: State):
    """{action: "approve" | "decline"}. Approving sends the command to the open console. Only the
    person can do this; the assistant has no tool for it."""
    assistant = state.assistant
    entry = state.registry.get(slug)
    data = await body_json(request)
    action = data.get("action")
    if not 1 <= len(proposal_id.encode()) <= 128:
        raise EventError("The proposal ID must be 1 to 128 UTF-8 bytes.")
    async with entry.lock:
        if action == "approve":
            receipt = next((e for e in entry.board.events if e.get("proposalId") == proposal_id), None)
            if receipt is not None:
                return {"ok": True, "seq": receipt["seq"], "alreadyAccepted": True}
        try:
            pending = assistant.get_proposal(slug, proposal_id)
        except AssistantError:
            return error(404, "proposal_not_found", "There is no pending proposal and no accepted proposal with this ID.")
        if pending.get("kind", "command") != "command":
            if action != "approve":
                return {"proposal": assistant.decide(slug, proposal_id, action, lambda command: None)}
            if pending["status"] != "pending":
                return error(409, "conflict", "This proposal is no longer pending")
            before = entry.board.seq
            storage_before = copy.deepcopy(entry.board.storage)
            try:
                events = suggestion_events(pending, entry.board.project)
                stored = entry.board.apply({"type": "board/batch", "events": events}, "web", _proposal_id=proposal_id)
            finally:
                broadcast_changes(entry, before, storage_before)
            assistant.mark_accepted(slug, proposal_id)
            return {"ok": True, "seq": stored["seq"], "alreadyAccepted": False}
    async with state.serial_lock(slug):
        session = None
        if action == "approve":
            session, failure = validate_serial_session(state, slug, data)
            if failure:
                return failure
        send = session.write_line if session is not None else (lambda command: None)
        try:
            proposal = await asyncio.to_thread(assistant.decide, slug, proposal_id, action, send)
        except OSError:
            if session and session._stop.is_set():
                return error(409, "session_stale", "The console session has closed")
            raise
        return {"proposal": proposal}
