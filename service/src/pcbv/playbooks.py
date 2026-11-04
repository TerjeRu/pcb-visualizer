"""Playbooks: guided procedures stored as YAML, built in and from the data repo.

Built-in playbooks ship in `pcbv/playbooks/`. Files in `<data repo>/playbooks/` (default
~/hw/playbooks) are loaded after them; one with the same `id` replaces the built-in, so the
wording can be edited without touching code. Every file is validated strictly: unknown keys are
errors, so a typo cannot silently drop a safety gate. A broken file is reported and skipped, and
the rest still load.

The service only loads and serves playbooks. Checks are evaluated by the app against the live
board (app/js/core/checks.js); progress is stored on the board with `playbook/updated` events.
See docs/PLAYBOOKS.md for the format.
"""
from __future__ import annotations

import re
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_FILE_BYTES = 256_000
SIDES = {"front", "back", "detail", "other"}
MODES = {"dc", "ohm", "continuity"}

# check kind -> {param: (type check, required)}
CHECKS: dict[str, dict[str, tuple[Any, bool]]] = {
    "photos": {"min": (int, False), "side": (str, False)},
    "meta": {"field": (str, True)},
    "markers": {"min": (int, False)},
    "pin_role": {"roles": (list, True)},
    "reading": {"mode": (list, False), "powered": (bool, False), "min": ((int, float), False),
                "max": ((int, float), False), "role": (str, False), "count": (int, False)},
    "uart_header": {},
    "capture": {"seen": (list, False), "seen_any": (list, False), "baud": (int, False), "min_bytes": (int, False)},
    "logic": {"decoded": (bool, False), "baud": (int, False), "min_bytes": (int, False), "seen": (list, False),
              "seen_any": (list, False), "compared": (bool, False), "min_ratio": ((int, float), False)},
}
# What a console session can recognise (pcbv.serialmgr.SIGNS), for capture checks.
SIGN_KINDS = {"bootloader", "autoboot", "uboot-prompt", "env", "help", "kernel", "shell", "login"}
PLAYBOOK_KEYS = {"id", "version", "title", "summary", "requires", "steps"}
STEP_KEYS = {"id", "title", "why", "do", "done_when", "gates", "ask", "checks", "wiki"}
GATE_KEYS = {"id", "text", "destructive"}
ASK_KEYS = {"id", "label", "placeholder", "required"}


class PlaybookError(ValueError):
    pass


def _need(cond: bool, where: str, message: str) -> None:
    if not cond:
        raise PlaybookError(f"{where}: {message}")


def _keys(obj: Any, allowed: set[str], where: str) -> None:
    _need(isinstance(obj, dict), where, "must be a mapping")
    unknown = set(obj) - allowed
    _need(not unknown, where, f"unknown key(s) {', '.join(sorted(unknown))}; allowed: {', '.join(sorted(allowed))}")


def _text(obj: dict, key: str, where: str, required: bool = True) -> None:
    if key in obj or required:
        _need(isinstance(obj.get(key), str) and obj[key].strip() != "", where, f"{key} must be non-empty text")


def _ident(obj: dict, where: str, seen: set[str]) -> str:
    ident = obj.get("id")
    _need(isinstance(ident, str) and bool(ID_RE.match(ident)), where, "id must be lowercase letters, digits and dashes")
    _need(ident not in seen, where, f"duplicate id {ident!r}")
    seen.add(ident)
    return ident


