"""Board exports for `pcbv export` and the app's Export button.

Formats: annotated photos (PNG and SVG), a Markdown report, pinouts (CSV and JSON) and a zip of the
board folder. Exports are redacted by default with the rules of `redact.py`; one Redactor serves every
file, so a value has the same stand-in in the report, the pinouts and the zip. Exports go to a new folder
that may not lie inside the board folder or the data repo, where a sync would commit them.
"""
from __future__ import annotations

import base64
import csv
import io
import json
import os
import re
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring

from PIL import Image, ImageDraw, ImageFont

from .assistant_tools import FINDING_HEADING
from .fsutil import Directory, File
from .photos import PhotoError, open_image, resolve_file
from .datarepo import find_repo
from .playbooks import load_all
from .redact import Redactor, load_custom, redact_board, redact_lines

FORMATS = ("photo", "svg", "report", "csv", "json", "zip")
REPORT_LOG_LINES = 60
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")

# The app's pin role colours (app/js/core/schema.js, PIN_ROLES).
ROLE_COLORS = {
    "GND": "#4b5563", "VCC": "#ef4444", "3V3": "#f97316", "5V": "#dc2626", "TX": "#22c55e", "RX": "#e5e7eb",
    "RST": "#a855f7", "BOOT": "#eab308", "SWDIO": "#06b6d4", "SWCLK": "#3b82f6", "TCK": "#14b8a6",
    "TMS": "#8b5cf6", "TDI": "#0ea5e9", "TDO": "#84cc16", "TRST": "#d946ef", "NC": "#1f2937",
}


class ExportError(Exception):
    """The export cannot be made as asked."""


def index_to_cell(sch: dict, index: int) -> tuple[int, int]:
    """Pin index (1-based) to (row, col) before rotation. Mirrors indexToCell in app/js/core/schema.js."""
    rows, cols, i = sch["rows"], sch["cols"], index - 1
    numbering = sch.get("numbering")
    if numbering == "column":
        return i % rows, i // rows
    if numbering == "u":
        if rows == 2:
            return (0, i) if i < cols else (1, cols - 1 - (i - cols))
        if cols == 2:
            return (i, 0) if i < rows else (rows - 1 - (i - rows), 1)
    return i // cols, i % cols


def pin_layout(sch: dict) -> dict:
    """Where each pin is drawn after numbering and rotation, in grid units. Mirrors pinLayout."""
    rows, cols = sch["rows"], sch["cols"]
    rot = (sch.get("rotation") or 0) % 360
    pins = []
    for index in range(1, rows * cols + 1):
        row, col = index_to_cell(sch, index)
        if rot == 90:
            x, y = rows - 1 - row, col
        elif rot == 180:
            x, y = cols - 1 - col, rows - 1 - row
        elif rot == 270:
            x, y = row, cols - 1 - col
        else:
            x, y = col, row
        pins.append({"index": index, "x": x, "y": y})
    swap = rot in (90, 270)
    return {"width": rows if swap else cols, "height": cols if swap else rows, "pins": pins}


def _split_findings(text: str) -> tuple[str, str]:
    """The person's own entries and the assistant's, told apart by the heading the write_finding tool gives."""
    own, assistant, target = [], [], None
    for line in text.splitlines():
        if line.startswith("## "):
            target = assistant if line.startswith(f"## {FINDING_HEADING}") else own
            if target is assistant:
                line = "#" + line         # one level down, under the report's own heading
        (own if target is None else target).append(line)
    if own[:1] == ["# Findings"]:
        own = own[1:]
    return "\n".join(own).strip(), "\n".join(assistant).strip()


@dataclass
class Result:
    folder: Path
    files: list[str] = field(default_factory=list)
    redacted: bool = True
    counts: dict = field(default_factory=dict)
    photos_to_check: int = 0


def _text(redactor: Redactor | None, value) -> str:
    text = "" if value is None else str(value)
    return redactor.text(text)[0] if redactor else text


