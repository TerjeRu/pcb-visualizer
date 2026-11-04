import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createPlaybookView } from '../js/playbookview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const playbooks = [{
  id: 'pb', title: 'Test playbook', summary: 'S', requires: [],
  steps: [
    { id: 'a', title: 'First', why: 'Because **reasons**.', do: '1. Do it', gates: [{ id: 'safe', text: 'Unplugged', destructive: false }],
      ask: [{ id: 'soc', label: 'SoC marking', required: true }], checks: [{ kind: 'meta', field: 'device', text: 'Device filled in' }], wiki: ['uart'] },
    { id: 'b', title: 'Second', why: 'w', do: 'd', gates: [], ask: [], checks: [], wiki: [] },
  ],
}];
const project = (extra = {}) => ({ meta: { name: 'B', device: '' }, assets: [], markers: [], schematics: [], components: [], ...extra });

function setup(answer = () => true) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.document.getElementById('panel-store').hidden = false;   // as after the layout starts
  const doc = dom.window.document;
  doc.getElementById('board-panel').hidden = false;
  const calls = [];
  const view = createPlaybookView(doc, {
    onPlaybookUpdate: async (...args) => { calls.push(['update', ...args]); return answer(...args); },
    loadWikiPage: async (name) => { calls.push(['page', name]); return { name, title: 'UART', markdown: '# UART\n\nTwo wires and **ground**.' }; },
    onOpenWiki: (name) => calls.push(['wiki', name]),
  });
  view.setPlaybooks(playbooks, []);
  return { dom, doc, view, calls };
}

test('the first open step is shown with its text, gates, questions and checks', () => {
  const { doc, view } = setup();
  view.render(project(), true);
  assert.equal(doc.querySelector('#step-detail h3').textContent, '1. First');
  assert.equal(doc.querySelector('#step-detail .md strong').textContent, 'reasons');
  assert.equal(doc.querySelectorAll('.step[data-state="locked"]').length, 1);
  assert.equal(doc.querySelector('.checks li').className, 'todo');
  assert.equal(doc.getElementById('step-complete').disabled, true);
});

test('ticking a gate and answering send progress for that step', () => {
  const { dom, doc, view, calls } = setup();
  view.render(project(), true);
  const box = doc.querySelector('.gate input');
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change'));
  const input = doc.querySelector('[data-ask="soc"]');
  input.value = ' ARC7621 ';
  input.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(calls.filter((c) => c[0] === 'update'), [
    ['update', 'pb', 'a', { gates: { safe: true } }],
    ['update', 'pb', 'a', { answers: { soc: 'ARC7621' } }],
  ]);
});

test('a ready step can be completed and the panel moves on', async () => {
  const { doc, view, calls } = setup();
  const ready = project({ meta: { device: 'X' }, playbooks: { pb: { steps: { a: { gates: { safe: true }, answers: { soc: 'ARC' } } } } } });
  view.render(ready, true);
  const button = doc.getElementById('step-complete');
  assert.equal(button.disabled, false);
  button.click();
  await new Promise((r) => setTimeout(r, 0));
  const [, id, step, patch] = calls.at(-1);
  assert.deepEqual([id, step], ['pb', 'a']);
  assert.match(patch.done, /^\d{4}-\d\d-\d\dT/);
  assert.equal(doc.querySelector('#step-detail h3').textContent, '2. Second');
});

test('a half-typed answer survives an incoming event', () => {
  const { doc, view } = setup();
  view.render(project(), true);
  const input = doc.querySelector('[data-ask="soc"]');
  input.focus();
  input.value = 'ARC76';
  view.render(project({ meta: { device: 'changed elsewhere' } }), true);
  const again = doc.querySelector('[data-ask="soc"]');
  assert.equal(again.value, 'ARC76');
  assert.equal(doc.activeElement, again);
});

