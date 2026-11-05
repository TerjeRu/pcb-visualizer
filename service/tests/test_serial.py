import json
import threading
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from pcbv.serialmgr import destructive_reason, forbidden_command_character, normalise_command, write_capture
from pcbv.server import create_app
from pcbv.server.serial import serial_open
from pcbv.vdev import VirtualPort

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.mark.parametrize("line", [
    "env save", "saveenv", "setenv bootdelay 5; saveenv", "sf erase 0 0x10000", "sf write 0x80000000 0 100",
    "nand erase.chip", "mtd write firmware.bin linux", "mw.l 0x80000000 0", "dd if=x.bin of=/dev/mtdblock3",
    "fw_setenv bootcmd x", "sysupgrade -n /tmp/fw.bin", "rm -rf /", "erase 1:0-7", "protect off all",
    "mmc write 0x80000000 0 100", "mmc erase 0 800", "ubi write 0x80000000 rootfs 0x100000", "ubi remove rootfs",
    "ubi create data", "fatwrite mmc 0:1 0x80000000 a.bin 100", "ext4write mmc 0:2 0x80000000 /a 100",
    "nandwrite -p /dev/mtd3 fw.bin", "mkfs.ext4 /dev/mmcblk0p2", "cat fw.bin | nandwrite /dev/mtd3 -",
])
def test_destructive_commands_are_recognised(line):
    assert destructive_reason(line)


@pytest.mark.parametrize("line", [
    "cat fw.bin > /dev/mtdblock3", "echo 1 > /dev/mtd3", "eeprom write 1",
    "sf protect unlock 0", "flash_unlock /dev/mtd3", "run update", "tftpboot x; run flashit",
    "fuse prog 0 0 0x1", "i2c write 1", "gpt write mmc 0 $parts", "mmc rpmb write 1",
    "cp fw.bin /dev/mtdblock3", "busybox devmem 0x1 32 0", "d'd' if=/dev/zero of=/dev/mtd0",
    "rm -r -f /", "echo x | tee /dev/nand0",
])
def test_destructive_bypasses(line):
    assert destructive_reason(line)


def test_command_normalisation_handles_flags_quotes_and_unicode():
    assert normalise_command("rm -r -f /") == normalise_command("rm -rf /")
    assert normalise_command("ｄ'd' if=x") == "dd if=x"


def test_capture_short_writes_are_completed_or_reported():
    class ShortWriter:
        def __init__(self):
            self.data = bytearray()
        def write(self, data):
            self.data.extend(data[:2])
            return min(len(data), 2)

    stream = ShortWriter()
    write_capture(stream, b"hello")
    assert stream.data == b"hello"
    stream.write = lambda _: 0
    with pytest.raises(OSError, match="no progress"):
        write_capture(stream, b"x")


def test_write_rejects_missing_and_stale_session_identity(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    opened = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
    identity = opened.json()["state"]["captureId"]
    url = f"/api/boards/{slug}/serial/write"
    assert client.post(url, json={"line": "help"}, headers=AUTH).json()["error"] == "bad_request"
    assert client.post(url, json={"line": "help", "sessionId": "old"}, headers=AUTH).json()["error"] == "session_stale"
    assert client.post(url, json={"line": "help", "sessionId": identity}, headers=AUTH).status_code == 200
    client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)


def test_reconnected_console_rejects_old_identity(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    url = f"/api/boards/{slug}/serial"
    old = client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).json()["state"]["captureId"]
    client.post(f"{url}/close", headers=AUTH)
    new = client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).json()["state"]["captureId"]
    assert old != new
    for payload in ({"line": "saveenv", "confirm": True}, {"key": "space"}):
        response = client.post(f"{url}/write", json={**payload, "sessionId": old}, headers=AUTH)
        assert response.status_code == 409 and response.json()["error"] == "session_stale"
    assert client.post(f"{url}/write", json={"key": "space", "sessionId": new}, headers=AUTH).status_code == 200
    assert client.post(f"{url}/write", json={"line": "help", "sessionId": "a" * 128}, headers=AUTH).status_code == 409
    assert client.post(f"{url}/write", json={"line": "help", "sessionId": "a" * 129}, headers=AUTH).status_code == 422
    client.post(f"{url}/close", headers=AUTH)


