"""Saved workspaces (panel layouts), per machine, shared by the browser app and the desktop shell.

Stored in `$XDG_CONFIG_HOME/pcbv/workspaces.json` (default ~/.config/pcbv). The app owns the layout
format (app/js/core/layout.js) and repairs anything odd when it loads; the service only checks
size and shape so a broken file can never take the app down.
"""
from __future__ import annotations

import json
import threading
import os
from pathlib import Path

from .fsutil import atomic_write

MAX_BYTES = 200_000
MAX_WORKSPACES = 40
MAX_NAME = 40


class WorkspaceError(ValueError):
    pass


def config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    return (Path(base) if base else Path.home() / ".config") / "pcbv"


def _path() -> Path:
    return config_dir() / "workspaces.json"


def load() -> dict:
    """{current, saved: {name: layout}}. A missing or unreadable file gives an empty set."""
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        validate(data)
        return data
    except (OSError, ValueError):
        return {"current": None, "saved": {}}


def validate(data) -> dict:
    if not isinstance(data, dict):
        raise WorkspaceError("workspaces must be an object")
    saved = data.get("saved", {})
    if not isinstance(saved, dict) or len(saved) > MAX_WORKSPACES:
        raise WorkspaceError(f"saved must be an object with at most {MAX_WORKSPACES} workspaces")
    for name, layout in saved.items():
        if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME:
            raise WorkspaceError(f"workspace names are 1 to {MAX_NAME} characters")
        if not isinstance(layout, dict):
            raise WorkspaceError(f"workspace {name!r} must be an object")
    current = data.get("current")
    if current is not None and not isinstance(current, str):
        raise WorkspaceError("current must be a workspace name or null")
    if len(json.dumps(data)) > MAX_BYTES:
        raise WorkspaceError(f"workspaces larger than {MAX_BYTES // 1000} kB")
    return {"current": current, "saved": saved}


_save_lock = threading.Lock()


def save(data) -> dict:
    with _save_lock:
        clean = validate(data)
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(path, (json.dumps(clean, indent=2) + "\n").encode())
        return clean
