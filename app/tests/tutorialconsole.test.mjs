import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConsoleFacts, factsFromRecordings } from '../js/core/tutorial/consolefacts.js';
import { LESSONS, consoleSetup, finishLines, lesson, stepDone } from '../js/core/tutorial/lessons.js';
import { J4, buildFacts } from '../js/core/tutorial/facts.js';
import { ACTION_NAMES, allowed, allowedAction } from '../js/core/tutorial/policy.js';
import { newMarkerEvent } from '../js/core/schema.js';

// Recorded from the virtual board (pcbv.vdev.Console), as the wire carries it.
const rec = JSON.parse(readFileSync(new URL('./fixtures/vdev-console.json', import.meta.url), 'utf8'));

const session = (id = 'cap_1', baud = 115200) => ({ captureId: id, baud });
function play(chunks, { baud = 115200, id = 'cap_1', facts = createConsoleFacts() } = {}) {
  facts.session(session(id, baud));
  for (const chunk of chunks) facts.data(chunk);
  return facts;
}
const f = (facts) => facts.facts();

test('at 9600 the board\'s text is noise: it counts as garbled and never as a banner', () => {
  const facts = play([rec.noise9600], { baud: 9600 });
  assert.equal(f(facts).sawGarble, true);
  assert.equal(f(facts).sawBanner, false);
  assert.equal(f(facts).portOpen, true);
  // The board's real text received at the wrong speed (it would not happen on the wire) is not noise and not a banner.
  const odd = play(rec.boot, { baud: 9600 });
  assert.equal(f(odd).sawBanner, false);
  assert.equal(f(odd).sawGarble, false);
});

test('a few stray characters are not noise', () => {
  const facts = play(['ÿþ€\r\n'], { baud: 9600 });
  assert.equal(f(facts).sawGarble, false);
});

test('the boot at 115200 shows the banner and the flash chip, and stops short of a prompt', () => {
  const facts = play(rec.boot);
  assert.deepEqual([f(facts).sawBanner, f(facts).sawFlash], [true, true]);
  assert.deepEqual([f(facts).ubootPrompt, f(facts).ranPrintenv, f(facts).shellPrompt], [false, false, false]);
});

test('the U-Boot prompt, printenv, the kernel, the shell and a shell command follow the board\'s text', () => {
  assert.equal(f(play(rec.toPrompt)).ubootPrompt, true);
  assert.equal(f(play(rec.toPrompt)).ranPrintenv, false);
  assert.equal(f(play(rec.printenv)).ranPrintenv, true);
  const shell = f(play(rec.toShell));
  assert.deepEqual([shell.sawKernel, shell.shellPrompt, shell.ranShellCommand], [true, true, false], 'a shell prompt alone is not a command');
  assert.equal(f(play(rec.ranCommand)).ranShellCommand, true);
});

test('an empty Enter at the shell is not a command', () => {
  const facts = play([...rec.toShell, '\r\nroot@ARC-DEMO:/# ']);
  assert.equal(f(facts).ranShellCommand, false);
});

test('letting the countdown run out reaches Linux without a U-Boot prompt', () => {
  const facts = f(play(rec.kernelOnly));
  assert.deepEqual([facts.sawKernel, facts.ubootPrompt], [true, false]);
});

test('a prompt that is only typed does not count, because the board echoes it after its own prompt', () => {
  const facts = play(['Starting kernel ...\r\n', 'root@ARC-DEMO:/# ARC7621 # \r\n']);
  assert.equal(f(facts).ubootPrompt, false);
  const shell = play(['ARC7621 # root@ARC-DEMO:/# ']);
  assert.equal(f(shell).shellPrompt, false);
  const env = play(['ARC7621 # bootargs= bootcmd= baudrate=115200\r\n']);
  assert.equal(f(env).ranPrintenv, false);
});

test('a new session starts a fresh screen but keeps what was already seen', () => {
  const facts = play(rec.toPrompt);
  assert.equal(f(facts).ubootPrompt, true);
  facts.session(null);
  assert.equal(f(facts).portIsOpen, false);
  assert.equal(f(facts).portOpen, true, 'opening a port once is remembered');
  play(['Hit any key'], { id: 'cap_2', facts });
  assert.equal(f(facts).ubootPrompt, true);
});

