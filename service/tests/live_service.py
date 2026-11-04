"""A real `pcbv serve` process on a free port, for tests that need real sockets and signals."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

import pytest


@contextmanager
def running_service(root: Path, run_dir: Path, host: str = "127.0.0.1", env: dict | None = None):
    """Yield (base_url, token, opener, process). The service binds port 0 and names the real port in service.json."""
    env = {**os.environ, "XDG_RUNTIME_DIR": str(run_dir), **(env or {})}
    process = subprocess.Popen([sys.executable, "-m", "pcbv.cli", "--root", str(root), "serve", "--host", host, "--port", "0"],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    info_file = run_dir / "pcbv" / "service.json"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                pytest.fail("service exited: " + process.stdout.read())
            if time.monotonic() > deadline:
                pytest.fail("service did not start within 15 s")
            try:
                info = json.loads(info_file.read_text())
                if opener.open(f"{info['url']}/api/health", timeout=0.5).status == 200:
                    break
            except (OSError, ValueError):
                time.sleep(0.05)
        yield info["url"], info["token"], opener, process
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
        process.stdout.close()
