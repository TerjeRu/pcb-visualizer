"""Bench assistant: a provider-agnostic chat loop over the OpenAI-compatible API, with domain tools.

What it can do: read the board through the tools in assistant_tools.py, save a finding in the board's
analysis folder, and propose a console command. What it cannot do: run anything. A proposal is a card
the person approves in the app. A list of known destructive commands is refused before a card exists; it
cannot cover every dangerous command. An approved command is checked again. The command-pattern guard
cannot identify every hardware write. Tool results are marked as data, because boot logs, strings and
notes can contain text written to steer a model.

Conversations are kept in memory only. See docs/SERVICE.md.
"""
from .errors import AssistantBusy, AssistantError, AssistantOff, KeyStoreError, TurnCancelled, UpstreamError
from .client import MAX_RESPONSE_BYTES, chat_request, parse_completion
from .loop import MAX_ROUNDS, AssistantService
from .proposals import command_problem, suggestion_events
from .settings import (PROFILES, KeyringStore, MemoryKeyStore, default_settings, endpoint, load_settings, load_usage,
                       record_usage, validate_settings)

__all__ = ["AssistantBusy", "AssistantError", "AssistantOff", "AssistantService", "KeyStoreError", "KeyringStore", "MAX_RESPONSE_BYTES",
           "MAX_ROUNDS", "MemoryKeyStore", "PROFILES", "TurnCancelled", "UpstreamError", "chat_request",
           "command_problem", "default_settings", "endpoint", "load_settings", "load_usage", "parse_completion",
           "record_usage", "suggestion_events", "validate_settings"]