test('a backlog sent again on reconnect replaces the screen, so a bare shell prompt does not become a command', () => {
  const facts = play(rec.toShell);
  const text = rec.toShell.join('');
  facts.backlog(text);
  facts.backlog(text);
  assert.equal(f(facts).shellPrompt, true);
  assert.equal(f(facts).ranShellCommand, false);
});

test('text outside an open session is ignored', () => {
  const facts = createConsoleFacts();
  facts.data(rec.boot.join(''));
  assert.equal(f(facts).sawBanner, false);
});

test('the chosen speed is tracked while no port is open, and the open session\'s speed wins', () => {
  const facts = createConsoleFacts();
  facts.chose(9600);
  assert.equal(f(facts).baud, 9600);
  facts.session(session('cap_1', 115200));
  assert.equal(f(facts).baud, 115200);
  facts.chose(9600);
  assert.equal(f(facts).baud, 115200, 'the select cannot change while a port is open');
});

test('a line typed before the prompt is the mistake; keys and later lines are not', () => {
  const facts = play(rec.boot);
  facts.sent('key');
  assert.equal(f(facts).typedBeforePrompt, false, 'Any key is how the countdown is stopped');
  facts.sent('line');
  assert.equal(f(facts).typedBeforePrompt, true);
  play(rec.toPrompt, { facts, id: 'cap_2' });
  assert.equal(f(facts).typedBeforePrompt, false, 'cleared once the prompt is there');
  const later = play(rec.toPrompt);
  later.sent('line');
  assert.equal(f(later).typedBeforePrompt, false);
});

test('reset forgets everything', () => {
  const facts = play(rec.ranCommand);
  facts.vdev(true);
  facts.reset();
  assert.equal(f(facts).portOpen, false);
  assert.equal(f(facts).shellPrompt, false);
  assert.equal(f(facts).vdevRunning, false);
});

// Lessons 10 to 16.

const baseFacts = (extra) => buildFacts({ extra });
const done = (step, extra) => stepDone(step, baseFacts(extra));

test('step 10 needs a port opened and noise seen; opening at the right speed hints to try 9600', () => {
  assert.equal(done(10, { portOpen: true }), false);
  assert.equal(done(10, { sawGarble: true }), false);
  assert.equal(done(10, { portOpen: true, sawGarble: true }), true);
  assert.match(lesson(10).hint(baseFacts({ portIsOpen: true, baud: 115200 })), /choose 9600/);
  assert.equal(lesson(10).hint(baseFacts({ portIsOpen: true, baud: 9600 })), '');
  assert.equal(lesson(10).hint(baseFacts({ portIsOpen: true, baud: 115200, sawGarble: true })), '');
  assert.equal(lesson(10).target(baseFacts({})), 'tutorial-vdev-start');
  assert.equal(lesson(10).target(baseFacts({ vdevRunning: true })), 'serial-connect');
  assert.equal(lesson(10).target(baseFacts({ vdevRunning: true, portIsOpen: true })), 'serial-output');
});

test('step 11 needs 115200 and the clean banner, and says how to change a speed that is locked while open', () => {
  assert.equal(done(11, { baud: 115200 }), false);
  assert.equal(done(11, { baud: 115200, sawBanner: true }), true);
  assert.equal(done(11, { baud: 9600, sawBanner: true }), false);
  assert.match(lesson(11).hint(baseFacts({ baud: 9600, sawBanner: true })), /not 115200 any more/);
  assert.match(lesson(11).hint(baseFacts({ baud: 9600, portIsOpen: true })), /Disconnect and choose 115200/);
  assert.equal(lesson(11).hint(baseFacts({ baud: 9600 })), '');
  assert.equal(lesson(11).target(baseFacts({ baud: 9600, portIsOpen: true })), 'serial-connect');
  assert.equal(lesson(11).target(baseFacts({ baud: 9600 })), 'serial-baud');
  assert.equal(lesson(11).target(baseFacts({ baud: 115200 })), 'serial-connect');
  assert.equal(lesson(11).target(baseFacts({ baud: 115200, portIsOpen: true })), 'serial-output');
});

