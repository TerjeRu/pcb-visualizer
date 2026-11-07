import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentStep, evaluateCheck, missingRequirements, playbookFinished, stepState } from '../js/core/checks.js';

const board = (extra = {}) => ({
  meta: { name: 'B', device: '' },
  assets: [{ id: 'img_1', side: 'front' }],
  markers: [{ id: 'mk_1', assetId: 'img_1', schematicId: 'sch_1', label: 'J4' }],
  schematics: [{ id: 'sch_1', name: 'UART', rows: 1, cols: 4, pins: [] }],
  components: [],
  ...extra,
});
const withPins = (pins) => board({ schematics: [{ id: 'sch_1', name: 'UART', rows: 1, cols: 4, pins }] });

test('photo, meta and marker checks', () => {
  assert.equal(evaluateCheck({ kind: 'photos', side: 'front' }, board()).ok, true);
  assert.deepEqual(evaluateCheck({ kind: 'photos', side: 'back' }, board()), { ok: false, detail: '0 of 1' });
  assert.equal(evaluateCheck({ kind: 'meta', field: 'device' }, board()).ok, false);
  assert.equal(evaluateCheck({ kind: 'meta', field: 'device' }, board({ meta: { device: ' N100 ' } })).detail, 'N100');
  assert.equal(evaluateCheck({ kind: 'markers', min: 2 }, board()).ok, false);
});

test('the photograph step is done with two photos of any kind, side or none', () => {
  const two = board({ assets: [{ id: 'img_1', label: 'Front' }, { id: 'img_2', label: 'Photo 2' }] });
  assert.deepEqual(evaluateCheck({ kind: 'photos', min: 2 }, two), { ok: true, detail: '2 of 2' });
  assert.deepEqual(evaluateCheck({ kind: 'photos', min: 2 }, board()), { ok: false, detail: '1 of 2' });
  assert.equal(evaluateCheck({ kind: 'photos', side: 'back', min: 1 }, two).ok, false, 'a custom playbook can still ask for a side');
});

test('pin roles name the header by its silkscreen label', () => {
  const p = withPins([{ index: 4, role: 'GND' }]);
  assert.deepEqual(evaluateCheck({ kind: 'pin_role', roles: ['GND'] }, p), { ok: true, detail: 'J4 pin 4' });
  assert.equal(evaluateCheck({ kind: 'pin_role', roles: ['TX'] }, p).ok, false);
});

test('reading checks filter by mode, power, range, role and distinct pins', () => {
  const gnd = { mode: 'ohm', value: 0.3, powered: false, text: '0.3 Ω' };
  const volts = (v) => ({ mode: 'dc', value: v, powered: true, text: `${v} V` });
  const p = withPins([
    { index: 1, role: '3V3', readings: [volts(3.31), volts(3.3)] },
    { index: 4, role: 'GND', readings: [gnd] },
  ]);
  const ground = { kind: 'reading', mode: ['continuity', 'ohm'], powered: false, max: 2, role: 'GND' };
  assert.deepEqual(evaluateCheck(ground, p), { ok: true, detail: 'J4 pin 4: 0.3 Ω' });
  assert.equal(evaluateCheck({ ...ground, powered: true }, p).ok, false);
  assert.equal(evaluateCheck({ ...ground, role: 'TX' }, p).ok, false);
  // two readings on one pin count once
  assert.deepEqual(evaluateCheck({ kind: 'reading', mode: ['dc'], powered: true, count: 2 }, p), { ok: false, detail: '1 of 2 pins' });
  // OL has no value, so it cannot satisfy a max
  const open = withPins([{ index: 4, role: 'GND', readings: [{ mode: 'ohm', value: null, powered: false, text: 'OL' }] }]);
  assert.equal(evaluateCheck(ground, open).ok, false);
});

test('uart_header needs GND, TX and RX on the same header', () => {
  assert.equal(evaluateCheck({ kind: 'uart_header' }, withPins([{ index: 1, role: 'GND' }, { index: 2, role: 'TX' }])).ok, false);
  const p = withPins([{ index: 1, role: 'GND' }, { index: 2, role: 'TX' }, { index: 3, role: 'RX' }]);
  assert.deepEqual(evaluateCheck({ kind: 'uart_header' }, p), { ok: true, detail: 'J4' });
});

