import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reduceProject } from '../js/core/apply.js';
import { HISTORY_LIMIT, MAX_BATCH, NOTES_RUN_MS, createHistory, entryFor, inverse, read, sameValues, stillThere, targets } from '../js/core/undo.js';

const schematic = (id, extra = {}) => ({ id, kind: 'header', name: 'Header', rows: 1, cols: 4, pitch: 2.54, numbering: 'row', rotation: 0, notes: '', pins: [], ...extra });
const marker = (id, assetId, schematicId, extra = {}) => ({ id, assetId, schematicId, shape: 'box', label: '', color: '#f59e0b', x: 10, y: 20, w: 40, h: 20, ...extra });
const asset = (id) => ({ id, kind: 'image', path: `assets/photos/${id}.jpg`, label: id, width: 1000, height: 800 });
const note = (id, assetId, extra = {}) => ({ id, assetId, x: 5, y: 5, lx: 50, ly: 50, text: id, wiki: '', ...extra });

/** A board with three photos, a header shared by two photos, pins with readings, callouts and playbook progress. */
function board() {
  const events = [
    { type: 'asset/added', asset: asset('img_a') },
    { type: 'asset/added', asset: asset('img_b') },
    { type: 'asset/added', asset: asset('img_c') },
    { type: 'marker/added', marker: marker('mk_1', 'img_b', 'sch_1'), schematic: schematic('sch_1') },
    { type: 'marker/added', marker: marker('mk_2', 'img_a', 'sch_2'), schematic: schematic('sch_2') },
    { type: 'marker/added', marker: marker('mk_3', 'img_b', 'sch_3'), schematic: schematic('sch_3') },
    { type: 'marker/added', marker: marker('mk_4', 'img_c', 'sch_1') },
    { type: 'pin/updated', schematicId: 'sch_1', index: 2, patch: { role: 'TX', color: '#22c55e' } },
    { type: 'pin/readingAdded', schematicId: 'sch_1', index: 2, reading: { mode: 'voltage', value: 3.3, text: '3.3 V' } },
    { type: 'annotation/added', annotation: note('an_1', 'img_b') },
    { type: 'annotation/added', annotation: note('an_2', 'img_a') },
    { type: 'annotation/added', annotation: note('an_3', 'img_b', { guess: { confidence: 'low' } }) },
    { type: 'components/replaced', components: [{ id: 'cmp_1', assetId: 'img_b', x: 1, y: 1, w: 2, h: 2 }, { id: 'cmp_2', assetId: 'img_a', x: 1, y: 1, w: 2, h: 2 }] },
    { type: 'playbook/updated', playbookId: 'uart', stepId: 'find', patch: { done: true } },
  ];
  const start = { format: 'pcb-visualizer-project', schemaVersion: 2, meta: { id: 'prj_1', name: 'Nimbus', notes: 'old notes', created: 't', modified: 't' }, assets: [], markers: [], schematics: [], components: [] };
  return events.reduce(reduceProject, start);
}

