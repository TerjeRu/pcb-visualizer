import json
import subprocess

import pytest
from starlette.testclient import TestClient

from pcbv import settings
from pcbv.board import Board
from pcbv.datarepo import init_repo
from pcbv.assistant import MemoryKeyStore
from pcbv.fakemodel import FakeModelServer
from pcbv.server import create_app

BOARDED = {"guidance": "guided", "theme": "system", "assistant": "off", "git": "off", "welcomed": True,
           "tutorial": "skipped", "tutorialStep": 1}
FRESH = {"guidance": "guided", "theme": "system", "assistant": "off", "git": "off", "welcomed": False,
         "tutorial": "new", "tutorialStep": 1}
TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN, keystore=MemoryKeyStore()), base_url="http://localhost:8765") as c:
        c.config = tmp_path / "config" / "pcbv" / "settings.json"
        c.slug = c.post("/api/boards", json={"name": "Nimbus"}, headers=AUTH).json()["slug"]
        c.config.unlink(missing_ok=True)       # creating a board reads the settings, which may write the one-time values
        yield c


def test_guidance_starts_guided_and_is_saved_per_machine(client):
    assert client.get("/api/settings").status_code == 401
    assert client.get("/api/settings", headers=AUTH).json() == {**BOARDED, "data_folder": str(client.config.parents[2])}
    saved = client.post("/api/settings", json={"guidance": "expert"}, headers=AUTH)
    assert saved.status_code == 200 and saved.json() == {**BOARDED, "guidance": "expert"}
    assert json.loads(client.config.read_text()) == {**BOARDED, "guidance": "expert"}
    assert client.get("/api/settings", headers=AUTH).json() == {**BOARDED, "guidance": "expert", "data_folder": str(client.config.parents[2])}


def test_theme_is_saved_without_touching_guidance(client):
    client.post("/api/settings", json={"guidance": "expert"}, headers=AUTH)
    saved = client.post("/api/settings", json={"theme": "dark"}, headers=AUTH)
    assert saved.status_code == 200 and saved.json() == {**BOARDED, "guidance": "expert", "theme": "dark"}


