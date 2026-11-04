# Roadmap

This file lists the planned work after version 0.1.0. The items have no dates. Each item gets its own
design and tests before it goes into the app.

## Board secrets

A place for the private details of a board: passwords, Wi-Fi keys, PINs, serial numbers and MAC addresses.
The values are encrypted in the board folder, so they can go into git. The key stays in the system
keyring. You can show a value, copy it or send it to the open console.

## Bench inventory

A list of your tools in the app: meter, USB-UART adapter, logic analyser and soldering gear. Playbooks and
the wiki use it, for example to know the signal level of your adapter. With the assistant on, you can add
items from a photo.

## Flash and firmware

- Playbooks for a CH341A programmer with `flashrom`. They read the SPI flash twice, compare the hashes and
  keep the dump read-only as a capture.
- Analysis of a dump in a sandbox (`bubblewrap` and `binwalk`), and a Firmware panel that lists partitions
  and file systems.
- Writing to flash comes after reading works. It will need a verified backup and the same confirmation as
  destructive console commands.

## Assistant

- A reasoning effort setting for each profile, so that thinking models answer within the reply limit.
- A comparison of more vision models on photo questions.
- "Ask about this" on Timeline entries.

## Photo block diagram

A study of whether a vision model can find the parts on a board photo (SoC, RAM, flash, regulators,
headers) and draw them as blocks. A schematic from a photo is not possible, because connections run under
chips and through inner layers.

## Editing and command line

- Arrow keys move and resize a selected marker or callout on the photo.
- JSON output for CLI commands (`--json`).
- A read-only MCP server for a board.

## Wiki

More pages: NAND dumps and ECC, OpenWrt, TFTP recovery and a soldering practice log.

## Packages

An AUR package built from the release tag, then `.deb` and AppImage builds.

## Code quality

Type checks with pyright for the service and `// @ts-check` for the front end core, and `cargo fmt` for
the desktop shell, all as CI gates.

## Not planned

- JTAG and SWD tools.
- SPI and I2C decoding in the app. PulseView and `sigrok-cli` decode these protocols.
- Operating systems other than Linux.
