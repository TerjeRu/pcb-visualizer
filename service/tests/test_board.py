import json

import pytest

from pcbv.board import CACHE_DIR, JOURNAL_REL, SNAPSHOT_HASH_FILE, Board, replay
from pcbv.events import EventConflict, EventError
from pcbv.journal import read_journal
from pcbv.schema import DEFAULT_PROJECT_FILE, serialize_project

import helpers as h


def snapshot_bytes(board):
    return (board.directory / DEFAULT_PROJECT_FILE).read_bytes()


def journal_bytes(board):
    return (board.directory / JOURNAL_REL).read_bytes()


def test_new_board_layout_and_snapshot_format(board):
    for sub in ("assets", "journal", CACHE_DIR):
        assert (board.directory / sub).is_dir()
    text = snapshot_bytes(board).decode()
    assert text == serialize_project(board.project)
    assert text.endswith("}\n") and text.splitlines()[1] == '  "format": "pcb-visualizer-project",'
    assert board.seq == 1 and board.project["meta"]["name"] == "Test board"


def test_snapshot_and_live_state_always_equal_a_replay_of_the_journal(seeded):
    seeded.apply(h.pin("sch_a", 2, {"role": "TX"}), "cli")
    seeded.apply({"type": "marker/updated", "id": "mk_a", "patch": {"x": 55}}, "web")
    seeded.apply({"type": "project/metaUpdated", "patch": {"device": "Nimbus"}}, "agent")

    events = read_journal(seeded.directory / JOURNAL_REL).events
    assert replay(events) == seeded.project
    assert json.loads(snapshot_bytes(seeded)) == seeded.project
    assert seeded.project["meta"]["modified"] == events[-1]["ts"]
    assert [e["actor"] for e in events[-3:]] == ["cli", "web", "agent"]


def test_a_photo_label_has_at_most_80_characters(seeded):
    seeded.apply({"type": "asset/updated", "id": "img_a", "patch": {"label": "x" * 80}}, "web")
    assert seeded.project["assets"][0]["label"] == "x" * 80
    for label in ("x" * 81, 5):
        with pytest.raises(EventError, match="label"):
            seeded.apply({"type": "asset/updated", "id": "img_a", "patch": {"label": label}}, "web")
    assert seeded.project["assets"][0]["label"] == "x" * 80


@pytest.mark.parametrize("bad, error", [
    ("not an object", EventError),
    ({"type": "firmware/dumped"}, EventError),
    ({"type": "project/replaced", "project": {}}, EventError),       # internal events are not client events
    ({"type": "asset/added"}, EventError),
    ({"type": "asset/added", "asset": h.asset(path="assets/../../etc/passwd")}, EventError),
    ({"type": "asset/added", "asset": h.asset(path="/etc/passwd")}, EventError),
    ({"type": "asset/added", "asset": h.asset(path="other/a.jpg")}, EventError),
    ({"type": "asset/added", "asset": h.asset(path="assets/a\\b.jpg")}, EventError),
    ({"type": "asset/added", "asset": h.asset(path="assets/")}, EventError),
    ({"type": "asset/added", "asset": h.asset(path="assets//a.jpg")}, EventError),
    ({"type": "asset/updated", "id": "img_a", "patch": {"path": "../outside.jpg"}}, EventError),
    ({"type": "asset/updated", "id": "img_a", "patch": {"id": "img_z"}}, EventError),
    ({"type": "project/metaUpdated", "patch": {"id": "prj_other"}}, EventError),
    ({"type": "project/metaUpdated", "patch": {"created": "1970-01-01T00:00:00.000Z"}}, EventError),
    ({"type": "marker/updated", "id": "mk_a", "patch": "x=5"}, EventError),
    ({"type": "marker/added", "marker": h.marker("mk_x"), "schematic": h.schematic("sch_other")}, EventError),
    (h.pin("sch_a", 0, {"role": "TX"}), EventError),
    (h.pin("sch_a", True, {"role": "TX"}), EventError),
    (h.pin("sch_a", 1, {"index": 9}), EventError),
    ({"type": "components/replaced", "components": ["nope"]}, EventError),
    ({"type": "asset/updated", "id": "img_a", "patch": {"label": "x" * 1_100_000}}, EventError),
    (h.add_asset(), EventConflict),                                  # duplicate id
    (h.add_marker("mk_a"), EventConflict),                           # duplicate marker id
    (h.add_marker("mk_new", asset_id="img_missing", schematic_id="sch_new"), EventConflict),
    ({"type": "marker/added", "marker": h.marker("mk_new", schematic_id="sch_missing")}, EventConflict),
    ({"type": "marker/updated", "id": "mk_missing", "patch": {"x": 1}}, EventConflict),
    ({"type": "marker/updated", "id": "mk_a", "patch": {"assetId": "img_missing"}}, EventConflict),
    ({"type": "marker/removed", "id": "mk_missing"}, EventConflict),
    ({"type": "asset/removed", "id": "img_missing"}, EventConflict),
    ({"type": "schematic/updated", "id": "sch_missing", "patch": {}}, EventConflict),
    (h.pin("sch_missing", 1, {"role": "TX"}), EventConflict),
])
def test_rejected_events_change_nothing_on_disk_or_in_memory(seeded, bad, error):
    journal, snapshot, project, seq = journal_bytes(seeded), snapshot_bytes(seeded), seeded.project, seeded.seq
    with pytest.raises(error):
        seeded.apply(bad, "test")
    assert journal_bytes(seeded) == journal
    assert snapshot_bytes(seeded) == snapshot
    assert seeded.project == project and seeded.seq == seq


