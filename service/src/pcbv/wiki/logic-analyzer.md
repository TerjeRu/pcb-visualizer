# Logic analyzer

A logic analyzer captures when digital signals go high and low. For a UART it captures the TX line exactly as the board drives it, with no serial adapter in between.

## Why use one

- It only listens, so it cannot damage the board the way a mismatched adapter can.
- It shows what the signal really looks like. Wrong speed, wrong voltage and swapped wires give different pictures. These are easier to tell apart than a screen of garbage.
- It works when the board has a console that you cannot read yet, because the decoder can estimate the speed from the pulses.

## What you need

- An analyzer. The cheap 8-channel USB clones (24 MHz) are enough for UART.
- Its software: PulseView (graphical) or `sigrok-cli` (command line). Both are part of sigrok.
- A ground connection. Clip the analyzer's ground to the header's GND pin first. Without it the readings float and mean nothing.

## Sample rate

The analyzer must sample much faster than the bits arrive. Use at least eight samples per bit. At 115200 baud a bit lasts about 8.7 microseconds. A rate of 1 MHz gives about 8.7 samples per bit, and 2 MHz is more comfortable. A higher rate makes bigger files, so a UART does not need a rate far above 2 MHz.

## Capturing a boot

1. Attach ground and TX with the board unplugged.
2. Start the capture, then power on the board, so that you catch the first bytes.
3. Stop when the output ends, and save the session as a `.sr` file.

With sigrok-cli and a typical USB clone, the command looks like this:

```
sigrok-cli -d fx2lafw --config samplerate=1m --channels D0,D1 --time 20s -o boot.sr
```

Check the options of your version with `sigrok-cli --help`. In PulseView, choose the device and set the sample rate and the number of samples. Press Run, then use File and Save As.

## Reading the result

The Logic panel shows the waveform and the decoded text. A UART line idles high. Each byte starts with a low start bit, then eight data bits, then a high stop bit. If the decoder finds many framing errors, the speed is probably wrong. If it finds nothing, check the channel and the ground.

Related: [sigrok](sigrok), [UART](uart), [Logic levels](logic-levels), [Reading boot logs](reading-boot-logs), [Multimeter basics](multimeter).
