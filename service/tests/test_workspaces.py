import json

import pytest
from starlette.testclient import TestClient

from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    root = tmp_path / "boards"
    root.mkdir()
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as c:
        yield c, tmp_path / "config" / "pcbv" / "workspaces.json"


def test_workspaces_start_empty_and_round_trip(client):
    c, path = client
    assert c.get("/api/workspaces").status_code == 401
    assert c.get("/api/workspaces", headers=AUTH).json() == {"current": None, "saved": {}}
    body = {"current": "Bench", "saved": {"Bench": {"regions": {"left": ["board"]}}}}
    assert c.post("/api/workspaces", json=body, headers=AUTH).status_code == 200
    assert c.get("/api/workspaces", headers=AUTH).json() == body
    assert json.loads(path.read_text()) == body


@pytest.mark.parametrize("body", [
    {"saved": []},
    {"saved": {"": {}}},
    {"saved": {"x" * 41: {}}},
    {"saved": {"A": "not a layout"}},
    {"current": 5, "saved": {}},
    {"saved": {f"w{i}": {} for i in range(41)}},
    {"saved": {"big": {"x": "y" * 210_000}}},
])
def test_bad_workspaces_are_refused_and_nothing_is_written(client, body):
    c, path = client
    assert c.post("/api/workspaces", json=body, headers=AUTH).status_code in (413, 422)
    assert not path.exists()


def test_a_broken_file_reads_as_empty(client):
    c, path = client
    path.parent.mkdir(parents=True)
    path.write_text("{not json")
    assert c.get("/api/workspaces", headers=AUTH).json() == {"current": None, "saved": {}}
