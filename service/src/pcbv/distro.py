"""The Linux distribution family, for install commands, and the group that owns serial ports."""
from __future__ import annotations

import grp
import os
from collections.abc import Iterable
from pathlib import Path

OS_RELEASE = Path("/etc/os-release")
MAX_OS_RELEASE = 64 * 1024
INSTALL = {"arch": "sudo pacman -S", "debian": "sudo apt install", "fedora": "sudo dnf install"}
# Derivatives that name only their parent's parent in ID_LIKE.
ALIASES = {"ubuntu": "debian"}


def family(os_release: Path = OS_RELEASE) -> str | None:
    """The family from ID and ID_LIKE in os-release: arch, debian, fedora, or None for anything else."""
    try:
        with open(os_release, "rb") as file:
            text = file.read(MAX_OS_RELEASE).decode("utf-8", "replace")
    except OSError:
        return None
    fields = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            fields[key.strip()] = value.strip().strip("\"'")
    for name in (fields.get("ID", ""), *fields.get("ID_LIKE", "").split()):
        name = ALIASES.get(name, name)
        if name in INSTALL:
            return name
    return None


def install_command(packages: list[str], fam: str | None) -> str | None:
    return f"{INSTALL[fam]} {' '.join(packages)}" if fam in INSTALL else None


def install_fix(packages: list[str], fam: str | None) -> str:
    """The install command, or for an unknown distribution a sentence that names the packages."""
    return install_command(packages, fam) or f"Install {' '.join(packages)} with your package manager."


def devices() -> list[Path]:
    """USB and ACM adapters first, because those are the ones people plug in, then the first built-in port."""
    dev = Path("/dev")
    return [*sorted(dev.glob("ttyUSB*")), *sorted(dev.glob("ttyACM*")), dev / "ttyS0"]


def group_of(path: str | os.PathLike) -> str | None:
    """The group that owns a device, or None when it is missing, has no group name or belongs to root."""
    try:
        gid = os.stat(path).st_gid
        return grp.getgrgid(gid).gr_name if gid != 0 else None
    except (OSError, KeyError):
        return None


def serial_group(paths: Iterable[str | os.PathLike] | None = None) -> str:
    """The group a person joins for serial port access: the owner of the first device found, else
    dialout (Debian, Ubuntu, Fedora) when that group exists, else uucp (Arch)."""
    for path in devices() if paths is None else paths:
        name = group_of(path)
        if name:
            return name
    try:
        grp.getgrnam("dialout")
    except KeyError:
        return "uucp"
    return "dialout"
