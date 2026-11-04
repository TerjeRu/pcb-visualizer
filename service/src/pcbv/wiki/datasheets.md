# Reading datasheets

A datasheet is the specification of a part, written by the manufacturer. It tells you what each pin
does, which voltages are safe, and how to connect the part. Read the datasheet before you connect
anything to the pins of a chip.

## Where to get them

- The website of the manufacturer. Search for the full part number.
- Distributors (Mouser, Digi-Key, LCSC) link to the PDF of the manufacturer on the page of each part.
- Do not use sites that wrap datasheets in their own viewers or downloads. The PDF of the manufacturer
  is the authority, and it is current.
- SoC datasheets are often confidential. Leaked copies exist. Whether you may use one depends on how
  you got it. Public sources usually answer your questions: OpenWrt, and the device tree files in the
  Linux kernel.

## Structure

| Section | What you use it for |
|---|---|
| Features, description | confirm you have the right part and what it does |
| Pin configuration | the pinout drawing, seen from above, with pin 1 marked |
| Pin descriptions | what each pin does, and whether it is an input, output or power |
| Absolute maximum ratings | limits that damage the part if exceeded, even briefly |
| Recommended operating conditions | the range the part is designed to work in |
| Electrical characteristics | input and output voltage thresholds, currents |
| Timing | how fast signals may change; needed for logic analysis |
| Application circuit | how the manufacturer expects it to be wired; a reference for tracing |
| Package information | dimensions, pin 1 location, footprint |
| Ordering information | how to decode the suffixes in the part number |

## Absolute maximum versus recommended

The absolute maximum ratings mark where damage begins. The part works as promised only inside the
recommended operating conditions, which are narrower. A pin on a 3.3 V part has an absolute maximum
of "−0.5 V to VCC + 0.5 V". It survives 3.8 V for a short time. A 5 V signal on that pin exceeds the
absolute maximum and can destroy the part.

## Logic thresholds

The electrical characteristics define four voltages. They decide whether two chips can talk:

| Symbol | Meaning |
|---|---|
| VIH | the lowest input voltage the chip reads as high |
| VIL | the highest input voltage the chip reads as low |
| VOH | the lowest voltage the chip outputs for high |
| VOL | the highest voltage the chip outputs for low |

Two parts are compatible when three conditions are true:

- The VOH of each output is above the VIH of the other part.
- The VOL of each output is below the VIL of the other part.
- No output exceeds the absolute maximum of the receiver.

See [Logic levels](logic-levels).

## Active-low signals

A signal is active low if its name has a bar over it, ends in `#`, `_N` or `_B`, or starts with `n`
(`CS#`, `nRESET`). It takes effect when something pulls it to 0 V. A flash chip is selected when `CS#`
is low. A reset happens while `nRESET` is low.

## Working method

1. Read the pin configuration and match pin 1 to the board.
2. Read the pin descriptions for the pins you will touch.
3. Read the absolute maximum ratings and the supply voltage.
4. Note the relevant pins in the app, on the callout of the chip or on the pins of the header.

Related: [Chip packages and markings](chip-packages), [Reading schematics](reading-schematics),
[Logic levels](logic-levels).