def test_session_identity_cannot_send_to_another_board(board_with_vdev):
    client, first, link, _ = board_with_vdev
    second = client.post("/api/boards", json={"name": "Second"}, headers=AUTH).json()["slug"]
    first_url = f"/api/boards/{first}/serial"
    second_url = f"/api/boards/{second}/serial"
    identity = client.post(first_url, json={"port": link, "baud": 115200}, headers=AUTH).json()["state"]["captureId"]
    assert client.post(f"{first_url}/write", json={"sessionId": identity, "line": "saveenv"}, headers=AUTH).json()["error"] == "confirm_required"
    client.post(f"{first_url}/close", headers=AUTH)
    client.post(second_url, json={"port": link, "baud": 115200}, headers=AUTH)
    response = client.post(f"{second_url}/write", json={"sessionId": identity, "line": "saveenv", "confirm": True}, headers=AUTH)
    assert response.status_code == 409 and response.json()["error"] == "session_stale"
    client.post(f"{second_url}/close", headers=AUTH)


def test_open_twice_concurrently_one_session(board_with_vdev):
    from concurrent.futures import ThreadPoolExecutor
    client, slug, link, _ = board_with_vdev
    url = f"/api/boards/{slug}/serial"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(url, json={"port": link, "baud": 115200}, headers=AUTH), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]
    client.post(f"{url}/close", headers=AUTH)


def test_failed_stop_can_be_reconciled_without_reopening_hardware(board_with_vdev, monkeypatch):
    from pcbv.journal import StorageError
    client, slug, link, _ = board_with_vdev
    url = f"/api/boards/{slug}/serial"
    opened = client.post(url, json={"port": link, "baud": 115200}, headers=AUTH)
    session_id = opened.json()["state"]["captureId"]
    journal = client.app.state.registry.get(slug).board._journal
    original = journal.append
    monkeypatch.setattr(journal, "append", lambda _: (_ for _ in ()).throw(StorageError("not_committed", "disk full")))
    failed = client.post(f"{url}/close", headers=AUTH)
    assert failed.status_code == 503 and failed.json()["error"] == "not_committed"
    assert client.post(f"{url}/close", headers=AUTH).status_code == 503
    stale = client.post(f"{url}/write", json={"sessionId": session_id, "line": "help"}, headers=AUTH)
    assert stale.status_code == 409 and stale.json()["error"] == "session_stale"
    monkeypatch.setattr(journal, "append", original)
    assert client.post(f"{url}/close", headers=AUTH).status_code == 200
    assert client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["captures"][0]["stopped"]


def test_unknown_stop_outcome_freezes_board_and_closes_hardware(board_with_vdev, monkeypatch):
    from pcbv.journal import StorageError
    client, slug, link, _ = board_with_vdev
    url = f"/api/boards/{slug}/serial"
    session_id = client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).json()["state"]["captureId"]
    board = client.app.state.registry.get(slug).board
    monkeypatch.setattr(board._journal, "append", lambda _: (_ for _ in ()).throw(StorageError("commit_unknown", "uncertain")))
    failed = client.post(f"{url}/close", headers=AUTH)
    assert failed.status_code == 503 and failed.json()["error"] == "commit_unknown"
    assert not board.writable
    response = client.post(f"{url}/write", json={"sessionId": session_id, "line": "help"}, headers=AUTH)
    assert response.status_code == 503 and response.json()["error"] == "recovery_required"


def test_failed_capture_registration_closes_port(board_with_vdev, monkeypatch):
    from pcbv.journal import StorageError
    client, slug, link, _ = board_with_vdev
    board = client.app.state.registry.get(slug).board
    original = board._journal.append
    monkeypatch.setattr(board._journal, "append", lambda _: (_ for _ in ()).throw(StorageError("not_committed", "disk full")))
    url = f"/api/boards/{slug}/serial"
    assert client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).status_code == 503
    assert client.get("/api/serial/ports", headers=AUTH).json()["sessions"] == []
    monkeypatch.setattr(board._journal, "append", original)
    assert client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).status_code == 201
    client.post(f"{url}/close", headers=AUTH)


