import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createView } from '../js/ui.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides = {}, { reduced = false } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const { document: doc } = window;
  window.matchMedia = (query) => ({ matches: reduced && query.includes('reduce'), addEventListener() {}, removeEventListener() {} });
  const calls = [];
  const saved = [];
  const timers = { items: [], set(fn, ms) { timers.items.push({ fn, ms }); return timers.items.length; }, clear(h) { if (timers.items[h - 1]) timers.items[h - 1].cleared = true; } };
  const handlers = {
    tutorialNext: () => calls.push(['next']),
    tutorialBack: () => calls.push(['back']),
    leaveTutorial: () => calls.push(['leave']),
    askLeaveTutorial: () => calls.push(['ask']),
    tutorialFinishCreate: () => calls.push(['create']),
    loadWorkspaces: async () => null,
    saveWorkspaces: async (data) => { saved.push(data); },
    loadWikiPage: async (name) => ({ name, title: name, origin: 'builtin', markdown: `# ${name}` }),
    loadWikiIndex: async () => [],
    ...overrides,
  };
  const view = createView(doc, handlers, timers, {});
  view.setAssistant('on');
  doc.getElementById('board-panel').hidden = false;
  return { doc, view, calls, saved, timers, window };
}
const $ = (doc, id) => doc.getElementById(id);
const stepModel = (extra = {}) => ({
  kind: 'step', moved: false, step: 3, total: 18, chapter: 0, title: 'Mark the candidate', body: ['One.', 'Two.'],
  tasks: [{ id: 'marked', text: 'Draw a box marker', done: false }], hint: '', canContinue: false, canBack: true, last: false,
  why: ['Because.'], wiki: 'headers', ...extra,
});

test('the coach shows the step, its tasks and the five chapters, and keeps Continue off until the task is done', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  assert.equal($(doc, 'tutorial-panel').hidden, false);
  view.tutorialDraw(stepModel());
  assert.equal($(doc, 'tutorial-step-title').textContent, 'Mark the candidate');
  assert.equal($(doc, 'tutorial-position').textContent, 'Step 3 of 18');
  assert.deepEqual([...doc.querySelectorAll('#tutorial-chapters li')].map((li) => li.firstChild.textContent), ['Find', 'Measure', 'Connect', 'Get in', 'Verify']);
  assert.equal(doc.querySelector('#tutorial-chapters [aria-current="step"]').textContent, 'Find');
  assert.deepEqual([...doc.querySelectorAll('#tutorial-text p')].map((p) => p.textContent), ['One.', 'Two.']);
  assert.equal($(doc, 'tutorial-tasks').children[0].getAttribute('aria-label'), 'Not yet: Draw a box marker');
  assert.equal($(doc, 'tutorial-continue').disabled, true);
  assert.equal($(doc, 'tutorial-show'), null, 'there is no Show me button');
  assert.equal($(doc, 'tutorial-back').disabled, false);
  assert.equal($(doc, 'tutorial-hint').hidden, true);
  assert.equal($(doc, 'tutorial-why').open, false, 'Why this step starts closed');
  assert.equal($(doc, 'tutorial-why-link').dataset.wiki, 'headers');

  view.tutorialDraw(stepModel({ canContinue: true, tasks: [{ id: 'marked', text: 'Draw a box marker', done: true }], chapter: 1 }));
  assert.equal($(doc, 'tutorial-continue').disabled, false);
  assert.equal($(doc, 'tutorial-note').textContent, 'Step done.', 'announced once');
  assert.equal($(doc, 'tutorial-tasks').children[0].getAttribute('aria-label'), 'Done: Draw a box marker');
  assert.equal(doc.querySelector('#tutorial-chapters li').querySelector('.visually-hidden').textContent, ' (done)');
  $(doc, 'tutorial-continue').click();
  $(doc, 'tutorial-back').click();
});

test('the buttons report to the controller', async () => {
  const { doc, view, calls } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ canContinue: true }));
  $(doc, 'tutorial-continue').click();
  $(doc, 'tutorial-back').click();
  assert.deepEqual(calls.map((c) => c[0]), ['next', 'back']);
});

