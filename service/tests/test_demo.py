import json

from pcbv import cli
from pcbv.board import inspect_board


def test_demo_board_is_complete_and_consistent(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "boards"
    assert cli.main(["--root", str(root), "demo"]) == 0
    board = root / "demo-router"
    assert inspect_board(board)["snapshot"] == "in-sync"
    project = json.loads((board / "project.pcb.json").read_text())
    assert [m["label"] for m in project["markers"]] == ["J4", "JP1", "TP7"]
    uart = project["schematics"][0]
    assert [p["role"] for p in uart["pins"]] == ["3V3", "TX", "RX", "GND"]
    assert len(project["annotations"]) == 3 and project["playbooks"]["open-and-photograph"]["steps"]["chips"]["done"]
    serial, logic = project["captures"]
    assert "bootloader" in serial["seen"] and (board / serial["path"]).read_bytes().startswith(b"\r\nU-Boot")
    assert logic["kind"] == "logic" and (board / logic["path"]).read_bytes()[:2] == b"PK"
    assert (board / project["assets"][0]["path"]).is_file()
    assert "pcbv open demo-router" in capsys.readouterr().out


def test_demo_does_not_overwrite(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "boards"
    assert cli.main(["--root", str(root), "demo"]) == 0
    assert cli.main(["--root", str(root), "demo"]) == 1
    assert "already exists" in capsys.readouterr().err
