# Logic levels

A logic level is the voltage that a chip uses for a digital 1. The serial adapter and the board must
use the same level.

| Level | Where |
|---|---|
| 3.3 V | most routers and their UART pins |
| 1.8 V | some newer SoCs, especially Qualcomm and MediaTek designs |
| 5 V | old boards; rare on routers |

## Measuring it

Measure the VCC pin of the header, and measure TX while the board is idle (after boot). Both are at
the logic level. If VCC reads 3.3 V but TX idles at 1.8 V, trust TX.

## What a wrong level does

A 3.3 V adapter that drives a 1.8 V input pushes the input beyond its limit. This can damage the SoC
at once or over time. A 1.8 V board that talks to a 3.3 V adapter may not be read reliably either.

## Checking the adapter

- Plug the adapter into the laptop and measure its TXD against its GND. TXD idles at the signal level
  of the adapter.
- A CP2102 always signals at 3.3 V. The 3V3 / 5V jumper on most CP2102 modules selects only the
  voltage on the VCC pin.
- On FT232 modules, the same jumper sets the signal level. Set it to 3V3 for routers.
- For 1.8 V boards, use an adapter that supports 1.8 V, or use a level shifter.
- Whatever the jumper does, leave the VCC pin of the adapter unconnected. See
  [USB-UART adapter](usb-uart-adapter).

Related: [UART](uart), [Multimeter basics](multimeter).
