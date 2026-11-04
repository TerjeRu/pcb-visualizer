# sigrok

sigrok is an open-source software suite for logic analyzers, oscilloscopes and meters. It has two front ends: PulseView, a graphical application, and `sigrok-cli`, a command-line tool. The app's Logic panel reads sigrok's `.sr` capture files directly. You need sigrok only to make the capture.

## Installing on Arch

```
sudo pacman -S sigrok-cli pulseview sigrok-firmware-fx2lafw
```

`sigrok-firmware-fx2lafw` is the open firmware for analyzers built on the Cypress FX2 chip. This includes the common 8-channel 24 MHz clones. Each time you plug in the analyzer, sigrok loads the firmware into it. The analyzer then disconnects and reappears with a new USB identity. This is expected.

The packages install udev rules that give the logged-in user access. Replug the analyzer after you install them.

## Input levels

The FX2 reads a signal as high above about 2 V and low below about 0.8 V. That works for 3.3 V and 5 V logic. A 1.8 V signal does not reach the high threshold reliably, so a 1.8 V board needs a different analyzer or a level shifter. The cheap clones have no input protection. Never connect a channel to anything above 5 V.

## Capturing with sigrok-cli

```
sigrok-cli --scan
sigrok-cli -d fx2lafw --config samplerate=2m --channels D0,D1 --time 20s -o boot.sr
```

The first command lists the connected devices. The second command captures channels D0 and D1 at 2 MHz for 20 seconds. See [Logic analyzer](logic-analyzer) for how to choose a sample rate.

## Capturing with PulseView

1. Choose the device in the toolbar.
2. Set the sample rate and the number of samples (or a time).
3. Press Run, power the board, and wait for the capture to end.
4. Save the capture with File, Save As, in the `.sr` format.
5. Import the file in the Logic panel.

## Protocol decoders

sigrok's decoders turn a waveform into bytes, packets and transactions. `sigrok-cli -L` lists them. Some useful ones:

```
sigrok-cli -i boot.sr -P uart:rx=D0:baudrate=115200 -A uart=rx-data
sigrok-cli -i bus.sr -P i2c:scl=D0:sda=D1
sigrok-cli -i bus.sr -P spi:clk=D0:mosi=D1:miso=D2:cs=D3
```

The Logic panel has its own UART decoder. For SPI and I2C, use PulseView or `sigrok-cli` until the app supports them.

## Connecting the analyzer

- Connect ground first: the analyzer's GND to the board's GND.
- Then connect each channel to a signal. An analyzer only listens. It does not drive the lines.
- Label the channels in PulseView (TX, CLK, SDA), so that the saved captures explain themselves.

Related: [Logic analyzer](logic-analyzer), [UART](uart), [SPI](spi), [I2C](i2c).
