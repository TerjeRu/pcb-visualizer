import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTutorialControl, TUTORIAL_SLUG } from '../js/tutorialcontrol.js';
import { lesson } from '../js/core/tutorial/lessons.js';
import { J4 } from '../js/core/tutorial/facts.js';
import { newMarkerEvent } from '../js/core/schema.js';
import { REFUSED } from '../js/core/tutorial/policy.js';
import { readFileSync } from 'node:fs';

const rec = JSON.parse(readFileSync(new URL('./fixtures/vdev-console.json', import.meta.url), 'utf8'));

const asset = { id: 'as_1', width: 1600, height: 1000, path: 'assets/a.png' };
const blank = () => ({ assets: [asset], markers: [], schematics: [] });
const withJ4 = (label = 'J4') => {
  const event = newMarkerEvent({ assetId: asset.id, rect: J4, label });
  return { assets: [asset], markers: [event.marker], schematics: [event.schematic] };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ settings = { tutorial: 'new', tutorialStep: 1 }, lastStep, failCreate = null, slug = 'nimbus', benchOptions = {} } = {}) {
  const log = [];
  const store = {};
  const state = { settings, slug };
  const applied = [];
  const view = {
    draws: [],
    tutorialDraw(model) { view.draws.push(model); },
    async tutorialEnter(panels) { log.push(['enter', panels]); },
    async tutorialLayout(panels) { log.push(['layout', panels]); },
    tutorialLeave() { log.push(['leave']); },
    tutorialConsole(setup) { log.push(['console', setup]); },
    tutorialSay(text) { log.push(['say', text]); },
    tutorialAskLeave(step) { log.push(['ask', step]); },
    tutorialFocusCreate() { log.push(['focusCreate']); },
    benches: [],
    tutorialBench(model) { view.benches.push(model); },
  };
  const sent = [];
  const timers = { items: [], set(fn, ms) { timers.items.push({ fn, ms, cleared: false }); return timers.items.length; }, clear(h) { timers.items[h - 1].cleared = true; } };
  const api = {
    async createTutorialBoard() { log.push(['create']); if (failCreate) throw failCreate; return { slug: TUTORIAL_SLUG }; },
    async resetTutorialBoard() { log.push(['reset']); if (failCreate) throw failCreate; return { slug: TUTORIAL_SLUG }; },
  };
  const hooks = {
    withToken: () => ({ baseUrl: 'x', token: 't' }),
    saveSetting: async (patch) => { log.push(['save', patch]); state.settings = { ...state.settings, ...patch }; },
    failed: (error, fallback) => log.push(['failed', error.message, fallback]),
    currentSlug: () => state.slug,
    client: () => ({ apply: async (event) => { applied.push(event); } }),
    settings: () => state.settings,
    openPractice: () => { state.slug = TUTORIAL_SLUG; log.push(['open']); },
    closed: (previous) => { state.slug = previous; log.push(['closed', previous]); },
    send: async (event) => { sent.push(event); return true; },
    closeSerial: async () => { log.push(['closeSerial', state.slug]); },
    stopVdev: async () => { log.push(['stopVdev']); },
  };
  const storage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const control = createTutorialControl({ api, view, hooks, storage, lastStep, benchOptions, timers });
  const live = (project) => control.stateChanged({ status: 'live', project });
  const last = () => view.draws.at(-1);
  return { control, view, log, applied, sent, timers, state, hooks, store, live, last, entries: (name) => log.filter((e) => e[0] === name) };
}

test('starting creates the practice board, saves step 1, enters with the step panels and opens the board', async () => {
  const t = setup();
  assert.equal(await t.control.start(), true);
  assert.deepEqual(t.log.map((e) => e[0]), ['create', 'save', 'enter', 'console', 'open']);
  assert.deepEqual(t.entries('save')[0][1], { tutorial: 'started', tutorialStep: 1 });
  assert.deepEqual(t.entries('enter')[0][1], ['photo']);
  assert.equal(t.control.active(), true);
  assert.equal(t.store['pcbv.tutorial'], '1');
  assert.equal(await t.control.start(), false, 'a second start while it runs does nothing');
  assert.equal(t.entries('create').length, 1);
});

test('start again rebuilds the board; resume keeps the saved step', async () => {
  const again = setup({ settings: { tutorial: 'started', tutorialStep: 7 } });
  await again.control.start({ restart: true });
  assert.equal(again.entries('reset').length, 1);
  assert.equal(again.entries('create').length, 0);
  assert.equal(again.entries('save')[0][1].tutorialStep, 1);

  const resumed = setup({ settings: { tutorial: 'started', tutorialStep: 7 } });
  await resumed.control.start({ resume: true });
  assert.equal(resumed.control.step(), 7);
  assert.equal(resumed.entries('create').length, 1);
  assert.equal(resumed.entries('save')[0][1].tutorialStep, 7);
  assert.deepEqual(resumed.entries('enter')[0][1], ['photo', 'inspector']);

  const odd = setup({ settings: { tutorial: 'started', tutorialStep: 99 } });
  await odd.control.start({ resume: true });
  assert.equal(odd.control.step(), 1, 'a step outside 1 to 18 starts from the top');
});

