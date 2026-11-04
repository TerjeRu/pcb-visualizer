import csv
import io
import json
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pytest
from PIL import Image
from starlette.testclient import TestClient

from pcbv import cli
from pcbv.board import Board
from pcbv.datarepo import git
from pcbv.demo import create_demo
from pcbv.export import ExportError, export_board, pin_layout
from pcbv.server import create_app

APP_SCHEMA = Path(__file__).resolve().parents[2] / "app" / "js" / "core" / "schema.js"
TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}
SECRET = "Kitchen2024!"
MAC = "00:1a:2b:3c:4d:5e"


def test_pin_layout_matches_the_app():
    cases = [{"rows": r, "cols": c, "numbering": n, "rotation": rot}
             for r, c in ((1, 4), (2, 7), (7, 2), (3, 2), (2, 5), (4, 1))
             for n in ("row", "column", "u") for rot in (0, 90, 180, 270)]
    script = (f"import {{ pinLayout }} from {json.dumps(APP_SCHEMA.as_uri())};"
              f"console.log(JSON.stringify({json.dumps(cases)}.map(pinLayout)));")
    js = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert [pin_layout(case) for case in cases] == js


@pytest.fixture
def demo(tmp_path):
    directory = create_demo(tmp_path / "boards")
    board = Board.open(directory)
    try:
        board.apply({"type": "project/metaUpdated", "patch": {"notes": f"wifi password: {SECRET} ethaddr {MAC}"}}, "test")
        sch = board.project["schematics"][0]["id"]
        board.apply({"type": "pin/updated", "schematicId": sch, "index": 1, "patch": {"note": f"router mac {MAC}"}}, "test")
    finally:
        board.close()
    return directory


def test_every_format_redacted_with_shared_stand_ins(demo, tmp_path):
    result = export_board(demo, tmp_path / "out")
    out = result.folder
    assert sorted(result.files) == sorted(["photo-1-front.png", "photo-1-front.svg", "pinouts.csv", "pinouts.json", "report.md", "board.zip"])

    report = (out / "report.md").read_text()
    assert "Redacted:" in report and SECRET not in report and MAC not in report
    assert "| 2 | TX | TX |" in report and "## Boot log" in report and "U-Boot 2015.07" in report
    stand_in = "02:00:00:00:00:01"
    assert stand_in in report

    with zipfile.ZipFile(out / "board.zip") as archive:
        names = archive.namelist()
        project = archive.read("demo-router/project.pcb.json").decode()
    assert "demo-router/REDACTION.md" in names and not any("originals" in n or ".pcbv" in n for n in names)
    assert SECRET not in project and stand_in in project, "the zip uses the report's stand-ins"

    rows = list(csv.DictReader(io.StringIO((out / "pinouts.csv").read_text())))
    assert len(rows) == 4 + 10 + 1 and rows[1]["role"] == "TX" and MAC not in json.dumps(rows)
    assert json.loads((out / "pinouts.json").read_text())[1]["role"] == "TX"

    with Image.open(out / "photo-1-front.png") as image:
        assert image.size == (1600, 1000) and not image.getexif()
    svg = ElementTree.parse(out / "photo-1-front.svg").getroot()
    assert not [e for e in svg.iter() if e.tag.endswith("script")]
    assert "1 3V3 · 2 TX · 3 RX · 4 GND" in (out / "photo-1-front.svg").read_text()
    assert result.counts["mac"] == 1 and result.counts["credential"] == 1 and result.photos_to_check == 1


def test_unredacted_export_says_so(demo, tmp_path):
    result = export_board(demo, tmp_path / "out", ["report", "zip"], redact=False)
    report = (result.folder / "report.md").read_text()
    assert "**Not redacted**" in report and SECRET in report
    with zipfile.ZipFile(result.folder / "board.zip") as archive:
        assert "demo-router/REDACTION.md" not in archive.namelist()


def test_unsafe_targets_and_formats_are_refused(demo, tmp_path, monkeypatch):
    with pytest.raises(ExportError, match="inside the board folder"):
        export_board(demo, demo / "out")
    with pytest.raises(ExportError, match="formats"):
        export_board(demo, tmp_path / "a", ["pdf"])
    (tmp_path / "taken").mkdir()
    with pytest.raises(ExportError, match="already exists"):
        export_board(demo, tmp_path / "taken")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    git(tmp_path, "init", "-q")
    with pytest.raises(ExportError, match="data repo"):
        export_board(demo, tmp_path / "in-repo")


