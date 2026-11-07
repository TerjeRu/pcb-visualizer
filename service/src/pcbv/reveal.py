"""Show a folder in the desktop's file manager."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from . import distro


class NoFileManager(OSError):
    """xdg-open is not installed."""


def no_file_manager_message() -> str:
    command = distro.install_command(["xdg-utils"], distro.family())
    hint = f"Install xdg-utils: {command}" if command else "Install xdg-utils with your package manager."
    return f"The file manager could not be started. {hint}"


def start(program: str, folder: Path) -> None:
    subprocess.Popen(  # noqa: S603 - xdg-open and the service's own folder, no shell
        [program, str(folder)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True)


def reveal(folder: Path) -> bool:
    """Start the file manager on `folder` without waiting. False when PCBV_NO_REVEAL=1 turns it off."""
    if os.environ.get("PCBV_NO_REVEAL") == "1":
        return False
    program = shutil.which("xdg-open")
    if program is None:
        raise NoFileManager(no_file_manager_message())
    start(program, folder)
    return True
