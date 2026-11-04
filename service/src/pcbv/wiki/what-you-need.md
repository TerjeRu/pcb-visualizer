# What you need

This page lists what you need to work on a real board. The app, the tutorial and the virtual board
(`pcbv vdev`) need none of it.

## Software

The Welcome screen and Settings, General check these items. They show the command for anything that is
missing.

| What | Command | Needed for |
|---|---|---|
| Serial port access | `sudo usermod -aG uucp $USER`, then log out and in | any USB-UART adapter |
| sigrok and PulseView | `sudo pacman -S sigrok-cli pulseview` | recording logic captures |
| FX2 analyzer firmware | `sudo pacman -S sigrok-firmware-fx2lafw` | the common 8-channel 24 MHz USB clones ([sigrok](sigrok)) |
| gitleaks | `sudo pacman -S gitleaks` | git backup of your boards |

After you install the firmware, unplug the analyzer and plug it in again. The access rules of the package
apply only when you plug the analyzer in.

## Hardware for a first console

| Item | What to look for | Read |
|---|---|---|
| Multimeter | continuity (beep), resistance and DC voltage modes | [Multimeter basics](multimeter) |
| USB-UART adapter | 3.3 V signal level; CP2102, FT232R or CH340 | [USB-UART adapter](usb-uart-adapter) |
| Jumper wires | female-to-female, 2.54 mm (often sold as Dupont wires), at least three | [Wiring](wiring) |
| Pin header or test hooks | 2.54 mm straight header, or hook clips, for holes with no pins | [Headers and pads](headers) |
| Tools to open cases | small Phillips and Torx screwdrivers, a plastic pry tool | [Opening cases](opening-cases) |
| A clear work surface | dry, non-conductive, with the board's own power adapter in reach | [Bench safety](safety) |

## Optional

| Item | What it adds | Read |
|---|---|---|
| Logic analyzer | records signals over time, to find the speed of a UART or to watch SPI | [Logic analyzer](logic-analyzer) |
| Soldering kit | fits a header into empty holes: iron, solder, flux, wick, a stand and glasses | [Soldering](soldering) |

[Your first live board](first-live-board) gives the whole procedure for when you have these items.