test('Enter outside a control continues once the step is done; on a button it does not', async () => {
  const { doc, view, calls, window } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel());
  const enter = (target) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  enter($(doc, 'tutorial-step-title'));
  assert.equal(calls.length, 0, 'not while the step is open');
  view.tutorialDraw(stepModel({ canContinue: true }));
  enter($(doc, 'tutorial-back'));
  assert.equal(calls.length, 0, 'a focused button keeps its own Enter');
  enter($(doc, 'tutorial-step-title'));
  assert.deepEqual(calls, [['next']]);
});

test('a hint appears in a polite status line only when there is one', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ hint: 'The box is not on the header yet.' }));
  assert.equal($(doc, 'tutorial-hint').textContent, 'The box is not on the header yet.');
  assert.equal($(doc, 'tutorial-hint').hidden, false);
  assert.equal($(doc, 'tutorial-hint').getAttribute('role'), 'status');
  assert.equal($(doc, 'tutorial-hint').getAttribute('aria-live'), 'polite');
  view.tutorialDraw(stepModel());
  assert.equal($(doc, 'tutorial-hint').hidden, true);
  view.tutorialSay('Not needed for this step.');
  assert.equal($(doc, 'tutorial-note').textContent, 'Not needed for this step.');
});

test('a step with moved: true puts focus on its title; a redraw of the same step does not', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ moved: true }));
  assert.equal(doc.activeElement, $(doc, 'tutorial-step-title'));
  $(doc, 'tutorial-back').focus();
  view.tutorialDraw(stepModel({ moved: true }));
  assert.equal(doc.activeElement, $(doc, 'tutorial-back'));
});

test('entering locks the top bar except the way out, forces Guided and shows the leave button', async () => {
  const { doc, view } = setup();
  view.setGuidance('expert');
  assert.equal(doc.documentElement.dataset.guidance, 'expert');
  await view.tutorialEnter(['photo']);
  assert.equal(doc.documentElement.dataset.tutorial, 'on');
  assert.equal(doc.documentElement.dataset.guidance, 'guided', 'Expert is locked to Guided');
  const bar = [...doc.querySelector('header.bar').children];
  const inert = bar.filter((n) => n.hasAttribute('inert')).map((n) => n.id || n.className);
  assert.ok(inert.length >= 6, inert.join());
  for (const id of ['board-field', 'new-board-form', 'workspace-bar', 'settings-open']) assert.equal($(doc, id).hasAttribute('inert') || Boolean($(doc, id).closest('[inert]')), true, id);
  assert.ok($(doc, 'panels-open').closest('[inert]'), 'the Panels menu button');
  assert.ok($(doc, 'guidance-guided').closest('[inert]'));
  assert.equal($(doc, 'guidance-guided').closest('.segmented').title, 'Locked while the tutorial runs');
  assert.equal($(doc, 'tutorial-leave').hidden, false);
  assert.equal($(doc, 'tutorial-leave').closest('[inert]'), null, 'the way out is not locked');
  assert.equal(doc.querySelector('header.bar h1').hasAttribute('inert'), false);
  $(doc, 'tutorial-leave').click();
});

test('leaving puts the bar, the panels and the Expert level back', async () => {
  const { doc, view } = setup();
  view.setGuidance('expert');
  await view.tutorialEnter(['photo']);
  view.setGuidance('guided');
  view.tutorialLeave();
  assert.equal(doc.documentElement.dataset.tutorial, undefined);
  assert.equal(doc.querySelectorAll('header.bar [inert]').length, 0);
  assert.equal($(doc, 'tutorial-panel').hidden, true);
  assert.equal($(doc, 'tutorial-leave').hidden, true);
  assert.equal(doc.documentElement.dataset.guidance, 'guided', 'the level set while locked was saved');
  assert.equal($(doc, 'guidance-guided').closest('.segmented').title, '');
});

test('the saved Guided or Expert level keeps its value while locked and applies after', async () => {
  const { doc, view } = setup();
  view.setGuidance('guided');
  await view.tutorialEnter(['photo']);
  view.setGuidance('expert');
  assert.equal(doc.documentElement.dataset.guidance, 'guided');
  view.tutorialLeave();
  assert.equal(doc.documentElement.dataset.guidance, 'expert');
});

