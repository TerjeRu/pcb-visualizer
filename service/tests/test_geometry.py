import pytest

from pcbv.events import EventError, validate_event
from pcbv.geometry import MAX_TURN_CHILDREN, turn_box, turn_events, turn_point
from pcbv.reducer import apply_event

W, H = 400, 300


@pytest.mark.parametrize("turns, point, expected", [
    (1, (10, 20), (280, 10)),
    (-1, (10, 20), (20, 390)),
    (1, (0, 0), (300, 0)),
    (1, (W, H), (0, W)),
    (-1, (0, 0), (0, W)),
    (-1, (W, H), (H, 0)),
    (1, (-5, 310), (-10, -5)),          # markers may lie past an edge
])
def test_a_point_turns_with_the_photo(turns, point, expected):
    assert turn_point(*point, W, H, turns) == expected


def test_a_box_turns_and_swaps_its_sides():
    assert turn_box(10, 20, 40, 30, W, H, 1) == (250, 10, 30, 40)
    assert turn_box(10, 20, 40, 30, W, H, -1) == (20, 350, 30, 40)


@pytest.mark.parametrize("turns", [1, -1])
def test_four_turns_come_back_to_the_start(turns):
    x, y, w, h, width, height = 10, 20, 40, 30, W, H
    px, py = 7, 290
    for _ in range(4):
        x, y, w, h = turn_box(x, y, w, h, width, height, turns)
        px, py = turn_point(px, py, width, height, turns)
        width, height = height, width
    assert (x, y, w, h, px, py) == (10, 20, 40, 30, 7, 290)


def project():
    return {
        "meta": {}, "assets": [
            {"id": "img_a", "kind": "image", "path": "assets/photos/img_a.jpg", "label": "Top", "width": W, "height": H},
            {"id": "img_b", "kind": "image", "path": "assets/photos/img_b.jpg", "label": "Bottom", "width": W, "height": H},
        ],
        "markers": [
            {"id": "mk_1", "assetId": "img_a", "schematicId": "sch_1", "shape": "box", "x": 10, "y": 20, "w": 40, "h": 30},
            {"id": "mk_2", "assetId": "img_a", "schematicId": "sch_2", "shape": "crosshair", "x": 5, "y": 6},
            {"id": "mk_3", "assetId": "img_a", "schematicId": "sch_3", "shape": "box", "x": 1, "y": 2, "w": 10, "h": 10},
            {"id": "mk_4", "assetId": "img_b", "schematicId": "sch_3", "shape": "box", "x": 1, "y": 2, "w": 10, "h": 10},
            {"id": "mk_5", "assetId": "img_b", "schematicId": "sch_4", "shape": "box", "x": 1, "y": 2, "w": 10, "h": 10},
        ],
        "schematics": [
            {"id": "sch_1", "rows": 2, "cols": 3, "rotation": 270},
            {"id": "sch_2", "rows": 1, "cols": 1},
            {"id": "sch_3", "rows": 1, "cols": 4, "rotation": 0},
            {"id": "sch_4", "rows": 1, "cols": 4},
        ],
        "components": [
            {"id": "cmp_1", "assetId": "img_a", "bbox": [10, 20, 40, 30]},
            {"id": "cmp_2", "assetId": "img_a", "bbox": {"x": 10, "y": 20, "w": 40, "h": 30}},
            {"id": "cmp_3", "assetId": "img_b", "bbox": [10, 20, 40, 30]},
        ],
        "annotations": [
            {"id": "an_1", "assetId": "img_a", "x": 10, "y": 20, "lx": 30, "ly": 40, "text": "SoC"},
            {"id": "an_2", "assetId": "img_b", "x": 10, "y": 20, "lx": 30, "ly": 40, "text": "RAM"},
        ],
    }


def by_target(events):
    return {(e["type"], e.get("id")): e for e in events}


def test_a_right_turn_moves_everything_on_the_photo():
    events = by_target(turn_events(project(), "img_a", 1, "assets/photos/img_a-1.jpg"))
    assert events[("asset/updated", "img_a")]["patch"] == {
        "path": "assets/photos/img_a-1.jpg", "width": H, "height": W, "rotation": 90}
    assert events[("marker/updated", "mk_1")]["patch"] == {"x": 250, "y": 10, "w": 30, "h": 40}
    assert events[("marker/updated", "mk_2")]["patch"] == {"x": 294, "y": 5}
    assert events[("annotation/updated", "an_1")]["patch"] == {"x": 280, "y": 10, "lx": 260, "ly": 30}
    assert events[("schematic/updated", "sch_1")]["patch"] == {"rotation": 0}
    components = events[("components/replaced", None)]["components"]
    assert components[0]["bbox"] == [250, 10, 30, 40]
    assert components[1]["bbox"] == {"x": 250, "y": 10, "w": 30, "h": 40}
    assert components[2] == project()["components"][2]


def test_only_the_turned_photo_changes():
    events = by_target(turn_events(project(), "img_a", -1, "assets/photos/img_a-1.jpg"))
    targets = set(events)
    assert ("marker/updated", "mk_4") not in targets and ("marker/updated", "mk_5") not in targets
    assert ("annotation/updated", "an_2") not in targets
    assert ("schematic/updated", "sch_4") not in targets
    assert events[("schematic/updated", "sch_1")]["patch"] == {"rotation": 180}


def test_a_header_with_a_box_on_another_photo_keeps_its_grid():
    events = by_target(turn_events(project(), "img_a", 1, "assets/photos/img_a-1.jpg"))
    assert ("marker/updated", "mk_3") in events
    assert ("schematic/updated", "sch_3") not in events


def test_a_crosshair_header_keeps_its_grid():
    events = by_target(turn_events(project(), "img_a", 1, "assets/photos/img_a-1.jpg"))
    assert ("schematic/updated", "sch_2") not in events


def test_a_header_without_a_rotation_starts_from_zero():
    events = by_target(turn_events(project(), "img_b", -1, "assets/photos/img_b-1.jpg"))
    assert events[("schematic/updated", "sch_4")]["patch"] == {"rotation": 270}


def test_a_photo_without_components_sends_no_component_list():
    p = project()
    p["components"] = [c for c in p["components"] if c["assetId"] != "img_a"]
    assert ("components/replaced", None) not in by_target(turn_events(p, "img_a", 1, "assets/photos/img_a-1.jpg"))


def test_the_events_are_a_valid_batch_and_four_turns_restore_the_project():
    p = project()
    start = project()
    for n in range(4):
        children = turn_events(p, "img_a", 1, f"assets/photos/img_a-{n}.jpg")
        p = apply_event(p, validate_event({"type": "board/batch", "events": children}))
    asset = p["assets"][0]
    assert asset["rotation"] == 0 and (asset["width"], asset["height"]) == (W, H)
    assert p["markers"] == start["markers"]
    assert p["annotations"] == start["annotations"]
    assert p["components"] == start["components"]
    assert p["schematics"][0]["rotation"] == 270


def test_a_photo_that_needs_too_many_events_is_refused():
    p = project()
    p["annotations"] = [{"id": f"an_{n}", "assetId": "img_a", "x": 1, "y": 1, "lx": 2, "ly": 2, "text": ""}
                        for n in range(MAX_TURN_CHILDREN)]
    with pytest.raises(EventError, match="too many"):
        turn_events(p, "img_a", 1, "assets/photos/img_a-1.jpg")


def test_turns_must_be_one_step():
    for turns in (0, 2, -2, True):
        with pytest.raises(ValueError):
            turn_point(1, 1, W, H, turns)
