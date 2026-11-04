"""Check that every dependency has an MIT-compatible license, and fail on anything else.

Run inside the service environment:  cd service && uv run python ../tools/license_audit.py
It checks the installed Python packages and every package in package-lock.json (development tools
included). The Rust crates of the desktop shell are checked by `cargo deny check licenses` with
desktop/src-tauri/deny.toml, whose allow-list a service test keeps equal to ALLOWED below.

ALLOWED is the one allow-list, as SPDX ids. An expression passes when one side of every OR and both
sides of every AND are allowed. GPL, AGPL and LGPL need a human decision, so they fail as REVIEW;
anything without a recognisable license fails as UNKNOWN. Exit code 1 on any failure.
"""
import json
import re
import sys
from importlib import metadata
from pathlib import Path

ALLOWED = frozenset({
    "0BSD", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause",
    "BSL-1.0", "CC0-1.0", "HPND", "ISC", "MIT", "MIT-0", "MIT-CMU", "MPL-2.0", "PSF-2.0", "Unicode-3.0",
    "Unlicense", "Zlib",
})
# Older Python packages name their license in free text or a trove classifier instead of SPDX.
LEGACY_NAMES = {
    "MIT": "MIT", "MIT License": "MIT",
    "BSD": "BSD-3-Clause", "BSD License": "BSD-3-Clause",
    "Apache-2.0": "Apache-2.0", "Apache Software License": "Apache-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
}
REVIEW = re.compile(r"GPL", re.I)
OURS = {"pcbv"}
ROOT = Path(__file__).resolve().parent.parent


def allowed(expression: str) -> bool:
    """Evaluate an SPDX expression against ALLOWED. Cargo's old "A/B" form means A OR B."""
    tokens = re.findall(r"\(|\)|[^\s()]+", expression.replace("/", " OR "))
    position = 0

    def peek():
        return tokens[position].upper() if position < len(tokens) else None

    def take():
        nonlocal position
        position += 1
        return tokens[position - 1]

    def any_of():
        result = all_of()
        while peek() == "OR":
            take()
            result = all_of() or result
        return result

    def all_of():
        result = term()
        while peek() == "AND":
            take()
            result = term() and result
        return result

    def term():
        if peek() == "(":
            take()
            result = any_of()
            if peek() != ")":
                raise ValueError(f"unbalanced parentheses in {expression!r}")
            take()
            return result
        if peek() in (None, ")", "OR", "AND", "WITH"):
            raise ValueError(f"cannot read license expression {expression!r}")
        name = take()
        if peek() == "WITH":
            take()
            if peek() is None:
                raise ValueError(f"WITH without an exception in {expression!r}")
            name = f"{name} WITH {take()}"
        return name in ALLOWED

    result = any_of()
    if position != len(tokens):
        raise ValueError(f"cannot read license expression {expression!r}")
    return result


def status(expression: str | None) -> str:
    if not expression:
        return "UNKNOWN"
    try:
        if allowed(expression):
            return "ok"
    except ValueError:
        return "UNKNOWN"
    return "REVIEW" if REVIEW.search(expression) else "UNKNOWN"


def python_license(dist) -> str | None:
    meta = dist.metadata
    if meta.get("License-Expression"):
        return meta["License-Expression"].strip()
    names = [(meta.get("License") or "").strip()]
    names += [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    found = sorted({LEGACY_NAMES[n] for n in names if n in LEGACY_NAMES})
    return " OR ".join(found) or None


def python_packages():
    for dist in sorted(metadata.distributions(), key=lambda d: (d.metadata["Name"] or "").lower()):
        name = dist.metadata["Name"] or "?"
        if name.lower() not in OURS:
            yield name, dist.version, python_license(dist)


def npm_packages(lockfile: Path):
    packages = json.loads(lockfile.read_text())["packages"]
    for path, info in sorted(packages.items()):
        if path and not info.get("link"):
            yield path.rsplit("node_modules/", 1)[-1], info.get("version", "?"), info.get("license")


def main() -> int:
    bad = 0
    for title, packages in (("Python", python_packages()), ("npm", npm_packages(ROOT / "package-lock.json"))):
        print(f"{title}:")
        for name, version, expression in packages:
            result = status(expression)
            bad += result != "ok"
            print(f"  {result:8} {name} {version}  {expression or '(no license field)'}")
    print(f"\n{bad} to review" if bad else "\nall Python and npm dependencies are MIT-compatible")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
