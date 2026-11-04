# SoC (system on chip)

The SoC is the main processor of the router. The CPU, the memory controller, the network and USB are all in one chip. The SoC decides which bootloader and which Linux kernel the board runs, so identify it first.

## Finding it

- The SoC is usually the largest square chip, near the middle. A metal shield or a heatsink often covers it.
- A shield often has a snap-off lid, and the frame stays soldered. Do not pry the frame off.
- Common makers in routers are Broadcom (BCM...), MediaTek (MT...), Qualcomm Atheros (QCA..., IPQ...), Realtek (RTL...) and Lantiq / Intel (GRX..., VRX...).

## Reading the marking

The top line is usually the part number, for example `BCM63138` or `MT7621AT`. The other lines are date codes and batch numbers. Search for the part number with "datasheet", "OpenWrt" or the router model.

## What the SoC tells you

- It gives the CPU architecture (ARM or MIPS), which you need to analyse the firmware later.
- It points to the bootloader, often U-Boot or Broadcom CFE.
- The OpenWrt table of hardware lists many routers by SoC, with notes on serial consoles.

Related: [Chip packages and markings](chip-packages), [Reading datasheets](datasheets), [SPI flash](spi-flash), [UART](uart).
