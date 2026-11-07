import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createBoardView } from '../js/boardview.js';
import { pickPhoto, removeQuestion, zoomShift } from '../js/photoview.js';
import { PIN_ROLES } from '../js/core/schema.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');

const project = (extra = {}) => ({
  meta: { name: 'Board' },
  assets: [{ id: 'img_1', kind: 'image', path: 'assets/photos/img_1.jpg', label: 'Front', side: 'front', width: 1000, height: 500 }],
  markers: [{ id: 'mk_1', assetId: 'img_1', schematicId: 'sch_1', shape: 'box', x: 100, y: 100, w: 80, h: 20, label: 'J4', color: '#f59e0b' }],
  schematics: [{ id: 'sch_1', kind: 'header', name: 'UART', rows: 1, cols: 4, numbering: 'row', rotation: 0, notes: '', pins: [{ index: 2, role: 'TX', label: '', color: '#22c55e', note: '' }] }],
  components: [],
  ...extra,
});

function setup(extraHandlers = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.document.getElementById('panel-store').hidden = false;   // as after the layout starts
  const doc = dom.window.document;
  doc.getElementById('board-panel').hidden = false;
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result; };
  const handlers = {
    loadPhoto: async () => 'blob:photo',
    onUploadPhoto: record('upload', Promise.resolve('img_2')),
    onAddMarker: record('add', Promise.resolve('mk_new')),
    onUpdateAsset: record('asset'),
    onRemoveAsset: record('removeAsset'),
    onRotatePhoto: record('rotate'),
    onUpdateMarker: record('marker'),
    onRemoveMarker: record('remove'),
    onUpdateSchematic: record('schematic'),
    onUpdatePin: record('pin'),
    onAddReading: record('reading', Promise.resolve(true)),
    onAddCallout: (event) => { calls.push(['addCallout', event]); return Promise.resolve(event.annotation.id); },
    onUpdateCallout: record('callout'),
    onRemoveCallout: record('removeCallout'),
    onOpenWiki: record('wiki'),
    onAsk: record('ask'),
    loadWikiIndex: async () => [{ name: 'soc', title: 'SoC' }, { name: 'spi-flash', title: 'SPI flash' }],
    ...extraHandlers,
  };
  const view = createBoardView(doc, handlers);
  // jsdom does no layout: give the overlay a box the same size as the image so pointer maths works.
  const overlay = doc.getElementById('overlay');
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  const pointer = (type, x, y, target = overlay) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  const key = (k, target = doc.getElementById('stage')) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { dom, doc, view, calls, overlay, pointer, key };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('photo tabs, the photo and markers are drawn from the project', async () => {
  const { doc, view } = setup();
  view.render(project(), true);
  assert.equal(doc.querySelectorAll('#photo-tabs .tab').length, 1);
  assert.equal(doc.getElementById('viewer-empty').hidden, true);
  assert.equal(doc.getElementById('overlay').getAttribute('viewBox'), '0 0 1000 500');
  assert.equal(doc.querySelector('[data-marker="mk_1"] text').textContent, 'J4');
  await tick();
  assert.equal(doc.getElementById('photo').getAttribute('src'), 'blob:photo');
});

test('without photos the empty hint shows and tools stay usable for adding one', () => {
  const { doc, view } = setup();
  view.render(project({ assets: [], markers: [], schematics: [] }), true);
  assert.equal(doc.getElementById('viewer-empty').hidden, false);
  assert.equal(doc.getElementById('canvas').hidden, true);
  assert.equal(doc.getElementById('photo-file').disabled, false);
  assert.equal(doc.getElementById('zoom-in').disabled, true);
});

test('drawing a box asks for a marker in image pixels and selects it', async () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  doc.getElementById('tool-box').click();
  pointer('pointerdown', 300, 200);
  pointer('pointermove', 360, 230);
  pointer('pointerup', 360, 230);
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'add'), ['add', 'img_1', { x: 300, y: 200, w: 60, h: 30 }]);
  assert.equal(doc.getElementById('tool-select').getAttribute('aria-pressed'), 'true');
});

test('a click without dragging draws nothing', async () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  doc.getElementById('tool-box').click();
  pointer('pointerdown', 300, 200);
  pointer('pointerup', 302, 201);
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'add').length, 0);
});

test('selecting a marker opens the inspector; pin keys set roles and Backspace clears', () => {
  const { doc, view, calls, pointer, key } = setup();
  view.render(project(), true);
  assert.equal(doc.getElementById('inspector-form').hidden, true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  assert.equal(doc.getElementById('inspector-form').hidden, false);
  assert.equal(doc.getElementById('marker-label').value, 'J4');
  const pins = doc.querySelectorAll('#pin-grid .pin');
  assert.equal(pins.length, 4);
  assert.equal(pins[1].dataset.role, 'TX');
  pins[0].click();
  key('3');
  key('Backspace');
  assert.deepEqual(calls.filter((c) => c[0] === 'pin'), [
    ['pin', 'sch_1', 1, { role: '3V3', color: '#f97316' }],
    ['pin', 'sch_1', 1, null],
  ]);
});

test('the pin keys are a closed Guided-only list of keys and roles, two columns', () => {
  const { doc } = setup();
  const keys = doc.getElementById('pin-keys');
  assert.equal(keys.tagName, 'DETAILS');
  assert.equal(keys.open, false);
  assert.ok(keys.classList.contains('guide'), 'Expert hides it');
  assert.equal(keys.querySelector('summary').textContent, 'Pin keys');
  const items = [...keys.querySelectorAll('.key-list li')];
  assert.equal(items.length, PIN_ROLES.length);
  assert.deepEqual(items.slice(0, 2).map((li) => [li.querySelector('kbd').textContent, li.textContent.trim()]), [['g', 'g GND'], ['v', 'v VCC']]);
  assert.match(css, /\.key-list \{[^}]*columns: 2/);
});

test('dragging a selected marker moves it', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  const rect = doc.querySelector('[data-marker="mk_1"] rect');
  pointer('pointerdown', 120, 110, rect);
  pointer('pointermove', 150, 140);
  pointer('pointerup', 150, 140);
  assert.deepEqual(calls.find((c) => c[0] === 'marker'), ['marker', 'mk_1', { x: 130, y: 130 }]);
});

test('inspector edits are reported per field', () => {
  const { dom, doc, view, calls, pointer } = setup();
  view.render(project(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  const cols = doc.getElementById('header-cols');
  cols.value = '999';
  cols.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(calls.find((c) => c[0] === 'schematic'), ['schematic', 'sch_1', { cols: 64 }]);
});

function pinForm(extraHandlers) {
  const ctx = setup(extraHandlers);
  const { dom, doc, view, pointer } = ctx;
  view.render(project(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  doc.querySelectorAll('#pin-grid .pin')[0].click();
  const field = doc.getElementById('pin-reading');
  const powered = doc.getElementById('pin-reading-powered');
  const hint = doc.getElementById('pin-reading-hint');
  const type = (text) => { field.focus(); field.value = text; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const byHand = (checked) => { powered.checked = checked; powered.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const enter = () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return { ...ctx, field, powered, hint, type, byHand, enter };
}

test('Enter in the Reading field adds a reading from the app, the way pcbv measure does', async () => {
  const { calls, field, type, enter } = pinForm();
  type('3.31V');
  enter();
  await tick();
  const [, schematicId, index, reading] = calls.find((c) => c[0] === 'reading');
  assert.deepEqual([schematicId, index], ['sch_1', 1]);
  assert.deepEqual({ ...reading, ts: undefined }, { ts: undefined, mode: 'dc', value: 3.31, unit: 'V', text: '3.31 V', powered: true, source: 'app' });
  assert.match(reading.ts, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(field.value, '');
});

test('the Add button adds the reading too', async () => {
  const { doc, calls, type } = pinForm();
  type('OL');
  doc.getElementById('pin-reading-add').click();
  await tick();
  assert.equal(calls.find((c) => c[0] === 'reading')[3].text, 'OL');
});

test('Board powered follows the typed mode until the person changes it', async () => {
  const { calls, powered, type, byHand, enter } = pinForm();
  type('3.3V');
  assert.equal(powered.checked, true);
  type('0.3ohm');
  assert.equal(powered.checked, false);
  type('beep');
  assert.equal(powered.checked, false);
  byHand(true);
  type('4.7k');
  assert.equal(powered.checked, true);
  enter();
  await tick();
  assert.equal(calls.find((c) => c[0] === 'reading')[3].powered, true);
});

test('a reading that cannot be read shows the parser message and sends nothing', async () => {
  const { calls, field, hint, type, enter } = pinForm();
  type('lots');
  enter();
  await tick();
  assert.equal(calls.some((c) => c[0] === 'reading'), false);
  assert.equal(hint.hidden, false);
  assert.equal(hint.dataset.kind, 'error');
  assert.equal(hint.textContent, "Cannot read 'lots'; write it like 3.29V, 330mV, 0.3ohm, 4.7k, OL or beep.");
  assert.equal(field.value, 'lots');
  type('3.3V');
  assert.equal(hint.hidden, true);
});

test('a resistance on a powered board warns after adding and is still added', async () => {
  const { calls, hint, type, byHand, enter } = pinForm();
  type('0.3ohm');
  byHand(true);
  enter();
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'reading').length, 1);
  assert.equal(hint.dataset.kind, 'warning');
  assert.equal(hint.textContent, 'Resistance and continuity are measured with the board unplugged; on a powered board the reading is meaningless and the meter can be damaged.');
});

test('a voltage on an unpowered board warns after adding and is still added', async () => {
  const { calls, hint, type, byHand, enter } = pinForm();
  type('3.3V');
  byHand(false);
  enter();
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'reading').length, 1);
  assert.equal(hint.textContent, 'A voltage on an unpowered board usually means a capacitor still holds charge.');
});

test('a reading the controller does not store stays in the field', async () => {
  const { field, hint, type, enter } = pinForm({ onAddReading: async () => false });
  type('3.3V');
  enter();
  await tick();
  assert.equal(field.value, '3.3V');
  assert.equal(hint.hidden, true);
});

test('Enter is consumed so the form does not submit, and a held or composing key adds nothing', async () => {
  const { dom, calls, field, type } = pinForm();
  type('3.3V');
  const press = (init) => { const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }); field.dispatchEvent(event); return event; };
  assert.equal(press({ repeat: true }).defaultPrevented, true);
  press({ isComposing: true });
  await tick();
  assert.equal(calls.some((c) => c[0] === 'reading'), false);
  assert.equal(press({}).defaultPrevented, true);
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'reading').length, 1);
});

