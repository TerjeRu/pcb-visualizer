"""Small builders so tests read as intent, not as dict plumbing."""
from __future__ import annotations

import pytest

# For tests that commit through the real commit guard; the fixture is in conftest.py.
needs_gitleaks = pytest.mark.usefixtures("working_gitleaks")


def require_gitleaks(state: str, ci: bool) -> None:
    """Skips the test when gitleaks cannot run the guard's scan. In CI that fails instead, so the guard
    tests can never be skipped there without anyone noticing."""
    if state == "ok":
        return
    reason = f"the commit guard needs gitleaks 8.21 or newer, and gitleaks here is {state}"
    if ci:
        pytest.fail(reason)
    pytest.skip(reason)


def asset(id="img_a", path="assets/a.jpg", **extra):
    return {"id": id, "kind": "image", "path": path, "label": id, "side": "front",
            "width": 1000, "height": 800, **extra}


def schematic(id="sch_a", rows=1, cols=4, **extra):
    return {"id": id, "kind": "header", "name": "Header", "rows": rows, "cols": cols, "pitch": 2.54,
            "numbering": "row", "rotation": 0, "notes": "", "pins": [], **extra}


def marker(id="mk_a", asset_id="img_a", schematic_id="sch_a", **extra):
    return {"id": id, "assetId": asset_id, "schematicId": schematic_id, "shape": "box",
            "label": "", "color": "#f59e0b", "x": 10, "y": 20, "w": 40, "h": 20, **extra}


def add_asset(**kw):
    return {"type": "asset/added", "asset": asset(**kw)}


def add_marker(marker_id="mk_a", asset_id="img_a", schematic_id="sch_a", with_schematic=True):
    event = {"type": "marker/added", "marker": marker(marker_id, asset_id, schematic_id)}
    if with_schematic:
        event["schematic"] = schematic(schematic_id)
    return event


def pin(schematic_id, index, patch):
    return {"type": "pin/updated", "schematicId": schematic_id, "index": index, "patch": patch}


def script():
    """Events that cover every reducer path, including the cascades on removal."""
    comp = {"id": "cmp_1", "assetId": "img_a", "x": 1, "y": 2, "w": 3, "h": 4}
    return [
        {"type": "project/metaUpdated", "patch": {"name": "Nimbus", "device": "Acme"}},
        add_asset(id="img_a", path="assets/a.jpg"),
        add_asset(id="img_b", path="assets/b.jpg"),
        add_marker("mk_1", "img_a", "sch_1"),
        # second marker on the other photo shares the same header
        {"type": "marker/added", "marker": marker("mk_2", "img_b", "sch_1")},
        add_marker("mk_3", "img_a", "sch_2"),
        pin("sch_1", 3, {"role": "TX", "label": "TX"}),
        pin("sch_1", 1, {"role": "GND", "color": "#4b5563"}),   # inserted before pin 3, must sort
        pin("sch_1", 3, {"note": "3.3V logic"}),                # merge into an existing pin
        pin("sch_1", 2, {"role": "", "label": ""}),             # empty pin must not be kept
        pin("sch_1", 4, {"role": "RX", "custom": "kept"}),      # unknown keys count as content
        pin("sch_1", 1, None),                                  # explicit removal
        {"type": "marker/updated", "id": "mk_1", "patch": {"x": 99, "label": "J1"}},
        {"type": "schematic/updated", "id": "sch_1", "patch": {"rows": 2, "cols": 2, "numbering": "u"}},
        {"type": "asset/updated", "id": "img_a", "patch": {"label": "front"}},
        # unset and at, as undo writes them
        {"type": "marker/updated", "id": "mk_1", "patch": {"x": 98}, "unset": ["color"]},
        {"type": "schematic/updated", "id": "sch_1", "patch": {}, "unset": ["notes"]},
        {"type": "asset/updated", "id": "img_b", "patch": {}, "unset": ["side"]},
        {"type": "project/metaUpdated", "patch": {"name": "Nimbus N100"}, "unset": ["device"]},
        {**add_asset(id="img_c", path="assets/c.jpg"), "at": 1},
        {**add_marker("mk_4", "img_c", "sch_4"), "at": 0, "schematicAt": 1},
        {"type": "marker/removed", "id": "mk_4"},
        {"type": "asset/removed", "id": "img_c"},
        {"type": "annotation/added", "annotation": {"id": "an_1", "assetId": "img_b", "x": 1, "y": 1, "lx": 9, "ly": 9, "text": "R1", "wiki": ""}},
        {"type": "annotation/added", "annotation": {"id": "an_2", "assetId": "img_b", "x": 2, "y": 2, "lx": 8, "ly": 8, "text": "C1"}, "at": 0},
        {"type": "annotation/updated", "id": "an_1", "patch": {"text": "R2"}, "unset": ["wiki"]},
        {"type": "playbook/updated", "playbookId": "uart", "stepId": "find", "patch": {"done": True}},
        {"type": "playbook/updated", "playbookId": "uart", "stepId": "wire", "patch": {"done": True}},
        {"type": "playbook/updated", "playbookId": "uart", "stepId": "wire", "patch": {}, "unset": ["done"]},
        {"type": "playbook/updated", "playbookId": "spi", "patch": {"answers": {"a": "yes"}}},
        {"type": "playbook/updated", "playbookId": "spi", "patch": {}, "unset": ["answers"]},
        {"type": "components/replaced", "components": [comp, {**comp, "id": "cmp_2", "assetId": "img_b"}]},
        {"type": "marker/removed", "id": "mk_2"},                 # header still used by mk_1
        {"type": "marker/removed", "id": "mk_3"},                 # last user of sch_2: header goes too
        {"type": "asset/removed", "id": "img_a"},                 # cascades to markers, headers, components
    ]

