import importlib.util
import tomllib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("license_audit", REPO / "tools" / "license_audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


@pytest.mark.parametrize("expression, result", [
    ("MIT", "ok"),
    ("MIT OR GPL-3.0-only", "ok"),
    ("MIT/Apache-2.0", "ok"),
    ("(MIT OR Apache-2.0) AND Unicode-3.0", "ok"),
    ("Apache-2.0 WITH LLVM-exception", "ok"),
    ("MIT AND GPL-3.0-only", "REVIEW"),
    ("LGPL-2.1-or-later", "REVIEW"),
    ("GPL-2.0 WITH Classpath-exception-2.0", "REVIEW"),
    ("SSPL-1.0", "UNKNOWN"),
    ("MIT OR", "UNKNOWN"),
    ("(MIT", "UNKNOWN"),
    ("", "UNKNOWN"),
    (None, "UNKNOWN"),
])
def test_an_expression_passes_only_when_every_branch_it_needs_is_allowed(expression, result):
    assert audit.status(expression) == result


def test_the_rust_allow_list_is_the_audit_allow_list():
    deny = tomllib.loads((REPO / "desktop" / "src-tauri" / "deny.toml").read_text())
    assert set(deny["licenses"]["allow"]) == audit.ALLOWED


def test_the_third_party_document_lists_exactly_the_python_packages_the_service_installs():
    lock = {p["name"]: p for p in tomllib.loads((REPO / "service" / "uv.lock").read_text())["package"]}
    installed, todo = set(), [d["name"] for d in lock["pcbv"]["dependencies"]]
    while todo:
        name = todo.pop()
        if name not in installed:
            installed.add(name)
            todo += [d["name"] for d in lock[name].get("dependencies", []) if "win32" not in d.get("marker", "")]
    text = (REPO / "THIRD_PARTY_LICENSES.md").read_text()
    section = text.split("## Python service")[1].split("\n## ")[0]
    listed = {line.split("|")[1].strip() for line in section.splitlines() if line.startswith("| ")} - {"Package"}
    assert listed == installed


def test_the_lockfile_reader_skips_the_root_and_names_nested_packages(tmp_path):
    lock = tmp_path / "package-lock.json"
    lock.write_text('{"packages": {"": {"name": "root"}, "node_modules/a": {"version": "1", "license": "MIT"},'
                    ' "node_modules/a/node_modules/@s/b": {"version": "2"}, "app": {"link": true}}}')
    assert list(audit.npm_packages(lock)) == [("a", "1", "MIT"), ("@s/b", "2", None)]