test('a second Enter while the reading is being saved adds nothing', async () => {
  let finish;
  const { calls, field, type, enter } = pinForm({ onAddReading: (...args) => { calls.push(['reading', ...args]); return new Promise((resolve) => { finish = resolve; }); } });
  type('3.3V');
  enter();
  enter();
  assert.equal(calls.filter((c) => c[0] === 'reading').length, 1);
  finish(true);
  await tick();
  assert.equal(field.value, '');
  type('3.4V');
  enter();
  assert.equal(calls.filter((c) => c[0] === 'reading').length, 2);
});

test('text typed while a reading is being saved is kept', async () => {
  let finish;
  const { field, type, enter } = pinForm({ onAddReading: () => new Promise((resolve) => { finish = resolve; }) });
  type('3.3V');
  enter();
  type('3.4V');
  finish(true);
  await tick();
  assert.equal(field.value, '3.4V');
});

test('a reading saved for a pin that is no longer selected does not touch the form', async () => {
  let finish;
  const { doc, field, hint, type, enter } = pinForm({ onAddReading: () => new Promise((resolve) => { finish = resolve; }) });
  type('0.3ohm');
  enter();
  doc.querySelectorAll('#pin-grid .pin')[1].click();
  type('typed on pin 2');
  finish(true);
  await tick();
  assert.equal(field.value, 'typed on pin 2');
  assert.equal(hint.hidden, true);
});

test('a reading over the length limit is refused before it is parsed', async () => {
  const { calls, field, hint, type, enter } = pinForm();
  type(`${'1'.repeat(40)}V`);
  assert.equal(field.maxLength, 40);
  enter();
  await tick();
  assert.equal(calls.some((c) => c[0] === 'reading'), false);
  assert.equal(hint.textContent, 'A reading has at most 40 characters.');
  type('1'.repeat(40));
  enter();
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'reading').length, 1);
});

test('the Reading field keeps its text over a redraw and clears for another pin', () => {
  const { doc, view, field, type } = pinForm();
  type('3.3');
  view.render(project(), true);
  assert.equal(field.value, '3.3');
  doc.querySelectorAll('#pin-grid .pin')[1].click();
  assert.equal(field.value, '');
});

test('the Reading field is disabled while the board is not live', () => {
  const { doc, view, field } = pinForm();
  view.render(project(), false);
  assert.equal(field.disabled, true);
  assert.equal(doc.getElementById('pin-reading-add').disabled, true);
});

test('Delete removes the selected marker after confirming', () => {
  const { dom, doc, view, calls, pointer, key } = setup();
  let asked = '';
  dom.window.confirm = (text) => { asked = text; return true; };
  view.render(project(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  key('Delete');
  assert.match(asked, /J4/);
  assert.deepEqual(calls.find((c) => c[0] === 'remove'), ['remove', 'mk_1']);
});

test('nothing is editable while not live', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), false);
  assert.equal(doc.getElementById('tool-box').disabled, true);
  doc.getElementById('tool-box').click();
  pointer('pointerdown', 300, 200);
  pointer('pointerup', 360, 230);
  assert.equal(calls.length, 0);
});

test('untrusted labels stay text on the photo and in the inspector', () => {
  const { doc, view, pointer } = setup();
  const evil = '<img src=x onerror=alert(1)>';
  const p = project();
  p.markers[0].label = evil;
  p.schematics[0].pins[0] = { index: 1, role: evil, label: evil, color: 'red', note: '' };
  view.render(p, true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  assert.equal(doc.querySelectorAll('img:not(#photo)').length, 0);
  assert.equal(doc.querySelector('[data-marker="mk_1"] text').textContent, evil);
});


const withCallout = (extra = {}) => project({
  annotations: [{ id: 'an_1', assetId: 'img_1', x: 500, y: 250, lx: 600, ly: 200, text: 'SoC', wiki: 'soc', ...extra }],
});

test('the callout tool places a callout where you click and opens its form', async () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  doc.getElementById('tool-callout').click();
  pointer('pointerdown', 400, 300);
  await tick();
  const [, event] = calls.find((c) => c[0] === 'addCallout');
  assert.equal(event.type, 'annotation/added');
  assert.deepEqual([event.annotation.assetId, event.annotation.x, event.annotation.y], ['img_1', 400, 300]);
  view.render(project({ annotations: [event.annotation] }), true);
  assert.equal(doc.getElementById('inspector-heading').textContent, 'Callout');
  assert.equal(doc.getElementById('callout-form').hidden, false);
  assert.equal(doc.getElementById('tool-select').getAttribute('aria-pressed'), 'true');
});

test('callouts draw a dot, a leader line and a label, and dragging the label moves only the label', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(withCallout(), true);
  const group = doc.querySelector('[data-callout="an_1"]');
  assert.equal(group.querySelector('text').textContent, 'SoC');
  assert.deepEqual(['x1', 'y1', 'x2', 'y2'].map((k) => Number(group.querySelector('line').getAttribute(k))), [500, 250, 600, 200]);
  pointer('pointerdown', 610, 200, group.querySelector('.label text'));
  pointer('pointermove', 650, 150);
  pointer('pointerup', 650, 150);
  assert.deepEqual(calls.find((c) => c[0] === 'callout'), ['callout', 'an_1', { lx: 640, ly: 150 }]);
});

test('a callout with a wiki page ends in a book icon, not a question mark, and keeps its title', () => {
  const { doc, view } = setup();
  view.render(withCallout(), true);
  const label = doc.querySelector('[data-callout="an_1"] .label');
  assert.equal(label.querySelector('text').textContent, 'SoC', 'no " ?" in the text');
  const book = label.querySelector('path.book');
  assert.ok(book, 'the icon is a path inside the label');
  assert.match(book.getAttribute('transform'), /^translate\(.+\) scale\(.+\)$/);
  assert.match(label.querySelector('title').textContent, /About this: soc/);
  view.render(withCallout({ wiki: '' }), true);
  assert.equal(doc.querySelector('[data-callout="an_1"] .label path.book'), null, 'no icon without a page');
  assert.equal(doc.querySelector('[data-callout="an_1"] .label title'), null);
});

test('the book icon takes the label text colour from the tokens', () => {
  assert.match(css, /\.callout \.label \.book \{ stroke: var\(--scr-label-fg\); \}/);
});

test('dragging the dot moves what the callout points at', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(withCallout(), true);
  pointer('pointerdown', 500, 250, doc.querySelector('[data-callout="an_1"] circle'));
  pointer('pointermove', 520, 260);
  pointer('pointerup', 520, 260);
  assert.deepEqual(calls.find((c) => c[0] === 'callout'), ['callout', 'an_1', { x: 520, y: 260 }]);
});

