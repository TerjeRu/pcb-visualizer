import json

import pytest

from pcbv import cli
from pcbv.board import Board
from pcbv.serialmgr import scan_stream
from test_serial import AUTH, board_with_vdev  # noqa: F401 - fixture reused


def test_transcript_scan_is_chunked_and_handles_long_lines():
    import io

    class Bounded(io.BytesIO):
        def read(self, size=-1):
            assert size == 65536
            return super().read(size)

    data = b"x" * 65530 + b"Linux version 6.1" + b"x" * 100000 + b"\nU-Boot 2024.01\n"
    size, seen = scan_stream(Bounded(data))
    assert size == len(data)
    assert {"kernel", "bootloader"} <= set(seen)


def test_transcript_scan_preserves_long_anchored_prompts():
    import io
    from pcbv.serialmgr import scan_text

    for text in ("x" * 70000 + "# ", " " * 70000 + "=> ", "\u2003" * 70000 + "=> ",
                 "ø" * 70000 + "@host:/# ",
                 "z" * 4091 + "Linu" + "x" * 70000 + " version 6" + "z" * 4086,
                 "x" * 4088 + " login:" + "x" * 70000,
                 "root@" + "x" * 10000 + ":/" + "x" * 70000 + "# ",
                 "x" * 10000 + "@host:/" + "x" * 70000 + "# ",
                 "root@host:/" + "x" * 70000 + "# ",
                 "root@host:/" + "x" * 40000 + "#" + "x" * 30000 + "# "):
        assert scan_stream(io.BytesIO(text.encode()))[1] == scan_text(text)
    assert scan_stream(io.BytesIO(("root@" + "x" * 10000 + ":/" + "x" * 70000 + "# ").encode()))[1] == ["shell"]
    assert scan_stream(io.BytesIO(("x" * 4088 + " login:" + "x" * 70000).encode()))[1] == []


@pytest.mark.parametrize("line", [
    "U-Boot 2024.01", "CFE version 1", "Hit any key to stop autoboot", " => ", "CFE>",
    "bootcmd=boot", "  printenv  - print environment", "Linux version 6", "BusyBox v1",
    "root@host:/# ", "/ # ", "user login: ", "Please press Enter to activate this console",
    "x" * 70000 + "# ", "root@" + "x" * 10000 + ":/" + "x" * 70000 + "# ",
    "x" * 4088 + " login:" + "x" * 70000,
])
def test_transcript_scanner_matches_recognizer_patterns(line):
    import io
    from pcbv.serialmgr import SIGNS
    expected = sorted(kind for kind, pattern in SIGNS if pattern.search(line))
    assert scan_stream(io.BytesIO(line.encode()))[1] == expected


def test_terminal_recording_failure_stops_shell_and_reports_error(tmp_path, monkeypatch):
    import threading
    from pcbv import terminal

    class BrokenLog:
        def write(self, _data):
            raise OSError("disk full")
        def close(self):
            pass

    monkeypatch.setattr(terminal, "open_capture", lambda *_: BrokenLog())
    monkeypatch.setenv("SHELL", "/bin/sh")
    ended = threading.Event()
    results = []
    session = terminal.TerminalSession(board_dir=tmp_path, slug="test", cols=80, rows=24,
                                       on_output=lambda _: None,
                                       on_exit=lambda code: (results.append(code), ended.set()))
    session.write("echo hello\n")
    assert ended.wait(5)
    assert "disk full" in session.recording_error
    assert len(results) == 1 and session._process.poll() is not None
    session.terminate()


def test_terminal_constructor_failure_closes_capture(tmp_path, monkeypatch):
    from pcbv import terminal
    logs = []
    real_open = terminal.open_capture

    def open_log(*args):
        log = real_open(*args)
        logs.append(log)
        return log

    monkeypatch.setattr(terminal, "open_capture", open_log)
    monkeypatch.setattr(terminal.pty, "openpty", lambda: (_ for _ in ()).throw(OSError("no pty")))
    with pytest.raises(OSError):
        terminal.TerminalSession(board_dir=tmp_path, slug="test", cols=80, rows=24,
                                 on_output=lambda _: None, on_exit=lambda _: None)
    assert logs[0].closed