test('a practice board that cannot be made stops the start and reports why', async () => {
  const t = setup({ failCreate: new Error('Close the Console or Terminal session on the practice board first.') });
  assert.equal(await t.control.start({ restart: true }), false);
  assert.equal(t.control.active(), false);
  assert.match(t.entries('failed')[0][1], /Close the Console/);
  assert.equal(t.entries('enter').length, 0);
  assert.equal(t.store['pcbv.tutorial'], undefined);
});

test('Continue is off until the step passes, then moves on, saves the step and changes the panels', async () => {
  const t = setup();
  await t.control.start();
  t.live(blank());
  await tick();
  assert.equal(t.last().step, 1);
  assert.equal(t.last().canContinue, true, 'step 1 has no task');
  assert.equal(t.last().canBack, false);
  await t.control.next();
  assert.equal(t.control.step(), 2);
  assert.equal(t.last().step, 2);
  assert.equal(t.last().canContinue, false);
  await t.control.next();
  assert.equal(t.control.step(), 2, 'refused while the task is open');
  t.control.noteZoom();
  assert.equal(t.last().canContinue, true);
  assert.deepEqual(t.last().tasks.map((x) => x.done), [true]);
  await t.control.next();
  assert.equal(t.control.step(), 3);
  assert.deepEqual(t.entries('save').at(-1)[1], { tutorialStep: 3 });
  assert.deepEqual(t.entries('layout').at(-1)[1], ['photo']);
  assert.equal(t.last().moved, true);
  await t.control.back();
  assert.equal(t.control.step(), 2);
  assert.equal(t.last().canContinue, true, 'going back keeps progress');
});

test('step 4 needs the label and the shape; the layout then includes the Header panel', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 3 } });
  await t.control.start({ resume: true });
  t.live(withJ4(''));
  await tick();
  assert.equal(t.last().canContinue, true);
  await t.control.next();
  assert.deepEqual(t.entries('layout').at(-1)[1], ['photo', 'inspector']);
  t.live(withJ4(''));
  await tick();
  assert.equal(t.last().canContinue, false);
  t.live(withJ4('J4'));
  await tick();
  assert.equal(t.last().canContinue, true);
  assert.equal(t.last().last, false);
});

test('resuming on a board without the earlier work sends the setup events once', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 6 } });
  await t.control.start({ resume: true });
  t.live(blank());
  await tick();
  assert.deepEqual(t.applied.map((e) => e.type), ['marker/added', 'pin/updated']);
  assert.equal(t.applied.at(-1).patch.role, 'GND');
  t.live(blank());
  await tick();
  assert.equal(t.applied.length, 2, 'once per step');
});

test('permit lets a step\'s own events through and refuses the rest with a note', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 3 } });
  assert.equal(t.control.permit({ type: 'project/metaUpdated', patch: {} }), true, 'not running: everything goes');
  await t.control.start({ resume: true });
  t.live(blank());
  await tick();
  const marker = newMarkerEvent({ assetId: asset.id, rect: J4, label: '' });
  assert.equal(t.control.permit(marker), true);
  assert.equal(t.control.permit({ type: 'project/metaUpdated', patch: { name: 'x' } }), false);
  assert.deepEqual(t.entries('say').at(-1), ['say', REFUSED]);
  assert.equal(t.control.permitAction('export'), false);
  assert.equal(t.entries('say').length, 2);
  assert.equal(t.control.permitAction('zoom'), false, 'unknown names are refused');
});

test('each step hands the view the control the next open item needs; Continue once the step is done', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 2 } });
  await t.control.start({ resume: true });
  t.live(blank());
  await tick();
  assert.equal(t.last().target, 'zoom-in');
  assert.equal(t.control.showMe, undefined, 'Show me is gone');
  assert.equal(typeof t.control.next, 'function');
});

test('the step model targets Continue once the step is done, and nothing on the finish pages', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 3 } });
  await t.control.start({ resume: true });
  t.live(blank());
  await tick();
  assert.notEqual(t.last().target, 'tutorial-continue');
  t.live(withJ4());
  await tick();
  assert.equal(t.last().canContinue, true);
  assert.equal(t.last().target, 'tutorial-continue');
});

