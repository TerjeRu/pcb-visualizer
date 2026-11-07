"""Turning a photo by 90 degrees: where its markers, callouts, header grids and component boxes go.

Coordinates are pixels in the photo's committed copy, origin top left. A right turn (turns = 1) is
clockwise and a left turn (turns = -1) is counter-clockwise, matching `pinLayout` in the app, where a
header rotation of 90 turns the pin grid clockwise.
"""
from __future__ import annotations

from .events import EventError

MAX_TURN_CHILDREN = 256           # the board/batch limit in events.py


def _check(turns) -> None:
    if isinstance(turns, bool) or turns not in (1, -1):
        raise ValueError("turns must be 1 or -1")


def turn_point(x, y, width, height, turns):
    """A point on a width x height photo, after the turn."""
    _check(turns)
    return (height - y, x) if turns == 1 else (y, width - x)


def turn_box(x, y, w, h, width, height, turns):
    """A box (top left, size) on a width x height photo, after the turn. Its sides swap."""
    _check(turns)
    if turns == 1:
        return height - (y + h), x, h, w
    return y, width - (x + w), h, w


def _turn_bbox(bbox, width, height, turns):
    if isinstance(bbox, list):
        return list(turn_box(*bbox, width, height, turns))
    x, y, w, h = turn_box(bbox["x"], bbox["y"], bbox["w"], bbox["h"], width, height, turns)
    return {**bbox, "x": x, "y": y, "w": w, "h": h}


def turn_events(project: dict, asset_id: str, turns: int, path: str) -> list[dict]:
    """The children of the board/batch that turns the photo `asset_id`, whose turned copy is at `path`."""
    _check(turns)
    asset = next(a for a in project["assets"] if a.get("id") == asset_id)
    width, height = asset["width"], asset["height"]
    events = [{"type": "asset/updated", "id": asset_id, "patch": {
        "path": path, "width": height, "height": width, "rotation": (asset.get("rotation", 0) + 90 * turns) % 360}}]

    markers = [m for m in project["markers"] if m.get("assetId") == asset_id]
    for marker in markers:
        if marker.get("shape") == "box":
            x, y, w, h = turn_box(marker["x"], marker["y"], marker["w"], marker["h"], width, height, turns)
            patch = {"x": x, "y": y, "w": w, "h": h}
        else:
            x, y = turn_point(marker["x"], marker["y"], width, height, turns)
            patch = {"x": x, "y": y}
        events.append({"type": "marker/updated", "id": marker["id"], "patch": patch})

    # A header's grid turns only when all of its boxes are on this photo; a box elsewhere would break.
    elsewhere = {m.get("schematicId") for m in project["markers"] if m.get("shape") == "box" and m.get("assetId") != asset_id}
    turned = {m.get("schematicId") for m in markers if m.get("shape") == "box"} - elsewhere
    for schematic in project["schematics"]:
        if schematic.get("id") in turned:
            events.append({"type": "schematic/updated", "id": schematic["id"],
                           "patch": {"rotation": (schematic.get("rotation", 0) + 90 * turns) % 360}})

    for note in project.get("annotations", []):
        if note.get("assetId") == asset_id:
            patch = {}
            for kx, ky in (("x", "y"), ("lx", "ly")):
                if kx in note and ky in note:
                    patch[kx], patch[ky] = turn_point(note[kx], note[ky], width, height, turns)
            if patch:
                events.append({"type": "annotation/updated", "id": note["id"], "patch": patch})

    components = project.get("components", [])
    if any(c.get("assetId") == asset_id for c in components):
        events.append({"type": "components/replaced", "components": [
            {**c, "bbox": _turn_bbox(c["bbox"], width, height, turns)} if c.get("assetId") == asset_id and "bbox" in c else c
            for c in components]})

    if len(events) > MAX_TURN_CHILDREN:
        raise EventError("This photo has too many markers, callouts and headers to rotate at once.")
    return events
