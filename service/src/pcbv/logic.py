"""Logic analyzer captures: read and write sigrok sessions, read sigrok CSV, decode UART.

A capture is up to 8 digital channels sampled at a fixed rate, one byte per sample (bit n is
channel n). That covers the common 8-channel FX2 "Saleae clone" analyzers. Sigrok is not needed to
read or decode: a .sr session is a zip with a `metadata` INI file and raw sample chunks.

UART decoding is done here too (8 data bits, no parity, 1 stop bit, idle high, LSB first), so the
decoded text can go through the same recogniser as serial consoles and be compared with them.
"""
from __future__ import annotations

import configparser
import difflib
import io
import re
import zipfile
import zlib
from dataclasses import dataclass
from itertools import pairwise

MAX_SAMPLES = 200_000_000          # 200 MB of samples; a long FX2 capture at 8 MHz is ~25 s
MAX_EDGES = 20_000                 # per request for the waveform view
MAX_METADATA = 64 * 1024
READ_CHUNK = 1024 * 1024
_RATE_RE = re.compile(r"^\s*([\d.]+)\s*([kKmMgG]?)\s*Hz\s*$")


class LogicError(ValueError):
    """The file is not a capture this module can read, or a request does not fit it."""


@dataclass
class Capture:
    samplerate: int                 # samples per second
    channels: list[str]             # names, index = bit number
    samples: bytes                  # one byte per sample

    @property
    def duration(self) -> float:
        return len(self.samples) / self.samplerate if self.samplerate else 0.0


def parse_rate(text: str) -> int:
    """'1 MHz', '24MHz', '500 kHz', '8000000' -> samples per second."""
    text = str(text).strip()
    if text.isdigit():
        return int(text)
    match = _RATE_RE.match(text)
    if not match:
        raise LogicError(f"cannot read the sample rate {text!r}")
    value, unit = float(match.group(1)), match.group(2).lower()
    return int(value * {"": 1, "k": 1e3, "m": 1e6, "g": 1e9}[unit])


def format_rate(rate: int) -> str:
    for factor, unit in ((1_000_000_000, "GHz"), (1_000_000, "MHz"), (1_000, "kHz")):
        if rate % factor == 0:
            return f"{rate // factor} {unit}"
    return f"{rate} Hz"


def _read_member(archive: zipfile.ZipFile, name: str, limit: int, what: str) -> bytes:
    """A zip member decompressed in chunks, refused as soon as it passes `limit`, so a small file
    that expands enormously never gets to fill memory."""
    out = bytearray()
    with archive.open(name) as member:
        while chunk := member.read(READ_CHUNK):
            out += chunk
            if len(out) > limit:
                raise LogicError(what)
    return bytes(out)


def read_sr(data: bytes) -> Capture:
    try:
        return _read_sr(data)
    except LogicError:
        raise
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, configparser.Error, ValueError, KeyError,
            EOFError, zlib.error) as exc:
        raise LogicError(f"cannot read this sigrok session: {exc}") from exc


def _read_sr(data: bytes) -> Capture:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise LogicError("not a sigrok session (.sr is a zip file)") from exc
    names = archive.namelist()
    if "metadata" not in names:
        raise LogicError("the session has no metadata file")
    meta = configparser.ConfigParser(interpolation=None)
    meta.read_string(_read_member(archive, "metadata", MAX_METADATA, "the session metadata is larger than 64 KB")
                     .decode("utf-8", errors="replace"))
    device = next((s for s in meta.sections() if s.startswith("device")), None)
    if device is None:
        raise LogicError("the session describes no device")
    section = meta[device]
    rate = parse_rate(section.get("samplerate", "0"))
    unitsize = int(section.get("unitsize", "1"))
    if unitsize != 1:
        raise LogicError("only captures with up to 8 channels are supported")
    total = int(section.get("total probes", "8"))
    channels = [section.get(f"probe{i + 1}", f"D{i}") for i in range(min(total, 8))]
    prefix = section.get("capturefile", "logic-1")
    chunks = sorted((n for n in names if n == prefix or n.startswith(prefix + "-")),
                    key=lambda n: int(n.rsplit("-", 1)[1]) if n != prefix else 0)
    samples = bytearray()
    too_long = f"capture longer than {MAX_SAMPLES} samples"
    for name in chunks:
        samples += _read_member(archive, name, (MAX_SAMPLES - len(samples)) * unitsize, too_long)
    if not rate or not samples:
        raise LogicError("the session has no samples or no sample rate")
    return Capture(rate, channels, bytes(samples))


def write_sr(capture: Capture) -> bytes:
    """A sigrok session file PulseView can open."""
    lines = ["[global]", "sigrok version=0.5.2", "", "[device 1]", "capturefile=logic-1",
             f"total probes={len(capture.channels)}", f"samplerate={format_rate(capture.samplerate)}",
             "total analog=0"]
    lines += [f"probe{i + 1}={name}" for i, name in enumerate(capture.channels)]
    lines += ["unitsize=1", ""]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("version", "2")
        archive.writestr("metadata", "\n".join(lines))
        chunk = 4 * 1024 * 1024
        for n, start in enumerate(range(0, len(capture.samples), chunk), start=1):
            archive.writestr(f"logic-1-{n}", capture.samples[start:start + chunk])
    return out.getvalue()


