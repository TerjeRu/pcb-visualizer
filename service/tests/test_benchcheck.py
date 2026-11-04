import grp
import types

import pytest

from pcbv import benchcheck

from test_settings import AUTH, client  # noqa: F401  (the shared app fixture)


def patch(monkeypatch, tmp_path=None, *, groups=(20,), uucp=20, tools=("sigrok-cli", "gitleaks"), firmware=("fx2lafw-saleae-logic.fw",)):
    def getgrnam(name):
        if uucp is None:
            raise KeyError(name)
        return types.SimpleNamespace(gr_gid=uucp)
    monkeypatch.setattr(grp, "getgrnam", getgrnam)
    monkeypatch.setattr("os.getgroups", lambda: list(groups))
    monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}" if name in tools else None)
    if tmp_path is not None:
        folder = tmp_path / "sigrok-firmware"
        folder.mkdir(exist_ok=True)
        for name in firmware:
            (folder / name).write_bytes(b"")
        monkeypatch.setattr(benchcheck, "FIRMWARE_DIRS", (tmp_path / "missing", folder))


def by_id():
    return {c["id"]: c for c in benchcheck.checks()}


def test_every_check_passes_when_all_is_present(monkeypatch, tmp_path):
    patch(monkeypatch, tmp_path)
    found = benchcheck.checks()
    assert [c["id"] for c in found] == ["serial-group", "sigrok", "fx2lafw", "gitleaks"]
    assert all(c["ok"] for c in found)


@pytest.mark.parametrize("kwargs", [{"groups": (1000,)}, {"uucp": None}])
def test_missing_uucp_membership_or_group_fails_with_the_fix(monkeypatch, kwargs):
    patch(monkeypatch, **kwargs)
    check = by_id()["serial-group"]
    assert not check["ok"] and "sudo usermod -aG uucp $USER" in check["fix"]


def test_missing_tools_fail_with_the_pacman_command(monkeypatch):
    patch(monkeypatch, tools=())
    found = by_id()
    assert not found["sigrok"]["ok"] and found["sigrok"]["fix"].startswith("sudo pacman -S sigrok-cli")
    assert not found["gitleaks"]["ok"] and found["gitleaks"]["fix"] == "sudo pacman -S gitleaks"


@pytest.mark.parametrize("firmware", [(), ("fx2lafw-sigrok-fx2-8ch.hex",), ("other.fw",)])
def test_missing_fx2_firmware_fails_with_the_pacman_command(monkeypatch, tmp_path, firmware):
    patch(monkeypatch, tmp_path, firmware=firmware)
    check = by_id()["fx2lafw"]
    assert not check["ok"] and check["fix"] == "sudo pacman -S sigrok-firmware-fx2lafw"
    assert "plug" in check["label"]


def test_no_firmware_folder_at_all_is_missing(monkeypatch, tmp_path):
    patch(monkeypatch)
    monkeypatch.setattr(benchcheck, "FIRMWARE_DIRS", (tmp_path / "none",))
    assert not by_id()["fx2lafw"]["ok"]


def test_the_route_needs_the_session_token_and_lists_the_checks(client, monkeypatch, tmp_path):  # noqa: F811
    patch(monkeypatch, tmp_path)
    assert client.get("/api/bench-check").status_code == 401
    answer = client.get("/api/bench-check", headers=AUTH)
    assert answer.status_code == 200
    assert [c["id"] for c in answer.json()["checks"]] == ["serial-group", "sigrok", "fx2lafw", "gitleaks"]