def test_cancelled_open_cleans_up_port_after_construction(board_with_vdev, monkeypatch):
    import time
    from pcbv.serialmgr import SerialManager

    client, slug, link, _ = board_with_vdev
    started, release = threading.Event(), threading.Event()
    original = SerialManager.open

    def slow_open(manager, **kwargs):
        started.set()
        assert release.wait(3)
        return original(manager, **kwargs)

    class Request:
        url = SimpleNamespace(path=f"/api/boards/{slug}/serial")
        headers = {}
        app = client.app

        async def stream(self):
            yield json.dumps({"port": link, "baud": 115200}).encode()

    monkeypatch.setattr(SerialManager, "open", slow_open)
    future = client.portal.start_task_soon(serial_open, slug, Request(), client.app.state.pcbv)
    assert started.wait(3)
    future.cancel()
    release.set()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
        if response.status_code == 201:
            break
        time.sleep(0.01)
    else:
        pytest.fail("cancelled open retained the port")
    client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)


def test_orphaned_capture_is_interrupted_before_reopening(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    board = client.app.state.registry.get(slug).board
    board.apply({"type": "capture/started", "capture": {"id": "cap_orphan", "kind": "serial",
                "path": "captures/serial/orphan.log", "started": "2026-01-01T00:00:00Z"}}, "service", internal=True)
    url = f"/api/boards/{slug}/serial"
    assert client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).status_code == 201
    capture = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["captures"][0]
    assert capture["reason"] == "interrupted" and capture["stopped"]
    client.post(f"{url}/close", headers=AUTH)


def test_serial_recording_failure_stops_and_notifies_once(tmp_path, monkeypatch):
    from pcbv import serialmgr

    class Port:
        def __init__(self, *args, **kwargs):
            self.closed = 0
        def read(self, _size):
            return b"hello"
        def close(self):
            self.closed += 1
        def write(self, _data):
            raise AssertionError("write after recording failure")

    class BrokenLog:
        def write(self, _data):
            raise OSError("disk full")
        def close(self):
            pass

    monkeypatch.setattr(serialmgr.serial, "Serial", Port)
    monkeypatch.setattr(serialmgr, "open_capture", lambda *_: BrokenLog())
    ended = []
    session = serialmgr.SerialSession(board_dir=tmp_path, slug="test", port={"path": "test", "label": "test"},
                                     baud=115200, on_text=lambda _: None, on_end=ended.append)
    session.start()
    session._thread.join(timeout=2)
    assert len(ended) == 1 and "recording error" in ended[0]
    with pytest.raises(OSError):
        session.write_line("help")
    session.close()
    assert session._serial.closed == 1


