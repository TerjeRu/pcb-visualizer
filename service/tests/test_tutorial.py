import shutil

import pytest
from starlette.testclient import TestClient

from pcbv import tutorial
from pcbv.board import Board, inspect_board
from pcbv.boards import TUTORIAL_SLUG, InvalidSlug, board_path, list_boards, practice_path, practice_root
from pcbv.datarepo import init_repo, sync
from pcbv.fsutil import Directory
from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "hw" / "boards"
    root.mkdir(parents=True)
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as c:
        c.root = root
        yield c


def test_the_practice_folder_follows_xdg_data_home(tmp_path, monkeypatch):
    assert practice_root() == tmp_path / "data" / "pcbv" / "practice"
    monkeypatch.delenv("XDG_DATA_HOME")
    assert practice_root().parts[-4:] == (".local", "share", "pcbv", "practice")


def test_the_tutorial_slug_is_reserved_in_the_boards_root(tmp_path):
    with pytest.raises(InvalidSlug, match="reserved for the tutorial"):
        board_path(tmp_path, TUTORIAL_SLUG)
    assert board_path(tmp_path, "pcbv-tutorial-2").name == "pcbv-tutorial-2"


def test_a_board_cannot_be_created_under_the_reserved_name(client):
    for name in ("pcbv-tutorial", "PCBV Tutorial", "  pcbv_tutorial "):
        made = client.post("/api/boards", json={"name": name}, headers=AUTH)
        assert made.status_code == 400 and made.json() == {"error": "bad_name", "message": "That name is reserved."}
    assert not (client.root / TUTORIAL_SLUG).exists()
    assert client.post("/api/boards", json={"name": "pcbv tutorial 2"}, headers=AUTH).status_code == 201


def test_the_practice_board_is_built_outside_the_boards_root(client):
    created = client.post("/api/tutorial/board", headers=AUTH)
    assert created.status_code == 201 and created.json() == {"slug": "pcbv-tutorial"}
    folder = practice_root() / TUTORIAL_SLUG
    assert inspect_board(folder)["snapshot"] == "in-sync"
    assert not (client.root / TUTORIAL_SLUG).exists()
    loaded = client.get("/api/boards/pcbv-tutorial", headers=AUTH).json()["project"]
    assert loaded["meta"]["name"] == "Tutorial router" and loaded["meta"]["device"].startswith("Synthetic")
    assert len(loaded["assets"]) == 1 and loaded["markers"] == [] and not loaded.get("annotations")
    assert [c["kind"] for c in loaded["captures"]] == ["logic"]
    assert (folder / loaded["captures"][0]["path"]).is_file()
    assert client.get("/api/boards", headers=AUTH).json()["boards"] == []


def test_creating_it_again_keeps_what_the_person_did(client):
    client.post("/api/tutorial/board", headers=AUTH)
    marker = {"type": "project/metaUpdated", "patch": {"notes": "mine"}}
    assert client.post("/api/boards/pcbv-tutorial/events", json={"event": marker, "actor": "web"}, headers=AUTH).status_code == 201
    assert client.post("/api/tutorial/board", headers=AUTH).status_code == 201
    assert client.get("/api/boards/pcbv-tutorial", headers=AUTH).json()["project"]["meta"]["notes"] == "mine"


def test_reset_rebuilds_the_board_from_scratch(client):
    client.post("/api/tutorial/board", headers=AUTH)
    client.post("/api/boards/pcbv-tutorial/events", json={"event": {"type": "project/metaUpdated", "patch": {"notes": "mine"}}, "actor": "web"}, headers=AUTH)
    reset = client.post("/api/tutorial/board/reset", headers=AUTH)
    assert reset.status_code == 201 and reset.json() == {"slug": "pcbv-tutorial"}
    state = client.get("/api/boards/pcbv-tutorial", headers=AUTH).json()
    assert state["project"]["meta"]["notes"] != "mine" and state["seq"] == 4


def test_reset_without_a_board_creates_it(client):
    assert client.post("/api/tutorial/board/reset", headers=AUTH).status_code == 201
    assert (practice_root() / TUTORIAL_SLUG / "project.pcb.json").is_file()


def test_the_tutorial_routes_need_the_session_token(client):
    for path in ("/api/tutorial/board", "/api/tutorial/board/reset"):
        assert client.post(path).status_code == 401
        assert client.post(path, headers={**AUTH, "Authorization": "Bearer wrong"}).status_code == 401
    assert not practice_root().exists()


def test_reset_is_refused_while_a_serial_session_is_open_on_the_board(client):
    client.post("/api/tutorial/board", headers=AUTH)
    state = client.app.state.pcbv
    state.serials.for_board = lambda slug: object() if slug == TUTORIAL_SLUG else None
    refused = client.post("/api/tutorial/board/reset", headers=AUTH)
    assert refused.status_code == 409 and refused.json()["error"] == "session_open"
    assert (practice_root() / TUTORIAL_SLUG / "project.pcb.json").is_file()


