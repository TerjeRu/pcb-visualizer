# Your first live board

This page is the complete procedure for a first console session on a router, from a closed case to a
captured boot log. Each stage matches a playbook in the Playbook panel, which records your results as you
go. Practise every stage on the virtual board first (`pcbv vdev`). Then repeat it on the hardware.

## Before you start

You need:

- the board and its own power adapter,
- a multimeter with continuity, resistance and DC voltage modes,
- a 3.3 V USB-UART adapter and three female-to-female jumper wires,
- test hooks or a pin header, if the UART holes have no pins,
- a clear, non-conductive work surface.

First read [Bench safety](safety), [Multimeter basics](multimeter), [UART](uart) and [Wiring](wiring).

## Stage 1: open and photograph (playbook 1)

1. Unplug the power adapter and every cable. Note the model and revision from the label.
2. Open the case. See [Opening cases](opening-cases).
3. Photograph both sides of the board and add the photos in the app. See
   [Photographing boards](photographing-boards).
4. Identify the main chips: SoC, RAM and flash. See [SoC](soc) and [SPI flash](spi-flash).

**Stop here** if the power supply is inside the case. That board needs a different procedure.

## Stage 2: find the UART (playbook 2)

With the board unpowered:

1. Mark candidate headers on the photo. See [Headers and pads](headers).
2. Find ground: test continuity from a known ground point to each pin. See [Ground](ground).
3. Measure the resistance from every other pin to ground and record it.

With the board powered (on its own adapter, with nothing else connected):

4. Put the black probe on ground. Measure the DC voltage of each pin while the board boots, and again one
   minute later.
5. Classify the pins with the table below.

| Pin behaviour while booting | After boot | Likely |
|---|---|---|
| 0 V, beeps to ground | 0 V | GND |
| steady 3.3 V | steady 3.3 V | VCC |
| jumps between about 2 V and 3.3 V | steady 3.3 V | TX |
| steady, close to 3.3 V or floating | the same | RX |

6. Record the logic level: the voltage where TX rests after boot. See [Logic levels](logic-levels).

**Stop here** if TX rests at 1.8 V and your adapter is 3.3 V.

## Stage 3: get a console (playbook 3)

1. Unplug the board.
2. Check the signal level of the adapter: measure from its TXD to its GND. See
   [USB-UART adapter](usb-uart-adapter).
3. Connect for listening only: GND to GND, and board TX to adapter RXD. Leave VCC unconnected.
4. Test each wire for continuity. See [Wiring](wiring).
5. Plug the adapter into the laptop. Open the Console panel and select the port.
6. Power the board. If the output is unreadable, use Detect speed. Most routers use 115200 baud.
7. Capture a complete boot, from the first bootloader line to the login prompt or the last message.
8. Read the capture. See [Reading boot logs](reading-boot-logs).

## Stage 4: two-way console (playbook 4)

1. Unplug the board. Connect the TXD of the adapter to the RX of the board.
2. Power the board. During the bootloader countdown, press a key to stop autoboot. See [U-Boot](u-boot).
3. Use only read-only commands: `help`, `version`, `printenv` and `bdinfo`.
4. Let the board boot normally with `boot`, or switch its power off and on.

The Console panel holds back commands that write to flash or change the bootloader environment
(`saveenv`, `erase`, `nand write` and similar). To run one, you must type it a second time to confirm.
Do not run them until you have a verified backup of the flash.

## If nothing appears

| Symptom | Check |
|---|---|
| No output at all | The board's TX goes to the adapter's RXD. GND is connected. The right port is open. |
| Garbage characters | The speed is wrong. Use Detect speed. |
| Output stops when you connect TXD | The TXD of the adapter can hold the RX of the board in a bad state. Remove the wire and capture in listen-only mode. |
| Output only from the bootloader, then silence | The kernel uses a different speed or console. This is normal on some boards. |
| "Permission denied" when you open the port | Your user is not in the `uucp` group. See [USB-UART adapter](usb-uart-adapter). |

Related: [Start here](start-here), [Wiring](wiring), [UART](uart).
