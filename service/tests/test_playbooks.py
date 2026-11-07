import pytest
import yaml
from starlette.testclient import TestClient

from pcbv.playbooks import PlaybookError, builtin_dir, load_all, validate
from pcbv.server import create_app

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}


def minimal(**extra):
    return {"id": "test", "title": "Test", "steps": [{"id": "one", "title": "One", "why": "w", "do": "d"}], **extra}


def test_builtin_playbooks_are_valid_and_ordered():
    playbooks, problems = load_all(None)
    assert problems == []
    assert [p["id"] for p in playbooks][:2] == ["open-and-photograph", "find-uart"]
    uart = playbooks[1]
    assert uart["requires"] == ["open-and-photograph"]
    ground = next(s for s in uart["steps"] if s["id"] == "ground")
    assert {g["id"] for g in ground["gates"]} == {"unplugged", "meter"}
    assert all(g["destructive"] is False for g in ground["gates"])


def test_the_photo_step_asks_for_two_photos_of_any_kind():
    playbooks, _ = load_all(None)
    step = next(s for s in playbooks[0]["steps"] if s["id"] == "photos")
    assert [(c["kind"], c.get("min"), c.get("side")) for c in step["checks"]] == [("photos", 2, None)]


def test_logic_capture_playbook_listens_only_and_builds_on_the_console_playbook():
    playbooks, problems = load_all(None)
    assert problems == []
    logic = next(p for p in playbooks if p["id"] == "logic-capture")
    assert logic["requires"] == ["get-a-console"]
    assert [s["id"] for s in logic["steps"]] == ["probe", "capture", "decode", "compare"]
    probe = logic["steps"][0]
    assert {"unplugged", "no-vcc"} <= {g["id"] for g in probe["gates"]}
    assert all(not g["destructive"] for s in logic["steps"] for g in s["gates"])
    assert {c["kind"] for s in logic["steps"] for c in s["checks"]} == {"uart_header", "logic"}


def test_builtin_text_follows_the_house_style():
    for path in builtin_dir().glob("*.yaml"):
        assert "—" not in path.read_text(encoding="utf-8"), f"{path.name} contains an em dash"


def test_defaults_are_filled_in():
    p = validate(minimal())
    assert p["version"] == 1 and p["requires"] == [] and p["steps"][0]["gates"] == []
    p = validate(minimal(steps=[{"id": "one", "title": "T", "why": "w", "do": "d",
                                 "ask": [{"id": "soc", "label": "SoC"}], "gates": [{"id": "g", "text": "t"}]}]))
    assert p["steps"][0]["ask"][0]["required"] is True
    assert p["steps"][0]["gates"][0]["destructive"] is False


@pytest.mark.parametrize("change, match", [
    (lambda p: p.update(titel="x"), "unknown key"),
    (lambda p: p["steps"][0].update(gate=[{"id": "g", "text": "t"}]), "unknown key"),
    (lambda p: p.update(id="Find UART"), "lowercase"),
    (lambda p: p.update(steps=[]), "at least one step"),
    (lambda p: p["steps"].append(dict(p["steps"][0])), "duplicate id"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "magic", "text": "t"}]), "unknown check kind"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "pin_role", "text": "t"}]), "needs roles"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "markers", "min": "1", "text": "t"}]), "wrong type"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "markers", "min": True, "text": "t"}]), "wrong type"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "photos", "side": "top", "text": "t"}]), "side"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "reading", "mode": ["amps"], "text": "t"}]), "mode"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "markers"}]), "text"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "capture", "seen": ["banner"], "text": "t"}]), "check capture"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "capture", "seen_any": [], "text": "t"}]), "check capture"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "logic", "seen": ["banner"], "text": "t"}]), "check logic"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "logic", "min_ratio": 1.5, "text": "t"}]), "min_ratio"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "logic", "min_ratio": True, "text": "t"}]), "min_ratio"),
    (lambda p: p["steps"][0].update(checks=[{"kind": "logic", "compared": "yes", "text": "t"}]), "wrong type"),
    (lambda p: p["steps"][0].update(why=""), "why"),
    (lambda p: p["steps"][0].update(gates=[{"id": "g", "text": "t", "destructive": "yes"}]), "destructive"),
])
def test_mistakes_are_named(change, match):
    p = minimal()
    change(p)
    with pytest.raises(PlaybookError, match=match):
        validate(p)


def test_data_repo_playbooks_replace_builtins_and_broken_files_are_reported(tmp_path):
    user = tmp_path / "playbooks"
    user.mkdir()
    custom = minimal(id="find-uart", title="My UART steps")
    (user / "02-find-uart.yaml").write_text(yaml.safe_dump(custom))
    (user / "zz-broken.yaml").write_text("id: [unclosed")
    (user / "zz-wrong.yaml").write_text(yaml.safe_dump(minimal(id="wrong", titel="x")))
    playbooks, problems = load_all(user)
    titles = {p["id"]: (p["title"], p["origin"]) for p in playbooks}
    assert titles["find-uart"] == ("My UART steps", "data repo")
    assert titles["open-and-photograph"][1] == "builtin"
    assert sorted(pr["file"].rsplit("/", 1)[1] for pr in problems) == ["zz-broken.yaml", "zz-wrong.yaml"]


def test_api_serves_playbooks_behind_the_token(tmp_path):
    root = tmp_path / "hw" / "boards"
    root.mkdir(parents=True)
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as client:
        assert client.get("/api/playbooks").status_code == 401
        body = client.get("/api/playbooks", headers=AUTH).json()
        assert [p["id"] for p in body["playbooks"]][:2] == ["open-and-photograph", "find-uart"]
        assert body["problems"] == []
