import os
import select
import termios
import time

import pytest

from pcbv.vdev import BOARD_BAUD, SHELL_PROMPT, UBOOT_PROMPT, Console, VirtualPort


@pytest.mark.parametrize("symlink", [False, True])
def test_virtual_port_preserves_existing_link_or_file(tmp_path, symlink):
    target = tmp_path / "target"
    target.write_text("keep")
    link = tmp_path / "ttyTEST"
    if symlink:
        link.symlink_to(target)
    else:
        link.write_text("keep")
    with pytest.raises(FileExistsError):
        VirtualPort(link)
    assert link.read_text() == "keep"


def boot_until(console, phase, limit=60.0):
    out = ""
    t = 0.0
    while console.phase != phase and t < limit:
        out += console.advance(0.05)
        t += 0.05
    assert console.phase == phase
    return out


def test_boot_runs_uboot_countdown_kernel_then_waits_for_enter():
    c = Console()
    out = boot_until(c, "countdown")
    assert "U-Boot 2015.07-ARC" in out and out.endswith("Hit any key to stop autoboot:  3 ")
    out = boot_until(c, "waitEnter")
    assert "Starting kernel" in out and out.rstrip().endswith("Please press Enter to activate this console.")
    assert c.feed("ls") == ""     # only Enter activates the console
    assert c.feed("\r").endswith(SHELL_PROMPT)
    assert c.phase == "shell"


def test_any_key_stops_autoboot_and_uboot_commands_work():
    c = Console()
    boot_until(c, "countdown")
    assert c.feed("x").endswith(UBOOT_PROMPT)
    out = c.feed("printenv\r")
    assert out.startswith("printenv\n") and "bootcmd=bootm 0x9c050000" in out and out.endswith(UBOOT_PROMPT)
    assert "Unknown command 'flash'" in c.feed("flash\r")
    c.feed("boot\r")
    assert c.phase == "kernel"


def test_shell_echoes_handles_backspace_and_runs_commands():
    c = Console()
    boot_until(c, "waitEnter")
    assert c.feed("\r").endswith(SHELL_PROMPT)
    assert c.feed("idd\x7f") == "idd\b \b"
    assert c.feed("\r") == "\nuid=0(root) gid=0(root)\n" + SHELL_PROMPT
    assert "not found" in c.feed("nc -l\r")
    assert "reboot: Restarting system" in c.feed("reboot\r")
    assert c.phase == "uboot"


def test_input_while_booting_is_ignored():
    c = Console()
    assert c.feed("hello\r") == ""
    assert c.phase == "uboot"


def open_client(port, baud):
    fd = os.open(port.link, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    speed = getattr(termios, f"B{baud}")
    attrs[4] = attrs[5] = speed
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    return fd


def read_for(port, fd, seconds):
    out = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        port.step(0.02)
        while select.select([fd], [], [], 0)[0]:
            out += os.read(fd, 4096)
    return out


@pytest.fixture
def port(tmp_path):
    p = VirtualPort(tmp_path / "ttyTEST", seed=1)
    yield p
    p.close()


def test_pty_at_the_right_baud_shows_the_boot_log(port):
    fd = open_client(port, BOARD_BAUD)
    try:
        out = read_for(port, fd, 1.6).decode()
        assert "U-Boot 2015.07-ARC" in out and "\r\n" in out
        os.write(fd, b"\r")
        out = read_for(port, fd, 0.3).decode()
        assert out.endswith(UBOOT_PROMPT)
    finally:
        os.close(fd)


def test_pty_at_the_wrong_baud_is_garbled(port):
    fd = open_client(port, 9600)
    try:
        out = read_for(port, fd, 1.6).decode("utf-8", "replace")
        assert out and "U-Boot" not in out
    finally:
        os.close(fd)


def test_close_removes_the_link(tmp_path):
    p = VirtualPort(tmp_path / "ttyX")
    assert (tmp_path / "ttyX").is_symlink()
    p.close()
    assert not (tmp_path / "ttyX").exists()


def test_board_stays_off_until_a_client_connects_and_reboots_on_reconnect(port):
    for _ in range(10):
        port.step(0.01)
    assert port.console.phase == "off" and not port.connected
    fd = open_client(port, BOARD_BAUD)
    try:
        out = read_for(port, fd, 1.6).decode()
        assert out.lstrip().startswith("U-Boot 2015.07-ARC")   # nothing stale from before the connect
    finally:
        os.close(fd)
    port.step(0.01)
    assert port.console.phase == "off"
    fd = open_client(port, BOARD_BAUD)
    try:
        assert "U-Boot 2015.07-ARC" in read_for(port, fd, 1.6).decode()
    finally:
        os.close(fd)
