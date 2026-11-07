"""Editing a board from the command line: `pcbv note` and `pcbv measure`.

While a service runs it holds the board's lock, so edits go through its HTTP API and every open
app sees them live. With no service running the board is opened directly. Both paths store the
same events.

Readings are kept on the pin as a `readings` list (unknown pin keys are preserved by both
reducers), newest last:
  {"ts", "mode": "dc" | "ohm" | "continuity", "value": float | null, "unit": "V" | "Ω" | "",
   "text": "3.29 V", "powered": bool, "source": "cli"}
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime
import urllib.error
import urllib.request
from pathlib import Path

from .board import Board
from .boards import board_path
from .schema import now_iso, PROTOCOL_VERSION

_READING_RE = re.compile(r"^\s*(-?\d+(?:[.,]\d+)?)\s*(mv|v|kohm|kω|k|mohm|mω|ohm|ohms|ω|r)?\s*$", re.IGNORECASE)
_SCALE = {"mv": ("V", 0.001, "dc"), "v": ("V", 1, "dc"),
          "k": ("Ω", 1e3, "ohm"), "kohm": ("Ω", 1e3, "ohm"), "kω": ("Ω", 1e3, "ohm"),
          "mohm": ("Ω", 1e6, "ohm"), "mω": ("Ω", 1e6, "ohm"),
          "ohm": ("Ω", 1, "ohm"), "ohms": ("Ω", 1, "ohm"), "ω": ("Ω", 1, "ohm"), "r": ("Ω", 1, "ohm")}


class EditError(ValueError):
    pass


def parse_reading(text: str) -> dict:
    """'3.29V', '330 mV', '0.3ohm', '4.7k', 'OL' (open loop) or 'beep' (continuity) to a reading."""
    raw = text.strip()
    lowered = raw.lower()
    if lowered in ("ol", "open", "o.l."):
        return {"mode": "ohm", "value": None, "unit": "Ω", "text": "OL"}
    if lowered in ("beep", "short", "continuity"):
        return {"mode": "continuity", "value": 0.0, "unit": "Ω", "text": "beep"}
    match = _READING_RE.match(raw)
    if not match:
        raise EditError(f"cannot read {text!r}; write it like 3.29V, 330mV, 0.3ohm, 4.7k, OL or beep")
    number = float(match.group(1).replace(",", "."))
    unit, factor, mode = _SCALE[(match.group(2) or "v").lower()]
    value = round(number * factor, 6)
    if not math.isfinite(value):
        raise EditError("the number is too large; write it like 3.29V, 330mV, 0.3ohm, 4.7k, OL or beep")
    if mode == "ohm" and match.group(1).startswith("-"):
        raise EditError("a resistance cannot be negative; write it like 0.3ohm or 4.7k")
    shown = f"{value:g} {unit}" if unit == "V" else _ohms(value)
    return {"mode": mode, "value": value, "unit": unit, "text": shown}


def _ohms(value: float) -> str:
    if value >= 1e6:
        return f"{value / 1e6:g} MΩ"
    if value >= 1e3:
        return f"{value / 1e3:g} kΩ"
    return f"{value:g} Ω"


def find_header(project: dict, name: str) -> dict:
    """A header by its marker's silkscreen label (J4) or by its own name (UART), ignoring case."""
    wanted = name.strip().lower()
    by_id = {s["id"]: s for s in project["schematics"]}
    matches = {m["schematicId"] for m in project["markers"] if (m.get("label") or "").lower() == wanted}
    matches |= {s["id"] for s in project["schematics"] if (s.get("name") or "").lower() == wanted}
    matches &= by_id.keys()
    if not matches:
        known = sorted({m.get("label") for m in project["markers"] if m.get("label")} |
                       {s.get("name") for s in project["schematics"] if s.get("name")})
        hint = f" Known: {', '.join(known)}." if known else " Draw a box around it in the app first."
        raise EditError(f"no header called {name!r}.{hint}")
    if len(matches) > 1:
        raise EditError(f"{name!r} matches {len(matches)} headers; use a more specific name")
    return by_id[matches.pop()]


def check_pin(header: dict, index: int, name: str) -> None:
    count = header["rows"] * header["cols"]
    if not 1 <= index <= count:
        raise EditError(f"{name} has pins 1 to {count}")


def pin_of(header: dict, index: int) -> dict:
    return next((p for p in header.get("pins", []) if p.get("index") == index), {})


def reading_event(project: dict, header_name: str, index: int, text: str, powered: bool | None) -> tuple[dict, dict, list[str]]:
    """An append-only measurement event, the reading, and any safety warnings."""
    header = find_header(project, header_name)
    check_pin(header, index, header_name)
    reading = parse_reading(text)
    if powered is None:
        powered = reading["mode"] == "dc"
    warnings = []
    if reading["mode"] != "dc" and powered:
        warnings.append("resistance and continuity are measured with the board unplugged; "
                        "on a powered board the reading is meaningless and the meter can be damaged")
    if reading["mode"] == "dc" and not powered:
        warnings.append("a voltage on an unpowered board usually means a capacitor still holds charge")
    reading = {"ts": now_iso(), **reading, "powered": powered, "source": "cli"}
    event = {"type": "pin/readingAdded", "schematicId": header["id"], "index": index, "reading": reading}
    return event, reading, warnings


def note_event(project: dict, text: str, pin: str | None = None) -> dict:
    """A timestamped line added to the board notes, or to a pin's note with pin='J4:2'."""
    text = text.strip()
    if not text:
        raise EditError("the note is empty")
    stamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")   # read by people, so local time
    if pin is None:
        notes = project["meta"].get("notes", "")
        line = f"- {stamp} {text}"
        return {"type": "project/metaUpdated", "patch": {"notes": f"{notes.rstrip()}\n{line}".lstrip("\n")}}
    name, sep, number = pin.rpartition(":")
    if not sep or not number.isdigit():
        raise EditError("give the pin as HEADER:NUMBER, for example J4:2")
    header = find_header(project, name)
    index = int(number)
    check_pin(header, index, name)
    old = pin_of(header, index).get("note", "")
    note = f"{old.rstrip()}\n{stamp} {text}".lstrip("\n")
    return {"type": "pin/updated", "schematicId": header["id"], "index": index, "patch": {"note": note}}


class HttpWriter:
    """Edits through a running service, so open apps update live."""

    def __init__(self, info: dict, slug: str):
        self.base = f"{info['url']}/api/boards/{slug}"
        self.headers = {"Authorization": f"Bearer {info['token']}", "Content-Type": "application/json", "X-PCBV-Protocol": str(PROTOCOL_VERSION)}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never via a proxy

    def _call(self, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers=self.headers, method="POST" if data else "GET")  # noqa: S310 - the local service's URL from service.json
        try:
            with self.opener.open(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                message = json.load(exc).get("message", exc.reason)
            except ValueError:
                message = exc.reason
            raise EditError(f"the service refused: {message}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise EditError("The operation may have completed. Refresh and inspect the board before trying again.") from None

    @property
    def project(self) -> dict:
        return self._call("")["project"]

    def apply(self, event: dict) -> dict:
        return self._call("/events", {"event": event, "actor": "cli"})["event"]

    def close(self) -> None:
        pass


class LocalWriter:
    """Edits straight into the board folder when no service is running."""

    def __init__(self, root: Path, slug: str):
        self.board = Board.open(board_path(root, slug))

    @property
    def project(self) -> dict:
        return self.board.project

    def apply(self, event: dict) -> dict:
        return self.board.apply(event, "cli")

    def close(self) -> None:
        self.board.close()
