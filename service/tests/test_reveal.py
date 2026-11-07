import pytest
from starlette.testclient import TestClient

from pcbv import distro, reveal
from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def exports(tmp_path, monkeypatch):
    root = tmp_path / "exports"
    root.mkdir()
    monkeypatch.setenv("PCBV_EXPORT_DIR", str(root))
    return root


@pytest.fixture
def client(tmp_path, exports):
    boards = tmp_path / "boards"
    boards.mkdir()
    with TestClient(create_app(boards, TOKEN), base_url="http://localhost:8765") as c:
        yield c


@pytest.fixture
def slug(client):
    return client.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH).json()["slug"]


@pytest.fixture
def started(monkeypatch):
    """Lets the real routes run with a fake starter that records its folder."""
    monkeypatch.delenv("PCBV_NO_REVEAL")
    monkeypatch.setattr(reveal.shutil, "which", lambda name: "/usr/bin/xdg-open")
    calls = []
    monkeypatch.setattr(reveal, "start", lambda program, folder: calls.append((program, folder)))
    return calls


def test_the_reveal_routes_need_the_token(client, slug, exports):
    (exports / "nimbus-1").mkdir()
    for headers in ({}, {"X-PCBV-Protocol": "2", "Authorization": "Bearer wrong"}):
        assert client.post(f"/api/boards/{slug}/reveal", headers=headers).status_code == 401
        assert client.post("/api/exports/reveal", json={"folder": str(exports / "nimbus-1")}, headers=headers).status_code == 401


def test_the_board_folder_goes_to_the_starter(client, slug, started, tmp_path):
    answer = client.post(f"/api/boards/{slug}/reveal", headers=AUTH)
    assert answer.status_code == 200 and answer.json()["opened"] is True
    assert started == [("/usr/bin/xdg-open", tmp_path / "boards" / slug)]


def test_no_reveal_starts_nothing(client, slug, monkeypatch):
    monkeypatch.setattr(reveal, "start", lambda *a: pytest.fail("a program was started"))
    assert client.post(f"/api/boards/{slug}/reveal", headers=AUTH).json()["opened"] is False


def test_an_unknown_board_is_not_found(client, started):
    assert client.post("/api/boards/nothing-here/reveal", headers=AUTH).status_code == 404
    assert started == []


def test_a_missing_xdg_open_says_what_to_install(client, slug, started, monkeypatch):
    monkeypatch.setattr(reveal.shutil, "which", lambda name: None)
    monkeypatch.setattr(distro, "family", lambda *a: "arch")
    answer = client.post(f"/api/boards/{slug}/reveal", headers=AUTH)
    assert answer.status_code == 501 and answer.json()["error"] == "no_file_manager"
    assert answer.json()["message"] == "The file manager could not be started. Install xdg-utils: sudo pacman -S xdg-utils"
    monkeypatch.setattr(distro, "family", lambda *a: None)
    assert "with your package manager" in client.post(f"/api/boards/{slug}/reveal", headers=AUTH).json()["message"]


def test_the_starter_gets_an_argument_list_and_detaches(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(reveal.subprocess, "Popen", lambda args, **kw: seen.update(args=args, **kw))
    reveal.start("/usr/bin/xdg-open", tmp_path / "a b; rm")
    assert seen["args"] == ["/usr/bin/xdg-open", str(tmp_path / "a b; rm")]
    assert seen["start_new_session"] is True and "shell" not in seen


def test_an_export_folder_opens(client, exports, started):
    folder = exports / "nimbus-20261105-181600"
    folder.mkdir()
    answer = client.post("/api/exports/reveal", json={"folder": str(folder)}, headers=AUTH)
    assert answer.status_code == 200 and answer.json()["opened"] is True
    assert started == [("/usr/bin/xdg-open", folder)]


def test_only_a_direct_child_folder_of_the_export_root_opens(client, exports, started, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    inside = exports / "nimbus-1"
    inside.mkdir()
    (inside / "deeper").mkdir()
    (exports / "a-file").write_text("x")
    (exports / "link").symlink_to(outside)
    for folder in (outside, exports, exports.parent, inside / "deeper", exports / "a-file", exports / "missing",
                   exports / "link", f"{inside}/../../elsewhere", "nimbus-1", "", "/"):
        answer = client.post("/api/exports/reveal", json={"folder": str(folder)}, headers=AUTH)
        assert answer.status_code == 400 and answer.json()["error"] == "bad_path", folder
    for body in ({}, {"folder": 5}, {"folder": ["x"]}, {"folder": "a\0b"}):
        assert client.post("/api/exports/reveal", json=body, headers=AUTH).status_code == 400
    assert started == []


def test_the_export_reveal_body_has_a_limit(client, exports, started):
    at_limit = '{"folder": "' + "x" * (4096 - len('{"folder": ""}')) + '"}'
    assert len(at_limit) == 4096
    answer = client.post("/api/exports/reveal", content=at_limit, headers={**AUTH, "Content-Type": "application/json"})
    assert answer.status_code == 400 and answer.json()["error"] == "bad_path"
    answer = client.post("/api/exports/reveal", content=at_limit + " ", headers={**AUTH, "Content-Type": "application/json"})
    assert answer.status_code == 413 and answer.json()["error"] == "too_large"
    assert started == []


def test_the_board_answer_names_its_folder(client, slug, tmp_path):
    assert client.get(f"/api/boards/{slug}", headers=AUTH).json()["directory"] == str(tmp_path / "boards" / slug)
