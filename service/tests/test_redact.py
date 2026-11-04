import json

import pytest
from PIL import Image, ImageCms

from pcbv import cli
from pcbv.board import Board
from pcbv.datarepo import git
from pcbv.redact import RedactError, Redactor, redact_board


def clean(text, custom=()):
    redactor = Redactor(custom=list(custom))
    out, kinds = redactor.text(text)
    return out, kinds


@pytest.mark.parametrize("line, secret", [
    ("wpa_psk=SuperSecret99", "SuperSecret99"),
    ("wl0_wpa_psk: 'hunter2hunter2'", "hunter2hunter2"),
    ("ppp_password = abcd1234", "abcd1234"),
    ("        option key 'MyWifiKey123'", "MyWifiKey123"),
    ("sip_auth_pass=\"voip-pass\"", "voip-pass"),
])
def test_credentials_are_replaced(line, secret):
    out, kinds = clean(line)
    assert secret not in out and "[SECRET-1]" in out and kinds == ["credential"]


@pytest.mark.parametrize("line", [
    "Password: ",
    "password: ********",
    "admin_password=<password>",
    "Please press Enter to activate this console.",
])
def test_prompts_and_masked_values_stay(line):
    assert clean(line) == (line, [])


def test_a_prompt_at_the_end_of_a_line_does_not_take_the_next_line():
    redactor = Redactor()
    out, _ = redactor.text("Password:\nBusyBox v1.24.1 built-in shell")
    assert "BusyBox" in out


def test_password_hashes_serials_and_email():
    out, kinds = clean("root:$1$abcd$0123456789abcdefghijkl:0:0 SerialNumber=LB4VRV12345 contact ops@isp.example.com")
    assert "$1$abcd" not in out and "LB4VRV12345" not in out and "ops@isp" not in out
    assert sorted(kinds) == ["email", "password-hash", "serial"]
    assert "user1@example.invalid" in out
    out, _ = clean("<SerialNumber> CP1234XYZ </SerialNumber> S/N: AB-99887766")
    assert "CP1234XYZ" not in out and "AB-99887766" not in out


def test_kernel_lines_that_look_like_serials_stay():
    for line in ("Serial: 8250/16550 driver, 2 ports, IRQ sharing disabled",
                 "serial8250: ttyS0 at MMIO 0x1e000c00 (irq = 33, base_baud = 3125000) is a 16550A"):
        assert clean(line) == (line, [])


def test_macs_keep_their_format_and_stand_in():
    redactor = Redactor()
    first, _ = redactor.text("ethaddr=00:1A:2B:3C:4D:5E wlan 00-1a-2b-3c-4d-5f")
    again, _ = redactor.text("eth0 address 00:1a:2b:3c:4d:5e")
    assert "00:1A:2B" not in first and "02:00:00:00:00:01".upper() in first
    assert "02-00-00-00-00-02" in first
    assert "02:00:00:00:00:01" in again, "the same MAC keeps its stand-in in any case"
    assert clean("bcast ff:ff:ff:ff:ff:ff")[1] == []
    assert "0200.0000.0001" in clean("cisco 0011.2233.4455")[0]


def test_public_addresses_go_and_private_ones_and_versions_stay():
    out, kinds = clean("wan 81.166.12.34 lan 192.168.1.1 dns 10.0.0.1 Linux version 2.6.32.61 (gcc)")
    assert "81.166.12.34" not in out and "203.0.113." in out
    assert "192.168.1.1" in out and "10.0.0.1" in out and "2.6.32.61" in out
    assert kinds == ["ip"]
    out, kinds = clean("inet6 2a02:2121:30c:1::5/64 scope global, fe80::1/64 scope link, at 12:34:56")
    assert "2a02:2121" not in out and "2001:db8::1" in out and "fe80::1" in out and "12:34:56" in out


def test_custom_strings_go_first_and_whole():
    out, kinds = clean("label LB4-0001-ABC and LB4-0001", custom=["LB4-0001-ABC", "LB4-0001"])
    assert "LB4-0001" not in out and kinds.count("custom") == 2


