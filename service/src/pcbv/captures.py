"""Capture records: new ids and file names, lookups, and the patch that stops a capture."""
from __future__ import annotations

import secrets
from datetime import datetime

from .schema import now_iso


def new_capture_id(folder: str, extension: str, *, id_bytes: int = 4) -> tuple[str, str]:
    """(id, path) for a new capture file. The local time in the name keeps a folder listing in order."""
    capture_id = f"cap_{secrets.token_hex(id_bytes)}"
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    return capture_id, f"{folder}/{stamp}_{capture_id}.{extension}"


def find_capture(project: dict, capture_id: object, kinds: tuple[str, ...]) -> dict | None:
    return next((c for c in project.get("captures", [])
                 if c.get("id") == capture_id and c.get("kind") in kinds), None)


def capture_stopped_patch(reason: str, *, size: int | None = None, kind: str | None = None,
                          seen: list[str] | None = None) -> dict:
    patch: dict = {"stopped": now_iso()}
    if size is not None:
        patch["bytes"] = size
    patch["reason"] = reason
    if kind is not None:
        patch["kind"] = kind
    if seen is not None:
        patch["seen"] = seen
    return patch