def test_api_and_cli(demo, tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("PCBV_EXPORT_DIR", str(tmp_path.parent / f"{tmp_path.name}-exports"))
    with TestClient(create_app(demo.parent, TOKEN), base_url="http://localhost:8765") as client:
        assert client.post("/api/boards/demo-router/export", json={}).status_code == 401
        answer = client.post("/api/boards/demo-router/export", json={"formats": ["csv"], "redact": True}, headers=AUTH)
        assert answer.status_code == 200 and answer.json()["files"] == ["pinouts.csv"]
        assert Path(answer.json()["folder"]).is_dir()
        assert client.post("/api/boards/demo-router/export", json={"formats": "csv"}, headers=AUTH).status_code == 422
    assert cli.main(["--root", str(demo.parent), "export", "demo-router", "--format", "report",
                     "--out", str(tmp_path.parent / f"{tmp_path.name}-cli")]) == 0
    assert "report.md" in capsys.readouterr().out


@pytest.mark.filterwarnings("ignore::PIL.Image.DecompressionBombWarning")
def test_an_oversized_photo_is_refused_with_an_export_error(tmp_path):
    from pcbv.export import annotated_png, annotated_svg
    for width in (15000, 25000):                      # past the limit, and past twice the limit
        big = tmp_path / f"big{width}.png"
        Image.new("1", (width, 10000)).save(big, "PNG")
        for render in (annotated_png, annotated_svg):
            with pytest.raises(ExportError, match=big.name):
                render(big, [])


def test_the_report_keeps_assistant_findings_apart_from_the_persons_own():
    from pcbv.export import _split_findings

    text = ("# Findings\n\n## My note\n\nBaud is 115200.\n\n"
            "## Assistant finding (unverified): UART\n\n_Written by the bench assistant (tutor, m)._\n\nLooks like TX.\n")
    own, assistant = _split_findings(text)
    assert own == "## My note\n\nBaud is 115200."
    assert assistant.startswith("### Assistant finding (unverified): UART") and "Looks like TX." in assistant
    assert _split_findings("# Findings\n\n## Assistant finding (unverified): X\n\nt\n")[0] == ""
    assert _split_findings("") == ("", "")


KEY_LINES = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
             "VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu",
             "ictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSn"]
KEY = "\n".join(["-----BEGIN PRIVATE KEY-----", *KEY_LINES, "-----END PRIVATE KEY-----"])


def _boot_log_with_key(demo, before: int, after: int) -> None:
    log = [f"boot line {n}" for n in range(before)] + [KEY] + [f"later line {n}" for n in range(after)]
    (demo / "captures" / "serial" / "demo-boot.log").write_text("\n".join(log) + "\n", encoding="utf-8")


def _assert_no_key(report: str) -> None:
    assert "BEGIN" not in report and "END PRIVATE" not in report
    assert not [line for line in KEY_LINES if line in report]


def test_the_report_boot_log_redacts_a_private_key_whole(demo, tmp_path):
    _boot_log_with_key(demo, 3, 3)
    report = (export_board(demo, tmp_path / "out", ["report"]).folder / "report.md").read_text()
    assert "[PEM-BLOCK-1]" in report and "boot line 2" in report and "later line 0" in report
    _assert_no_key(report)


def test_the_report_boot_log_redacts_a_key_cut_by_the_line_limit(demo, tmp_path):
    from pcbv.export import REPORT_LOG_LINES

    _boot_log_with_key(demo, REPORT_LOG_LINES - 2, 20)
    report = (export_board(demo, tmp_path / "out", ["report"]).folder / "report.md").read_text()
    _assert_no_key(report)
    assert "[PEM-BLOCK-1]" in report and f"first {REPORT_LOG_LINES} of {REPORT_LOG_LINES - 2 + 1 + 20} lines" in report


def test_unredacted_zip_keeps_private_key_blocks(demo, tmp_path):
    key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----"
    (demo / "captures").mkdir(exist_ok=True)
    (demo / "captures" / "dump.log").write_text(f"one\n{key}\ntwo\n", encoding="utf-8")
    result = export_board(demo, tmp_path / "out", ["zip"], redact=False)
    with zipfile.ZipFile(result.folder / "board.zip") as archive:
        data = archive.read(f"{demo.name}/captures/dump.log").decode()
    assert data == f"one\n{key}\ntwo\n"