@pytest.mark.parametrize("actor", ["", "UPPER", "has space", "x" * 33, "../etc", None, 7])
def test_actor_names_are_restricted(seeded, actor):
    with pytest.raises(EventError):
        seeded.apply({"type": "project/metaUpdated", "patch": {"notes": "x"}}, actor)


def test_notes_have_a_size_limit(seeded):
    seeded.apply({"type": "project/metaUpdated", "patch": {"notes": "n" * 100_000}}, "test")
    seq, notes = seeded.seq, seeded.project["meta"]["notes"]
    with pytest.raises(EventError, match="100000 characters"):
        seeded.apply({"type": "project/metaUpdated", "patch": {"notes": "n" * 100_001}}, "test")
    assert seeded.seq == seq and seeded.project["meta"]["notes"] == notes


def test_client_cannot_inject_envelope_fields(seeded):
    stored = seeded.apply({"type": "project/metaUpdated", "patch": {"notes": "n"},
                           "seq": 1, "ts": "1999-01-01T00:00:00.000Z", "actor": "root", "extra": 1}, "test")
    assert stored["seq"] == seeded.seq and stored["ts"] != "1999-01-01T00:00:00.000Z"
    assert stored["actor"] == "test" and "extra" not in stored


def test_reopening_resumes_at_the_next_sequence_number(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    b.apply(h.add_asset(), "test")
    state, seq = b.project, b.seq
    b.close()
    again = Board.open(tmp_path / "b")
    try:
        assert again.project == state and again.seq == seq
        assert again.apply(h.add_asset(id="img_b", path="assets/b.jpg"), "test")["seq"] == seq + 1
    finally:
        again.close()


def test_edit_found_on_reopen_is_preserved_without_guessing(tmp_path):
    """The browser app can still write project.pcb.json directly. That work must never be overwritten."""
    b = Board.create(tmp_path / "b", "B")
    b.apply(h.add_asset(), "test")
    path = b.directory / DEFAULT_PROJECT_FILE
    b.close()
    edited = json.loads(path.read_text())
    edited["meta"]["name"] = "Renamed in the browser"
    edited["assets"][0]["label"] = "front photo"
    path.write_text(json.dumps(edited, indent=2) + "\n")

    first = Board.open(tmp_path / "b")
    try:
        assert first.project["meta"]["name"] == "B"
        assert first.seq == 2
        relative = first.warning_details["external_edit_preserved"]["path"]
        assert json.loads((first.directory / relative).read_bytes()) == edited
        seq = first.seq
    finally:
        first.close()
    second = Board.open(tmp_path / "b")
    try:
        assert second.seq == seq and not second.warnings, "an edit is recorded once, not on every start"
    finally:
        second.close()


def test_interrupted_snapshot_write_is_refreshed_and_not_mistaken_for_an_edit(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    snap_path = b.directory / DEFAULT_PROJECT_FILE
    hash_path = b.directory / CACHE_DIR / SNAPSHOT_HASH_FILE
    old_snapshot, old_hash = snap_path.read_bytes(), hash_path.read_bytes()
    b.apply(h.add_asset(), "test")        # journal now ahead of the snapshot
    state, seq = b.project, b.seq
    b.close()
    snap_path.write_bytes(old_snapshot)   # the crash: journal written, snapshot not
    hash_path.write_bytes(old_hash)

    again = Board.open(tmp_path / "b")
    try:
        assert again.seq == seq, "no spurious external-edit event"
        assert again.project == state
        assert json.loads(snap_path.read_text()) == state
    finally:
        again.close()


@pytest.mark.parametrize("content", [
    b"{ this is not json",
    b"[]",
    json.dumps({"format": "something-else"}).encode(),
])
def test_unreadable_or_foreign_snapshot_is_set_aside_not_destroyed(tmp_path, content):
    b = Board.create(tmp_path / "b", "B")
    state = b.project
    path = b.directory / DEFAULT_PROJECT_FILE
    b.close()
    path.write_bytes(content)

    again = Board.open(tmp_path / "b")
    try:
        assert again.project == state
        asides = list(again.directory.glob(".pcbv/recovery/snapshot-*.json"))
        assert len(asides) == 1 and asides[0].read_bytes() == content
        assert json.loads(path.read_text()) == state
    finally:
        again.close()


def test_missing_snapshot_is_rebuilt(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    b.apply(h.add_asset(), "test")
    state, path = b.project, b.directory / DEFAULT_PROJECT_FILE
    b.close()
    path.unlink()
    again = Board.open(tmp_path / "b")
    try:
        assert json.loads(path.read_text()) == state and again.seq == 2
    finally:
        again.close()


def test_edit_made_while_the_service_is_running_is_not_overwritten_by_the_next_event(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    try:
        b.apply(h.add_asset(), "web")
        path = b.directory / DEFAULT_PROJECT_FILE
        edited = json.loads(path.read_text())
        edited["meta"]["name"] = "Renamed by the browser app"
        path.write_text(json.dumps(edited, indent=2) + "\n")

        stored = b.apply({"type": "project/metaUpdated", "patch": {"notes": "service wrote this"}}, "cli")

        assert b.project["meta"]["name"] == "Renamed by the browser app"
        assert b.project["meta"]["notes"] == "service wrote this"
        assert json.loads(path.read_text()) == b.project
        types = [(e["type"], e["actor"]) for e in b.events]
        assert types[-2:] == [("project/replaced", "external"), ("project/metaUpdated", "cli")]
        assert stored["seq"] == b.seq
        assert replay(read_journal(b.directory / JOURNAL_REL).events) == b.project
    finally:
        b.close()


def test_a_rejected_event_does_not_hide_an_outside_edit(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    try:
        path = b.directory / DEFAULT_PROJECT_FILE
        edited = json.loads(path.read_text())
        edited["meta"]["device"] = "Edited outside"
        path.write_text(json.dumps(edited) + "\n")
        with pytest.raises(EventConflict):
            b.apply({"type": "asset/removed", "id": "img_missing"}, "cli")
        assert b.project["meta"]["device"] == "Edited outside"      # kept, and journaled
        assert b.events[-1]["type"] == "project/replaced"
    finally:
        b.close()


def test_snapshot_destroyed_while_running_is_set_aside_and_rebuilt_on_the_next_event(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    try:
        b.apply(h.add_asset(), "web")
        before = b.project
        path = b.directory / DEFAULT_PROJECT_FILE
        path.write_text("{ half a file")
        b.apply({"type": "project/metaUpdated", "patch": {"notes": "n"}}, "cli")
        assert b.project["assets"] == before["assets"]
        assert json.loads(path.read_text()) == b.project
        assert len(list(b.directory.glob(".pcbv/recovery/snapshot-*.json"))) == 1
    finally:
        b.close()