test('leaving restores the previous board, keeps the step and forgets the running flag', async () => {
  const t = setup({ slug: 'router', settings: { tutorial: 'started', tutorialStep: 5 } });
  await t.control.start({ resume: true });
  assert.equal(t.control.wasRunning(), true);
  t.control.askLeave();
  assert.deepEqual(t.entries('ask').at(-1), ['ask', 5]);
  await t.control.leave();
  assert.deepEqual(t.log.slice(-2).map((e) => e[0]), ['leave', 'closed']);
  assert.deepEqual(t.entries('closed')[0], ['closed', 'router']);
  assert.equal(t.control.active(), false);
  assert.equal(t.control.wasRunning(), false);
  assert.equal(t.state.settings.tutorialStep, 5);
  assert.equal(t.state.settings.tutorial, 'started');
  await t.control.leave();
  assert.equal(t.entries('leave').length, 1, 'leaving twice is harmless');
  t.control.askLeave();
  assert.equal(t.entries('ask').length, 1, 'nothing to leave');
});

test('at the last step this build offers, Continue shows a closing page and Back returns to the step', async () => {
  const t = setup({ lastStep: 4, settings: { tutorial: 'started', tutorialStep: 4 } });
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  await t.control.next();
  assert.equal(t.last().kind, 'finish');
  assert.equal(t.last().complete, false);
  assert.match(t.last().lead, /next chapters arrive in the next update/);
  assert.deepEqual(t.last().lines, ['Found the UART header and marked it J4']);
  assert.equal(t.entries('save').some((e) => e[1].tutorial === 'done'), false);
  await t.control.next();
  assert.equal(t.last().kind, 'finish', 'Continue does nothing on the closing page');
  await t.control.back();
  assert.equal(t.last().kind, 'step');
  assert.equal(t.last().step, 4);
});

test('finishing step 18 saves done, shows the finish page with what was done, and Create my first board leaves', async () => {
  const t = setup({ slug: 'router', lastStep: 18, settings: { tutorial: 'started', tutorialStep: 18 } });
  t.control.setExtra(() => ({ exported: true, baud: 115200, sawBanner: true, shellPrompt: true, ranShellCommand: true, decoded115200: true, compareMatches: true, ranPrintenv: true, wiringCorrect: true }));
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.equal(t.last().last, true);
  assert.equal(t.last().canContinue, true);
  await t.control.next();
  assert.deepEqual(t.entries('save').at(-1)[1], { tutorial: 'done', welcomed: true });
  assert.equal(t.last().kind, 'finish');
  assert.equal(t.last().complete, true);
  assert.ok(t.last().lines.includes('Exported a report'));
  assert.ok(t.last().lines.includes('Opened the console at 115200 and read the U-Boot banner'));
  assert.match(t.last().where, /practice board stays on this computer/);
  await t.control.finishCreate();
  assert.deepEqual(t.log.slice(-3).map((e) => e[0]), ['leave', 'closed', 'focusCreate']);
});

test('a reload in the same window resumes; abandon stops without going anywhere', async () => {
  const t = setup();
  assert.equal(t.control.wasRunning(), false);
  await t.control.start();
  assert.equal(t.control.wasRunning(), true);
  t.control.abandon();
  assert.equal(t.control.active(), false);
  assert.equal(t.entries('closed').length, 0);
  assert.equal(t.entries('leave').length, 1);
});

test('state from a board the tutorial left is ignored', async () => {
  const t = setup();
  await t.control.start();
  await t.control.leave();
  const drawn = t.view.draws.length;
  t.live(blank());
  await tick();
  assert.equal(t.view.draws.length, drawn);
});

// The bench (21b).
const j4Project = (roles = {}) => {
  const project = withJ4('J4');
  project.schematics[0].pins = Object.entries(roles).map(([index, role]) => ({ index: Number(index), role }));
  return project;
};
async function atStep(step, options = {}) {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: step }, ...options });
  await t.control.start({ resume: true });
  t.project = j4Project({ 4: 'GND', 1: '3V3', 2: 'TX', 3: 'RX' });
  t.live(t.project);
  await tick();
  return t;
}

test('the meter steps show the meter, step 9 the wiring and the others no bench', async () => {
  for (const [step, kind] of [[4, null], [5, 'meter'], [6, 'meter'], [7, 'meter'], [8, null], [9, 'wiring']]) {
    const t = await atStep(step);
    assert.equal(t.last().bench?.kind ?? null, kind, `step ${step}`);
  }
});

test('step 5 starts with the board unplugged and the meter on continuity, step 6 with it plugged in on volts', async () => {
  const five = await atStep(5);
  assert.deepEqual([five.last().bench.powered, five.last().bench.mode], [false, 'continuity']);
  const six = await atStep(6);
  assert.deepEqual([six.last().bench.powered, six.last().bench.mode], [true, 'dc']);
  const seven = await atStep(7);
  assert.equal(seven.last().bench.probe, 2);
});

