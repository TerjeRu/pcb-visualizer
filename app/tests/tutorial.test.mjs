import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { LAST_STEP, LESSONS, TOTAL_STEPS, benchSetup, doneTasks, lesson, setupEvents, stepDone, CHAPTERS } from '../js/core/tutorial/lessons.js';
import { J4, buildFacts } from '../js/core/tutorial/facts.js';
import { REFUSED, allowed, allowedAction } from '../js/core/tutorial/policy.js';
import { PANELS, REGIONS, tutorialLayout, normalize } from '../js/core/layout.js';
import { newMarkerEvent } from '../js/core/schema.js';
import { benchFacts, createBench } from '../js/core/tutorial/bench.js';

const asset = { id: 'as_1', width: 1600, height: 1000, path: 'assets/a.png' };
const empty = () => ({ assets: [asset], markers: [], schematics: [] });

/** A project with a box marker at `rect`, built the way the app builds one. */
function withMarker(rect = J4, label = '') {
  const event = newMarkerEvent({ assetId: asset.id, rect, label });
  return { project: { assets: [asset], markers: [event.marker], schematics: [event.schematic] }, event };
}
const setPins = (project, roles) => {
  project.schematics[0].pins = Object.entries(roles).map(([index, role]) => ({ index: Number(index), role }));
  return project;
};

test('there are eighteen steps in five chapters, each with a body of at most three sentences', () => {
  assert.equal(LESSONS.length, TOTAL_STEPS);
  assert.equal(CHAPTERS.length, 5);
  const ids = new Set(LESSONS.map((l) => l.id));
  assert.equal(ids.size, 18);
  for (const l of LESSONS) {
    assert.ok(l.chapter >= 0 && l.chapter < 5, l.id);
    assert.ok(l.body.length >= 1 && l.body.length <= 3, `${l.id} body`);
    assert.ok(l.title && !/[—–]/.test(l.title + l.body.join('') + l.why.join('')), `${l.id} text has no em dash`);
    assert.ok(l.panels.length >= 1);
    assert.equal(typeof l.check, 'function');
  }
  assert.deepEqual(LESSONS.map((l) => l.chapter), [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4]);
  assert.ok(LAST_STEP >= 4 && LAST_STEP <= 18);
});

