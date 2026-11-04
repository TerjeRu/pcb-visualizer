# Reading a boot log

A boot log is everything the board prints from power-on to its first prompt. It has two parts: first the bootloader, then the Linux kernel. Read the log once from top to bottom before you type anything.

## The bootloader part

```
U-Boot 2015.07-ARC (Mar 14 2019 - 10:21:07 +0000)
CPU:   ARC7621 rev 1.2 @ 880 MHz
DRAM:  128 MiB
SF: Detected 25Q128 with page size 256 Bytes, erase size 64 KiB, total 16 MiB
Hit any key to stop autoboot:  3
```

- The first line names the bootloader and its version. See [U-Boot](u-boot).
- CPU and DRAM confirm the [SoC](soc) and memory size.
- `SF: Detected ...` names the [SPI flash](spi-flash) and its size.
- The countdown is your chance to stop the boot. See the Bootloader recon playbook.

## The kernel part

- `Linux version 4.4.198 (...)` gives the kernel version and how it was built.
- `Kernel command line: console=ttyS0,115200 root=/dev/mtdblock5` gives the console speed and the place of the root filesystem.
- `Creating 6 MTD partitions on "spi0.0":` is followed by address ranges and names. This is the flash layout. Keep this list, because a backup later reads these regions. See [Flash and filesystems](flash-and-filesystems).
- `VFS: Mounted root (squashfs filesystem) readonly` gives the root filesystem type. Squashfs is compressed and read-only. Changes go to a writable overlay.

## What to look out for

- Passwords, Wi-Fi keys, TR-069 credentials or VoIP credentials that the board prints during boot. They stay in your private repository, and the commit guard blocks the common forms.
- Error lines with `failed`, `error` or `panic`. They are usually harmless on a working router. Note them anyway.
- The last lines. A `login:` prompt, or "Please press Enter to activate this console", often gives a root shell.

Related: [The boot chain](boot-chain), [UART](uart), [Glossary](glossary).