test('expert opens every step, folds the explanations away and keeps only destructive gates', () => {
  const { doc, view } = setup();
  view.render(project({ meta: { name: 'B', device: '', mode: 'expert' } }), true);
  assert.equal(doc.querySelectorAll('.step[data-state="locked"]').length, 1, "an old board's own mode is ignored");
  assert.ok(doc.querySelector('#step-detail .gates'), 'guided shows every safety point');

  view.setGuidance('expert');
  assert.equal(doc.querySelectorAll('.step[data-state="locked"]').length, 0);
  const more = doc.querySelector('#step-detail details.step-more');
  assert.equal(more.open, false);
  assert.equal(more.querySelector('summary').textContent, 'Details');
  assert.equal(more.querySelector('.md strong').textContent, 'reasons');
  assert.equal(doc.querySelector('#step-detail .gates'), null, 'a plain safety point is not shown');
  assert.deepEqual([...doc.querySelectorAll('#step-detail .step-notes li')].map((li) => li.textContent), ['Some checks do not pass.']);
  assert.equal(doc.getElementById('step-complete').disabled, false);
});

test('load problems are listed and untrusted playbook text stays text', () => {
  const { doc, view } = setup();
  const evil = [{ ...playbooks[0], title: '<img src=x>', steps: [{ ...playbooks[0].steps[0], why: '<img src=x onerror=alert(1)>' }] }];
  view.setPlaybooks(evil, [{ file: '/home/x/hw/playbooks/bad.yaml', message: 'unknown key titel' }]);
  view.render(project(), true);
  assert.equal(doc.getElementById('playbook-problems').hidden, false);
  assert.equal(doc.querySelector('#playbook-problems li').textContent, 'bad.yaml: unknown key titel');
  assert.equal(doc.querySelectorAll('#playbook-body img').length, 0);
});


test('guided mode shows the wiki page of the step as an open Background section; expert does not', async () => {
  const { doc, view, calls } = setup();
  view.render(project(), true);
  let bg = doc.querySelector('#step-detail details.background');
  assert.ok(bg, 'background section is there in guided mode');
  await new Promise((r) => setTimeout(r, 0));
  bg = doc.querySelector('#step-detail details.background');
  assert.equal(bg.open, true);
  assert.equal(bg.querySelector('summary').textContent, 'Background: UART');
  assert.equal(bg.querySelector('.md strong').textContent, 'ground');
  assert.equal(bg.querySelector('.md h2'), null, 'the page title is not repeated');
  assert.equal(calls.filter((c) => c[0] === 'page').length, 1, 'loaded once');

  bg.open = false;
  bg.dispatchEvent(new doc.defaultView.Event('toggle'));
  view.render(project(), true);
  assert.equal(doc.querySelector('#step-detail details.background').open, false, 'closing is remembered');

  view.setGuidance('expert');
  assert.equal(doc.querySelector('#step-detail details.background'), null);
});

test('a playbook without steps says so instead of failing', () => {
  const { dom, doc, view } = setup();
  view.setPlaybooks([{ id: 'empty', title: 'Empty', summary: 'Nothing yet', requires: [], steps: [] }], []);
  view.render(project(), true);
  assert.match(doc.getElementById('step-detail').textContent, /This playbook has no steps/);
  assert.equal(doc.querySelectorAll('#step-list li').length, 0);
  assert.equal(doc.getElementById('playbook-summary').textContent, 'Nothing yet');
  view.setPlaybooks(playbooks, []);
  assert.equal(doc.querySelector('#step-detail h3')?.textContent, '1. First', 'a playbook with steps draws again');
  assert.ok(dom);
});

test('in the desktop shell a link in a step asks and then opens through the shell', async () => {
  const { doc, view } = setup();
  const linked = [{ ...playbooks[0], steps: [{ ...playbooks[0].steps[0], why: 'Read [the datasheet](https://example.org/ds).' }, playbooks[0].steps[1]] }];
  view.setPlaybooks(linked, []);
  const win = doc.defaultView;
  const invoked = [];
  win.__TAURI__ = { core: { invoke: async (...args) => { invoked.push(args); } } };
  win.confirm = () => true;
  view.render(project(), true);
  doc.querySelector('#step-detail .md a').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(invoked, [['open_link', { url: 'https://example.org/ds' }]]);
});