test('the tutorial layout shows the step panels and the Wiki only, and nothing is saved', async () => {
  const { doc, view, saved } = setup();
  view.startLayout();
  await flush();
  await view.tutorialEnter(['photo']);
  const centre = doc.querySelector('#region-center .region-body');
  assert.ok(centre.contains($(doc, 'panel-photo')));
  assert.ok(centre.contains($(doc, 'panel-wiki')));
  assert.equal($(doc, 'panel-photo').hidden, false);
  assert.equal($(doc, 'panel-wiki').hidden, true, 'a tab behind the photo');
  for (const panel of ['playbook', 'console', 'logic', 'terminal', 'timeline', 'board', 'inspector', 'feed', 'assistant']) {
    assert.equal($(doc, `panel-${panel}`).closest('#panel-store') !== null, true, `${panel} is put away`);
  }
  await view.tutorialLayout(['photo', 'inspector']);
  assert.ok(doc.querySelector('#region-left .region-body').contains($(doc, 'panel-inspector')));
  assert.equal($(doc, 'panel-inspector').hidden, false);
  assert.equal(doc.querySelector('#region-right').classList.contains('empty'), true);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(saved.some((s) => JSON.stringify(s).includes('inspector') && s.current === 'Learn' && s.saved?.Learn?.away?.includes('playbook')), false, 'the tutorial layout is never saved as a workspace');
});

test('leaving gives the layout back, windows included', async () => {
  const handles = [];
  const opened = [];
  const { doc, view } = setup({
    loadWorkspaces: async () => ({ current: 'Wall', saved: {} }),
    findShellWindow: () => { const h = { closed: false, close() { this.closed = true; }, focus() {} }; handles.push(h); return h; },
    openPanelWindow: (panel) => { const h = { closed: false, close() { this.closed = true; }, focus() {} }; opened.push(panel); handles.push(h); return h; },
  });
  view.startLayout();
  await flush();
  await flush();
  assert.ok($(doc, 'panel-console').closest('#panel-store'), 'Wall keeps the console in its own window');
  await view.tutorialEnter(['photo']);
  assert.ok(handles.every((h) => h.closed), 'detached windows closed for the tutorial');
  assert.ok(doc.querySelector('#region-center .region-body').contains($(doc, 'panel-photo')));
  view.tutorialLeave();
  assert.ok(opened.includes('console'), 'the console window is reopened');
  assert.ok(doc.querySelector('#region-left .region-body').contains($(doc, 'panel-inspector')));
  for (const handle of handles) handle.closed = true;      // the dock's watchers stop on their next tick
  await new Promise((resolve) => setTimeout(resolve, 1100));
});

test('while the tutorial runs the panels cannot be moved, dragged or found in the Panels menu', async () => {
  const { doc, view, window } = setup();
  view.startLayout();
  await flush();
  await view.tutorialEnter(['photo']);
  const shortcut = new window.KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  doc.dispatchEvent(shortcut);
  assert.equal(doc.querySelector('.panels-menu'), null, 'Ctrl+Shift+P does nothing');
  const tab = doc.querySelector('#region-center .region-tab');
  const drag = new window.Event('dragstart', { bubbles: true, cancelable: true });
  tab.dispatchEvent(drag);
  assert.equal(drag.defaultPrevented, true, 'a tab cannot be dragged');
  const before = [...doc.querySelectorAll('#region-left .panel, #region-center .region-body > .panel')].map((n) => n.id);
  const drop = new window.Event('drop', { bubbles: true, cancelable: true });
  drop.dataTransfer = { getData: () => 'playbook', types: ['application/x-pcbv-panel'] };
  doc.querySelector('#region-center .region-body').dispatchEvent(drop);
  assert.deepEqual([...doc.querySelectorAll('#region-left .panel, #region-center .region-body > .panel')].map((n) => n.id), before);
  view.tutorialLeave();
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  assert.ok(doc.querySelector('.panels-menu'), 'the menu works again afterwards');
});

