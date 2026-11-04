// The tutorial "Find the UART" as data and pure functions: eighteen steps in five chapters. Each step has
// its text, its task list, the panels it needs, a `check` that says which tasks the facts satisfy, a
// `hint` for the typical mistake and a `target` for the highlight. No DOM and no service calls, so every rule is
// tested in Node and the same facts could drive another front end. Text is short on purpose: at most three
// sentences in `body`, the rest under `why`.

import { newMarkerEvent, roleDef } from '../schema.js';
import { J4 } from './facts.js';

export const TOTAL_STEPS = 18;
/** The last step this build offers. */
export const LAST_STEP = 18;

export const CHAPTERS = ['Find', 'Measure', 'Connect', 'Get in', 'Verify'];

const task = (id, text) => ({ id, text });
const panel = (...names) => names;

export const LESSONS = [
  {
    id: 'plain-sight', chapter: 0, title: 'A console hidden in plain sight',
    body: ['Most routers have a serial console on a few unlabelled pins.', 'You will find it on a photo, name its pins, talk to it and write down what you learned.', 'Everything here is practice: nothing leaves this computer.'],
    tasks: [], panels: panel('photo'), wiki: 'uart',
    why: ['A UART header gives you the boot messages and often a root shell. Manufacturers leave it on the board because they use it to test and flash the board.'],
    example: { question: 'What is a UART, and why would a router have one?', answer: 'A UART is a simple serial link: one wire to send, one to receive, and ground. Factories use it to test and flash boards, so it is often left on the board without a label. I would look for a short row of 3 to 6 pins near the main chip.' },
    check: () => [], hint: () => '', target: () => null,
  },
  {
    id: 'look-around', chapter: 0, title: 'Look around the board',
    body: ['This is a photo of a router board. Zoom in on it with the + button above the photo.', 'Look for a small row of four holes or pins near an edge.'],
    tasks: [task('zoom', 'Zoom in on the photo at least once')], panels: panel('photo'), wiki: 'headers',
    why: ['Debug headers are usually a row of 3 to 6 holes or pins close to the main chip, often with no label. Zooming shows the solder pads and the traces that lead to the chip.'],
    example: { question: 'Where on this photo should I look for a debug header?', answer: 'Look near the edges and close to the large main chip for a short row of holes or pins with nothing plugged in. On this photo, the lower left beside the power jack has a row of four. Zoom in to see whether traces run from it towards the chip.' },
    check: (f) => (f.zoomed ? ['zoom'] : []), hint: () => '', target: () => 'zoom-in',
  },
  {
    id: 'mark-candidate', chapter: 0, title: 'Mark the candidate',
    body: ['The row of four pins in the lower left, next to the power jack, is the one to look at.', 'Choose the Box tool above the photo and drag a box around it.'],
    tasks: [task('marked', 'Draw a box marker around the four-pin header')], panels: panel('photo'), wiki: 'headers',
    why: ['A marker ties a spot on the photo to a header. The pinout you write later stays attached to that spot.'],
    example: { question: 'Is the row of four pins by the power jack a likely UART?', answer: 'It is a good candidate: four pins in a row is the usual layout for ground, supply, transmit and receive. That is a guess from the photo, so mark it and confirm it with the meter in the next chapter.' },
    check: (f) => (f.header ? ['marked'] : []),
    hint: (f) => (f.markerCount > 0 && !f.header ? 'The box is not on the four-pin header yet. Look at the lower left of the photo, beside the power jack, and move the box there.' : ''),
    target: () => 'tool-box',
  },
  {
    id: 'name-and-shape', chapter: 0, title: 'Name it and check the shape',
    body: ['The silkscreen next to this header says J4, so type that as its label in the Header panel.', 'Then set the shape in the Header panel to one row of four pins.'],
    tasks: [task('label', 'Label the marker J4'), task('shape', 'The header has 1 row and 4 columns')], panels: panel('photo', 'inspector'), wiki: 'headers',
    why: ['Labels on the board are the quickest way to talk about a header, and they survive in notes and reports. The grid says how many pins the header has and how they are numbered.'],
    example: { question: 'How should I name and describe this header?', answer: 'Use the label printed next to it, J4, so your notes match the board. Then set the grid to 1 row and 4 columns in the Header panel, so each pin has a number you can give a role.' },
    check: (f) => [...(f.label === 'J4' ? ['label'] : []), ...(f.rows === 1 && f.cols === 4 ? ['shape'] : [])],
    hint: (f) => {
      if (f.label && f.label !== 'J4') return 'The silkscreen says J4. Use exactly that as the label.';
      if (f.header && !(f.rows === 1 && f.cols === 4)) return 'This header has one row of four pins. Set rows to 1 and columns to 4 in the Header panel.';
      return '';
    },
    target: (f) => (f.label !== 'J4' ? 'marker-label' : 'header-cols'),
  },
  {
    id: 'ground', chapter: 1, title: 'Find ground, with power off',
    body: ['Ground is the pin that beeps against the metal shell of the power jack.', 'Unplug the board first. Then set pin 4 to GND in the Header panel.'],
    tasks: [task('gnd', 'Pin 4 has the role GND, and no other pin does')], panels: panel('photo', 'inspector'), wiki: 'ground',
    why: ['A continuity test only works on a board with no power. Ground is the reference for every voltage you measure next.'],
    example: { question: 'How do I find ground safely?', answer: 'Unplug the board, set the meter to continuity and hold one probe on the metal shell of the power jack. Touch each pin with the other probe: the one that beeps is ground. Never test continuity on a powered board.' },
    check: (f) => (f.roles[3] === 'GND' && f.groundPins.length === 1 ? ['gnd'] : []),
    hint: (f) => {
      if (f.powered && f.meterMode === 'continuity') return 'A continuity test needs a board with no power. Unplug the board first.';
      if (f.groundPins.length > 1) return 'Only one pin of this header is ground. Clear the others.';
      if (f.groundPins.length === 1 && f.roles[3] !== 'GND') return 'That pin did not beep against the shell. Ground is the pin that does: probe each pin and listen.';
      return '';
    },
    target: (f) => (f.powered ? 'bench-power' : 'pin-role'),
    bench: 'meter', benchSetup: { powered: false, mode: 'continuity' },
  },
  {
    id: 'supply', chapter: 1, title: 'Find the steady supply',
    body: ['With the board powered, one pin sits at a steady 3.3 V.', 'Mark pin 1 as 3V3 in the Header panel.'],
    tasks: [task('v33', 'Pin 1 has the role 3V3')], panels: panel('photo', 'inspector'), wiki: 'logic-levels',
    why: ['A steady 3.3 V on a UART header is almost always the supply, not a data line. Do not connect the adapter to it.'],
    example: { question: 'Which pin is the supply, and should I connect it?', answer: 'Power the board and measure each pin against ground in DC volts. The pin that sits at a steady 3.3 V the whole time is the supply. Leave it unconnected: the board has its own power, and a second supply can damage it.' },
    check: (f) => (f.roles[0] === '3V3' ? ['v33'] : []),
    hint: (f) => {
      if (f.roles[1] === '3V3') return 'Pin 2 moves while the board boots, so it carries data, not power. The supply never moves.';
      if (f.roles[2] === '3V3') return 'Pin 3 reads 3.28 V, so it is a data line held high. The supply is the pin that reads exactly 3.30 V.';
      if (!f.powered && f.meterMode === 'dc') return 'The board is unplugged, so every pin reads 0 V. Plug it in to measure the supply.';
      return '';
    },
    target: (f) => (f.powered ? 'pin-role' : 'bench-power'),
    bench: 'meter', benchSetup: { powered: true, mode: 'dc' },
  },
  {
    id: 'tx', chapter: 1, title: 'Catch TX during boot',
    body: ['A transmit pin idles at 3.3 V and flickers while the board boots.', 'Mark pin 2 as TX in the Header panel.'],
    tasks: [task('tx', 'Pin 2 has the role TX')], panels: panel('photo', 'inspector'), wiki: 'uart',
    why: ['The board sends its boot messages on TX. A steady line is not a data line, so look for the pin that moves while the board starts.'],
    example: { question: 'How do I tell TX from RX with a meter?', answer: 'Watch each pin while the board starts. TX idles high and the reading jumps while the board sends its boot messages; RX stays steady because nothing talks to it yet. Power-cycle the board and watch pin 2.' },
    check: (f) => (f.roles[1] === 'TX' ? ['tx'] : []),
    hint: (f) => (f.roles[0] === 'TX' || f.roles[2] === 'TX' ? 'A steady pin is not transmitting. TX is the pin that flickers while the board boots.' : ''),
    target: () => 'bench-cycle',
    bench: 'meter', benchSetup: { powered: true, mode: 'dc', probe: 2 },
  },
  {
    id: 'rx', chapter: 1, title: 'RX by elimination',
    body: ['The pin left over is the board\'s receive pin.', 'Mark pin 3 as RX in the Header panel.'],
    tasks: [task('rx', 'Pin 3 has the role RX')], panels: panel('photo', 'inspector'), wiki: 'uart',
    why: ['Ground, supply and TX are known, so the fourth pin is RX. It usually reads a steady 3.3 V because the board holds it high.'],
    example: { question: 'Is the last pin really RX?', answer: 'It is very likely. Ground, supply and TX are known, so the pin left over is RX. It reads close to 3.3 V because the board holds it high. You will see it work in chapter 4, when the board answers what you type.' },
    check: (f) => (f.roles[2] === 'RX' ? ['rx'] : []), hint: () => '', target: () => 'pin-role',
    bench: null, benchSetup: { powered: true, mode: 'dc' },
  },
  {
    id: 'wiring', chapter: 2, title: 'Cross the data lines',
    body: ['Connect the adapter to the header: its RXD goes to the board\'s TX and its TXD to the board\'s RX.', 'Ground goes to ground. Leave VCC open.'],
    tasks: [task('wired', 'Wire the adapter correctly')], panels: panel('photo', 'inspector'), wiki: 'uart',
    why: ['Each side listens where the other talks, so the data lines cross. The board has its own power, and a second supply on VCC can damage it.'],
    example: { question: 'How do I connect my USB serial adapter?', answer: 'Cross the data lines: adapter RXD to the board\'s TX, adapter TXD to the board\'s RX, and GND to GND. Leave the adapter\'s VCC open. Check that the adapter is set to 3.3 V, not 5 V.' },
    check: (f) => (f.wiringCorrect ? ['wired'] : []),
    hint: (f) => {
      if (f.adapterVccConnected) return 'The board has its own power. Leave VCC open.';
      if (f.adapterTxdOnTx) return 'The adapter\'s TXD must go to the board\'s RX, not to its TX.';
      if (f.wiring?.RXD && !f.rxGetsTx) return 'The adapter listens on RXD. It has to hear the board, so connect RXD to the board\'s TX.';
      if (f.wiring?.GND && !f.grounded) return 'Ground goes to ground. Connect the adapter\'s GND to the pin you marked GND.';
      return '';
    },
    target: (f) => (f.adapterVccConnected ? 'wire-VCC' : !f.rxGetsTx ? 'wire-RXD' : !f.txReachesRx ? 'wire-TXD' : 'wire-GND'),
    bench: 'wiring', benchSetup: { powered: true, mode: 'dc' },
  },
  {
    id: 'open-console', chapter: 2, title: 'Open the console',
    body: ['Start the virtual board below. Then open its port in the Console panel at 9600 baud.', 'The text looks like noise because 9600 is the wrong speed.'],
    tasks: [task('open', 'Start the virtual board and open its port'), task('garble', 'See garbled text')], panels: panel('console'), wiki: 'uart',
    why: ['Serial lines have no clock, so both sides must agree on the speed. The wrong speed turns text into noise.',
      'The virtual board stands in for the router. It starts its boot text the moment you open its port, as a real board does when you power it on.'],
    example: { question: 'The console shows random characters. What is wrong?', answer: 'That is the usual sign of a wrong speed. The wiring is probably fine, because something arrives at all. Try other speeds. 115200 is the most common on routers.' },
    check: (f) => [...(f.portOpen ? ['open'] : []), ...(f.sawGarble ? ['garble'] : [])],
    hint: (f) => (f.portIsOpen && f.baud === 115200 && !f.sawGarble ? 'This speed is already the right one, so there is no noise to see. Disconnect and choose 9600. Then connect again.' : ''),
    target: (f) => (!f.vdevRunning ? 'tutorial-vdev-start' : !f.portIsOpen ? 'serial-connect' : 'serial-output'),
    bench: 'vdev',
  },
  {
    id: 'baud', chapter: 2, title: 'Find a readable speed',
    body: ['Try other speeds until the text becomes readable.', '115200 is the most common speed on routers.'],
    tasks: [task('baud', 'Choose 115200'), task('banner', 'See the clean U-Boot banner')], panels: panel('console'), wiki: 'uart',
    why: ['Common speeds are 9600, 38400, 57600 and 115200. A banner that reads cleanly shows that the speed is right.',
      'On a real board, the Console\'s Detect button tries the common speeds for you. The tutorial hides it so you learn what it does.'],
    example: { question: 'Which speeds should I try?', answer: 'Start with 115200, then 57600, 38400 and 9600. The right one gives clean text, such as a U-Boot banner. Connect again after each change, so the board starts over.' },
    check: (f) => [...(f.baud === 115200 ? ['baud'] : []), ...(f.sawBanner ? ['banner'] : [])],
    hint: (f) => {
      if (f.sawBanner && f.baud !== 115200) return 'The text is readable, but the speed is not 115200 any more. Set it back.';
      if (f.portIsOpen && f.baud !== 115200) return 'This speed still gives noise. Disconnect and choose 115200. Then connect again: the board restarts when you connect.';
      return '';
    },
    target: (f) => (f.portIsOpen && f.baud !== 115200 ? 'serial-connect' : f.baud !== 115200 ? 'serial-baud' : !f.portIsOpen ? 'serial-connect' : 'serial-output'),
    bench: 'vdev',
  },
  {
    id: 'read-first', chapter: 3, title: 'Read before you type',
    body: ['Read what the board says before sending anything.', 'Find the line that names the flash chip. Then choose it below.'],
    tasks: [task('flash', 'Let the boot text print at 115200'), task('answer', 'Name the flash chip')], panels: panel('console'), wiki: 'reading-boot-logs',
    why: ['The boot text names the chips, the memory sizes and the software version. Reading changes nothing on the board.'],
    question: { legend: 'Which chip holds the firmware?', choices: ['ARC7621', '25Q128', 'eth0'], answer: '25Q128' },
    example: { question: 'What does this boot text tell me?', answer: 'It names the processor on the CPU line, the memory on the DRAM line and the flash chip on the line that starts with SF. The flash chip holds the firmware, so note it before you try to back up the firmware.' },
    check: (f) => [...(f.sawFlash ? ['flash'] : []), ...(f.sawFlash && f.flashAnswer === '25Q128' ? ['answer'] : [])],
    hint: (f) => {
      if (!f.portIsOpen && !f.sawFlash) return 'Connect at 115200 so the board prints its boot text.';
      if (f.flashAnswer === 'ARC7621') return 'ARC7621 is the processor, on the CPU line. The flash chip is on the line that starts with SF.';
      if (f.flashAnswer === 'eth0') return 'eth0 is the network port, on the Net line. The flash chip is on the line that starts with SF.';
      return '';
    },
    target: (f) => (!f.portIsOpen && !f.sawFlash ? 'serial-connect' : !f.sawFlash ? 'serial-output' : 'tutorial-question'),
    bench: 'vdev',
  },
  {
    id: 'bootloader', chapter: 3, title: 'Stop at the bootloader',
    body: ['The bootloader counts down for a few seconds before it starts Linux.', 'Press Any key while the countdown runs. Then run printenv.'],
    tasks: [task('prompt', 'Reach the U-Boot prompt'), task('printenv', 'Run printenv')], panels: panel('console'), wiki: 'u-boot',
    why: ['U-Boot is the program that starts Linux. At its prompt you can read the boot settings without changing anything.'],
    example: { question: 'How do I stop at U-Boot without breaking anything?', answer: 'Press Any key while the countdown runs. The countdown follows the line "Hit any key to stop autoboot". At the prompt, commands that only read, such as printenv and help, are safe. Avoid erase, write and saveenv until you have a backup.' },
    check: (f) => [...(f.ubootPrompt ? ['prompt'] : []), ...(f.ranPrintenv ? ['printenv'] : [])],
    hint: (f) => {
      if (f.typedBeforePrompt) return 'Wait for the prompt before typing. Press Any key while the countdown runs.';
      if (f.sawKernel && !f.ubootPrompt) return 'The countdown ended and Linux started. Disconnect and connect again, so that the board restarts. Press Any key while the countdown runs.';
      if (!f.portIsOpen && !f.ubootPrompt) return 'Connect at 115200. The board starts when you connect.';
      return '';
    },
    target: (f) => (!f.portIsOpen && !f.ubootPrompt ? 'serial-connect' : !f.ubootPrompt ? 'key-space' : 'serial-input'),
    bench: 'vdev',
  },
  {
    id: 'shell', chapter: 3, title: 'Boot Linux and get a shell',
    body: ['Type boot and press Enter.', 'When the shell prompt appears, run one command.'],
    tasks: [task('shell', 'Reach the shell prompt'), task('command', 'Run one command')], panels: panel('console'), wiki: 'serial-terminals',
    why: ['A shell on a router usually runs as root, so a wrong command can damage the board.'],
    example: { question: 'I have a shell. What should I look at first?', answer: 'Start with commands that only read: uname -a for the kernel, cat /proc/mtd for the flash partitions and cat /proc/cpuinfo for the chip. I can suggest commands, but I never run them. You type each one yourself.' },
    check: (f) => [...(f.shellPrompt ? ['shell'] : []), ...(f.ranShellCommand ? ['command'] : [])],
    hint: (f) => {
      if (f.shellPrompt) return '';
      if (!f.ubootPrompt && !f.sawKernel) return 'Reach the U-Boot prompt first. Connect at 115200. Press Any key while the countdown runs.';
      if (f.sawKernel) return 'Linux is starting. When the board says "Please press Enter", press Enter.';
      return '';
    },
    target: (f) => (f.shellPrompt ? 'serial-input' : f.sawKernel ? 'key-enter' : f.ubootPrompt ? 'serial-input' : 'key-space'),
    bench: 'vdev',
  },
  {
    id: 'signal', chapter: 4, title: 'Look at the signal',
    body: ['The practice logic capture is open in the Logic panel.', 'Below the waveform, keep channel D0 and choose 115200.', 'Then press Decode UART.'],
    tasks: [task('open', 'The practice logic capture is open'), task('decode', 'Decode it as UART at 115200')], panels: panel('logic'), wiki: 'logic-analyzer',
    why: ['A logic analyser records the line itself, with its timing. A capture shows what is on the wire, independent of any program on your computer.'],
    example: { question: 'How do I decode this capture?', answer: 'Choose the channel the TX line was on, D0, and the speed the console used, 115200, then press Decode UART. Many framing errors mean the speed is wrong.' },
    check: (f) => [...(f.captureOpen ? ['open'] : []), ...(f.decoded115200 ? ['decode'] : [])],
    hint: (f) => (f.decodedBaud && f.decodedBaud !== 115200 ? 'That speed is not the one the console used. Choose 115200 and decode again.' : ''),
    target: () => 'logic-decode',
  },
  {
    id: 'agree', chapter: 4, title: 'Make two instruments agree',
    body: ['You now have two records of the same boot. The serial adapter made one in step 11. The logic analyzer made the other.',
      'At the bottom of the Logic panel, choose the console capture at 115200. Then press Compare.',
      'The two captures agree until you stopped the countdown.'],
    tasks: [task('compare', 'Compare the logic capture with the console capture')], panels: panel('logic'), wiki: 'logic-analyzer',
    why: ['The serial adapter and the logic analyzer share no parts. They only agree if the pin, the speed and the voltage level are all right.',
      'A wrong speed, a wrong pin and a wrong threshold would each make the two captures differ, so a match rules out all three.',
      'The logic capture was recorded while nobody touched the board, so its countdown ran out and Linux started. In your console capture you stopped that countdown, so the first difference is the moment you stopped it.'],
    example: { question: 'Why compare the logic capture with the console capture?', answer: 'If two separate instruments see the same text, the speed, the pin and the voltage level are all right. Expect them to match until you stopped the countdown. After that the board did something different in each capture.' },
    check: (f) => (f.compareMatches ? ['compare'] : []),
    hint: (f) => {
      if (f.compareRatio !== null && !f.compareMatches) return 'These two captures differ almost everywhere. You may have picked the garbled capture from 9600. Choose the console capture made at 115200.';
      if (!f.consoleCaptures) return 'There is no console capture yet. Go back to step 11. Connect at 115200 and let the boot text print.';
      return '';
    },
    target: () => 'logic-compare-bar',
  },
  {
    id: 'write-down', chapter: 4, title: 'Write it down',
    body: ['In the Header panel, give the header a name.', 'Add a note of at least eight characters, for example the speed and what each pin does.'],
    tasks: [task('name', 'Set the header name'), task('note', 'Write a note of at least 8 characters')], panels: panel('photo', 'inspector'), wiki: 'method-and-ethics',
    why: ['Notes make the work reusable. A note with the pinout, the speed and the wiring lets you repeat the work later.'],
    example: { question: 'What should my notes on this header say?', answer: 'Write the pinout (1 3V3, 2 TX, 3 RX, 4 GND) and the speed (115200). Add how the adapter is wired and anything surprising, such as the autoboot countdown. Keep what you measured apart from what you guessed.' },
    check: (f) => [...(f.headerName && f.headerName !== 'Header' ? ['name'] : []), ...(f.notes.trim().length >= 8 ? ['note'] : [])],
    hint: () => '', target: (f) => (f.headerName && f.headerName !== 'Header' ? 'header-notes' : 'header-name'),
  },
  {
    id: 'export', chapter: 4, title: 'Take it with you',
    body: ['In the Board panel, export a report: the annotated photo, the pinout and your notes.'],
    tasks: [task('exported', 'Export a report')], panels: panel('board'), wiki: 'method-and-ethics',
    why: ['A report keeps the work after the practice board is gone. Exports hide serial numbers and passwords when redaction is on. Leave it on.'],
    example: { question: 'Is the exported report safe to share?', answer: 'Leave redaction on: it hides passwords, serial numbers and MAC addresses that it recognises in the logs. Read the report before you share it anyway, because redaction finds known patterns, not everything.' },
    check: (f) => (f.exported ? ['exported'] : []), hint: () => '', target: () => 'export-run',
  },
];

