# Headers and pads

A header is a row or grid of pins or plated holes where you can connect a wire. On routers, many headers have no pins. You see only holes or pads, and solder sometimes covers them.

## Spotting candidates

- A row of 3 to 5 holes or pads with even spacing, often near the SoC or a board edge.
- Silkscreen such as `J1`, `JP1`, `CON3`, `UART`, `TX`, `RX`, `GND`, `VCC`.
- A square pad among round ones is usually pin 1.
- A grid of 2 x 5, 2 x 7 or 2 x 10 is usually JTAG. See [JTAG and SWD](jtag).

## Pitch

The pitch is the distance between two pins. The standard pitch is 2.54 mm (0.1 inch), and ordinary jumper wires fit it. You also find 2.0 mm and 1.27 mm. For these you need finer wires or test clips.

## Pin numbering

The Header panel supports three numbering schemes:

- Row by row: 1 2 3 / 4 5 6. A single-row header always uses this scheme.
- Column by column (IDC): 1 3 5 / 2 4 6. Ribbon-cable headers, such as JTAG, use this scheme.
- U-shape (DIP): 1 2 3 / 6 5 4. This is the numbering of a chip.

## Unpopulated holes

To connect to the holes, hold pins in them at an angle, use spring test hooks, or solder in a pin header. To clear holes that are full of solder, you need a soldering iron and solder wick. See [Wiring](wiring) and [Soldering](soldering).

Related: [UART](uart), [Reading schematics](reading-schematics).
