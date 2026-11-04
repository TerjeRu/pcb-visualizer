"""Wiki pages: Markdown files, built in and from the data repo.

Starter pages ship in `pcbv/wiki/`. Pages in `<data repo>/wiki/` (default ~/hw/wiki) are read
after them, and a page with the same name replaces the built-in one, so you can rewrite a page in
your own words. A page's name is its file name without `.md`; its title is its first `# ` heading.
Pages are read from disk on every request, so an edit shows up on the next click.

`contents.yaml` in the built-in folder groups pages into sections in reading order. Pages it does
not name are listed after them: data repo pages under "Your pages", others under "More". Figures
(`.svg`, `.png`) sit next to the pages and follow the same replacement rule.
"""
from __future__ import annotations

import re
from importlib import resources
from pathlib import Path

import yaml

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_PAGE_BYTES = 512_000
FIGURE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}\.(svg|png)$")
FIGURE_TYPES = {"svg": "image/svg+xml", "png": "image/png"}
MAX_FIGURE_BYTES = 1_000_000


def builtin_dir() -> Path:
    return Path(str(resources.files("pcbv") / "wiki"))


def _title(text: str, name: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()[:120] or name
    return name.replace("-", " ").capitalize()


def _sources(user_dir: Path | None) -> list[tuple[str, Path]]:
    sources = [("builtin", builtin_dir())]
    if user_dir is not None and Path(user_dir).is_dir():
        sources.append(("data repo", Path(user_dir)))
    return sources


def _read(path: Path) -> str | None:
    """Page text, or None for anything that is not a small regular UTF-8 file (symlinks included)."""
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_PAGE_BYTES:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def contents() -> list[dict]:
    """The built-in sections as [{title, pages}], in reading order."""
    data = yaml.safe_load((builtin_dir() / "contents.yaml").read_text(encoding="utf-8")) or {}
    return [{"title": str(sec["title"]), "pages": [str(p) for p in sec.get("pages", [])]} for sec in data.get("sections", [])]


def list_pages(user_dir: Path | None = None) -> list[dict]:
    """Every page as {name, title, origin, section}, in index order. Data repo pages replace built-in ones."""
    pages: dict[str, dict] = {}
    for origin, directory in _sources(user_dir):
        for path in directory.glob("*.md"):
            name = path.stem
            text = _read(path) if NAME_RE.match(name) else None
            if text is not None:
                pages[name] = {"name": name, "title": _title(text, name), "origin": origin}
    ordered = []
    for section in contents():
        for name in section["pages"]:
            if name in pages:
                ordered.append({**pages.pop(name), "section": section["title"]})
    for rest in ("Your pages", "More"):
        mine = [p for p in pages.values() if (p["origin"] == "data repo") == (rest == "Your pages")]
        ordered += [{**p, "section": rest} for p in sorted(mine, key=lambda p: p["title"].lower())]
    return ordered


def get_page(name: str, user_dir: Path | None = None) -> dict | None:
    """One page as {name, title, origin, markdown}, or None when there is no such page."""
    if not isinstance(name, str) or not NAME_RE.match(name):
        return None
    for origin, directory in reversed(_sources(user_dir)):
        text = _read(directory / f"{name}.md")
        if text is not None:
            return {"name": name, "title": _title(text, name), "origin": origin, "markdown": text}
    return None


def get_figure(file: str, user_dir: Path | None = None) -> tuple[Path, str] | None:
    """A figure's path and media type, or None for a bad name, a symlink, or a file over the size limit."""
    match = FIGURE_RE.match(file) if isinstance(file, str) else None
    if not match:
        return None
    for _, directory in reversed(_sources(user_dir)):
        path = directory / file
        try:
            if not path.is_symlink() and path.is_file() and path.stat().st_size <= MAX_FIGURE_BYTES:
                return path, FIGURE_TYPES[match.group(1)]
        except OSError:
            continue
    return None
