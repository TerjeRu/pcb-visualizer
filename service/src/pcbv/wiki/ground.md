# Ground

Ground (GND) is the 0 V reference for every other voltage on the board. Find it first on any header,
and connect its wire first.

## Known ground points

- The metal shell of USB and Ethernet ports.
- Metal shield cans over chips.
- The plated ring around mounting screw holes (usually, but not always).
- The negative side of the power input jack (usually the outer barrel).
- Large copper areas on the board.

Use one of these as the reference for the black probe.

## Finding the GND pin on a header

Unplug the board. Set the meter to continuity and keep the black probe on a known ground. The header
pin that beeps is GND. Expect a reading below 1 Ω. A pin that reads a few ohms to hundreds of ohms
connects to ground through another part, not directly.

Related: [Multimeter basics](multimeter), [UART](uart), [Electricity basics](electricity-basics).