def _pin_text(pin: dict | None) -> str:
    if not pin:
        return ""
    return pin.get("label") or pin.get("role") or ""


def _legend(sch: dict | None, redactor: Redactor | None, per_line: int = 4) -> list[str]:
    """Pins grouped by what they are, "1 3V3 · 2 TX" or "2 4 6 8 10 GND", a few groups per line. Text
    under each pin does not fit on a 2.54 mm grid."""
    groups: dict[str, list[int]] = {}
    for pin in sorted((sch or {}).get("pins", []), key=lambda p: p["index"]):
        text = _text(redactor, _pin_text(pin))
        if text:
            groups.setdefault(text, []).append(pin["index"])
    items = [f'{" ".join(str(n) for n in numbers)} {text}' for text, numbers in groups.items()]
    return [" · ".join(items[i:i + per_line]) for i in range(0, len(items), per_line)]


def overlay(project: dict, asset: dict, redactor: Redactor | None) -> list[dict]:
    """Shapes to draw over one photo, shared by the PNG and SVG renderers."""
    schematics = {s["id"]: s for s in project.get("schematics", [])}
    shapes = []
    for marker in project.get("markers", []):
        if marker.get("assetId") != asset["id"]:
            continue
        sch = schematics.get(marker.get("schematicId"))
        color = marker.get("color") or "#f59e0b"
        label = _text(redactor, marker.get("label") or (sch or {}).get("name", ""))
        pins = {p["index"]: p for p in (sch or {}).get("pins", [])}
        if marker.get("shape") == "crosshair":
            text = _text(redactor, _pin_text(pins.get(1)))
            shapes.append({"kind": "point", "x": marker["x"], "y": marker["y"], "color": color,
                           "label": f"{label}: {text}" if text and text != label else label})
            continue
        box = {"kind": "box", "x": marker["x"], "y": marker["y"], "w": marker.get("w", 0), "h": marker.get("h", 0),
               "color": color, "label": label, "pins": []}
        if sch and sch.get("rows") and sch.get("cols"):
            layout = pin_layout(sch)
            cw, ch = box["w"] / layout["width"], box["h"] / layout["height"]
            for cell in layout["pins"]:
                pin = pins.get(cell["index"])
                box["pins"].append({"x": box["x"] + (cell["x"] + 0.5) * cw, "y": box["y"] + (cell["y"] + 0.5) * ch,
                                    "r": max(2.0, min(cw, ch) * 0.28), "first": cell["index"] == 1,
                                    "fill": ROLE_COLORS.get((pin or {}).get("role"))})
        box["legend"] = _legend(sch, redactor)
        shapes.append(box)
    for callout in project.get("annotations", []):
        if callout.get("assetId") != asset["id"]:
            continue
        text = _text(redactor, callout.get("text", ""))
        if callout.get("guess"):
            text += " (unverified)"
        shapes.append({"kind": "callout", "x": callout["x"], "y": callout["y"],
                       "lx": callout.get("lx", callout["x"]), "ly": callout.get("ly", callout["y"]), "label": text})
    return shapes


def _font(size: float):
    return ImageFont.load_default(size=max(10, round(size)))


def _load_rgb(photo: Path) -> Image.Image:
    try:
        with (photo.open() if isinstance(photo, File) else open(photo, "rb")) as handle, open_image(handle) as source:
            return source.convert("RGB")
    except PhotoError as exc:
        raise ExportError(f"cannot use {photo.name if hasattr(photo, 'name') else photo}: {exc}") from exc