test('the meter follows the pin selected in the Header panel and shows what the board would read', async () => {
  const t = await atStep(5);
  t.control.notePin(4);
  assert.equal(t.view.benches.at(-1).probe, 4);
  assert.equal(t.view.benches.at(-1).reading.text, 'beep  0.0 Ω');
  t.control.notePin(2);
  assert.equal(t.view.benches.at(-1).reading.text, 'OL');
  const count = t.view.benches.length;
  t.control.notePin(2);
  t.control.notePin(null);
  t.control.notePin(9);
  assert.equal(t.view.benches.length, count, 'the same pin, no pin and a pin that is not on J4 draw nothing');
});

test('the meter buttons act at the meter steps and are refused elsewhere', async () => {
  const t = await atStep(5);
  t.control.benchProbe(3);
  t.control.benchPower(true);
  assert.equal(t.view.benches.at(-1).reading.text, 'Unplug the board first');
  t.control.benchMode('dc');
  assert.equal(t.view.benches.at(-1).reading.text, '3.28 V');
  assert.equal(t.entries('say').length, 0);
  const wiring = await atStep(9);
  wiring.control.benchPower(false);
  wiring.control.benchMode('continuity');
  wiring.control.benchProbe(1);
  wiring.control.benchCycle();
  assert.equal(wiring.entries('say').length, 4);
  assert.equal(wiring.entries('say')[0][1], REFUSED);
  const find = await atStep(3);
  find.control.benchWire('RXD', 2);
  assert.equal(find.entries('say')[0][1], REFUSED);
});

test('Record reading stores the reading on the probed pin of J4 through the ordinary path', async () => {
  const t = await atStep(5);
  assert.equal(await t.control.benchRecord(), false, 'no pin probed yet');
  t.control.notePin(4);
  assert.equal(await t.control.benchRecord(), true);
  assert.equal(t.sent.length, 1);
  const event = t.sent[0];
  assert.equal(event.type, 'pin/readingAdded');
  assert.equal(event.schematicId, t.project.schematics[0].id);
  assert.equal(event.index, 4);
  assert.equal(event.reading.text, 'beep');
  assert.equal(event.reading.source, 'tutorial');
  assert.deepEqual(t.entries('say').at(-1), ['say', 'Recorded beep on pin 4.']);
  t.control.benchPower(true);
  assert.equal(await t.control.benchRecord(), false, 'a refused continuity test is not recorded');
  assert.equal(t.sent.length, 1);
});

test('Record reading asks for the header first when J4 is not marked', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 5 } });
  await t.control.start({ resume: true });
  t.live(blank());
  await tick();
  t.control.notePin(4);
  assert.equal(await t.control.benchRecord(), false);
  assert.deepEqual(t.entries('say').at(-1), ['say', 'Mark the header first.']);
  assert.equal(t.sent.length, 0);
});

test('a power cycle makes pin 2 jumpy for three seconds and the meter redraws on its own until it settles', async () => {
  const clock = { t: 5_000 };
  const t = await atStep(7, { benchOptions: { now: () => clock.t, random: () => 0 } });
  assert.equal(t.timers.items.length, 0, 'nothing is scheduled while the reading is steady');
  t.control.benchCycle();
  assert.equal(t.view.benches.at(-1).reading.jumpy, true);
  assert.equal(t.timers.items.length, 1);
  assert.equal(t.timers.items[0].ms, 250);
  const before = t.view.benches.length;
  clock.t += 1_000;
  t.timers.items[0].fn();
  assert.equal(t.view.benches.length, before + 1);
  assert.equal(t.timers.items.length, 2, 'it schedules the next redraw while jumpy');
  clock.t += 2_500;
  t.timers.items[1].fn();
  assert.equal(t.view.benches.at(-1).reading.jumpy, false);
  assert.equal(t.view.benches.at(-1).reading.text, '3.30 V');
  assert.equal(t.timers.items.length, 2, 'and stops when it has settled');
});

test('leaving or moving on stops the meter redraw', async () => {
  const clock = { t: 0 };
  const t = await atStep(7, { benchOptions: { now: () => clock.t, random: () => 0 } });
  t.control.benchCycle();
  assert.equal(t.timers.items[0].cleared, false);
  await t.control.leave();
  assert.equal(t.timers.items[0].cleared, true);
  const moving = await atStep(7, { benchOptions: { now: () => clock.t, random: () => 0 } });
  moving.control.benchCycle();
  await moving.control.next();
  assert.equal(moving.timers.items[0].cleared, true);
});

