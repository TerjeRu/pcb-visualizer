"""Project file constants and helpers."""
from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime
from typing import Any

from .hints import command

FORMAT = "pcb-visualizer-project"
SCHEMA_VERSION = 2
PROTOCOL_VERSION = 2
DEFAULT_PROJECT_FILE = "project.pcb.json"
ASSET_DIR = "assets"

Project = dict[str, Any]


def new_uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def now_iso() -> str:
    """UTC timestamp in the same shape as JavaScript's Date.toISOString()."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def create_project(name: str = "Untitled board", *, now: str | None = None) -> Project:
    stamp = now or now_iso()
    return {
        "format": FORMAT,
        "schemaVersion": SCHEMA_VERSION,
        "meta": {
            "id": new_uid("prj"),
            "name": name,
            "device": "",
            "notes": "",
            "created": stamp,
            "modified": stamp,
        },
        "assets": [],
        "markers": [],
        "schematics": [],
        "components": [],
    }


def serialize_project(project: Project) -> str:
    """Two-space indent and a trailing newline, so git diffs stay clean."""
    return json.dumps(project, indent=2, ensure_ascii=False) + "\n"


class ProjectShapeError(ValueError):
    pass


def check_project_shape(raw: Any) -> Project:
    """Reject anything that is clearly not a project this service can safely own.

    Deliberately stricter than the browser's normalizeProject: the service does
    not repair files, it refuses them, so it never rewrites data it does not understand.
    """
    if not isinstance(raw, dict):
        raise ProjectShapeError("project is not a JSON object")
    if raw.get("format") != FORMAT:
        raise ProjectShapeError(f"unknown format {raw.get('format')!r}")
    version = raw.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool):
        raise ProjectShapeError("schemaVersion must be an integer")
    if version != SCHEMA_VERSION:
        raise ProjectShapeError(
            f"unsupported snapshot version {version}; this service reads snapshot version {SCHEMA_VERSION}. Recreate the test board with {command('new')} or {command('demo')}"
        )
    if not isinstance(raw.get("meta"), dict):
        raise ProjectShapeError("meta must be an object")
    for key in ("assets", "markers", "schematics", "components"):
        value = raw.get(key)
        if not isinstance(value, list) or not all(isinstance(v, dict) for v in value):
            raise ProjectShapeError(f"{key} must be a list of objects")
    return raw
