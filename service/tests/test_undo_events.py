"""`unset` and `at`: what undo in the app (app/js/core/undo.js) writes to put a board back exactly."""
import shutil

import pytest

from pcbv.board import Board
from pcbv.events import MAX_UNSET_KEYS, EventConflict, EventError, validate_event
from pcbv.reducer import apply_event
from pcbv.schema import create_project

import helpers as h
from test_client_parity import node


def project_with(*events):
    project = create_project("Undo", now="2026-11-06T10:00:00.000Z")
    for event in events:
        project = apply_event(project, validate_event(event))
    return project


def test_unset_removes_keys_after_the_patch():
    project = project_with(h.add_asset(), h.add_marker(),
                           {"type": "marker/updated", "id": "mk_a", "patch": {"x": 5}, "unset": ["label", "color"]})
    marker = project["markers"][0]
    assert marker["x"] == 5 and "label" not in marker and "color" not in marker


def test_unset_on_the_meta_keeps_the_other_fields():
    project = project_with({"type": "project/metaUpdated", "patch": {}, "unset": ["device"]})
    assert "device" not in project["meta"] and project["meta"]["name"] == "Undo"


@pytest.mark.parametrize("event", [
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": []},
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": "label"},
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": [""]},
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": ["x" * 65]},
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": ["label", "label"]},
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": [f"k{i}" for i in range(MAX_UNSET_KEYS + 1)]},
    {"type": "marker/updated", "id": "mk_a", "patch": {}, "unset": ["id"]},
    {"type": "marker/updated", "id": "mk_a", "patch": {"label": "J1"}, "unset": ["label"]},
    {"type": "project/metaUpdated", "patch": {}, "unset": ["created"]},
    {"type": "playbook/updated", "playbookId": "uart", "patch": {}, "unset": ["steps"]},
])
def test_unset_is_refused_when_it_is_not_a_short_list_of_free_keys(event):
    with pytest.raises(EventError):
        validate_event(event)


def test_unset_stays_out_of_events_that_do_not_take_it():
    event = validate_event({"type": "pin/updated", "schematicId": "sch_a", "index": 1, "patch": {"label": "TX"}, "unset": ["role"]})
    assert "unset" not in event


def test_unset_prunes_a_playbook_step_and_record_it_leaves_empty():
    tick = {"type": "playbook/updated", "playbookId": "uart", "stepId": "find", "patch": {"done": True}}
    undo = {**tick, "patch": {}, "unset": ["done"]}
    assert project_with(tick, undo)["playbooks"] == {}
    other = {**tick, "stepId": "wire"}
    assert project_with(other, tick, undo)["playbooks"] == {"uart": {"steps": {"wire": {"done": True}}}}


def test_a_patch_with_nothing_left_still_keeps_an_empty_step_without_unset():
    """Only an undo prunes; ordinary events keep the journal's existing meaning."""
    reset = {"type": "playbook/updated", "playbookId": "uart", "stepId": "find", "patch": {}}
    assert project_with(reset)["playbooks"] == {"uart": {"steps": {"find": {}}}}


def test_at_puts_an_item_back_in_its_place():
    project = project_with(h.add_asset(id="img_a"), h.add_asset(id="img_b", path="assets/b.jpg"),
                           {**h.add_asset(id="img_c", path="assets/c.jpg"), "at": 0},
                           h.add_marker("mk_a", "img_a", "sch_a"),
                           {**h.add_marker("mk_b", "img_a", "sch_b"), "at": 0, "schematicAt": 0})
    assert [a["id"] for a in project["assets"]] == ["img_c", "img_a", "img_b"]
    assert [m["id"] for m in project["markers"]] == ["mk_b", "mk_a"]
    assert [s["id"] for s in project["schematics"]] == ["sch_b", "sch_a"]


@pytest.mark.parametrize("value", [-1, True, 1.5, "0", 1_000_001])
def test_at_must_be_a_whole_number_in_range(value):
    with pytest.raises(EventError):
        validate_event({**h.add_asset(), "at": value})


def test_schematic_at_needs_a_schematic():
    with pytest.raises(EventError):
        validate_event({**h.add_marker(with_schematic=False), "schematicAt": 0})


def test_at_past_the_end_is_a_conflict(tmp_path):
    board = Board.create(tmp_path / "b", "Nimbus")
    try:
        board.apply(h.add_asset(), "web")
        with pytest.raises(EventConflict):
            board.apply({**h.add_asset(id="img_b", path="assets/b.jpg"), "at": 2}, "web")
        board.apply({**h.add_asset(id="img_b", path="assets/b.jpg"), "at": 1}, "web")
        with pytest.raises(EventConflict):
            board.apply({**h.add_marker("mk_a", "img_a", "sch_a"), "schematicAt": 1}, "web")
        assert [a["id"] for a in board.project["assets"]] == ["img_a", "img_b"]
    finally:
        board.close()


