"""Names that reach this machine only."""
from __future__ import annotations

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def is_loopback(host: str | None) -> bool:
    """`host` as a URL parser or a bind address gives it: no port, and no brackets around IPv6."""
    return host in LOOPBACK_HOSTS
