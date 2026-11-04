# UART (serial console)

A UART is a simple serial link with two data wires: one to send (TX) and one to receive (RX). The two sides also share a ground wire. Almost every router has a UART, because the manufacturer used it during development. Through the UART you see the messages of the bootloader and the kernel at boot. You can often open a shell.

## What the pins do

| Pin | Direction | Idle level | What you see on a meter |
|---|---|---|---|
| GND | | 0 V | beeps against a known ground |
| TX | board sends | high (3.3 V) | flickers or dips during boot, when text is printed |
| RX | board receives | high or floating | steady |
| VCC | power | 3.3 V (or 1.8 V, 5 V) | rock steady |

The header is usually a row of 4 pins or pads. The label is J1, CON3 or UART, or there is no label. See [Headers](headers).

## Wiring an adapter

Cross the data lines. Connect the RX of the adapter to the TX of the board, and the TX of the adapter to the RX of the board. Connect GND to GND. Leave VCC unconnected. The board has its own power, and two supplies that fight each other can damage either side.

Make sure that the adapter uses the [logic level](logic-levels) of the board. 3.3 V is the most common level. See [USB-UART adapter](usb-uart-adapter) and [Wiring](wiring).

## Settings

Most routers use 115200 baud, 8 data bits, no parity and 1 stop bit (115200 8N1). If the output is noise, the speed is wrong. Try 57600 or 38400.

To practise, start the virtual board with `pcbv vdev`. If `pcbv` is not on your PATH, run `uv run pcbv vdev` in the service folder. The virtual board runs at 115200 baud.

```
tio -b 115200 /dev/ttyUSB0
```

Related: [Serial terminals](serial-terminals), [Multimeter basics](multimeter), [Ground](ground), [Your first live board](first-live-board).
