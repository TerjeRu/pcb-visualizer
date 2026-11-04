# Bench safety

A router runs on a low-voltage DC adapter, so most of the risk on a router bench is to the board, not to
you. These habits protect both.

## Keep mains out of reach

- Use the router's own external power adapter. If the power supply is **inside the case** (some set-top
  boxes and older modems), do not work on the board while it is powered. Parts of that supply carry mains
  voltage. The big capacitor can stay charged after you unplug the board.
- Keep the plug of the adapter and the power strip away from loose wires and probe leads.

## Power off before you touch

- Unplug power and every cable before you open a case or move the board.
- Wait one minute after you unplug the board. The capacitors near the power input hold charge for a short
  time.
- Measure resistance and continuity only when the board is unplugged. See [Multimeter basics](multimeter).

## Probing powered boards

- Lay the board flat on a surface that does not conduct: a wooden desk, a cardboard sheet or an ESD mat.
- Put the black probe on [ground](ground) first. Then use only the red probe.
- Brace your hand on the desk. A probe tip that slips can short two neighbouring pins, and this is the
  main way to damage a board at this stage.
- Never connect the VCC pin of a USB-serial adapter to the board. Connect GND, TX and RX only. See
  [UART](uart).

## Static

Discharge yourself first. Then handle boards by their edges. See [Static electricity](static).

## Back up before you write

Reading is safe. Writing (flash, bootloader settings, `env save`) can brick a board. The app keeps these
actions behind confirmations and a verified backup, in later playbooks. See
[Method and ethics](method-and-ethics).
