"""The pcbv command line to show in messages, as the person can paste it."""
from __future__ import annotations

import shutil


def command(*words: str) -> str:
    """`pcbv ...` when pcbv is on PATH, otherwise `uv run pcbv ...`, which works from the service/ folder."""
    prefix = "pcbv" if shutil.which("pcbv") else "uv run pcbv"
    return " ".join((prefix, *words))