def validate(data: Any) -> dict:
    """Return the playbook with defaults filled in, or raise PlaybookError naming the problem."""
    _keys(data, PLAYBOOK_KEYS, "playbook")
    pid = _ident(data, "playbook", set())
    where = f"playbook {pid}"
    _need(isinstance(data.get("version", 1), int), where, "version must be an integer")
    _text(data, "title", where)
    _text(data, "summary", where, required=False)
    requires = data.get("requires", [])
    _need(isinstance(requires, list) and all(isinstance(r, str) and ID_RE.match(r) for r in requires), where,
          "requires must be a list of playbook ids")
    steps = data.get("steps")
    _need(isinstance(steps, list) and steps, where, "needs at least one step")

    step_ids: set[str] = set()
    out_steps = []
    for n, step in enumerate(steps, start=1):
        _keys(step, STEP_KEYS, f"{where} step {n}")
        sid = _ident(step, f"{where} step {n}", step_ids)
        swhere = f"{where} step {sid}"
        _text(step, "title", swhere)
        _text(step, "why", swhere)
        _text(step, "do", swhere)
        _text(step, "done_when", swhere, required=False)

        gates, gate_ids = [], set()
        for gate in step.get("gates", []):
            _keys(gate, GATE_KEYS, f"{swhere} gate")
            _ident(gate, f"{swhere} gate", gate_ids)
            _text(gate, "text", f"{swhere} gate {gate['id']}")
            _need(isinstance(gate.get("destructive", False), bool), swhere, "destructive must be true or false")
            gates.append({"destructive": False, **gate})

        asks, ask_ids = [], set()
        for ask in step.get("ask", []):
            _keys(ask, ASK_KEYS, f"{swhere} ask")
            _ident(ask, f"{swhere} ask", ask_ids)
            _text(ask, "label", f"{swhere} ask {ask['id']}")
            _text(ask, "placeholder", f"{swhere} ask {ask['id']}", required=False)
            _need(isinstance(ask.get("required", True), bool), swhere, "required must be true or false")
            asks.append({"required": True, **ask})

        checks = []
        for check in step.get("checks", []):
            _need(isinstance(check, dict), swhere, "each check must be a mapping")
            kind = check.get("kind")
            _need(kind in CHECKS, swhere, f"unknown check kind {kind!r}; known: {', '.join(sorted(CHECKS))}")
            params = CHECKS[kind]
            _keys(check, {"kind", "text", *params}, f"{swhere} check {kind}")
            _text(check, "text", f"{swhere} check {kind}")
            for name, (kind_type, required) in params.items():
                if required:
                    _need(name in check, swhere, f"check {kind} needs {name}")
                if name in check:
                    value = check[name]
                    ok = isinstance(value, kind_type) and not (kind_type is int and isinstance(value, bool))
                    _need(ok, swhere, f"check {kind}: {name} has the wrong type")
            if kind == "photos" and "side" in check:
                _need(check["side"] in SIDES, swhere, f"check photos: side must be one of {', '.join(sorted(SIDES))}")
            if kind in ("capture", "logic"):
                for name in ("seen", "seen_any"):
                    if name in check:
                        unknown = set(check[name]) - SIGN_KINDS
                        _need(not unknown and check[name], swhere,
                              f"check {kind}: {name} must be from {', '.join(sorted(SIGN_KINDS))}")
            if kind == "logic" and "min_ratio" in check:
                ratio = check["min_ratio"]
                _need(not isinstance(ratio, bool) and 0 <= ratio <= 1, swhere,
                      "check logic: min_ratio must be a number from 0 to 1")
            if kind == "reading" and "mode" in check:
                _need(set(check["mode"]) <= MODES and check["mode"], swhere, f"check reading: mode must be from {', '.join(sorted(MODES))}")
            checks.append(check)

        wiki = step.get("wiki", [])
        _need(isinstance(wiki, list) and all(isinstance(w, str) and ID_RE.match(w) for w in wiki), swhere,
              "wiki must be a list of page names")
        out_steps.append({**step, "gates": gates, "ask": asks, "checks": checks, "wiki": wiki})

    return {"version": 1, "summary": "", "requires": [], **data, "steps": out_steps}


def _load_file(path: Path) -> dict:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise PlaybookError(f"larger than {MAX_FILE_BYTES // 1000} kB")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (yaml.YAMLError, UnicodeDecodeError) as exc:
        raise PlaybookError(f"not valid YAML: {exc}") from None
    return validate(data)


def builtin_dir() -> Path:
    return Path(str(resources.files("pcbv") / "playbooks"))


def load_all(user_dir: Path | None = None) -> tuple[list[dict], list[dict]]:
    """All playbooks (built in, then the data repo's, same id replaces) and the problems found."""
    found: dict[str, dict] = {}
    problems: list[dict] = []
    sources = [("builtin", builtin_dir())]
    if user_dir is not None and Path(user_dir).is_dir():
        sources.append(("data repo", Path(user_dir)))
    for origin, directory in sources:
        for path in sorted(directory.glob("*.y*ml")):
            if not path.is_file() or path.suffix not in (".yaml", ".yml"):
                continue
            try:
                playbook = _load_file(path)
            except (PlaybookError, OSError) as exc:
                problems.append({"file": str(path), "message": str(exc)})
                continue
            found[playbook["id"]] = {**playbook, "origin": origin, "file": path.name}
    ordered = sorted(found.values(), key=lambda p: p["file"])   # 01-..., 02-... sets the order
    return ordered, problems
