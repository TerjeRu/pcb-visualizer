"""Virtual device: a synthetic router, ARC-DEMO-01, as a serial port on a pty.

Any serial tool (tio, picocom, screen, pyserial, the future serial manager) can open the
stable path this prints and practise the console playbooks without real hardware. The board
talks at 115200 baud; the baud a client sets on the port is read back from the pty, and a
mismatch garbles the output the way a real UART does. The board is off while nobody has the
port open and powers on when a client connects, so every session starts with the full boot
log (wire the adapter first, then apply power, as on a real bench). A pty has no pins, so there is
nothing to wire or measure.

The console logic (`Console`) is pure and driven by `feed` and `advance`, so it is tested without a pty or clock.
"""
from __future__ import annotations

import os
import random
import select
import signal
import termios
import time
import tty
from pathlib import Path

from .runtime import runtime_dir
from .stopwith import stop_when_process_ends

BOARD_BAUD = 115200

BOOT_UBOOT = [
    (0.30, ""),
    (0.08, "U-Boot 2015.07-ARC (Mar 14 2019 - 10:21:07 +0000)"),
    (0.06, ""),
    (0.12, "CPU:   ARC7621 rev 1.2 @ 880 MHz"),
    (0.09, "DRAM:  128 MiB"),
    (0.26, "SF: Detected 25Q128 with page size 256 Bytes, erase size 64 KiB, total 16 MiB"),
    (0.08, "In:    serial"),
    (0.04, "Out:   serial"),
    (0.04, "Err:   serial"),
    (0.20, "Net:   eth0"),
]

BOOT_KERNEL = [
    (0.12, "## Booting kernel from Legacy Image at 9c050000 ..."),
    (0.09, "   Image Name:   Linux-4.4.198"),
    (0.06, "   Data Size:    1893416 Bytes = 1.8 MiB"),
    (0.50, "   Verifying Checksum ... OK"),
    (0.30, "   Uncompressing Kernel Image ... OK"),
    (0.20, ""),
    (0.08, "Starting kernel ..."),
    (0.50, ""),
    (0.06, "[    0.000000] Linux version 4.4.198 (builder@arc-demo) (gcc version 5.4.0) #1 SMP Thu Mar 14 10:19:52 UTC 2019"),
    (0.04, "[    0.000000] SoC Type: ARC7621 ver:1 eco:3"),
    (0.04, "[    0.000000] Kernel command line: console=ttyS0,115200 root=/dev/mtdblock5 rootfstype=squashfs"),
    (0.06, "[    0.000000] Memory: 121436K/131072K available"),
    (0.14, "[    0.410000] Serial: 8250/16550 driver, 3 ports, IRQ sharing disabled"),
    (0.08, "[    0.420000] 1e000c00.uartlite: ttyS0 at MMIO 0x1e000c00 (irq = 20, base_baud = 3125000) is a 16550A"),
    (0.16, "[    1.204000] spi-nor spi0.0: 25q128 (16384 Kbytes)"),
    (0.05, "[    1.210000] 6 fixed-partitions partitions found on MTD device spi0.0"),
    (0.03, '[    1.214000] Creating 6 MTD partitions on "spi0.0":'),
    (0.03, '[    1.218000] 0x000000000000-0x000000030000 : "u-boot"'),
    (0.03, '[    1.224000] 0x000000030000-0x000000040000 : "u-boot-env"'),
    (0.03, '[    1.230000] 0x000000040000-0x000000050000 : "factory"'),
    (0.03, '[    1.236000] 0x000000050000-0x000000250000 : "kernel"'),
    (0.03, '[    1.242000] 0x000000250000-0x000000e00000 : "rootfs"'),
    (0.03, '[    1.248000] 0x000000e00000-0x000001000000 : "rootfs_data"'),
    (0.40, "[    2.880000] VFS: Mounted root (squashfs filesystem) readonly on device 31:5."),
    (0.30, "[    3.020000] Freeing unused kernel memory: 208K"),
    (0.60, "[    5.102000] init: Console is alive"),
    (0.30, "[    6.330000] eth0: link up (1000Mbps/Full duplex)"),
    (0.40, ""),
    (0.06, "Please press Enter to activate this console."),
]

UBOOT_ENV = [
    "bootargs=console=ttyS0,115200 root=/dev/mtdblock5 rootfstype=squashfs",
    "bootcmd=bootm 0x9c050000",
    "bootdelay=3",
    "baudrate=115200",
    "ethaddr=00:0c:43:76:21:01",
    "ipaddr=192.168.1.1",
    "serverip=192.168.1.100",
    "",
    "Environment size: 210/4092 bytes",
]

UBOOT_HELP = (
    "boot     - boot default, i.e., run 'bootcmd'\n"
    "help     - print command description/usage\n"
    "printenv - print environment variables\n"
    "reset    - Perform RESET of the CPU\n"
    "sf       - SPI flash sub-system"
)

