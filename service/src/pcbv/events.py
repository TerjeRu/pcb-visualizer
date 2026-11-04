"""Event validation.

The journal is append-only and replayed on every start, so one bad event would
poison a board forever. Every event is therefore checked twice before it is
written: once for shape (this module, no state needed) and once against the
current project (`check_against_state`, for references and duplicates).
"""
from __future__ import annotations

import json
import math
import posixpath
import re
from typing import Any

from .schema import ASSET_DIR, Project, ProjectShapeError, check_project_shape

MAX_EVENT_BYTES = 1_000_000

# type -> (required payload keys, optional payload keys)
CLIENT_EVENT_FIELDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "board/batch": (("events",), ()),
    "project/metaUpdated": (("patch",), ()),
    "asset/added": (("asset",), ()),
    "asset/updated": (("id", "patch"), ()),
    "asset/removed": (("id",), ()),
    "marker/added": (("marker",), ("schematic",)),
    "marker/updated": (("id", "patch"), ()),
    "marker/removed": (("id",), ()),
    "schematic/updated": (("id", "patch"), ()),
    "pin/readingAdded": (("schematicId", "index", "reading"), ()),
    "pin/updated": (("schematicId", "index", "patch"), ()),
    "components/replaced": (("components",), ()),
    "playbook/updated": (("playbookId", "patch"), ("stepId",)),
    "annotation/added": (("annotation",), ()),
    "annotation/updated": (("id", "patch"), ()),
    "annotation/removed": (("id",), ()),
}
# Written by the service for console, shell and logic captures; clients cannot forge them.
CAPTURE_EVENT_FIELDS = {
    "capture/started": (("capture",), ()),
    "capture/stopped": (("id", "patch"), ()),
    "capture/updated": (("id", "patch"), ()),
}
# Written by the service itself, never accepted from a client.
INTERNAL_EVENT_FIELDS = {
    "project/created": (("project",), ()),
    "project/replaced": (("project",), ()),
}
INTERNAL_EVENT_FIELDS.update(CAPTURE_EVENT_FIELDS)
ALL_EVENT_FIELDS = {**CLIENT_EVENT_FIELDS, **INTERNAL_EVENT_FIELDS}

PROTECTED_META_KEYS = {"id", "created"}
PLAYBOOK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class EventError(ValueError):
    """The event is malformed. Maps to HTTP 422."""


class EventConflict(ValueError):
    """The event is well formed but does not fit the current project. Maps to HTTP 409."""