test('step 12 is done when the flash chip line was read; it asks to connect when nothing is open', () => {
  assert.equal(done(12, {}), false);
  assert.equal(done(12, { sawFlash: true }), false, 'the question is still to answer');
  assert.equal(done(12, { sawFlash: true, flashAnswer: '25Q128' }), true);
  assert.match(lesson(12).hint(baseFacts({})), /Connect at 115200/);
  assert.equal(lesson(12).hint(baseFacts({ portIsOpen: true })), '');
  assert.equal(lesson(12).target(baseFacts({})), 'serial-connect');
});

test('step 13 needs the prompt and printenv, and explains a missed countdown and early typing', () => {
  assert.equal(done(13, { ubootPrompt: true }), false);
  assert.equal(done(13, { ubootPrompt: true, ranPrintenv: true }), true);
  assert.match(lesson(13).hint(baseFacts({ typedBeforePrompt: true })), /Wait for the prompt/);
  assert.match(lesson(13).hint(baseFacts({ sawKernel: true, portIsOpen: true })), /Disconnect and connect again/);
  assert.match(lesson(13).hint(baseFacts({})), /Connect at 115200/);
  assert.equal(lesson(13).hint(baseFacts({ ubootPrompt: true, portIsOpen: true })), '');
  assert.equal(lesson(13).target(baseFacts({})), 'serial-connect');
  assert.equal(lesson(13).target(baseFacts({ portIsOpen: true })), 'key-space');
  assert.equal(lesson(13).target(baseFacts({ portIsOpen: true, ubootPrompt: true })), 'serial-input');
});

test('step 14 needs the shell prompt and a command, and tells a resumed learner to reach U-Boot first', () => {
  assert.equal(done(14, { shellPrompt: true }), false);
  assert.equal(done(14, { shellPrompt: true, ranShellCommand: true }), true);
  assert.match(lesson(14).hint(baseFacts({})), /Reach the U-Boot prompt first/);
  assert.equal(lesson(14).hint(baseFacts({ ubootPrompt: true })), '');
  assert.match(lesson(14).hint(baseFacts({ ubootPrompt: true, sawKernel: true })), /press Enter/);
  assert.equal(lesson(14).hint(baseFacts({ shellPrompt: true, sawKernel: true })), '');
  assert.equal(lesson(14).target(baseFacts({})), 'key-space');
  assert.equal(lesson(14).target(baseFacts({ ubootPrompt: true })), 'serial-input');
  assert.equal(lesson(14).target(baseFacts({ ubootPrompt: true, sawKernel: true })), 'key-enter');
  assert.equal(lesson(14).target(baseFacts({ shellPrompt: true, sawKernel: true })), 'serial-input');
});

const withCaptures = (captures) => {
  const event = newMarkerEvent({ assetId: 'as_1', rect: J4, label: 'J4' });
  return { assets: [{ id: 'as_1' }], markers: [event.marker], schematics: [event.schematic], captures };
};
const logicCapture = (extra = {}) => ({ id: 'cap_l', kind: 'logic', ...extra });
const decodedAt = (baud, extra = {}) => ({ channel: 0, name: 'D0', baud, bytes: 900, errors: 0, ...extra });

test('the decode and the comparison are read from the capture the service saved', () => {
  const facts = (captures, extra) => buildFacts({ project: withCaptures(captures), extra });
  assert.equal(facts([]).decoded115200, false);
  assert.equal(facts([logicCapture()]).decoded115200, false, 'a capture nobody decoded');
  assert.equal(facts([logicCapture({ decoded: [decodedAt(115200)] })]).decoded115200, true);
  assert.equal(facts([logicCapture({ decoded: [decodedAt(57600)] })]).decoded115200, false);
  assert.equal(facts([logicCapture({ decoded: [decodedAt(115200, { bytes: 3 })] })]).decoded115200, false, 'the idle channel decodes to nothing');
  assert.equal(facts([logicCapture({ decoded: [decodedAt(115200, { errors: 4 })] })]).decoded115200, false);
  assert.equal(facts([logicCapture({ decoded: [decodedAt(57600)] })]).decodedBaud, 57600);
  const compared = (ratio) => facts([logicCapture({ compare: { ratio } })]);
  assert.deepEqual([compared(0.997).compareMatches, compared(0.852).compareMatches, compared(0.8).compareMatches, compared(0.79).compareMatches, compared(0.034).compareMatches],
    [true, true, true, false, false], 'a session that stopped the countdown scores about 0.85');
  assert.equal(facts([logicCapture()]).compareRatio, null);
  assert.equal(facts([logicCapture(), { id: 'c1', kind: 'serial' }, { id: 'c2', kind: 'shell' }]).consoleCaptures, 2);
});