def test_serial_capture_open_failure_closes_port(tmp_path, monkeypatch):
    from pcbv import serialmgr
    ports = []

    class Port:
        def __init__(self, *args, **kwargs):
            self.closed = False
            ports.append(self)
        def close(self):
            self.closed = True

    monkeypatch.setattr(serialmgr.serial, "Serial", Port)
    monkeypatch.setattr(serialmgr, "open_capture", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        serialmgr.SerialSession(board_dir=tmp_path, slug="test", port={"path": "test", "label": "test"},
                                baud=115200, on_text=lambda _: None, on_end=lambda _: None)
    assert ports[0].closed


def test_output_before_session_ready(tmp_path, monkeypatch):
    from pcbv import serialmgr

    class Port:
        def __init__(self, *args, **kwargs):
            self.calls = 0
        def read(self, _size):
            self.calls += 1
            if self.calls == 1:
                return b"U-Boot 2024.01\n"
            raise OSError("disconnected")
        def close(self):
            pass

    monkeypatch.setattr(serialmgr.serial, "Serial", Port)
    manager = serialmgr.SerialManager()
    output, ended = [], []
    session = manager.open(board_dir=tmp_path, slug="test", port={"path": "test", "label": "test"},
                           baud=115200, on_text=output.append, on_end=ended.append)
    assert manager.for_board("test") is session and output == []
    session.start()
    session._thread.join(timeout=2)
    assert "U-Boot 2024.01" in output[0] and len(ended) == 1
    session.close()
    manager.forget(session)


def test_immediate_port_failure_frees_port(board_with_vdev, monkeypatch):
    import time
    from pcbv import serialmgr

    class BrokenPort:
        def __init__(self, *args, **kwargs):
            pass
        def read(self, _size):
            raise OSError("disconnected")
        def close(self):
            pass

    client, slug, link, _ = board_with_vdev
    original = serialmgr.serial.Serial
    monkeypatch.setattr(serialmgr.serial, "Serial", BrokenPort)
    url = f"/api/boards/{slug}/serial"
    assert client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).status_code == 201
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not client.get("/api/serial/ports", headers=AUTH).json()["sessions"]:
            break
        time.sleep(0.01)
    else:
        pytest.fail("failed session kept its port")
    monkeypatch.setattr(serialmgr.serial, "Serial", original)
    assert client.post(url, json={"port": link, "baud": 115200}, headers=AUTH).status_code == 201
    client.post(f"{url}/close", headers=AUTH)


def test_a_permission_error_names_the_group_that_owns_the_port(board_with_vdev, monkeypatch):
    import grp
    import os
    from pcbv import distro, serialmgr

    def refused(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    client, slug, link, _ = board_with_vdev
    owner = os.stat(link).st_gid
    monkeypatch.setattr(grp, "getgrgid", lambda gid: SimpleNamespace(gr_name="dialout" if gid == owner else "other"))
    monkeypatch.setattr(serialmgr.serial, "Serial", refused)
    answer = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
    assert answer.status_code == 409 and answer.json()["error"] == "port_busy"
    assert "Add yourself to the dialout group with: sudo usermod -aG dialout $USER." in answer.json()["message"]

    monkeypatch.setattr(distro, "group_of", lambda path: None)
    monkeypatch.setattr(distro, "serial_group", lambda: "uucp")
    answer = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
    assert "sudo usermod -aG uucp $USER" in answer.json()["message"]


def test_immediate_serial_output_arrives_in_order_before_end(board_with_vdev, monkeypatch):
    from pcbv import serialmgr

    class Port:
        def __init__(self, *args, **kwargs):
            self.parts = iter([b"first", b"second", b"third"])
        def read(self, _size):
            try:
                return next(self.parts)
            except StopIteration:
                raise OSError("disconnected") from None
        def close(self):
            pass

    client, slug, link, _ = board_with_vdev
    monkeypatch.setattr(serialmgr.serial, "Serial", Port)
    with client.websocket_connect(f"/api/boards/{slug}/ws", headers={"host": "localhost:8765"}) as ws:
        ws.send_json({"op": "auth", "protocol": 2, "token": TOKEN})
        ws.receive_json()
        ws.receive_json()
        assert client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH).status_code == 201
        chunks = []
        while True:
            message = ws.receive_json()
            if message["op"] == "serial-data":
                chunks.append(message["text"])
            if message["op"] == "serial" and message.get("reason", "").startswith("port lost"):
                break
        assert chunks == ["first", "second", "third"]


@pytest.mark.parametrize("codepoint", [*range(0x202a, 0x202f), *range(0x2066, 0x206a),
                                       *range(0x200b, 0x200e), 0xfeff])
def test_invisible_command_characters_are_refused(codepoint):
    assert f"U+{codepoint:04X}" in forbidden_command_character("help" + chr(codepoint))


@pytest.mark.parametrize("line", ["printenv", "help", "version", "sf probe", "md.l 0x80000000 10",
                                  "cat /proc/mtd", "ls /", "dmesg", "env print", "mtd list", "dd if=/dev/mtd0 of=/tmp/x",
                                  "mmc list", "mmc info", "mmc read 0x80000000 0 100", "ubi part rootfs", "ubi info",
                                  "fatls mmc 0:1", "ext4ls mmc 0:2", "nanddump -f /tmp/nand.bin /dev/mtd3"])
