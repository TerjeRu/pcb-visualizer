import os
import subprocess
import sys
import time

import pytest
from starlette.testclient import TestClient

from pcbv.server import create_app
from pcbv.vdevmanager import VdevManager, link_is_live

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return tmp_path / "run" / "pcbv" / "ttyPCBV0"


def wait_for(condition, limit=5.0):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.05)
    return condition()


def foreign_vdev(env):
    """A virtual board started the way a user would, from a terminal."""
    return subprocess.Popen([sys.executable, "-I", "-m", "pcbv", "vdev"], env=env, stdout=subprocess.DEVNULL)


def test_start_makes_the_link_appear_and_stop_removes_it(run_dir):
    manager = VdevManager()
    try:
        started = manager.start()
        assert started == {"running": True, "owned": True, "path": str(run_dir)}
        child = manager.child
        assert manager.status()["owned"] is True
        stopped = manager.stop()
        assert stopped["running"] is False and stopped["owned"] is False
        assert child.poll() is not None and not run_dir.is_symlink()
    finally:
        manager.stop_child()


def test_a_second_start_while_running_starts_nothing(run_dir):
    manager = VdevManager()
    try:
        manager.start()
        child = manager.child
        again = manager.start()
        assert again["running"] and again["owned"] and manager.child is child
    finally:
        manager.stop_child()


def test_a_board_started_elsewhere_is_reported_and_cannot_be_stopped(run_dir):
    other = foreign_vdev(os.environ.copy())
    manager = VdevManager()
    try:
        assert wait_for(link_is_live)
        assert manager.start() == {"running": True, "owned": False, "path": str(run_dir)}
        assert manager.child is None
        from pcbv.vdevmanager import NotOwned
        with pytest.raises(NotOwned):
            manager.stop()
        assert other.poll() is None
    finally:
        other.terminate()
        other.wait()


def test_pcbv_vdev_ends_soon_after_the_process_it_watches(run_dir):
    watched = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"])
    child = foreign_vdev({**os.environ, "PCBV_STOP_WITH_PID": str(watched.pid)})
    try:
        assert wait_for(link_is_live)
        assert child.poll() is None
        watched.wait()
        assert wait_for(lambda: child.poll() is not None, 5.0)
        assert not run_dir.is_symlink()
    finally:
        watched.kill()
        child.kill()
        child.wait()


def test_pcbv_vdev_refuses_a_bad_watched_pid(run_dir):
    done = subprocess.run([sys.executable, "-I", "-m", "pcbv", "vdev"], env={**os.environ, "PCBV_STOP_WITH_PID": "x"},
                          capture_output=True, text=True, timeout=10)
    assert done.returncode == 2 and "PCBV_STOP_WITH_PID" in done.stderr


def test_the_routes_need_the_token_and_report_states(run_dir, tmp_path):
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as client:
        for method, path in (("get", "/api/vdev"), ("post", "/api/vdev/start"), ("post", "/api/vdev/stop")):
            assert getattr(client, method)(path).status_code == 401
        assert client.get("/api/vdev", headers=AUTH).json() == {"running": False, "owned": False, "path": str(run_dir)}
        assert client.post("/api/vdev/stop", headers=AUTH).json()["running"] is False
        started = client.post("/api/vdev/start", headers=AUTH)
        assert started.status_code == 200 and started.json()["owned"] is True
        assert client.get("/api/vdev", headers=AUTH).json()["running"] is True
        ports = client.get("/api/serial/ports", headers=AUTH).json()["ports"]
        assert [p["label"] for p in ports if p["virtual"]] == ["Virtual board (pcbv vdev)"]
        assert client.post("/api/vdev/stop", headers=AUTH).json()["running"] is False
        assert client.get("/api/vdev", headers=AUTH).json()["running"] is False


def test_the_route_refuses_to_stop_a_board_it_did_not_start(run_dir, tmp_path):
    root = tmp_path / "boards"
    root.mkdir()
    other = foreign_vdev(os.environ.copy())
    try:
        assert wait_for(link_is_live)
        with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as client:
            started = client.post("/api/vdev/start", headers=AUTH)
            assert started.status_code == 200 and started.json()["owned"] is False
            refused = client.post("/api/vdev/stop", headers=AUTH)
            assert refused.status_code == 409 and "outside the app" in refused.json()["message"]
    finally:
        other.terminate()
        other.wait()


def test_a_failed_start_reports_the_childs_first_lines_and_leaves_nothing(run_dir, monkeypatch):
    monkeypatch.setattr("pcbv.vdevmanager.START_WAIT", 2.0)
    run_dir.parent.mkdir(parents=True)
    run_dir.write_text("a plain file in the way")        # VirtualPort refuses to replace it
    from pcbv.vdevmanager import VdevError
    manager = VdevManager()
    with pytest.raises(VdevError) as problem:
        manager.start()
    assert "File exists" in str(problem.value) and manager.child is None


def test_closing_the_app_stops_an_owned_board(run_dir, tmp_path):
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as client:
        assert client.post("/api/vdev/start", headers=AUTH).json()["owned"] is True
        pid = client.app.state.pcbv.vdev.child.pid
    assert wait_for(lambda: not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z", 3.0)
    assert not run_dir.is_symlink()