@pytest.fixture
def board_dir(tmp_path):
    board = Board.create(tmp_path / "boards" / "nimbus", "Nimbus")
    board.apply({"type": "project/metaUpdated", "patch": {"notes": "wifi password: Kitchen2024!\nWAN 81.166.12.34"}}, "test")
    board.close()
    d = tmp_path / "boards" / "nimbus"
    (d / "captures" / "serial").mkdir(parents=True)
    (d / "captures" / "serial" / "boot.log").write_text(
        "U-Boot 2015.07\nethaddr=00:1a:2b:3c:4d:5e\nwpa_psk=SuperSecret99\nLabel LB4-77-XYZ\n", encoding="utf-8")
    (d / "captures" / "logic").mkdir(parents=True)
    (d / "captures" / "logic" / "boot.sr").write_bytes(b"PK\x03\x04raw samples")
    photos = d / "assets" / "photos"
    (photos / "originals").mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (40, 30), "green")
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"          # Make
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/">GPSLatitude 59.9</x:xmpmeta>'
    image.save(photos / "img_1.jpg", exif=exif.tobytes(), icc_profile=icc, xmp=xmp)
    image.save(photos / "originals" / "img_1.jpg", exif=exif.tobytes())
    (d / ".pcbv").mkdir(exist_ok=True)
    (d / ".pcbv" / "redact.txt").write_text("# from the label\nLB4-77-XYZ\n", encoding="utf-8")
    (d / "link.log").symlink_to("/etc/hostname")
    return d


def test_a_board_copy_is_redacted_and_the_board_is_untouched(board_dir, tmp_path):
    before = (board_dir / "captures" / "serial" / "boot.log").read_text()
    out = tmp_path / "share"
    report = redact_board(board_dir, out)
    assert (board_dir / "captures" / "serial" / "boot.log").read_text() == before

    log = (out / "captures" / "serial" / "boot.log").read_text()
    assert "SuperSecret99" not in log and "00:1a:2b" not in log and "LB4-77-XYZ" not in log
    assert "U-Boot 2015.07" in log

    project = json.loads((out / "project.pcb.json").read_text())
    assert "Kitchen2024" not in project["meta"]["notes"] and "81.166.12.34" not in project["meta"]["notes"]
    for line in (out / "journal" / "events.jsonl").read_text().splitlines():
        json.loads(line)
    assert "Kitchen2024" not in (out / "journal" / "events.jsonl").read_text()

    with Image.open(out / "assets" / "photos" / "img_1.jpg") as image:
        assert not image.getexif() and "icc_profile" not in image.info and "xmp" not in image.info
    raw = (out / "assets" / "photos" / "img_1.jpg").read_bytes()
    assert b"GPSLatitude" not in raw and b"PhoneMaker" not in raw, "no metadata survives, whatever Pillow's defaults"
    assert not (out / "assets" / "photos" / "originals").exists()
    assert not (out / ".pcbv").exists() and not (out / "link.log").exists()
    assert not (out / "captures" / "logic" / "boot.sr").exists()

    text = (out / "REDACTION.md").read_text()
    for secret in ("SuperSecret99", "Kitchen2024", "LB4-77-XYZ", "00:1a:2b", "81.166.12.34"):
        assert secret not in text
    assert "Check by eye" in text and "boot.sr" in text and "symbolic link" in text
    counts = report.counts()
    assert counts["credential"] >= 2 and counts["custom"] == 1 and counts["mac"] == 1


def test_logic_captures_only_on_request(board_dir, tmp_path):
    redact_board(board_dir, tmp_path / "share", include_logic=True)
    assert (tmp_path / "share" / "captures" / "logic" / "boot.sr").read_bytes() == b"PK\x03\x04raw samples"


def test_check_writes_nothing_and_unsafe_targets_are_refused(board_dir, tmp_path):
    report = redact_board(board_dir, None)
    assert report.counts()["credential"] >= 2
    assert not (tmp_path / "nimbus-redacted").exists()
    with pytest.raises(RedactError):
        redact_board(board_dir, board_dir / "export")
    (tmp_path / "taken").mkdir()
    with pytest.raises(FileExistsError):
        redact_board(board_dir, tmp_path / "taken")


