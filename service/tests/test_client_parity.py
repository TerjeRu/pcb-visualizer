"""The front end keeps its own copy of the project by applying the service's events.
That copy must equal the service's state, or the UI would show something the files do not contain.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from pcbv.board import JOURNAL_REL, Board
from pcbv.events import EventConflict
from pcbv.journal import read_journal
from pcbv.reducer import apply_event
from pcbv.schema import DEFAULT_PROJECT_FILE, create_project

import helpers as h

RUNNER = Path(__file__).with_name("client_runners.mjs")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the app code")


def node(payload):
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps(payload), capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_app_reducer_matches_the_service_reducer_after_every_event():
    initial = create_project("Parity", now="2026-10-25T10:00:00.000Z")
    events = h.script()
    from_app = node({"mode": "reduce", "initial": initial, "events": events})
    project = initial
    for step, (event, theirs) in enumerate(zip(events, from_app, strict=True), start=1):
        project = apply_event(project, event)
        assert project == theirs, f"step {step} ({event['type']}) differs between service and app"


def test_script_exercises_the_cascades_it_claims_to():
    """Guards the guard: if the script stopped hitting these paths the parity test would prove little."""
    states, project = [], create_project("Parity", now="2026-10-25T10:00:00.000Z")
    for event in h.script():
        project = apply_event(project, event)
        states.append(project)
    after_shared_marker_removed, after_last_marker_removed, final = states[-3], states[-2], states[-1]
    assert [s["id"] for s in after_shared_marker_removed["schematics"]] == ["sch_1", "sch_2"]
    assert [s["id"] for s in after_last_marker_removed["schematics"]] == ["sch_1"]
    assert final["assets"][0]["id"] == "img_b"
    assert final["markers"] == [] and final["schematics"] == [] and final["components"][0]["id"] == "cmp_2"
    pins = {p["index"]: p for p in states[10]["schematics"][0]["pins"]}
    assert sorted(pins) == [1, 3, 4] and pins[4]["custom"] == "kept"


def test_the_app_rebuilds_exactly_the_state_the_service_holds(tmp_path):
    """A real journal, including an outside edit and a rejected event, replayed by the app code."""
    board = Board.create(tmp_path / "b", "Nimbus")
    try:
        board.apply(h.add_asset(id="img_a", path="assets/a.jpg"), "web")
        board.apply(h.add_marker("mk_a", "img_a", "sch_a"), "web")
        board.apply(h.pin("sch_a", 3, {"role": "TX", "label": "TX"}), "cli")
        board.apply(h.pin("sch_a", 1, {"role": "GND"}), "agent")
        board.apply({"type": "project/metaUpdated", "patch": {"device": "Acme"}}, "web")
        # an edit made outside the service, picked up before the next event
        path = board.directory / DEFAULT_PROJECT_FILE
        edited = json.loads(path.read_text())
        edited["meta"]["notes"] = "typed into the file by hand"
        path.write_text(json.dumps(edited, indent=2) + "\n")
        board.apply({"type": "marker/updated", "id": "mk_a", "patch": {"x": 77}}, "web")
        with pytest.raises(EventConflict):
            board.apply(h.add_asset(id="img_a"), "web")           # rejected, must leave no trace
        board.apply({"type": "marker/removed", "id": "mk_a"}, "web")
        expected = board.project
    finally:
        board.close()

    events = read_journal(tmp_path / "b" / JOURNAL_REL).events
    assert "project/replaced" in [e["type"] for e in events]
    assert node({"mode": "replay", "events": events}) == expected


def test_app_refuses_an_event_it_does_not_know_instead_of_guessing(tmp_path):
    board = Board.create(tmp_path / "b", "B")
    events = list(board.events)
    board.close()
    events.append({"seq": 2, "ts": "2026-10-25T10:00:00.000Z", "actor": "x", "type": "firmware/dumped"})
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps({"mode": "replay", "events": events}),
                            capture_output=True, text=True, timeout=30)
    assert result.returncode != 0 and "unknown event type" in result.stderr


def test_an_outside_edit_keeps_the_modified_time_the_editor_wrote(tmp_path):
    board = Board.create(tmp_path / "b", "B")
    try:
        board.apply(h.add_asset(), "web")
        path = board.directory / DEFAULT_PROJECT_FILE
        edited = json.loads(path.read_text())
        edited["meta"]["name"] = "Renamed in an editor"
        edited["meta"]["modified"] = "2020-01-01T00:00:00.000Z"
        path.write_text(json.dumps(edited, indent=2) + "\n")
        with pytest.raises(EventConflict):
            board.apply(h.add_asset(), "web")
        expected = board.project
        events = list(board.events)
        assert events[-1]["type"] == "project/replaced"
        assert expected["meta"]["modified"] == "2020-01-01T00:00:00.000Z"
        assert node({"mode": "replay", "events": events}) == expected
    finally:
        board.close()


def test_reopen_preserves_ambiguous_edit_and_replays_identically(tmp_path):
    with Board.create(tmp_path / "b", "B") as board:
        expected, events = board.project, list(board.events)
        path = board.directory / DEFAULT_PROJECT_FILE
    edited = {**expected, "meta": {**expected["meta"], "name": "outside edit"}}
    path.write_text(json.dumps(edited))
    with Board.open(tmp_path / "b") as reopened:
        assert reopened.events == events
        assert reopened.project == node({"mode": "replay", "events": events}) == expected
        preserved = reopened.warning_details["external_edit_preserved"]["path"]
        assert json.loads((reopened.directory / preserved).read_bytes()) == edited


def playbook_script():
    return [
        {"type": "playbook/updated", "playbookId": "find-uart", "patch": {"started": "2026-10-25T10:00:00.000Z"}},
        {"type": "playbook/updated", "playbookId": "find-uart", "stepId": "ground", "patch": {"gates": {"unplugged": True}}},
        {"type": "playbook/updated", "playbookId": "find-uart", "stepId": "ground", "patch": {"done": "2026-10-25T10:05:00.000Z"}},
        {"type": "playbook/updated", "playbookId": "find-uart", "stepId": "ground", "patch": {"gates": {"unplugged": True, "meter": True}}},
        {"type": "playbook/updated", "playbookId": "open-and-photograph", "stepId": "chips", "patch": {"answers": {"soc": "ARC7621"}}},
        {"type": "playbook/updated", "playbookId": "find-uart", "patch": {"finished": None}},
    ]


def test_app_and_service_agree_on_playbook_progress():
    initial = create_project("Parity", now="2026-10-25T10:00:00.000Z")
    events = playbook_script()
    from_app = node({"mode": "reduce", "initial": initial, "events": events})
    project = initial
    for step, (event, theirs) in enumerate(zip(events, from_app, strict=True), start=1):
        project = apply_event(project, event)
        assert project == theirs, f"playbook step {step} differs between service and app"
    record = project["playbooks"]["find-uart"]
    assert record["steps"]["ground"] == {"gates": {"unplugged": True, "meter": True}, "done": "2026-10-25T10:05:00.000Z"}
    assert record["finished"] is None


def test_app_and_service_agree_on_annotations():
    initial = create_project("Parity", now="2026-10-25T10:00:00.000Z")
    note = {"id": "an_1", "assetId": "img_a", "x": 10, "y": 20, "lx": 80, "ly": -10, "text": "Flash", "wiki": "spi-flash"}
    events = [
        h.add_asset(id="img_a", path="assets/a.jpg"),
        h.add_asset(id="img_b", path="assets/b.jpg"),
        {"type": "annotation/added", "annotation": note},
        {"type": "annotation/added", "annotation": {**note, "id": "an_2", "assetId": "img_b", "text": "SoC"}},
        {"type": "annotation/updated", "id": "an_1", "patch": {"text": "Flash 25Q128", "lx": 90}},
        {"type": "asset/removed", "id": "img_b"},
        {"type": "annotation/removed", "id": "an_1"},
    ]
    from_app = node({"mode": "reduce", "initial": initial, "events": events})
    project = initial
    for step, (event, theirs) in enumerate(zip(events, from_app, strict=True), start=1):
        project = apply_event(project, event)
        assert project == theirs, f"annotation step {step} ({event['type']}) differs between service and app"
    assert project["annotations"] == []


def test_app_and_service_agree_on_captures():
    initial = create_project("Parity", now="2026-10-25T10:00:00.000Z")
    capture = {"id": "cap_1", "kind": "serial", "path": "captures/serial/a.log", "port": "/dev/ttyUSB0", "baud": 115200,
               "started": "2026-10-25T10:00:00.000Z"}
    events = [
        {"type": "capture/started", "capture": capture},
        {"type": "capture/started", "capture": {**capture, "id": "cap_2"}},
        {"type": "capture/updated", "id": "cap_1", "patch": {"seen": ["bootloader"]}},
        {"type": "capture/updated", "id": "cap_1", "patch": {"seen": ["autoboot", "bootloader"]}},
        {"type": "capture/stopped", "id": "cap_1", "patch": {"stopped": "2026-10-25T10:05:00.000Z", "bytes": 5120, "reason": "closed"}},
    ]
    from_app = node({"mode": "reduce", "initial": initial, "events": events})
    project = initial
    for step, (event, theirs) in enumerate(zip(events, from_app, strict=True), start=1):
        project = apply_event(project, event)
        assert project == theirs, f"capture step {step} differs between service and app"
    assert project["captures"][0]["bytes"] == 5120 and "stopped" not in project["captures"][1]


def test_batch_parity_uses_one_outer_timestamp(board):
    event = board.apply({'type': 'board/batch', 'events': [h.add_asset(), h.add_marker(), h.pin('sch_a', 1, {'role': 'TX'})]})
    assert board.project['meta']['modified'] == event['ts']
    assert node({'mode': 'replay', 'events': board.events}) == board.project


def test_reading_appends_match_client_even_with_interleaved_writers(seeded):
    from pcbv.edits import reading_event
    a, _, _ = reading_event(seeded.project, 'Header', 1, '1V', None)
    b, _, _ = reading_event(seeded.project, 'Header', 1, '2V', None)
    seeded.apply(a)
    seeded.apply(b)
    assert node({'mode': 'replay', 'events': seeded.events}) == seeded.project
    assert len(seeded.project['schematics'][0]['pins'][0]['readings']) == 2
