"""Errors the assistant raises. Each message is safe to show to the person."""


class AssistantError(RuntimeError):
    """A problem the person can fix or should know about. The message is safe to show."""


class AssistantBusy(AssistantError):
    """Too many questions at once, or this conversation is still answering."""


class TurnCancelled(AssistantError):
    """The window that asked has gone away; no further model calls or tools run."""


class AssistantOff(AssistantError):
    """The assistant is switched off in the settings. Maps to HTTP 409 `assistant_off`."""


class KeyStoreError(AssistantError):
    """The system keyring is missing, locked or refused."""


class UpstreamError(AssistantError):
    """The model server could not be reached or answered badly. `status` is the HTTP status it answered
    with, `kind` is "unreachable" or "timeout" when there was no answer, and `detail` is what the server said."""

    def __init__(self, message: str, *, status: int | None = None, kind: str = "", detail: str = ""):
        super().__init__(message)
        self.status, self.kind, self.detail = status, kind, detail