test('every lesson names a wiki page that exists', () => {
  const pages = new Set(readdirSync(new URL('../../service/src/pcbv/wiki/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  for (const l of LESSONS) assert.ok(pages.has(l.wiki), `${l.id}: ${l.wiki}`);
});

test('every lesson panel is a real panel', () => {
  for (const l of LESSONS) for (const p of l.panels) assert.ok(p in PANELS, `${l.id}: ${p}`);
});

test('step 1 is done at once, with no tasks', () => {
  assert.equal(lesson(1).tasks.length, 0);
  assert.equal(stepDone(1, buildFacts({ project: empty() })), true);
});

test('step 2 is done after one zoom', () => {
  assert.equal(stepDone(2, buildFacts({ project: empty() })), false);
  assert.deepEqual(doneTasks(2, buildFacts({ project: empty(), zoomed: true })), ['zoom']);
  assert.equal(stepDone(2, buildFacts({ project: empty(), zoomed: true })), true);
});

test('step 3 needs a box whose centre lies inside J4, and hints when it is elsewhere', () => {
  assert.equal(stepDone(3, buildFacts({ project: empty() })), false);
  assert.equal(lesson(3).hint(buildFacts({ project: empty() })), '');
  const off = withMarker({ x: 900, y: 100, w: 117, h: 40 }).project;
  assert.equal(stepDone(3, buildFacts({ project: off })), false);
  assert.match(lesson(3).hint(buildFacts({ project: off })), /lower left/);
  assert.equal(stepDone(3, buildFacts({ project: withMarker().project })), true);
  assert.equal(lesson(3).hint(buildFacts({ project: withMarker().project })), '');
  // The centre decides, not the corner: a box much larger than J4 centred on it still counts.
  const wide = withMarker({ x: J4.x - 40, y: J4.y - 30, w: J4.w + 80, h: J4.h + 60 }).project;
  assert.equal(stepDone(3, buildFacts({ project: wide })), true);
  // A point marker is not a box.
  const point = withMarker().project;
  point.markers[0].shape = 'crosshair';
  assert.equal(stepDone(3, buildFacts({ project: point })), false);
});

test('step 4 needs the label J4 and a 1 by 4 grid, with a hint for each mistake', () => {
  const { project } = withMarker();
  const facts = () => buildFacts({ project });
  assert.deepEqual(doneTasks(4, facts()), ['shape']);
  assert.equal(stepDone(4, facts()), false);
  project.markers[0].label = 'J5';
  assert.match(lesson(4).hint(facts()), /silkscreen says J4/);
  project.markers[0].label = 'J4';
  assert.equal(stepDone(4, facts()), true);
  project.schematics[0].rows = 2;
  project.schematics[0].cols = 2;
  assert.deepEqual(doneTasks(4, facts()), ['label']);
  assert.match(lesson(4).hint(facts()), /one row of four pins/);
  assert.equal(lesson(4).target(facts()), 'header-cols');
  project.markers[0].label = '';
  assert.equal(lesson(4).target(facts()), 'marker-label');
});

test('the pin steps check the role of their pin and the ground step allows only one ground', () => {
  const { project } = withMarker(J4, 'J4');
  setPins(project, { 4: 'GND' });
  assert.equal(stepDone(5, buildFacts({ project })), true);
  setPins(project, { 4: 'GND', 1: 'GND' });
  assert.equal(stepDone(5, buildFacts({ project })), false);
  assert.match(lesson(5).hint(buildFacts({ project })), /Only one pin/);
  setPins(project, { 1: '3V3' });
  assert.equal(stepDone(6, buildFacts({ project })), true);
  setPins(project, { 1: 'TX' });
  assert.match(lesson(7).hint(buildFacts({ project })), /steady pin/);
  setPins(project, { 2: 'TX' });
  assert.equal(stepDone(7, buildFacts({ project })), true);
  setPins(project, { 3: 'RX' });
  assert.equal(stepDone(8, buildFacts({ project })), true);
});

test('later steps read the bench and console facts passed in', () => {
  const facts = (extra) => buildFacts({ project: empty(), extra });
  assert.equal(stepDone(9, facts({ wiringCorrect: true })), true);
  assert.match(lesson(9).hint(facts({ adapterVccConnected: true })), /Leave VCC open/);
  assert.match(lesson(9).hint(facts({ adapterTxdOnTx: true })), /TXD must go to the board.s RX/);
  assert.equal(stepDone(10, facts({ portOpen: true, sawGarble: true })), true);
  assert.equal(stepDone(11, facts({ baud: 115200, sawBanner: true })), true);
  assert.match(lesson(11).hint(facts({ baud: 9600, sawBanner: true })), /not 115200/);
  assert.equal(stepDone(12, facts({ sawFlash: true, flashAnswer: '25Q128' })), true);
  assert.match(lesson(13).hint(facts({ typedBeforePrompt: true })), /Wait for the prompt/);
  assert.equal(stepDone(14, facts({ shellPrompt: true, ranShellCommand: true })), true);
  assert.equal(stepDone(15, facts({ captureOpen: true, decoded115200: true })), true);
  assert.equal(stepDone(16, facts({ compareMatches: true })), true);
  assert.equal(stepDone(18, facts({ exported: true })), true);
});

test('step 17 needs a header name other than the default and a note of at least eight characters', () => {
  const { project } = withMarker(J4, 'J4');
  assert.equal(stepDone(17, buildFacts({ project })), false);
  project.schematics[0].name = 'J4 UART';
  project.schematics[0].notes = '1234567';
  assert.deepEqual(doneTasks(17, buildFacts({ project })), ['name']);
  project.schematics[0].notes = '115200 8N1';
  assert.equal(stepDone(17, buildFacts({ project })), true);
  assert.equal(lesson(17).target(buildFacts({ project })), 'header-notes');
});

test('setup gives every step a state its check can start from', () => {
  for (let step = 1; step <= TOTAL_STEPS; step += 1) {
    const project = empty();
    for (const event of setupEvents(step, project)) {
      // Apply the setup events the way the reducer would, for the kinds setup uses.
      if (event.type === 'marker/added') { project.markers.push(event.marker); project.schematics.push(event.schematic); }
      else if (event.type === 'marker/updated') Object.assign(project.markers.find((m) => m.id === event.id), event.patch);
      else if (event.type === 'schematic/updated') Object.assign(project.schematics.find((s) => s.id === event.id), event.patch);
      else if (event.type === 'pin/updated') {
        const sch = project.schematics.find((s) => s.id === event.schematicId);
        sch.pins = [...sch.pins.filter((p) => p.index !== event.index), { index: event.index, ...event.patch }];
      }
    }
    const facts = buildFacts({ project });
    if (step >= 4) assert.ok(facts.header, `step ${step} has the J4 marker`);
    if (step >= 5) assert.equal(facts.label, 'J4');
    if (step >= 5) assert.equal(facts.rows * 10 + facts.cols, 14);
    if (step >= 6) assert.equal(facts.roles[3], 'GND');
    if (step >= 7) assert.equal(facts.roles[0], '3V3');
    if (step >= 8) assert.equal(facts.roles[1], 'TX');
    if (step >= 9) assert.equal(facts.roles[2], 'RX');
    // Steps 1 to 3 start from an untouched board; the others from the finished earlier steps.
    if (step < 4) assert.equal(setupEvents(step, project).length, 0);
  }
});

test('setup adds only what is missing and never touches work that is there', () => {
  const { project } = withMarker(J4, 'J4');
  setPins(project, { 4: 'GND' });
  assert.deepEqual(setupEvents(6, project), []);
  const events = setupEvents(8, project);
  assert.deepEqual(events.map((e) => [e.type, e.index]), [['pin/updated', 1], ['pin/updated', 2]]);
  assert.equal(setupEvents(5, { assets: [], markers: [], schematics: [] }).length, 0);
});

// The policy.
const upd = (type, extra) => ({ type, ...extra });

test('step 1 and 2 refuse every board change', () => {
  const { project, event } = withMarker();
  for (const step of [1, 2]) {
    for (const e of [event, upd('marker/updated', { id: project.markers[0].id, patch: { label: 'x' } }), upd('project/metaUpdated', { patch: { name: 'x' } }),
      upd('marker/removed', { id: project.markers[0].id }), { type: 'asset/added', asset }]) assert.equal(allowed(step, e, project), false, `${step} ${e.type}`);
  }
});

test('step 3 allows one box marker on the photo and moving it, and nothing else', () => {
  const { event } = withMarker();
  assert.equal(allowed(3, event, empty()), true);
  assert.equal(allowed(3, { ...event, marker: { ...event.marker, shape: 'crosshair' } }, empty()), false);
  assert.equal(allowed(3, { ...event, marker: { ...event.marker, assetId: 'as_other' } }, empty()), false);
  const { project } = withMarker();
  assert.equal(allowed(3, event, project), false, 'a second marker');
  const id = project.markers[0].id;
  assert.equal(allowed(3, upd('marker/updated', { id, patch: { x: 5, y: 6, w: 7, h: 8 } }), project), true);
  assert.equal(allowed(3, upd('marker/updated', { id, patch: { label: 'J4' } }), project), false);
  assert.equal(allowed(3, upd('marker/updated', { id, patch: { x: 1, schematicId: 'sch_x' } }), project), false);
  assert.equal(allowed(3, upd('marker/updated', { id: 'mk_none', patch: { x: 1 } }), project), false);
  assert.equal(allowed(3, upd('marker/removed', { id }), project), false);
  assert.equal(allowed(3, upd('schematic/updated', { id: project.schematics[0].id, patch: { rows: 1 } }), project), false);
  assert.equal(allowed(3, upd('project/metaUpdated', { patch: { name: 'x' } }), project), false);
  assert.equal(allowed(3, { type: 'annotation/added', annotation: { id: 'an_1', assetId: asset.id } }, project), false);
});

test('step 4 allows the label, the header name and the grid of J4, and no other header or marker', () => {
  const { project } = withMarker();
  const id = project.markers[0].id;
  const sch = project.schematics[0].id;
  assert.equal(allowed(4, upd('marker/updated', { id, patch: { label: 'J4' } }), project), true);
  assert.equal(allowed(4, upd('marker/updated', { id, patch: { x: 5 } }), project), false);
  assert.equal(allowed(4, upd('marker/updated', { id, patch: { label: 'J4', color: '#fff' } }), project), false);
  assert.equal(allowed(4, upd('schematic/updated', { id: sch, patch: { rows: 2, cols: 2, name: 'x' } }), project), true);
  assert.equal(allowed(4, upd('schematic/updated', { id: sch, patch: { pitch: 2 } }), project), false);
  assert.equal(allowed(4, upd('schematic/updated', { id: sch, patch: { notes: 'x' } }), project), false);
  assert.equal(allowed(4, upd('schematic/updated', { id: 'sch_other', patch: { rows: 2 } }), project), false);
  assert.equal(allowed(4, upd('marker/removed', { id }), project), false);
  assert.equal(allowed(4, upd('pin/updated', { schematicId: sch, index: 1, patch: { role: 'TX' } }), project), false);
  // A second marker on the photo is another header and stays locked.
  const other = newMarkerEvent({ assetId: asset.id, rect: { x: 900, y: 100, w: 100, h: 40 }, label: 'X' });
  project.markers.push(other.marker);
  project.schematics.push(other.schematic);
  assert.equal(allowed(4, upd('marker/updated', { id: other.marker.id, patch: { label: 'J4' } }), project), false);
  assert.equal(allowed(4, upd('schematic/updated', { id: other.schematic.id, patch: { rows: 2 } }), project), false);
});

test('a marker that is not on J4 cannot be edited at step 4', () => {
  const { project } = withMarker({ x: 900, y: 100, w: 100, h: 40 });
  assert.equal(allowed(4, upd('marker/updated', { id: project.markers[0].id, patch: { label: 'J4' } }), project), false);
});

test('chapter 2 allows pin roles and readings on J4 only, chapter 5 the name and notes', () => {
  const { project } = withMarker(J4, 'J4');
  const sch = project.schematics[0].id;
  for (const step of [5, 6, 7, 8]) {
    assert.equal(allowed(step, upd('pin/updated', { schematicId: sch, index: 2, patch: { role: 'TX', color: '#22c55e' } }), project), true, `step ${step}`);
    assert.equal(allowed(step, upd('pin/updated', { schematicId: sch, index: 2, patch: null }), project), true);
    assert.equal(allowed(step, upd('pin/updated', { schematicId: 'sch_other', index: 2, patch: { role: 'TX' } }), project), false);
    assert.equal(allowed(step, upd('pin/updated', { schematicId: sch, index: 2, patch: { guess: {} } }), project), false);
    assert.equal(allowed(step, upd('pin/readingAdded', { schematicId: sch, index: 1, reading: { value: 3.3 } }), project), step <= 7, `reading at step ${step}: the meter is on screen at steps 5 to 7`);
    assert.equal(allowed(step, upd('pin/readingAdded', { schematicId: 'sch_other', index: 1, reading: { value: 3.3 } }), project), false);
    assert.equal(allowed(step, upd('marker/updated', { id: project.markers[0].id, patch: { label: 'x' } }), project), false);
  }
  for (const step of [4, 9, 12, 17, 18]) assert.equal(allowed(step, upd('pin/updated', { schematicId: sch, index: 2, patch: { role: 'TX' } }), project), false, `step ${step}`);
  assert.equal(allowed(17, upd('schematic/updated', { id: sch, patch: { name: 'J4 UART', notes: '115200 8N1' } }), project), true);
  assert.equal(allowed(17, upd('schematic/updated', { id: sch, patch: { rows: 2 } }), project), false);
  assert.equal(allowed(16, upd('schematic/updated', { id: sch, patch: { name: 'x' } }), project), false);
  assert.equal(allowed(5, upd('schematic/updated', { id: sch, patch: { name: 'x' } }), project), false);
});

test('an unknown or malformed event is refused', () => {
  const { project } = withMarker();
  for (const e of [null, undefined, {}, { type: 'constructor/toString' }, { type: '__proto__/x' }, { type: 'nope/x' }, { type: 'marker' }, { type: 'marker/' }, { type: 'board/batch', events: [] }, 'marker/added']) {
    assert.equal(allowed(3, e, project), false);
  }
  assert.equal(allowed(3, { type: 'marker/added', marker: null }, empty()), false);
  assert.equal(typeof REFUSED, 'string');
});

test('actions that are not events are allowed only at their steps', () => {
  assert.equal(allowedAction(10, 'vdev-start'), true);
  assert.equal(allowedAction(9, 'vdev-start'), false);
  assert.equal(allowedAction(13, 'serial-write'), true);
  assert.equal(allowedAction(12, 'serial-write'), false, 'read before you type');
  assert.equal(allowedAction(18, 'export'), true);
  for (const name of ['bench-power', 'bench-mode', 'bench-probe']) {
    assert.deepEqual([4, 5, 6, 7, 8, 9].filter((step) => allowedAction(step, name)), [5, 6, 7], name);
  }
  assert.deepEqual([...Array(18).keys()].map((i) => i + 1).filter((step) => allowedAction(step, 'wire')), [9]);
  assert.equal(allowedAction(17, 'export'), false);
  assert.equal(allowedAction(3, 'upload'), false);
  assert.equal(allowedAction(3, 'nonsense'), false);
  assert.equal(allowedAction(1, 'toString'), false);
});

test('the tutorial layout holds the step panels and the Wiki, and puts everything else away', () => {
  const layout = tutorialLayout(['photo', 'inspector']);
  assert.deepEqual(layout.regions.left, ['inspector']);
  assert.deepEqual(layout.regions.center, ['photo', 'wiki']);
  assert.deepEqual(layout.regions.right, []);
  assert.equal(layout.active.center, 'photo');
  assert.deepEqual(layout.detached, []);
  const placed = new Set([...REGIONS.flatMap((r) => layout.regions[r]), ...layout.away]);
  assert.deepEqual([...placed].sort(), Object.keys(PANELS).sort());
  assert.equal(layout.away.length + 3, Object.keys(PANELS).length);
  assert.deepEqual(normalize(layout).regions, layout.regions, 'normalize leaves it as it is');
  assert.deepEqual(tutorialLayout(['photo']).regions.left, []);
  assert.deepEqual(tutorialLayout(['board']).regions.left, ['board']);
});

// The bench steps (21b).
test('this build offers every step', () => {
  assert.equal(LAST_STEP, TOTAL_STEPS);
});

test('step 5 hints at the three typical mistakes: power on, a second ground, a ground that did not beep', () => {
  const { project } = withMarker(J4, 'J4');
  const facts = (extra) => buildFacts({ project, extra });
  assert.equal(lesson(5).hint(facts({ powered: false, meterMode: 'continuity' })), '');
  assert.match(lesson(5).hint(facts({ powered: true, meterMode: 'continuity' })), /Unplug the board first/);
  assert.equal(lesson(5).hint(facts({ powered: true, meterMode: 'dc' })), '', 'volts on a powered board is fine');
  setPins(project, { 2: 'GND' });
  assert.match(lesson(5).hint(facts({})), /did not beep/);
  assert.equal(stepDone(5, facts({})), false);
  setPins(project, { 4: 'GND', 2: 'GND' });
  assert.match(lesson(5).hint(facts({})), /Only one pin/);
  setPins(project, { 4: 'GND' });
  assert.equal(lesson(5).hint(facts({})), '');
  assert.equal(lesson(5).target(facts({ powered: true })), 'bench-power');
  assert.equal(lesson(5).target(facts({ powered: false })), 'pin-role');
});

test('step 6 explains why pin 2 and pin 3 are not the supply and why an unplugged board reads nothing', () => {
  const { project } = withMarker(J4, 'J4');
  const facts = (extra) => buildFacts({ project, extra });
  assert.equal(lesson(6).hint(facts({ powered: true, meterMode: 'dc' })), '');
  assert.match(lesson(6).hint(facts({ powered: false, meterMode: 'dc' })), /unplugged, so every pin reads 0 V/);
  assert.equal(lesson(6).hint(facts({ powered: false, meterMode: 'continuity' })), '');
  setPins(project, { 2: '3V3' });
  assert.match(lesson(6).hint(facts({ powered: true })), /Pin 2 moves/);
  setPins(project, { 3: '3V3' });
  assert.match(lesson(6).hint(facts({ powered: true })), /3\.28 V/);
  assert.equal(stepDone(6, facts({})), false);
  setPins(project, { 1: '3V3' });
  assert.equal(stepDone(6, facts({})), true);
  assert.equal(lesson(6).hint(facts({ powered: true })), '');
  assert.equal(lesson(6).target(facts({ powered: false })), 'bench-power');
  assert.equal(lesson(6).target(facts({ powered: true })), 'pin-role');
});

test('step 7 points at the power cycle and steps 7 and 8 keep their checks', () => {
  const { project } = withMarker(J4, 'J4');
  assert.equal(lesson(7).target(buildFacts({ project })), 'bench-cycle');
  setPins(project, { 3: 'TX' });
  assert.match(lesson(7).hint(buildFacts({ project })), /flickers while the board boots/);
  assert.equal(stepDone(8, buildFacts({ project })), false);
  assert.equal(lesson(8).bench, null, 'the meter is not on screen at step 8');
});

test('step 9 is done only with RXD on TX, TXD on RX, GND on GND and VCC open', () => {
  const bench = createBench();
  const facts = () => buildFacts({ project: empty(), extra: benchFacts(bench) });
  assert.equal(stepDone(9, facts()), false);
  bench.wire('RXD', 2);
  bench.wire('TXD', 3);
  assert.equal(stepDone(9, facts()), false, 'ground still open');
  bench.wire('GND', 4);
  assert.equal(stepDone(9, facts()), true);
  bench.wire('VCC', 1);
  assert.equal(stepDone(9, facts()), false);
  assert.match(lesson(9).hint(facts()), /Leave VCC open/);
  assert.equal(lesson(9).target(facts()), 'wire-VCC');
});

test('step 9 hints for the straight-through mistake, a wrong receive line and a wrong ground', () => {
  const bench = createBench();
  const facts = () => buildFacts({ project: empty(), extra: benchFacts(bench) });
  assert.equal(lesson(9).hint(facts()), '');
  bench.wire('TXD', 2);
  assert.match(lesson(9).hint(facts()), /TXD must go to the board.s RX/);
  bench.wire('TXD', 3);
  bench.wire('RXD', 1);
  assert.match(lesson(9).hint(facts()), /connect RXD to the board's TX/);
  assert.equal(lesson(9).target(facts()), 'wire-RXD');
  bench.wire('RXD', 2);
  bench.wire('GND', 1);
  assert.match(lesson(9).hint(facts()), /Ground goes to ground/);
  assert.equal(lesson(9).target(facts()), 'wire-GND');
  bench.wire('TXD', null);
  bench.wire('GND', 4);
  assert.equal(lesson(9).target(facts()), 'wire-TXD');
});

test('benchFacts reports power, meter, probe and wiring', () => {
  const bench = createBench();
  bench.setPower(true);
  bench.setMode('dc');
  bench.setProbe(3);
  bench.wire('GND', 4);
  assert.deepEqual(benchFacts(bench), {
    powered: true, meterMode: 'dc', probe: 3, wiring: { VCC: null, TXD: null, RXD: null, GND: 4 }, wiringCorrect: false,
    rxGetsTx: false, txReachesRx: false, grounded: true, adapterVccConnected: false, adapterTxdOnTx: false,
  });
});

test('each bench step starts the bench in a known state, and later steps start with the wiring done', () => {
  assert.deepEqual(benchSetup(5), { powered: false, mode: 'continuity' });
  assert.deepEqual(benchSetup(6), { powered: true, mode: 'dc' });
  assert.deepEqual(benchSetup(7), { powered: true, mode: 'dc', probe: 2 });
  assert.equal(benchSetup(9).wiring, undefined, 'wiring on the wiring step is kept');
  for (let step = 1; step <= 9; step += 1) assert.equal(benchSetup(step).wiring, undefined, `step ${step}`);
  for (let step = 10; step <= 18; step += 1) assert.deepEqual(benchSetup(step), { powered: true, mode: 'dc', wiring: 'correct' });
  // Every bench step can reach its check from its setup.
  const bench = createBench();
  bench.setup(benchSetup(12));
  assert.equal(bench.flags().wiringCorrect, true);
});

test('the lessons that show a bench name a known one', () => {
  for (const l of LESSONS) assert.ok([undefined, null, 'meter', 'wiring', 'vdev'].includes(l.bench), l.id);
  assert.deepEqual(LESSONS.map((l) => l.bench ?? null), [null, null, null, null, 'meter', 'meter', 'meter', null, 'wiring', 'vdev', 'vdev', 'vdev', 'vdev', 'vdev', null, null, null, null]);
});

test('every step has an example question and answer for the coach, the answer at most four sentences', () => {
  for (const [index, step] of LESSONS.entries()) {
    const { question, answer } = step.example ?? {};
    assert.equal(typeof question, 'string', `step ${index + 1} has an example question`);
    assert.equal(typeof answer, 'string', `step ${index + 1} has an example answer`);
    assert.ok(question.trim() && answer.trim(), `step ${index + 1} example is not empty`);
    const sentences = answer.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length <= 4, `step ${index + 1} answer has ${sentences.length} sentences`);
  }
});