test('Leave asks inline, names the step to resume at and defaults to Stay; a second Esc leaves', async () => {
  const { doc, view, calls, window } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ step: 7 }));
  $(doc, 'tutorial-leave').click();
  assert.deepEqual(calls.at(-1), ['ask']);
  view.tutorialAskLeave(7);
  assert.equal($(doc, 'tutorial-leave-ask').hidden, false);
  assert.equal($(doc, 'tutorial-leave-text').textContent, 'Leave the tutorial? You can resume at step 7 or start again from Settings.');
  assert.equal(doc.activeElement, $(doc, 'tutorial-leave-no'));
  $(doc, 'tutorial-leave-no').click();
  assert.equal($(doc, 'tutorial-leave-ask').hidden, true);
  assert.equal(calls.some((c) => c[0] === 'leave'), false, 'Stay leaves nothing');
  view.tutorialAskLeave(7);
  $(doc, 'tutorial-leave-yes').click();
  assert.deepEqual(calls.at(-1), ['leave']);

  const esc = () => $(doc, 'tutorial-step-title').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  calls.length = 0;
  esc();
  assert.equal($(doc, 'tutorial-leave-ask').hidden, false, 'the first Esc asks');
  assert.equal(calls.length, 0);
  esc();
  assert.deepEqual(calls, [['leave']], 'the second Esc leaves');
});

test('the tick does not animate under reduced motion', async () => {
  const { doc, view } = setup({}, { reduced: true });
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ tasks: [{ id: 'a', text: 'A', done: false }] }));
  view.tutorialDraw(stepModel({ tasks: [{ id: 'a', text: 'A', done: true }] }));
  assert.equal($(doc, 'tutorial-tasks').children[0].classList.contains('tick'), false);
  const calm = setup();
  await calm.view.tutorialEnter(['photo']);
  calm.view.tutorialDraw(stepModel({ tasks: [{ id: 'a', text: 'A', done: false }] }));
  calm.view.tutorialDraw(stepModel({ tasks: [{ id: 'a', text: 'A', done: true }] }));
  assert.equal($(calm.doc, 'tutorial-tasks').children[0].classList.contains('tick'), true);
  calm.view.tutorialDraw(stepModel({ tasks: [{ id: 'a', text: 'A', done: true }] }));
  assert.equal($(calm.doc, 'tutorial-tasks').children[0].classList.contains('tick'), false, 'only a new tick animates');
});

test('the closing page lists what was done and shows the next steps only when the tutorial is complete', async () => {
  const { doc, view, calls } = setup({ onOpenWiki: () => {} });
  await view.tutorialEnter(['photo']);
  const finish = { kind: 'finish', moved: true, complete: true, step: 18, total: 18, chapter: 4, title: 'You found the UART', lead: 'Lead.', lines: ['Found the UART header and marked it J4'], where: 'Stays here.' };
  view.tutorialDraw(finish);
  assert.equal($(doc, 'tutorial-step').hidden, true);
  assert.equal($(doc, 'tutorial-finish').hidden, false);
  assert.equal($(doc, 'tutorial-position').textContent, 'Finished');
  assert.equal($(doc, 'tutorial-finish-list').textContent, '✓Found the UART header and marked it J4');
  assert.equal($(doc, 'tutorial-finish-create').hidden, false);
  assert.equal($(doc, 'tutorial-continue').hidden, true);
  assert.equal(doc.activeElement, $(doc, 'tutorial-finish-title'));
  $(doc, 'tutorial-finish-create').click();
  assert.deepEqual(calls.at(-1), ['create']);
  view.tutorialDraw({ ...finish, complete: false, step: 4, title: 'That is all for now', moved: false });
  assert.equal($(doc, 'tutorial-finish-create').hidden, true);
  assert.equal($(doc, 'tutorial-finish-needs').hidden, true);
  assert.equal($(doc, 'tutorial-position').textContent, 'Step 4 of 18');
  view.tutorialDraw(stepModel());
  assert.equal($(doc, 'tutorial-finish').hidden, true);
  assert.equal($(doc, 'tutorial-continue').hidden, false);
});

test('the lesson text is set as text, never as markup', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ title: '<img src=x onerror=alert(1)>', body: ['<b>bold</b>'], hint: '<i>x</i>', tasks: [{ id: 'a', text: '<u>u</u>', done: false }], why: ['<s>s</s>'] }));
  assert.equal($(doc, 'tutorial-panel').querySelector('img, b, i, u, s'), null);
  assert.equal($(doc, 'tutorial-step-title').textContent, '<img src=x onerror=alert(1)>');
});

