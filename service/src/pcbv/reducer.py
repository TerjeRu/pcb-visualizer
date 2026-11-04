"""Pure project reducer. app/js/core/apply.js is its port for the front end.

tests/test_client_parity.py runs both implementations over the same events and
compares the results, so any drift between app and service fails the suite.
"""
from __future__ import annotations

import copy
from typing import Any

from .schema import Project

PIN_BASE_KEYS = {"index", "role", "label", "color", "note"}


def _replace_by_id(items: list[dict], target: str, fn) -> list[dict]:
    return [fn(item) if item.get("id") == target else item for item in items]


def _pin_has_content(pin: dict) -> bool:
    return bool(
        pin.get("role") or pin.get("label") or pin.get("color") or pin.get("note")
        or any(key not in PIN_BASE_KEYS for key in pin)
    )


def apply_event(project: Project, event: dict[str, Any]) -> Project:
    """Return a new project with `event` applied. The input is never mutated."""
    p = copy.deepcopy(project)
    kind = event["type"]

    if kind == "board/batch":
        for child in event["events"]:
            p = apply_event(p, child)
        return p

    if kind == "project/created" or kind == "project/replaced":
        return copy.deepcopy(event["project"])

    if kind == "project/metaUpdated":
        p["meta"] = {**p["meta"], **event["patch"]}

    elif kind == "asset/added":
        p["assets"].append(event["asset"])
    elif kind == "asset/updated":
        p["assets"] = _replace_by_id(p["assets"], event["id"], lambda a: {**a, **event["patch"]})
    elif kind == "asset/removed":
        asset_id = event["id"]
        markers = [m for m in p["markers"] if m.get("assetId") != asset_id]
        used = {m.get("schematicId") for m in markers}
        p["assets"] = [a for a in p["assets"] if a.get("id") != asset_id]
        p["markers"] = markers
        p["schematics"] = [s for s in p["schematics"] if s.get("id") in used]
        p["components"] = [c for c in p["components"] if c.get("assetId") != asset_id]
        if "annotations" in p:
            p["annotations"] = [a for a in p["annotations"] if a.get("assetId") != asset_id]

    elif kind == "marker/added":
        p["markers"].append(event["marker"])
        if event.get("schematic"):
            p["schematics"].append(event["schematic"])
    elif kind == "marker/updated":
        p["markers"] = _replace_by_id(p["markers"], event["id"], lambda m: {**m, **event["patch"]})
    elif kind == "marker/removed":
        marker = next((m for m in p["markers"] if m.get("id") == event["id"]), None)
        if marker is None:
            return p
        p["markers"] = [m for m in p["markers"] if m.get("id") != event["id"]]
        still_used = any(m.get("schematicId") == marker.get("schematicId") for m in p["markers"])
        if not still_used:
            p["schematics"] = [s for s in p["schematics"] if s.get("id") != marker.get("schematicId")]

    elif kind == "schematic/updated":
        p["schematics"] = _replace_by_id(p["schematics"], event["id"], lambda s: {**s, **event["patch"]})

    elif kind == "pin/readingAdded":
        schematic = next(s for s in p["schematics"] if s["id"] == event["schematicId"])
        existing = next((pin for pin in schematic.get("pins", []) if pin.get("index") == event["index"]), {})
        return apply_event(p, {"type": "pin/updated", "schematicId": event["schematicId"], "index": event["index"],
                               "patch": {"readings": [*existing.get("readings", []), event["reading"]]}})

    elif kind == "pin/updated":
        index, patch = event["index"], event["patch"]

        def update_schematic(sch: dict) -> dict:
            pins = sch.get("pins", [])
            existing = next((pin for pin in pins if pin.get("index") == index), None)
            if patch is None:
                pins = [pin for pin in pins if pin.get("index") != index]
            elif existing is not None:
                pins = [{**pin, **patch} if pin.get("index") == index else pin for pin in pins]
            else:
                created = {"index": index, "role": "", "label": "", "color": "", "note": "", **patch}
                pins = sorted([*pins, created], key=lambda pin: pin["index"])
            # A pin with nothing on it is dropped so files stay minimal.
            return {**sch, "pins": [pin for pin in pins if _pin_has_content(pin)]}

        p["schematics"] = _replace_by_id(p["schematics"], event["schematicId"], update_schematic)

    elif kind == "components/replaced":
        p["components"] = event["components"]

    elif kind == "capture/started":
        p.setdefault("captures", []).append(event["capture"])
    elif kind in ("capture/stopped", "capture/updated"):
        p["captures"] = _replace_by_id(p.get("captures", []), event["id"], lambda c: {**c, **event["patch"]})

    elif kind == "annotation/added":
        p.setdefault("annotations", []).append(event["annotation"])
    elif kind == "annotation/updated":
        p["annotations"] = _replace_by_id(p.get("annotations", []), event["id"], lambda a: {**a, **event["patch"]})
    elif kind == "annotation/removed":
        p["annotations"] = [a for a in p.get("annotations", []) if a.get("id") != event["id"]]

    elif kind == "playbook/updated":
        # Progress per playbook; with stepId the patch merges into that step, otherwise into the playbook.
        playbooks = p.setdefault("playbooks", {})
        record = playbooks.setdefault(event["playbookId"], {})
        if event.get("stepId"):
            steps = record.setdefault("steps", {})
            steps[event["stepId"]] = {**steps.get(event["stepId"], {}), **event["patch"]}
        else:
            record.update(event["patch"])

    else:  # unreachable for validated events; fail loudly on a journal from a newer version
        raise ValueError(f"cannot apply unknown event type {kind!r}")

    return p