def annotated_png(photo: Path, shapes: list[dict]) -> bytes:
    image = _load_rgb(photo)
    unit = max(image.size) / 1600
    draw = ImageDraw.Draw(image)
    label_font, pin_font = _font(22 * unit), _font(15 * unit)
    outline = dict(stroke_width=max(2, round(3 * unit)), stroke_fill="#000000")
    for shape in shapes:
        if shape["kind"] == "box":
            draw.rectangle([shape["x"], shape["y"], shape["x"] + shape["w"], shape["y"] + shape["h"]],
                           outline=shape["color"], width=max(2, round(3 * unit)))
            draw.text((shape["x"], shape["y"] - 6 * unit), shape["label"], font=label_font, fill=shape["color"], anchor="ls", **outline)
            for pin in shape["pins"]:
                r, box = pin["r"], [pin["x"] - pin["r"], pin["y"] - pin["r"], pin["x"] + pin["r"], pin["y"] + pin["r"]]
                # A pin without a role is drawn hollow, so it does not read as RX's light grey.
                (draw.rectangle if pin["first"] else draw.ellipse)(
                    box, fill=pin["fill"], outline="#000000" if pin["fill"] else "#ffffff", width=max(1, round(2 * unit)))
            for line_no, text in enumerate(shape["legend"]):
                y = shape["y"] + shape["h"] + (6 + 19 * line_no) * unit
                draw.text((shape["x"], y), text, font=pin_font, fill="#ffffff", anchor="lt", **outline)
        elif shape["kind"] == "point":
            r = 12 * unit
            draw.ellipse([shape["x"] - r, shape["y"] - r, shape["x"] + r, shape["y"] + r], outline=shape["color"], width=max(2, round(3 * unit)))
            draw.text((shape["x"] + r + 4 * unit, shape["y"]), shape["label"], font=label_font, fill=shape["color"], anchor="lm", **outline)
        else:
            draw.line([shape["x"], shape["y"], shape["lx"], shape["ly"]], fill="#fde68a", width=max(2, round(2 * unit)))
            r = 5 * unit
            draw.ellipse([shape["x"] - r, shape["y"] - r, shape["x"] + r, shape["y"] + r], fill="#fde68a")
            draw.text((shape["lx"], shape["ly"]), shape["label"], font=label_font, fill="#fde68a", anchor="mb", **outline)
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    return out.getvalue()


def annotated_svg(photo: Path, shapes: list[dict]) -> str:
    """The photo, re-encoded without metadata and embedded, with the shapes as vector elements on top."""
    image = _load_rgb(photo)
    width, height = image.size
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=90)
    data = base64.b64encode(buffer.getvalue()).decode()
    unit = max(width, height) / 1600
    root = Element("svg", {"xmlns": "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink",
                           "viewBox": f"0 0 {width} {height}", "width": str(width), "height": str(height), "font-family": "sans-serif"})

    def node(tag, **attrs):
        return SubElement(root, tag, {key.replace("_", "-"): str(value) for key, value in attrs.items()})

    SubElement(root, "image", {"width": str(width), "height": str(height), "xlink:href": f"data:image/jpeg;base64,{data}"})

    def label(x, y, text, color, size, anchor="start"):
        # Outline and fill are separate for SVG renderers without paint-order support.
        at = dict(x=f"{x:.1f}", y=f"{y:.1f}", font_size=f"{size:.1f}", text_anchor=anchor)
        node("text", **at, fill="none", stroke="#000", stroke_width=3 * unit, stroke_linejoin="round").text = str(text)
        node("text", **at, fill=color).text = str(text)

    for shape in shapes:
        if shape["kind"] == "box":
            node("rect", x=shape["x"], y=shape["y"], width=shape["w"], height=shape["h"], fill="none", stroke=shape["color"], stroke_width=3 * unit)
            label(shape["x"], shape["y"] - 6 * unit, shape["label"], shape["color"], 22 * unit)
            for pin in shape["pins"]:
                paint = dict(fill=pin["fill"] or "none", stroke="#000" if pin["fill"] else "#fff", stroke_width=2 * unit)
                if pin["first"]:
                    node("rect", x=pin["x"] - pin["r"], y=pin["y"] - pin["r"], width=2 * pin["r"], height=2 * pin["r"], **paint)
                else:
                    node("circle", cx=pin["x"], cy=pin["y"], r=pin["r"], **paint)
            for line_no, text in enumerate(shape["legend"]):
                label(shape["x"], shape["y"] + shape["h"] + (19 + 19 * line_no) * unit, text, "#ffffff", 15 * unit)
        elif shape["kind"] == "point":
            node("circle", cx=shape["x"], cy=shape["y"], r=12 * unit, fill="none", stroke=shape["color"], stroke_width=3 * unit)
            label(shape["x"] + 16 * unit, shape["y"] + 7 * unit, shape["label"], shape["color"], 22 * unit)
        else:
            node("line", x1=shape["x"], y1=shape["y"], x2=shape["lx"], y2=shape["ly"], stroke="#fde68a", stroke_width=2 * unit)
            node("circle", cx=shape["x"], cy=shape["y"], r=5 * unit, fill="#fde68a")
            label(shape["lx"], shape["ly"] - 4 * unit, shape["label"], "#fde68a", 22 * unit, "middle")
    return tostring(root, encoding="unicode") + "\n"


