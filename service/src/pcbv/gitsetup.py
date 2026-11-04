"""Turning on git for the data folder: the checks, the five setup steps and the remote address rules.

Every step looks at the folder again and trusts nothing the browser claims. A step that cannot finish
returns `ok: False` with the reason; the person fixes it and runs the same step again. Local steps can
be repeated safely. Nothing here deletes data, and an existing remote is replaced only when the caller
confirms the exact replacement.
"""
from __future__ import annotations

import re
import shutil
import threading
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

from . import github
from .datarepo import RepoError, find_repo, git, guard_problem, init_repo, redact, run, sync

STEPS = ("check", "init", "ignore", "remote", "sync")
MAX_URL = 2048
DEADLINE = 60
ACCESS_DEADLINE = 20
INSTALL = {"git": "sudo pacman -S git", "gitleaks": "sudo pacman -S gitleaks"}

SCP_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~/][A-Za-z0-9._~/+@-]*$")
HTTPS_PATH_RE = re.compile(r"^[A-Za-z0-9._~/%+@:-]*$")
HTTPS_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*$")

# What git says when the login is missing or wrong, with the one thing to do about it, in the order checked.
ACCESS_HINTS = (
    (("authentication failed", "could not read username"), "Log in first: gh auth login"),
    (("permission denied (publickey)",), "Add your SSH key to GitHub"),
    (("host key verification failed",), "Run ssh -T git@github.com once in a terminal and accept GitHub's key"),
    (("repository not found",), "Check the address, and that you are logged in as the owner."),
)

busy = threading.Lock()


class SetupError(ValueError):
    """The request itself is wrong (unknown step, bad address). Maps to HTTP 422."""


def check_url(url: object) -> str:
    """The address if it is an scp-style SSH address or an HTTPS address without credentials."""
    if not isinstance(url, str) or not url:
        raise SetupError("the remote address must be text")
    if len(url) > MAX_URL:
        raise SetupError(f"the remote address is over {MAX_URL} characters")
    if url.startswith("-") or any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise SetupError("the remote address has spaces, control characters or starts with a dash")
    if "://" not in url:
        if not SCP_RE.match(url):
            raise SetupError("use the SSH form git@host:owner/repo.git or an https:// address")
        return url
    try:
        parts = urlsplit(url)
    except ValueError:
        raise SetupError("the https address could not be read") from None
    if parts.scheme != "https":
        raise SetupError("only https:// and the SSH form git@host:owner/repo.git are accepted")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise SetupError("the address must not contain a user name or password; let git's credential helper ask for them")
    if not parts.hostname or not HTTPS_HOST_RE.match(parts.hostname) or parts.query or parts.fragment or not HTTPS_PATH_RE.match(parts.path):
        raise SetupError("the https address needs a host and a plain path, without a query or fragment")
    return url


class Reply(NamedTuple):
    code: int
    stderr: str


def ls_remote(folder: Path, url: str) -> Reply:
    """Can git read the repository? Never waits for a password or for an answer about an unknown host."""
    result = run(["git", "-C", str(folder), "ls-remote", "--", url], timeout=ACCESS_DEADLINE,  # noqa: S607
                 env={"GIT_SSH_COMMAND": "ssh -o BatchMode=yes"})
    return Reply(result.returncode, result.stderr)


def _tools() -> dict[str, bool]:
    return {name: shutil.which(name) is not None for name in INSTALL}


def _missing_tools() -> list[str]:
    return [name for name, found in _tools().items() if not found]


def _is_repo(folder: Path) -> bool:
    return folder.is_dir() and find_repo(folder) == folder.resolve()


def _originals_ignored(folder: Path, boards: Path) -> bool | None:
    """Would a photo original be left out of commits? None when that cannot be asked yet."""
    if not _is_repo(folder):
        return None
    slugs = sorted(p.name for p in boards.iterdir() if p.is_dir()) if boards.is_dir() else []
    probe = f"{boards.name}/{slugs[0] if slugs else 'example'}/assets/photos/originals/x.jpg"
    return git(folder, "check-ignore", "-q", "--", probe, check=False, timeout=DEADLINE).returncode == 0