test('step 9 is finished when the adapter is wired across, and the wiring survives Back and Continue', async () => {
  const t = await atStep(9);
  assert.equal(t.last().canContinue, false);
  t.control.benchWire('RXD', 2);
  t.control.benchWire('TXD', 3);
  assert.equal(t.last().canContinue, false);
  t.control.benchWire('GND', 4);
  assert.equal(t.last().canContinue, true);
  assert.deepEqual(t.last().bench.wiring, { VCC: null, TXD: 3, RXD: 2, GND: 4 });
  assert.deepEqual(t.last().bench.pins.map((p) => p.role), ['3V3', 'TX', 'RX', 'GND'], 'the wiring options carry the roles the person marked');
  await t.control.back();
  assert.equal(t.last().step, 8);
  await t.control.next();
  assert.equal(t.last().step, 9);
  assert.equal(t.last().canContinue, true);
});

test('wiring VCC shows the hint and blocks Continue', async () => {
  const t = await atStep(9);
  t.control.benchWire('RXD', 2);
  t.control.benchWire('TXD', 3);
  t.control.benchWire('GND', 4);
  t.control.benchWire('VCC', 1);
  assert.equal(t.last().canContinue, false);
  assert.match(t.last().hint, /Leave VCC open/);
});

test('resuming after the wiring step starts with the adapter wired', async () => {
  const t = await atStep(12);
  // The step 12 model has no bench, so go back to the wiring step to see what the setup left.
  await t.control.back();
  await t.control.back();
  await t.control.back();
  assert.equal(t.last().step, 9);
  assert.equal(t.last().canContinue, true);
  assert.equal(t.last().bench.wiring.GND, 4);
});

test('a new start clears the bench', async () => {
  const t = await atStep(9);
  t.control.benchWire('RXD', 2);
  await t.control.leave();
  await t.control.start({ resume: true });
  t.live(t.project);
  await tick();
  assert.deepEqual(t.last().bench.wiring, { VCC: null, TXD: null, RXD: null, GND: null });
});

// Chapters 3 to 5 (21c): the Console, the virtual board and the closing steps.

const sessionMsg = (baud = 115200, id = 'cap_1') => ({ kind: 'session', state: { captureId: id, baud } });
const lastTasks = (t) => t.last().tasks.map((x) => x.done);

test('the Console asks for 9600 on step 10 and for 115200 on step 12, and the choice is told to the view at each step', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 10 } });
  await t.control.start({ resume: true });
  assert.deepEqual(t.entries('console').at(-1), ['console', { baud: 9600 }]);
  t.live(withJ4('J4'));
  await tick();
  t.control.noteConsole(sessionMsg(9600));
  t.control.noteConsole({ kind: 'data', text: 'ÿþ€x~|¿ÃÂ#ð÷¦ª§®°±' });
  assert.equal(t.last().canContinue, true);
  await t.control.next();
  assert.deepEqual(t.entries('console').at(-1), ['console', {}]);
  assert.equal(t.last().step, 11);
});

test('console reports tick the task list live and draw again only when a fact changed', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 10 } });
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.deepEqual(lastTasks(t), [false, false]);
  const drawn = () => t.view.draws.length;
  t.control.noteConsole({ kind: 'vdev', running: true });
  assert.equal(t.last().bench.running, true);
  t.control.noteConsole(sessionMsg(9600));
  assert.deepEqual(lastTasks(t), [true, false]);
  const before = drawn();
  t.control.noteConsole({ kind: 'data', text: 'abc' });
  t.control.noteConsole({ kind: 'data', text: 'def' });
  assert.equal(drawn(), before, 'plain text that changes no fact does not redraw the coach');
  t.control.noteConsole({ kind: 'data', text: 'ÿþ€x~|¿ÃÂ#ð÷¦ª§®°±' });
  assert.deepEqual(lastTasks(t), [true, true]);
});

test('the virtual board is offered on step 10, hidden later while it runs, and offered again when it stopped', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 10 } });
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.deepEqual(t.last().bench, { kind: 'vdev', running: false });
  t.control.noteConsole({ kind: 'vdev', running: true });
  assert.deepEqual(t.last().bench, { kind: 'vdev', running: true }, 'step 10 keeps it, with the running state');
  t.control.noteConsole(sessionMsg(9600));
  t.control.noteConsole({ kind: 'data', text: 'ÿþ€x~|¿ÃÂ#ð÷¦ª§®°±' });
  await t.control.next();
  assert.equal(t.last().step, 11);
  assert.equal(t.last().bench, null, 'running: nothing to start');
  t.control.noteConsole({ kind: 'vdev', running: false });
  assert.deepEqual(t.last().bench, { kind: 'vdev', running: false });
});

test('a speed chosen in the select counts for step 11 while no port is open', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 11 } });
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.deepEqual(lastTasks(t), [false, false]);
  t.control.noteConsole({ kind: 'baud', value: 115200 });
  assert.deepEqual(lastTasks(t), [true, false]);
  t.control.noteConsole(sessionMsg(115200));
  t.control.noteConsole({ kind: 'data', text: 'U-Boot 2015.07-ARC (Mar 14 2019)\r\n' });
  assert.equal(t.last().canContinue, true);
});