def read_csv(text: str, samplerate: int | None = None) -> Capture:
    """sigrok-cli -O csv output: ';' comment lines (one may hold the sample rate), a header, 0/1 rows.
    A leading time column is ignored."""
    rate = samplerate
    header = None
    samples = bytearray()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(";"):
            found = re.search(r"[Ss]ample ?rate:?\s*([\d.]+\s*[kKmMgG]?Hz)", line)
            if found and rate is None:
                rate = parse_rate(found.group(1))
            continue
        cells = [c.strip() for c in line.split(",")]
        if header is None:
            header = cells
            continue
        bits = [c for c, name in zip(cells, header, strict=False) if not name.lower().startswith("time")]
        value = 0
        for i, bit in enumerate(bits[:8]):
            if bit not in ("0", "1"):
                raise LogicError(f"unexpected value {bit!r} in the CSV")
            value |= (bit == "1") << i
        samples.append(value)
        if len(samples) > MAX_SAMPLES:
            raise LogicError(f"capture longer than {MAX_SAMPLES} samples")
    if header is None or not samples:
        raise LogicError("the CSV has no header or no samples")
    if not rate:
        raise LogicError("the CSV does not say its sample rate; give it when importing")
    names = [n for n in header if not n.lower().startswith("time")][:8]
    return Capture(rate, names, bytes(samples))


def read_capture(data: bytes, filename: str, samplerate: int | None = None) -> Capture:
    if data[:2] == b"PK" or filename.lower().endswith(".sr"):
        return read_sr(data)
    try:
        return read_csv(data.decode("utf-8"), samplerate)
    except UnicodeDecodeError as exc:
        raise LogicError("not a sigrok session or a CSV file") from exc


# Long captures are tens of millions of samples, too many to loop over in Python. Each channel is
# turned into a bytes string of b"0" and b"1" with bytes.translate, and edges are found with
# bytes.find and regular expressions, which run in C.
_TABLES = [bytes((ord("1") if v >> bit & 1 else ord("0")) for v in range(256)) for bit in range(8)]
_EDGE = re.compile(rb"(?=01|10)")


def bits(capture: Capture, channel: int, start: int = 0, end: int | None = None) -> bytes:
    return capture.samples[start:end].translate(_TABLES[channel])