const CHANGES = {
  'name and a new device': { type: 'project/metaUpdated', patch: { name: 'Nimbus N100', device: 'router' } },
  notes: { type: 'project/metaUpdated', patch: { notes: 'new notes' } },
  'photo label': { type: 'asset/updated', id: 'img_b', patch: { label: 'Back' } },
  'photo rotation fields': { type: 'asset/updated', id: 'img_b', patch: { path: 'assets/photos/img_b-1.jpg', width: 800, height: 1000, rotation: 90 } },
  'photo added': { type: 'asset/added', asset: asset('img_d') },
  'middle photo removed': { type: 'asset/removed', id: 'img_b' },
  'first photo removed': { type: 'asset/removed', id: 'img_a' },
  'header marked': { type: 'marker/added', marker: marker('mk_9', 'img_c', 'sch_9'), schematic: schematic('sch_9') },
  'marker moved': { type: 'marker/updated', id: 'mk_1', patch: { x: 99, y: 98 } },
  'marker gets a new key': { type: 'marker/updated', id: 'mk_1', patch: { width: 3 } },
  'marker removed with its header': { type: 'marker/removed', id: 'mk_3' },
  'marker removed, header shared': { type: 'marker/removed', id: 'mk_1' },
  'header grid': { type: 'schematic/updated', id: 'sch_1', patch: { rows: 2, cols: 3, numbering: 'u' } },
  'header gets a new key': { type: 'schematic/updated', id: 'sch_1', patch: { connector: 'JST' } },
  'new pin': { type: 'pin/updated', schematicId: 'sch_1', index: 4, patch: { role: 'GND' } },
  'pin with a reading changed': { type: 'pin/updated', schematicId: 'sch_1', index: 2, patch: { label: 'UART TX' } },
  'pin cleared': { type: 'pin/updated', schematicId: 'sch_1', index: 2, patch: null },
  'reading added': { type: 'pin/readingAdded', schematicId: 'sch_1', index: 2, reading: { mode: 'voltage', value: 0, text: '0 V' } },
  'reading on a new pin': { type: 'pin/readingAdded', schematicId: 'sch_2', index: 1, reading: { mode: 'continuity', text: 'beep' } },
  'callout added': { type: 'annotation/added', annotation: note('an_9', 'img_c') },
  'callout text': { type: 'annotation/updated', id: 'an_1', patch: { text: 'R12' } },
  'callout checked': { type: 'annotation/updated', id: 'an_3', patch: { guess: null } },
  'callout removed': { type: 'annotation/removed', id: 'an_1' },
  'step ticked': { type: 'playbook/updated', playbookId: 'uart', stepId: 'find', patch: { done: false } },
  'first tick of a new playbook': { type: 'playbook/updated', playbookId: 'spi', stepId: 'chip', patch: { done: true, gates: { power: true } } },
  'playbook answers': { type: 'playbook/updated', playbookId: 'uart', patch: { answers: { baud: '115200' } } },
  'components': { type: 'components/replaced', components: [] },
  'rotation batch': {
    type: 'board/batch', events: [
      { type: 'asset/updated', id: 'img_b', patch: { path: 'assets/photos/img_b-2.jpg', width: 800, height: 1000, rotation: 90 } },
      { type: 'marker/updated', id: 'mk_1', patch: { x: 760, y: 10, w: 20, h: 40 } },
      { type: 'schematic/updated', id: 'sch_3', patch: { rotation: 90 } },
      { type: 'annotation/updated', id: 'an_1', patch: { x: 795, y: 5, lx: 750, ly: 50 } },
      { type: 'components/replaced', components: [{ id: 'cmp_1', assetId: 'img_b', x: 797, y: 1, w: 2, h: 2 }] },
    ],
  },
};

// A board that never had callouts or playbook progress gets empty ones back; the app reads both the same.
const settled = (project) => ({ ...project, annotations: project.annotations ?? [], playbooks: project.playbooks ?? {} });

for (const [name, change] of Object.entries(CHANGES)) {
  test(`undo and redo put the board back exactly: ${name}`, () => {
    const before = board();
    const after = reduceProject(before, change);
    assert.ok(!sameValues(after, before), 'the change must change something');
    const back = inverse(change, before);
    const undone = reduceProject(after, back);
    assert.deepEqual(settled(undone), settled(before));
    const redone = reduceProject(undone, inverse(back, after));
    assert.deepEqual(settled(redone), settled(after));
  });
}

test('undo of a photo removal brings back its markers, headers, callouts and components in order', () => {
  const before = board();
  const back = inverse({ type: 'asset/removed', id: 'img_b' }, before);
  assert.equal(back.type, 'board/batch');
  assert.deepEqual(back.events.map((e) => e.type), ['asset/added', 'marker/added', 'marker/added', 'annotation/added', 'annotation/added', 'components/replaced']);
  assert.equal(back.events[0].at, 1);
  // sch_1 is still used by mk_4 on another photo, so only sch_3 comes back with its marker
  assert.equal(back.events[1].schematic, undefined);
  assert.equal(back.events[2].schematic.id, 'sch_3');
});

test('a key the change added is removed by the undo, not set to null', () => {
  const before = board();
  const change = CHANGES['marker gets a new key'];
  assert.deepEqual(inverse(change, before), { type: 'marker/updated', id: 'mk_1', patch: {}, unset: ['width'] });
});

test('events the app does not send cannot be undone', () => {
  assert.equal(inverse({ type: 'capture/started', capture: { id: 'cap_1' } }, board()), null);
  assert.equal(inverse({ type: 'board/batch', events: [{ type: 'capture/updated', id: 'c', patch: {} }] }, board()), null);
});

test('an undo larger than one batch is refused', () => {
  let before = board();
  for (let i = 0; i < MAX_BATCH; i += 1) {
    before = reduceProject(before, { type: 'annotation/added', annotation: note(`an_x${i}`, 'img_c') });
  }
  assert.equal(inverse({ type: 'asset/removed', id: 'img_c' }, before), null);
});