test('leaving closes the console on the practice board and stops the virtual board only if the tutorial started it', async () => {
  const t = setup({ slug: 'router', settings: { tutorial: 'started', tutorialStep: 12 } });
  await t.control.start({ resume: true });
  t.control.noteConsole({ kind: 'vdev', running: true });
  t.control.noteConsole(sessionMsg());
  await t.control.leave();
  assert.equal(t.entries('closeSerial').length, 1);
  assert.equal(t.entries('stopVdev').length, 0, 'a virtual board the person started in a terminal stays');
  assert.ok(t.log.findIndex((e) => e[0] === 'closeSerial') < t.log.findIndex((e) => e[0] === 'leave'), 'closed before the view lets go of the practice board');

  const mine = setup({ slug: 'router', settings: { tutorial: 'started', tutorialStep: 12 } });
  await mine.control.start({ resume: true });
  mine.control.vdevStarted();
  mine.control.noteConsole(sessionMsg());
  await mine.control.leave();
  assert.deepEqual([mine.entries('closeSerial').length, mine.entries('stopVdev').length], [1, 1]);
  assert.ok(mine.log.findIndex((e) => e[0] === 'closeSerial') < mine.log.findIndex((e) => e[0] === 'stopVdev'));
});

test('leaving with nothing open calls neither', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  await t.control.start({ resume: true });
  await t.control.leave();
  assert.deepEqual([t.entries('closeSerial').length, t.entries('stopVdev').length], [0, 0]);
});

test('a failing cleanup does not keep the person inside the tutorial', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  const hooks = { closeSerial: async () => { throw new Error('gone'); }, stopVdev: async () => { throw new Error('gone'); } };
  const fresh = createTutorialControl({ api: { createTutorialBoard: async () => ({}), resetTutorialBoard: async () => ({}) }, view: t.view,
    hooks: { withToken: () => ({}), saveSetting: async () => {}, failed() {}, currentSlug: () => 'router', client: () => ({ apply: async () => {} }), settings: () => ({ tutorialStep: 12 }),
      openPractice() {}, closed: (previous) => t.log.push(['closed', previous]), send: async () => true, ...hooks },
    storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  await fresh.start({ resume: true });
  fresh.vdevStarted();
  fresh.noteConsole(sessionMsg());
  await fresh.leave();
  assert.equal(fresh.active(), false);
  assert.equal(t.entries('closed').length, 1);
});

test('the logic and export reports tick steps 15 and 18 and are ignored when the tutorial is not running', async () => {
  const idle = setup();
  idle.control.noteLogic({ open: true });
  idle.control.noteExport();
  idle.control.noteConsole(sessionMsg());
  assert.equal(idle.view.draws.length, 0);

  const logic = setup({ settings: { tutorial: 'started', tutorialStep: 15 } });
  await logic.control.start({ resume: true });
  logic.live(withJ4('J4'));
  await tick();
  assert.deepEqual(lastTasks(logic), [false, false]);
  logic.control.noteLogic({ open: true });
  assert.deepEqual(lastTasks(logic), [true, false]);
  const drawn = logic.view.draws.length;
  logic.control.noteLogic({ open: true });
  assert.equal(logic.view.draws.length, drawn, 'told twice, drawn once');

  const report = setup({ settings: { tutorial: 'started', tutorialStep: 18 } });
  await report.control.start({ resume: true });
  report.live(withJ4('J4'));
  await tick();
  assert.equal(report.last().canContinue, false);
  report.control.noteExport();
  assert.equal(report.last().canContinue, true);
});

test('the decode and the comparison come from the capture on the board, so they survive a reload', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 16 } });
  await t.control.start({ resume: true });
  const project = { ...withJ4('J4'), captures: [{ id: 'cap_l', kind: 'logic', decoded: [{ channel: 0, baud: 115200, bytes: 900, errors: 0 }] },
    { id: 'cap_s', kind: 'serial' }] };
  t.live(project);
  await tick();
  assert.equal(t.last().canContinue, false);
  t.live({ ...project, captures: [{ ...project.captures[0], compare: { channel: 0, with: 'cap_s', ratio: 0.852 } }, project.captures[1]] });
  await tick();
  assert.equal(t.last().canContinue, true);
});

