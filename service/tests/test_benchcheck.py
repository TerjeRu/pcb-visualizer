import grp
import types

import pytest

from pcbv import benchcheck, datarepo, distro

from test_settings import AUTH, client  # noqa: F401  (the shared app fixture)


def patch(monkeypatch, tmp_path=None, *, groups=(20,), uucp=20, dialout=None, fam="arch", gitleaks=None,
          tools=("sigrok-cli", "gitleaks"), firmware=("fx2lafw-saleae-logic.fw",)):
    known = {"uucp": uucp, "dialout": dialout}

    def getgrnam(name):
        if known.get(name) is None:
            raise KeyError(name)
        return types.SimpleNamespace(gr_gid=known[name])
    monkeypatch.setattr(grp, "getgrnam", getgrnam)
    monkeypatch.setattr(distro, "devices", lambda: [])
    monkeypatch.setattr(distro, "family", lambda: fam)
    state = gitleaks or ("ok" if "gitleaks" in tools else "missing")
    monkeypatch.setattr(datarepo, "gitleaks_status", lambda: state)
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


def test_a_debian_like_setup_names_the_dialout_group(monkeypatch):
    patch(monkeypatch, groups=(1000,), uucp=10, dialout=20, fam="debian")
    check = by_id()["serial-group"]
    assert not check["ok"] and "dialout group" in check["label"]
    assert check["fix"] == "sudo usermod -aG dialout $USER, then log out and in"
    patch(monkeypatch, groups=(20,), uucp=10, dialout=20, fam="debian")
    assert by_id()["serial-group"]["ok"]


def test_on_arch_the_group_is_uucp(monkeypatch):
    patch(monkeypatch, groups=(20,), uucp=20, dialout=None)
    check = by_id()["serial-group"]
    assert check["ok"] and "uucp group" in check["label"]


def test_the_group_comes_from_the_adapter_that_is_plugged_in(monkeypatch, tmp_path):
    patch(monkeypatch, groups=(20,), uucp=20, dialout=None)
    port = tmp_path / "ttyUSB0"
    port.write_bytes(b"")
    monkeypatch.setattr(distro, "devices", lambda: [port])
    monkeypatch.setattr(grp, "getgrgid", lambda gid: types.SimpleNamespace(gr_name="plugdev"))
    assert "plugdev group" in by_id()["serial-group"]["label"]


@pytest.mark.parametrize("fam, command", [("arch", "sudo pacman -S"), ("debian", "sudo apt install"), ("fedora", "sudo dnf install")])
def test_install_commands_follow_the_distribution(monkeypatch, fam, command):
    patch(monkeypatch, tools=(), firmware=(), fam=fam)
    found = by_id()
    assert found["sigrok"]["fix"] == f"{command} sigrok-cli pulseview sigrok-firmware-fx2lafw"
    assert found["fx2lafw"]["fix"] == f"{command} sigrok-firmware-fx2lafw"


def test_an_unknown_distribution_gets_the_package_names(monkeypatch):
    patch(monkeypatch, tools=(), fam=None)
    assert by_id()["sigrok"]["fix"] == "Install sigrok-cli pulseview sigrok-firmware-fx2lafw with your package manager."


def test_missing_tools_fail_with_the_pacman_command(monkeypatch):
    patch(monkeypatch, tools=())
    found = by_id()
    assert not found["sigrok"]["ok"] and found["sigrok"]["fix"].startswith("sudo pacman -S sigrok-cli")
    assert not found["gitleaks"]["ok"] and found["gitleaks"]["fix"] == "sudo pacman -S gitleaks"


@pytest.mark.parametrize("state, fam, ok, fix", [
    ("ok", "debian", True, None),
    ("missing", "fedora", False, "sudo dnf install gitleaks"),
    ("too-old", "arch", False, "sudo pacman -S gitleaks"),
    ("too-old", "debian", False, "Download gitleaks 8.21 or newer from https://github.com/gitleaks/gitleaks/releases"),
    ("missing", "debian", False, "Download gitleaks 8.21 or newer from https://github.com/gitleaks/gitleaks/releases"),
])
def test_the_gitleaks_check_runs_the_probe_and_never_suggests_the_old_debian_package(monkeypatch, state, fam, ok, fix):
    patch(monkeypatch, gitleaks=state, fam=fam)
    check = by_id()["gitleaks"]
    assert check["ok"] is ok and "8.21 or newer" in check["label"]
    if fix:
        assert check["fix"] == fix


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
