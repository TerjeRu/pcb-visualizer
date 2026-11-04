import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTimeline, byDay, describe } from '../js/core/timeline.js';

const project = {
  meta: { name: 'B' },
  markers: [{ id: 'mk_1', schematicId: 'sch_1', label: 'J4' }],
  schematics: [{ id: 'sch_1', name: 'UART' }],
  captures: [{ id: 'cap_1', path: 'captures/serial/a.log' }],
};
const playbooks = [{ id: 'find-uart', title: 'Find the UART', steps: [{ id: 'ground', title: 'Find ground' }] }];
const ev = (seq, type, extra = {}, ts = `2026-10-25T10:${String(seq).padStart(2, '0')}:00Z`) => ({ seq, ts, actor: 'web', type, ...extra });

test('events become readable entries with jump targets', () => {
  const d = (e) => describe(e, project, playbooks);
  assert.deepEqual(d(ev(1, 'asset/added', { asset: { id: 'img_1', label: 'Front', width: 10, height: 5 } })).target, { kind: 'asset', id: 'img_1' });
  const reading = d(ev(2, 'pin/updated', { schematicId: 'sch_1', index: 2, patch: { readings: [{ text: '0.3 Ω' }, { text: '3.29 V', mode: 'dc', powered: true }] } }));
  assert.equal(reading.kind, 'reading');
  assert.equal(reading.title, 'J4 pin 2: 3.29 V');
  assert.equal(reading.detail, 'dc, powered');
  assert.equal(d(ev(3, 'pin/updated', { schematicId: 'sch_1', index: 4, patch: { role: 'GND', color: '#000' } })).title, 'J4 pin 4 is GND');
  const step = d(ev(4, 'playbook/updated', { playbookId: 'find-uart', stepId: 'ground', patch: { done: 't' } }));
  assert.equal(step.title, 'Step done: Find the UART: Find ground');
  assert.deepEqual(step.target, { kind: 'playbook', playbookId: 'find-uart', stepId: 'ground' });
  const closed = d(ev(5, 'capture/stopped', { id: 'cap_1', patch: { bytes: 2217, reason: 'port lost: gone' } }));
  assert.equal(closed.title, 'Console closed, 2.2 kB captured (port lost: gone)');
  assert.deepEqual(closed.target, { kind: 'capture', id: 'cap_1', path: 'captures/serial/a.log' });
});

test('noise is left out', () => {
  assert.equal(describe(ev(1, 'marker/updated', { id: 'mk_1', patch: { x: 1, y: 2 } }), project), null);
  assert.equal(describe(ev(2, 'playbook/updated', { playbookId: 'p', stepId: 's', patch: { gates: { a: true } } }), project), null);
  assert.equal(describe(ev(3, 'something/new'), project), null);
});

test('commits merge in by time, newest first, and days group entries', () => {
  const entries = buildTimeline({
    events: [ev(1, 'project/created', { project: { meta: { name: 'B' } } }), ev(2, 'asset/added', { asset: { id: 'i' } })],
    project,
    commits: [{ hash: 'abcdef1234567890', date: '2026-10-25T10:01:30Z', subject: 'Sync b (+1 events)' }],
  });
  assert.deepEqual(entries.map((e) => e.kind), ['photo', 'commit', 'board']);
  assert.equal(entries[1].detail, 'abcdef1234');
  const days = byDay([...entries, { kind: 'board', ts: '2026-10-24T09:00:00Z', title: 'older' }]);
  assert.equal(days.length, 2);
});

test('junk never throws', () => {
  for (const junk of [null, 5, 'x', {}, { type: 'pin/updated' }, { type: 'capture/started' }, { type: 'playbook/updated', patch: null }]) describe(junk, null, null);
  assert.deepEqual(buildTimeline({ events: [null, {}], commits: [null, 3] }), []);
});

test('shell sessions are named as such', () => {
  const shellProject = { captures: [{ id: 'cap_s', kind: 'shell', path: 'captures/shell/s.log' }] };
  const started = describe({ seq: 1, ts: 't', type: 'capture/started', capture: { id: 'cap_s', kind: 'shell', label: 'pcbv shell', path: 'captures/shell/s.log' } }, shellProject);
  assert.equal(started.title, 'Shell session started: pcbv shell');
  const ended = describe({ seq: 2, ts: 't', type: 'capture/stopped', id: 'cap_s', patch: { bytes: 802 } }, shellProject);
  assert.equal(ended.title, 'Shell session ended, 802 bytes captured');
  assert.deepEqual(ended.target, { kind: 'capture', id: 'cap_s', path: 'captures/shell/s.log' });
});

test('AI guesses say they are guesses, with their grade and evidence', () => {
  const pin = describe({ seq: 1, ts: '2026-10-26T10:00:00Z', actor: 'web', type: 'pin/updated', schematicId: 'sch_1', index: 2,
    patch: { guess: { role: 'TX', confidence: 'low', evidence: 'Next to the SoC' } } }, project);
  assert.equal(pin.title, 'J4 pin 2: AI guess TX (low)');
  assert.equal(pin.detail, 'Next to the SoC');
  const label = describe({ seq: 2, ts: '2026-10-26T10:00:00Z', actor: 'web', type: 'annotation/added',
    annotation: { id: 'an_1', text: 'U3: flash', guess: { confidence: 'high', evidence: 'Marking legible' } } }, project);
  assert.equal(label.title, 'AI guess: U3: flash (high)');
  const checked = describe({ seq: 3, ts: '2026-10-26T10:00:00Z', actor: 'web', type: 'annotation/updated', id: 'an_1', patch: { guess: null } }, project);
  assert.equal(checked.title, 'Callout checked');
});