_LS = "bin   dev   etc   lib   mnt   overlay   proc   rom   root   sbin   sys   tmp   usr   var   www"
SHELL = {
    "help": "Built-in commands:\n  cat  cd  echo  help  id  ls  reboot  uname",
    "uname -a": "Linux ARC-DEMO 4.4.198 #1 SMP Thu Mar 14 10:19:52 UTC 2019 mips GNU/Linux",
    "uname": "Linux",
    "id": "uid=0(root) gid=0(root)",
    "ls": _LS,
    "ls /": _LS,
    "cat /proc/mtd": 'dev:    size   erasesize  name\nmtd0: 00030000 00010000 "u-boot"\nmtd1: 00010000 00010000 "u-boot-env"\n'
                     'mtd2: 00010000 00010000 "factory"\nmtd3: 00200000 00010000 "kernel"\n'
                     'mtd4: 00bb0000 00010000 "rootfs"\nmtd5: 00200000 00010000 "rootfs_data"',
    "cat /proc/cpuinfo": "system type\t\t: ARC7621 ver:1 eco:3\nmachine\t\t\t: ARC-DEMO-01\n"
                         "cpu model\t\t: MIPS 1004Kc V2.15\nBogoMIPS\t\t: 586.13",
    "cat /etc/banner": "  ARC-DEMO firmware 2.1.7\n  (synthetic demo board)",
}

UBOOT_PROMPT = "ARC7621 # "
SHELL_PROMPT = "root@ARC-DEMO:/# "
SHELL_BANNER = "\n\nBusyBox v1.25.1 () built-in shell (ash)\n\n  ARC-DEMO firmware 2.1.7\n\n" + SHELL_PROMPT


def garble(text: str, baud: int, rng: random.Random) -> str:
    """Wrong baud: the receiver samples at the wrong speed and sees junk bytes."""
    pool = "ÿþ€x~|¿ÃÂ#ð÷¦ª§®°±"
    ratio = baud / BOARD_BAUD
    out = []
    for ch in text:
        if ch == "\n" and rng.random() < 0.6:
            out.append("\r\n")
            continue
        n = (1 if rng.random() < ratio else 0) if ratio < 1 else round(ratio)
        out.extend(rng.choice(pool) for _ in range(n))
    return "".join(out)


class Console:
    """The board's serial console as a state machine.

    `advance(dt)` moves time forward and returns text the board sent; `feed(chars)` handles
    keystrokes and returns the board's reply. Text is in board form ("\\n"); the pty layer
    converts line endings and applies the baud check.
    """

    def __init__(self):
        self.power_on()

    def power_on(self) -> None:
        self.phase = "uboot"   # off | uboot | countdown | ubootPrompt | kernel | waitEnter | shell
        self.queue = list(BOOT_UBOOT)
        self.wait = 0.0
        self.countdown = 3
        self.line = ""

    def _run(self, lines, phase) -> None:
        self.phase = phase
        self.queue = list(lines)
        self.wait = 0.0

    def advance(self, dt: float) -> str:
        out = []
        self.wait += dt
        while True:
            if self.phase in ("uboot", "kernel"):
                if not self.queue:
                    if self.phase == "uboot":
                        self.phase, self.countdown, self.wait = "countdown", 3, 0.0
                        out.append("Hit any key to stop autoboot:  3 ")   # U-Boot: "%2d " then "\b\b\b%2d " per tick
                        continue
                    self.phase = "waitEnter"
                    break
                delay, text = self.queue[0]
                if self.wait < delay:
                    break
                self.wait -= delay
                self.queue.pop(0)
                out.append(text + "\n")
            elif self.phase == "countdown":
                if self.wait < 1.0:
                    break
                self.wait -= 1.0
                self.countdown -= 1
                out.append(f"\b\b\b{self.countdown:2d} ")
                if self.countdown == 0:
                    out.append("\n")
                    self._run(BOOT_KERNEL, "kernel")
            else:
                self.wait = 0.0
                break
        return "".join(out)

    def feed(self, chars: str) -> str:
        out = []
        for ch in chars:
            if self.phase == "countdown":
                self.phase = "ubootPrompt"
                out.append("\b\b\b 0 \n" + UBOOT_PROMPT)
            elif self.phase in ("ubootPrompt", "shell"):
                if ch in "\r\n":
                    out.append("\n" + self._command(self.line.strip()))
                    self.line = ""
                elif ch in "\x7f\b":
                    if self.line:
                        self.line = self.line[:-1]
                        out.append("\b \b")
                elif ch.isprintable():
                    self.line += ch
                    out.append(ch)
            elif self.phase == "waitEnter" and ch in "\r\n":
                self.phase = "shell"
                out.append(SHELL_BANNER)
            # booting: input is ignored, like a real kernel mid-boot
        return "".join(out)

    def _command(self, cmd: str) -> str:
        if self.phase == "ubootPrompt":
            if cmd == "printenv":
                return "\n".join(UBOOT_ENV) + "\n" + UBOOT_PROMPT
            if cmd in ("help", "?"):
                return UBOOT_HELP + "\n" + UBOOT_PROMPT
            if cmd == "boot":
                self._run(BOOT_KERNEL, "kernel")
                return ""
            if cmd == "reset":
                self.power_on()
                return "resetting ...\n"
            if cmd == "":
                return UBOOT_PROMPT
            return f"Unknown command '{cmd}' - try 'help'\n{UBOOT_PROMPT}"
        if cmd == "reboot":
            self.power_on()
            return "reboot: Restarting system\n"
        reply = ""
        if cmd:
            reply = SHELL.get(cmd) or (cmd[5:] if cmd.startswith("echo ") else f"-ash: {cmd.split(' ')[0]}: not found")
            reply += "\n"
        return reply + SHELL_PROMPT


