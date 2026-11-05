"""The data repo (default ~/hw): template, commit guard and sync to GitHub.

Boards live in `<repo>/boards/`. `init_repo` lays out the folders, writes the
.gitignore, gitleaks config and pre-commit guard, and points git at the guard
(core.hooksPath is local config, so a fresh clone needs `pcbv repo init` again).
`sync` stages everything, commits with a message built from the board journals,
then pulls and pushes. It refuses to commit while the guard is not active.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections import Counter
from importlib import resources
from pathlib import Path

from . import distro, github
from .hints import command

HOOKS_DIR = ".githooks"
FOLDERS = ["boards", "wiki", "library/datasheets", "playbooks", "journal"]
# template file -> path in the repo
TEMPLATE_FILES = {
    "gitignore": ".gitignore",
    "gitleaks.toml": ".gitleaks.toml",
    "githooks/pre-commit": f"{HOOKS_DIR}/pre-commit",
    "README.md": "README.md",
}


# GIT_TERMINAL_PROMPT=0 alone still lets git and ssh open a password window through SSH_ASKPASS, which
# Plasma sets to ksshaskpass. An empty GIT_ASKPASS stops git's, SSH_ASKPASS_REQUIRE=never stops ssh's
# (key passphrase, unknown host key) without overriding the person's core.sshCommand.
NO_PROMPT = {"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "", "SSH_ASKPASS_REQUIRE": "never"}


class RepoError(RuntimeError):
    pass


CREDENTIALS_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s]+@")


def redact(text: str, limit: int = 4000) -> str:
    """`text` without credentials embedded in URLs, cut to `limit` characters."""
    text = CREDENTIALS_RE.sub(r"\1***@", text)
    return text if len(text) <= limit else text[:limit] + " [cut]"


def run(argv: list[str], *, input: str | None = None, timeout: float | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """Runs a git command with no terminal and no password window, so a missing credential fails at once
    instead of waiting for a prompt. A command that runs over `timeout` seconds is stopped and raises
    RepoError. `env` adds variables to the environment."""
    env = {**os.environ, **NO_PROMPT, **(env or {})}
    try:
        return subprocess.run(argv, capture_output=True, text=True, input=input, timeout=timeout, env=env,  # noqa: S603 - fixed argv, no shell
                              stdin=None if input is not None else subprocess.DEVNULL, start_new_session=True)
    except subprocess.TimeoutExpired:
        raise RepoError(f"git did not finish in {timeout:g} seconds and was stopped") from None


def git(repo: Path, *args: str, check: bool = True, timeout: float | None = None) -> subprocess.CompletedProcess:
    result = run(["git", "-C", str(repo), *args], timeout=timeout)  # noqa: S607 - git from PATH
    if check and result.returncode != 0:
        raise RepoError(f"git {' '.join(args)} failed: {(result.stderr or result.stdout).strip()}")
    return result


def find_repo(path: Path) -> Path | None:
    """The top of the git repo containing path, or None."""
    if not Path(path).is_dir():
        return None
    result = git(Path(path), "rev-parse", "--show-toplevel", check=False)
    return Path(result.stdout.strip()) if result.returncode == 0 else None


def init_repo(repo: Path) -> list[str]:
    """Create or complete the data repo layout. Existing files are left alone, except that the
    guard hook is always refreshed and activated. Returns what was created, for the user."""
    repo = Path(repo)
    created = []
    repo.mkdir(parents=True, exist_ok=True)
    if find_repo(repo) != repo.resolve():
        git(repo, "init", "-q", "-b", "main")
        created.append("git repository")
    for folder in FOLDERS:
        path = repo / folder
        if not path.exists():
            path.mkdir(parents=True)
            (path / ".gitkeep").touch()
            created.append(f"{folder}/")
    template = resources.files("pcbv") / "template"
    for source, target in TEMPLATE_FILES.items():
        path = repo / target
        is_hook = target.startswith(HOOKS_DIR)
        if path.exists() and not is_hook:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        path.write_bytes((template / source).read_bytes())
        if is_hook:
            path.chmod(0o755)
        if not existed:
            created.append(target)
    git(repo, "config", "core.hooksPath", HOOKS_DIR)
    return created


def guard_problem(repo: Path) -> str | None:
    """Why the commit guard would not run, or None when it is active."""
    hooks_path = git(repo, "config", "--get", "core.hooksPath", check=False).stdout.strip()
    hook = repo / HOOKS_DIR / "pre-commit"
    if hooks_path != HOOKS_DIR or not hook.is_file():
        return f"the commit guard is not active in this clone; run: {command('repo', 'init')}"
    if not hook.stat().st_mode & 0o100:
        return f"{hook} is not executable; run: {command('repo', 'init')}"
    return gitleaks_problem()


# gitleaks 8.16 (Debian 13, Ubuntu 24.04) has no `git` command and 8.19 lacks a flag the guard's call
# needs; 8.21 is the oldest release tested to work. Builds often print no usable version, so the probe
# runs the guard's own command instead of reading one.
GITLEAKS_MIN = "8.21"
GITLEAKS_RELEASES = "https://github.com/gitleaks/gitleaks/releases"
PROBE_DEADLINE = 10
_probe_lock = threading.Lock()
_probed: dict[tuple[str, int], str] = {}


def gitleaks_status() -> str:
    """Whether gitleaks can run the commit guard's scan: missing, too-old or ok. The answer is
    kept per binary (resolved path and mtime), so it runs once per process and again after an update."""
    found = shutil.which("gitleaks")
    if found is None:
        return "missing"
    try:
        binary = Path(found).resolve()
        key = (str(binary), binary.stat().st_mtime_ns)
    except OSError:
        return "missing"
    with _probe_lock:
        if key not in _probed:
            state = _probe(str(binary))
            if state is None:
                return "too-old"
            _probed[key] = state
        return _probed[key]


def _probe(gitleaks: str) -> str | None:
    """None when git itself cannot make the empty repository, so the answer says nothing about gitleaks
    and is not kept: once git works, the next call probes again."""
    env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    with tempfile.TemporaryDirectory(prefix="pcbv-gitleaks-") as folder:
        try:
            made = run(["git", "init", "-q", folder], timeout=PROBE_DEADLINE, env=env)  # noqa: S607 - git from PATH
        except (OSError, RepoError):
            return None
        if made.returncode != 0:
            return None
        try:
            result = run([gitleaks, "git", "--pre-commit", "--staged", "--redact", "--no-banner", "--log-level", "error",
                          "--exit-code", "3", folder], timeout=PROBE_DEADLINE, env=env)
        except (OSError, RepoError):
            return "too-old"
    return "ok" if result.returncode == 0 else "too-old"


def gitleaks_fix(fam: str | None) -> str:
    """The fix to show for a missing or old gitleaks. Debian and Ubuntu package one that is too old."""
    if fam == "debian":
        return f"Download gitleaks {GITLEAKS_MIN} or newer from {GITLEAKS_RELEASES}"
    return distro.install_fix(["gitleaks"], fam)


def gitleaks_problem() -> str | None:
    """Why gitleaks cannot run the commit guard's scan, with the fix, or None when it can."""
    state = gitleaks_status()
    if state == "ok":
        return None
    fam = distro.family()
    if fam == "debian":
        fix = f"download gitleaks {GITLEAKS_MIN} or newer from {GITLEAKS_RELEASES}"
    else:
        verb = "install" if state == "missing" else "update"
        command = distro.install_command(["gitleaks"], fam)
        fix = f"{verb} it with: {command}" if command else f"{verb} it with your package manager"
    if state == "missing":
        return f"gitleaks is not installed, so the secret scan cannot run; {fix}"
    return f"gitleaks is too old to run the secret scan, which needs gitleaks {GITLEAKS_MIN} or newer; {fix}"