def _reading(reading: dict) -> str:
    state = "powered" if reading.get("powered") else "unpowered"
    return f'{reading.get("text", "")} ({state})'


def pinout_rows(project: dict, redactor: Redactor | None) -> list[dict]:
    markers = {m.get("schematicId"): m for m in project.get("markers", [])}
    rows = []
    for sch in project.get("schematics", []):
        header = _text(redactor, (markers.get(sch["id"]) or {}).get("label") or sch.get("name", ""))
        pins = {p["index"]: p for p in sch.get("pins", [])}
        for index in range(1, sch["rows"] * sch["cols"] + 1):
            pin = pins.get(index, {})
            guess = pin.get("guess") or {}
            rows.append({
                "header": header, "header_name": _text(redactor, sch.get("name", "")),
                "grid": f'{sch["rows"]}x{sch["cols"]}', "pitch_mm": sch.get("pitch", ""), "numbering": sch.get("numbering", ""),
                "pin": index, "role": pin.get("role", ""), "label": _text(redactor, pin.get("label", "")),
                "guess": f'{guess["role"]} ({guess.get("confidence", "")})' if guess.get("role") else "",
                "readings": "; ".join(_text(redactor, _reading(r)) for r in pin.get("readings", [])),
                "note": _text(redactor, pin.get("note", "")),
            })
    return rows