# termios speed constant -> baud
_SPEEDS = {getattr(termios, f"B{b}"): b for b in (1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600)
           if hasattr(termios, f"B{b}")}


def default_link() -> Path:
    return runtime_dir() / "ttyPCBV0"


class VirtualPort:
    """A pty whose far end behaves like the board's UART."""

    def __init__(self, link: Path | None = None, seed: int | None = None):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)             # a UART passes bytes through; no line discipline
        attrs = termios.tcgetattr(self.slave)
        attrs[4] = attrs[5] = termios.B9600  # adapters often default to 9600
        termios.tcsetattr(self.slave, termios.TCSANOW, attrs)
        os.set_blocking(self.master, False)
        self.device = os.ttyname(self.slave)
        # Only clients hold the slave open, so the master reports a hangup exactly while nobody is
        # connected. The settings above stay on the pty after this close.
        os.close(self.slave)
        self.poll = select.poll()
        self.poll.register(self.master, select.POLLIN)
        self.connected = False
        self.link = Path(link) if link else default_link()
        self.link.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.link.symlink_to(self.device)
        except BaseException:
            os.close(self.master)
            raise
        self.rng = random.Random(seed)  # noqa: S311 - simulated boot noise, not security
        self.console = Console()
        self.console.phase = "off"

    def baud(self) -> int:
        # The pty shares one set of termios settings between both ends, so the master sees what
        # the client set on the slave.
        return _SPEEDS.get(termios.tcgetattr(self.master)[5], 0)

    def send(self, text: str) -> None:
        if not text:
            return
        baud = self.baud()
        wire = text.replace("\n", "\r\n") if baud == BOARD_BAUD else garble(text, baud, self.rng)
        try:
            os.write(self.master, wire.encode("utf-8", "replace"))
        except BlockingIOError:
            pass                           # nobody reading and the buffer is full: bytes are lost, as on a wire

    def receive(self, data: bytes) -> None:
        if self.baud() != BOARD_BAUD:
            self.send(garble(data.decode("latin-1"), self.baud(), self.rng))
            return
        self.send(self.console.feed(data.decode("latin-1")))

    def power_cycle(self) -> None:
        if self.connected:
            self.console.power_on()
            self.send("\n")

    def step(self, timeout: float) -> None:
        """Wait up to timeout for keystrokes, then move the board's clock forward. A client
        connecting powers the board on; with nobody connected it stays off."""
        start = time.monotonic()
        events = dict(self.poll.poll(timeout * 1000))
        hangup = bool(events.get(self.master, 0) & select.POLLHUP)
        if hangup:
            if self.connected:
                self.connected = False
                self.console.phase = "off"
            time.sleep(max(0.0, timeout - (time.monotonic() - start)))  # poll returns at once on hangup
            return
        if not self.connected:
            self.connected = True
            self.console.power_on()
            start = time.monotonic()
        if events.get(self.master, 0) & select.POLLIN:
            try:
                data = os.read(self.master, 1024)
            except (BlockingIOError, OSError):
                data = b""
            if data:
                self.receive(data)
        self.send(self.console.advance(time.monotonic() - start))

    def close(self) -> None:
        try:
            if self.link.is_symlink() and os.readlink(self.link) == self.device:
                self.link.unlink()
        finally:
            os.close(self.master)


def run(link: Path | None = None, out=lambda line: print(line, flush=True), watch_fd: int | None = None) -> int:
    port = VirtualPort(link)
    cycle = []
    signal.signal(signal.SIGUSR1, lambda *_: cycle.append(1))
    def exit_on_signal(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, exit_on_signal)
    if watch_fd is not None:                     # after the handler, so the stop takes the cleanup path below
        stop_when_process_ends(watch_fd)
    out(f"virtual ARC-DEMO-01 board on {port.link} -> {port.device}")
    out(f"connect with:  tio -b {BOARD_BAUD} {port.link}   (the board powers on when you connect)")
    out(f"power cycle:   kill -USR1 {os.getpid()}    stop: Ctrl-C")
    try:
        while True:
            if cycle:
                cycle.clear()
                port.power_cycle()
            port.step(0.05)
    except KeyboardInterrupt:
        pass
    finally:
        port.close()
    return 0