def rebase_in_progress(repo: Path) -> bool:
    return any(Path(git(repo, "rev-parse", "--path-format=absolute", "--git-path", name).stdout.strip()).exists()
               for name in ("rebase-merge", "rebase-apply"))


def _staged_events(repo: Path) -> dict[str, Counter]:
    """Event types newly staged in each board's journal, by board slug."""
    diff = git(repo, "diff", "--cached", "-U0", "--no-color", "--", "boards/*/journal/events.jsonl").stdout
    per_board: dict[str, Counter] = {}
    board = None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            parts = line[6:].split("/") if line.startswith("+++ b/") else []
            board = parts[1] if len(parts) > 1 and parts[0] == "boards" else None
        elif line.startswith("+") and board:
            try:
                kind = json.loads(line[1:]).get("type", "unknown")
            except (ValueError, AttributeError):
                kind = "unknown"
            per_board.setdefault(board, Counter())[kind] += 1
    return per_board


def commit_message(repo: Path) -> str:
    events = _staged_events(repo)
    files = [f for f in git(repo, "diff", "--cached", "--name-only").stdout.splitlines() if f]
    boards = sorted({f.split("/")[1] for f in files if f.startswith("boards/") and f.count("/") >= 2})
    if boards:
        parts = [f"{b} (+{sum(events[b].values())} events)" if b in events else b for b in boards]
        subject = "Sync " + ", ".join(parts)
    else:
        subject = f"Sync {len(files)} file{'s' if len(files) != 1 else ''}"
    body = []
    for b in boards:
        if b in events:
            body.append(f"{b}:")
            body += [f"  {n} x {kind}" for kind, n in sorted(events[b].items())]
    other = [f for f in files if not f.startswith("boards/")]
    if other:
        body.append(f"other files: {len(other)}")
    return subject + ("\n\n" + "\n".join(body) if body else "") + "\n"


