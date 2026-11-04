# Start here

This wiki is a reference for opening consumer hardware and getting a console on it. It assumes no
electronics background. Each page covers one topic and links to the pages it depends on.

## Reading order for a first console

Read these pages before you connect anything to a live board. They take about an hour.

1. [Bench safety](safety) and [Method and ethics](method-and-ethics): what can go wrong, how to work, and
   which boards you may open.
2. [Electricity basics](electricity-basics): voltage, current, resistance and supply rails.
3. [Ground](ground) and [Logic levels](logic-levels): the two measurements that every connection needs.
4. [Multimeter basics](multimeter): continuity, resistance and DC voltage.
5. [Reading schematics](reading-schematics) and [Schematic symbols](schematic-symbols): how circuits are drawn.
6. [Headers and pads](headers) and [UART](uart): what to look for on the board.
7. [USB-UART adapter](usb-uart-adapter) and [Wiring](wiring): how to connect the laptop to the board.
8. [Your first live board](first-live-board): the whole procedure, step by step.

[The tutorial](tutorial) practises the whole method on a practice board first. It needs no hardware.

[What you need](what-you-need) lists the software and the bench tools for a real board.

Read [Soldering](soldering) only if a header has no pins fitted. Practise on a spare board first.

## How the wiki relates to the playbooks

The playbooks in the Playbook panel are the procedures. They tell you what to do next and record what you
found. The wiki explains the background. Each playbook step links to the pages it uses, so you can read
them when you need them.

## Your own pages

Pages that you put in `~/hw/wiki/` appear under "Your pages". A page with the same file name as a built-in
page replaces it. You can use this to rewrite any page in your own words.

## Sections

| Section | Covers |
|---|---|
| Electricity | voltage, current, ground, logic levels, static |
| Schematics and datasheets | circuit diagrams, their symbols, and manufacturers' specifications |
| Tools | multimeter, USB-UART adapter, wiring, soldering, serial terminals, logic analyzer, sigrok |
| The board | opening cases, photographing, the parts on a board, chip packages, headers, SoC, flash |
| Interfaces | UART, SPI, I2C, JTAG and SWD |
| Boot and firmware | the boot chain, boot logs, U-Boot, flash layout and filesystems, firmware images |
| Reference | glossary |

## After the first console

When the console works, read about the [boot chain](boot-chain), the [flash layout](flash-and-filesystems)
and [firmware images](firmware-basics). These lead to a backup of the flash. [JTAG and SWD](jtag),
[SPI](spi) and [I2C](i2c) cover the other interfaces on a board.
