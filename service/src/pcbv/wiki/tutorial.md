# The tutorial: Find the UART

The tutorial starts with a photo of an unlabelled header. It ends with a shell on the serial console of
the board, a matching logic capture and an exported report. It uses the real panels of the app on a practice board, so
you learn the steps that you use on a live board. It needs no hardware and takes about 20 minutes.

## What it covers

Eighteen steps in five chapters:

| Chapter | Steps | What you do |
|---|---|---|
| Find | 1 to 4 | Look over the board photo, mark the four-pin header, label it J4 and check its shape. |
| Measure | 5 to 8 | Find ground, the steady supply, TX and RX with a simulated multimeter, and mark each pin. |
| Connect | 9 to 11 | Cross the data lines on the adapter, open the console and find the speed that makes the text readable. |
| Get in | 12 to 14 | Read the boot text, stop at the bootloader and boot Linux to a shell. |
| Verify | 15 to 18 | Decode a logic capture of the same boot, compare it with your console capture, write the header down and export a report. |

The wiring and the multimeter are simulated, because a computer has no pins to measure. The console is the
real Console panel with the virtual board (`pcbv vdev`). The logic capture is a real capture, and the real
Logic panel decodes it.

## How it works

- The coach panel on the right shows one step at a time, with a task list that ticks as you work.
  **Continue** stays off until the task is done. A steady ring marks the control that the next item needs.
  When the step is done, the ring moves to **Continue**.
- When the assistant is on, "Ask the assistant (example)" under the task list shows a made-up question and
  answer for the step. The tutorial sends nothing to a model.
- The tutorial locks everything that the step does not need, so you cannot get lost. You can make
  mistakes inside the task. Each mistake comes with a hint.
- The Console steps read what the board sent, not what you typed. If you type a prompt, it does not count
  as reaching the prompt.
- **Leave tutorial** in the top bar keeps your place. Settings shows **Resume the tutorial** and
  **Start the tutorial again**. **Start the tutorial again** clears the practice board and nothing else.
- The practice board is kept apart from your boards. The app does not list, commit or push it.
- A reload or a restart keeps what you did. The tutorial reads your console and capture results back from
  the practice board.
- When the tutorial ends, the app stops the virtual board that it started.

## Facts to know

At 9600 baud the text from the virtual board is noise, and at 115200 it is clean. A real board does the
same, so the speed is the first thing to find. See [UART](uart) and [Serial terminals](serial-terminals).

The U-Boot countdown gives you a few seconds to press a key. If the countdown runs out, Linux starts. To
start the board again, disconnect and connect. See [U-Boot](u-boot).

Nobody touched the board while the logic capture was recorded, so its countdown ran out. Your console
capture stops the countdown. The first difference between the two is the moment when you pressed a key.
See [Logic analyzer](logic-analyzer).

When you finish, read [Your first live board](first-live-board). It gives the same method for hardware.
[What you need](what-you-need) lists the bench tools.