test('step 15 is done when the capture is open and decoded at 115200, and warns about another speed', () => {
  assert.equal(done(15, { captureOpen: true }), false);
  assert.equal(done(15, { decoded115200: true }), false);
  assert.equal(done(15, { captureOpen: true, decoded115200: true }), true);
  assert.match(lesson(15).hint(baseFacts({ decodedBaud: 57600 })), /Choose 115200/);
  assert.equal(lesson(15).hint(baseFacts({})), '');
  assert.equal(lesson(15).target(baseFacts({})), 'logic-decode');
});

test('step 16 is done when the comparison matches, and explains a missing or garbled console recording', () => {
  assert.equal(done(16, {}), false);
  assert.equal(done(16, { compareMatches: true, compareRatio: 0.99 }), true);
  assert.match(lesson(16).hint(baseFacts({})), /no console capture yet/);
  assert.match(lesson(16).hint(baseFacts({ consoleCaptures: 2, compareRatio: 0.2 })), /capture made at 115200/);
  assert.equal(lesson(16).hint(baseFacts({ consoleCaptures: 1 })), '');
  assert.equal(lesson(16).target(baseFacts({ consoleCaptures: 1 })), 'logic-compare-bar');
  assert.equal(lesson(16).target(baseFacts({ consoleCaptures: 1, compareRatio: 0.2 })), 'logic-compare-bar');
  assert.equal(lesson(16).target(baseFacts({})), 'logic-compare-bar');
});

test('lessons 15 and 16 say where the controls are', () => {
  assert.match(lesson(15).body.join(' '), /Below the waveform, keep channel D0 and choose 115200\. Then press Decode UART/);
  assert.match(lesson(16).body.join(' '), /At the bottom of the Logic panel, choose the console capture at 115200\. Then press Compare/);
});

test('step 18 is done when a report was exported; every lesson from 10 on names a target that exists in the page', () => {
  assert.equal(done(18, {}), false);
  assert.equal(done(18, { exported: true }), true);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = new Set();
  const facts = [{}, { vdevRunning: true }, { vdevRunning: true, portIsOpen: true }, { baud: 9600 }, { baud: 9600, portIsOpen: true }, { baud: 115200, portIsOpen: true },
    { ubootPrompt: true }, { ubootPrompt: true, sawKernel: true }, { shellPrompt: true }, { portIsOpen: true }, { portIsOpen: true, ubootPrompt: true }, { consoleCaptures: 1 }, { compareRatio: 0.5 }];
  for (let step = 10; step <= 18; step += 1) for (const extra of facts) { const id = lesson(step).target(baseFacts(extra)); if (id) ids.add(id); }
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `the page has #${id}`);
});

test('the Console starts at 9600 on step 10, at 115200 from step 12 to 14, and is left alone otherwise', () => {
  assert.deepEqual(consoleSetup(10), { baud: 9600 });
  assert.deepEqual([11, 15, 18, 3].map(consoleSetup), [{}, {}, {}, {}]);
  assert.deepEqual([12, 13, 14].map(consoleSetup), [{ baud: 115200 }, { baud: 115200 }, { baud: 115200 }]);
});

// The policy for the console and logic steps.

