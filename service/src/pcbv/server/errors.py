"""The error shape every route answers with, {error, message}, and the exceptions that map to it."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..assistant import AssistantBusy, AssistantError, AssistantOff, KeyStoreError, UpstreamError
from ..board import BoardNotFound
from ..events import EventConflict, EventError
from ..export import ExportError
from ..journal import StorageError
from ..limits import BodyTooLarge, WorkBusy
from .. import logic as logicmod
from ..photos import PhotoError


class NotFound(LookupError):
    """A record the request names does not exist. Maps to HTTP 404."""


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": code, "message": message}, status_code=status)


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(OSError)
    async def filesystem_error(_: Request, exc: OSError):
        if isinstance(exc, BoardNotFound):
            return error(404, "not_found", str(exc))
        if isinstance(exc, FileExistsError):
            return error(409, "exists", str(exc))
        return error(503, "recovery_required", "The service cannot safely access a board file. Check the file, then reopen the board.")

    @app.exception_handler(StorageError)
    async def storage_error(_: Request, exc: StorageError):
        return error(503, exc.code, str(exc))

    @app.exception_handler(EventError)
    async def _invalid(_: Request, exc: EventError):
        return error(422, "invalid_event", str(exc))

    @app.exception_handler(RequestValidationError)
    async def _bad_request(_: Request, exc: RequestValidationError):
        where = ", ".join(".".join(str(part) for part in item["loc"]) for item in exc.errors())
        return error(422, "bad_request", f"The request is not valid: {where}.")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        codes = {404: "not_found", 405: "method_not_allowed"}
        return error(exc.status_code, codes.get(exc.status_code, "http_error"), str(exc.detail))

    @app.exception_handler(NotFound)
    async def _missing(_: Request, exc: NotFound):
        return error(404, "not_found", str(exc))

    @app.exception_handler(BodyTooLarge)
    async def _too_large(_: Request, exc: BodyTooLarge):
        return error(413, "too_large", str(exc))

    @app.exception_handler(WorkBusy)
    async def _busy(_: Request, exc: WorkBusy):
        return error(429, "work_busy", str(exc))

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception):
        return error(500, "internal_error", "The service had an unexpected error. The service log has the details.")

    @app.exception_handler(PhotoError)
    async def _bad_photo(_: Request, exc: PhotoError):
        return error(422, "invalid_photo", str(exc))

    @app.exception_handler(EventConflict)
    async def _conflict(_: Request, exc: EventConflict):
        return error(409, "conflict", str(exc))

    @app.exception_handler(ExportError)
    async def _bad_export(_: Request, exc: ExportError):
        return error(422, "invalid_export", str(exc))

    @app.exception_handler(logicmod.LogicError)
    async def _bad_capture(_: Request, exc: logicmod.LogicError):
        return error(422, "invalid_capture", str(exc))

    @app.exception_handler(KeyStoreError)
    async def _keyring(_: Request, exc: KeyStoreError):
        return error(503, "keyring_unavailable", str(exc))

    @app.exception_handler(UpstreamError)
    async def _upstream(_: Request, exc: UpstreamError):
        return error(502, "model_server", str(exc))

    @app.exception_handler(AssistantBusy)
    async def _assistant_busy(_: Request, exc: AssistantBusy):
        return error(429, "assistant_busy", str(exc))

    @app.exception_handler(AssistantOff)
    async def _assistant_off(_: Request, exc: AssistantOff):
        return error(409, "assistant_off", str(exc))

    @app.exception_handler(AssistantError)
    async def _assistant(_: Request, exc: AssistantError):
        return error(422, "invalid_assistant_request", str(exc))
