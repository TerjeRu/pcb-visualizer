"""Checks the bench needs that the app cannot fix itself: serial port access and the optional tools.

Nothing here changes anything. The only command it runs is the gitleaks probe in `datarepo`, once per
gitleaks binary. Each check reports whether it passes and, when it does not, what the person can do.
"""
from __future__ import annotations

import grp
import os
import shutil
from pathlib import Path

from . import datarepo, distro

# Where libsigrok looks for firmware on Arch and Debian. The FX2 analyzer firmware is a separate package from
# sigrok-cli, so a working sigrok-cli does not mean an FX2 analyzer will start.
FIRMWARE_DIRS = (Path("/usr/share/sigrok-firmware"), Path("/usr/local/share/sigrok-firmware"))


def _in_group(name: str) -> bool:
    try:
        return grp.getgrnam(name).gr_gid in os.getgroups()
    except KeyError:
        return False


def _has_fx2_firmware() -> bool:
    for folder in FIRMWARE_DIRS:
        try:
            if any(folder.glob("fx2lafw-*.fw")):
                return True
        except OSError:
            continue
    return False


def checks() -> list[dict]:
    fam = distro.family()
    group = distro.serial_group()
    return [
        {"id": "serial-group", "ok": _in_group(group),
         "label": f"You are in the {group} group, which gives access to serial adapters.",
         "fix": f"sudo usermod -aG {group} $USER, then log out and in"},
        {"id": "sigrok", "ok": shutil.which("sigrok-cli") is not None,
         "label": "sigrok-cli is installed. It is needed only to record logic captures.",
         "fix": distro.install_fix(["sigrok-cli", "pulseview", "sigrok-firmware-fx2lafw"], fam)},
        {"id": "fx2lafw", "ok": _has_fx2_firmware(),
         "label": "The firmware for FX2-based logic analyzers is installed. It is needed only for those "
                  "analyzers; unplug the analyzer and plug it in again after installing it.",
         "fix": distro.install_fix(["sigrok-firmware-fx2lafw"], fam)},
        {"id": "gitleaks", "ok": datarepo.gitleaks_status() == "ok",
         "label": f"gitleaks {datarepo.GITLEAKS_MIN} or newer is installed. It is needed only for git backup.",
         "fix": datarepo.gitleaks_fix(fam)},
    ]