test('junk never throws', () => {
  for (const check of [null, {}, { kind: 'nope' }, { kind: 'pin_role' }, { kind: 'reading', mode: 'dc' }]) {
    assert.equal(typeof evaluateCheck(check, board()).ok, 'boolean');
  }
  assert.equal(evaluateCheck({ kind: 'photos' }, null).ok, false);
  const weird = withPins([{ index: 1, readings: [null, 'x', { mode: 'dc' }] }]);
  assert.equal(evaluateCheck({ kind: 'reading', mode: ['dc'], min: 1 }, weird).ok, false);
});

const playbook = {
  id: 'pb',
  steps: [
    { id: 'a', gates: [{ id: 'safe', text: 'Safe', destructive: false }], ask: [{ id: 'q', label: 'Q', required: true }],
      checks: [{ kind: 'meta', field: 'device', text: 'device' }] },
    { id: 'b', gates: [{ id: 'erase', text: 'Erase', destructive: true }], ask: [], checks: [] },
  ],
};
const progress = (steps) => ({ playbooks: { pb: { steps } } });

test('guided: a step needs gates, answers and checks; later steps stay locked', () => {
  let s = stepState(playbook, 0, board());
  assert.equal(s.canComplete, false);
  assert.deepEqual(s.blockers, ['Confirm the safety points.', 'Answer the questions.', 'Some checks do not pass yet.']);
  assert.equal(stepState(playbook, 1, board()).open, false);

  const ready = board({ meta: { device: 'X' }, ...progress({ a: { gates: { safe: true }, answers: { q: 'yes' } } }) });
  s = stepState(playbook, 0, ready);
  assert.equal(s.canComplete, true);
  assert.deepEqual(s.blockers, []);

  const done = board({ meta: { device: 'X' }, ...progress({ a: { done: 't' } }) });
  assert.equal(stepState(playbook, 0, done).canComplete, false, 'a done step cannot be completed again');
  assert.equal(stepState(playbook, 1, done).open, true);
  assert.equal(currentStep(playbook, done), 1);
});

test('expert: everything is open, failing checks are the only warning, destructive gates still block', () => {
  const s = stepState(playbook, 0, board(), 'expert');
  assert.equal(s.canComplete, true);
  assert.deepEqual(s.warnings, ['Some checks do not pass.']);
  const destructive = stepState(playbook, 1, board(), 'expert');
  assert.equal(destructive.open, true);
  assert.equal(destructive.canComplete, false);
  assert.deepEqual(destructive.blockers, ['Confirm the destructive-action points.']);
  const ticked = stepState(playbook, 1, board(progress({ b: { gates: { erase: true } } })), 'expert');
  assert.equal(ticked.canComplete, true);
});

test('finished playbooks and missing requirements', () => {
  const done = board(progress({ a: { done: 't' }, b: { done: 't' } }));
  assert.equal(playbookFinished(playbook, done.playbooks.pb), true);
  assert.equal(currentStep(playbook, done), 1, 'when all are done the last step is shown');
  const second = { id: 'two', requires: ['pb', 'unknown'], steps: [] };
  assert.deepEqual(missingRequirements(second, [playbook, second], board()), ['pb']);
  assert.deepEqual(missingRequirements(second, [playbook, second], done), []);
});