test('targets read only the patched keys, so a change to another field is not a conflict', () => {
  const before = board();
  const change = CHANGES['marker moved'];
  const after = reduceProject(before, change);
  const entry = entryFor(change, before, after, 'Moved');
  assert.ok(stillThere(entry, reduceProject(after, { type: 'marker/updated', id: 'mk_1', patch: { label: 'J1' } })));
  assert.ok(!stillThere(entry, reduceProject(after, { type: 'marker/updated', id: 'mk_1', patch: { x: 1 } })));
});

test('a marker added on a removed photo counts as a change to that photo', () => {
  const before = board();
  const change = CHANGES['photo added'];
  const after = reduceProject(before, change);
  const entry = entryFor(change, before, after, 'Photo added');
  assert.ok(stillThere(entry, after));
  assert.ok(!stillThere(entry, reduceProject(after, { type: 'marker/added', marker: marker('mk_x', 'img_d', 'sch_1') })));
});

test('targets of a batch cover every step', () => {
  const before = board();
  const list = targets(CHANGES['rotation batch'], before);
  assert.deepEqual(list.map((t) => t.kind), ['record', 'record', 'record', 'record', 'components']);
  assert.equal(read(list, before).length, 5);
});

test('sameValues ignores key order and tells arrays from objects', () => {
  assert.ok(sameValues({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!sameValues({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!sameValues([], {}));
  assert.ok(!sameValues(null, {}));
});

function history(clock = { t: 0 }) {
  return { clock, list: createHistory({ now: () => clock.t }) };
}
const entry = (label, extra = {}) => ({ label, back: { type: 'x' }, targets: [], expected: [], notes: false, ...extra });

test('the history undoes the newest change first and a new change clears redo', () => {
  const { list } = history();
  list.changed(entry('one'));
  list.changed(entry('two'));
  assert.deepEqual(list.labels(), { undo: 'two', redo: null });
  list.take('undo');
  list.reversed('undo', entry('two'));
  assert.deepEqual(list.labels(), { undo: 'one', redo: 'two' });
  list.changed(entry('three'));
  assert.deepEqual(list.labels(), { undo: 'three', redo: null });
});

test('the history keeps the newest changes up to its limit', () => {
  const { list } = history();
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) list.changed(entry(`c${i}`));
  let count = 0;
  while (list.peek('undo')) { list.take('undo'); count += 1; }
  assert.equal(count, HISTORY_LIMIT);
});

test('a change that cannot be undone ends the history', () => {
  const { list } = history();
  list.changed(entry('one'));
  list.changed(null);
  assert.equal(list.peek('undo'), null);
});

test('notes saves close together are one change that keeps the oldest undo', () => {
  const { clock, list } = history();
  list.changed(entry('Notes', { notes: true, back: { first: true }, expected: ['a'] }));
  clock.t = NOTES_RUN_MS - 1;
  list.changed(entry('Notes', { notes: true, back: { first: false }, expected: ['ab'] }));
  assert.deepEqual(list.peek('undo').back, { first: true });
  assert.deepEqual(list.peek('undo').expected, ['ab']);
  clock.t += NOTES_RUN_MS;
  list.changed(entry('Notes', { notes: true, expected: ['abc'] }));
  list.take('undo');
  assert.deepEqual(list.peek('undo').expected, ['ab']);
});

test('a change between notes saves starts a new notes entry', () => {
  const { list } = history();
  list.changed(entry('Notes', { notes: true }));
  list.changed(entry('Moved'));
  list.changed(entry('Notes', { notes: true }));
  list.take('undo');
  assert.equal(list.peek('undo').label, 'Moved');
});

test('a photo removal cannot be undone over a later change to another photo\'s components', () => {
  const before = board();
  const change = { type: 'asset/removed', id: 'img_b' };
  const after = reduceProject(before, change);
  const entry = entryFor(change, before, after, 'Photo removed');
  assert.ok(stillThere(entry, after));
  const turned = reduceProject(after, { type: 'components/replaced', components: [{ id: 'cmp_2', assetId: 'img_a', x: 9, y: 9, w: 2, h: 2 }] });
  assert.ok(!stillThere(entry, turned));
});

test('a key named __proto__ comes back as a value, not as a prototype', () => {
  const before = JSON.parse('{"meta":{"name":"N","__proto__":5},"assets":[],"markers":[],"schematics":[],"components":[]}');
  const back = inverse(JSON.parse('{"type":"project/metaUpdated","patch":{"__proto__":7}}'), before);
  assert.ok(Object.hasOwn(back.patch, '__proto__'));
  assert.equal(back.patch.__proto__, 5);
});
