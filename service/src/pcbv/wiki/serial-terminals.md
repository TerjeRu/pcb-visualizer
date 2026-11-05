# Serial terminals

A serial terminal program opens a serial port, shows what arrives and sends what you type. The Console panel is one. It has speed detection, highlights and captures built in. A command-line terminal is useful as a second opinion when something does not work, and on machines without the app.

## Programs

| Program | Install on Arch | Open a port | Quit |
|---|---|---|---|
| tio | `yay -S tio` (AUR) | `tio -b 115200 /dev/ttyUSB0` | `Ctrl-t q` |
| picocom | `sudo pacman -S picocom` | `picocom -b 115200 /dev/ttyUSB0` | `Ctrl-a Ctrl-x` |
| screen | `sudo pacman -S screen` | `screen /dev/ttyUSB0 115200` | `Ctrl-a k`, then `y` |
| minicom | `sudo pacman -S minicom` | `minicom -D /dev/ttyUSB0 -b 115200` | `Ctrl-a x` |

On Debian and Ubuntu, install them with `sudo apt install tio picocom screen minicom`. On Fedora, use `sudo dnf install tio picocom screen minicom`.

tio reconnects automatically when you unplug the adapter and plug it back in. This makes it the most convenient of the four for board work.

## Settings

| Setting | Router consoles | Notes |
|---|---|---|
| Speed | 115200 | sometimes 57600, 38400 or 9600 |
| Data bits, parity, stop bits | 8N1 | the default in every program above |
| Flow control | none | hardware flow control stops the output when RTS and CTS are unconnected |
| Enter | sends CR | bootloaders and Linux consoles expect it |

## Saving a session

Save every session. A boot log is the most useful single file in an investigation.

```
tio -b 115200 --log --log-file boot.log /dev/ttyUSB0
picocom -b 115200 --logfile boot.log /dev/ttyUSB0
```

The Console panel saves every session automatically as a console capture in the board's `captures/serial/` folder.

## Common problems

| Symptom | Cause |
|---|---|
| "Device or resource busy" | another program, or the app's Console panel, has the port open |
| "Permission denied" | your user is not in the group that owns serial ports (`uucp` on Arch, `dialout` on Debian, Ubuntu and Fedora). See [USB-UART adapter](usb-uart-adapter) |
| Output appears, but typing does nothing | the adapter's TXD is not connected to the board's RX, or flow control is on |
| Every character appears twice | local echo is on, and the board already echoes what you type |
| Lines run into each other or step across the screen | the line endings do not match. The `--map` option of tio and the `--imap` option of picocom change them |

## Sending a break

Some bootloaders stop on a serial break instead of a key press. tio sends a break with `Ctrl-t b`. picocom sends a break with `Ctrl-a Ctrl-\`.

Related: [USB-UART adapter](usb-uart-adapter), [UART](uart), [Reading a boot log](reading-boot-logs).
