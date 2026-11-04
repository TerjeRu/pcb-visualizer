"""Checks the bench needs that the app cannot fix itself: serial port access and the optional tools.

Nothing here runs a command or changes anything; each check reports whether it passes and, when it does
not, the command the person can run.
"""
from __future__ import annotations

import grp
import os
import shutil
from pathlib import Path

# Where libsigrok looks for firmware on Arch. The FX2 analyzer firmware is a separate package from
# sigrok-cli, so a working sigrok-cli does not mean an FX2 analyzer will start.
FIRMWARE_DIRS = (Path("/usr/share/sigrok-firmware"), Path("/usr/local/share/sigrok-firmware"))


def _in_uucp() -> bool:
    try:
        return grp.getgrnam("uucp").gr_gid in os.getgroups()
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
    return [
        {"id": "serial-group", "ok": _in_uucp(),
         "label": "You are in the uucp group, which gives access to serial adapters.",
         "fix": "sudo usermod -aG uucp $USER, then log out and in"},
        {"id": "sigrok", "ok": shutil.which("sigrok-cli") is not None,
         "label": "sigrok-cli is installed. It is needed only to record logic captures.",
         "fix": "sudo pacman -S sigrok-cli pulseview sigrok-firmware-fx2lafw"},
        {"id": "fx2lafw", "ok": _has_fx2_firmware(),
         "label": "The firmware for FX2-based logic analyzers is installed. It is needed only for those "
                  "analyzers; unplug the analyzer and plug it in again after installing it.",
         "fix": "sudo pacman -S sigrok-firmware-fx2lafw"},
        {"id": "gitleaks", "ok": shutil.which("gitleaks") is not None,
         "label": "gitleaks is installed. It is needed only for git backup.",
         "fix": "sudo pacman -S gitleaks"},
    ]