test('the callout form edits text and wiki page, opens the page and removes the callout', async () => {
  const { dom, doc, view, calls, pointer, key } = setup();
  dom.window.confirm = () => true;
  view.render(withCallout(), true);
  pointer('pointerdown', 610, 200, doc.querySelector('[data-callout="an_1"] .label text'));
  pointer('pointerup', 610, 200);
  await tick();
  view.render(withCallout(), true);
  const wiki = doc.getElementById('callout-wiki');
  assert.deepEqual([...wiki.options].map((o) => o.value), ['', 'soc', 'spi-flash']);
  assert.equal(wiki.value, 'soc');
  const text = doc.getElementById('callout-text');
  text.value = ' Flash ';
  text.dispatchEvent(new dom.window.Event('change'));
  wiki.value = 'spi-flash';
  wiki.dispatchEvent(new dom.window.Event('change'));
  doc.getElementById('callout-open').click();
  key('Delete');
  assert.deepEqual(calls.filter((c) => ['callout', 'wiki', 'removeCallout'].includes(c[0])), [
    ['callout', 'an_1', { text: 'Flash' }],
    ['callout', 'an_1', { wiki: 'spi-flash' }],
    ['wiki', 'soc'],
    ['removeCallout', 'an_1'],
  ]);
});

test('expert guidance draws callout labels smaller; CSS shows them on hover only', () => {
  const { doc, view } = setup();
  view.render(withCallout(), true);
  assert.equal(doc.querySelector('.callout text').getAttribute('font-size'), '15');
  doc.documentElement.dataset.guidance = 'expert';
  view.render(withCallout(), true);
  assert.equal(doc.querySelector('.callout text').getAttribute('font-size'), '12');
});

test('callout text from the board stays text', () => {
  const { doc, view } = setup();
  view.render(withCallout({ text: '<img src=x onerror=alert(1)>' }), true);
  assert.equal(doc.querySelectorAll('img:not(#photo)').length, 0);
});

const guessed = () => project({
  annotations: [{ id: 'an_g', assetId: 'img_1', x: 500, y: 250, lx: 550, ly: 200, text: 'U3: SPI flash',
    guess: { by: 'analyst, qwen', confidence: 'medium', evidence: 'SOIC-8 next to the SoC' } }],
  schematics: [{ id: 'sch_1', kind: 'header', name: 'UART', rows: 1, cols: 4, numbering: 'row', rotation: 0, notes: '',
    pins: [{ index: 1, role: '', label: '', color: '', note: '', guess: { role: 'GND', confidence: 'high', evidence: 'Wide trace' } },
           { index: 2, role: 'TX', label: '', color: '#22c55e', note: '', guess: { role: 'TX', confidence: 'low', evidence: 'x' } }] }],
});

test('an AI guess on a callout is drawn as unconfirmed until it is marked as checked', () => {
  const { doc, view, calls, pointer } = setup();
  doc.documentElement.dataset.assistant = 'on';
  view.render(guessed(), true);
  const group = doc.querySelector('[data-callout="an_g"]');
  assert.ok(group.classList.contains('guess'));
  assert.equal(group.querySelector('text').textContent, 'U3: SPI flash · AI guess, medium');
  doc.documentElement.dataset.guidance = 'expert';
  view.render(guessed(), true);
  assert.equal(doc.querySelector('[data-callout="an_g"] text').textContent, 'U3: SPI flash · AI?');
  pointer('pointerdown', 500, 250, doc.querySelector('[data-callout="an_g"] circle'));
  pointer('pointerup', 500, 250);
  assert.equal(doc.getElementById('callout-guess').hidden, false);
  assert.match(doc.getElementById('callout-guess-text').textContent, /medium certainty, from analyst, qwen\. SOIC-8 next to the SoC/);
  doc.getElementById('callout-confirm').click();
  assert.deepEqual(calls.at(-1), ['callout', 'an_g', { guess: null }]);
});

test('with the assistant off a stored guess is shown as unverified, and nothing else about it changes', () => {
  const { doc, view, pointer } = setup();
  assert.equal(doc.documentElement.dataset.assistant, 'off');
  view.render(guessed(), true);
  assert.equal(doc.querySelector('[data-callout="an_g"] text').textContent, 'U3: SPI flash · unverified, medium');
  pointer('pointerdown', 500, 250, doc.querySelector('[data-callout="an_g"] circle'));
  pointer('pointerup', 500, 250);
  assert.match(doc.getElementById('callout-guess-text').textContent, /^Unverified guess: medium certainty, from analyst/);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  const first = doc.querySelectorAll('#pin-grid .pin')[0];
  assert.equal(first.querySelector('.r').textContent, 'GND?');
  assert.match(first.getAttribute('aria-label'), /Unverified guess GND/);
});

test('a guessed pin role shows as a question until the person sets the role', () => {
  const { doc, view, calls, pointer } = setup();
  doc.documentElement.dataset.assistant = 'on';
  view.render(guessed(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  const pins = doc.querySelectorAll('#pin-grid .pin');
  assert.ok(pins[0].classList.contains('guessed') && !pins[1].classList.contains('guessed'));
  assert.equal(pins[0].querySelector('.r').textContent, 'GND?');
  assert.match(pins[0].getAttribute('aria-label'), /AI guess GND/);
  pins[1].click();
  assert.equal(doc.getElementById('pin-guess').hidden, true, 'a guess that matches the role needs no note');
  doc.querySelectorAll('#pin-grid .pin')[0].click();
  assert.equal(doc.getElementById('pin-guess').hidden, false);
  assert.equal(doc.getElementById('pin-guess-use').textContent, 'Use GND as the role');
  doc.getElementById('pin-guess-use').click();
  assert.deepEqual(calls.at(-1), ['pin', 'sch_1', 1, { role: 'GND', color: '#4b5563' }]);
});

test('ask buttons send the pin or the photo to the assistant', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  doc.getElementById('photo-ask').click();
  assert.deepEqual(calls.at(-1)[2], { photo: 'img_1' });
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  doc.querySelectorAll('#pin-grid .pin')[1].click();
  doc.getElementById('pin-ask').click();
  assert.deepEqual(calls.at(-1), ['ask', 'What can you tell me about pin 2 of J4?', { header: 'J4', pin: 2 }]);
  doc.getElementById('photo-ask').click();
  assert.deepEqual(calls.at(-1)[2], { photo: 'img_1', header: 'J4' }, 'a selected header goes along');
});

test('board shortcuts ignore focus outside the Header and Photo panels and inside editable fields', () => {
  const { doc, view, calls, pointer, key } = setup();
  view.render(project(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  doc.querySelectorAll('#pin-grid .pin')[0].click();
  for (const outside of ['serial-input', 'assistant-input', 'panel-console', 'panel-assistant', 'panel-terminal']) {
    key('3', doc.getElementById(outside));
    key('Backspace', doc.getElementById(outside));
  }
  key('3', doc.getElementById('marker-label'));
  key('Backspace', doc.getElementById('pin-label'));
  assert.deepEqual(calls.filter((c) => c[0] === 'pin' || c[0] === 'remove'), [], 'no shortcut fired');
  key('3');
  assert.equal(calls.filter((c) => c[0] === 'pin').length, 1, 'the same key works from the photo');
});

test('a click on the photo keeps shortcuts working because focus moves to the stage', () => {
  const { doc, view, pointer } = setup();
  view.render(project(), true);
  doc.getElementById('serial-input').focus();
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  assert.equal(doc.activeElement, doc.getElementById('stage'));
});

test('clearing a pin that has a role and readings or a note asks first; a bare pin does not', () => {
  const { dom, doc, view, calls, pointer, key } = setup();
  const p = project();
  p.schematics[0].pins.push({ index: 3, role: 'GND', label: '', color: '#4b5563', note: '', readings: [{ text: '0 V', ts: '2026-10-30T10:00:00Z' }] });
  view.render(p, true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  const pins = doc.querySelectorAll('#pin-grid .pin');
  let asked = 0;
  let answer = false;
  dom.window.confirm = () => { asked += 1; return answer; };
  pins[2].click();
  key('Backspace');
  assert.equal(asked, 1);
  assert.equal(calls.filter((c) => c[0] === 'pin').length, 0, 'declined: the pin is kept');
  answer = true;
  key('Delete');
  assert.deepEqual(calls.filter((c) => c[0] === 'pin'), [['pin', 'sch_1', 3, null]]);
  doc.querySelectorAll('#pin-grid .pin')[1].click();
  key('Backspace');
  assert.equal(asked, 2, 'asked once more for the first clear only');
  assert.equal(calls.filter((c) => c[0] === 'pin').length, 2, 'TX has no readings or note: cleared at once');
});

test('colours from the board file reach CSS only as #rrggbb', () => {
  const { doc, view, pointer } = setup();
  const p = project();
  p.markers[0].color = 'red; background: url(//evil)';
  p.schematics[0].pins[0] = { index: 1, role: 'TX', label: '', color: 'expression(alert(1))', note: '' };
  p.schematics[0].pins[1] = { index: 2, role: 'RX', label: '', color: '#ABCDEF', note: '' };
  view.render(p, true);
  assert.equal(doc.querySelector('[data-marker="mk_1"]').style.getPropertyValue('--marker'), '', 'the stylesheet default applies');
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  const pins = doc.querySelectorAll('#pin-grid .pin');
  assert.equal(pins[0].style.getPropertyValue('--pin'), '');
  assert.equal(pins[1].style.getPropertyValue('--pin'), '#ABCDEF');
  p.markers[0].color = '#22d3ee';
  view.render(p, true);
  assert.equal(doc.querySelector('[data-marker="mk_1"]').style.getPropertyValue('--marker'), '#22d3ee');
});

test('a photo removed during a box drag ends the drag without an error or a marker', async () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  doc.getElementById('tool-box').click();
  pointer('pointerdown', 300, 200);
  pointer('pointermove', 360, 230);
  view.render(project({ assets: [], markers: [], schematics: [] }), true);
  pointer('pointermove', 380, 240);
  pointer('pointerup', 380, 240);
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'add').length, 0);
  assert.equal(doc.querySelector('#overlay .draft'), null, 'the draft rectangle is gone');
});

test('a result for the previous board changes nothing after a reset', async () => {
  const { doc, view, calls } = setup();
  view.render(project(), true);
  const upload = doc.getElementById('photo-file');
  Object.defineProperty(upload, 'files', { value: [{ name: 'late.jpg' }] });
  upload.dispatchEvent(new doc.defaultView.Event('change'));
  view.reset();
  view.render(project({ assets: [{ id: 'img_9', kind: 'image', path: 'assets/photos/img_9.jpg', label: 'Other', side: 'front', width: 800, height: 400 }], markers: [], schematics: [] }), true);
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'upload').length, 1);
  assert.equal(doc.querySelector('#photo-tabs .tab').textContent, 'Other');
  assert.equal(doc.querySelector('#photo-tabs .tab').getAttribute('aria-pressed'), 'true', 'the late upload did not switch photos');
});