def test_read_only_commands_pass(line):
    assert destructive_reason(line) is None


@pytest.fixture
def board_with_vdev(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    port = VirtualPort(tmp_path / "run" / "pcbv" / "ttyPCBV0", seed=1)
    stop = threading.Event()

    def run():
        while not stop.is_set():
            port.step(0.01)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as client:
        slug = client.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH).json()["slug"]
        yield client, slug, str(port.link), root
    stop.set()
    thread.join(2)
    port.close()


def read_until(ws, needle, limit=400):
    text = ""
    for _ in range(limit):
        message = ws.receive_json()
        if message["op"] == "serial-data":
            text += message["text"]
            if needle in text:
                return text
    raise AssertionError(f"{needle!r} never arrived; got {text[-300:]!r}")


def test_a_console_session_captures_everything_and_guards_destructive_commands(board_with_vdev):
    client, slug, link, root = board_with_vdev
    listing = client.get("/api/serial/ports", headers=AUTH).json()
    assert any(p["path"] == link and p["virtual"] for p in listing["ports"])
    assert 115200 in listing["bauds"]

    with client.websocket_connect(f"/api/boards/{slug}/ws", headers={"host": "localhost:8765"}) as ws:
        ws.send_json({"op": "auth", "protocol": 2, "token": TOKEN})
        assert ws.receive_json()["op"] == "snapshot"
        assert ws.receive_json()["state"] is None

        opened = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
        assert opened.status_code == 201
        capture_id = opened.json()["state"]["captureId"]

        assert "Hit any key to stop autoboot" in read_until(ws, "Hit any key")
        assert client.post(f"/api/boards/{slug}/serial/write", json={"key": "space", "sessionId": capture_id}, headers=AUTH).status_code == 200
        read_until(ws, "ARC7621 # ")
        assert client.post(f"/api/boards/{slug}/serial/write", json={"line": "printenv", "sessionId": capture_id}, headers=AUTH).status_code == 200
        assert "bootcmd=bootm" in read_until(ws, "bootcmd=")

        refused = client.post(f"/api/boards/{slug}/serial/write", json={"line": "saveenv", "sessionId": capture_id}, headers=AUTH)
        assert refused.status_code == 409 and refused.json()["error"] == "confirm_required"
        assert "backup" in refused.json()["message"]
        confirmed = client.post(f"/api/boards/{slug}/serial/write", json={"line": "saveenv", "confirm": True, "sessionId": capture_id}, headers=AUTH)
        assert confirmed.status_code == 200 and confirmed.json()["destructive"] is True

        closed = client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)
        assert closed.status_code == 200

    project = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]
    capture = project["captures"][0]
    assert capture["id"] == capture_id and capture["baud"] == 115200 and capture["stopped"]
    assert capture["bytes"] > 100 and capture["reason"] == "closed"
    log = (root / slug / capture["path"]).read_bytes()
    assert b"U-Boot 2015.07-ARC" in log and b"bootcmd=bootm" in log


def test_only_listed_ports_and_known_bauds_can_be_opened(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    assert client.post(f"/api/boards/{slug}/serial", json={"port": "/dev/sda", "baud": 115200}, headers=AUTH).status_code == 400
    assert client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 12345}, headers=AUTH).status_code == 422
    assert client.post(f"/api/boards/{slug}/serial/write", json={"line": "help", "sessionId": "old"}, headers=AUTH).status_code == 409


def test_one_console_per_board_and_per_port(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    other = client.post("/api/boards", json={"name": "Other"}, headers=AUTH).json()["slug"]
    assert client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH).status_code == 201
    assert client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH).status_code == 409
    assert client.post(f"/api/boards/{other}/serial", json={"port": link, "baud": 115200}, headers=AUTH).status_code == 409
    assert client.post(f"/api/boards/{slug}/serial/close", headers=AUTH).status_code == 200