test('every control the lessons name exists in the page', async () => {
  const { LESSONS } = await import('../js/core/tutorial/lessons.js');
  const { buildFacts } = await import('../js/core/tutorial/facts.js');
  const { doc } = setup();
  const facts = [buildFacts({ project: { markers: [], schematics: [], assets: [] } }), buildFacts({ project: { markers: [{ id: 'm', shape: 'box', x: J4x, y: J4y, w: 117, h: 40, label: 'J4', schematicId: 's' }], schematics: [{ id: 's', rows: 1, cols: 4, pins: [], name: 'Header', notes: '' }], assets: [] } })];
  for (const lesson of LESSONS) {
    for (const f of facts) {
      const id = lesson.target(f);
      if (id) assert.ok($(doc, id), `${lesson.id} points at #${id}`);
    }
  }
  for (const id of ['tool-box', 'zoom-in', 'marker-label', 'header-rows', 'header-cols', 'pin-role', 'header-name', 'header-notes', 'export-run']) assert.ok($(doc, id), id);
});
const J4x = 280;
const J4y = 750;

test('setTutorial reaches the Welcome and Settings', () => {
  const { doc, view } = setup();
  view.setTutorial({ state: 'started', step: 9 });
  assert.equal($(doc, 'welcome-tutorial').textContent, 'Resume the tutorial (step 9 of 18)');
  assert.equal($(doc, 'settings-tutorial-resume').textContent, 'Resume the tutorial (step 9 of 18)');
});

// The bench widgets (21b).
const meterModel = (extra = {}) => ({ kind: 'meter', powered: false, mode: 'continuity', probe: 4, pins: [1, 2, 3, 4], reading: { text: 'beep  0.0 Ω', kind: 'beep', recordable: true, jumpy: false }, ...extra });
const wiringModel = (wiring = {}) => ({
  kind: 'wiring', wiring: { VCC: null, TXD: null, RXD: null, GND: null, ...wiring }, lines: ['VCC', 'TXD', 'RXD', 'GND'],
  pins: [{ pin: 1, role: '3V3' }, { pin: 2, role: 'TX' }, { pin: 3, role: 'RX' }, { pin: 4, role: 'GND' }],
});
const benchHandlers = () => {
  const calls = [];
  return { calls, handlers: {
    benchMode: (m) => calls.push(['mode', m]), benchProbe: (p) => calls.push(['probe', p]), benchPower: (on) => calls.push(['power', on]),
    benchCycle: () => calls.push(['cycle']), benchRecord: () => calls.push(['record']), benchWire: (l, p) => calls.push(['wire', l, p]),
  } };
};

test('the meter shows its reading, mode, probe and power, and only on a meter step', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel());
  assert.equal($(doc, 'bench-meter').hidden, true);
  assert.equal($(doc, 'bench-wiring').hidden, true);
  view.tutorialDraw(stepModel({ bench: meterModel() }));
  assert.equal($(doc, 'bench-meter').hidden, false);
  assert.equal($(doc, 'bench-wiring').hidden, true);
  assert.equal($(doc, 'bench-reading').textContent, 'beep  0.0 Ω');
  assert.equal($(doc, 'bench-reading').dataset.kind, 'beep');
  assert.equal($(doc, 'bench-mode-continuity').getAttribute('aria-pressed'), 'true');
  assert.equal($(doc, 'bench-mode-dc').getAttribute('aria-pressed'), 'false');
  assert.deepEqual([1, 2, 3, 4].map((p) => $(doc, `bench-pin-${p}`).getAttribute('aria-pressed')), ['false', 'false', 'false', 'true']);
  assert.equal($(doc, 'bench-power').textContent, 'Plug in the board');
  assert.equal($(doc, 'bench-power-state').textContent, 'The board is unplugged.');
  assert.equal($(doc, 'bench-record').disabled, false);
  view.tutorialBench(meterModel({ powered: true, mode: 'continuity', probe: 2, reading: { text: 'Unplug the board first', kind: 'warning', recordable: false, jumpy: false } }));
  assert.equal($(doc, 'bench-power').textContent, 'Unplug the board');
  assert.equal($(doc, 'bench-record').disabled, true);
  assert.equal($(doc, 'bench-reading').dataset.kind, 'warning');
  view.tutorialDraw(stepModel());
  assert.equal($(doc, 'bench-meter').hidden, true, 'the meter goes away with the step');
});