test('the photo upload is a real input a keyboard can reach, shown through its label', () => {
  const { doc, view } = setup();
  view.render(project(), true);
  const input = doc.getElementById('photo-file');
  assert.equal(input.hasAttribute('hidden'), false, 'hidden would remove it from the tab order');
  assert.ok(input.classList.contains('visually-hidden'));
  assert.equal(input.closest('label.button')?.id, 'add-photo', 'the label shows the focus ring and the name');
  assert.equal(input.disabled, false);
  view.render(project(), false);
  assert.equal(input.disabled, true);
});

test('markers and callouts are listed with name and kind, and the list chooses them without a pointer', () => {
  const { doc, view } = setup();
  view.render(withCallout({ text: 'Flash <b>chip</b>', wiki: '' }), true);
  assert.equal(doc.getElementById('annotation-box').hidden, false);
  const buttons = [...doc.querySelectorAll('#annotation-list button')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['J4Header marker', 'Flash <b>chip</b>Callout']);
  assert.equal(doc.querySelector('#annotation-list b'), null, 'names are text');
  assert.ok(buttons.every((b) => b.getAttribute('aria-pressed') === 'false'));

  buttons[0].click();
  assert.equal(doc.querySelector('[data-marker="mk_1"]').classList.contains('selected'), true, 'the photo shows the selection');
  assert.equal(doc.getElementById('inspector-form').hidden, false);
  assert.equal(doc.querySelector('#annotation-list button').getAttribute('aria-pressed'), 'true');

  doc.querySelectorAll('#annotation-list button')[1].click();
  assert.equal(doc.querySelector('[data-callout="an_1"]').classList.contains('selected'), true);
  assert.equal(doc.querySelector('[data-marker="mk_1"]').classList.contains('selected'), false);
  assert.equal(doc.getElementById('callout-form').hidden, false);
  assert.equal(doc.getElementById('inspector-form').hidden, true);
});

test('the list keeps keyboard focus on the chosen item and is hidden when the photo has nothing', () => {
  const { doc, view } = setup();
  view.render(withCallout({ text: 'Flash <b>chip</b>', wiki: '' }), true);
  const second = doc.querySelectorAll('#annotation-list button')[1];
  second.focus();
  second.click();
  assert.equal(doc.activeElement.dataset.key, 'callout:an_1', 'a redraw does not drop focus');
  view.render(project({ markers: [] }), true);
  assert.equal(doc.getElementById('annotation-box').hidden, true);
});

test('a keyboard alone can pick a marker, a pin and its role', () => {
  const { doc, view, calls, key } = setup();
  view.render(project(), true);
  doc.querySelector('#annotation-list button').click();
  const pin = doc.querySelectorAll('#pin-grid button')[2];
  pin.focus();
  pin.click();
  assert.equal(doc.activeElement.getAttribute('aria-label').startsWith('Pin 3'), true, 'focus follows the chosen pin');
  key('g', doc.activeElement);
  assert.deepEqual(calls.at(-1).slice(0, 3), ['pin', 'sch_1', 3]);
  assert.equal(calls.at(-1)[3].role, 'GND');
  const role = doc.getElementById('pin-role');
  role.value = 'TX';
  role.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(calls.at(-1)[3].role, 'TX');
});

test('removing a marker or a callout asks first, in Expert as well as Guided', () => {
  for (const guidance of ['guided', 'expert']) {
    const { doc, view, calls, dom } = setup();
    doc.documentElement.dataset.guidance = guidance;
    const asked = [];
    dom.window.confirm = (text) => { asked.push(text); return false; };
    view.render(withCallout(), true);
    doc.querySelectorAll('#annotation-list button')[0].click();
    doc.getElementById('marker-delete').click();
    doc.querySelectorAll('#annotation-list button')[1].click();
    doc.getElementById('callout-delete').click();
    assert.equal(asked.length, 2, guidance);
    assert.equal(calls.some((c) => c[0] === 'remove' || c[0] === 'removeCallout'), false);
  }
});

test('the Clear button asks like the keys do, and declining leaves the pin alone', () => {
  const { dom, doc, view, calls, pointer } = setup();
  const p = project();
  p.schematics[0].pins[0] = { index: 2, role: 'TX', label: '', color: '#22c55e', note: 'idles high', readings: [{ text: '3.3 V', ts: '2026-10-30T10:00:00Z' }] };
  view.render(p, true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  doc.querySelectorAll('#pin-grid .pin')[1].click();
  let asked = 0;
  let answer = false;
  dom.window.confirm = () => { asked += 1; return answer; };
  doc.getElementById('pin-clear').click();
  assert.equal(asked, 1);
  assert.equal(calls.filter((c) => c[0] === 'pin').length, 0, 'declined: the pin is kept');
  answer = true;
  doc.getElementById('pin-clear').click();
  assert.deepEqual(calls.filter((c) => c[0] === 'pin'), [['pin', 'sch_1', 2, null]]);
});

test('uploading a photo clears a selected callout, so its form is hidden and Delete does nothing', async () => {
  const { dom, doc, view, calls } = setup();
  dom.window.confirm = () => true;
  const withPhoto = (extra) => project({
    assets: [...project().assets, { id: 'img_2', kind: 'image', path: 'assets/photos/img_2.jpg', label: 'Back', side: 'back', width: 1000, height: 500 }],
    annotations: [{ id: 'an_1', assetId: 'img_1', x: 400, y: 300, lx: 450, ly: 250, text: 'test pad' }], ...extra });
  view.render(withPhoto(), true);
  doc.querySelectorAll('#annotation-list button')[1].click();
  assert.equal(doc.getElementById('callout-form').hidden, false);
  const input = doc.getElementById('photo-file');
  Object.defineProperty(input, 'files', { value: [new dom.window.File(['x'], 'back.jpg')], configurable: true });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick(); await tick();
  view.render(withPhoto(), true);
  assert.equal(doc.getElementById('callout-form').hidden, true);
  doc.getElementById('callout-delete').click();
  assert.equal(calls.some((c) => c[0] === 'removeCallout'), false);
});

test('pressing a box marker and releasing without a move still draws what changed meanwhile', () => {
  const { doc, view, pointer } = setup();
  view.render(project(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  const renamed = project();
  renamed.markers[0].label = 'J5';
  view.render(renamed, true);                                  // ignored while the pointer is down
  pointer('pointerup', 120, 110);
  assert.equal(doc.querySelector('[data-marker="mk_1"] text').textContent, 'J5');
});

test('the selected pin is reported once per change, for the tutorial meter', () => {
  const noted = [];
  const { doc, view, pointer } = setup({ notePin: (pin) => noted.push(pin) });
  view.render(project(), true);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
  assert.deepEqual(noted, [], 'a header alone is no pin');
  doc.querySelectorAll('#pin-grid .pin')[1].click();
  assert.deepEqual(noted, [2]);
  view.render(project(), true);
  assert.deepEqual(noted, [2], 'a redraw with the same pin says nothing');
  doc.querySelectorAll('#pin-grid .pin')[3].click();
  assert.deepEqual(noted, [2, 4]);
  view.reset();
  view.render(project(), true);
  assert.deepEqual(noted, [2, 4, null], 'losing the pin is reported too');
});

const menuButton = (doc) => doc.querySelector('#photo-tabs .photo-menu-button');
const items = (doc) => [...doc.querySelectorAll('#photo-tabs [role="menuitem"]')];
const press = (dom, target, key) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));

test('the side box is gone and a new photo is sent without one', async () => {
  const { doc, view, calls } = setup();
  view.render(project(), true);
  assert.equal(doc.getElementById('photo-side'), null);
  const upload = doc.getElementById('photo-file');
  Object.defineProperty(upload, 'files', { value: [{ name: 'a.jpg' }] });
  upload.dispatchEvent(new doc.defaultView.Event('change'));
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'upload').length, 2, 'the file is the only argument');
});

