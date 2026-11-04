"""The shipped front end pieces against a real service process: static files, then the real client over real sockets."""
import json
import os
import subprocess
import urllib.request
from pathlib import Path

import pytest

from live_service import running_service

RUNNER = Path(__file__).parent / "e2e_runner.mjs"


@pytest.fixture
def service(tmp_path):
    boards = tmp_path / "boards"
    with running_service(boards, tmp_path / "run") as (base, token, opener, _process):
        yield base, token, boards, opener

def test_real_process_serves_the_app_and_the_real_client_edits_a_board(service):
    base, token, boards, opener = service

    index = opener.open(f"{base}/", timeout=3)
    page = index.read().decode()
    assert "PCB Visualizer" in page and "js/main.js" in page
    csp = index.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp and "script-src" not in csp and "unsafe-inline" not in csp.split("style-src")[0]
    for asset in ("js/main.js", "js/ui.js", "css/app.css"):
        assert opener.open(f"{base}/{asset}", timeout=3).status == 200

    create = urllib.request.Request(f"{base}/api/boards", method="POST", data=b'{"name": "Bench Router"}',
                                    headers={"X-PCBV-Protocol": "2", "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    assert opener.open(create, timeout=3).status == 201

    result = subprocess.run(["node", str(RUNNER), base, token, "bench-router"], capture_output=True, text=True, timeout=30,
                            env={**os.environ, "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"})
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert "bench-router" in out["boards"]
    assert out["status"] == "live" and out["notes"] == "from the real client"

    # the edit really reached the journal on disk, attributed to the client's actor
    events = [json.loads(line) for line in (boards / "bench-router" / "journal" / "events.jsonl").read_text().splitlines()]
    assert events[-1]["type"] == "project/metaUpdated" and events[-1]["actor"] == "ws"