test('the meter buttons report what was pressed, and Plug in / Unplug flips the board', async () => {
  const { calls, handlers } = benchHandlers();
  const { doc, view } = setup(handlers);
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: meterModel() }));
  $(doc, 'bench-mode-dc').click();
  $(doc, 'bench-mode-continuity').click();
  $(doc, 'bench-pin-3').click();
  $(doc, 'bench-power').click();
  view.tutorialBench(meterModel({ powered: true }));
  $(doc, 'bench-power').click();
  $(doc, 'bench-cycle').click();
  $(doc, 'bench-record').click();
  assert.deepEqual(calls, [['mode', 'dc'], ['mode', 'continuity'], ['probe', 3], ['power', true], ['power', false], ['cycle'], ['record']]);
});

test('the meter controls are real buttons, so Tab, Enter and Space work', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: meterModel() }));
  for (const id of ['bench-mode-continuity', 'bench-mode-dc', 'bench-pin-1', 'bench-pin-2', 'bench-pin-3', 'bench-pin-4', 'bench-power', 'bench-cycle', 'bench-record']) {
    assert.equal($(doc, id).tagName, 'BUTTON', id);
    assert.equal($(doc, id).tabIndex, 0, id);
  }
});

test('a steady reading is announced once and a jumpy one is not announced on every redraw', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: meterModel() }));
  assert.equal($(doc, 'bench-announce').textContent, 'Pin 4: beep  0.0 Ω');
  $(doc, 'bench-announce').textContent = '';
  view.tutorialBench(meterModel());
  assert.equal($(doc, 'bench-announce').textContent, '', 'the same reading is not repeated');
  view.tutorialBench(meterModel({ mode: 'dc', probe: 2, reading: { text: '2.41 V', kind: 'volts', recordable: true, jumpy: true } }));
  assert.equal($(doc, 'bench-announce').textContent, 'Pin 2: the reading is changing');
  view.tutorialBench(meterModel({ mode: 'dc', probe: 2, reading: { text: '3.02 V', kind: 'volts', recordable: true, jumpy: true } }));
  assert.equal($(doc, 'bench-announce').textContent, 'Pin 2: the reading is changing');
  assert.equal($(doc, 'bench-reading').textContent, '3.02 V', 'the screen itself keeps up');
});

test('a redraw of the meter alone keeps keyboard focus on the button that has it', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: meterModel() }));
  $(doc, 'bench-pin-2').focus();
  view.tutorialBench(meterModel({ probe: 2 }));
  assert.equal(doc.activeElement, $(doc, 'bench-pin-2'));
});

test('the wiring widget offers Open and the four pins with the roles the person marked, and draws one wire per connection', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: wiringModel() }));
  assert.equal($(doc, 'bench-wiring').hidden, false);
  assert.equal($(doc, 'bench-meter').hidden, true);
  assert.deepEqual([...$(doc, 'wire-RXD').options].map((o) => o.textContent), ['Open (not connected)', 'Pin 1 (3V3)', 'Pin 2 (TX)', 'Pin 3 (RX)', 'Pin 4 (GND)']);
  assert.equal($(doc, 'wire-RXD').value, '');
  assert.equal(doc.querySelectorAll('#bench-figure path.wire').length, 0);
  view.tutorialBench(wiringModel({ RXD: 2, TXD: 3, GND: 4 }));
  assert.equal($(doc, 'wire-RXD').value, '2');
  assert.equal($(doc, 'wire-TXD').value, '3');
  assert.equal($(doc, 'wire-VCC').value, '');
  assert.deepEqual([...doc.querySelectorAll('#bench-figure path.wire')].map((p) => p.getAttribute('class')), ['wire wire-TXD', 'wire wire-RXD', 'wire wire-GND']);
  assert.ok($(doc, 'bench-figure').textContent.includes('Adapter'));
});

test('the wiring options without a marked role show the bare pin number', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  const model = wiringModel();
  model.pins = model.pins.map((p) => ({ pin: p.pin, role: '' }));
  view.tutorialDraw(stepModel({ bench: model }));
  assert.deepEqual([...$(doc, 'wire-VCC').options].map((o) => o.textContent).slice(1), ['Pin 1', 'Pin 2', 'Pin 3', 'Pin 4']);
});