test('each photo has a labelled menu button, and a read-only board has none', () => {
  const { doc, view } = setup();
  view.render(project(), true);
  assert.equal(menuButton(doc).getAttribute('aria-label'), 'Photo actions for Front');
  assert.equal(menuButton(doc).getAttribute('aria-expanded'), 'false');
  view.render(project(), false);
  assert.equal(menuButton(doc), null);
});

test('the photo menu opens on the keyboard, moves with the arrows and closes with Escape', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  menuButton(doc).click();
  assert.deepEqual(items(doc).map((i) => i.textContent), ['Rename', 'Rotate left', 'Rotate right', 'Remove photo']);
  assert.equal(menuButton(doc).getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, items(doc)[0]);
  press(dom, doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement, items(doc)[1]);
  assert.ok(items(doc)[3].classList.contains('danger'));
  press(dom, doc.activeElement, 'End');
  assert.equal(doc.activeElement, items(doc)[3]);
  press(dom, doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement, items(doc)[0], 'wraps round');
  press(dom, doc.activeElement, 'End');
  assert.equal(doc.activeElement, items(doc)[3]);
  press(dom, doc.activeElement, 'Home');
  assert.equal(doc.activeElement, items(doc)[0]);
  press(dom, doc.activeElement, 'Escape');
  assert.equal(items(doc).length, 0);
  assert.equal(doc.activeElement, menuButton(doc));
  assert.equal(menuButton(doc).getAttribute('aria-expanded'), 'false');
});

test('Tab closes the photo menu and keeps focus on its button', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  menuButton(doc).click();
  press(dom, doc.activeElement, 'Tab');
  assert.equal(items(doc).length, 0);
  assert.equal(doc.activeElement, menuButton(doc));
});

function startRename(ctx) {
  ctx.view.render(project(), true);
  menuButton(ctx.doc).click();
  items(ctx.doc)[0].click();
  return ctx.doc.querySelector('#photo-tabs .tab-input');
}

test('Rename turns the tab into a text box with the name selected; Enter saves one event', () => {
  const ctx = setup();
  const input = startRename(ctx);
  assert.equal(input.value, 'Front');
  assert.equal(input.maxLength, 80);
  assert.equal(input.getAttribute('aria-label'), 'Photo name');
  assert.equal(ctx.doc.activeElement, input);
  input.value = '  Back side ';
  input.dispatchEvent(new ctx.dom.window.Event('input'));
  press(ctx.dom, input, 'Enter');
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'asset'), [['asset', 'img_1', { label: 'Back side' }]]);
  assert.equal(ctx.doc.querySelector('#photo-tabs .tab-input'), null);
  assert.equal(ctx.doc.activeElement, menuButton(ctx.doc));
});

test('Rename: Escape cancels, an empty name and an unchanged name send nothing, leaving the box saves', () => {
  const ctx = setup();
  let input = startRename(ctx);
  input.value = 'Changed';
  press(ctx.dom, input, 'Escape');
  assert.equal(ctx.doc.querySelector('#photo-tabs .tab-input'), null);
  input = startRename(ctx);
  input.value = '   ';
  press(ctx.dom, input, 'Enter');
  input = startRename(ctx);
  press(ctx.dom, input, 'Enter');
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'asset'), []);
  assert.equal(ctx.doc.querySelector('#photo-tabs .tab').textContent, 'Front');
  input = startRename(ctx);
  input.value = 'Left in place';
  input.dispatchEvent(new ctx.dom.window.FocusEvent('blur'));
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'asset'), [['asset', 'img_1', { label: 'Left in place' }]]);
});

test('Rename keeps what was typed when the board redraws, and never sends more than 80 characters', () => {
  const ctx = setup();
  const input = startRename(ctx);
  input.value = 'x'.repeat(120);
  input.dispatchEvent(new ctx.dom.window.Event('input'));
  ctx.view.render(project(), true);
  const again = ctx.doc.querySelector('#photo-tabs .tab-input');
  assert.equal(again.value.length, 120);
  press(ctx.dom, again, 'Enter');
  assert.equal(ctx.calls.find((c) => c[0] === 'asset')[2].label.length, 80);
});

test('Rename: pressing another tab saves the name and shows that photo; leaving by keyboard stays', () => {
  const ctx = setup();
  const two = () => project({ assets: [...project().assets, { id: 'img_2', kind: 'image', path: 'assets/photos/img_2.jpg', label: 'Back', width: 1000, height: 500 }] });
  const pressed = () => [...ctx.doc.querySelectorAll('#photo-tabs .tab')].find((t) => t.getAttribute('aria-pressed') === 'true')?.dataset.asset;
  const rename = () => {
    ctx.view.render(two(), true);
    ctx.doc.querySelector('#photo-tabs .photo-menu-button').click();
    items(ctx.doc)[0].click();
    return ctx.doc.querySelector('#photo-tabs .tab-input');
  };
  let input = rename();
  input.value = 'Top';
  const other = ctx.doc.querySelector('#photo-tabs .tab[data-asset="img_2"]');
  other.dispatchEvent(new ctx.dom.window.MouseEvent('pointerdown', { bubbles: true }));
  input.dispatchEvent(new ctx.dom.window.FocusEvent('blur'));      // the browser moves focus on the press; the redraw then loses the click
  ctx.doc.dispatchEvent(new ctx.dom.window.MouseEvent('pointerup', { bubbles: true }));
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'asset'), [['asset', 'img_1', { label: 'Top' }]]);
  assert.equal(pressed(), 'img_2');
  ctx.doc.querySelector('#photo-tabs .tab[data-asset="img_1"]').click();
  input = rename();
  input.value = 'Top side';
  input.dispatchEvent(new ctx.dom.window.FocusEvent('blur'));
  assert.equal(pressed(), 'img_1');
});

test('Rotate left and Rotate right turn that photo by a quarter', () => {
  const { doc, view, calls } = setup();
  view.render(project(), true);
  menuButton(doc).click();
  items(doc)[1].click();
  menuButton(doc).click();
  items(doc)[2].click();
  assert.deepEqual(calls.filter((c) => c[0] === 'rotate'), [['rotate', 'img_1', -1], ['rotate', 'img_1', 1]]);
});

test('Remove photo asks first and names what goes with the photo', () => {
  const ctx = setup();
  const asked = [];
  ctx.dom.window.confirm = (text) => { asked.push(text); return false; };
  ctx.view.render(project(), true);
  menuButton(ctx.doc).click();
  items(ctx.doc).at(-1).click();
  assert.deepEqual(asked, ['Remove the photo "Front"? This also removes 1 marker on it.']);
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'removeAsset'), [], 'a No sends nothing');
  assert.equal(ctx.doc.activeElement, menuButton(ctx.doc));
  ctx.dom.window.confirm = () => true;
  menuButton(ctx.doc).click();
  items(ctx.doc).at(-1).click();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'removeAsset'), [['removeAsset', 'img_1']]);
});