export const lesson = (step) => LESSONS[step - 1];

/**
 * The bench a step starts from. Steps that come after the wiring step start with the adapter wired
 * correctly, so resuming at step 12 has the same bench as having done step 9. Wiring before and on the
 * wiring step is never touched, so going Back does not undo it.
 */
export function benchSetup(step) {
  if (step > 9) return { powered: true, mode: 'dc', wiring: 'correct' };
  return lesson(step).benchSetup ?? {};
}
/**
 * What the Console panel starts from at a step: the first lesson shows the noise a wrong speed makes, so it
 * starts at 9600; once the speed is known the select starts at the board's own. Other steps leave it alone.
 */
export function consoleSetup(step) {
  if (step === 10) return { baud: 9600 };
  if (step >= 12 && step <= 14) return { baud: 115200 };
  return {};
}
export const doneTasks = (step, facts) => lesson(step).check(facts);
export const stepDone = (step, facts) => lesson(step).tasks.every((t) => doneTasks(step, facts).includes(t.id));

/**
 * The events that bring a board to the state a step starts from, as they would have been left by the earlier
 * steps. Only what is missing is added, so a learner's own work is never overwritten. Resuming at any step
 * and going Back both start from here.
 */
export function setupEvents(step, project) {
  const events = [];
  const asset = project?.assets?.[0];
  if (!asset || step < 4) return events;
  let marker = project.markers.find((m) => m.shape === 'box' && m.x + m.w / 2 >= J4.x && m.x + m.w / 2 <= J4.x + J4.w && m.y + m.h / 2 >= J4.y && m.y + m.h / 2 <= J4.y + J4.h);
  let schematic = marker && project.schematics.find((s) => s.id === marker.schematicId);
  if (!marker) {
    const added = newMarkerEvent({ assetId: asset.id, rect: J4, label: 'J4', colorIndex: project.markers.length });
    events.push(added);
    marker = added.marker;
    schematic = added.schematic;
  }
  if (step >= 5) {
    if (marker.label !== 'J4') events.push({ type: 'marker/updated', id: marker.id, patch: { label: 'J4' } });
    if (schematic.rows !== 1 || schematic.cols !== 4) events.push({ type: 'schematic/updated', id: schematic.id, patch: { rows: 1, cols: 4 } });
  }
  const wanted = { 4: 'GND', 1: '3V3', 2: 'TX', 3: 'RX' };
  const after = { 4: 6, 1: 7, 2: 8, 3: 9 };
  for (const [index, role] of Object.entries(wanted)) {
    const pin = schematic.pins?.find((p) => p.index === Number(index));
    if (step >= after[index] && pin?.role !== role) events.push({ type: 'pin/updated', schematicId: schematic.id, index: Number(index), patch: { role, color: roleDef(role)?.color ?? '' } });
  }
  return events;
}

/** What the person did, one line each, for the finish page. Only what the facts show is listed. */
export function finishLines(facts) {
  const lines = [];
  if (facts.header) lines.push(`Found the UART header and marked it ${facts.label || 'J4'}`);
  if (['3V3', 'TX', 'RX', 'GND'].every((role) => facts.roles?.includes(role))) lines.push('Named the four pins: 3V3, TX, RX and GND');
  if (facts.wiringCorrect) lines.push('Crossed the data lines and left VCC open');
  if (facts.sawBanner) lines.push('Opened the console at 115200 and read the U-Boot banner');
  if (facts.sawFlash) lines.push('Read the boot text and found the flash chip');
  if (facts.ranPrintenv) lines.push('Stopped in U-Boot and ran printenv');
  if (facts.ranShellCommand) lines.push('Booted Linux and ran a command in the shell');
  if (facts.decoded115200) lines.push('Decoded the logic capture as UART at 115200');
  if (facts.compareMatches) lines.push('Checked that the logic capture and the console capture agree');
  if (facts.headerName && facts.headerName !== 'Header' && facts.notes?.trim().length >= 8) lines.push('Wrote down the header and its notes');
  if (facts.exported) lines.push('Exported a report');
  return lines;
}