test('choosing a pin in a wiring select reports the line and the pin, and Open reports null', async () => {
  const { calls, handlers } = benchHandlers();
  const { doc, view } = setup(handlers);
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: wiringModel() }));
  const choose = (id, value) => { $(doc, id).value = value; $(doc, id).dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); };
  choose('wire-TXD', '3');
  choose('wire-VCC', '');
  assert.deepEqual(calls, [['wire', 'TXD', 3], ['wire', 'VCC', null]]);
});

test('a wiring redraw keeps the select that has focus', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: wiringModel() }));
  $(doc, 'wire-GND').focus();
  view.tutorialDraw(stepModel({ bench: wiringModel({ GND: 4 }) }));
  assert.equal(doc.activeElement, $(doc, 'wire-GND'));
});

test('the bench is hidden on the finish page', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ bench: meterModel() }));
  view.tutorialDraw({ kind: 'finish', moved: false, complete: false, step: 9, total: 18, chapter: 2, title: 'That is all for now', lead: 'Later.', lines: [], where: '' });
  assert.equal($(doc, 'bench-meter').hidden, true);
  assert.equal($(doc, 'bench-wiring').hidden, true);
});

test('every control the bench lessons name exists in the page', async () => {
  const { doc } = setup();
  for (const id of ['bench-power', 'bench-cycle', 'bench-record', 'wire-VCC', 'wire-TXD', 'wire-RXD', 'wire-GND', 'bench-figure']) assert.ok($(doc, id), id);
});

// The virtual board widget (21c).
const vdevModel = (running = false) => ({ kind: 'vdev', running });

test('the virtual board widget shows its state, starts the board and is hidden on other steps', async () => {
  const calls = [];
  const { doc, view } = setup({ benchMode: () => {}, ...{} });
  await view.tutorialEnter(['console']);
  view.tutorialDraw(stepModel({ bench: vdevModel(false) }));
  assert.equal($(doc, 'bench-vdev').hidden, false);
  assert.equal($(doc, 'bench-meter').hidden, true);
  assert.equal($(doc, 'tutorial-vdev-start').disabled, false);
  assert.match($(doc, 'tutorial-vdev-state').textContent, /not running/);
  view.tutorialDraw(stepModel({ bench: vdevModel(true) }));
  assert.equal($(doc, 'tutorial-vdev-start').disabled, true);
  assert.match($(doc, 'tutorial-vdev-state').textContent, /is running/);
  view.tutorialDraw(stepModel({ bench: null }));
  assert.equal($(doc, 'bench-vdev').hidden, true);
  assert.deepEqual(calls, []);
});

test('Start the virtual board in the coach starts it through the Console panel, which selects its port', async () => {
  const started = [];
  const { doc, view } = setup({
    vdevStatus: async () => ({ running: false, owned: false }),
    startVdev: async () => { started.push('start'); return { running: true, owned: true }; },
    listSerialPorts: async () => ({ ports: [{ path: '/run/ttyPCBV0', label: 'Virtual board (pcbv vdev)' }], bauds: [9600, 115200] }),
  });
  await view.tutorialEnter(['console']);
  view.tutorialDraw(stepModel({ bench: vdevModel(false) }));
  $(doc, 'tutorial-vdev-start').click();
  await flush(); await flush(); await flush();
  assert.deepEqual(started, ['start']);
  assert.equal($(doc, 'serial-port').value, '/run/ttyPCBV0');
});

test('while the tutorial runs the Console lists the virtual board only and starts at the asked speed; leaving gives both back', async () => {
  const { doc, view } = setup({
    vdevStatus: async () => ({ running: true, owned: true }),
    listSerialPorts: async () => ({ ports: [{ path: '/dev/ttyUSB0', label: 'CP2102' }, { path: '/run/ttyPCBV0', label: 'Virtual board (pcbv vdev)' }], bauds: [9600, 115200] }),
  });
  await view.tutorialEnter(['console']);
  view.tutorialConsole({ baud: 9600 });
  await flush(); await flush(); await flush();
  assert.deepEqual([...$(doc, 'serial-port').options].map((o) => o.value), ['/run/ttyPCBV0']);
  assert.equal($(doc, 'serial-baud').value, '9600');
  view.tutorialLeave();
  await flush(); await flush(); await flush();
  assert.deepEqual([...$(doc, 'serial-port').options].map((o) => o.value), ['/dev/ttyUSB0', '/run/ttyPCBV0']);
  assert.equal($(doc, 'serial-baud').value, '115200');
});