test('the Remove question counts markers and callouts and leaves out a part that is 0', () => {
  const asset = { id: 'a', label: 'Top' };
  const at = (n, id = 'a') => Array.from({ length: n }, () => ({ assetId: id }));
  assert.equal(removeQuestion({ markers: [], annotations: [] }, asset), 'Remove the photo "Top"?');
  assert.equal(removeQuestion({ markers: at(3), annotations: at(2) }, asset), 'Remove the photo "Top"? This also removes 3 markers and 2 callouts on it.');
  assert.equal(removeQuestion({ markers: at(1), annotations: at(1, 'b') }, asset), 'Remove the photo "Top"? This also removes 1 marker on it.');
  assert.equal(removeQuestion({ markers: at(5, 'b'), annotations: at(1) }, asset), 'Remove the photo "Top"? This also removes 1 callout on it.');
  assert.equal(removeQuestion({ markers: [] }, { id: 'a' }), 'Remove the photo "Photo"?');
});

const select = (doc, pointer) => {
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointerup', 120, 110);
};
const handle = (doc, name) => doc.querySelector(`#overlay [data-handle="${name}"]`);

test('a selected box shows eight handles, 8 screen pixels wide at any zoom', () => {
  const { doc, view, pointer } = setup();
  view.render(project(), true);
  assert.equal(doc.querySelectorAll('#overlay [data-handle]').length, 0, 'nothing selected, no handles');
  select(doc, pointer);
  const handles = [...doc.querySelectorAll('#overlay [data-handle]')];
  assert.deepEqual(handles.map((h) => h.dataset.handle), ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
  assert.equal(handle(doc, 'se').getAttribute('width'), '8');
  assert.equal(handle(doc, 'se').getAttribute('x'), String(180 - 4));
  assert.equal(handle(doc, 'n').getAttribute('x'), String(140 - 4));
  doc.getElementById('zoom-out').click();
  assert.equal(handle(doc, 'se').getAttribute('width'), '10', 'at 80% a handle is 10 image pixels, still 8 on screen');
});

test('dragging a handle resizes the box and sends one event on release', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  select(doc, pointer);
  pointer('pointerdown', 180, 110, handle(doc, 'e'));
  pointer('pointermove', 200, 110);
  assert.equal(doc.querySelector('[data-marker="mk_1"] rect').getAttribute('width'), '100', 'the box follows the pointer');
  assert.equal(calls.filter((c) => c[0] === 'marker').length, 0, 'nothing is sent while dragging');
  pointer('pointermove', 210, 110);
  pointer('pointerup', 210, 110);
  assert.deepEqual(calls.filter((c) => c[0] === 'marker'), [['marker', 'mk_1', { x: 100, y: 100, w: 110, h: 20 }]]);
});

test('a corner handle changes two edges and the box stays inside the photo', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  select(doc, pointer);
  pointer('pointerdown', 100, 100, handle(doc, 'nw'));
  pointer('pointermove', -400, -400);
  pointer('pointerup', -400, -400);
  assert.deepEqual(calls.find((c) => c[0] === 'marker'), ['marker', 'mk_1', { x: 0, y: 0, w: 180, h: 120 }]);
});

test('a handle dragged past the other side stops at the minimum, and a release without a change sends nothing', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  select(doc, pointer);
  pointer('pointerdown', 180, 110, handle(doc, 'e'));
  pointer('pointermove', -300, 110);
  pointer('pointerup', -300, 110);
  assert.deepEqual(calls.find((c) => c[0] === 'marker'), ['marker', 'mk_1', { x: 100, y: 100, w: 6, h: 20 }]);
  calls.length = 0;
  view.render(project(), true);
  pointer('pointerdown', 180, 110, handle(doc, 'e'));
  pointer('pointerup', 180, 110);
  assert.deepEqual(calls.filter((c) => c[0] === 'marker'), []);
});

test('a cancelled resize puts the box back', () => {
  const { doc, view, calls, pointer } = setup();
  view.render(project(), true);
  select(doc, pointer);
  pointer('pointerdown', 180, 110, handle(doc, 'e'));
  pointer('pointermove', 260, 110);
  pointer('pointercancel', 260, 110);
  assert.equal(doc.querySelector('[data-marker="mk_1"] rect').getAttribute('width'), '80');
  assert.deepEqual(calls.filter((c) => c[0] === 'marker'), []);
});

test('there are no handles on a read-only board, with another tool, or on a point marker', () => {
  const { doc, view, pointer } = setup();
  view.render(project(), true);
  select(doc, pointer);
  view.render(project(), false);
  assert.equal(doc.querySelectorAll('#overlay [data-handle]').length, 0, 'read-only');
  view.render(project(), true);
  assert.equal(doc.querySelectorAll('#overlay [data-handle]').length, 8);
  doc.getElementById('tool-callout').click();
  view.render(project(), true);
  assert.equal(doc.querySelectorAll('#overlay [data-handle]').length, 0, 'other tool');
  doc.getElementById('tool-select').click();
  const point = project();
  point.markers[0] = { ...point.markers[0], shape: 'crosshair' };
  view.render(point, true);
  assert.equal(doc.querySelectorAll('#overlay [data-handle]').length, 0, 'a point has nothing to resize');
});

const callouts = () => project({ annotations: [{ id: 'an_1', assetId: 'img_1', x: 300, y: 300, lx: 360, ly: 250, text: 'U1', wiki: '' }] });
const arrow = (dom, doc, name, shiftKey = false) => {
  const event = new dom.window.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true });
  doc.getElementById('stage').dispatchEvent(event);
  return event;
};
const markerRects = (calls) => calls.filter((c) => c[0] === 'marker');

test('an arrow key moves the selected box at once and sends one event 400 ms after the last key', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(project(), true);
    select(doc, pointer);
    assert.equal(arrow(dom, doc, 'ArrowRight').defaultPrevented, true, 'the stage does not scroll');
    assert.equal(doc.querySelector('[data-marker="mk_1"] rect').getAttribute('x'), '101');
    arrow(dom, doc, 'ArrowDown');
    arrow(dom, doc, 'ArrowRight', true);
    assert.equal(doc.querySelector('[data-marker="mk_1"] rect').getAttribute('x'), '111');
    assert.deepEqual(markerRects(calls), []);
    mock.timers.tick(399);
    assert.deepEqual(markerRects(calls), []);
    mock.timers.tick(1);
    assert.deepEqual(markerRects(calls), [['marker', 'mk_1', { x: 111, y: 101 }]]);
  } finally { mock.timers.reset(); }
});

test('a key restarts the 400 ms wait', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(project(), true);
    select(doc, pointer);
    arrow(dom, doc, 'ArrowLeft');
    mock.timers.tick(300);
    arrow(dom, doc, 'ArrowLeft');
    mock.timers.tick(300);
    assert.deepEqual(markerRects(calls), []);
    mock.timers.tick(100);
    assert.deepEqual(markerRects(calls), [['marker', 'mk_1', { x: 98, y: 100 }]]);
  } finally { mock.timers.reset(); }
});

test('changing the selection sends a waiting move at once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer, key } = setup();
    view.render(project(), true);
    select(doc, pointer);
    arrow(dom, doc, 'ArrowUp', true);
    key('Escape');
    assert.deepEqual(markerRects(calls), [['marker', 'mk_1', { x: 100, y: 90 }]]);
    mock.timers.tick(1000);
    assert.equal(markerRects(calls).length, 1, 'the timer sends nothing a second time');
  } finally { mock.timers.reset(); }
});

test('a zoomed-out photo moves one screen pixel, which is more image pixels', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(project(), true);
    for (let i = 0; i < 3; i += 1) doc.getElementById('zoom-out').click();
    assert.equal(doc.getElementById('zoom-label').textContent, '50%');
    select(doc, pointer);
    arrow(dom, doc, 'ArrowRight');
    arrow(dom, doc, 'ArrowRight', true);
    mock.timers.tick(400);
    assert.deepEqual(markerRects(calls), [['marker', 'mk_1', { x: 122, y: 100 }]]);
  } finally { mock.timers.reset(); }
});

test('a box at the edge of the photo stays there, and sends nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    const edge = project();
    edge.markers[0] = { ...edge.markers[0], x: 0 };
    view.render(edge, true);
    pointer('pointerdown', 20, 110, doc.querySelector('[data-marker="mk_1"] rect'));
    pointer('pointerup', 20, 110);
    arrow(dom, doc, 'ArrowLeft', true);
    mock.timers.tick(400);
    assert.deepEqual(markerRects(calls), []);
  } finally { mock.timers.reset(); }
});

test('arrow keys move a callout, its dot and label together', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(callouts(), true);
    pointer('pointerdown', 300, 300, doc.querySelector('[data-callout="an_1"] circle'));
    pointer('pointerup', 300, 300);
    arrow(dom, doc, 'ArrowLeft', true);
    arrow(dom, doc, 'ArrowDown');
    mock.timers.tick(400);
    assert.deepEqual(calls.filter((c) => c[0] === 'callout'), [['callout', 'an_1', { x: 290, y: 301, lx: 350, ly: 251 }]]);
  } finally { mock.timers.reset(); }
});

