import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clock, describeEvent, describeReadings, statusLabel, summarize } from '../js/viewmodel.js';

test('every event type the service can write has a readable description', () => {
  const cases = [
    [{ type: 'project/created', project: { meta: { name: 'Nimbus' } } }, 'Board created: Nimbus'],
    [{ type: 'project/replaced' }, 'File edited outside the service. The edit was kept.'],
    [{ type: 'project/metaUpdated', patch: { name: 'x', device: 'y' } }, 'Board details changed: name, device'],
    [{ type: 'asset/added', asset: { label: 'Front', path: 'assets/a.jpg' } }, 'Photo added: Front'],
    [{ type: 'asset/added', asset: { path: 'assets/a.jpg' } }, 'Photo added: assets/a.jpg'],
    [{ type: 'asset/updated', id: 'img_a' }, 'Photo changed: img_a'],
    [{ type: 'asset/removed', id: 'img_a' }, 'Photo removed: img_a'],
    [{ type: 'marker/added', marker: { label: 'J1' } }, 'Marker added: J1'],
    [{ type: 'marker/added', marker: {} }, 'Marker added'],
    [{ type: 'marker/updated', id: 'mk_a' }, 'Marker changed: mk_a'],
    [{ type: 'marker/removed', id: 'mk_a' }, 'Marker removed: mk_a'],
    [{ type: 'schematic/updated', id: 'sch_a' }, 'Header changed: sch_a'],
    [{ type: 'pin/updated', index: 3, patch: { role: 'TX' } }, 'Pin 3 set to TX'],
    [{ type: 'pin/updated', index: 3, patch: { note: 'n' } }, 'Pin 3 note changed'],
    [{ type: 'pin/updated', index: 3, patch: { label: 'L' } }, 'Pin 3 set'],
    [{ type: 'pin/updated', index: 2, patch: { readings: [{ text: '0.3 Ω' }, { text: '3.29 V' }] } }, 'Pin 2 reading: 3.29 V'],
    [{ type: 'pin/updated', index: 3, patch: null }, 'Pin 3 cleared'],
    [{ type: 'components/replaced', components: [{}, {}] }, 'Components replaced (2)'],
    [{ type: 'capture/stopped', id: 'c', patch: { bytes: 684, kind: 'shell' } }, 'Shell session ended, 684 bytes captured'],
    [{ type: 'project/metaUpdated', patch: { mode: 'expert' } }, 'Mode: Expert'],
    [{ type: 'playbook/updated', playbookId: 'find-uart', stepId: 'ground', patch: { done: 't' } }, 'Step done: find-uart / ground'],
    [{ type: 'playbook/updated', playbookId: 'find-uart', stepId: 'ground', patch: { done: null } }, 'Step reopened: find-uart / ground'],
    [{ type: 'playbook/updated', playbookId: 'find-uart', stepId: 'ground', patch: { gates: {} } }, 'Safety points updated: find-uart / ground'],
    [{ type: 'playbook/updated', playbookId: 'p', stepId: 's', patch: { answers: {} } }, 'Answer saved: p / s'],
    [{ type: 'playbook/updated', playbookId: 'p', patch: {} }, 'Playbook progress: p'],
  ];
  for (const [event, expected] of cases) assert.equal(describeEvent(event), expected);
});

test('descriptions never throw, whatever an event contains', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { type: 'asset/added' }, { type: 'pin/updated' },
    { type: 'project/metaUpdated', patch: 5 }, { type: 'components/replaced', components: 'no' }, { type: 12 }]) {
    assert.doesNotThrow(() => describeEvent(bad));
    assert.equal(typeof describeEvent(bad), 'string');
  }
  assert.equal(describeEvent({ type: 'nope' }), 'Unknown change: nope');
});

test('long text from boards is shortened so one entry cannot flood the feed', () => {
  const text = describeEvent({ type: 'asset/added', asset: { label: 'x'.repeat(5000) } });
  assert.ok(text.length < 80, `got ${text.length} characters`);
});

test('summary counts use singular and plural and tolerate a missing project', () => {
  assert.equal(summarize(null), null);
  const project = { meta: { name: 'Nimbus', device: 'Acme' }, assets: [{}], markers: [{}, {}], schematics: [], components: [] };
  const summary = summarize(project);
  assert.equal(summary.name, 'Nimbus');
  assert.deepEqual(summary.counts.map((c) => `${c.n} ${c.label}`), ['1 photo', '2 markers', '0 headers', '0 components']);
  assert.equal(summarize({ meta: {} }).name, 'Untitled board');
  assert.deepEqual(summarize({ meta: {} }).counts.map((c) => c.n), [0, 0, 0, 0]);
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