test('every control the console and logic lessons name exists in the page', () => {
  const { doc } = setup();
  for (const id of ['tutorial-vdev-start', 'serial-connect', 'serial-baud', 'serial-output', 'key-space', 'key-enter', 'serial-input', 'logic-decode', 'logic-compare', 'logic-compare-with', 'logic-compare-bar', 'export-run']) assert.ok($(doc, id), id);
});

test('the Console\'s own Start button and the Logic import are hidden while the tutorial runs', () => {
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-tutorial="on"\] #vdev-bar, :root\[data-tutorial="on"\] #serial-detect, :root\[data-tutorial="on"\] #logic-import,\n[^{]*\{ display: none; \}/);
});

test('step 12 shows its question as buttons that report the choice; other steps hide it', async () => {
  const answers = [];
  const { doc, view } = setup({ tutorialAnswer: (value) => answers.push(value) });
  await view.tutorialEnter(['console']);
  const question = (extra = {}) => ({ legend: 'Which chip holds the firmware?', choices: ['ARC7621', '25Q128', 'eth0'], chosen: null, enabled: false, ...extra });
  view.tutorialDraw(stepModel({ question: null }));
  assert.equal($(doc, 'tutorial-question').hidden, true);
  view.tutorialDraw(stepModel({ question: question() }));
  assert.equal($(doc, 'tutorial-question').hidden, false);
  assert.equal($(doc, 'tutorial-question-legend').textContent, 'Which chip holds the firmware?');
  const buttons = [0, 1, 2].map((n) => $(doc, `tutorial-choice-${n}`));
  assert.deepEqual(buttons.map((b) => b.textContent), ['ARC7621', '25Q128', 'eth0']);
  assert.ok(buttons.every((b) => b.disabled && b.getAttribute('aria-pressed') === 'false'));
  view.tutorialDraw(stepModel({ question: question({ enabled: true, chosen: 'eth0' }) }));
  assert.ok(buttons.every((b) => !b.disabled), 'the same buttons stay in place');
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  buttons[1].click();
  assert.deepEqual(answers, ['25Q128']);
  view.tutorialDraw(stepModel({ question: null }));
  assert.equal($(doc, 'tutorial-question').hidden, true);
});

test('the coach shows the step\'s example in a fold-out that closes on a new step and is hidden on the finish pages', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  const example = { question: 'What is a UART?', answer: 'A simple serial link.' };
  view.tutorialDraw(stepModel({ example }));
  const box = $(doc, 'tutorial-example');
  assert.equal(box.hidden, false);
  assert.equal(box.hasAttribute('data-ai'), true);
  assert.match(box.querySelector('summary').textContent, /Ask the assistant \(example\)/);
  assert.match(box.textContent, /Example only\. In the tutorial no question is sent to a model\./);
  assert.equal($(doc, 'tutorial-example-question').textContent, example.question);
  assert.equal($(doc, 'tutorial-example-answer').textContent, example.answer);
  box.open = true;
  view.tutorialDraw(stepModel({ example, hint: 'again' }));
  assert.equal(box.open, true, 'a redraw of the same step keeps it open');
  view.tutorialDraw(stepModel({ step: 4, example: { question: 'Q2', answer: 'A2' } }));
  assert.equal(box.open, false, 'a new step closes it');
  assert.equal($(doc, 'tutorial-example-question').textContent, 'Q2');
  view.tutorialDraw({ kind: 'finish', target: null, moved: false, complete: false, step: 4, total: 18, chapter: 0, title: 'End', lead: 'L', lines: [], where: '' });
  assert.equal(box.hidden, true);
});

test('the example text is set as text, never as markup', async () => {
  const { doc, view } = setup();
  await view.tutorialEnter(['photo']);
  view.tutorialDraw(stepModel({ example: { question: '<img src=x>', answer: '<b>hi</b>' } }));
  assert.equal($(doc, 'tutorial-example').querySelectorAll('img, b').length, 0);
});
