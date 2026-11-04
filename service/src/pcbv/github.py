"""The private check: is the repository behind a GitHub address readable by anyone?

One unauthenticated request to api.github.com, no login, no board data. Only a 404 counts as private; a
network failure, a 403 or any other answer means "cannot tell" and callers treat that as a refusal.
Callers use this module as `github.github_status(...)` and `github.check(...)`, so a test replaces the
network question in one place. This module imports nothing from the rest of pcbv, so both `gitsetup`
and `datarepo` can use it.
"""
from __future__ import annotations

import http.client
import re
import urllib.error
import urllib.request
from typing import NamedTuple
from urllib.parse import quote, urlsplit

GITHUB_DEADLINE = 10
GITHUB_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
# Host names git reaches GitHub through. A trailing dot names the same host.
GITHUB_HOSTS = frozenset({"github.com", "www.github.com", "ssh.github.com"})

PUBLIC, PRIVATE, UNKNOWN, OTHER_HOST = "public", "private", "unknown", "other host"


class GitHubAddressError(ValueError):
    """A github.com address whose owner and repository cannot be read."""


class Verdict(NamedTuple):
    kind: str          # PUBLIC, PRIVATE, UNKNOWN or OTHER_HOST
    reason: str = ""   # for UNKNOWN: what went wrong, in a few words


def github_repo(url: str) -> tuple[str, str] | None:
    """(owner, repository) for an address on github.com in either form, None for any other host."""
    if "://" in url:
        parts = urlsplit(url)
        host, path = parts.hostname or "", parts.path
        if parts.port not in (None, 443):
            return None
    else:
        host, _, path = url.partition("@")[2].partition(":")
    if host.lower().rstrip(".") not in GITHUB_HOSTS:
        return None
    names = path.strip("/").removesuffix(".git").split("/")
    if len(names) != 2 or not all(GITHUB_NAME_RE.match(n) and n.strip(".") for n in names):
        raise GitHubAddressError("a GitHub address needs the owner and the repository, as in github.com/owner/repo")
    return names[0], names[1]


def github_status(owner: str, repo: str) -> int:
    """The status GitHub gives to an unauthenticated request for the repository. No login is sent, so only a
    public repository answers 200. A network failure or a broken reply raises OSError."""
    request = urllib.request.Request(
        f"https://api.github.com/repos/{quote(owner)}/{quote(repo)}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "pcb-visualizer"})
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_DEADLINE) as response:  # noqa: S310 - fixed https URL
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except http.client.HTTPException as exc:
        raise OSError(f"GitHub sent a broken reply ({type(exc).__name__})") from exc


def check(url: str) -> Verdict:
    """Public, private (404), cannot tell, or not GitHub. Raises GitHubAddressError for a GitHub address
    without a plain owner and repository."""
    repo = github_repo(url)
    if repo is None:
        return Verdict(OTHER_HOST)
    try:
        code = github_status(*repo)
    except OSError as exc:
        return Verdict(UNKNOWN, str(exc))
    if code == 200:
        return Verdict(PUBLIC)
    if code == 404:
        return Verdict(PRIVATE)
    return Verdict(UNKNOWN, f"GitHub answered {code}")