test('finishing stops the virtual board the tutorial started and closes the console; Back from the finish page offers the board again', async () => {
  const t = setup({ slug: 'router', settings: { tutorial: 'started', tutorialStep: 18 } });
  await t.control.start({ resume: true });
  t.control.vdevStarted();
  t.control.noteConsole({ kind: 'vdev', running: true });
  t.control.noteConsole(sessionMsg());
  t.control.noteExport();
  t.live(withJ4('J4'));
  await tick();
  await t.control.next();
  assert.equal(t.last().complete, true);
  assert.deepEqual([t.entries('closeSerial').length, t.entries('stopVdev').length], [1, 1]);
  assert.equal(t.entries('save').at(-1)[1].tutorial, 'done');
  t.control.noteConsole({ kind: 'vdev', running: false });
  t.control.noteConsole({ kind: 'session', state: null });
  await t.control.back();
  await t.control.back();
  assert.equal(t.last().step, 17);
  assert.equal(t.entries('stopVdev').length, 1, 'stopped once');
});

test('Start again begins with no console facts from the earlier run', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  await t.control.start({ resume: true });
  t.control.noteConsole(sessionMsg());
  t.control.noteConsole({ kind: 'data', text: 'SF: Detected 25Q128 with page size 256 Bytes\r\n' });
  t.live(withJ4('J4'));
  await tick();
  t.control.answer('25Q128');
  assert.equal(t.last().canContinue, true);
  await t.control.leave();
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.equal(t.last().canContinue, false);
});

// Step 12's question (spec 22).
test('step 12 carries the question, locked until the flash line printed; the right answer lets the step continue', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.deepEqual(t.last().question, { legend: 'Which chip holds the firmware?', choices: ['ARC7621', '25Q128', 'eth0'], chosen: null, enabled: false });
  t.control.answer('25Q128');
  assert.equal(t.last().question.chosen, null, 'ignored before the boot text printed');
  t.control.noteConsole(sessionMsg());
  t.control.noteConsole({ kind: 'data', text: 'SF: Detected 25Q128 with page size 256 Bytes\r\n' });
  assert.equal(t.last().question.enabled, true);
  assert.equal(t.last().canContinue, false);
  t.control.answer('eth0');
  assert.equal(t.last().question.chosen, 'eth0');
  assert.match(t.last().hint, /network port/);
  assert.equal(t.last().canContinue, false);
  t.control.answer('25Q128');
  assert.equal(t.last().canContinue, true);
  assert.match(t.entries('say').at(-1)[1], /Correct\. 25Q128 is a 16 MiB SPI flash chip/);
  t.control.answer('something else');
  assert.equal(t.last().question.chosen, '25Q128', 'a value that is not a choice changes nothing');
});

test('other steps have no question, and a new start clears the answer', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  await t.control.start({ resume: true });
  t.live(withJ4('J4'));
  await tick();
  t.control.noteConsole(sessionMsg());
  t.control.noteConsole({ kind: 'data', text: 'SF: Detected 25Q128 with page size 256 Bytes\r\n' });
  t.control.answer('25Q128');
  await t.control.leave();
  await t.control.start({ restart: true, resume: true });
  t.live(withJ4('J4'));
  await tick();
  assert.equal(t.last().question.chosen, null);
  await t.control.leave();
  const other = setup({ settings: { tutorial: 'started', tutorialStep: 11 } });
  await other.control.start({ resume: true });
  other.live(withJ4('J4'));
  await tick();
  assert.equal(other.last().question, null);
});

// Console results survive a reload (spec 22).
const serialCapture = (n, baud = 115200, extra = {}) => ({ id: `cap_${n}`, kind: 'serial', baud, path: `captures/serial/${n}.log`, ...extra });
const texts = (map) => async (path) => new Blob([map[path] ?? '']);

async function resumeWith(captures, read, { step = 14, extraHooks = {} } = {}) {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: step } });
  const reads = [];
  t.hooks.readCapture = async (path) => { reads.push(path); return read(path); };
  Object.assign(t.hooks, extraHooks);
  await t.control.start({ resume: true });
  t.live({ ...withJ4('J4'), captures });
  await tick(); await tick(); await tick();
  return { t, reads };
}

test('a resume reads the board\'s console recordings back, so the tasks and the finish page keep what was done', async () => {
  const files = { 'captures/serial/1.log': rec.noise9600, 'captures/serial/2.log': rec.ranCommand.join('') };
  const { t, reads } = await resumeWith([serialCapture(1, 9600), serialCapture(2)], texts(files));
  assert.deepEqual(reads, ['captures/serial/1.log', 'captures/serial/2.log']);
  assert.equal(t.last().step, 14);
  assert.equal(t.last().tasks.every((task) => task.done), true, 'step 14 has its tasks ticked');
  t.state.settings = { ...t.state.settings, tutorialStep: 18 };
  await t.control.leave();
  const done = setup({ settings: { tutorial: 'started', tutorialStep: 18 } });
  done.hooks.readCapture = texts(files);
  await done.control.start({ resume: true });
  done.live({ ...withJ4('J4'), captures: [serialCapture(1, 9600), serialCapture(2)] });
  await tick(); await tick(); await tick();
  done.control.noteExport();
  await done.control.next();
  const lines = done.last().lines.join('\n');
  assert.match(lines, /read the U-Boot banner/);
  assert.match(lines, /printenv/);
  assert.match(lines, /ran a command in the shell/);
});