def _is_str(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_asset_path(path: Any) -> str:
    """Asset paths are relative, live under assets/ and cannot climb out of the board."""
    if not isinstance(path, str) or not path:
        raise EventError("asset path must be a non-empty string")
    if "\\" in path or "\x00" in path or path.startswith("/"):
        raise EventError(f"asset path {path!r} is not a plain relative path")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise EventError(f"asset path {path!r} contains empty, '.' or '..' segments")
    if posixpath.normpath(path) != path or parts[0] != ASSET_DIR or len(parts) < 2:
        raise EventError(f"asset path {path!r} must be inside {ASSET_DIR}/")
    return path


def _need_dict(event: dict, key: str) -> dict:
    value = event.get(key)
    if not isinstance(value, dict):
        raise EventError(f"{event['type']}: {key} must be an object")
    return value


def _check_patch(patch: dict, *, protected: set[str] = frozenset({"id"})) -> None:
    clash = protected & patch.keys()
    if clash:
        raise EventError(f"patch may not change {sorted(clash)}")


GUESS_CONFIDENCE = ("high", "medium", "low")


def _check_guess(guess: Any, kind: str) -> None:
    """An AI guess on a callout or pin: who guessed, how sure, and why. null clears it."""
    if guess is None:
        return
    if not isinstance(guess, dict) or guess.get("confidence") not in GUESS_CONFIDENCE:
        raise EventError(f"{kind}: guess must be an object with confidence high, medium or low")
    for key, limit in (("by", 120), ("evidence", 400), ("role", 16), ("at", 40)):
        if key in guess and (not isinstance(guess[key], str) or len(guess[key]) > limit):
            raise EventError(f"{kind}: guess.{key} must be text of at most {limit} characters")


def _check_annotation_fields(fields: dict, kind: str) -> None:
    for key in ("x", "y", "lx", "ly"):
        if key in fields and (not isinstance(fields[key], (int, float)) or isinstance(fields[key], bool)):
            raise EventError(f"{kind}: {key} must be a number")
    if "text" in fields and (not isinstance(fields["text"], str) or len(fields["text"]) > 200):
        raise EventError(f"{kind}: text must be a string of at most 200 characters")
    if fields.get("wiki") not in (None, "") and (not isinstance(fields["wiki"], str) or not PLAYBOOK_ID_RE.match(fields["wiki"])):
        raise EventError(f"{kind}: wiki must be a page name like spi-flash")
    if "guess" in fields:
        _check_guess(fields["guess"], kind)


def _check_fields(fields: dict, *, pin=False):
    for key in ("x", "y", "lx", "ly", "w", "h", "width", "height", "pitch", "rotation", "rows", "cols"):
        if key not in fields:
            continue
        value = fields[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or abs(value) > 1_000_000 or not math.isfinite(value):
            raise EventError(f"{key} must be finite with absolute value at most 1000000")
        if key in ("w", "h", "width", "height", "pitch", "rows", "cols") and value <= 0:
            raise EventError(f"{key} must be positive")
        if key in ("rows", "cols") and (not _is_int(value) or value > 64):
            raise EventError(f"{key} must be an integer from 1 to 64")
    if "color" in fields:
        color = fields["color"]
        if not (pin and color == "") and (not isinstance(color, str) or re.fullmatch(r"#[0-9a-fA-F]{6}", color) is None):
            raise EventError("color must be a six-digit hex colour")
    if "bbox" in fields:
        box = fields["bbox"]
        if isinstance(box, list) and len(box) == 4:
            _check_fields(dict(zip(("x", "y", "w", "h"), box, strict=True)))
        elif isinstance(box, dict) and all(k in box for k in ("x", "y", "w", "h")):
            _check_fields(box)
        else:
            raise EventError("bbox must contain x, y, w and h")
    if "original" in fields:
        validate_asset_path(fields["original"])
    if "pins" in fields:
        if not isinstance(fields["pins"], list):
            raise EventError("pins must be a list")
        seen = set()
        for item in fields["pins"]:
            if not isinstance(item, dict) or not _is_int(item.get("index")) or not 1 <= item["index"] <= 1_000_000 or item["index"] in seen:
                raise EventError("pin indices must be unique integers from 1 to 1000000")
            seen.add(item["index"])
            _check_fields(item, pin=True)
            if "guess" in item:
                _check_guess(item["guess"], "pin")


def _capture_path(path):
    if not isinstance(path, str) or not path.startswith("captures/"):
        raise EventError("capture path must be inside captures/")
    validate_asset_path("assets/" + path[len("captures/"):])


def validate_project(raw):
    from .reducer import apply_event
    project = check_project_shape(raw)
    staged = {**project, "assets": [], "markers": [], "schematics": [], "components": [], "captures": [], "annotations": []}
    for key in ("assets", "markers", "schematics", "components", "captures", "annotations"):
        items = project.get(key, [])
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise EventError(f"{key} must be a list of objects")
        seen = set()
        for item in items:
            if not _is_str(item.get("id")) or item["id"] in seen:
                raise EventError(f"{key} IDs must be nonempty and unique")
            seen.add(item["id"])
            _check_fields(item)
    for schematic in project["schematics"]:
        if not all(key in schematic for key in ("rows", "cols")):
            raise EventError("schematic requires rows and cols")
    for marker in project["markers"]:
        if not all(key in marker for key in ("x", "y")) or marker.get("shape") not in ("box", "crosshair"):
            raise EventError("marker requires coordinates and a box or crosshair shape")
        if marker["shape"] == "box" and not all(key in marker for key in ("w", "h")):
            raise EventError("box marker requires width and height")
    staged["schematics"] = project["schematics"]
    for key, kind, payload in (("assets", "asset/added", "asset"), ("markers", "marker/added", "marker"),
                               ("captures", "capture/started", "capture"), ("annotations", "annotation/added", "annotation")):
        for item in project.get(key, []):
            event = validate_event({"type": kind, payload: item}, internal=True)
            check_against_state(staged, event)
            staged = apply_event(staged, event)
    for component in project["components"]:
        if not _is_str(component.get("assetId")):
            raise EventError("component assetId must be a nonempty string")
        if component.get("assetId") not in {a["id"] for a in project["assets"]}:
            raise EventConflict("component references a missing asset")
    playbooks = project.get("playbooks", {})
    if not isinstance(playbooks, dict):
        raise EventError("playbooks must be an object")
    for pid, record in playbooks.items():
        if not isinstance(record, dict):
            raise EventError("playbook progress must be an object")
        validate_event({"type": "playbook/updated", "playbookId": pid, "patch": {k: v for k, v in record.items() if k != "steps"}})
        steps = record.get("steps", {})
        if not isinstance(steps, dict):
            raise EventError("playbook steps must be an object")
        for sid, patch in steps.items():
            validate_event({"type": "playbook/updated", "playbookId": pid, "stepId": sid, "patch": patch})
    return project


def validate_event(raw: Any, *, internal: bool = False) -> dict:
    """Return a clean payload dict (type plus allowed fields only) or raise EventError."""
    if not isinstance(raw, dict):
        raise EventError("event must be a JSON object")
    if "proposalId" in raw:
        raise EventError("proposalId is service-owned metadata")
    kind = raw.get("type")
    table = ALL_EVENT_FIELDS if internal else CLIENT_EVENT_FIELDS
    if not isinstance(kind, str) or kind not in table:
        raise EventError(f"unknown event type {kind!r}")
    required, optional = table[kind]
    for key in required:
        if key not in raw:
            raise EventError(f"{kind}: missing {key!r}")
    event = {"type": kind, **{k: raw[k] for k in (*required, *optional) if k in raw}}

    if kind == "board/batch":
        children = event["events"]
        if not isinstance(children, list) or not 1 <= len(children) <= 256:
            raise EventError("board/batch requires 1 to 256 events")
        clean = []
        for child in children:
            if not isinstance(child, dict) or child.get("type") in ("board/batch", "project/created", "project/replaced"):
                raise EventError("batch children must be ordinary events")
            if set(child) & {"seq", "ts", "actor", "journalVersion", "proposalId"}:
                raise EventError("batch children cannot contain envelopes")
            clean.append(validate_event(child, internal=internal))
        event["events"] = clean
    elif kind in ("project/created", "project/replaced"):
        try:
            validate_project(event["project"])
        except ProjectShapeError as exc:
            raise EventError(f"{kind}: {exc}") from exc
    elif kind == "project/metaUpdated":
        patch = _need_dict(event, "patch")
        _check_patch(patch, protected=PROTECTED_META_KEYS)
    elif kind == "asset/added":
        asset = _need_dict(event, "asset")
        if not _is_str(asset.get("id")):
            raise EventError("asset/added: asset.id must be a non-empty string")
        validate_asset_path(asset.get("path"))
    elif kind == "asset/updated":
        if not _is_str(event["id"]):
            raise EventError("asset/updated: id must be a non-empty string")
        patch = _need_dict(event, "patch")
        _check_patch(patch)
        if "path" in patch:
            validate_asset_path(patch["path"])
    elif kind in ("asset/removed", "marker/removed"):
        if not _is_str(event["id"]):
            raise EventError(f"{kind}: id must be a non-empty string")
    elif kind == "marker/added":
        marker = _need_dict(event, "marker")
        for key in ("id", "assetId", "schematicId"):
            if not _is_str(marker.get(key)):
                raise EventError(f"marker/added: marker.{key} must be a non-empty string")
        schematic = event.get("schematic")
        if schematic is not None:
            if not isinstance(schematic, dict) or schematic.get("id") != marker["schematicId"]:
                raise EventError("marker/added: schematic.id must equal marker.schematicId")
            if not isinstance(schematic.get("pins", []), list):
                raise EventError("marker/added: schematic.pins must be a list")
    elif kind in ("marker/updated", "schematic/updated"):
        if not _is_str(event["id"]):
            raise EventError(f"{kind}: id must be a non-empty string")
        _check_patch(_need_dict(event, "patch"))
    elif kind == "pin/readingAdded":
        if not _is_str(event["schematicId"]) or not _is_int(event["index"]) or not 1 <= event["index"] <= 1_000_000:
            raise EventError("reading requires a schematic and pin index from 1 to 1000000")
        reading = _need_dict(event, "reading")
        if len(json.dumps(reading).encode()) > 4000:
            raise EventError("reading exceeds 4000 bytes")
        value = reading.get("value")
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or abs(value) > 1e308 or not math.isfinite(value)):
            raise EventError("reading value must be finite or null")
    elif kind == "pin/updated":
        if not _is_str(event["schematicId"]):
            raise EventError("pin/updated: schematicId must be a non-empty string")
        if not _is_int(event["index"]) or not 1 <= event["index"] <= 1_000_000:
            raise EventError("pin/updated: index must be an integer >= 1")
        patch = event["patch"]
        if patch is not None:
            if not isinstance(patch, dict):
                raise EventError("pin/updated: patch must be an object or null")
            if "index" in patch:
                raise EventError("pin/updated: patch may not change index")
            if "guess" in patch:
                _check_guess(patch["guess"], "pin/updated")
    elif kind == "capture/started":
        capture = _need_dict(event, "capture")
        if not _is_str(capture.get("id")):
            raise EventError("capture/started: capture.id must be a non-empty string")
        path = capture.get("path")
        if not isinstance(path, str) or not path.startswith("captures/") or ".." in path.split("/") or "\\" in path:
            raise EventError("capture/started: capture.path must be inside captures/")
    elif kind in ("capture/stopped", "capture/updated"):
        if not _is_str(event["id"]):
            raise EventError(f"{kind}: id must be a non-empty string")
        _check_patch(_need_dict(event, "patch"))
    elif kind == "annotation/added":
        note = _need_dict(event, "annotation")
        for key in ("id", "assetId"):
            if not _is_str(note.get(key)):
                raise EventError(f"annotation/added: annotation.{key} must be a non-empty string")
        _check_annotation_fields(note, "annotation/added")
    elif kind == "annotation/updated":
        if not _is_str(event["id"]):
            raise EventError("annotation/updated: id must be a non-empty string")
        patch = _need_dict(event, "patch")
        _check_patch(patch)
        _check_annotation_fields(patch, "annotation/updated")
    elif kind == "annotation/removed":
        if not _is_str(event["id"]):
            raise EventError("annotation/removed: id must be a non-empty string")
    elif kind == "playbook/updated":
        if not isinstance(event["playbookId"], str) or not PLAYBOOK_ID_RE.match(event["playbookId"]):
            raise EventError("playbook/updated: playbookId must be a short lowercase name")
        if "stepId" in event and (not isinstance(event["stepId"], str) or not PLAYBOOK_ID_RE.match(event["stepId"])):
            raise EventError("playbook/updated: stepId must be a short lowercase name")
        _need_dict(event, "patch")
        if "stepId" not in event and "steps" in event["patch"]:
            raise EventError("playbook/updated: change steps one at a time with stepId")
    elif kind == "components/replaced":
        comps = event["components"]
        if not isinstance(comps, list) or not all(isinstance(c, dict) for c in comps):
            raise EventError("components/replaced: components must be a list of objects")

    for key in ("asset", "marker", "schematic", "annotation", "patch", "capture"):
        fields = event.get(key)
        if isinstance(fields, dict):
            _check_fields(fields, pin=kind == "pin/updated")
    if kind == "components/replaced":
        for component in event["components"]:
            _check_fields(component)
    if kind.startswith("capture/"):
        fields = event.get("capture", event.get("patch", {}))
        if "path" in fields:
            _capture_path(fields["path"])
        if "decoded" in fields:
            if not isinstance(fields["decoded"], list):
                raise EventError("decoded must be a list")
            for decoded in fields["decoded"]:
                if not isinstance(decoded, dict):
                    raise EventError("decoded entries must be objects")
                _capture_path(decoded.get("text"))
    try:
        encoded = json.dumps(event, ensure_ascii=False, allow_nan=False).encode()
    except (ValueError, TypeError, UnicodeError) as exc:
        raise EventError("event must contain valid UTF-8 JSON values") from exc
    if len(encoded) > MAX_EVENT_BYTES:
        raise EventError(f"event larger than {MAX_EVENT_BYTES} bytes")
    return event


def check_against_state(project: Project, event: dict) -> None:
    """Reject events that point at things that do not exist or that duplicate ids."""
    kind = event["type"]
    ids = lambda key: {item.get("id") for item in project[key]}  # noqa: E731

    if kind == "asset/added" and event["asset"]["id"] in ids("assets"):
        raise EventConflict(f"asset {event['asset']['id']!r} already exists")
    elif kind in ("asset/updated", "asset/removed") and event["id"] not in ids("assets"):
        raise EventConflict(f"asset {event['id']!r} does not exist")
    elif kind == "marker/added":
        marker, schematic = event["marker"], event.get("schematic")
        if marker["id"] in ids("markers"):
            raise EventConflict(f"marker {marker['id']!r} already exists")
        if marker["assetId"] not in ids("assets"):
            raise EventConflict(f"marker references missing asset {marker['assetId']!r}")
        if schematic is not None and schematic["id"] in ids("schematics"):
            raise EventConflict(f"schematic {schematic['id']!r} already exists")
        if schematic is None and marker["schematicId"] not in ids("schematics"):
            raise EventConflict(f"marker references missing schematic {marker['schematicId']!r}")
    elif kind in ("marker/updated", "marker/removed") and event["id"] not in ids("markers"):
        raise EventConflict(f"marker {event['id']!r} does not exist")
    elif kind == "marker/updated":
        patch = event["patch"]
        if "assetId" in patch and patch["assetId"] not in ids("assets"):
            raise EventConflict(f"marker moved to missing asset {patch['assetId']!r}")
        if "schematicId" in patch and patch["schematicId"] not in ids("schematics"):
            raise EventConflict(f"marker moved to missing schematic {patch['schematicId']!r}")
    elif kind == "schematic/updated" and event["id"] not in ids("schematics"):
        raise EventConflict(f"schematic {event['id']!r} does not exist")
    elif kind == "capture/started" and event["capture"]["id"] in {c.get("id") for c in project.get("captures", [])}:
        raise EventConflict(f"capture {event['capture']['id']!r} already exists")
    elif kind in ("capture/stopped", "capture/updated") and event["id"] not in {c.get("id") for c in project.get("captures", [])}:
        raise EventConflict(f"capture {event['id']!r} does not exist")
    elif kind in ("annotation/added", "annotation/updated", "annotation/removed"):
        existing = {a.get("id") for a in project.get("annotations", [])}
        target = event["annotation"]["id"] if kind == "annotation/added" else event["id"]
        if kind == "annotation/added" and target in existing:
            raise EventConflict(f"annotation {target!r} already exists")
        if kind != "annotation/added" and target not in existing:
            raise EventConflict(f"annotation {target!r} does not exist")
        asset = (event["annotation"].get("assetId") if kind == "annotation/added"
                 else event.get("patch", {}).get("assetId"))
        if asset is not None and asset not in ids("assets"):
            raise EventConflict(f"annotation references missing asset {asset!r}")
    elif kind in ("pin/updated", "pin/readingAdded") and event["schematicId"] not in ids("schematics"):
        raise EventConflict(f"schematic {event['schematicId']!r} does not exist")
