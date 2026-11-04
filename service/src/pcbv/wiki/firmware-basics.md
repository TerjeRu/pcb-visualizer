# Firmware images

Firmware comes in two forms: an update file from the vendor, and a dump that you read from the flash of the board. Both are binary files, and both have parts that you can recognise. This page describes those parts and the first steps to look at them. The app does not have firmware analysis yet. It is planned.

## Update file and dump

| | Vendor update file | Flash dump |
|---|---|---|
| Source | the vendor's website or the update server of the board | read from the chip with a programmer, or from `/dev/mtd*` on a shell |
| Contains | kernel and root filesystem, plus a vendor header | everything: bootloader, settings, calibration, kernel, filesystems |
| Unique to the unit | no | yes: MAC addresses, keys, serial numbers, your settings |
| Safe to share | usually | no; treat it as private |

## Parts you will find

| Part | How to recognise it |
|---|---|
| Vendor header | a block at the start with a product ID, version and checksum; format varies by vendor |
| uImage | the legacy U-Boot image header, magic bytes `27 05 19 56`, followed by a kernel |
| FIT image | a newer U-Boot format based on a device tree; can hold a kernel, device tree and signatures |
| Compressed kernel | LZMA, gzip or XZ data |
| SquashFS | a filesystem image starting with `hsqs` (little endian) or `sqsh` |
| JFFS2, UBI | writable filesystems; UBI starts with `UBI#` |
| Padding | long runs of `FF`, the value of erased flash |

A tool such as binwalk scans a file for these signatures and reports their offsets. It can then extract the parts.

## Entropy

Entropy measures how random the data looks, on a scale from 0 to 1. Compressed data and encrypted data are both close to 1. Text, code and padding are lower.

An entropy plot along the file shows its structure at a glance. Flat high plateaus are compressed or encrypted regions. Low stretches are code, tables or padding. If the whole file has the highest entropy and has no signatures you recognise, it is usually encrypted.

## Strings

`strings -n 8 firmware.bin` prints the readable text. Before you extract anything, it quickly finds version numbers, build paths, URLs of update servers, default passwords and command names.

## Checksums and signatures

- A checksum (CRC32, MD5) detects corruption. The vendor header usually has one. The updater refuses a modified image with a wrong checksum.
- A signature proves who made the image. With secure boot or signed updates, the board refuses a modified image even when the checksum is correct. See [The boot chain](boot-chain).

## Handling dumps

- Keep every dump read-only and write down its SHA-256 hash. Planned flash playbooks will guide both steps.
- A dump contains secrets of the board. It stays in your private data repository. Never publish it. See [Method and ethics](method-and-ethics).
- Analyse copies in a sandbox. Extraction tools parse untrusted data, and they have had security bugs.

Related: [Flash and filesystems](flash-and-filesystems), [SPI flash](spi-flash), [Method and ethics](method-and-ethics).