def test_cli(board_dir, tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = str(board_dir.parent)
    assert cli.main(["--root", root, "redact", "nimbus", "--check"]) == 0
    out = capsys.readouterr().out
    assert "credential" in out and "check only" in out and "SuperSecret99" not in out
    assert cli.main(["--root", root, "redact", "nimbus", "--out", str(tmp_path / "copy")]) == 0
    assert (tmp_path / "copy" / "REDACTION.md").is_file()
    assert cli.main(["--root", root, "redact", "nimbus", "--out", str(board_dir / "x")]) == 1
    assert "inside the board folder" in capsys.readouterr().err


def test_cli_keeps_the_copy_out_of_the_data_repo(board_dir, tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    git(tmp_path, "init", "-q")
    assert cli.main(["--root", str(board_dir.parent), "redact", "nimbus", "--out", str(tmp_path / "copy")]) == 1
    assert "inside the data repo" in capsys.readouterr().err
    assert not (tmp_path / "copy").exists()


@pytest.mark.filterwarnings("ignore::PIL.Image.DecompressionBombWarning")
def test_an_oversized_photo_is_left_out_not_a_crash(board_dir, tmp_path):
    for width in (15000, 25000):
        Image.new("1", (width, 10000)).save(board_dir / "assets" / "photos" / f"big{width}.png", "PNG")
    report = redact_board(board_dir, tmp_path / "share")
    for width in (15000, 25000):
        assert any(rel.endswith(f"big{width}.png") and "cannot be redacted" in why for rel, why in report.left_out)
        assert not (tmp_path / "share" / "assets" / "photos" / f"big{width}.png").exists()
    assert (tmp_path / "share" / "assets" / "photos" / "img_1.jpg").exists()


@pytest.mark.parametrize("key", ["password", "wifiPassword", "api_key", "apiKey", "auth-token", "wpa_psk", "Secret", "passwd"])
def test_json_values_under_secret_keys_are_replaced(tmp_path, key):
    board = Board.create(tmp_path / "boards" / "b", "B")
    board.close()
    d = tmp_path / "boards" / "b"
    (d / "extra.json").write_text(json.dumps({key: "plainvalue1", "nested": [{key: 12345678}]}), encoding="utf-8")
    report = redact_board(d, tmp_path / "share")
    data = json.loads((tmp_path / "share" / "extra.json").read_text())
    assert data[key] == "[SECRET-1]" and data["nested"][0][key] == "[SECRET-2]"
    assert report.counts()["credential"] == 2


def test_json_keys_that_only_contain_a_secret_word_stay(tmp_path):
    board = Board.create(tmp_path / "boards" / "b", "B")
    board.close()
    d = tmp_path / "boards" / "b"
    values = {"keyboard": "us-layout", "keys": "none", "monkey": "banana", "tokenizer": "bpe", "password": "********", "psk": ""}
    (d / "extra.json").write_text(json.dumps(values), encoding="utf-8")
    redact_board(d, tmp_path / "share")
    assert json.loads((tmp_path / "share" / "extra.json").read_text()) == values


KEY_BLOCK = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----"


def test_pem_blocks_are_replaced_whole_in_text_and_json(tmp_path):
    out, kinds = clean(f"before {KEY_BLOCK} after")
    assert out == "before [PEM-BLOCK-1] after" and kinds == ["pem-block"]
    board = Board.create(tmp_path / "boards" / "b", "B")
    board.close()
    d = tmp_path / "boards" / "b"
    (d / "captures").mkdir()
    (d / "captures" / "dump.log").write_text(f"one\n{KEY_BLOCK}\nwan 81.166.12.34\n", encoding="utf-8")
    (d / "extra.json").write_text(json.dumps({"note": KEY_BLOCK}), encoding="utf-8")
    report = redact_board(d, tmp_path / "share")
    copy = (tmp_path / "share" / "captures" / "dump.log").read_text()
    assert copy.startswith("one\n[PEM-BLOCK-1]\nwan 203.0.113.") and "MIIE" not in copy
    assert "MIIE" not in (tmp_path / "share" / "extra.json").read_text()
    lines = {(f.kind, f.file): f.line for f in report.findings}
    assert lines[("pem-block", "captures/dump.log")] == 2
    assert [f.line for f in report.findings if f.kind == "ip"] == [6]


def test_an_unterminated_or_mismatched_pem_header_stays_and_cannot_stall_the_scan():
    text = "-----BEGIN CERTIFICATE-----\nabc\n-----END PRIVATE KEY-----\n" + "-----BEGIN X-----\n" * 50_000
    out, kinds = clean(text)
    assert out == text and kinds == []


UNTERMINATED = "boot\n-----BEGIN PRIVATE KEY-----\n" + "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n" * 3 + "login:"


def test_an_unterminated_private_key_is_replaced_with_its_key_lines(tmp_path):
    assert clean(UNTERMINATED) == ("boot\n[PEM-BLOCK-1]\nlogin:", ["pem-block"])
    assert clean("boot\n-----BEGIN PRIVATE KEY-----") == ("boot\n-----BEGIN PRIVATE KEY-----", [])
    board = Board.create(tmp_path / "boards" / "b", "B")
    board.close()
    d = tmp_path / "boards" / "b"
    (d / "captures").mkdir()
    (d / "captures" / "cut.log").write_text(f"{KEY_BLOCK}\n{UNTERMINATED}\nwan 81.166.12.34\n", encoding="utf-8")
    report = redact_board(d, tmp_path / "share")
    copy = (tmp_path / "share" / "captures" / "cut.log").read_text()
    assert copy == "[PEM-BLOCK-1]\nboot\n[PEM-BLOCK-2]\nlogin:\nwan 203.0.113.2\n" and "MIIE" not in copy
    lines = sorted((f.kind, f.line) for f in report.findings if f.file == "captures/cut.log")
    assert lines == [("ip", 11), ("pem-block", 1), ("pem-block", 6)]


@pytest.mark.parametrize("line, secret", [
    ("root:aBcDeFgHiJkLm:15000:0:99999:7:::", "aBcDeFgHiJkLm"),
    ("admin:ab.CD/ef01234:0:0:99999:7:::", "ab.CD/ef01234"),
    ("root:$y$j9T$F5Jx5fExrKuPp53xLKQ..1$Z5qPhQyUd5yEZUNu5mGDRCtyZYQoLDPhM3sP5JgJL.D:19000:0:99999:7:::", "$y$j9T$"),
    ("pw $sha1$40000$abcdefgh$0123456789abcdefghijklmnopq tail", "$sha1$"),
])
def test_more_password_hash_formats_are_replaced(line, secret):
    out, kinds = clean(line)
    assert secret not in out and kinds == ["password-hash"] and "[PASSWORD-HASH-1]" in out


@pytest.mark.parametrize("line", ["root:x:0:0:root:/root:/bin/sh", "Interface:eth0:up", "root:*:15000:0:99999:7:::",
                                  "notes:abcdefghijklm:text", "root:!:0:0"])
def test_lines_that_only_resemble_hashes_stay(line):
    assert clean(line) == (line, [])


def test_a_v_inside_a_word_is_not_a_version_marker():
    for line in ("server 81.166.12.34", "dev 81.166.12.34", "recover 81.166.12.34"):
        assert clean(line)[1] == ["ip"], line
    for line in ("version 2.6.32.61", "ver. 2.6.32.61", "v2.6.32.61", "kernel 2.6.32.61", "Linux 2.6.32.61"):
        assert clean(line)[1] == [], line


def test_photos_keep_their_orientation_but_lose_the_exif_tag(board_dir, tmp_path):
    exif = Image.Exif()
    exif[0x0112] = 6                    # Orientation: rotate 270 degrees to view; a 40 x 30 file shows as 30 x 40
    Image.new("RGB", (40, 30), "green").save(board_dir / "assets" / "photos" / "turned.jpg", exif=exif.tobytes())
    redact_board(board_dir, tmp_path / "share")
    with Image.open(tmp_path / "share" / "assets" / "photos" / "turned.jpg") as copy:
        assert copy.size == (30, 40) and not copy.getexif()
