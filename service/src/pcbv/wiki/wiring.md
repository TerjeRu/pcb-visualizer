# Wiring

A console connection is three wires: GND, the board's TX and the board's RX. Most failed first sessions come from a loose or swapped wire. This page covers the hardware for the connection and a routine to check it.

## Jumper wires

Jumper wires (often called Dupont wires) have a 2.54 mm connector on each end:

| End | Fits |
|---|---|
| Female (socket) | a male pin: header pins on the board, pins on the adapter |
| Male (pin) | a female socket, or a plated hole on the board, held in by friction |

For a board with a fitted pin header and an adapter with pins, use female-to-female wires.

## When the header has no pins

| Method | Holds | Needs |
|---|---|---|
| Spring test hooks on the hole's rim or a nearby pad | well, for a session | test hooks |
| A male header strip pushed into the holes at a slight angle, not soldered | well enough to read a boot log | a header strip |
| Male jumper wires pushed into the holes | poorly, because they fall out | nothing |
| A soldered pin header | permanently | [Soldering](soldering) |

If solder fills the holes, the friction methods do not work. Use test hooks on the pads, or clear the holes. See [Soldering](soldering).

## Conventions

- Use a black wire for GND. Pick one colour for TX and one for RX, and keep to them.
- Keep the wires short and free of tension. Tape the adapter and the wires to the desk, so a pulled USB cable cannot drag the wires off the header.
- Lay the board on a non-conductive surface. See [Bench safety](safety).

## Read first, then write

Connect in two stages. The first stage cannot send anything to the board:

1. **Listen only**: connect GND to GND, and the board's TX to the adapter's RXD. Capture a complete boot.
2. **Two-way**: when the log is readable, add the adapter's TXD to the board's RX.

Listening first proves the speed and the wiring before you type anything. It also stops the adapter from driving the board's RX while the board is unpowered. An adapter's TXD idles at 3.3 V. If a powered signal goes into an unpowered chip, it can feed current into the chip through its input protection.

## Checking before power

Unplug the board and disconnect the adapter from the laptop. Then:

1. Set the meter to continuity.
2. For each wire, touch one probe to the adapter pin. Touch the other probe to the board pin that the wire should reach. The meter must beep.
3. Touch the board's GND and each signal pin in turn. No pin may beep against another pin.

## Order of connection

1. Unplug the board. Connect GND, then the signal wires.
2. Plug the adapter into the laptop and open the Console panel.
3. Power the board. The boot log starts within a second or two.

To disconnect, reverse the order: power off the board, close the console, unplug the adapter, then remove the wires.

Related: [USB-UART adapter](usb-uart-adapter), [UART](uart), [Your first live board](first-live-board).
