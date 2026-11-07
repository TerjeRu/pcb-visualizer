"""KWin window rules for the desktop shell's windows.

Plasma on Wayland does not let apps choose the monitor for their windows, so panel windows have
stable titles ("pcbv · Console") and this writes a rules file that pins each to a monitor. It is a
.kwinrule file for System Settings, Window Management, Window Rules, Import: nothing in the
desktop's configuration is changed by pcbv itself.
"""
from __future__ import annotations

# Titles must match app/js/core/layout.js PANELS; the main window is titled "pcbv".
TITLES = {
    "main": "pcbv",
    "board": "pcbv · Board",
    "inspector": "pcbv · Header",
    "photo": "pcbv · Photo",
    "notes": "pcbv · Notes",
    "playbook": "pcbv · Playbook",
    "wiki": "pcbv · Wiki",
    "console": "pcbv · Console",
    "timeline": "pcbv · Timeline",
    "logic": "pcbv · Logic",
    "terminal": "pcbv · Terminal",
    "assistant": "pcbv · Agent",
}

FORCE = 2          # KWin rule policy: keep enforcing
APPLY_INITIALLY = 3
EXACT = 1          # KWin string match: exact


class RuleError(ValueError):
    pass


def parse_assignments(items: list[str]) -> dict[str, int]:
    """['console=1', 'main=0'] -> {'console': 1, 'main': 0}."""
    result = {}
    for item in items:
        name, sep, screen = item.partition("=")
        name = name.strip().lower()
        if not sep or name not in TITLES or not screen.strip().isdigit():
            known = ", ".join(TITLES)
            raise RuleError(f"write window=monitor, for example console=1; windows: {known}")
        result[name] = int(screen)
    if not result:
        raise RuleError("give at least one window=monitor, for example console=1")
    return result


def rules_file(assignments: dict[str, int], maximize: bool = False) -> str:
    sections = []
    for n, (name, screen) in enumerate(sorted(assignments.items()), start=1):
        lines = [
            f"[{n}]",
            f"Description=PCB Visualizer: {TITLES[name]} on monitor {screen}",
            f"title={TITLES[name]}",
            f"titlematch={EXACT}",
            "types=1",
            f"screen={screen}",
            f"screenrule={FORCE}",
        ]
        if maximize:
            lines += ["maximizehoriz=true", f"maximizehorizrule={APPLY_INITIALLY}",
                      "maximizevert=true", f"maximizevertrule={APPLY_INITIALLY}"]
        sections.append("\n".join(lines))
    return "\n\n".join(sections) + "\n"