test('a callout stops moving when its label reaches the edge, and the dot goes no further either', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(callouts(), true);
    pointer('pointerdown', 300, 300, doc.querySelector('[data-callout="an_1"] circle'));
    pointer('pointerup', 300, 300);
    for (let i = 0; i < 70; i += 1) arrow(dom, doc, 'ArrowRight', true);
    mock.timers.tick(400);
    assert.deepEqual(calls.filter((c) => c[0] === 'callout'), [['callout', 'an_1', { x: 940, y: 300, lx: 1000, ly: 250 }]]);
  } finally { mock.timers.reset(); }
});

test('arrow keys do nothing without a selection, in a text box, on a read-only board or after a reset', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(project(), true);
    assert.equal(arrow(dom, doc, 'ArrowRight').defaultPrevented, false, 'nothing selected: the stage scrolls');
    select(doc, pointer);
    const field = doc.getElementById('header-cols');
    const typed = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    field.dispatchEvent(typed);
    assert.equal(typed.defaultPrevented, false);
    view.render(project(), false);
    assert.equal(arrow(dom, doc, 'ArrowRight').defaultPrevented, false);
    view.render(project(), true);
    arrow(dom, doc, 'ArrowRight');
    view.reset();
    mock.timers.tick(1000);
    assert.deepEqual(markerRects(calls), [], 'a move for the previous board is dropped');
  } finally { mock.timers.reset(); }
});

const wheel = (dom, doc, init) => {
  const event = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  doc.getElementById('stage').dispatchEvent(event);
  return event;
};
const zoomLabel = (doc) => doc.getElementById('zoom-label').textContent;

test('zoomShift keeps the image point under the pointer in place', () => {
  assert.equal(zoomShift(300, 100, 100, 1, 2), 200, 'the point 200 px into the photo moves 200 px away');
  assert.equal(zoomShift(300, 100, 100, 2, 1), -100);
  assert.equal(zoomShift(300, 100, 100, 1, 1), 0, 'no zoom, no shift');
  assert.equal(zoomShift(100, 100, 100, 1, 4), 0, 'the photo edge under the pointer stays');
  assert.equal(zoomShift(300, 100, 40, 1, 2), 140, 'a photo that moved on the page is allowed for');
});

test('Ctrl+wheel zooms one step per notch and stops the page from zooming; a plain wheel scrolls', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  assert.equal(zoomLabel(doc), '100%');
  assert.equal(wheel(dom, doc, { deltaY: -100 }).defaultPrevented, false, 'a plain wheel is left to the stage');
  assert.equal(zoomLabel(doc), '100%');
  assert.equal(wheel(dom, doc, { deltaY: -100, ctrlKey: true }).defaultPrevented, true);
  assert.equal(zoomLabel(doc), '125%');
  wheel(dom, doc, { deltaY: 100, ctrlKey: true });
  wheel(dom, doc, { deltaY: 100, ctrlKey: true });
  assert.equal(zoomLabel(doc), '80%');
});

test('small Ctrl+wheel moves from a pinch add up to one step', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  wheel(dom, doc, { deltaY: -30, ctrlKey: true });
  assert.equal(zoomLabel(doc), '100%');
  wheel(dom, doc, { deltaY: -30, ctrlKey: true });
  assert.equal(zoomLabel(doc), '125%');
});

test('Ctrl+wheel keeps the point under the pointer by scrolling the stage', () => {
  const { dom, doc, view } = setup();
  const stage = doc.getElementById('stage');
  Object.defineProperty(stage, 'scrollLeft', { value: 0, writable: true });
  Object.defineProperty(stage, 'scrollTop', { value: 0, writable: true });
  doc.getElementById('canvas').getBoundingClientRect = () => ({ left: 100 - stage.scrollLeft, top: 50 - stage.scrollTop });
  view.render(project(), true);
  wheel(dom, doc, { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 150 });
  assert.equal(stage.scrollLeft, 50, '(300 - 100) px into the photo, 25% larger');
  assert.equal(stage.scrollTop, 25);
});

test('+ and - zoom and 0 fits, but not while typing a photo name', () => {
  const { dom, doc, view, key } = setup();
  view.render(project(), true);
  key('+');
  assert.equal(zoomLabel(doc), '125%');
  key('-');
  key('-');
  assert.equal(zoomLabel(doc), '80%');
  key('0');
  assert.equal(zoomLabel(doc), '100%');
  doc.querySelector('#photo-tabs .photo-menu-button').click();
  doc.querySelector('#photo-tabs [role="menuitem"]').click();
  const box = doc.querySelector('#photo-tabs .tab-input');
  box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
  assert.equal(zoomLabel(doc), '100%', 'the + was typed, not used');
});

test('the middle button drags the stage, and no tool starts', () => {
  const { doc, view, pointer } = setup();
  const stage = doc.getElementById('stage');
  Object.defineProperty(stage, 'scrollLeft', { value: 200, writable: true });
  Object.defineProperty(stage, 'scrollTop', { value: 100, writable: true });
  view.render(project(), true);
  doc.getElementById('tool-box').click();
  const down = new doc.defaultView.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500, clientY: 400, button: 1 });
  doc.getElementById('overlay').dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.ok(stage.classList.contains('panning'));
  pointer('pointermove', 450, 380, stage);
  assert.deepEqual([stage.scrollLeft, stage.scrollTop], [250, 120]);
  pointer('pointerup', 450, 380, stage);
  assert.equal(stage.classList.contains('panning'), false);
  assert.equal(doc.querySelector('#overlay .draft'), null, 'the Draw box tool did not start');
  pointer('pointermove', 400, 300, stage);
  assert.deepEqual([stage.scrollLeft, stage.scrollTop], [250, 120], 'after the release the pointer no longer drags');
});

test('Space turns the left button into a pan, shows a grab cursor, and releasing it ends that', () => {
  const { dom, doc, view, key, pointer } = setup();
  const stage = doc.getElementById('stage');
  Object.defineProperty(stage, 'scrollLeft', { value: 0, writable: true });
  view.render(project(), true);
  const space = (type) => {
    const event = new dom.window.KeyboardEvent(type, { key: ' ', bubbles: true, cancelable: true });
    stage.dispatchEvent(event);
    return event;
  };
  assert.equal(space('keydown').defaultPrevented, true, 'the stage does not scroll a page');
  assert.ok(stage.classList.contains('pan-ready'));
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  pointer('pointermove', 100, 110, stage);
  pointer('pointerup', 100, 110, stage);
  assert.equal(stage.scrollLeft, 20);
  assert.equal(doc.querySelector('[data-marker="mk_1"]').classList.contains('selected'), false, 'the click did not select the marker');
  space('keyup');
  assert.equal(stage.classList.contains('pan-ready'), false);
  pointer('pointerdown', 120, 110, doc.querySelector('[data-marker="mk_1"] rect'));
  assert.ok(doc.querySelector('[data-marker="mk_1"]').classList.contains('selected'), 'without Space the click selects again');
  key('Escape');
});

test('Space in a text box is still a space', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  doc.querySelector('#photo-tabs .photo-menu-button').click();
  doc.querySelector('#photo-tabs [role="menuitem"]').click();
  const typed = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  doc.querySelector('#photo-tabs .tab-input').dispatchEvent(typed);
  assert.equal(typed.defaultPrevented, false);
  assert.equal(doc.getElementById('stage').classList.contains('pan-ready'), false);
});

const file = (name, type) => ({ name, type });
function transfer(dom, doc, type, files, target = doc.getElementById('stage')) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = { types: files.length ? ['Files'] : ['text/plain'], files, dropEffect: '' };
  target.dispatchEvent(event);
  return event;
}
const uploads = (calls) => calls.filter((c) => c[0] === 'upload');

test('pickPhoto takes the first JPEG, PNG or WebP and says so when it ignored others', () => {
  const jpg = file('a.jpg', 'image/jpeg'), png = file('b.png', 'image/png'), gif = file('c.gif', 'image/gif');
  assert.deepEqual(pickPhoto([jpg]), { file: jpg, notice: null });
  assert.deepEqual(pickPhoto([gif, png]), { file: png, notice: 'Added the first photo only.' });
  assert.deepEqual(pickPhoto([jpg, png]), { file: jpg, notice: 'Added the first photo only.' });
  assert.equal(pickPhoto([file('d.webp', 'image/webp')]).file.name, 'd.webp');
  assert.deepEqual(pickPhoto([gif]), { file: null, notice: 'Use a JPEG, PNG or WebP photo.' });
  assert.deepEqual(pickPhoto([file('e.txt', '')]), { file: null, notice: 'Use a JPEG, PNG or WebP photo.' });
  assert.equal(pickPhoto([]).file, null);
});

