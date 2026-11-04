import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createLogicView } from '../js/logicview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };

const project = () => ({
  captures: [{ id: 'cap_l', kind: 'logic', label: 'Boot', samples: 100000, samplerate: 1e6, duration: 0.1, channels: ['D0', 'D1'], decoded: [] }],
});

function setup(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  doc.getElementById('logic-canvas').getContext = () => null;
  const timers = { sets: [], cleared: [], set(fn, ms) { this.sets.push([fn, ms]); return this.sets.length; }, clear(handle) { this.cleared.push(handle); } };
  const calls = [];
  const view = createLogicView(doc, {
    logicEdges: async (...args) => { calls.push(['edges', ...args]); return { bins: {} }; },
    logicDecode: async () => null,
    logicCompare: async () => null,
    importLogic: async () => null,
    loadCaptureLog: async () => '',
    ...overrides,
  }, timers);
  view.render(project(), true);
  const pointer = (type, x = 0) => doc.getElementById('logic-canvas').dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x }));
  return { doc, view, timers, calls, pointer };
}

test('the waveform fetch uses the injected timer', () => {
  const { timers } = setup();
  assert.equal(timers.sets.length, 1);
  assert.equal(timers.sets[0][1], 80);
});

test('a cancelled pointer ends the pan, so later moves do nothing', () => {
  const { timers, pointer } = setup();
  const before = timers.sets.length;
  pointer('pointerdown', 300);
  pointer('pointermove', 250);
  assert.ok(timers.sets.length > before, 'panning schedules a fetch');
  pointer('pointercancel');
  const after = timers.sets.length;
  pointer('pointermove', 100);
  assert.equal(timers.sets.length, after, 'the pan is over');
});

test('a decode that finishes after a board switch is not shown', async () => {
  const slow = deferred();
  const { doc, view } = setup({ logicDecode: () => slow.promise });
  doc.getElementById('logic-decode').click();
  assert.equal(doc.getElementById('logic-status').textContent, 'Decoding…');
  view.reset();
  assert.equal(doc.getElementById('logic-status').textContent, '');
  slow.resolve({ decoded: { name: 'D0', baud: 115200, bytes: 4, errors: 0 }, preview: 'old board text' });
  await tick();
  assert.equal(doc.getElementById('logic-status').textContent, '');
  assert.doesNotMatch(doc.getElementById('logic-text').textContent, /old board/);
});

test('a waveform failure after a board switch is not reported, and its timer is cancelled', async () => {
  const slow = deferred();
  const { doc, view, timers } = setup({ logicEdges: () => slow.promise });
  timers.sets[0][0]();
  view.reset();
  assert.ok(timers.cleared.length > 0);
  slow.reject(new Error('old board gone'));
  await tick();
  assert.equal(doc.getElementById('logic-status').textContent, '');
});

test('an import that finishes after a board switch is not selected on the new board', async () => {
  const slow = deferred();
  const { doc, view } = setup({ importLogic: () => slow.promise });
  const input = doc.getElementById('logic-file');
  Object.defineProperty(input, 'files', { value: [{ name: 'boot.sr' }] });
  input.dispatchEvent(new doc.defaultView.Event('change'));
  view.reset();
  slow.resolve({ capture: { id: 'cap_old', decoded: [] } });
  await tick();
  assert.equal(doc.getElementById('logic-status').textContent, '');
});

test('the capture import input stays in the tab order inside its labelled button', () => {
  const doc = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' }).window.document;
  const input = doc.getElementById('logic-file');
  assert.equal(input.hasAttribute('hidden'), false);
  assert.ok(input.classList.contains('visually-hidden'));
  assert.equal(input.closest('label.button')?.id, 'logic-import');
});

test('opening a capture is reported, for the tutorial', () => {
  const reports = [];
  setup({ noteLogic: (event) => reports.push(event) });
  assert.deepEqual(reports, [{ open: true }]);
});

test('a board with no logic capture reports nothing open', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const reports = [];
  const view = createLogicView(doc, { noteLogic: (event) => reports.push(event) }, { set: () => 1, clear() {} });
  view.render({ captures: [] }, true);
  assert.deepEqual(reports, []);
});

test('console captures in the compare list say their speed, newest first', () => {
  const { doc, view } = setup();
  const serial = (id, baud, started) => ({ id, kind: 'serial', label: 'Virtual board (pcbv vdev)', baud, started });
  const p = project();
  p.captures.push(serial('cap_a', 9600, '2026-11-02T10:12:05Z'), serial('cap_b', 115200, '2026-11-02T10:14:40Z'));
  p.captures.push({ id: 'cap_s', kind: 'shell', label: 'Shell', started: '2026-11-02T10:15:00Z' });
  p.captures.push({ id: 'cap_n', kind: 'serial', label: 'Old port', started: '2026-11-02T10:16:00Z' });
  view.render(p, true);
  view.focus('cap_l');
  const labels = [...doc.getElementById('logic-compare-with').options].map((o) => o.textContent);
  assert.deepEqual(labels, [
    'Compare with a console capture…',
    'Old port (2026-11-02 10:16)',
    'Shell (2026-11-02 10:15)',
    'Console at 115200 baud (2026-11-02 10:14)',
    'Console at 9600 baud (2026-11-02 10:12)',
  ]);
});

test('a console capture made after the logic capture opened appears in the compare list', () => {
  const { doc, view } = setup();
  const p = project();
  p.captures.push({ id: 'cap_c', kind: 'serial', label: 'Virtual board (pcbv vdev)', baud: 115200, started: '2026-11-02T10:14:40Z' });
  view.render(p, true);
  const labels = [...doc.getElementById('logic-compare-with').options].map((o) => o.textContent);
  assert.deepEqual(labels, ['Compare with a console capture…', 'Console at 115200 baud (2026-11-02 10:14)']);
});
