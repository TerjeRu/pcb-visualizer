# Parts on a router board

Most routers use the same blocks. When you know them, you can tell where the processor, the memory and the firmware are. You can also tell which areas carry power and which parts to ignore.

## The blocks

| Block | What to look for | What it tells you |
|---|---|---|
| SoC | the largest square chip, near the centre, often under a heat sink or shield | sets the CPU architecture and the bootloader; see [SoC](soc) |
| RAM | one or two rectangular chips next to the SoC, marked by Winbond, Nanya, Samsung, ESMT, Micron | its size shows in the boot log |
| Flash | an 8-pin chip (SPI NOR) or a 48-pin TSOP or BGA (NAND), close to the SoC | holds the firmware; see [SPI flash](spi-flash) |
| Ethernet switch or PHY | a square chip behind the network ports | sometimes integrated in the SoC |
| Magnetics | small rectangular blocks between the switch and the ports, marked with "LAN" or "Gigabit" part numbers | isolation transformers; do not probe them |
| Wi-Fi | chips under metal shields, with U.FL antenna connectors or printed antennas nearby | a second processor on some designs, with its own firmware |
| Power input | barrel jack, a fuse or polyfuse, a protection diode, large electrolytic capacitors | the 12 V input; see [Electricity basics](electricity-basics) |
| Regulators | small chips next to an inductor (a coil, often a square black block marked with a number such as 4R7) and capacitors | make the 3.3 V, 1.8 V and core voltages |
| Crystals | metal-cased oval or rectangular parts marked with a frequency (25.000, 40.000) | clocks for the SoC, Ethernet and Wi-Fi |
| DSL front end | a line driver chip and transformer near the phone socket | on DSL routers only |
| Telephony | a SLIC chip and relays near the phone ports | on routers with phone ports |
| Debug headers | rows of holes or pads, often unpopulated, near the SoC or a board edge | the reason you opened the case; see [Headers and pads](headers) |
| Buttons and LEDs | reset and WPS buttons, LEDs along the front edge | the reset button is often read by the bootloader |

## Shields

Metal shields cover the SoC, the RAM and the radios to keep interference in. Many shields have a lid that snaps off a soldered frame. You can put the lid back. To remove the frame you need hot air, and that is rarely worth it.

## Test points

Round pads marked `TP` with a number are test points for the factory tester. Some connect to signals you want, such as UART, JTAG or a power rail. If you cannot find a header, check the test points with the meter.

## Working through a new board

1. Photograph both sides before you remove anything. See [Photographing boards](photographing-boards).
2. Find the power input and the regulators. Note which areas carry 12 V.
3. Find the SoC, the RAM and the flash, and read their markings. See [Chip packages and markings](chip-packages).
4. Look for headers, test points and labelled pads near the SoC.
5. Write down what you found in the app: a callout for each chip and a marker for each header.

Related: [SoC](soc), [Chip packages and markings](chip-packages), [Headers and pads](headers).