def test_a_removed_photo_comes_back_with_its_marks_in_one_batch(tmp_path):
    """The batch undo writes for a photo removal: the same ids are accepted again, step by step."""
    board = Board.create(tmp_path / "b", "Nimbus")
    try:
        for event in (h.add_asset(), h.add_asset(id="img_b", path="assets/b.jpg"), h.add_marker()):
            board.apply(event, "web")
        before = board.project
        board.apply({"type": "asset/removed", "id": "img_a"}, "web")
        board.apply({"type": "board/batch", "events": [
            {"type": "asset/added", "asset": before["assets"][0], "at": 0},
            {"type": "marker/added", "marker": before["markers"][0], "schematic": before["schematics"][0], "at": 0, "schematicAt": 0},
        ]}, "web")
        after = {**board.project, "meta": {**board.project["meta"], "modified": before["meta"]["modified"]}}
        assert after == before
    finally:
        board.close()


UNDOABLE = [
    {"type": "project/metaUpdated", "patch": {"device": "router", "flavour": "new key"}},
    {"type": "asset/updated", "id": "img_b", "patch": {"label": "Back"}},
    h.add_asset(id="img_d", path="assets/d.jpg"),
    {"type": "marker/updated", "id": "mk_a", "patch": {"x": 99, "label": "J2"}},
    {"type": "schematic/updated", "id": "sch_a", "patch": {"rows": 2, "connector": "JST"}},
    h.pin("sch_a", 2, {"role": "TX"}),
    {"type": "pin/readingAdded", "schematicId": "sch_a", "index": 2, "reading": {"mode": "voltage", "value": 3.3}},
    h.pin("sch_a", 2, None),
    {"type": "annotation/added", "annotation": {"id": "an_9", "assetId": "img_b", "x": 1, "y": 1, "lx": 9, "ly": 9, "text": "", "wiki": ""}},
    {"type": "annotation/updated", "id": "an_1", "patch": {"text": "R2", "wiki": "spi-flash"}},
    {"type": "annotation/removed", "id": "an_1"},
    {"type": "playbook/updated", "playbookId": "spi", "stepId": "chip", "patch": {"done": True}},
    {"type": "marker/removed", "id": "mk_b"},
    {"type": "board/batch", "events": [
        {"type": "asset/updated", "id": "img_b", "patch": {"path": "assets/b2.jpg", "width": 800, "height": 1000, "rotation": 90}},
        {"type": "marker/updated", "id": "mk_c", "patch": {"x": 700}},
    ]},
    {"type": "asset/removed", "id": "img_a"},
    h.add_marker("mk_z", "img_b", "sch_z"),
]


def settled(project):
    """Without meta.modified; no callouts or playbook progress reads the same as empty ones."""
    return {**project, "meta": {k: v for k, v in project["meta"].items() if k != "modified"},
            "annotations": project.get("annotations", []), "playbooks": project.get("playbooks", {})}


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the app code")
def test_the_service_stores_every_undo_and_redo_the_app_builds(tmp_path):
    """Each change, then the app's undo of it, then the undo of that undo, through the real validator."""
    board = Board.create(tmp_path / "b", "Nimbus")
    try:
        for event in (h.add_asset(), h.add_asset(id="img_b", path="assets/b.jpg"), h.add_asset(id="img_c", path="assets/c.jpg"),
                      h.add_marker("mk_a", "img_a", "sch_a"), h.add_marker("mk_b", "img_b", "sch_b"),
                      {"type": "marker/added", "marker": h.marker("mk_c", "img_b", "sch_a")},
                      {"type": "annotation/added", "annotation": {"id": "an_1", "assetId": "img_a", "x": 1, "y": 1, "lx": 9, "ly": 9, "text": "R1"}},
                      {"type": "components/replaced", "components": [{"id": "cmp_1", "assetId": "img_a", "x": 1, "y": 1, "w": 2, "h": 2}]}):
            board.apply(event, "web")
        for change in UNDOABLE:
            before = board.project
            board.apply(change, "web")
            after = board.project
            [back] = node({"mode": "inverse", "initial": [before], "events": [change]})
            board.apply(back, "web")
            assert settled(board.project) == settled(before), f"undo of {change['type']}"
            [again] = node({"mode": "inverse", "initial": [after], "events": [back]})
            board.apply(again, "web")
            assert settled(board.project) == settled(after), f"redo of {change['type']}"
    finally:
        board.close()
