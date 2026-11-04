"""The demo board for `pcbv demo`: a synthetic router with marked headers, labelled pins, chip callouts,
some playbook progress, a boot log and a logic capture, so a fresh install has something to explore.

Everything is written as ordinary events, as if a person had done the work in the app. The photo
(demo/board-front.png) is a drawing made for this project, MIT licensed like the rest of the code.
"""
from __future__ import annotations

from importlib import resources
from pathlib import Path

from .settings import assistant_on
from .board import Board
from .boards import board_path
from .logic import virtual_boot_capture, write_sr
from .photos import ingest
from .schema import now_iso
from .serialmgr import scan_text
from .vdev import BOOT_KERNEL, BOOT_UBOOT

SLUG = "demo-router"

HEADERS = [
    ({"label": "J4", "shape": "box", "color": "#f59e0b", "x": 280, "y": 750, "w": 117, "h": 40},
     {"name": "J4 UART", "rows": 1, "cols": 4, "numbering": "row", "rotation": 0,
      "notes": "115200 8N1. The bootloader banner appears about one second after power on.",
      "pins": [
          {"index": 1, "role": "3V3", "label": "3V3", "note": "Steady 3.30 V. Leave the adapter's VCC unconnected."},
          {"index": 2, "role": "TX", "label": "TX", "note": "Dips during boot. Goes to the adapter's RXD."},
          {"index": 3, "role": "RX", "label": "RX", "note": "Steady 3.28 V, pulled up. Goes to the adapter's TXD."},
          {"index": 4, "role": "GND", "label": "GND", "note": "Beeps against the power jack shell."},
      ]}),
    ({"label": "JP1", "shape": "box", "color": "#22d3ee", "x": 1090, "y": 680, "w": 142, "h": 66},
     {"name": "JP1 EJTAG (unverified)", "rows": 2, "cols": 5, "numbering": "column", "rotation": 0,
      "notes": "Even pins all beep to ground, which fits the EJTAG layout. Odd pins still to probe.",
      "pins": [{"index": n, "role": "GND", "label": "GND", "note": ""} for n in (2, 4, 6, 8, 10)]}),
    ({"label": "TP7", "shape": "crosshair", "color": "#a3e635", "x": 930, "y": 660},
     {"name": "TP7", "rows": 1, "cols": 1, "numbering": "row", "rotation": 0, "notes": "",
      "pins": [{"index": 1, "role": "VCC", "label": "1V0 core", "note": "Measured 1.01 V, powered."}]}),
]

CALLOUTS = [
    {"x": 760, "y": 470, "lx": 760, "ly": 300, "text": "SoC ARC7621", "wiki": "soc"},
    {"x": 545, "y": 258, "lx": 700, "ly": 200, "text": "SPI flash 25Q128, 16 MB", "wiki": "spi-flash"},
    {"x": 1075, "y": 432, "lx": 1075, "ly": 330, "text": "DDR3 RAM, 4 Gb"},
]

PROGRESS = [
    ("open-and-photograph", "prepare", {"gates": {"unplugged": True}}),
    ("open-and-photograph", "open-case", {"answers": {"opening": "Four screws under the rubber feet, then clips along the front."}}),
    ("open-and-photograph", "photos", {}),
    ("open-and-photograph", "chips", {"answers": {"soc": "ARC7621", "flash": "25Q128 (16 MB SPI NOR)", "ram": "DDR3 4 Gb"}}),
    ("find-uart", "candidates", {}),
    ("find-uart", "ground", {"gates": {"unplugged": True, "meter": True}}),
]


def _boot_log() -> str:
    return "\r\n".join(text for _, text in BOOT_UBOOT + BOOT_KERNEL) + "\r\n"


def add_logic_capture(board: Board, actor: str, started: str) -> None:
    """The practice logic capture: the boot log's TX line at 115200 baud, on D0. The tutorial uses it too."""
    capture = virtual_boot_capture(115200, 2_000_000)
    raw = write_sr(capture)
    rel = "captures/logic/demo-boot.sr"
    board.files.create_bytes(rel, raw)
    board.apply({"type": "capture/started", "capture": {
        "id": "cap_demo0002", "kind": "logic", "path": rel, "label": "Demo boot, TX on D0",
        "samplerate": capture.samplerate, "channels": capture.channels, "samples": len(capture.samples),
        "duration": round(capture.duration, 4), "started": started, "stopped": started, "bytes": len(raw)}},
        actor, internal=True)


def create_demo(root: Path) -> Path:
    """Create the demo board in root and return its folder. Raises FileExistsError if it is there already."""
    directory = board_path(Path(root), SLUG)
    if directory.exists():
        raise FileExistsError(f"{directory} already exists; remove it first to create the demo again")
    board = Board.create(directory, "Demo router", actor="demo", agents_md=assistant_on(root))
    try:
        def apply(event):
            return board.apply(event, "demo")

        apply({"type": "project/metaUpdated", "patch": {
            "device": "Synthetic dual-band router board, rev B",
            "notes": "The demo board. The photo is a drawing, and every reading on it is made up, so feel free to "
                     "change anything. Delete the folder to start over; pcbv demo creates it again."}})
        photo = (resources.files("pcbv") / "demo" / "board-front.png").read_bytes()
        asset = ingest(board.files, photo, label="Front", side="front")
        apply({"type": "asset/added", "asset": asset})
        for number, (marker, schematic) in enumerate(HEADERS, 1):
            schematic_id = f"sch_demo{number:04d}"
            details = {k: v for k, v in schematic.items() if k != "pins"}
            pins = [{"color": "", **pin} for pin in schematic["pins"]]
            apply({"type": "marker/added",
                   "marker": {"id": f"mk_demo{number:04d}", "assetId": asset["id"], "schematicId": schematic_id, **marker},
                   "schematic": {"id": schematic_id, "kind": "header", "pitch": 2.54, "pins": pins, **details}})
        for number, callout in enumerate(CALLOUTS, 1):
            apply({"type": "annotation/added", "annotation": {"id": f"an_demo{number:04d}", "assetId": asset["id"], **callout}})
        for playbook, step, patch in PROGRESS:
            apply({"type": "playbook/updated", "playbookId": playbook, "stepId": step, "patch": {**patch, "done": now_iso()}})

        log = _boot_log().encode()
        rel = "captures/serial/demo-boot.log"
        board.files.create_bytes(rel, log)
        started = now_iso()
        board.apply({"type": "capture/started", "capture": {
            "id": "cap_demo0001", "kind": "serial", "path": rel, "port": "virtual", "label": "Demo boot",
            "baud": 115200, "started": started}}, "demo", internal=True)
        board.apply({"type": "capture/stopped", "id": "cap_demo0001", "patch": {
            "stopped": now_iso(), "bytes": len(log), "reason": "closed", "kind": "serial", "seen": scan_text(log.decode())}},
            "demo", internal=True)

        add_logic_capture(board, "demo", started)
    finally:
        board.close()
    return directory
