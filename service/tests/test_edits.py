import json
import urllib.request
from pathlib import Path

import pytest

from pcbv import cli
from pcbv.board import Board
from pcbv.edits import EditError, find_header, note_event, parse_reading, reading_event

from live_service import running_service


def project_with_j4():
    return {
        "meta": {"name": "Nimbus", "notes": "first line"},
        "assets": [{"id": "img_1", "path": "assets/photos/img_1.jpg"}],
        "markers": [{"id": "mk_1", "assetId": "img_1", "schematicId": "sch_1", "label": "J4"}],
        "schematics": [{"id": "sch_1", "name": "UART", "rows": 1, "cols": 4,
                        "pins": [{"index": 2, "role": "TX", "readings": [{"text": "old"}]}]}],
        "components": [],
    }


@pytest.mark.parametrize("text, mode, value, unit, shown", [
    ("3.29V", "dc", 3.29, "V", "3.29 V"),
    ("3,3 v", "dc", 3.3, "V", "3.3 V"),
    ("330mV", "dc", 0.33, "V", "0.33 V"),
    ("3.3", "dc", 3.3, "V", "3.3 V"),
    ("0.3ohm", "ohm", 0.3, "Ω", "0.3 Ω"),
    ("4.7k", "ohm", 4700, "Ω", "4.7 kΩ"),
    ("1.2MΩ", "ohm", 1_200_000, "Ω", "1.2 MΩ"),
    ("OL", "ohm", None, "Ω", "OL"),
    ("beep", "continuity", 0.0, "Ω", "beep"),
])
def test_readings_parse_the_way_a_meter_shows_them(text, mode, value, unit, shown):
    reading = parse_reading(text)
    assert (reading["mode"], reading["value"], reading["unit"], reading["text"]) == (mode, value, unit, shown)


