"""Where a running service advertises itself (URL, token, pid) for the CLI and the Tauri shell.

The file is service.json, mode 0600, in a folder of mode 0700: $XDG_RUNTIME_DIR/pcbv/, which the system
clears at logout, or ~/.cache/pcbv/ when that variable is unset. The fallback is an ordinary folder, so the
token can stay on disk after the service stops (the service removes the file on a normal exit). runtime_dir()
selects the location. Windows are opened with a one-time code from mint_code(), never with this token.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from .schema import PROTOCOL_VERSION

INFO_NAME = "service.json"


def runtime_dir() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR")
    return Path(base) / "pcbv" if base else Path.home() / ".cache" / "pcbv"


def write_service_info(url: str, token: str, pid: int | None = None) -> Path:
    directory = runtime_dir()
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    path = directory / INFO_NAME
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({"url": url, "token": token, "pid": pid or os.getpid(), "protocol": PROTOCOL_VERSION}, fh)
        fh.write("\n")
    os.chmod(path, 0o600)
    return path


def read_service_info() -> dict | None:
    """Return the advertised service, or None when there is none or its process is gone."""
    path = runtime_dir() / INFO_NAME
    try:
        info = json.loads(path.read_text())
        os.kill(int(info["pid"]), 0)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return info


def remove_service_info() -> None:
    try:
        (runtime_dir() / INFO_NAME).unlink()
    except FileNotFoundError:
        pass


def mint_code(info: dict) -> str:
    """Ask the advertised service for a one-time login code (valid 60 s, one use). Raises OSError."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))      # a local service is never behind the proxy
    request = urllib.request.Request(f"{info['url']}/api/session/code", data=b"{}", method="POST",  # noqa: S310 - the local service's URL from service.json
                                     headers={"Authorization": f"Bearer {info['token']}", "Content-Type": "application/json"})
    try:
        with opener.open(request, timeout=5) as response:
            code = json.load(response)["code"]
    except (urllib.error.URLError, ValueError, KeyError, TypeError) as exc:
        raise OSError(f"the service did not give a login code: {getattr(exc, 'reason', exc)}") from None
    if not isinstance(code, str):
        raise OSError("the service did not give a login code")
    return code