test('logic checks read what was decoded and compared on an imported capture', () => {
  const d0 = { channel: 0, name: 'D0', baud: 115200, bytes: 4200, errors: 0, seen: ['bootloader', 'autoboot'] };
  const serial = { id: 'cap_1', kind: 'serial', baud: 115200, bytes: 5000, seen: ['bootloader', 'kernel'] };
  const logic = { id: 'cap_2', kind: 'logic', label: 'boot.sr', decoded: [d0], compare: { channel: 0, with: 'cap_1', ratio: 0.97 } };
  const p = board({ captures: [serial, logic] });
  assert.deepEqual(evaluateCheck({ kind: 'logic' }, board()), { ok: false, detail: 'no logic capture yet' });
  assert.equal(evaluateCheck({ kind: 'logic' }, board({ captures: [serial] })).ok, false, 'a console session is not a logic capture');
  assert.equal(evaluateCheck({ kind: 'logic' }, p).ok, true, 'any imported capture passes with no parameters');

  assert.match(evaluateCheck({ kind: 'logic', decoded: true, seen_any: ['bootloader', 'kernel'] }, p).detail, /boot\.sr: D0 at 115200 baud, 4200 bytes/);
  const missing = evaluateCheck({ kind: 'logic', seen: ['kernel'] }, p);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /latest capture decoded D0 at 115200 baud, saw bootloader, autoboot countdown/);
  assert.equal(evaluateCheck({ kind: 'logic', baud: 9600 }, p).ok, false);
  assert.equal(evaluateCheck({ kind: 'logic', min_bytes: 10000 }, p).ok, false);

  const matched = evaluateCheck({ kind: 'logic', compared: true, min_ratio: 0.9 }, p);
  assert.equal(matched.ok, true);
  assert.match(matched.detail, /97% the same as the console capture/);
  assert.deepEqual(evaluateCheck({ kind: 'logic', min_ratio: 0.99 }, p), { ok: false, detail: 'latest comparison is 97% the same' });

  const notCompared = board({ captures: [{ ...logic, compare: undefined }] });
  assert.deepEqual(evaluateCheck({ kind: 'logic', compared: true }, notCompared), { ok: false, detail: 'decoded, not compared with a console capture yet' });
  const notDecoded = board({ captures: [{ id: 'cap_3', kind: 'logic', label: 'raw.sr' }] });
  assert.equal(evaluateCheck({ kind: 'logic' }, notDecoded).ok, true);
  assert.deepEqual(evaluateCheck({ kind: 'logic', decoded: true }, notDecoded), { ok: false, detail: 'latest capture has nothing decoded yet' });

  // The comparison has to belong to the channel that matched the other conditions.
  const d1 = { channel: 1, name: 'D1', baud: 115200, bytes: 90, errors: 0, seen: [] };
  const split = board({ captures: [{ ...logic, decoded: [d0, d1], compare: { channel: 1, with: 'cap_1', ratio: 1 } }] });
  assert.equal(evaluateCheck({ kind: 'logic', seen: ['bootloader'], compared: true }, split).ok, false);
  assert.equal(evaluateCheck({ kind: 'logic', decoded: true, compared: true }, split).ok, true);
});

test('capture checks look at what console sessions recognised', () => {
  const p = board({ captures: [
    { id: 'cap_1', baud: 9600, bytes: 900, seen: [] },
    { id: 'cap_2', baud: 115200, bytes: 5000, seen: ['bootloader', 'autoboot', 'uboot-prompt', 'env'] },
  ] });
  assert.equal(evaluateCheck({ kind: 'capture', seen_any: ['bootloader', 'kernel'] }, p).ok, true);
  assert.match(evaluateCheck({ kind: 'capture', seen: ['env'] }, p).detail, /115200 baud, saw bootloader/);
  const missing = evaluateCheck({ kind: 'capture', seen: ['kernel'] }, p);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /latest console capture saw bootloader, autoboot countdown/);
  assert.equal(evaluateCheck({ kind: 'capture', seen_any: ['env'], baud: 9600 }, p).ok, false);
  assert.equal(evaluateCheck({ kind: 'capture', seen: ['env'], min_bytes: 10000 }, p).ok, false);
  assert.deepEqual(evaluateCheck({ kind: 'capture', seen: ['env'] }, board()), { ok: false, detail: 'no console capture yet' });
});

test('currentStep stays at the first step for a playbook without steps', async () => {
  const { currentStep } = await import('../js/core/checks.js');
  assert.equal(currentStep({ id: 'empty', steps: [] }, {}), 0);
});