def _remote(folder: Path) -> str | None:
    if not _is_repo(folder):
        return None
    result = git(folder, "remote", "get-url", "origin", check=False, timeout=DEADLINE)
    return redact(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip() else None


def _last_commit(folder: Path) -> str | None:
    if not _is_repo(folder):
        return None
    result = git(folder, "log", "-1", "--format=%cI", check=False, timeout=DEADLINE)
    return result.stdout.strip() or None if result.returncode == 0 else None


def problems(folder: Path, boards: Path) -> list[str]:
    """What stops git from being turned on, one line each. Empty when the local checks all pass."""
    found = []
    missing = _missing_tools()
    if missing:
        found.append(f"{' and '.join(missing)} not installed; run: {' && '.join(INSTALL[name] for name in missing)}")
    if not _is_repo(folder):
        found.append(f"{folder} is not a git repository yet; run the init step")
        return found
    guard = guard_problem(folder)
    if guard and "gitleaks" not in missing:
        found.append(guard)
    if _originals_ignored(folder, boards) is False:
        found.append("photo originals are not ignored by this repository, so their location data (EXIF and GPS) could be committed")
    return found


def status(folder: Path, boards: Path, setting: str) -> dict:
    found = problems(folder, boards)
    tools = _tools()
    return {"ok": not found, "detail": {
        "setting": setting, "folder": str(folder), "git": tools["git"], "gitleaks": tools["gitleaks"],
        "repository": _is_repo(folder), "guard": _is_repo(folder) and guard_problem(folder) is None,
        "originals_ignored": _originals_ignored(folder, boards), "remote": _remote(folder),
        "last_commit": _last_commit(folder), "problems": found}}


def run_step(folder: Path, boards: Path, step: object, data: dict) -> dict:
    """One setup step. `data` may hold `url` and `replace` for the remote step. Returns {ok, detail}."""
    if step not in STEPS:
        raise SetupError(f"step must be one of {', '.join(STEPS)}")
    if step != "remote" and set(data) - {"step"}:
        raise SetupError(f"the {step} step takes no other fields")
    if step == "remote" and set(data) - {"step", "url", "replace"}:
        raise SetupError("the remote step takes only url and replace")
    if step == "check":
        missing = _missing_tools()
        if missing:
            return {"ok": False, "detail": f"{' and '.join(missing)} not installed. Run: {' && '.join(INSTALL[name] for name in missing)}"}
        return {"ok": True, "detail": "git and gitleaks are installed"}
    if _missing_tools():
        return {"ok": False, "detail": "git and gitleaks must be installed first; run the check step"}
    try:
        if step == "init":
            created = init_repo(folder)
            return {"ok": True, "detail": "created " + ", ".join(created) if created else "the layout was already complete; the commit guard is active"}
        if not _is_repo(folder):
            return {"ok": False, "detail": f"{folder} is not a git repository; run the init step first"}
        if step == "ignore":
            if _originals_ignored(folder, boards):
                return {"ok": True, "detail": "photo originals are ignored, so their location data stays on this machine"}
            return {"ok": False, "detail": "photo originals are not ignored by this repository. They can carry EXIF and GPS data, so git stays off. Run the init step to restore the .gitignore"}
        if step == "remote":
            return _remote_step(folder, data)
        problem = guard_problem(folder)
        if problem:
            return {"ok": False, "detail": problem}
        report = sync(folder, push=_remote(folder) is not None, timeout=DEADLINE)
        report = ["not pushed: no remote set" if line == "not pushed (--no-push)" else line for line in report]
        return {"ok": True, "detail": redact("\n".join(report))}
    except RepoError as exc:
        return {"ok": False, "detail": redact(str(exc))}


def _private_check(url: str) -> tuple[bool, str]:
    """Whether the step may go on, and what to tell the person. Only a 404 counts as private."""
    try:
        verdict = github.check(url)
    except github.GitHubAddressError as exc:
        raise SetupError(str(exc)) from exc
    if verdict.kind == github.OTHER_HOST:
        return True, "Not a GitHub address; make sure the repository is private."
    if verdict.kind == github.UNKNOWN:
        return False, f"Could not check whether the repository is private: {verdict.reason}. Try again."
    if verdict.kind == github.PUBLIC:
        return False, ("This repository is public. Anyone could read your boards. Make it private on GitHub "
                       "(Settings, Danger Zone, Change visibility), or use another one.")
    return True, "GitHub shows no public repository at this address, so it is private or not created yet."


def _access_check(folder: Path, url: str) -> tuple[bool, str]:
    try:
        reply = ls_remote(folder, url)
    except RepoError:
        return False, f"the repository did not answer within {ACCESS_DEADLINE} seconds"
    if reply.code == 0:
        return True, "git can read the repository."
    text = redact(reply.stderr)
    lines = [line for line in text.splitlines() if line.strip()]
    hint = next((hint for words, hint in ACCESS_HINTS if any(word in text.lower() for word in words)), "")
    return False, " ".join(part for part in (f"git cannot read it: {lines[-1].strip()}" if lines else "git cannot read it.", hint) if part)


def _remote_step(folder: Path, data: dict) -> dict:
    url = data.get("url")
    if url in (None, ""):
        return {"ok": True, "detail": "no remote address given; the repository stays on this machine"}
    url = check_url(url)
    current = git(folder, "remote", "get-url", "origin", check=False, timeout=DEADLINE)
    old = current.stdout.strip() if current.returncode == 0 else None
    if old is not None and old != url and data.get("replace") is not True:
        return {"ok": False, "confirm": {"old": redact(old), "new": url},
                "detail": f"origin is already {redact(old)}. Replace it with {url}? Send the step again with replace set to true to confirm"}
    allowed, privacy = _private_check(url)
    if not allowed:
        return {"ok": False, "detail": privacy}
    if old is None:
        git(folder, "remote", "add", "--", "origin", url, timeout=DEADLINE)
        done = f"origin set to {redact(url)}."
    elif old != url:
        git(folder, "remote", "set-url", "--", "origin", url, timeout=DEADLINE)
        done = f"origin changed from {redact(old)} to {url}."
    else:
        done = f"origin is already {redact(url)}."
    reachable, access = _access_check(folder, url)
    if not reachable:
        return {"ok": False, "detail": f"{done} {privacy} But {access}"}
    return {"ok": True, "detail": f"{done} {privacy} Access checked: {access}"}