def test_a_settings_file_from_before_the_theme_still_loads(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    (tmp_path / "pcbv").mkdir()
    (tmp_path / "pcbv" / "settings.json").write_text('{"guidance": "expert"}')
    assert settings.load(tmp_path / "hw" / "boards") == {**FRESH, "guidance": "expert"}


@pytest.mark.parametrize("body", [{"guidance": "pro"}, {"guidance": None}, {"theme": "sepia"}, {"font": "large"}, {"data_folder": "/x"}, {"welcomed": "yes"}, {"welcomed": 1}, {"assistant": "yes"}, {"git": True}, {"assistant": None}, []])
def test_unknown_settings_and_values_are_refused(client, body):
    response = client.post("/api/settings", json=body, headers=AUTH)
    assert response.status_code == 422
    assert not client.config.exists()


def test_a_broken_settings_file_gives_the_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    (tmp_path / "pcbv").mkdir()
    (tmp_path / "pcbv" / "settings.json").write_text("{not json")
    assert settings.load(tmp_path / "hw" / "boards") == FRESH


def test_a_change_reaches_every_open_window(client):
    with client.websocket_connect(f"/api/boards/{client.slug}/ws", headers={"host": "localhost:8765"}) as ws:
        ws.send_json({"op": "auth", "protocol": 2, "token": TOKEN, "actor": "web"})
        while ws.receive_json()["op"] != "serial":
            pass
        client.post("/api/settings", json={"guidance": "expert"}, headers=AUTH)
        assert ws.receive_json() == {"op": "settings", "settings": {**BOARDED, "guidance": "expert"}}


def test_the_assistant_speaks_to_the_chosen_level(client):
    model = FakeModelServer().start()
    try:
        client.post("/api/settings", json={"assistant": "on"}, headers=AUTH)
        client.post("/api/assistant/settings", headers=AUTH, json={"default": "local", "profiles": {
            "local": {"base_url": model.base_url, "model": "sim"}}})
        prompts = []
        for level in ("guided", "expert"):
            client.post("/api/settings", json={"guidance": level}, headers=AUTH)
            answer = client.post(f"/api/boards/{client.slug}/assistant/chat", json={"message": "hello"}, headers=AUTH)
            assert answer.status_code == 200, answer.text
            prompts.append(model.requests[-1]["body"]["messages"][0]["content"])
        assert "learn hardware hacking" in prompts[0] and "experienced person" not in prompts[0]
        assert "experienced person" in prompts[1] and "learn hardware hacking" not in prompts[1]
        assert all("Never tell the person to connect the adapter's VCC pin" in p for p in prompts)
    finally:
        model.stop()


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    (tmp_path / "config" / "pcbv").mkdir(parents=True)
    return tmp_path / "config" / "pcbv"


def test_both_new_settings_start_off_and_are_saved(client, tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")
    assert client.get("/api/settings", headers=AUTH).json() == {**BOARDED, "data_folder": str(tmp_path)}
    init_repo(tmp_path)
    saved = client.post("/api/settings", json={"assistant": "on", "git": "on"}, headers=AUTH)
    assert saved.status_code == 200 and saved.json() == {**BOARDED, "assistant": "on", "git": "on"}
    assert json.loads(client.config.read_text()) == {**BOARDED, "assistant": "on", "git": "on"}
    off = client.post("/api/settings", json={"assistant": "off"}, headers=AUTH).json()
    assert off == {**BOARDED, "git": "on"}


def test_a_fresh_install_writes_both_as_off_so_they_are_decided_once(config, tmp_path):
    assert settings.load(tmp_path / "hw" / "boards") == FRESH
    assert json.loads((config / "settings.json").read_text()) == FRESH
    (config / "assistant.json").write_text("{}")               # set up later, after the first start
    assert settings.load(tmp_path / "hw" / "boards")["assistant"] == "off"


def test_an_install_with_assistant_settings_migrates_to_on_once(config, tmp_path):
    (config / "assistant.json").write_text(json.dumps({"default": "tutor", "profiles": {}}))
    (config / "settings.json").write_text(json.dumps({"guidance": "expert", "theme": "dark"}))
    loaded = settings.load(tmp_path / "hw" / "boards")
    assert loaded == {"guidance": "expert", "theme": "dark", "assistant": "on", "git": "off", "welcomed": False,
                      "tutorial": "new", "tutorialStep": 1}
    assert json.loads((config / "settings.json").read_text()) == loaded
    settings.save({"assistant": "off"})                         # the choice sticks on the next load
    assert settings.load(tmp_path / "hw" / "boards")["assistant"] == "off"


def test_welcomed_is_a_bool_and_is_saved(config, tmp_path):
    boards = tmp_path / "hw" / "boards"
    assert settings.load(boards)["welcomed"] is False
    assert settings.save({"welcomed": True}, boards)["welcomed"] is True
    assert settings.load(boards)["welcomed"] is True
    for bad in ("yes", 1, None, "true"):
        with pytest.raises(settings.SettingsError):
            settings.validate({"welcomed": bad})


def test_a_file_without_welcomed_reads_true_only_when_a_board_exists(config, tmp_path):
    boards = tmp_path / "hw" / "boards"
    (config / "settings.json").write_text(json.dumps({"guidance": "guided", "theme": "system", "assistant": "off", "git": "off"}))
    assert settings.load(boards)["welcomed"] is False
    (config / "settings.json").unlink()
    Board.create(boards / "first", "First", actor="test").close()
    (config / "settings.json").write_text(json.dumps({"guidance": "guided", "theme": "system", "assistant": "off", "git": "off"}))
    assert settings.load(boards)["welcomed"] is True
    assert json.loads((config / "settings.json").read_text())["welcomed"] is True


def test_an_assistant_file_that_does_not_parse_still_counts_as_set_up(config, tmp_path):
    (config / "assistant.json").write_text("{not json")
    assert settings.load(tmp_path / "hw" / "boards")["assistant"] == "on"


def test_a_data_repo_with_the_commit_guard_migrates_git_to_on(config, tmp_path):
    init_repo(tmp_path / "hw")
    assert settings.load(tmp_path / "hw" / "boards")["git"] == "on"
    assert json.loads((config / "settings.json").read_text())["git"] == "on"


@pytest.mark.parametrize("hooks", [None, ".other"])
def test_a_git_folder_without_the_guard_stays_off(config, tmp_path, hooks):
    folder = tmp_path / "hw"
    (folder / "boards").mkdir(parents=True)
    subprocess.run(["git", "-C", str(folder), "init", "-q"], check=True)
    if hooks:
        subprocess.run(["git", "-C", str(folder), "config", "core.hooksPath", hooks], check=True)
    assert settings.load(folder / "boards")["git"] == "off"


def test_a_boards_folder_inside_someone_elses_repo_stays_off(config, tmp_path):
    init_repo(tmp_path / "work")
    (tmp_path / "work" / "sub" / "boards").mkdir(parents=True)
    assert settings.load(tmp_path / "work" / "sub" / "boards")["git"] == "off"


def test_saved_choices_are_not_migrated_again(config, tmp_path):
    (config / "assistant.json").write_text("{}")
    init_repo(tmp_path / "hw")
    (config / "settings.json").write_text(json.dumps({"assistant": "off", "git": "off"}))
    loaded = settings.load(tmp_path / "hw" / "boards")
    assert loaded["assistant"] == "off" and loaded["git"] == "off"


def test_a_broken_file_is_not_overwritten_by_a_read(config, tmp_path):
    (config / "settings.json").write_text("{not json")
    (config / "assistant.json").write_text("{}")
    assert settings.load(tmp_path / "hw" / "boards") == FRESH
    assert (config / "settings.json").read_text() == "{not json"


def test_a_refused_change_writes_nothing(client):
    assert client.post("/api/settings", json={"assistant": "maybe"}, headers=AUTH).status_code == 422
    assert not client.config.exists()


def test_the_tutorial_settings_are_validated_and_saved(config, tmp_path):
    boards = tmp_path / "hw" / "boards"
    for state in settings.TUTORIAL_STATES:
        assert settings.save({"tutorial": state}, boards)["tutorial"] == state
    assert settings.save({"tutorial": "started", "tutorialStep": 18}, boards)["tutorialStep"] == 18
    assert settings.load(boards)["tutorialStep"] == 18
    for bad in ("begun", None, 1, True):
        with pytest.raises(settings.SettingsError):
            settings.validate({"tutorial": bad})
    for bad in (0, 19, -1, 1.0, "3", None, True, False):
        with pytest.raises(settings.SettingsError):
            settings.validate({"tutorialStep": bad})


def test_a_file_from_before_the_tutorial_reads_skipped_for_a_welcomed_user_and_new_for_a_fresh_one(config, tmp_path):
    boards = tmp_path / "hw" / "boards"
    old = {"guidance": "guided", "theme": "system", "assistant": "off", "git": "off"}
    (config / "settings.json").write_text(json.dumps({**old, "welcomed": True}))
    assert settings.load(boards)["tutorial"] == "skipped"
    assert json.loads((config / "settings.json").read_text())["tutorial"] == "skipped"
    (config / "settings.json").write_text(json.dumps({**old, "welcomed": False}))
    assert settings.load(boards)["tutorial"] == "new"
    (config / "settings.json").write_text(json.dumps({**old, "welcomed": False, "tutorial": "started", "tutorialStep": 7}))
    assert settings.load(boards)["tutorial"] == "started"      # a saved choice is never migrated over