def push_urls(repo: Path, timeout: float | None = None) -> list[str]:
    """Every address git pushes to for origin (there can be several), one per line of git's answer.
    An answer git cannot give stops the push, so no address goes unchecked."""
    result = git(repo, "remote", "get-url", "--push", "--all", "origin", check=False, timeout=timeout)
    urls = [line for line in result.stdout.splitlines() if line.strip()]
    if result.returncode != 0 or not urls:
        raise RepoError("Not pushed: could not read the addresses origin pushes to: "
                        f"{redact(result.stderr.strip()) or 'git gave none'}. The local commit is kept.")
    return urls


def check_push_targets(repo: Path, timeout: float | None = None) -> None:
    """Refuses a push to a GitHub repository that is public or whose privacy cannot be checked. Runs before
    anything is pulled or pushed; the local commit is already made and stays. Other hosts pass."""
    for url in push_urls(repo, timeout):
        try:
            verdict = github.check(url)
        except github.GitHubAddressError:
            raise RepoError("Not pushed: origin is a GitHub address without a plain owner and repository. "
                            "The local commit is kept.") from None
        if verdict.kind == github.PUBLIC:
            raise RepoError("Not pushed: origin is a public GitHub repository, so anyone could read your boards. "
                            "Make it private on GitHub (Settings, Danger Zone, Change visibility), then sync again. "
                            "The local commit is kept.")
        if verdict.kind == github.UNKNOWN:
            raise RepoError(f"Not pushed: could not check whether origin is private: {redact(verdict.reason)}. "
                            "The local commit is kept; sync again later.")


def sync(repo: Path, push: bool = True, message: str | None = None, timeout: float | None = None) -> list[str]:
    """Commit everything and, when a remote is set and push is True, pull and push.
    `timeout` limits each git command, in seconds. Returns progress lines for the user. Raises RepoError on failure: a refused commit leaves nothing
    staged, and a pull that conflicts has its rebase aborted, with the commit kept."""
    report = []
    problem = guard_problem(repo)
    if problem:
        raise RepoError(problem)
    if rebase_in_progress(repo):
        raise RepoError("a rebase is already in progress in the data repo; finish it with git rebase "
                        "--continue or cancel it with git rebase --abort, then sync again")
    git(repo, "add", "-A", timeout=timeout)
    if git(repo, "diff", "--cached", "--quiet", check=False, timeout=timeout).returncode == 0:
        report.append("nothing to commit")
    else:
        msg = message.strip() + "\n" if message else commit_message(repo)
        result = run(["git", "-C", str(repo), "commit", "-q", "-F", "-"], input=msg, timeout=timeout)  # noqa: S607 - git from PATH
        if result.returncode != 0:
            git(repo, "reset", "-q", timeout=timeout)
            raise RepoError("commit refused, nothing was committed:\n" + (result.stderr or result.stdout).strip())
        report.append("committed: " + msg.splitlines()[0])
    remote = git(repo, "remote", check=False, timeout=timeout).stdout.split()
    if not push:
        report.append("not pushed (--no-push)")
    elif "origin" not in remote:
        report.append("no remote named origin; add one with: gh repo create hw --private --source <repo> --push")
    else:
        check_push_targets(repo, timeout)
        branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD", timeout=timeout).stdout.strip()
        has_upstream = git(repo, "ls-remote", "--exit-code", "--heads", "origin", branch, check=False, timeout=timeout).returncode == 0
        if has_upstream:
            pulled = git(repo, "pull", "-q", "--rebase", "origin", branch, check=False, timeout=timeout)
            if pulled.returncode != 0:
                # None was running when this sync started, so any rebase here is ours to abort.
                started = rebase_in_progress(repo)
                if started:
                    git(repo, "rebase", "--abort", check=False, timeout=timeout)
                if not started:
                    outcome = "Nothing was pushed."
                elif rebase_in_progress(repo):
                    outcome = f"The rebase could not be aborted; run git rebase --abort in {repo}."
                else:
                    outcome = (f"The rebase was aborted and your commit is kept; resolve it by hand in {repo} "
                               f"with git pull --rebase origin {branch}, then sync again.")
                raise RepoError(f"pull from origin failed: {(pulled.stderr or pulled.stdout).strip()}\n{outcome}")
        git(repo, "push", "-q", "-u", "origin", branch, timeout=timeout)
        report.append(f"pushed {branch} to origin")
    return report


def board_history(board_dir: Path, limit: int = 200) -> list[dict]:
    """Commits that touched a board folder, newest first: {hash, date, subject}. Empty outside a repo."""
    repo = find_repo(board_dir)
    if repo is None:
        return []
    rel = os.path.relpath(Path(board_dir).resolve(), repo.resolve())
    result = git(repo, "log", f"-{limit}", "--format=%H%x1f%cI%x1f%s", "--", rel, check=False)
    commits = []
    for line in result.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 3:
            commits.append({"hash": parts[0], "date": parts[1], "subject": parts[2]})
    return commits
