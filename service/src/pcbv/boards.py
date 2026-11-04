"""The boards root (default ~/hw/boards): slugs, confinement and listing.

Every board is addressed by a slug. Slugs are validated, never joined blindly,
and the resolved path must be a direct child of the root, so neither `../x`,
an absolute path nor a symlink planted in the root can point the service at
files outside it.

One slug, `pcbv-tutorial`, is reserved for the tutorial's practice board. It never resolves in the boards
root; `practice_path` resolves it, and only it, in the practice folder under `$XDG_DATA_HOME/pcbv`, with
the same confinement. Practice boards stay out of the data repository that holds the boards root.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from .board import JOURNAL_REL

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
TUTORIAL_SLUG = "pcbv-tutorial"


class InvalidSlug(ValueError):
    pass


def default_root() -> Path:
    return Path(os.environ.get("PCBV_BOARDS_ROOT", Path.home() / "hw" / "boards"))


def practice_root() -> Path:
    base = os.environ.get("XDG_DATA_HOME")
    return (Path(base) if base else Path.home() / ".local" / "share") / "pcbv" / "practice"


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:64].strip("-")
    if not slug:
        raise InvalidSlug(f"cannot make a folder name out of {name!r}; use letters or digits")
    return slug


def board_path(root: Path, slug: str) -> Path:
    """Resolve a slug to a board folder inside root, or raise InvalidSlug."""
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise InvalidSlug(f"invalid board name {slug!r}")
    if slug == TUTORIAL_SLUG:
        raise InvalidSlug(f"{TUTORIAL_SLUG} is reserved for the tutorial")
    return _child(root, slug, "the boards root")


def practice_path(root: Path | None = None) -> Path:
    """The tutorial's practice board folder. A symlink in place of the practice folder or the board is refused."""
    root = Path(root) if root else practice_root()
    if root.is_symlink():
        raise InvalidSlug("the practice folder is a symlink")
    return _child(root, TUTORIAL_SLUG, "the practice folder")


def _child(root: Path, slug: str, where: str) -> Path:
    root_real = Path(root).resolve()
    candidate = root_real / slug
    if candidate.is_symlink() or candidate.parent != root_real:
        raise InvalidSlug(f"board {slug!r} resolves outside {where}")
    return candidate


def list_boards(root: Path) -> list[str]:
    root = Path(root)
    if not root.is_dir():
        return []
    found = []
    for child in sorted(root.iterdir()):
        if SLUG_RE.match(child.name) and (child / JOURNAL_REL).is_file():
            try:
                board_path(root, child.name)
            except InvalidSlug:
                continue  # symlink pointing elsewhere: not listed, not openable
            found.append(child.name)
    return found
