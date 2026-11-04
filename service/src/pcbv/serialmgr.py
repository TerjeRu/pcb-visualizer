"""Serial consoles: list ports, run one session per port, capture everything to the board folder.

A session reads the port in a thread, appends the raw bytes to
`captures/serial/<time>_<id>.log` in the board folder, and hands decoded text to the service,
which broadcasts it to the board's WebSocket clients. Writes are whole lines, so every line can be
checked for commands that change the device (see DESTRUCTIVE) before it is sent.

Only ports from `list_ports()` can be opened: real USB serial adapters and the `pcbv vdev`
virtual board. The app can never point the service at an arbitrary device file.

Adapters are identified by their /dev/serial/by-path name (the USB socket) as well as by-id,
because many cheap adapters share a placeholder serial number like the CP2102's "0001".
"""
from __future__ import annotations

import codecs
import os
import re
import threading
import unicodedata
from collections.abc import Callable
from pathlib import Path

import serial
from serial.tools import list_ports as _list_ports

from .runtime import runtime_dir

from .captures import new_capture_id
from .fsutil import File, open_capture

CAPTURE_DIR = "captures/serial"
BAUD_RATES = (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600)
BACKLOG_BYTES = 64_000
MAX_LINE = 1000


def write_capture(stream, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = stream.write(remaining)
        if written is None or written <= 0:
            raise OSError("capture write made no progress")
        remaining = remaining[written:]

# Commands that write flash, change the bootloader's stored settings or erase things. A line is split
# at ;, && and ||, and each part is searched case-insensitively, so a command behind a pipe counts too.
# A match needs a typed confirmation in every mode.
DESTRUCTIVE = [
    (re.compile(p, re.IGNORECASE), why) for p, why in [
        (r"\b(env\s+save|saveenv)\b", "saves bootloader settings to flash"),
        (r"\b(env\s+(default|erase))\b", "resets or erases bootloader settings"),
        (r"\b(erase|protect\s+off)\b", "erases or unprotects flash"),
        (r"\b(sf|spi)\s+(erase|write|update)\b", "erases or writes SPI flash"),
        (r"\bnand\s+(erase|write|scrub)\b|\bnandwrite\b", "erases or writes NAND flash"),
        (r"\bmmc\s+(erase|write)\b", "erases or writes eMMC storage"),
        (r"\bubi\s+(write|remove|create)\b", "changes UBI volumes on flash"),
        (r"\b(fat|ext4)write\b|\bmkfs\b", "writes or formats a storage partition"),
        (r"\bmtd\s+(erase|write)\b|\bmtd_write\b|\bflash_erase(all)?\b|\bflashcp\b", "erases or writes flash from Linux"),
        (r"\bcp\.[bwl]\b", "copies memory, possibly into flash"),
        (r"\b(mw|mm|nm)\.?[bwlq]?\s", "writes memory directly"),
        (r"\bdd\b.*\bof=/dev/(mtd|mmcblk|sd)", "writes a raw flash or disk device"),
        (r"\bfw_setenv\b|\bnvram\s+(set|commit|erase)\b", "changes stored settings"),
        (r"\b(sysupgrade|mtd\s+-r\s+write|ubiformat|ubiupdatevol)\b", "replaces the firmware"),
        (r"\brm\s+-[a-z]*r[a-z]*f?\s+/\S*", "deletes files recursively"),
        (r"(?:>|\bof=)\s*/dev/(?:mtd|mmcblk|sd|nand)", "writes a raw flash or disk device"),
        (r"\b(?:cp|tee)\b.*\s/dev/(?:mtd|mmcblk|sd|nand)", "writes a raw flash or disk device"),
        (r"\bflash_unlock\b|\bfuse\s+(?:prog|override)\b", "changes flash protection or fuses"),
        (r"\b(?:eeprom|i2c|gpt|mmc)\b.*\bwrite\b|\bmmc\s+rpmb\b", "writes device storage"),
        (r"\bsf\s+protect\b", "changes SPI flash protection"),
        (r"\bdevmem\s+\S+\s+\S+\s+\S+", "writes memory directly"),
        (r"\brun\s+\S+", "runs a stored bootloader script"),
        (r"\brm\s+(?:-[a-z]+\s+)*-[a-z]*r[a-z]*\s+(?:-[a-z]+\s+)*/", "deletes files recursively"),
    ]
]


# What a session can recognise in the output, for playbook checks. Each kind is recorded on the
# capture the first time it is seen. Prompts are matched on the unfinished last line too, since a
# prompt waits for input without a newline.
SIGNS = [
    ("bootloader", re.compile(r"U-Boot \d{4}\.\d{2}|^CFE version|^Bootloader|^BootROM", re.IGNORECASE)),
    ("autoboot", re.compile(r"Hit any key to stop autoboot|Press any key|autoboot in \d", re.IGNORECASE)),
    ("uboot-prompt", re.compile(r"^\s*(=>|[A-Za-z0-9_.-]+\s?#|CFE>)\s*$")),
    ("env", re.compile(r"^(bootcmd|bootargs|bootdelay|baudrate)=")),
    ("help", re.compile(r"^\s*(printenv|bootm|setenv|md)\s+-\s")),
    ("kernel", re.compile(r"Linux version \d|Starting kernel")),
    ("shell", re.compile(r"BusyBox v\d|^[\w.-]+@[\w.-]+:[^#$]*[#$]\s*$|^/ #\s*$")),
    ("login", re.compile(r"\blogin:\s*$|Please press Enter to activate this console", re.IGNORECASE)),
]


class Detector:
    """Watches decoded output line by line and reports each kind in SIGNS once."""

    def __init__(self):
        self.seen: set[str] = set()
        self._partial = ""

    def feed(self, text: str) -> list[str]:
        new = []
        lines = (self._partial + text.replace("\r\n", "\n").replace("\r", "\n")).split("\n")
        self._partial = lines.pop()[-MAX_LINE:]
        for line in [*lines, self._partial]:
            for kind, pattern in SIGNS:
                if kind not in self.seen and pattern.search(line):
                    self.seen.add(kind)
                    new.append(kind)
        return new


def normalise_command(line: str) -> str:
    line = unicodedata.normalize("NFKC", line)
    line = re.sub(r"\\(.)", r"\1", line)
    words = line.replace("'", "").replace('"', "").split()
    result = []
    flags = ""
    for word in words:
        if re.fullmatch(r"-[A-Za-z]+", word):
            flags += word[1:]
        else:
            if flags:
                result.append("-" + "".join(sorted(flags)))
                flags = ""
            result.append(word)
    if flags:
        result.append("-" + "".join(sorted(flags)))
    return " ".join(result)


def forbidden_command_character(line: str) -> str | None:
    for char in line:
        code = ord(char)
        if 0x202a <= code <= 0x202e or 0x2066 <= code <= 0x2069 or 0x200b <= code <= 0x200d or code == 0xfeff:
            return f"command contains forbidden character U+{code:04X}"
    return None


def destructive_reason(line: str) -> str | None:
    """Why a typed line could change the device, or None when it looks read-only."""
    for part in [normalise_command(line), *re.split(r";|&&|\|\||\|", normalise_command(line))]:
        for pattern, why in DESTRUCTIVE:
            if pattern.search(part.strip()):
                return why
    return None


def vdev_link() -> Path:
    return runtime_dir() / "ttyPCBV0"


def _links(directory: str) -> dict[str, str]:
    """device path -> symlink path for /dev/serial/by-id or by-path."""
    found = {}
    base = Path(directory)
    if base.is_dir():
        for link in sorted(base.iterdir()):
            try:
                found[os.path.realpath(link)] = str(link)
            except OSError:
                continue
    return found


def list_ports() -> list[dict]:
    """Ports the app may open, with what is known about each."""
    by_id, by_path = _links("/dev/serial/by-id"), _links("/dev/serial/by-path")
    ports = []
    for p in sorted(_list_ports.comports(), key=lambda p: p.device):
        if not p.device.startswith("/dev/tty") or p.vid is None:
            continue                     # built-in ttyS* without hardware behind them
        ports.append({
            "path": p.device,
            "label": f"{p.product or p.description or 'USB serial'} ({Path(p.device).name})",
            "byId": by_id.get(p.device, ""),
            "byPath": by_path.get(p.device, ""),
            "vidPid": f"{p.vid:04x}:{p.pid:04x}",
            "serial": p.serial_number or "",
            "virtual": False,
        })
    link = vdev_link()
    if link.is_symlink() and Path(os.path.realpath(link)).exists():
        ports.append({"path": str(link), "label": "Virtual board (pcbv vdev)", "byId": "", "byPath": "",
                      "vidPid": "", "serial": "", "virtual": True})
    return ports


class PortNotAllowed(ValueError):
    pass


class SerialSession:
    """One open port, read in a thread, captured to a file."""

    def __init__(self, *, board_dir: Path, slug: str, port: dict, baud: int,
                 on_text: Callable[[str], None], on_end: Callable[[str], None],
                 on_seen: Callable[[list[str]], None] = lambda kinds: None):
        self.id, self.rel_path = new_capture_id(CAPTURE_DIR, "log", id_bytes=16)
        self.slug, self.port, self.baud = slug, port, baud
        self.file_path = File(board_dir, self.rel_path)
        self.bytes = 0
        self.backlog = bytearray()
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._on_text, self._on_end, self._on_seen = on_text, on_end, on_seen
        self.detector = Detector()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._finish_lock = threading.Lock()
        self._finished = False
        self._serial = serial.Serial(port["path"], baud, timeout=0.05, exclusive=True)
        try:
            self._file = open_capture(board_dir, self.rel_path)
        except BaseException:
            self._serial.close()
            raise
        self._thread = threading.Thread(target=self._read_loop, name=f"serial-{self.id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def describe(self) -> dict:
        return {"captureId": self.id, "board": self.slug, "port": self.port["path"],
                "label": self.port["label"], "baud": self.baud, "path": self.rel_path, "bytes": self.bytes,
                "seen": sorted(self.detector.seen)}

    def _read_loop(self) -> None:
        reason = "closed"
        try:
            while not self._stop.is_set():
                data = self._serial.read(4096)
                if not data:
                    continue
                with self._lock:
                    try:
                        write_capture(self._file, data)
                    except OSError as exc:
                        self._stop.set()
                        reason = f"recording error: {exc}"
                        break
                    self.bytes += len(data)
                    self.backlog += data
                    del self.backlog[:-BACKLOG_BYTES]
                text = self._decoder.decode(data)
                self._on_text(text)
                new = self.detector.feed(text)
                if new:
                    self._on_seen(sorted(self.detector.seen))
        except (serial.SerialException, OSError) as exc:
            if not self._stop.is_set():
                reason = f"port lost: {exc}"
        finally:
            self._stop.set()
            self._finish()
            if reason != "closed":
                self._on_end(reason)

    def write_line(self, line: str) -> int:
        data = (line + "\r").encode("utf-8")
        with self._lock:
            if self._stop.is_set():
                raise OSError("console session has stopped")
            return self._serial.write(data)

    def write_raw(self, data: bytes) -> int:
        with self._lock:
            if self._stop.is_set():
                raise OSError("console session has stopped")
            return self._serial.write(data)

    def backlog_text(self) -> str:
        with self._lock:
            return bytes(self.backlog).decode("utf-8", errors="replace")

    def _finish(self) -> None:
        with self._finish_lock:
            if self._finished:
                return
            self._finished = True
            for closer in (self._serial.close, self._file.close):
                try:
                    closer()
                except OSError:
                    pass

    def close(self) -> None:
        self._stop.set()
        if self._thread.ident is not None:
            self._thread.join(timeout=2)
        self._finish()


class SerialManager:
    """All sessions of this service, at most one per port."""

    def __init__(self):
        self.sessions: dict[str, SerialSession] = {}       # port path -> session
        self._lock = threading.Lock()

    def resolve(self, path: str) -> dict:
        for port in list_ports():
            if port["path"] == path:
                return port
        raise PortNotAllowed(f"{path!r} is not one of the serial ports this service lists")

    def for_board(self, slug: str) -> SerialSession | None:
        with self._lock:
            return next((s for s in self.sessions.values() if s.slug == slug), None)

    def open(self, **kwargs) -> SerialSession:
        port = kwargs["port"]
        with self._lock:
            if port["path"] in self.sessions:
                raise FileExistsError(f"{port['label']} is already open for board {self.sessions[port['path']].slug}")
            session = SerialSession(**kwargs)
            self.sessions[port["path"]] = session
            return session

    def forget(self, session: SerialSession) -> None:
        with self._lock:
            if self.sessions.get(session.port["path"]) is session:
                del self.sessions[session.port["path"]]

    def all_sessions(self) -> list[SerialSession]:
        with self._lock:
            return list(self.sessions.values())

    def close_all(self) -> list[SerialSession]:
        closed = self.all_sessions()
        for session in closed:
            session.close()
        self.sessions.clear()
        return closed


def scan_text(text: str) -> list[str]:
    """Everything SIGNS recognises in a whole transcript, sorted."""
    scanner = TranscriptScanner()
    scanner.feed(text)
    scanner.finish_line()
    return sorted(scanner.seen)


def scan_stream(stream) -> tuple[int, list[str]]:
    scanner = TranscriptScanner()
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    size = 0
    while data := stream.read(65536):
        size += len(data)
        scanner.feed(decoder.decode(data))
    scanner.feed(decoder.decode(b"", final=True))
    scanner.finish_line()
    return size, sorted(scanner.seen)


class TranscriptScanner:
    """Recognise complete lines with bounded state, including arbitrarily long prompts."""

    def __init__(self):
        self.seen: set[str] = set()
        self.reset_line()

    def reset_line(self):
        self.prefix = ""
        self.tail = ""
        self.help_prefix = ""
        self.login_tail = ""
        self.shell_state = "user_start"
        self.uboot_states = {"leading"}
        self.root_prompt = 0

    def feed(self, text: str):
        parts = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        for index, part in enumerate(parts):
            self.feed_line(part)
            if index < len(parts) - 1:
                self.finish_line()
                self.reset_line()

    def feed_line(self, text: str):
        window = self.tail + text
        for kind, expression in (
            ("bootloader", r"U-Boot \d{4}\.\d{2}"),
            ("autoboot", r"Hit any key to stop autoboot|Press any key|autoboot in \d"),
            ("kernel", r"Linux version \d|Starting kernel"),
            ("shell", r"BusyBox v\d"),
            ("login", r"Please press Enter to activate this console"),
        ):
            if re.search(expression, window, re.IGNORECASE if kind in ("bootloader", "autoboot", "login") else 0):
                self.seen.add(kind)
        self.tail = window[-8192:]
        self.prefix = (self.prefix + text)[:32]
        for char in text:
            self.step(char)

    def step(self, char: str):
        word = char.isalnum() or char in "_.-"
        ascii_word = char.isascii() and word
        state = self.shell_state
        if state == "user_start":
            self.shell_state = "user" if word else "invalid"
        elif state == "user":
            self.shell_state = "user" if word else "host_start" if char == "@" else "invalid"
        elif state == "host_start":
            self.shell_state = "host" if word else "invalid"
        elif state == "host":
            self.shell_state = "host" if word else "path" if char == ":" else "invalid"
        elif state == "path":
            self.shell_state = "end" if char in "#$" else "path"
        elif state == "end" and not char.isspace():
            self.shell_state = "invalid"

        new = set()
        for state in self.uboot_states:
            if state == "leading":
                if char.isspace():
                    new.add("leading")
                if char == "=":
                    new.add("equals")
                if char == "C":
                    new.add("c")
                if ascii_word:
                    new.add("token")
            elif state == "equals" and char == ">" or state == "cfe" and char == ">":
                new.add("end")
            elif state == "c" and char == "F":
                new.add("cf")
            elif state == "cf" and char == "E":
                new.add("cfe")
            elif state == "token":
                if ascii_word:
                    new.add("token")
                elif char == "#":
                    new.add("end")
                elif char.isspace():
                    new.add("one_space")
            elif state == "one_space" and char == "#":
                new.add("end")
            elif state == "end" and char.isspace():
                new.add("end")
        self.uboot_states = new

        if self.root_prompt >= 0:
            expected = "/ #"
            if self.root_prompt < len(expected) and char == expected[self.root_prompt]:
                self.root_prompt += 1
            elif self.root_prompt == len(expected) and char.isspace():
                pass
            else:
                self.root_prompt = -1
        if not char.isspace():
            self.login_tail = (self.login_tail + char)[-16:]
        elif self.login_tail and not self.login_tail.endswith(" "):
            self.login_tail = (self.login_tail + " ")[-16:]
        if len(self.help_prefix) < 128:
            if char.isspace():
                if self.help_prefix and not self.help_prefix.endswith(" "):
                    self.help_prefix += " "
            else:
                self.help_prefix += char

    def finish_line(self):
        if re.search(r"^CFE version|^Bootloader|^BootROM", self.prefix, re.IGNORECASE):
            self.seen.add("bootloader")
        if re.search(r"^(bootcmd|bootargs|bootdelay|baudrate)=", self.prefix):
            self.seen.add("env")
        if re.search(r"^(printenv|bootm|setenv|md)\s+-\s", self.help_prefix):
            self.seen.add("help")
        if "end" in self.uboot_states:
            self.seen.add("uboot-prompt")
        if self.shell_state == "end" or self.root_prompt == 3:
            self.seen.add("shell")
        if re.search(r"\blogin:\s*$", self.login_tail, re.IGNORECASE):
            self.seen.add("login")


def readability(data: bytes) -> float:
    """Share of bytes that look like terminal text (printable ASCII, tab, CR, LF). Wrong baud rates
    produce mostly high and control bytes."""
    if not data:
        return 0.0
    good = sum(1 for b in data if 32 <= b < 127 or b in (9, 10, 13))
    return good / len(data)


def probe_bauds(path: str, bauds=(115200, 57600, 38400, 19200, 9600, 230400), seconds: float = 1.5) -> list[dict]:
    """Listen at each speed in turn and score what arrives. Needs the board to be printing, so the
    person power-cycles it while this runs. Returns results best first."""
    results = []
    for baud in bauds:
        data = bytearray()
        try:
            with serial.Serial(path, baud, timeout=0.1, exclusive=True) as port:
                end = threading.Event()
                timer = threading.Timer(seconds, end.set)
                timer.start()
                while not end.is_set() and len(data) < 20000:
                    data += port.read(2048)
                timer.cancel()
        except (serial.SerialException, OSError) as exc:
            results.append({"baud": baud, "bytes": 0, "score": 0.0, "error": str(exc)})
            continue
        score = readability(bytes(data)) if len(data) >= 40 else 0.0
        sample = bytes(data[:160]).decode("utf-8", errors="replace")
        results.append({"baud": baud, "bytes": len(data), "score": round(score, 3), "sample": sample})
    return sorted(results, key=lambda r: (r["score"], r["bytes"]), reverse=True)
