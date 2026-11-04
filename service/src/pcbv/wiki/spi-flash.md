# SPI flash

The firmware is in a flash chip. On most routers this is a small SPI NOR flash: an 8-pin chip near the SoC, in a SOIC-8 or WSON-8 package.

## Recognising it

- 8 pins, about 5 x 5 mm (SOIC-8) or a flat pad-only package (WSON-8).
- Typical markings are `25Q128`, `MX25L12835F`, `W25Q64` and `GD25Q128`. The number is the size in megabits: 128 Mbit is 16 MB.
- A dot or a notch marks pin 1.

Some routers use NAND flash instead. It is larger, in a 48-pin TSOP or BGA package, and you need different tools for it.

## Pinout of a typical SOIC-8 SPI flash

| Pin | Name | Pin | Name |
|---|---|---|---|
| 1 | CS# (chip select) | 8 | VCC |
| 2 | DO (data out) | 7 | HOLD# |
| 3 | WP# (write protect) | 6 | CLK |
| 4 | GND | 5 | DI (data in) |

Check the datasheet for your exact part.

## Reading it

A CH341A programmer with a SOIC-8 clip reads the chip in the circuit with `flashrom`. A later playbook covers this: make two reads, compare their SHA-256 and keep the dump read-only. Never write to the chip without a verified backup.

Related: [SPI](spi), [Flash and filesystems](flash-and-filesystems), [SoC](soc), [Bench safety](safety).
