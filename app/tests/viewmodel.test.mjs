import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chipModel, clock, describeReadings, statusLabel, summarize } from '../js/viewmodel.js';

test('the summary tolerates a missing project and fills in the defaults', () => {
  assert.equal(summarize(null), null);
  const project = { meta: { name: 'Nimbus', device: 'Acme' } };
  const summary = summarize(project);
  assert.equal(summary.name, 'Nimbus');
  assert.equal(summarize({ meta: {} }).name, 'Untitled board');
});

test('status and clock helpers have sane fallbacks', () => {
  assert.equal(statusLabel('live'), 'Live');
  assert.equal(statusLabel('something-new'), 'Unknown');
  assert.equal(clock('not a date'), 'not a date');
  assert.match(clock('2026-10-25T16:02:11.482Z'), /^\d\d:\d\d:\d\d$/);
});

test('readings are listed newest first with power state and source', () => {
  const pin = { readings: [
    { ts: '2026-10-25T10:00:00Z', text: '0.3 Ω', powered: false, source: 'cli' },
    { ts: '2026-10-25T10:05:00Z', text: '3.29 V', powered: true, source: 'cli' },
  ] };
  const lines = describeReadings(pin);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^3\.29 V · powered · \d\d:\d\d:\d\d · via cli$/);
  assert.match(lines[1], /^0\.3 Ω · unpowered/);
  assert.deepEqual(describeReadings({}), []);
  assert.deepEqual(describeReadings({ readings: [null, 7] }).length, 2);   // junk does not throw
});

test('the chip shows the connection before the save state', () => {
  const save = { pending: 1, at: null, error: 'x' };
  assert.deepEqual(chipModel({ status: 'idle', error: null, save }), { text: 'Not connected', state: 'idle', title: '' });
  assert.deepEqual(chipModel({ status: 'rejected', error: { message: 'Refused.' }, save }), { text: 'Refused', state: 'rejected', title: 'Refused.' });
  assert.equal(chipModel({ status: 'connecting', error: null, save }).text, 'Connecting');
  assert.equal(chipModel({ status: 'reconnecting', error: null, save }).text, 'Reconnecting');
  assert.equal(chipModel({ status: 'closed', error: null, save }).text, 'Closed');
});

test('the chip on a live board: saving, not saved, saved with the time, saved', () => {
  const live = (save) => ({ status: 'live', error: null, save });
  const at = new Date(2026, 10, 5, 8, 6).getTime();
  assert.deepEqual(chipModel(live({ pending: 1, at, error: null }), true), { text: 'Saving', state: 'saving', title: '' });
  assert.equal(chipModel(live({ pending: 1, at, error: null }), false).text, 'Saved 08:06', 'a short write does not flicker');
  assert.deepEqual(chipModel(live({ pending: 0, at, error: 'Disk full.' })), { text: 'Not saved', state: 'unsaved', title: 'Disk full.' });
  assert.deepEqual(chipModel(live({ pending: 0, at, error: null })), { text: 'Saved 08:06', state: 'saved', title: 'Every change is saved in the board folder.' });
  assert.equal(chipModel(live({ pending: 0, at: null, error: null })).text, 'Saved');
  assert.equal(chipModel({ status: 'live', error: null }).text, 'Saved');
});