test('only serial recordings with a speed and a path inside captures/ are read, and a failing read is skipped', async () => {
  const files = { 'captures/serial/ok.log': rec.boot.join('') };
  const captures = [
    { id: 'l', kind: 'logic', baud: 115200, path: 'captures/logic/x.sr' },
    { id: 'sh', kind: 'shell', baud: 115200, path: 'captures/shell/x.log' },
    serialCapture('nobaud', 1, { baud: undefined }), serialCapture('zero', 0), serialCapture('frac', 11.5), serialCapture('str', '115200'),
    serialCapture('out', 115200, { path: 'assets/photo.png' }), serialCapture('up', 115200, { path: 'captures/../secrets.txt' }),
    serialCapture('broken', 115200, { path: 'captures/serial/broken.log' }),
    { id: 'ok', kind: 'serial', baud: 115200, path: 'captures/serial/ok.log' },
  ];
  const { t, reads } = await resumeWith(captures, async (path) => { if (path.includes('broken')) throw new Error('gone'); return new Blob([files[path] ?? '']); });
  assert.deepEqual(reads, ['captures/serial/broken.log', 'captures/serial/ok.log']);
  assert.equal(t.entries('failed').length, 0, 'a failing read is not shown to the person');
  t.control.noteConsole({ kind: 'baud', value: 115200 });
  assert.equal(t.last().tasks.length, 2);
});

test('at most the newest 20 recordings are read, and only the first 256 KiB of each', async () => {
  const many = Array.from({ length: 25 }, (_, n) => serialCapture(n + 1));
  const sizes = [];
  const { reads } = await resumeWith(many, async () => {
    const blob = new Blob(['U-Boot 2015.07-ARC (x)\r\n'.padEnd(300000, ' ')]);
    return { slice: (a, b) => { sizes.push([a, b]); return blob.slice(a, b); } };
  });
  assert.equal(reads.length, 20);
  assert.equal(reads[0], 'captures/serial/6.log');
  assert.equal(reads.at(-1), 'captures/serial/25.log');
  assert.deepEqual(sizes[0], [0, 262144]);
});

test('a recording read that finishes after leaving, or after a new start, is dropped', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  let release;
  t.hooks.readCapture = () => new Promise((resolve) => { release = () => resolve(new Blob([rec.boot.join('')])); });
  await t.control.start({ resume: true });
  t.live({ ...withJ4('J4'), captures: [serialCapture(1)] });
  await tick();
  await t.control.leave();
  await t.control.start({ restart: true, resume: true });
  release();
  await tick(); await tick();
  assert.equal(t.last().tasks[0].done, false, 'the earlier run\'s recording does not reach the new one');
});

// Leaving never waits long (spec 22).
test('leaving and finishing give up on a service that does not answer after three seconds', async () => {
  const never = () => new Promise(() => {});
  for (const way of ['leave', 'finish']) {
    const t = setup({ settings: { tutorial: 'started', tutorialStep: 18 } });
    t.hooks.closeSerial = never;
    t.hooks.stopVdev = never;
    await t.control.start({ resume: true });
    t.live(withJ4('J4'));
    await tick();
    t.control.vdevStarted();
    t.control.noteConsole(sessionMsg());
    t.control.noteExport();
    let done = false;
    const run = (way === 'leave' ? t.control.leave() : (async () => { await t.control.next(); })()).then(() => { done = true; });
    await tick(); await tick();
    assert.equal(done, false, `${way} is still waiting`);
    const timer = t.timers.items.find((item) => item.ms === 3000);
    assert.ok(timer, `${way} sets one timer of 3000 ms`);
    timer.fn();
    await run;
    if (way === 'leave') assert.equal(t.entries('closed').length, 1);
    else assert.equal(t.last().complete, true);
  }
});

test('a cleanup that finishes first clears its timer', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 12 } });
  await t.control.start({ resume: true });
  t.control.noteConsole(sessionMsg());
  await t.control.leave();
  const timer = t.timers.items.find((item) => item.ms === 3000);
  assert.equal(timer.cleared, true);
});

test('the step model carries the lesson\'s example exchange', async () => {
  const t = setup({ settings: { tutorial: 'started', tutorialStep: 3 } });
  await t.control.start({ resume: true });
  t.live(blank());
  await tick();
  assert.ok(lesson(3).example.question);
  assert.deepEqual(t.last().example, lesson(3).example);
});