READINGS = json.loads((Path(__file__).parent / "fixtures" / "readings.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", READINGS["parse"], ids=lambda case: repr(case["input"]))
def test_the_shared_reading_fixture_matches_the_parser(case):
    """app/tests/reading.test.mjs runs the same file through the app's parser."""
    if "error" in case:
        with pytest.raises(EditError) as raised:
            parse_reading(case["input"])
        assert str(raised.value) == case["error"]
    else:
        assert parse_reading(case["input"]) == case["expect"]


@pytest.mark.parametrize("case", READINGS["events"], ids=lambda case: f"{case['input']}-{case['powered']}")
def test_the_shared_fixture_matches_the_power_and_warnings(case):
    _, reading, warnings = reading_event(project_with_j4(), "J4", 1, case["input"], case["powered"])
    assert {"powered": reading["powered"], "warnings": warnings} == case["expect"]


@pytest.mark.parametrize("text", ["lots", "3.3A", "", "V"])
def test_unreadable_values_are_refused(text):
    with pytest.raises(EditError, match="cannot read"):
        parse_reading(text)


def test_headers_are_found_by_silkscreen_label_or_name():
    p = project_with_j4()
    assert find_header(p, "j4")["id"] == "sch_1"
    assert find_header(p, "uart")["id"] == "sch_1"
    with pytest.raises(EditError, match="Known: J4, UART"):
        find_header(p, "J9")


def test_a_reading_is_appended_to_the_pin_and_power_is_inferred():
    event, reading, warnings = reading_event(project_with_j4(), "J4", 2, "3.29V", None)
    assert event["type"] == "pin/readingAdded" and event["index"] == 2
    assert event["reading"]["text"] == "3.29 V"
    assert reading["powered"] is True and reading["source"] == "cli" and warnings == []
    _, reading, _ = reading_event(project_with_j4(), "J4", 4, "0.3ohm", None)
    assert reading["powered"] is False


def test_unsafe_combinations_warn():
    _, _, warnings = reading_event(project_with_j4(), "J4", 1, "2ohm", True)
    assert "unplugged" in warnings[0]
    _, _, warnings = reading_event(project_with_j4(), "J4", 1, "1.2V", False)
    assert "capacitor" in warnings[0]


def test_pin_numbers_outside_the_header_are_refused():
    with pytest.raises(EditError, match="J4 has pins 1 to 4"):
        reading_event(project_with_j4(), "J4", 5, "3V", None)


def test_notes_are_timestamped_lines_on_the_board_or_a_pin():
    board_note = note_event(project_with_j4(), "case has 4 screws")
    lines = board_note["patch"]["notes"].splitlines()
    assert lines[0] == "first line" and lines[1].startswith("- 20") and lines[1].endswith("case has 4 screws")
    pin_note = note_event(project_with_j4(), "flickers at boot", pin="J4:2")
    assert pin_note["type"] == "pin/updated" and pin_note["patch"]["note"].endswith("flickers at boot")
    with pytest.raises(EditError, match="HEADER:NUMBER"):
        note_event(project_with_j4(), "x", pin="J4")


@pytest.fixture
def board_with_j4(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "boards"
    board = Board.create(root / "nimbus", "Nimbus")
    board.apply({"type": "asset/added", "asset": {"id": "img_1", "kind": "image", "path": "assets/photos/img_1.jpg"}}, "test")
    board.apply({"type": "marker/added",
                 "marker": {"id": "mk_1", "assetId": "img_1", "schematicId": "sch_1", "shape": "box", "label": "J4", "x": 1, "y": 1, "w": 20, "h": 10},
                 "schematic": {"id": "sch_1", "kind": "header", "name": "UART", "rows": 1, "cols": 4, "pins": []}}, "test")
    board.close()
    return root


def test_cli_edits_the_board_folder_when_no_service_runs(board_with_j4, capsys):
    root = board_with_j4
    assert cli.main(["--root", str(root), "measure", "nimbus", "J4", "1", "3.31V"]) == 0
    assert "through the board folder" in capsys.readouterr().out
    assert cli.main(["--root", str(root), "note", "nimbus", "UART found"]) == 0
    with Board.open(root / "nimbus") as board:
        pin = board.project["schematics"][0]["pins"][0]
        assert pin["readings"][0]["text"] == "3.31 V"
        assert board.project["meta"]["notes"].endswith("UART found")
        assert board.events[-1]["actor"] == "cli"


def test_cli_takes_a_value_with_a_minus_sign_as_the_value(board_with_j4, capsys):
    root = board_with_j4
    assert cli.main(["--root", str(root), "measure", "nimbus", "J4", "1", "-5k"]) == 1
    assert capsys.readouterr().err == "pcbv: a resistance cannot be negative; write it like 0.3ohm or 4.7k\n"
    with Board.open(root / "nimbus") as board:
        assert board.project["schematics"][0]["pins"] == []
    assert cli.main(["--root", str(root), "measure", "nimbus", "J4", "1", "-3.3V", "--powered"]) == 0
    with Board.open(root / "nimbus") as board:
        assert board.project["schematics"][0]["pins"][0]["readings"][0]["text"] == "-3.3 V"


def test_cli_note_that_would_pass_the_notes_limit_is_refused(board_with_j4, capsys):
    root = board_with_j4
    with Board.open(root / "nimbus") as board:
        board.apply({"type": "project/metaUpdated", "patch": {"notes": "n" * 100_000}}, "test")
    assert cli.main(["--root", str(root), "note", "nimbus", "one more"]) == 1
    err = capsys.readouterr().err
    assert "notes longer than 100000 characters" in err and "Traceback" not in err


def test_cli_errors_are_one_line(board_with_j4, capsys):
    assert cli.main(["--root", str(board_with_j4), "measure", "nimbus", "J9", "1", "3V"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("pcbv: no header called 'J9'") and "Traceback" not in err


def test_cli_goes_through_a_running_service(board_with_j4, tmp_path, capsys):
    root = board_with_j4
    with running_service(root, tmp_path / "run") as (base, token, opener, _process):
        request = urllib.request.Request(f"{base}/api/boards/nimbus", headers={"X-PCBV-Protocol": "2", "Authorization": f"Bearer {token}"})
        opener.open(request).read()    # the service now holds the board's lock

        assert cli.main(["--root", str(root), "measure", "nimbus", "J4", "2", "3.29V"]) == 0
        assert "through the service" in capsys.readouterr().out
        assert cli.main(["--root", str(root), "measure", "nimbus", "J4", "9", "3V"]) == 1
        assert "J4 has pins 1 to 4" in capsys.readouterr().err

        state = json.load(opener.open(request))
        pin = state["project"]["schematics"][0]["pins"][0]
        assert pin["index"] == 2 and pin["readings"][0]["text"] == "3.29 V"
