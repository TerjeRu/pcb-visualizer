import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createBoardView } from '../js/boardview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
    onUpdateMarker: record('marker'),
    onRemoveMarker: record('remove'),
    onUpdateSchematic: record('schematic'),
    onUpdatePin: record('pin'),
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
  assert.equal(group.querySelector('text').textContent, 'SoC ?');
  assert.deepEqual(['x1', 'y1', 'x2', 'y2'].map((k) => Number(group.querySelector('line').getAttribute(k))), [500, 250, 600, 200]);
  pointer('pointerdown', 610, 200, group.querySelector('.label text'));
  pointer('pointermove', 650, 150);
  pointer('pointerup', 650, 150);
  assert.deepEqual(calls.find((c) => c[0] === 'callout'), ['callout', 'an_1', { lx: 640, ly: 150 }]);
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
