"""The tutorial's practice board: an ordinary board in the practice folder (see `boards.practice_path`), with
the synthetic router's front photo and the practice logic capture, and nothing marked on it yet.

It lives outside the boards root, so it is never listed, committed or pushed with the user's boards, and
starting the tutorial again can delete it without touching user data.
"""
from __future__ import annotations

from importlib import resources
from pathlib import Path

from .board import JOURNAL_REL, Board
from .boards import TUTORIAL_SLUG, practice_path, practice_root
from .demo import add_logic_capture
from .fsutil import Directory, ensure_directory
from .photos import ingest
from .schema import now_iso
from .settings import assistant_on

ACTOR = "tutorial"
META = {
    "device": "Synthetic dual-band router, rev B",
    "notes": "The practice board of the tutorial. The photo is a drawing, and every reading on it is made up, "
             "so feel free to change anything. Starting the tutorial again builds it fresh.",
}


def create_tutorial(practice: Path | None = None) -> Path:
    """Create the practice board if it is not there, and return its folder."""
    root = Path(practice) if practice else practice_root()
    directory = practice_path(root)
    if (directory / JOURNAL_REL).is_file():
        return directory
    ensure_directory(root)
    if directory.exists():                 # a half-built folder from an earlier crash
        _remove(root)
    board = Board.create(directory, "Tutorial router", actor=ACTOR, agents_md=assistant_on())
    try:
        board.apply({"type": "project/metaUpdated", "patch": META}, ACTOR)
        photo = (resources.files("pcbv") / "demo" / "board-front.png").read_bytes()
        board.apply({"type": "asset/added", "asset": ingest(board.files, photo, label="Front", side="front")}, ACTOR)
        add_logic_capture(board, ACTOR, now_iso())
    finally:
        board.close()
    return directory


def reset_tutorial(practice: Path | None = None) -> Path:
    """Remove the practice board and build it again."""
    root = Path(practice) if practice else practice_root()
    if root.is_dir() and practice_path(root).exists():  # practice_path refuses a symlink before anything is touched
        _remove(root)
    return create_tutorial(practice)


def _remove(root: Path) -> None:
    with Directory(root) as directory:
        directory.remove_tree(TUTORIAL_SLUG)