def pinouts_csv(rows: list[dict]) -> str:
    out = io.StringIO()
    fields = ["header", "header_name", "grid", "pitch_mm", "numbering", "pin", "role", "label", "guess", "readings", "note"]
    writer = csv.DictWriter(out, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def _cell(text) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _latest_serial_log(board_dir: Path, project: dict) -> tuple[dict, str] | None:
    serial = [c for c in project.get("captures", []) if c.get("kind") == "serial" and c.get("path")]
    for capture in reversed(serial):
        path = resolve_file(board_dir, capture["path"])
        if path is not None:
            text = ANSI_RE.sub("", path.read_text(encoding="utf-8", errors="replace")).replace("\r", "")
            if text.strip():
                return capture, text
    return None


def report_markdown(board_dir: Path, project: dict, photos: list[tuple[dict, str]], redactor: Redactor | None, *, files=None, playbooks_dir=None) -> str:
    meta = project.get("meta", {})
    def t(value):
        return _text(redactor, value)

    lines = [f'# {t(meta.get("name") or board_dir.name)}', ""]
    if meta.get("device"):
        lines += [t(meta["device"]), ""]
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    if redactor:
        lines += [f"Exported {stamp} with PCB Visualizer. Redacted: credentials, password hashes, serial numbers, MAC",
                  "addresses, public IP addresses and email addresses are replaced with stand-ins. Text printed in the",
                  "photos is not redacted.", ""]
    else:
        lines += [f"Exported {stamp} with PCB Visualizer. **Not redacted**: this export may contain serial numbers,",
                  "MAC addresses and credentials. Keep it private.", ""]
    if meta.get("notes"):
        lines += [t(meta["notes"]), ""]

    if photos:
        lines += ["## Photos", ""]
        for asset, name in photos:
            lines += [f'![{t(asset.get("label") or asset.get("side") or "photo")}]({name})', ""]

    callouts = project.get("annotations", [])
    if callouts:
        lines += ["## Labels on the board", ""]
        for c in callouts:
            lines.append(f'- {t(c.get("text", ""))}{" (unverified guess)" if c.get("guess") else ""}')
        lines.append("")

    markers = {m.get("schematicId"): m for m in project.get("markers", [])}
    if project.get("schematics"):
        lines += ["## Headers", ""]
    for sch in project.get("schematics", []):
        label = (markers.get(sch["id"]) or {}).get("label")
        name = sch.get("name", "")
        title = t(f"{label} {name}" if label and not name.startswith(label) else (name or label or "Header"))
        lines += [f'### {title}', "",
                  f'{sch["rows"]} x {sch["cols"]}, {sch.get("pitch", 2.54)} mm pitch, {sch.get("numbering", "row")} numbering.', ""]
        if sch.get("notes"):
            lines += [t(sch["notes"]), ""]
        pins = {p["index"]: p for p in sch.get("pins", [])}
        lines += ["| Pin | Role | Label | Readings | Note |", "|---|---|---|---|---|"]
        for index in range(1, sch["rows"] * sch["cols"] + 1):
            pin = pins.get(index, {})
            role = pin.get("role", "")
            guess = pin.get("guess") or {}
            if not role and guess.get("role"):
                role = f'{guess["role"]}? (unverified guess)'
            readings = "; ".join(t(_reading(r)) for r in pin.get("readings", []))
            lines.append(f'| {index} | {_cell(role)} | {_cell(t(pin.get("label", "")))} | {_cell(readings)} | {_cell(t(pin.get("note", "")))} |')
        lines.append("")

    findings = resolve_file(files if files is not None else board_dir, "analysis/findings.md")
    if findings is not None:
        own, assistant = _split_findings(findings.read_text(encoding="utf-8", errors="replace"))
        if own:
            lines += ["## Findings", "", t(own), ""]
        if assistant:
            lines += ["## Assistant findings (unverified)", "",
                      "The bench assistant wrote these. Nobody has checked them against the board.", "", t(assistant), ""]

    progress = project.get("playbooks", {})
    if progress:
        playbooks, _ = load_all(playbooks_dir if playbooks_dir is not None else board_dir.parent.parent / "playbooks")
        titles = {p["id"]: p for p in playbooks}
        lines += ["## Playbook progress", ""]
        for pid, record in progress.items():
            book = titles.get(pid)
            done = [sid for sid, step in (record.get("steps") or {}).items() if step.get("done")]
            total = len(book["steps"]) if book else "?"
            lines.append(f'- {book["title"] if book else pid}: {len(done)} of {total} steps done')
        lines.append("")

    captures = project.get("captures", [])
    if captures:
        lines += ["## Captures", "", "| Kind | Label | Started | Size |", "|---|---|---|---|"]
        for c in captures:
            lines.append(f'| {c.get("kind", "")} | {_cell(t(c.get("label", "")))} | {c.get("started", "")[:19].replace("T", " ")} UTC | {c.get("bytes", "")} |')
        lines.append("")

    latest = _latest_serial_log(files if files is not None else board_dir, project)
    if latest:
        capture, text = latest
        if redactor:                    # whole, so a key block that spans lines is found before the cut
            text = redact_lines("report.md", text, redactor)[0]
        log = text.strip("\n").split("\n")
        shown = "\n".join(log[:REPORT_LOG_LINES])
        more = f", first {REPORT_LOG_LINES} of {len(log)} lines" if len(log) > REPORT_LOG_LINES else ""
        lines += ["## Boot log", "", f'From the console capture "{t(capture.get("label", ""))}"{more}.', "", "```", shown, "```", ""]
    return "\n".join(lines).rstrip("\n") + "\n"


def export_root() -> Path:
    return Path(os.environ.get("PCBV_EXPORT_DIR") or Path.home() / "pcbv-exports")


def default_folder(slug: str) -> Path:
    return export_root() / f'{slug}-{datetime.now().strftime("%Y%m%d-%H%M%S")}'


def check_target(board_dir: Path, out: Path) -> Path:
    out = Path(out).expanduser().resolve()
    board_dir = Path(board_dir).resolve()
    if out == board_dir or board_dir in out.parents:
        raise ExportError("the export cannot go inside the board folder")
    repo = find_repo(board_dir)
    if repo is not None and (out == repo.resolve() or repo.resolve() in out.parents):
        raise ExportError(f"{out} is inside the data repo {repo}, where sync would commit it; choose a folder outside it")
    if out.exists():
        raise ExportError(f"{out} already exists; choose a new folder")
    return out


def _zip_folder(source: Path, target: Path, root_name: str) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file() and not path.is_symlink():
                archive.write(path, f"{root_name}/{path.relative_to(source)}")


def export_board(board_dir: Path, out: Path, formats=FORMATS, *, redact=True, project=None, files=None, playbooks_dir=None):
    with Directory(files if files is not None else board_dir) as root:
        return _export_board(board_dir, out, formats, redact=redact, project=project, files=root, playbooks_dir=playbooks_dir)


def _export_board(board_dir: Path, out: Path, formats=FORMATS, *, redact: bool = True, project: dict | None = None, files=None, playbooks_dir=None) -> Result:
    """Write the chosen formats to the new folder `out` and return what was written."""
    board_dir = Path(board_dir).resolve()
    unknown = [f for f in formats if f not in FORMATS]
    if unknown or not formats:
        raise ExportError(f"formats must be some of {', '.join(FORMATS)}")
    out = check_target(board_dir, out)
    if project is None:
        from .board import JOURNAL_REL, replay
        from .journal import read_journal
        project = replay(read_journal(board_dir / JOURNAL_REL, root=files).events)
    redactor = Redactor(custom=load_custom(files)) if redact else None
    result = Result(folder=out, redacted=redact)
    out.mkdir(parents=True)

    def write(name: str, data) -> None:
        path = out / name
        if isinstance(data, bytes):
            path.write_bytes(data)
        else:
            path.write_text(data, encoding="utf-8")
        result.files.append(name)

    photos: list[tuple[dict, str]] = []
    for number, asset in enumerate(project.get("assets", []), 1):
        path = resolve_file(files, asset.get("path", ""))
        if asset.get("kind") != "image" or path is None:
            continue
        name = re.sub(r"[^a-z0-9]+", "-", str(asset.get("label") or "").lower()).strip("-")[:40] or "photo"
        stem = f"photo-{number}-{name}"
        shapes = overlay(project, asset, redactor)
        if "photo" in formats or "report" in formats:
            write(f"{stem}.png", annotated_png(path, shapes))
            photos.append((asset, f"{stem}.png"))
        if "svg" in formats:
            write(f"{stem}.svg", annotated_svg(path, shapes))
        result.photos_to_check += 1
    rows = pinout_rows(project, redactor)
    if "csv" in formats:
        write("pinouts.csv", pinouts_csv(rows))
    if "json" in formats:
        write("pinouts.json", json.dumps(rows, indent=2, ensure_ascii=False) + "\n")
    if "report" in formats:
        write("report.md", report_markdown(board_dir, project, photos, redactor, files=files, playbooks_dir=playbooks_dir))
    if "zip" in formats:
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / board_dir.name
            if redact:
                redact_board(board_dir, copy, redactor=redactor, files=files)
            else:
                redact_board(board_dir, copy, redactor=_PassThrough(), files=files)
                (copy / "REDACTION.md").unlink()
            _zip_folder(copy, out / "board.zip", board_dir.name)
        result.files.append("board.zip")
    if redactor:
        result.counts = dict(redactor.counters)
    return result


class _PassThrough(Redactor):
    """For an unredacted zip: the same copying rules (no originals, no .pcbv/), text left as it is."""

    def text(self, text: str) -> tuple[str, list[str]]:
        return text, []

    def pem(self, match, found: list[str]) -> str:
        found.append("pem-block")
        return match.group(0)