test('the console actions are open only at the steps that teach them', () => {
  const steps = [...Array(18).keys()].map((i) => i + 1);
  const at = (name) => steps.filter((step) => allowedAction(step, name));
  assert.deepEqual(at('vdev-start'), [10, 11, 12, 13, 14]);
  assert.deepEqual(at('serial-open'), [10, 11, 12, 13, 14]);
  assert.deepEqual(at('serial-write'), [13, 14], 'input is locked until the bootloader step');
  assert.deepEqual(at('logic-decode'), [15, 16]);
  assert.deepEqual(at('logic-compare'), [16]);
  assert.deepEqual(at('logic-import'), [], 'importing is locked in every step: the practice capture is the only one');
  assert.deepEqual(at('export'), [18]);
  assert.deepEqual(at('serial-detect'), [], 'Detect would find the speed for the learner, so step 11 would teach nothing');
});

test('every action the policy lists is asked about by the code', () => {
  const code = ['../js/controller.js', '../js/tutorialcontrol.js'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  for (const name of ACTION_NAMES) assert.match(code, new RegExp(`permitAction\\('${name}'\\)`), name);
});

test('step 17 lets through only the header\'s name and notes; steps 15 and 16 let no board change through', () => {
  const event = newMarkerEvent({ assetId: 'as_1', rect: J4, label: 'J4' });
  const project = { assets: [{ id: 'as_1' }], markers: [event.marker], schematics: [event.schematic] };
  const patch = (value) => ({ type: 'schematic/updated', id: event.schematic.id, patch: value });
  assert.equal(allowed(17, patch({ name: 'UART', notes: '115200 8N1' }), project), true);
  assert.equal(allowed(17, patch({ rows: 2 }), project), false);
  assert.equal(allowed(17, { type: 'marker/updated', id: event.marker.id, patch: { label: 'J9' } }, project), false);
  assert.equal(allowed(17, { type: 'marker/removed', id: event.marker.id }, project), false);
  for (const step of [10, 14, 15, 16, 18]) assert.equal(allowed(step, patch({ name: 'x' }), project), false, `step ${step}`);
});

test('the finish page lists the console and logic results only when the facts show them', () => {
  const lines = finishLines({ baud: 115200, sawBanner: true, ranPrintenv: true, ranShellCommand: true, decoded115200: true, compareMatches: true, exported: true });
  assert.deepEqual(lines, [
    'Opened the console at 115200 and read the U-Boot banner', 'Stopped in U-Boot and ran printenv', 'Booted Linux and ran a command in the shell',
    'Decoded the logic capture as UART at 115200', 'Checked that the logic capture and the console capture agree', 'Exported a report',
  ]);
  assert.deepEqual(finishLines({ baud: 9600 }), []);
});

test('every lesson from step 10 on has tasks, a hint function and a target function', () => {
  for (const l of LESSONS.slice(9)) {
    assert.ok(l.tasks.length >= 1, l.id);
    assert.equal(typeof l.hint(baseFacts({})), 'string', l.id);
    assert.ok(['string', 'object'].includes(typeof l.target(baseFacts({}))), l.id);
  }
});

test('Linux from an earlier session does not steer the hints of steps 13 and 14', () => {
  // Step 11: input is locked, so the countdown runs out and Linux boots.
  const facts = play(rec.kernelOnly);
  facts.session(null);
  // Step 13: connect again; the new countdown is running.
  play(rec.boot, { id: 'cap_2', facts });
  const counting = { ...baseFacts(), ...f(facts) };
  assert.equal(counting.sawKernel, false);
  assert.equal(lesson(13).hint(counting), '');
  assert.equal(lesson(13).target(counting), 'key-space');
  for (const chunk of rec.printenv.slice(rec.boot.length)) facts.data(chunk);
  // Step 14: at the U-Boot prompt, about to type boot.
  const atPrompt = { ...baseFacts(), ...f(facts) };
  assert.equal(atPrompt.ubootPrompt, true);
  assert.equal(lesson(14).hint(atPrompt), '');
  assert.equal(lesson(14).target(atPrompt), 'serial-input');
});

// Step 12 asks which chip holds the firmware (spec 22).
const lessonTwelve = lesson(12);
const facts12 = (extra) => ({ ...f(play(rec.boot)), ...extra });

test('step 12 is done when the flash line printed and the right chip was chosen', () => {
  assert.deepEqual(lessonTwelve.check({ sawFlash: false }), []);
  assert.deepEqual(lessonTwelve.check(facts12()), ['flash']);
  assert.deepEqual(lessonTwelve.check(facts12({ flashAnswer: '25Q128' })), ['flash', 'answer']);
  assert.deepEqual(lessonTwelve.check({ sawFlash: false, flashAnswer: '25Q128' }), [], 'the answer counts only after the boot text printed');
  assert.deepEqual(lessonTwelve.check(facts12({ flashAnswer: 'eth0' })), ['flash']);
  assert.equal(stepDone(12, facts12()), false);
  assert.equal(stepDone(12, facts12({ flashAnswer: '25Q128' })), true);
});

test('a wrong chip gets a hint that points at the SF line; no answer gets none', () => {
  assert.match(lessonTwelve.hint(facts12({ flashAnswer: 'ARC7621' })), /processor.*CPU line.*starts with SF/);
  assert.match(lessonTwelve.hint(facts12({ flashAnswer: 'eth0' })), /network port.*Net line.*starts with SF/);
  assert.equal(lessonTwelve.hint(facts12()), '');
  assert.equal(lessonTwelve.hint(facts12({ flashAnswer: '25Q128' })), '');
  assert.match(lessonTwelve.hint({ portIsOpen: false, sawFlash: false }), /Connect at 115200/);
});

test('step 12 shows the question once the flash line was seen, and every choice is in the board\'s first lines', () => {
  const { question } = lessonTwelve;
  assert.deepEqual(question.choices, ['ARC7621', '25Q128', 'eth0']);
  for (const choice of question.choices) assert.ok(rec.boot.join('').includes(choice), choice);
  assert.equal(lessonTwelve.target({ portIsOpen: false, sawFlash: false }), 'serial-connect');
  assert.equal(lessonTwelve.target({ portIsOpen: true, sawFlash: false }), 'serial-output');
  assert.equal(lessonTwelve.target({ portIsOpen: true, sawFlash: true }), 'tutorial-question');
  assert.ok(finishLines({ sawFlash: true }).some((line) => /flash chip/.test(line)));
  assert.ok(!finishLines({}).some((line) => /flash chip/.test(line)));
});

// Console results read back from the board's recordings (spec 22).
const recordings = () => [
  { captureId: 'cap_a', baud: 9600, text: rec.noise9600 },
  { captureId: 'cap_b', baud: 115200, text: rec.boot.join('') },
  { captureId: 'cap_c', baud: 115200, text: rec.ranCommand.join('') },
];

test('recordings give back what they showed, and only what lasts', () => {
  const [garbled, boot, full] = recordings();
  const one = factsFromRecordings([garbled]);
  assert.deepEqual([one.sawGarble, one.sawBanner, one.portOpen], [true, undefined, true]);
  const two = factsFromRecordings([boot]);
  assert.deepEqual([two.sawBanner, two.sawFlash, two.ubootPrompt, two.portOpen], [true, true, undefined, true]);
  const all = factsFromRecordings([garbled, boot, full]);
  for (const name of ['sawGarble', 'sawBanner', 'sawFlash', 'ubootPrompt', 'ranPrintenv', 'shellPrompt', 'ranShellCommand', 'portOpen']) assert.equal(all[name], true, name);
  for (const name of ['sawKernel', 'typedBeforePrompt', 'portIsOpen', 'baud']) assert.equal(Object.hasOwn(all, name), false, name);
  assert.deepEqual(factsFromRecordings([]), {});
});

test('merging results only ever sets facts to true and ignores unknown names', () => {
  const facts = play(rec.boot);
  facts.session(null);
  facts.merge({ ubootPrompt: true, sawGarble: true, sawBanner: false, nonsense: true, portOpen: true });
  const now = f(facts);
  assert.deepEqual([now.ubootPrompt, now.sawGarble, now.sawBanner, now.sawFlash], [true, true, true, true]);
  assert.equal(Object.hasOwn(now, 'nonsense'), false);
  const empty = createConsoleFacts();
  empty.merge({ portOpen: true });
  assert.equal(f(empty).portOpen, true);
  assert.equal(f(empty).portIsOpen, false);
  empty.merge({});
  assert.equal(f(empty).portOpen, true);
});
