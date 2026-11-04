"""The journal is the source of truth, so how it fails matters more than how it succeeds."""
import json

import pytest

from pcbv.board import JOURNAL_REL, Board, BoardLocked, replay
from pcbv.journal import JournalError, read_journal

import helpers as h


def journal_path(board_dir):
    return board_dir / JOURNAL_REL


def test_crash_mid_write_is_repaired_and_no_acknowledged_event_is_lost(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    b.apply(h.add_asset(), "test")
    b.close()
    path = journal_path(tmp_path / "b")
    intact = path.read_bytes()
    path.write_bytes(intact + b'{"seq":3,"ts":"2026-10-25T10:00:00.000Z","actor":"te')  # power cut mid-line

    read = read_journal(path)
    assert read.torn_tail and len(read.events) == 2

    reopened = Board.open(tmp_path / "b")
    try:
        assert reopened.seq == 2
        assert any("incomplete line" in w for w in reopened.warnings)
        assert path.read_bytes() == intact, "repair must cut exactly the torn bytes"
        reopened.apply(h.add_asset(id="img_b", path="assets/b.jpg"), "test")
    finally:
        reopened.close()
    assert [e["seq"] for e in read_journal(path).events] == [1, 2, 3]


def test_last_line_missing_only_its_newline_is_discarded(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    b.apply(h.add_asset(), "test")
    b.close()
    path = journal_path(tmp_path / "b")
    path.write_bytes(path.read_bytes().rstrip(b"\n"))

    reopened = Board.open(tmp_path / "b")
    try:
        assert reopened.seq == 1 and reopened.project["assets"] == []
    finally:
        reopened.close()
    assert path.read_bytes().endswith(b"\n")


@pytest.mark.parametrize("damage", ["garbage_middle", "gap", "duplicate", "reordered"])
def test_damage_before_the_last_line_is_never_guessed_around(tmp_path, damage):
    b = Board.create(tmp_path / "b", "B")
    b.apply(h.add_asset(), "test")
    b.apply(h.add_asset(id="img_b", path="assets/b.jpg"), "test")
    b.close()
    path = journal_path(tmp_path / "b")
    lines = path.read_text().splitlines()
    damaged = {
        "garbage_middle": [lines[0], "{not json", lines[2]],
        "gap": [lines[0], lines[2]],
        "duplicate": [lines[0], lines[1], lines[1], lines[2]],
        "reordered": [lines[0], lines[2], lines[1]],
    }[damage]
    path.write_text("\n".join(damaged) + "\n")
    before = path.read_bytes()

    with pytest.raises(JournalError):
        Board.open(tmp_path / "b")
    assert path.read_bytes() == before, "a damaged journal must not be modified"
    # the failed open must not leave the board locked
    with pytest.raises(JournalError):
        Board.open(tmp_path / "b")


def test_journal_must_start_with_project_created(tmp_path):
    event = {"seq": 1, "ts": "2026-10-25T10:00:00.000Z", "actor": "x", "type": "asset/added", "asset": h.asset()}
    with pytest.raises(JournalError, match="project/created"):
        replay([event])


def test_event_from_a_newer_service_version_fails_loudly(tmp_path):
    b = Board.create(tmp_path / "b", "B")
    b.close()
    path = journal_path(tmp_path / "b")
    future = {"seq": 2, "ts": "2026-10-25T10:00:00.000Z", "actor": "x", "type": "firmware/dumped"}
    path.write_text(path.read_text() + json.dumps(future) + "\n")
    with pytest.raises(JournalError, match="seq 2"):
        Board.open(tmp_path / "b")


def test_only_one_writer_per_board(tmp_path):
    first = Board.create(tmp_path / "b", "B")
    with pytest.raises(BoardLocked):
        Board.open(tmp_path / "b")
    first.close()
    Board.open(tmp_path / "b").close()
