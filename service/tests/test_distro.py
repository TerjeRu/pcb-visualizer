import grp
import types

import pytest

from pcbv import distro

OS_RELEASE = {
    "arch": 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n',
    "manjaro": 'NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\n',
    "endeavouros": 'NAME="EndeavourOS"\nID="endeavouros"\nID_LIKE="arch"\n',
    "debian": 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n',
    "ubuntu": 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
    "mint": 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
    "fedora": 'NAME="Fedora Linux"\nVERSION_ID=45\nID=fedora\n',
    "opensuse": 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
    "empty": "",
}
FAMILY = {"arch": "arch", "manjaro": "arch", "endeavouros": "arch", "debian": "debian", "ubuntu": "debian",
          "mint": "debian", "fedora": "fedora", "opensuse": None, "empty": None}


@pytest.mark.parametrize("name", OS_RELEASE)
def test_the_family_comes_from_id_and_id_like(tmp_path, name):
    path = tmp_path / "os-release"
    path.write_text(OS_RELEASE[name])
    assert distro.family(path) == FAMILY[name]


def test_a_missing_or_unreadable_file_has_no_family(tmp_path):
    assert distro.family(tmp_path / "missing") is None
    assert distro.family(tmp_path) is None


def test_only_the_first_64_kib_are_read(tmp_path):
    path = tmp_path / "os-release"
    path.write_text("X=" + "a" * distro.MAX_OS_RELEASE + "\nID=arch\n")
    assert distro.family(path) is None


@pytest.mark.parametrize("fam, command", [
    ("arch", "sudo pacman -S sigrok-cli pulseview"),
    ("debian", "sudo apt install sigrok-cli pulseview"),
    ("fedora", "sudo dnf install sigrok-cli pulseview"),
    (None, None),
])
def test_the_install_command_follows_the_family(fam, command):
    assert distro.install_command(["sigrok-cli", "pulseview"], fam) == command


def test_without_a_family_the_fix_names_the_packages():
    assert distro.install_fix(["gitleaks"], None) == "Install gitleaks with your package manager."
    assert distro.install_fix(["gitleaks"], "fedora") == "sudo dnf install gitleaks"


@pytest.fixture
def groups(monkeypatch):
    """Group names by gid, and the names that exist; a test fills both."""
    known = {}

    def getgrgid(gid):
        if gid not in known:
            raise KeyError(gid)
        return types.SimpleNamespace(gr_name=known[gid], gr_gid=gid)

    def getgrnam(name):
        for gid, known_name in known.items():
            if known_name == name:
                return types.SimpleNamespace(gr_name=name, gr_gid=gid)
        raise KeyError(name)

    monkeypatch.setattr(grp, "getgrgid", getgrgid)
    monkeypatch.setattr(grp, "getgrnam", getgrnam)
    return known


def device(tmp_path, name):
    path = tmp_path / name
    path.write_bytes(b"")
    return path


@pytest.mark.parametrize("owner", ["dialout", "uucp"])
def test_the_serial_group_is_the_one_that_owns_the_first_device(tmp_path, groups, owner):
    port = device(tmp_path, "ttyUSB0")
    groups[port.stat().st_gid] = owner
    groups[99999] = "uucp" if owner == "dialout" else "dialout"
    assert distro.serial_group([tmp_path / "ttyUSB9", port]) == owner
    assert distro.group_of(port) == owner


def test_a_device_owned_by_root_does_not_name_the_root_group(tmp_path, groups, monkeypatch):
    port = device(tmp_path, "ttyS0")
    monkeypatch.setattr("os.stat", lambda path: types.SimpleNamespace(st_gid=0))
    groups[0] = "root"
    groups[20] = "dialout"
    assert distro.group_of(port) is None
    assert distro.serial_group([port]) == "dialout"


def test_without_devices_dialout_wins_when_it_exists(tmp_path, groups):
    groups.update({10: "uucp", 20: "dialout"})
    assert distro.serial_group([tmp_path / "ttyUSB0"]) == "dialout"


def test_without_devices_or_dialout_the_group_is_uucp(tmp_path, groups):
    groups[987] = "uucp"
    assert distro.serial_group([]) == "uucp"


def test_the_default_devices_are_adapters_first_then_ttyS0(monkeypatch):
    found = {"ttyUSB*": ["/dev/ttyUSB1", "/dev/ttyUSB0"], "ttyACM*": ["/dev/ttyACM0"]}
    monkeypatch.setattr(distro.Path, "glob", lambda self, pattern: [distro.Path(p) for p in found.get(pattern, [])])
    assert [str(p) for p in distro.devices()] == ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyACM0", "/dev/ttyS0"]