test('Start this playbook over appears only with progress, asks inline, and Cancel or Esc sends nothing', () => {
  const { doc, view, calls, dom } = setup();
  view.render(project({ playbooks: { pb: { steps: { a: { answers: { soc: 'X' } } } } } }), true);
  assert.equal(doc.getElementById('playbook-restart').hidden, true, 'answers alone are not progress');

  view.render(project({ playbooks: { pb: { steps: { a: { gates: { safe: true } } } } } }), true);
  assert.equal(doc.getElementById('playbook-restart').hidden, false);
  doc.getElementById('playbook-restart-ask').click();
  assert.equal(doc.activeElement.id, 'playbook-restart-confirm');
  assert.match(doc.getElementById('playbook-restart').textContent, /keeps what you wrote under Write down/);
  doc.querySelector('#playbook-restart button:not(.primary)').click();
  assert.equal(doc.activeElement.id, 'playbook-restart-ask');

  doc.getElementById('playbook-restart-ask').click();
  doc.getElementById('playbook-restart-confirm').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.getElementById('playbook-restart-confirm'), null);
  assert.equal(calls.filter((c) => c[0] === 'update').length, 0);
});

test('Start over clears done marks and ticks step by step, keeps answers, and shows the first step', async () => {
  const { doc, view, calls } = setup();
  view.render(project({ meta: { name: 'B', device: 'Router' }, playbooks: { pb: { steps: {
    a: { gates: { safe: true }, answers: { soc: 'X' }, done: '2026-11-01T00:00:00Z' },
    b: { done: '2026-11-01T00:00:00Z' },
  } } } }), true);
  doc.getElementById('playbook-restart-ask').click();
  doc.getElementById('playbook-restart-confirm').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.filter((c) => c[0] === 'update'), [
    ['update', 'pb', 'a', { done: null, gates: {} }],
    ['update', 'pb', 'b', { done: null, gates: {} }],
  ]);
  assert.equal(doc.querySelector('#step-detail h3').textContent, '1. First');
});

test('Start over stops at the first change the service refuses', async () => {
  const { doc, view, calls } = setup(() => false);
  view.render(project({ playbooks: { pb: { steps: { a: { done: 'x' }, b: { done: 'x' } } } } }), true);
  doc.getElementById('playbook-restart-ask').click();
  doc.getElementById('playbook-restart-confirm').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.filter((c) => c[0] === 'update').map((c) => c[2]), ['a']);
});

test('Start over is disabled on a read-only board', () => {
  const { doc, view } = setup();
  view.render(project({ playbooks: { pb: { steps: { a: { done: 'x' } } } } }), false);
  assert.equal(doc.getElementById('playbook-restart-ask').disabled, true);
});

test('Start over sends once, to the playbook it started on, and keeps focus across a board update', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { doc, view, calls } = setup(() => gate);
  const state = project({ playbooks: { pb: { steps: { a: { done: 'x' }, b: { done: 'x' } } } } });
  view.render(state, true);
  doc.getElementById('playbook-restart-ask').click();
  doc.getElementById('playbook-restart-cancel').focus();
  view.render(state, true);
  assert.equal(doc.activeElement.id, 'playbook-restart-cancel', 'a redraw keeps focus in the row');
  const yes = doc.getElementById('playbook-restart-confirm');
  yes.click();
  yes.click();
  assert.equal(calls.filter((c) => c[0] === 'update').length, 1, 'a second press sends nothing');
  release(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.filter((c) => c[0] === 'update').map((c) => c.slice(1, 3)), [['pb', 'a'], ['pb', 'b']]);
});
