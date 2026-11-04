# Responsible use

PCB Visualizer is for documenting and learning about hardware you own or have written permission to examine.

- Use it on your own devices. Opening a router you were lent, or a device on a network you do not control, is not covered.
- Reading a serial console is passive, but commands you type can change or erase a device. The Console asks for a typed
  confirmation for common commands that write flash or bootloader settings, but it is a list of known commands and
  cannot catch everything, and the Terminal panel has no such check. The app never writes to flash on its own.
  A confirmation names the board, port and speed and applies to that console session.
- Check voltage first: connect GND, RX and TX at the right logic level and leave VCC unconnected.
- Photos, logs and notes you ask the assistant about go to the model server you chose. Tick "Send photos" only for
  a server you trust with them. Findings the assistant writes are marked unverified; check them before you rely on them.
- Redact serial numbers, MAC addresses and Wi-Fi keys before you share logs or photos; `pcbv redact` makes a cleaned copy
  of a board, and the photos still need a look by eye.
- The assistant's suggestions can be wrong. Anything it proposes stays unverified until you confirm it with a meter.
- Follow the laws that apply to you about reverse engineering and about the firmware you extract.
