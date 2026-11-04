# Multimeter basics

To find a UART you need three modes: continuity, resistance and DC voltage.

## Continuity (the beeper symbol)

- The meter beeps when the two probes connect through a very low resistance.
- To find [ground](ground), put the black probe on a known ground. Put the red probe on each pin.
- **Use it only on an unplugged board.** The meter sends a small current of its own. On a powered board the reading is meaningless, and you can damage the meter or the board.
- Touch the probes together first. If the meter does not beep, the mode or the leads are wrong.

## Resistance (Ω)

- The meter shows the resistance between the probes. `OL` means open: the resistance is too high to measure, so the pins are not connected.
- Use this mode only on an unpowered board.
- Record the value with `pcbv measure <board> J4 4 0.3ohm`, or record `OL`. If `pcbv` is not on your PATH, run `uv run pcbv measure ...` in the service folder.

## DC voltage (V with a straight line)

- Power the board. Put the black probe on ground and the red probe on the pin.
- Use the 20 V range, or auto range.
- A meter averages fast signals. A pin that switches quickly between 0 and 3.3 V shows as a lower, jumping value. That is how you spot [TX](uart).
- Record the value with `pcbv measure <board> J4 2 3.29V`.

## Leads

Put the black lead in **COM**. Put the red lead in the socket marked **V Ω**. Do not use the 10 A or mA sockets: they are for current and short whatever you touch.

## Diode mode (the diode symbol)

- The meter pushes a small current and shows the voltage that the current needs to flow, in volts.
- A silicon diode reads about 0.5 V to 0.7 V in one direction and `OL` in the other.
- Use this mode to find chip pins on an unpowered board. Nearly every chip pin has a protection diode to ground.
- Put the red probe on GND and the black probe on the pin. A reading of 0.3 V to 0.8 V means the pin connects to a chip. `OL` means the pin reaches no chip, or only passive parts.
- Supply pins often read lower, because many chips connect to them.
- Like continuity, this mode is for an unpowered board only.

## Range and resolution

- An auto-ranging meter picks the range itself. On a manual meter, start at a range above the expected value (20 V for a 3.3 V board) and step down.
- Meters have a count rating. A 2000-count meter shows up to 1.999 on a range, and a 6000-count meter shows up to 5.999. More counts give more digits on the ranges you use.
- In DC voltage mode a meter has an input resistance of about 10 MΩ, so it barely loads the circuit.
- The HOLD button freezes the display. MIN/MAX, where the meter has it, records the extremes. It helps you catch the dips on a TX line.

## Measuring current

To measure current, break the circuit and put the meter in the gap, in series. Move the red lead to the mA or A socket. Board work rarely needs this.

Move the lead back to V Ω immediately afterwards. If you leave it in a current socket and then put the meter across a supply, you make a short circuit.

## Finding a short

An unpowered rail that measures close to 0 Ω against ground has a short. A rail that starts low and rises over a second or two is a capacitor that charges. This is normal. A short between two neighbouring pins after soldering is almost always a solder bridge. See [Soldering](soldering).

## Probing technique

- Use sharp probe tips, and rest the heel of your hand on the desk.
- Hook clips or test hooks on the black lead free a hand. Clip the lead to ground once.
- On a powered board, touch only the pin you want to measure. If the probe slips, lift it straight away.

Related: [Bench safety](safety), [Logic levels](logic-levels), [Electricity basics](electricity-basics).