test('a file dragged over the stage shows the outline and the hint, and leaving hides them', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  const hint = doc.getElementById('drop-hint');
  assert.equal(hint.hidden, true);
  assert.equal(hint.textContent, 'Drop the photo to add it');
  const over = transfer(dom, doc, 'dragenter', [file('a.jpg', 'image/jpeg')]);
  assert.equal(over.defaultPrevented, true, 'the drop is allowed');
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.equal(hint.hidden, false);
  assert.ok(hint.parentElement.classList.contains('drop-ready'));
  transfer(dom, doc, 'dragenter', [file('a.jpg', 'image/jpeg')], doc.getElementById('photo'));   // over a child
  transfer(dom, doc, 'dragleave', [file('a.jpg', 'image/jpeg')], doc.getElementById('photo'));
  assert.equal(hint.hidden, false, 'still over the stage');
  transfer(dom, doc, 'dragleave', [file('a.jpg', 'image/jpeg')]);
  assert.equal(hint.hidden, true);
  assert.equal(hint.parentElement.classList.contains('drop-ready'), false);
});

test('something dragged that is not a file shows nothing', () => {
  const { dom, doc, view } = setup();
  view.render(project(), true);
  const over = transfer(dom, doc, 'dragover', []);
  assert.equal(over.defaultPrevented, false);
  assert.equal(doc.getElementById('drop-hint').hidden, true);
});

test('dropping a photo uploads it the way Add photo does, and shows the new photo', async () => {
  const { dom, doc, view, calls } = setup();
  view.render(project(), true);
  const photo = file('a.jpg', 'image/jpeg');
  const drop = transfer(dom, doc, 'drop', [photo]);
  assert.equal(drop.defaultPrevented, true, 'the browser does not open the file');
  await tick();
  assert.deepEqual(uploads(calls), [['upload', photo]]);
  assert.equal(doc.getElementById('drop-hint').hidden, true);
});

test('a drop of two photos adds the first and says so; a drop of a wrong type adds nothing and says so', async () => {
  const notices = [];
  const { dom, doc, view, calls } = setup({ onNotice: (text) => notices.push(text) });
  view.render(project(), true);
  const first = file('a.jpg', 'image/jpeg');
  transfer(dom, doc, 'drop', [first, file('b.png', 'image/png')]);
  await tick();
  assert.deepEqual(uploads(calls), [['upload', first]]);
  assert.deepEqual(notices, ['Added the first photo only.']);
  transfer(dom, doc, 'drop', [file('c.gif', 'image/gif')]);
  await tick();
  assert.equal(uploads(calls).length, 1);
  assert.deepEqual(notices.at(-1), 'Use a JPEG, PNG or WebP photo.');
});

test('a drop on a read-only board is taken, so the browser stays, but nothing is uploaded', async () => {
  const { dom, doc, view, calls } = setup();
  view.render(project(), false);
  const over = transfer(dom, doc, 'dragover', [file('a.jpg', 'image/jpeg')]);
  assert.equal(over.defaultPrevented, true);
  assert.equal(doc.getElementById('drop-hint').hidden, true, 'no hint where nothing can be dropped');
  assert.equal(transfer(dom, doc, 'drop', [file('a.jpg', 'image/jpeg')]).defaultPrevented, true);
  await tick();
  assert.deepEqual(uploads(calls), []);
});

test('a refused upload of a dropped photo shows the service reason through the controller path', async () => {
  const notices = [];
  const { dom, doc, view } = setup({ onNotice: (text) => notices.push(text), onUploadPhoto: () => Promise.resolve(null) });
  view.render(project(), true);
  transfer(dom, doc, 'drop', [file('a.jpg', 'image/jpeg')]);
  await tick();
  assert.deepEqual(notices, [], 'the view adds no message of its own; the controller shows the service text');
});

const paste = (dom, doc, files, target = doc.getElementById('stage')) => {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { files };
  target.dispatchEvent(event);
  return event;
};

test('pasting an image in the photo panel uploads it', async () => {
  const { dom, doc, view, calls } = setup();
  view.render(project(), true);
  const shot = file('image.png', 'image/png');
  assert.equal(paste(dom, doc, [shot]).defaultPrevented, true);
  await tick();
  assert.deepEqual(uploads(calls), [['upload', shot]]);
});

test('pasting text, or pasting on a read-only board, uploads nothing', async () => {
  const { dom, doc, view, calls } = setup();
  view.render(project(), true);
  assert.equal(paste(dom, doc, []).defaultPrevented, false, 'text pastes as usual');
  assert.equal(paste(dom, doc, [file('x.txt', 'text/plain')]).defaultPrevented, false);
  view.render(project(), false);
  paste(dom, doc, [file('image.png', 'image/png')]);
  await tick();
  assert.deepEqual(uploads(calls), []);
});

test('pasting a GIF says which types work', async () => {
  const notices = [];
  const { dom, doc, view, calls } = setup({ onNotice: (text) => notices.push(text) });
  view.render(project(), true);
  paste(dom, doc, [file('x.gif', 'image/gif')]);
  await tick();
  assert.deepEqual(notices, ['Use a JPEG, PNG or WebP photo.']);
  assert.deepEqual(uploads(calls), []);
});

test('a redraw keeps the focus on the photo tab or menu button it was on', () => {
  const { doc, view } = setup();
  view.render(project(), true);
  menuButton(doc).focus();
  view.render(project({ meta: { name: 'Renamed elsewhere' } }), true);
  assert.equal(doc.activeElement, menuButton(doc), 'the menu button');
  doc.querySelector('#photo-tabs .tab').focus();
  view.render(project(), true);
  assert.equal(doc.activeElement, doc.querySelector('#photo-tabs .tab'), 'the tab');
});

test('arrow keys inside the photo menu move the menu, not the selected marker', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(project(), true);
    select(doc, pointer);
    menuButton(doc).click();
    press(dom, doc.activeElement, 'ArrowDown');
    press(dom, doc.activeElement, 'ArrowRight');
    mock.timers.tick(1000);
    assert.deepEqual(markerRects(calls), []);
  } finally { mock.timers.reset(); }
});

test('a redraw while the photo menu is open closes it and keeps the focus on its button', () => {
  const { doc, view } = setup();
  view.render(project(), true);
  menuButton(doc).click();
  view.render(project({ meta: { name: 'Changed elsewhere' } }), true);
  assert.equal(items(doc).length, 0);
  assert.equal(doc.activeElement, menuButton(doc));
});

test('choosing a menu item puts the focus back on the menu button first', () => {
  const ctx = setup();
  ctx.dom.window.confirm = () => false;
  ctx.view.render(project(), true);
  menuButton(ctx.doc).click();
  items(ctx.doc).at(-1).click();
  assert.equal(ctx.doc.activeElement, menuButton(ctx.doc));
});

test('the first-photo-only notice comes after the upload worked, and not when it was refused', async () => {
  const notices = [];
  let result = 'img_2';
  const { dom, doc, view } = setup({ onNotice: (text) => notices.push(text), onUploadPhoto: () => Promise.resolve(result) });
  view.render(project(), true);
  const two = [file('a.jpg', 'image/jpeg'), file('b.png', 'image/png')];
  result = null;
  transfer(dom, doc, 'drop', two);
  await tick();
  assert.deepEqual(notices, [], 'a refused upload says nothing about a photo being added');
  result = 'img_2';
  transfer(dom, doc, 'drop', two);
  await tick();
  assert.deepEqual(notices, ['Added the first photo only.']);
});

test('a rename finished after the board turned read-only sends nothing', () => {
  const ctx = setup();
  const input = startRename(ctx);
  input.value = 'Too late';
  input.dispatchEvent(new ctx.dom.window.Event('input'));
  ctx.view.render(project(), false);
  press(ctx.dom, ctx.doc.querySelector('#photo-tabs .tab-input') ?? input, 'Enter');
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'asset'), []);
});

test('a waiting arrow-key move is not sent once the board is read-only', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { dom, doc, view, calls, pointer } = setup();
    view.render(project(), true);
    select(doc, pointer);
    arrow(dom, doc, 'ArrowRight');
    view.render(project(), false);
    mock.timers.tick(400);
    assert.deepEqual(markerRects(calls), []);
  } finally { mock.timers.reset(); }
});

test('a callout label at the right edge of the photo is drawn to the left of its anchor', () => {
  const { doc, view } = setup();
  view.render(project({ annotations: [{ id: 'an_e', assetId: 'img_1', x: 900, y: 100, lx: 960, ly: 100, text: 'SPI flash 25Q128' }] }), true);
  const box = doc.querySelector('[data-callout="an_e"] rect');
  assert.ok(Number(box.getAttribute('x')) + Number(box.getAttribute('width')) <= 960, 'the label ends at its anchor');
});