def edges(capture: Capture, start: int = 0, end: int | None = None, max_edges: int = MAX_EDGES) -> dict:
    """Level changes per channel in [start, end): {channel index: [[sample, level], ...]}, with the
    level at `start` first. Stops early (truncated=True) when there are too many to draw."""
    end = len(capture.samples) if end is None else min(end, len(capture.samples))
    start = max(0, min(start, end))
    result, truncated, cut = {}, False, end
    per_channel = max(1, max_edges // max(1, len(capture.channels)))
    for channel in range(len(capture.channels)):
        line = bits(capture, channel, start, end)
        changes = [[start, line[0] - 48 if line else 1]]
        for match in _EDGE.finditer(line):
            changes.append([start + match.start() + 1, line[match.start() + 1] - 48])
            if len(changes) > per_channel:
                truncated = True
                cut = min(cut, start + match.start() + 1)
                break
        result[channel] = changes
    if truncated:                       # keep every channel to the same window
        result = {ch: [e for e in changes if e[0] <= cut] for ch, changes in result.items()}
    return {"start": start, "end": cut, "edges": result, "truncated": truncated}


def activity(capture: Capture, start: int, end: int, bins: int) -> dict:
    """A window too busy to draw edge by edge, summarised per screen column: for each channel a
    string with one character per bin, "0" low, "1" high, "2" both (it changed inside the bin)."""
    end = min(end, len(capture.samples))
    start = max(0, min(start, end))
    bins = max(1, min(bins, 4000))
    size = max(1, (end - start) / bins)
    result = {}
    for channel in range(len(capture.channels)):
        line = bits(capture, channel, start, end)
        out = []
        for b in range(bins):
            chunk = line[int(b * size):int((b + 1) * size)]
            if not chunk:
                out.append(out[-1] if out else "1")
            elif b"0" in chunk and b"1" in chunk:
                out.append("2")
            else:
                out.append(chr(chunk[0]))
        result[channel] = "".join(out)
    return {"start": start, "end": end, "bins": result, "binSize": size}


COMMON_BAUDS = (300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000)


def estimate_baud(capture: Capture, channel: int, limit: int = 5_000_000) -> int | None:
    """The common baud rate whose bit time matches the shortest pulses on the channel."""
    line = bits(capture, channel, 0, limit)
    positions = [m.start() for m in _EDGE.finditer(line)]
    runs = sorted(b - a for a, b in pairwise(positions))
    if len(runs) < 20:
        return None
    short = runs[len(runs) // 20] if len(runs) > 40 else runs[0]   # ignore the odd glitch
    bit_time = short / capture.samplerate
    best = min(COMMON_BAUDS, key=lambda b: abs(1 / b - bit_time))
    return best if abs(1 / best - bit_time) <= 0.25 / best else None


def decode_uart(capture: Capture, channel: int, baud: int) -> dict:
    """8N1, idle high, LSB first. Returns the bytes, their sample positions and framing errors."""
    if not 0 <= channel < len(capture.channels):
        raise LogicError(f"there is no channel {channel}")
    if baud <= 0:
        raise LogicError("baud must be positive")
    spb = capture.samplerate / baud                 # samples per bit
    if spb < 4:
        raise LogicError(f"{format_rate(capture.samplerate)} is too slow for {baud} baud; "
                         "sample at least 4, better 8 times the baud rate")
    line = bits(capture, channel)
    n = len(line)
    data, positions, errors = bytearray(), [], 0
    i = 0
    while True:
        edge = line.find(b"10", i)                  # idle high falling to a start bit
        if edge < 0:
            break
        start = edge + 1
        middle = start + spb / 2
        if int(middle) >= n:
            break
        if line[int(middle)] == 49:                 # back high already: a glitch, not a start bit
            i = start
            continue
        value = 0
        complete = True
        for bit in range(8):
            at = int(middle + (bit + 1) * spb)
            if at >= n:
                complete = False
                break
            if line[at] == 49:
                value |= 1 << bit
        stop = int(middle + 9 * spb)
        if not complete or stop >= n:
            break
        if line[stop] != 49:
            errors += 1                             # framing error: no stop bit
        data.append(value)
        positions.append(start)
        i = int(middle + 9 * spb)                   # look for the next start from the stop bit on
    return {"bytes": bytes(data), "positions": positions, "errors": errors}


def terminal_text(text: str) -> str:
    """What a terminal would show: escape codes dropped, \r returns to the line start and \b steps
    back, so a countdown rewritten in place compares by its final text, as in app/js/core/terminal.js."""
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text).replace("\r\n", "\n")
    lines = []
    for raw in text.split("\n"):
        line, col = [], 0
        for ch in raw:
            if ch == "\r":
                col = 0
            elif ch == "\b":
                col = max(0, col - 1)
            elif ch >= " ":
                if col < len(line):
                    line[col] = ch
                else:
                    line.append(ch)
                col += 1
        lines.append("".join(line).rstrip())
    return "\n".join(lines)


def compare_text(decoded: str, console: str, limit: int = 20_000) -> dict:
    """How well a decoded capture matches a console log of the same boot. Text before the first
    common line is skipped on both sides, since the two rarely start at the same moment."""
    a, b = terminal_text(decoded)[:limit], terminal_text(console)[:limit]
    if not a.strip() or not b.strip():
        return {"ratio": 0.0, "first_difference": None}
    lines_a = a.split("\n")
    lines_b = b.split("\n")
    anchor = next(((i, lines_b.index(line)) for i, line in enumerate(lines_a) if len(line) > 8 and line in lines_b), None)
    if anchor:
        a = "\n".join(lines_a[anchor[0]:])
        b = "\n".join(lines_b[anchor[1]:])
    length = min(len(a), len(b))
    matcher = difflib.SequenceMatcher(None, a[:length], b[:length], autojunk=False)
    ratio = matcher.ratio()
    first = next((op for op in matcher.get_opcodes() if op[0] != "equal"), None)
    difference = None
    if first:
        line = a[:first[1]].count("\n") + 1
        difference = {"line": line, "decoded": a[first[1]:first[2]][:80], "console": b[first[3]:first[4]][:80]}
    return {"ratio": round(ratio, 3), "first_difference": difference}


def uart_waveform(text: bytes, baud: int, samplerate: int, *, lead_in: float = 0.01,
                  gap_bits: float = 0.0) -> bytearray:
    """Channel-0 samples (idle high) for text sent as 8N1; other bits stay high."""
    spb = samplerate / baud
    out = bytearray([0xFF]) * int(lead_in * samplerate)
    position = float(len(out))
    for byte in text:
        bits = [0] + [(byte >> i) & 1 for i in range(8)] + [1]
        for level in bits:
            target = position + spb
            out += bytes([0xFF if level else 0xFE]) * (int(target) - int(position))
            position = target
        if gap_bits:
            target = position + gap_bits * spb
            out += bytes([0xFF]) * (int(target) - int(position))
            position = target
    out += bytes([0xFF]) * int(lead_in * samplerate)
    return out


def virtual_boot_capture(baud: int = 115200, samplerate: int = 1_000_000) -> Capture:
    """What a logic analyzer on the virtual board's TX pin records during a boot: the same output
    `pcbv vdev` sends, as 8N1 on D0. D1 (RX) stays idle. For building and practising without hardware."""
    from .vdev import Console

    console = Console()
    text = ""
    for _ in range(4000):
        text += console.advance(0.01)
        if console.phase == "waitEnter":
            break
    wire = text.replace("\n", "\r\n").encode()
    return Capture(samplerate, [f"D{i}" for i in range(8)], bytes(uart_waveform(wire, baud, samplerate, gap_bits=1)))