def test_reset_is_refused_while_a_terminal_is_open_on_the_board(client):
    client.post("/api/tutorial/board", headers=AUTH)
    state = client.app.state.pcbv

    class Terminal:
        slug = TUTORIAL_SLUG

    state.terminals.add(Terminal())
    assert client.post("/api/tutorial/board/reset", headers=AUTH).status_code == 409
    state.terminals.clear()
    assert client.post("/api/tutorial/board/reset", headers=AUTH).status_code == 201


def test_the_registry_resolves_the_slug_only_in_the_practice_folder(client):
    assert client.get("/api/boards/pcbv-tutorial", headers=AUTH).status_code == 404
    Board.create(client.root / "pcbv-tutorial-copy", "Other").close()
    # a board folder with the reserved name in the boards root is never opened
    (client.root / TUTORIAL_SLUG).mkdir()
    client.post("/api/tutorial/board", headers=AUTH)
    folder = client.get("/api/boards/pcbv-tutorial", headers=AUTH).json()
    assert folder["project"]["meta"]["name"] == "Tutorial router"
    assert "pcbv-tutorial" not in list_boards(client.root)


def test_a_symlinked_board_folder_or_practice_folder_is_refused(client, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    practice_root().mkdir(parents=True)
    (practice_root() / TUTORIAL_SLUG).symlink_to(outside)
    assert client.post("/api/tutorial/board", headers=AUTH).status_code == 400
    assert client.post("/api/tutorial/board/reset", headers=AUTH).status_code == 400
    assert client.get("/api/boards/pcbv-tutorial", headers=AUTH).status_code == 400
    assert list(outside.iterdir()) == []
    (practice_root() / TUTORIAL_SLUG).unlink()
    practice_root().rmdir()
    practice_root().parent.mkdir(parents=True, exist_ok=True)
    practice_root().symlink_to(outside)
    assert client.post("/api/tutorial/board", headers=AUTH).status_code == 400
    assert list(outside.iterdir()) == []


def test_remove_tree_removes_a_planted_symlink_as_a_link(tmp_path):
    target = tmp_path / "precious"
    target.mkdir()
    (target / "keep.txt").write_text("keep")
    folder = tmp_path / "root" / "board"
    (folder / "a" / "b").mkdir(parents=True)
    (folder / "a" / "b" / "file").write_text("x")
    (folder / "a" / "link").symlink_to(target)
    (folder / "filelink").symlink_to(target / "keep.txt")
    with Directory(tmp_path / "root") as root:
        root.remove_tree("board")
    assert not folder.exists()
    assert (target / "keep.txt").read_text() == "keep"


def test_reset_removes_a_symlink_planted_inside_the_board_without_following_it(client, tmp_path):
    client.post("/api/tutorial/board", headers=AUTH)
    target = tmp_path / "precious"
    target.mkdir()
    (target / "keep.txt").write_text("keep")
    (practice_root() / TUTORIAL_SLUG / "assets" / "trap").symlink_to(target)
    assert client.post("/api/tutorial/board/reset", headers=AUTH).status_code == 201
    assert (target / "keep.txt").read_text() == "keep"
    assert not (practice_root() / TUTORIAL_SLUG / "assets" / "trap").exists()


def test_reset_with_an_empty_practice_folder_creates_the_board(tmp_path):
    root = tmp_path / "practice"
    root.mkdir()
    tutorial.reset_tutorial(root)
    assert inspect_board(root / TUTORIAL_SLUG)["snapshot"] == "in-sync"


def test_a_half_built_folder_is_replaced(tmp_path):
    root = tmp_path / "practice"
    (root / TUTORIAL_SLUG / "assets").mkdir(parents=True)
    tutorial.create_tutorial(root)
    assert inspect_board(root / TUTORIAL_SLUG)["snapshot"] == "in-sync"


@pytest.mark.skipif(shutil.which("gitleaks") is None, reason="gitleaks not installed")
def test_syncing_the_data_repository_after_a_tutorial_run_commits_nothing_new(tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for var in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{var}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{var}_EMAIL", "test@example.invalid")
    repo = tmp_path / "hw"
    init_repo(repo)
    sync(repo, push=False)
    tutorial.create_tutorial()
    tutorial.reset_tutorial()
    assert sync(repo, push=False)[0] == "nothing to commit"
    assert not str(practice_path()).startswith(str(repo))


def test_the_tutorial_routes_take_no_input_and_still_refuse_an_oversized_body(client):
    from pcbv.server.body import MAX_BODY_BYTES

    for path in ("/api/tutorial/board", "/api/tutorial/board/reset"):
        refused = client.post(path, content=b"x" * (MAX_BODY_BYTES + 1), headers=AUTH)
        assert refused.status_code == 413 and refused.json()["error"] == "too_large"
    assert not practice_root().exists()
    assert client.post("/api/tutorial/board", json={"slug": "../../etc", "anything": 1}, headers=AUTH).json() == {"slug": "pcbv-tutorial"}