def test_cli_shell_reader_failure_reaps_child():
    from pcbv.shell import RecordingError, _spawn

    def fail(_fd):
        raise RecordingError("disk full")

    with pytest.raises(RecordingError, match="disk full"):
        _spawn(["/bin/sh", "-c", "echo ready; sleep 30"], fail)


def test_terminal_socket_reports_recording_failure(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from pcbv import terminal
    from pcbv.server import create_app

    real_open = terminal.open_capture

    class BrokenLog:
        def __init__(self, stream):
            self.stream = stream
        def write(self, _data):
            raise OSError("disk full")
        def close(self):
            self.stream.close()

    monkeypatch.setattr(terminal, "open_capture", lambda *args: BrokenLog(real_open(*args)))
    monkeypatch.setenv("SHELL", "/bin/sh")
    with TestClient(create_app(tmp_path / "boards", "test"), base_url="http://localhost:8765") as client:
        headers = {"X-PCBV-Protocol": "2", "Authorization": "Bearer test"}
        slug = client.post("/api/boards", json={"name": "Scratch"}, headers=headers).json()["slug"]
        with client.websocket_connect(f"/api/boards/{slug}/terminal", headers={"host": "localhost:8765"}) as ws:
            ws.send_json({"op": "auth", "protocol": 2, "token": "test"})
            assert ws.receive_json()["op"] == "started"
            ws.send_json({"op": "input", "data": "echo hello\n"})
            message = ws.receive_json()
            assert message["op"] == "error" and "disk full" in message["message"]
        capture = client.get(f"/api/boards/{slug}", headers=headers).json()["project"]["captures"][0]
        assert "recording error" in capture["reason"]


def test_terminal_start_notification_failure_closes_shell(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from pcbv import server
    from pcbv.terminal import TerminalSession

    sessions = []

    def make_session(**kwargs):
        session = TerminalSession(**kwargs)
        sessions.append(session)
        return session

    class Socket:
        headers = {"host": "localhost:8765"}
        async def accept(self):
            pass
        async def receive_json(self):
            return {"op": "auth", "protocol": 2, "token": "test"}
        async def send_json(self, _message):
            raise RuntimeError("socket disappeared")

    monkeypatch.setattr(server.terminal, "TerminalSession", make_session)
    monkeypatch.setenv("SHELL", "/bin/sh")
    app = server.create_app(tmp_path / "boards", "test")
    with TestClient(app, base_url="http://localhost:8765") as client:
        headers = {"X-PCBV-Protocol": "2", "Authorization": "Bearer test"}
        slug = client.post("/api/boards", json={"name": "Scratch"}, headers=headers).json()["slug"]
        with pytest.raises(RuntimeError, match="socket disappeared"):
            client.portal.call(server.terminal.terminal_socket, Socket(), slug, app.state.pcbv)
        assert sessions[0]._process.poll() is not None
        capture = client.get(f"/api/boards/{slug}", headers=headers).json()["project"]["captures"][0]
        assert capture["stopped"]


def test_cancelled_terminal_construction_terminates_shell(tmp_path, monkeypatch):
    import threading
    import time
    from starlette.testclient import TestClient
    from pcbv import server
    from pcbv.terminal import TerminalSession

    started, release = threading.Event(), threading.Event()
    sessions = []

    def slow_session(**kwargs):
        started.set()
        assert release.wait(3)
        session = TerminalSession(**kwargs)
        sessions.append(session)
        return session

    class Socket:
        headers = {"host": "localhost:8765"}
        async def accept(self):
            pass
        async def receive_json(self):
            return {"op": "auth", "protocol": 2, "token": "test"}

    monkeypatch.setattr(server.terminal, "TerminalSession", slow_session)
    monkeypatch.setenv("SHELL", "/bin/sh")
    app = server.create_app(tmp_path / "boards", "test")
    with TestClient(app, base_url="http://localhost:8765") as client:
        headers = {"X-PCBV-Protocol": "2", "Authorization": "Bearer test"}
        slug = client.post("/api/boards", json={"name": "Scratch"}, headers=headers).json()["slug"]
        future = client.portal.start_task_soon(server.terminal.terminal_socket, Socket(), slug, app.state.pcbv)
        assert started.wait(3)
        future.cancel()
        release.set()
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and (not sessions or sessions[0]._process.poll() is None):
            time.sleep(0.01)
        assert sessions and sessions[0]._process.poll() is not None

@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("SHELL", "/bin/sh")
    root = tmp_path / "boards"
    Board.create(root / "nimbus", "Nimbus").close()
    return root


def captures(root):
    with Board.open(root / "nimbus") as board:
        return board.project["captures"]


def test_shell_records_the_session_and_recognises_boot_output(root):
    code = cli.main(["--root", str(root), "shell", "nimbus", "-c",
                     "printf 'U-Boot 2015.07-ARC\\r\\nStarting kernel ...\\r\\nOpenWrt login: \\n'; pwd"])
    assert code == 0
    capture = captures(root)[0]
    assert capture["kind"] == "shell" and capture["stopped"] and capture["bytes"] > 0
    assert {"bootloader", "kernel", "login"} <= set(capture["seen"])
    transcript = (root / "nimbus" / capture["path"]).read_text()
    assert "U-Boot 2015.07-ARC" in transcript
    assert str(root / "nimbus") in transcript, "the shell runs in the board folder"


def test_shell_passes_the_exit_code_through(root):
    assert cli.main(["--root", str(root), "shell", "nimbus", "-c", "exit 3"]) == 3
    assert captures(root)[0]["stopped"]


def test_shell_sets_board_variables(root):
    cli.main(["--root", str(root), "shell", "nimbus", "-c", "echo board=$PCBV_BOARD capture=$PCBV_CAPTURE"])
    capture = captures(root)[0]
    transcript = (root / "nimbus" / capture["path"]).read_text()
    assert f"board=nimbus capture={capture['id']}" in transcript


def test_shell_on_a_missing_board_fails_cleanly(root, capsys):
    assert cli.main(["--root", str(root), "shell", "nope", "-c", "true"]) == 1
    assert "no board called 'nope'" in capsys.readouterr().err


def test_shell_routes_record_and_scan(board_with_vdev):  # noqa: F811
    client, slug, _, root = board_with_vdev
    started = client.post(f"/api/boards/{slug}/shell", json={"label": "pcbv shell"}, headers=AUTH)
    assert started.status_code == 201
    capture = started.json()["capture"]
    assert capture["path"].startswith("captures/shell/")
    file = root / slug / capture["path"]
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("Hit any key to stop autoboot:  1 \nARC7621 # ")
    stopped = client.post(f"/api/boards/{slug}/shell/{capture['id']}/stop", json={}, headers=AUTH)
    assert stopped.status_code == 200
    patch = stopped.json()["event"]["patch"]
    assert patch["seen"] == ["autoboot", "uboot-prompt"] and patch["bytes"] > 0
    invalid = client.post(f"/api/boards/{slug}/shell/{capture['id']}/stop", json={"reason": "x" * 129}, headers=AUTH)
    assert invalid.status_code == 422 and invalid.json()["error"] == "bad_request"
    assert client.post(f"/api/boards/{slug}/shell/cap_nope/stop", json={}, headers=AUTH).status_code == 404


def test_baud_detection_finds_the_virtual_boards_speed(board_with_vdev):  # noqa: F811
    client, slug, link, _ = board_with_vdev
    response = client.post(f"/api/boards/{slug}/serial/detect", json={"port": link, "seconds": 0.7}, headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert body["best"] == 115200, json.dumps(body["results"], indent=1)[:800]
    wrong = next(r for r in body["results"] if r["baud"] == 9600)
    assert wrong["score"] < 0.85
    # an open console blocks detection on the same port
    client.post(f"/api/boards/{slug}/serial", json={"port": link, "baud": 115200}, headers=AUTH)
    assert client.post(f"/api/boards/{slug}/serial/detect", json={"port": link}, headers=AUTH).status_code == 409
    client.post(f"/api/boards/{slug}/serial/close", headers=AUTH)


def test_readability_scores():
    from pcbv.serialmgr import readability
    assert readability(b"U-Boot 2015.07\r\nDRAM: 128 MiB\r\n") == 1.0
    assert readability("ÿþ€x~|¿ÃÂ#ð÷".encode()) < 0.5
    assert readability(b"") == 0.0


def test_terminal_socket_runs_a_captured_shell_in_the_board_folder(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from pcbv.server import create_app
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "boards"
    root.mkdir()
    token = "test-token-123"
    with TestClient(create_app(root, token), base_url="http://localhost:8765") as client:
        slug = client.post("/api/boards", json={"name": "Nimbus"}, headers={"X-PCBV-Protocol": "2", "Authorization": f"Bearer {token}"}).json()["slug"]
        with client.websocket_connect(f"/api/boards/{slug}/terminal", headers={"host": "localhost:8765"}) as ws:
            ws.send_json({"op": "auth", "protocol": 2, "token": token, "cols": 100, "rows": 30})
            started = ws.receive_json()
            assert started["op"] == "started" and started["capture"]["kind"] == "shell"
            ws.send_json({"op": "input", "data": "printf 'U-Boot 2015.07-ARC\\n'; pwd; stty size; exit\n"})
            text, message = "", {}
            for _ in range(200):
                message = ws.receive_json()
                if message["op"] == "exit":
                    break
                text += message.get("data", "")
            assert message == {"op": "exit", "code": 0}
            assert "U-Boot 2015.07-ARC" in text and str(root / slug) in text
            assert "30 100" in text, "the pty got the size the panel asked for"
        project = client.get(f"/api/boards/{slug}", headers={"X-PCBV-Protocol": "2", "Authorization": f"Bearer {token}"}).json()["project"]
        capture = project["captures"][0]
        assert capture["label"] == "Terminal panel" and capture["stopped"] and "bootloader" in capture["seen"]


def test_terminal_socket_needs_the_token(tmp_path):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    from pcbv.server import create_app
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, "tok"), base_url="http://localhost:8765") as client:
        slug = client.post("/api/boards", json={"name": "B"}, headers={"X-PCBV-Protocol": "2", "Authorization": "Bearer tok"}).json()["slug"]
        with client.websocket_connect(f"/api/boards/{slug}/terminal", headers={"host": "localhost:8765"}) as ws:
            ws.send_json({"op": "auth", "protocol": 2, "token": "wrong"})
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4401
        assert client.get(f"/api/boards/{slug}", headers={"X-PCBV-Protocol": "2", "Authorization": "Bearer tok"}).json()["project"].get("captures", []) == []


def test_cli_shell_restoration_failure_still_closes_and_reaps(monkeypatch):
    from pcbv import shell

    calls = []
    monkeypatch.setattr(shell.pty, "fork", lambda: (123, 456))
    monkeypatch.setattr(shell.termios, "tcgetattr", lambda fd: ["saved"])
    monkeypatch.setattr(shell.tty, "setraw", lambda fd: None)
    monkeypatch.setattr(shell.pty, "_copy", lambda *args: None)
    def fail_restore(*args):
        raise OSError("terminal disconnected")
    monkeypatch.setattr(shell.termios, "tcsetattr", fail_restore)
    monkeypatch.setattr(shell.os, "close", lambda fd: calls.append(("close", fd)))
    monkeypatch.setattr(shell.os, "waitpid", lambda pid, flags: calls.append(("waitpid", pid)) or (pid, 0))

    with pytest.raises(OSError, match="terminal disconnected"):
        shell._spawn(["sh"], lambda fd: b"")
    assert calls == [("close", 456), ("waitpid", 123)]


def test_terminal_output_bounded():
    import asyncio
    import threading
    from pcbv.terminal import LOSS_NOTICE, QUEUE_BYTES, QUEUE_ITEMS, OutputQueue

    async def scenario():
        loop = asyncio.get_running_loop()
        queue = OutputQueue(loop)
        scheduled = []
        real = loop.call_soon_threadsafe
        loop.call_soon_threadsafe = lambda *args, **kwargs: (scheduled.append(args), real(*args, **kwargs))[1]

        def flood():
            for n in range(50_000):
                queue.put(f"line {n}\r\n")
            queue.close(3)

        thread = threading.Thread(target=flood)
        thread.start()
        thread.join()                                 # the loop is blocked here, like a window that cannot keep up
        assert len(queue._items) <= QUEUE_ITEMS and queue._bytes <= QUEUE_BYTES
        assert len(scheduled) == 1, "however fast the thread produces, one wake-up is pending"

        got = [await queue.get() for _ in range(QUEUE_ITEMS + 2)]
        assert got[0] == ("output", LOSS_NOTICE), "the gap is announced before what survived"
        assert [kind for kind, _ in got[1:-1]] == ["output"] * QUEUE_ITEMS
        assert got[-2] == ("output", "line 49999\r\n") and got[-1] == ("exit", 3)
        assert LOSS_NOTICE not in [text for _, text in got[1:]], "one notice for the whole gap"

    asyncio.run(scenario())


def test_terminal_output_bounded_by_bytes_and_exit_survives_a_full_queue():
    import asyncio
    from pcbv.terminal import QUEUE_BYTES, OutputQueue

    async def scenario():
        queue = OutputQueue(asyncio.get_running_loop())
        for _ in range(1000):
            queue.put("x" * 4096)
        assert queue._bytes <= QUEUE_BYTES and len(queue._items) <= QUEUE_BYTES // 4096
        queue.close(0)
        kinds = []
        while True:
            kind, _ = await queue.get()
            kinds.append(kind)
            if kind == "exit":
                break
        assert kinds[0] == "output" and kinds.count("exit") == 1

    asyncio.run(scenario())


def test_terminal_output_queue_wakes_a_waiting_reader_and_tolerates_a_closed_loop():
    import asyncio
    import threading
    from pcbv.terminal import OutputQueue

    async def scenario():
        queue = OutputQueue(asyncio.get_running_loop())
        reader = asyncio.create_task(queue.get())
        await asyncio.sleep(0.01)
        threading.Thread(target=queue.put, args=("hello",)).start()
        assert await asyncio.wait_for(reader, 5) == ("output", "hello")

    asyncio.run(scenario())
    loop = asyncio.new_event_loop()
    queue = OutputQueue(loop)
    loop.close()
    queue.put("after shutdown")                       # must not raise in the reader thread
    queue.close(0)


def test_the_queue_lets_the_loop_run_between_items():
    import asyncio
    from pcbv.terminal import OutputQueue

    async def scenario():
        queue = OutputQueue(asyncio.get_running_loop())
        for n in range(20):
            queue.put(f"line {n}\n")
        ticks = 0

        async def other_work():
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0)

        task = asyncio.create_task(other_work())
        for _ in range(20):
            await queue.get()
        task.cancel()
        assert ticks >= 10, "reading a full queue starved everything else on the loop"

    asyncio.run(scenario())


def _session(tmp_path, monkeypatch, on_output=lambda _: None):
    from pcbv.terminal import TerminalSession
    monkeypatch.setenv("SHELL", "/bin/sh")
    return TerminalSession(board_dir=tmp_path, slug="test", cols=80, rows=24, on_output=on_output, on_exit=lambda _: None)


def _wait_for_size(path, size, timeout=10):
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size >= size:
            return path.read_bytes()
        time.sleep(0.05)
    return path.read_bytes() if path.exists() else b""


def test_terminal_input_does_not_wait_for_a_program_that_is_not_reading(tmp_path, monkeypatch):
    import time
    session = _session(tmp_path, monkeypatch)
    try:
        session.write("stty raw -echo; sleep 2; stty sane\n")
        time.sleep(0.3)
        began = time.monotonic()
        session.write("x" * 64_000)
        assert time.monotonic() - began < 0.2
    finally:
        session.terminate()


def test_terminal_input_arrives_whole_and_in_order(tmp_path, monkeypatch):
    import time
    session = _session(tmp_path, monkeypatch)
    try:
        session.write("stty raw -echo; sleep 1; head -c 200000 > got; stty sane\n")
        time.sleep(0.3)
        messages = [letter * 50_000 for letter in "abcd"]
        for message in messages:
            session.write(message)
        assert _wait_for_size(tmp_path / "got", 200_000) == "".join(messages).encode()
    finally:
        session.terminate()


def test_terminal_input_is_bounded_and_says_so_once(tmp_path, monkeypatch):
    import time
    from pcbv.terminal import INPUT_NOTICE, MAX_PENDING_INPUT, TerminalSession
    output, writer_at_close = [], []
    close_fds = TerminalSession._close_fds

    def recording_close(self):
        writer_at_close.append(self._writer.is_alive())
        close_fds(self)

    monkeypatch.setattr(TerminalSession, "_close_fds", recording_close)
    session = _session(tmp_path, monkeypatch, on_output=output.append)
    session.write("stty raw -echo; sleep 30\n")
    time.sleep(0.3)
    try:
        sent = 0
        while INPUT_NOTICE not in output:
            assert sent <= MAX_PENDING_INPUT + 64_000, "a message beyond the limit was not refused"
            began = time.monotonic()
            session.write("x" * 64_000)
            assert time.monotonic() - began < 0.2
            sent += 64_000
        for _ in range(3):
            began = time.monotonic()
            session.write("x" * 64_000)
            assert time.monotonic() - began < 0.2
        assert output.count(INPUT_NOTICE) == 1
    finally:
        began = time.monotonic()
        session.terminate()
        assert time.monotonic() - began < 5
    assert not session._thread.is_alive() and not session._writer.is_alive()
    assert writer_at_close == [False], "the writer ended before the pty master was closed"


def test_terminal_input_cut_at_a_character_boundary(tmp_path, monkeypatch):
    session = _session(tmp_path, monkeypatch)
    try:
        session.write("stty raw -echo; cat > got\n")
        import time
        time.sleep(0.3)
        session.write("ø" * 40_000)
        session.write("x" + "ø" * 40_000)
        expected = ("ø" * 32_000 + "x" + "ø" * 31_999).encode()
        got = _wait_for_size(tmp_path / "got", len(expected))
        time.sleep(0.3)
        assert (tmp_path / "got").read_bytes() == got == expected
    finally:
        session.terminate()


def test_a_paste_the_shell_does_not_read_leaves_the_service_responsive(tmp_path, monkeypatch):
    import time
    from starlette.testclient import TestClient
    from pcbv.server import create_app
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "boards"
    root.mkdir()
    token = "test-token-123"
    headers = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {token}"}
    with TestClient(create_app(root, token), base_url="http://localhost:8765") as client:
        slug = client.post("/api/boards", json={"name": "Nimbus"}, headers=headers).json()["slug"]
        with client.websocket_connect(f"/api/boards/{slug}/terminal", headers={"host": "localhost:8765"}) as ws:
            ws.send_json({"op": "auth", "protocol": 2, "token": token, "cols": 100, "rows": 30})
            assert ws.receive_json()["op"] == "started"
            ws.send_json({"op": "input", "data": "stty raw -echo; sleep 30\n"})
            time.sleep(0.3)
            for _ in range(5):
                ws.send_json({"op": "input", "data": "x" * 64_000})
            time.sleep(0.3)
            began = time.monotonic()
            assert client.get("/api/health").status_code == 200
            assert time.monotonic() - began < 1
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            capture = client.get(f"/api/boards/{slug}", headers=headers).json()["project"]["captures"][0]
            if capture.get("stopped"):
                break
            time.sleep(0.1)
        assert capture.get("stopped"), "closing the panel ended the shell and recorded the stop"


def test_a_lone_surrogate_in_the_input_does_not_end_the_session(tmp_path, monkeypatch):
    session = _session(tmp_path, monkeypatch)
    try:
        session.write("\ud800\n")
        session.write("echo ok > got\n")
        assert _wait_for_size(tmp_path / "got", 3) == b"ok\n"
    finally:
        session.terminate()
