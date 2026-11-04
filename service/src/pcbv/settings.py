"""App settings per machine, shared by the browser app, the desktop shell and the assistant.

Stored in `$XDG_CONFIG_HOME/pcbv/settings.json`. `guidance` is "guided" for the beginner path (steps in
order, explanations, hints) or "expert" for the same tools without them. `theme` is "system" (follow the
desktop's light or dark preference), "light" or "dark". `assistant` and `git` are "off" or "on" and start
off. A file that does not have them yet gets them once, from what the machine already has: an
`assistant.json` means the assistant was set up, and a data folder that is a git repository with the commit
guard active means git was set up. `welcomed` is a bool, false until the first-start Welcome has been
skipped or a board opened; a file that lacks it gets true when the boards folder already holds a board, so an
existing install never sees the Welcome. `tutorial` is "new", "skipped", "started" or "done", and `tutorialStep`
(1 to 18) is where a started tutorial resumes; a file without `tutorial` gets "skipped" when `welcomed` is true
(an existing user is not offered the tutorial on their own), else "new". Board files do not depend on any of these.
"""
from __future__ import annotations

import json
import threading
from typing import Any

from pathlib import Path

from .boards import default_root, list_boards
from .datarepo import HOOKS_DIR, find_repo, git
from .fsutil import atomic_write
from .workspaces import config_dir

GUIDANCE = ("guided", "expert")
THEMES = ("system", "light", "dark")
SWITCHES = ("off", "on")
TUTORIAL_STATES = ("new", "skipped", "started", "done")
TUTORIAL_STEPS = 18


class SettingsError(ValueError):
    pass


def defaults() -> dict:
    return {"guidance": "guided", "theme": "system", "assistant": "off", "git": "off", "welcomed": False,
            "tutorial": "new", "tutorialStep": 1}


def validate(data: Any, base: dict | None = None) -> dict:
    """Clean settings from `data`; keys it leaves out keep their value in `base`, else the default."""
    if not isinstance(data, dict):
        raise SettingsError("settings must be an object")
    unknown = set(data) - set(defaults())
    if unknown:
        raise SettingsError(f"unknown settings: {', '.join(sorted(unknown))}")
    clean = {**defaults(), **(base or {})}
    if "guidance" in data:
        if data["guidance"] not in GUIDANCE:
            raise SettingsError(f"guidance must be one of {', '.join(GUIDANCE)}")
        clean["guidance"] = data["guidance"]
    if "theme" in data:
        if data["theme"] not in THEMES:
            raise SettingsError(f"theme must be one of {', '.join(THEMES)}")
        clean["theme"] = data["theme"]
    for key in ("assistant", "git"):
        if key in data:
            if data[key] not in SWITCHES:
                raise SettingsError(f"{key} must be one of {', '.join(SWITCHES)}")
            clean[key] = data[key]
    if "welcomed" in data:
        if not isinstance(data["welcomed"], bool):
            raise SettingsError("welcomed must be true or false")
        clean["welcomed"] = data["welcomed"]
    if "tutorial" in data:
        if data["tutorial"] not in TUTORIAL_STATES:
            raise SettingsError(f"tutorial must be one of {', '.join(TUTORIAL_STATES)}")
        clean["tutorial"] = data["tutorial"]
    if "tutorialStep" in data:
        step = data["tutorialStep"]
        if type(step) is not int or not 1 <= step <= TUTORIAL_STEPS:
            raise SettingsError(f"tutorialStep must be a whole number from 1 to {TUTORIAL_STEPS}")
        clean["tutorialStep"] = step
    return clean


def _git_set_up(data_folder: Path) -> bool:
    """Is the data folder itself a git repository with the commit guard active?"""
    try:
        if find_repo(data_folder) != data_folder.resolve():
            return False
        return git(data_folder, "config", "--get", "core.hooksPath", check=False).stdout.strip() == HOOKS_DIR
    except OSError:                    # git is not installed
        return False


def _read(root: Path | None) -> tuple[dict, bool]:
    """The saved settings, and whether keys were missing and got their one-time value. A missing file
    counts as empty; an unreadable one gives the defaults, and nothing is to be written over it."""
    path = config_dir() / "settings.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raw = {}
    except (OSError, ValueError):
        return defaults(), False
    try:
        if not isinstance(raw, dict):
            raise SettingsError("settings must be an object")
        missing = {"assistant", "git", "welcomed", "tutorial"} - set(raw)
        if "assistant" in missing:
            raw["assistant"] = "on" if (config_dir() / "assistant.json").exists() else "off"
        if "git" in missing:
            raw["git"] = "on" if _git_set_up((Path(root) if root else default_root()).parent) else "off"
        if "welcomed" in missing:
            raw["welcomed"] = bool(list_boards(Path(root) if root else default_root()))
        if "tutorial" in missing:
            raw["tutorial"] = "skipped" if raw.get("welcomed") is True else "new"
        return validate(raw), bool(missing)
    except SettingsError:
        return defaults(), False


_save_lock = threading.Lock()


def _write(clean: dict) -> None:
    path = config_dir() / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, (json.dumps(clean, indent=2) + "\n").encode())


def load(root: Path | None = None) -> dict:
    """Saved settings over the defaults, with the one-time values for `assistant`, `git`, `welcomed` and `tutorial` written
    back when the file lacked them. `root` is the boards folder; its parent is the data folder. A
    missing or unreadable file gives the defaults."""
    with _save_lock:
        clean, migrated = _read(root)
        if migrated:
            _write(clean)
        return clean


def save(data: Any, root: Path | None = None) -> dict:
    with _save_lock:
        clean = validate(data, base=_read(root)[0])
        _write(clean)
        return clean


def assistant_on(root: Path | None = None) -> bool:
    return load(root)["assistant"] == "on"