def test_clients_cannot_forge_capture_events(board_with_vdev):
    client, slug, _, _ = board_with_vdev
    fake = {"type": "capture/started", "capture": {"id": "cap_x", "path": "captures/serial/x.log"}}
    assert client.post(f"/api/boards/{slug}/events", json={"event": fake}, headers=AUTH).status_code == 422


def test_lines_must_be_single_lines(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    capture_id = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH).json()["state"]["captureId"]
    for bad in ["help\nsaveenv", "x" * 1001, 7]:
        assert client.post(f"/api/boards/{slug}/serial/write", json={"line": bad, "sessionId": capture_id}, headers=AUTH).status_code == 422
    client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)


def test_capture_logs_are_served_as_text_behind_the_token(board_with_vdev):
    client, slug, link, root = board_with_vdev
    client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
    client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)
    path = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["captures"][0]["path"]
    assert client.get(f"/api/boards/{slug}/files/{path}").status_code == 401
    response = client.get(f"/api/boards/{slug}/files/{path}", headers=AUTH)
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/plain")
    assert response.headers["cache-control"] == "no-store"
    assert client.get(f"/api/boards/{slug}/files/captures/../journal/events.jsonl", headers=AUTH).status_code in (400, 404)
    assert client.get(f"/api/boards/{slug}/files/journal/events.jsonl", headers=AUTH).status_code == 400


def test_the_detector_recognises_boot_milestones_once():
    from pcbv.serialmgr import Detector
    d = Detector()
    assert d.feed("\r\nU-Boot 2015.07-ARC (Mar 14)\r\nHit any key to stop autoboot:  3 ") == ["bootloader", "autoboot"]
    assert d.feed("\b\b\b 0 \r\nARC7621 # ") == ["uboot-prompt"]           # prompt without a newline yet
    assert d.feed("printenv\r\nbootcmd=bootm 0x9c050000\r\nARC7621 # ") == ["env"]
    assert d.feed("help\r\nprintenv - print environment variables\r\n") == ["help"]
    assert d.feed("[    0.000000] Linux version 4.4.198 (builder)\r\n") == ["kernel"]
    assert d.feed("Please press Enter to activate this console.\r\n") == ["login"]
    assert d.feed("\r\nroot@ARC-DEMO:/# ") == ["shell"]
    assert d.feed("U-Boot 2015.07 again\r\n") == []
    assert d.seen == {"bootloader", "autoboot", "uboot-prompt", "env", "help", "kernel", "login", "shell"}


def test_a_shell_prompt_is_not_a_uboot_prompt():
    from pcbv.serialmgr import Detector
    d = Detector()
    assert "uboot-prompt" not in d.feed("root@OpenWrt:~# ")
    assert "uboot-prompt" not in Detector().feed("/ # ")


def test_what_the_console_saw_is_recorded_on_the_capture(board_with_vdev):
    client, slug, link, _ = board_with_vdev
    with client.websocket_connect(f"/api/boards/{slug}/ws", headers={"host": "localhost:8765"}) as ws:
        ws.send_json({"op": "auth", "protocol": 2, "token": TOKEN})
        ws.receive_json()
        ws.receive_json()
        capture_id = client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH).json()["state"]["captureId"]
        read_until(ws, "Hit any key")
        client.post(f"/api/boards/{slug}/serial/write", json={"key": "space", "sessionId": capture_id}, headers=AUTH)
        read_until(ws, "ARC7621 # ")
        client.post(f"/api/boards/{slug}/serial/write", json={"line": "printenv", "sessionId": capture_id}, headers=AUTH)
        read_until(ws, "Environment size")
    captures = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["captures"]
    assert {"bootloader", "autoboot", "uboot-prompt", "env"} <= set(captures[0]["seen"])
    client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)
    stopped = client.get(f"/api/boards/{slug}", headers=AUTH).json()["project"]["captures"][0]
    assert "env" in stopped["seen"] and stopped["stopped"]
