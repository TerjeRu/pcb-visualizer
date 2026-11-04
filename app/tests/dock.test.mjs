import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createDock, showSinglePanel } from '../js/dock.js';
import { PANELS, PRESETS } from '../js/core/layout.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

async function setup({ loaded = null, blocked = false, found = {} } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('board-panel').hidden = false;
  const calls = [];
  const windows = [];
  const statuses = [];
  const dock = createDock(doc, {
    loadWorkspaces: async () => loaded,
    saveWorkspaces: (data) => calls.push(['save', JSON.parse(JSON.stringify(data))]),
    openPanelWindow: (panel) => {
      if (blocked) return null;
      const w = { closed: false, focused: 0, close() { this.closed = true; }, focus() { this.focused += 1; } };
      windows.push([panel, w]);
      return w;
    },
    findPanelWindow: (panel) => found[panel] ?? null,
    onStatus: (text) => statuses.push(text),
    onPanelHome: (panel) => calls.push(['home', panel]),
  });
  dock.setAssistant('on');
  await dock.start();
  const regionOf = (p) => doc.getElementById(`panel-${p}`).closest('.region')?.dataset.region ?? null;
  const closeAll = () => windows.forEach(([, w]) => { w.closed = true; });
  return { dom, doc, dock, calls, windows, statuses, regionOf, closeAll };
}

const openPanels = (doc) => { doc.getElementById('panels-open').click(); return doc.querySelector('.panels-menu'); };
const row = (doc, panel) => doc.querySelector(`.panels-menu .panels-row[data-panel="${panel}"]`);
const actions = (doc, panel) => [...row(doc, panel).querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
const choose = (doc, panel, label) => {
  const item = [...row(doc, panel).querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label);
  assert.ok(item, `${panel}: ${label}`);
  item.click();
};
const panelMenuFor = (doc, name) => {
  [...doc.querySelectorAll('.region-tab')].find((t) => t.textContent === name).click();
  doc.querySelector('#region-right .region-tools .panel-menu').click();
};

test('the default workspace places panels and shows stacked and tabbed regions', async () => {
  const { doc, regionOf } = await setup();
  assert.equal(regionOf('board'), 'left');
  assert.equal(regionOf('photo'), 'center');
  assert.equal(regionOf('console'), 'right');
  assert.equal(doc.getElementById('region-bottom').classList.contains('empty'), true);
  assert.equal(doc.getElementById('panel-inspector').hidden, false, 'stacked panels are all shown');
  assert.equal(doc.getElementById('panel-wiki').hidden, true, 'only the active tab is shown');
  assert.deepEqual([...doc.querySelectorAll('#workspace-select option')].map((o) => o.value), ['Learn', 'Console', 'Analysis', 'Wall']);
});

test('the menu moves a panel and the layout is saved under the current workspace', async (t) => {
  const { doc, calls, regionOf } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  [...doc.querySelectorAll('.region-tab')].find((t) => t.textContent === 'Console').click();
  doc.querySelector('#region-right .region-tools .panel-menu').click();
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Move to bottom').click();
  assert.equal(regionOf('console'), 'bottom');
  assert.equal(doc.getElementById('region-bottom').classList.contains('empty'), false);
  const before = calls.length;
  t.mock.timers.tick(399);
  assert.equal(calls.length, before, 'saving waits for the debounce');
  t.mock.timers.tick(1);
  assert.equal(calls.length, before + 1);
  const [, saved] = calls.at(-1);
  assert.equal(saved.current, 'Learn');
  assert.ok(saved.saved.Learn.regions.bottom.includes('console'));
});

test('a saved workspace is applied on start, and switching workspaces rearranges', async () => {
  const custom = { ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, right: ['playbook', 'wiki', 'timeline', 'terminal'], bottom: ['console'] }, active: { ...PRESETS.Learn.active, bottom: 'console' } };
  const { doc, regionOf, closeAll } = await setup({ loaded: { current: 'Bench', saved: { Bench: custom } } });
  assert.equal(regionOf('console'), 'bottom');
  assert.equal(doc.getElementById('workspace-select').value, 'Bench');
  const select = doc.getElementById('workspace-select');
  select.value = 'Console';
  select.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(regionOf('console'), 'center');
  assert.equal(regionOf('board'), null, 'Board is detached in the Console workspace');
  closeAll();
});

test('opening a panel in a window detaches it; Bring back in the Panels menu returns it', async () => {
  const { doc, windows, regionOf } = await setup();
  panelMenuFor(doc, 'Timeline');
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  assert.deepEqual(windows.map(([p]) => p), ['timeline']);
  assert.equal(regionOf('timeline'), null);
  assert.equal(doc.getElementById('panel-timeline').parentElement.id, 'panel-store');
  openPanels(doc);
  assert.equal(row(doc, 'timeline').querySelector('.panels-state').textContent, 'Own window');
  assert.deepEqual(actions(doc, 'timeline'), ['Focus window', 'Bring back']);
  choose(doc, 'timeline', 'Bring back');
  assert.equal(regionOf('timeline'), 'right');
  assert.equal(windows[0][1].closed, true, 'its window is closed');
  assert.equal(doc.querySelector('.panels-menu'), null);
});

test('stack mode toggles per region', async () => {
  const { doc } = await setup();
  doc.querySelector('#region-right .region-mode').click();
  assert.equal(doc.getElementById('region-right').dataset.mode, 'stack');
  assert.equal(doc.getElementById('panel-wiki').hidden, false);
  assert.ok(doc.querySelector('#panel-wiki > .panel-head .panel-menu'));
});

test('a panel window shows only that panel', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  assert.equal(showSinglePanel(doc, 'console'), true);
  assert.equal(doc.title, 'pcbv · Console');
  assert.equal(doc.querySelectorAll('.region').length, 0);
  assert.equal(doc.getElementById('board-panel').firstElementChild.id, 'panel-console');
  assert.equal(showSinglePanel(doc, 'nope'), false);
});

test('a moved panel is flashed so it can be found, and an empty centre is marked', async () => {
  const { doc } = await setup();
  doc.getElementById('panel-photo').scrollIntoView = () => {};
  doc.querySelector('#region-center .region-tools .panel-menu').click();
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Move to left').click();
  assert.ok(doc.getElementById('panel-photo').classList.contains('moved'));
  assert.equal(doc.getElementById('board-panel').classList.contains('has-center'), false);
});

test('Save as asks for a name in the bar; Escape and an empty name save nothing', async () => {
  const { doc, calls } = await setup();
  const form = doc.getElementById('workspace-name-form');
  const input = doc.getElementById('workspace-name');
  const submit = () => form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  doc.getElementById('workspace-save').click();
  assert.equal(form.hidden, false);
  assert.equal(doc.getElementById('workspace-save').hidden, true);
  assert.equal(doc.activeElement, input);
  input.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(form.hidden, true);
  assert.equal(calls.length, 0);

  doc.getElementById('workspace-save').click();
  input.value = '   ';
  submit();
  assert.equal(form.hidden, false, 'an empty name keeps the field open');
  assert.equal(calls.length, 0);
  input.value = 'Bench';
  submit();
  assert.equal(form.hidden, true);
  assert.equal(calls.at(-1)[1].current, 'Bench');
  assert.ok(calls.at(-1)[1].saved.Bench);
  assert.equal(doc.getElementById('workspace-select').value, 'Bench');
});

const switchTo = (doc, name) => {
  const select = doc.getElementById('workspace-select');
  select.value = name;
  select.dispatchEvent(new doc.defaultView.Event('change'));
};

test('a preset that wants a panel in its own window opens it, and leaving the preset closes it', async () => {
  const { doc, windows, regionOf } = await setup();
  switchTo(doc, 'Console');
  assert.deepEqual(windows.map(([p]) => p), ['board']);
  assert.equal(regionOf('board'), null);
  switchTo(doc, 'Learn');
  assert.equal(windows[0][1].closed, true, 'its window closes');
  assert.equal(regionOf('board'), 'left', 'the panel is back in this window, where Learn puts it');
});

test('presets never detach a panel without a window: a blocked pop-up leaves it docked and says so', async () => {
  const { doc, dock, statuses, regionOf } = await setup({ blocked: true });
  switchTo(doc, 'Wall');
  assert.deepEqual(dock.layout().detached, []);
  assert.notEqual(regionOf('console'), null);
  assert.notEqual(regionOf('assistant'), null);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /blocked the pop-up/i);
  assert.match(statuses[0], /Console/);
});

test('the menu does not detach a panel when its window could not open', async () => {
  const { doc, statuses, regionOf } = await setup({ blocked: true });
  [...doc.querySelectorAll('.region-tab')].find((t) => t.textContent === 'Timeline').click();
  doc.querySelector('#region-right .region-tools .panel-menu').click();
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  assert.equal(regionOf('timeline'), 'right');
  assert.match(statuses[0], /Timeline stays in this window/);
});

test('after a reload, panels whose window is still there stay detached and the rest come home unsaved', async () => {
  const alive = { closed: false, focus() {}, close() {} };
  const layout = { ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, right: ['playbook', 'wiki', 'terminal', 'assistant'] }, detached: ['console', 'timeline'], origins: { console: { region: 'right', index: 2 }, timeline: { region: 'center', index: 1 } } };
  const { doc, calls, regionOf, dock, closeAll } = await setup({ loaded: { current: 'Bench', saved: { Bench: layout } }, found: { console: alive } });
  assert.equal(regionOf('console'), null);
  openPanels(doc);
  assert.equal(row(doc, 'console').querySelector('.panels-state').textContent, 'Own window');
  assert.equal(regionOf('timeline'), 'center', 'no window: back at its origin');
  assert.deepEqual(dock.layout().detached, ['console']);
  assert.equal(calls.some((c) => c[0] === 'save'), false, 'the saved workspace is not rewritten by what the reload found');
  assert.deepEqual(calls.filter((c) => c[0] === 'home'), [['home', 'timeline']], 'a window it could not reach is told the panel is home');
  alive.closed = true;
  closeAll();
});

test('one watcher per window, and bringing the panel back clears it', async (t) => {
  const live = new Set();
  let next = 0;
  t.mock.method(globalThis, 'setInterval', () => { live.add(++next); return next; });
  t.mock.method(globalThis, 'clearInterval', (handle) => { live.delete(handle); });
  const { doc } = await setup();
  panelMenuFor(doc, 'Timeline');
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  assert.equal(live.size, 1);
  openPanels(doc);
  choose(doc, 'timeline', 'Bring back');
  assert.equal(live.size, 0);
});

test('showing a detached panel focuses its window; with the window gone it returns to its place first', async () => {
  const { doc, windows, dock, regionOf } = await setup();
  [...doc.querySelectorAll('.region-tab')].find((t) => t.textContent === 'Timeline').click();
  doc.querySelector('#region-right .region-tools .panel-menu').click();
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  assert.equal(dock.route('timeline'), 'remote');
  assert.equal(windows[0][1].focused, 1);
  assert.equal(dock.route('photo'), 'here');
  windows[0][1].closed = true;
  assert.equal(dock.route('timeline'), 'here');
  assert.equal(regionOf('timeline'), 'right');
  assert.equal(windows.length, 1, 'no new window was opened');
  assert.equal(dock.isDocked('timeline'), true);
});

test('the dock says when the saved workspace is in place, after deciding which panels come home', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const calls = [];
  let dock = null;
  let release;
  const layout = { ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, right: PRESETS.Learn.regions.right.filter((p) => p !== 'console') }, detached: ['console'], origins: { console: { region: 'right', index: 2 } } };
  dock = createDock(doc, {
    loadWorkspaces: () => new Promise((resolve) => { release = () => resolve({ current: 'Bench', saved: { Bench: layout } }); }),
    saveWorkspaces() {},
    findPanelWindow: (panel) => { calls.push(['find', panel, dock.settled(), dock.isDocked(panel)]); return null; },
    onPanelHome: (panel) => calls.push(['home', panel]),
    onSettled: () => calls.push(['settled', dock.isDocked('console')]),
  });
  const starting = dock.start();
  assert.equal(dock.settled(), false, 'while the saved workspace loads, the layout is only the default');
  release();
  await starting;
  assert.deepEqual(calls, [['find', 'console', true, false], ['home', 'console'], ['settled', true]],
    'a panel not decided yet is still detached; the end comes after every decision');
});

const press = (dom, target, key) => {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

async function openMenu() {
  const ctx = await setup();
  const button = ctx.doc.querySelector('#region-right .region-tools .panel-menu');
  button.focus();
  button.click();
  return { ...ctx, button, items: () => [...ctx.doc.querySelectorAll('.menu [role="menuitem"]')] };
}

test('the panel menu opens on its first item and the button says it is expanded', async () => {
  const { doc, button, items } = await openMenu();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, items()[0]);
  assert.ok(doc.querySelector('.menu').getAttribute('aria-label'));
  assert.ok(items().every((item) => item.tabIndex === -1), 'items are reached with the arrows, not Tab');
});

test('arrow keys, Home and End move through the menu and wrap', async () => {
  const { dom, doc, items } = await openMenu();
  const list = items();
  assert.ok(list.length >= 3);
  press(dom, doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement, list[1]);
  press(dom, doc.activeElement, 'End');
  assert.equal(doc.activeElement, list.at(-1));
  press(dom, doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement, list[0], 'wraps to the first');
  press(dom, doc.activeElement, 'ArrowUp');
  assert.equal(doc.activeElement, list.at(-1), 'wraps to the last');
  press(dom, doc.activeElement, 'Home');
  assert.equal(doc.activeElement, list[0]);
});

test('Escape closes the menu and puts focus back on its button', async () => {
  const { dom, doc, button } = await openMenu();
  press(dom, doc.activeElement, 'Escape');
  assert.equal(doc.querySelector('.menu'), null);
  assert.equal(doc.activeElement, button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('Tab closes the menu and leaves focus on its button, so the next Tab moves on from there', async () => {
  const { dom, doc, button } = await openMenu();
  const event = press(dom, doc.activeElement, 'Tab');
  assert.equal(event.defaultPrevented, false, 'the browser still moves focus');
  assert.equal(doc.querySelector('.menu'), null);
  assert.equal(doc.activeElement, button);
});

test('choosing a menu item still moves the panel', async () => {
  const { doc, regionOf, items } = await openMenu();
  const shown = doc.querySelector('#region-right [role="tab"][aria-selected="true"]').dataset.panel;
  items().find((item) => item.textContent === 'Move to bottom').click();
  assert.equal(regionOf(shown), 'bottom');
  assert.equal(doc.querySelector('.menu'), null);
});

test('after a move by keyboard, focus is on the moved panel\'s menu button in its new region', async () => {
  const { doc, regionOf, items } = await openMenu();
  const shown = doc.querySelector('#region-right [role="tab"][aria-selected="true"]').dataset.panel;
  items().find((item) => item.textContent === 'Move to bottom').click();
  assert.equal(regionOf(shown), 'bottom');
  assert.ok(doc.activeElement.classList.contains('panel-menu'), 'focus is on a menu button, not lost to the page');
  assert.equal(doc.activeElement.dataset.menuFor, shown);
  assert.ok(doc.getElementById('region-bottom').contains(doc.activeElement));
});

test('tabs are wired to their panels, and stacked regions have no tablist', async () => {
  const { doc } = await setup();
  const tablist = doc.querySelector('#region-right [role="tablist"]');
  assert.ok(tablist.getAttribute('aria-label'));
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  assert.ok(tabs.length > 1);
  for (const tab of tabs) {
    const panel = doc.getElementById(tab.getAttribute('aria-controls'));
    assert.equal(panel.id, `panel-${tab.dataset.panel}`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(tab.tabIndex, tab.getAttribute('aria-selected') === 'true' ? 0 : -1, 'only the selected tab is in the tab order');
  }
  assert.equal(doc.querySelectorAll('#region-right [role="tab"][aria-selected="true"]').length, 1);
  assert.equal(doc.querySelector('#region-left [role="tablist"]'), null, 'a stacked region has no tabs');
  assert.equal(doc.querySelector('#region-bottom [role="tablist"]'), null, 'an empty region has no tabs');
  assert.equal(doc.getElementById('panel-board').getAttribute('role'), null, 'stacked panels are not tab panels');
  doc.querySelector('#region-right .region-mode').click();
  assert.equal(doc.querySelector('#region-right [role="tablist"]'), null);
  assert.equal(doc.getElementById('panel-wiki').getAttribute('role'), null);
  assert.equal(doc.getElementById('panel-wiki').getAttribute('aria-labelledby'), null);
});

test('arrow keys, Home and End move between tabs, show that panel and keep focus on its tab', async () => {
  const { dom, doc } = await setup();
  const names = () => [...doc.querySelectorAll('#region-right [role="tab"]')].map((t) => t.dataset.panel);
  const order = names();
  const selected = () => doc.querySelector('#region-right [role="tab"][aria-selected="true"]');
  const first = selected();
  press(dom, first, 'ArrowRight');
  assert.equal(selected().dataset.panel, order[(order.indexOf(first.dataset.panel) + 1) % order.length]);
  assert.equal(doc.activeElement, selected(), 'focus follows the selected tab');
  assert.equal(doc.getElementById(`panel-${selected().dataset.panel}`).hidden, false);
  assert.equal(doc.getElementById(`panel-${first.dataset.panel}`).hidden, true);
  press(dom, doc.activeElement, 'End');
  assert.equal(selected().dataset.panel, order.at(-1));
  press(dom, doc.activeElement, 'ArrowRight');
  assert.equal(selected().dataset.panel, order[0], 'wraps');
  press(dom, doc.activeElement, 'ArrowLeft');
  assert.equal(selected().dataset.panel, order.at(-1), 'wraps backwards');
  press(dom, doc.activeElement, 'Home');
  assert.equal(selected().dataset.panel, order[0]);
});

test('keyboard tab changes tell the app which panel came to the front', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('board-panel').hidden = false;
  const shown = [];
  const dock = createDock(doc, { onShow: (panel) => shown.push(panel) });
  await dock.start();
  const tab = doc.querySelector('#region-right [role="tab"][aria-selected="true"]');
  press(dom, tab, 'ArrowRight');
  assert.equal(shown.length, 1);
  assert.equal(shown[0], doc.querySelector('#region-right [role="tab"][aria-selected="true"]').dataset.panel);
});

test('a detached panel keeps no tab roles', async () => {
  const { doc, closeAll } = await setup();
  doc.querySelector('#region-right .region-tools .panel-menu').click();
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  const panel = doc.querySelector('#panel-store > .panel');
  assert.ok(panel);
  assert.equal(panel.getAttribute('role'), null);
  assert.equal(panel.getAttribute('aria-labelledby'), null);
  closeAll();
});

test('a dragged Agent tab from a window that has not heard the setting is refused while the assistant is off', async () => {
  const { dom, doc, dock, regionOf } = await setup();
  dock.setAssistant('off');
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  drop.dataTransfer = { getData: (type) => (type === 'application/x-pcbv-panel' ? 'assistant' : '') };
  doc.querySelector('#region-bottom .region-body').dispatchEvent(drop);
  assert.equal(regionOf('assistant'), null);
  assert.equal([...doc.querySelectorAll('.region-tab')].some((t) => t.textContent === 'Agent'), false);
});

const key = (dom, target, init) => {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const states = (doc) => Object.fromEntries([...doc.querySelectorAll('.panels-menu .panels-row')].map((r) => [r.dataset.panel, r.querySelector('.panels-state').textContent]));

test('the Panels menu lists every panel in a fixed order with its state and the right actions', async () => {
  const { doc, windows, closeAll } = await setup();
  const button = doc.getElementById('panels-open');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.match(button.title, /Ctrl\+Shift\+P/);
  openPanels(doc);
  assert.deepEqual([...doc.querySelectorAll('.panels-menu .panels-row')].map((r) => r.dataset.panel), Object.keys(PANELS));
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(states(doc), { board: 'Left', inspector: 'Left', feed: 'Left', photo: 'Centre', playbook: 'Right', wiki: 'Right', console: 'Right', timeline: 'Right', logic: 'Right', terminal: 'Right', assistant: 'Right' });
  assert.deepEqual(actions(doc, 'wiki'), ['Show', 'Open in own window', 'Put away']);
  assert.equal(row(doc, 'wiki').getAttribute('aria-label'), 'Wiki, Right');
  choose(doc, 'logic', 'Open in own window');
  assert.equal(doc.querySelector('.panels-menu'), null, 'choosing an action closes the menu');
  assert.deepEqual(windows.map(([p]) => p), ['logic']);
  closeAll();
});

test('every action works: show, own window, put away, focus window, bring back, show here', async () => {
  const { doc, dock, windows, regionOf } = await setup();
  openPanels(doc);
  choose(doc, 'wiki', 'Show');
  assert.equal(doc.querySelector('#region-right [role="tab"][aria-selected="true"]').dataset.panel, 'wiki');
  assert.equal(doc.activeElement.dataset.panel, 'wiki', 'focus is on the panel tab');
  assert.equal(doc.getElementById('panel-wiki').hidden, false);

  openPanels(doc);
  choose(doc, 'logic', 'Open in own window');
  assert.deepEqual(windows.map(([p]) => p), ['logic']);
  assert.equal(doc.activeElement, doc.getElementById('panels-open'));
  assert.deepEqual(dock.layout().detached, ['logic']);

  openPanels(doc);
  choose(doc, 'photo', 'Put away');
  assert.equal(regionOf('photo'), null);
  assert.deepEqual(dock.layout().away, ['photo']);
  assert.equal(doc.getElementById('panel-photo').parentElement.id, 'panel-store');
  assert.equal(doc.activeElement, doc.getElementById('panels-open'), 'focus goes to the Panels button');
  assert.equal(doc.getElementById('board-panel').classList.contains('has-center'), false);

  openPanels(doc);
  assert.deepEqual(states(doc).photo, 'Put away');
  assert.deepEqual(states(doc).logic, 'Own window');
  assert.deepEqual(actions(doc, 'photo'), ['Show here']);
  assert.deepEqual(actions(doc, 'logic'), ['Focus window', 'Bring back']);
  choose(doc, 'logic', 'Focus window');
  assert.equal(windows[0][1].focused, 1);
  assert.equal(regionOf('logic'), null, 'a live window stays a window');

  openPanels(doc);
  choose(doc, 'photo', 'Show here');
  assert.equal(regionOf('photo'), 'center', 'back at its origin');
  assert.equal(doc.activeElement.dataset.panel, 'photo');
  assert.equal(doc.getElementById('panel-photo').hidden, false);

  openPanels(doc);
  choose(doc, 'logic', 'Bring back');
  assert.equal(regionOf('logic'), 'right');
  assert.equal(windows[0][1].closed, true);
});

test('Focus window on a window that is already gone brings the panel back', async () => {
  const { doc, windows, regionOf } = await setup();
  panelMenuFor(doc, 'Timeline');
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  windows[0][1].closed = true;
  openPanels(doc);
  choose(doc, 'timeline', 'Focus window');
  assert.equal(regionOf('timeline'), 'right');
  assert.equal(windows.length, 1, 'no new window opened');
});

test('the panel menu has Put away, and the panel is found again in the Panels menu', async () => {
  const { doc, dock, regionOf } = await setup();
  panelMenuFor(doc, 'Timeline');
  const labels = [...doc.querySelectorAll('.menu [role="menuitem"]')].map((b) => b.textContent);
  assert.ok(labels.includes('Put away'));
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Put away').click();
  assert.equal(regionOf('timeline'), null);
  assert.deepEqual(dock.layout().away, ['timeline']);
  assert.equal(doc.activeElement, doc.getElementById('panels-open'));
  openPanels(doc);
  assert.equal(states(doc).timeline, 'Put away');
});

test('a put-away panel is saved with the workspace and is still away after a reload', async (t) => {
  const first = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  openPanels(first.doc);
  choose(first.doc, 'logic', 'Put away');
  t.mock.timers.tick(400);
  const [, saved] = first.calls.at(-1);
  assert.deepEqual(saved.saved.Learn.away, ['logic']);
  const second = await setup({ loaded: saved });
  assert.equal(second.regionOf('logic'), null);
  openPanels(second.doc);
  assert.equal(states(second.doc).logic, 'Put away');
});

test('closing a panel window by its window controls returns the panel to its origin, never to away', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { doc, windows, dock, regionOf } = await setup();
  panelMenuFor(doc, 'Timeline');
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent === 'Open in its own window').click();
  windows[0][1].closed = true;
  t.mock.timers.tick(1000);
  assert.equal(regionOf('timeline'), 'right');
  assert.deepEqual(dock.layout().away, []);
});

test('Ctrl+Shift+P opens the Panels menu on its first item; Escape closes it and returns focus', async () => {
  const { dom, doc } = await setup();
  const event = key(dom, doc.body, { key: 'P', ctrlKey: true, shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  const menu = doc.querySelector('.panels-menu');
  assert.ok(menu);
  assert.equal(doc.activeElement, menu.querySelector('[role="menuitem"]'));
  assert.equal(doc.activeElement.textContent, 'Show');
  assert.equal(doc.activeElement.closest('.panels-row').dataset.panel, 'board');
  key(dom, doc.activeElement, { key: 'Escape' });
  assert.equal(doc.querySelector('.panels-menu'), null);
  assert.equal(doc.activeElement, doc.getElementById('panels-open'));
  key(dom, doc.body, { key: 'p', ctrlKey: true });
  assert.equal(doc.querySelector('.panels-menu'), null, 'Ctrl+P alone and Shift+P alone do nothing');
  key(dom, doc.body, { key: 'P', shiftKey: true });
  assert.equal(doc.querySelector('.panels-menu'), null);
});

test('the shortcut does nothing before the saved workspace is in place, and not in a panel window', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  createDock(doc, {});
  assert.equal(doc.getElementById('panels-open').disabled, true);
  assert.equal(key(dom, doc.body, { key: 'P', ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  const ready = await setup();
  showSinglePanel(ready.doc, 'console');
  assert.equal(key(ready.dom, ready.doc.body, { key: 'P', ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(ready.doc.querySelector('.panels-menu'), null);
});

test('arrows move through the actions of every panel; typing letters jumps to a panel by title', async () => {
  const { dom, doc } = await setup();
  key(dom, doc.body, { key: 'P', ctrlKey: true, shiftKey: true });
  const items = () => [...doc.querySelectorAll('.panels-menu [role="menuitem"]')];
  key(dom, doc.activeElement, { key: 'ArrowDown' });
  assert.equal(doc.activeElement, items()[1]);
  key(dom, doc.activeElement, { key: 'End' });
  assert.equal(doc.activeElement, items().at(-1));
  key(dom, doc.activeElement, { key: 'ArrowDown' });
  assert.equal(doc.activeElement, items()[0], 'wraps');
  key(dom, doc.activeElement, { key: 'w' });
  assert.equal(doc.activeElement.closest('.panels-row').dataset.panel, 'wiki');
  key(dom, doc.activeElement, { key: 'ArrowDown' });
  key(dom, doc.activeElement, { key: 't' });
  key(dom, doc.activeElement, { key: 'i' });
  assert.equal(doc.activeElement.closest('.panels-row').dataset.panel, 'timeline', 'typed letters narrow the match');
  assert.ok(items().every((item) => item.tabIndex === -1));
  const tab = key(dom, doc.activeElement, { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false);
  assert.equal(doc.querySelector('.panels-menu'), null);
});

test('Enter on a focused action chooses it', async () => {
  const { dom, doc, regionOf } = await setup();
  key(dom, doc.body, { key: 'P', ctrlKey: true, shiftKey: true });
  key(dom, doc.activeElement, { key: 'p' });
  key(dom, doc.activeElement, { key: 'h' });
  assert.equal(doc.activeElement.closest('.panels-row').dataset.panel, 'photo');
  key(dom, doc.activeElement, { key: 'ArrowDown' });
  key(dom, doc.activeElement, { key: 'ArrowDown' });
  assert.equal(doc.activeElement.textContent, 'Put away');
  doc.activeElement.click();
  assert.equal(regionOf('photo'), null);
});

test('the Agent panel is not listed while the assistant is off, and is listed again when it is on', async () => {
  const { doc, dock } = await setup();
  dock.setAssistant('off');
  openPanels(doc);
  assert.equal(row(doc, 'assistant'), null);
  assert.equal(doc.querySelectorAll('.panels-menu .panels-row').length, Object.keys(PANELS).length - 1);
  doc.getElementById('panels-open').click();
  dock.setAssistant('on');
  openPanels(doc);
  assert.ok(row(doc, 'assistant'));
});

test('a click outside, or on the Panels button again, closes the menu', async () => {
  const { doc } = await setup();
  openPanels(doc);
  doc.getElementById('panels-open').click();
  assert.equal(doc.querySelector('.panels-menu'), null);
  assert.equal(doc.getElementById('panels-open').getAttribute('aria-expanded'), 'false');
  openPanels(doc);
  doc.body.click();
  assert.equal(doc.querySelector('.panels-menu'), null);
});

test('the chip strip is gone from the header', async () => {
  const { doc } = await setup();
  assert.equal(doc.getElementById('detached-list'), null);
  assert.equal(doc.querySelector('.detached-chip'), null);
});

test('with every panel away or in a window the board says where to find them', async () => {
  const { doc } = await setup();
  assert.equal(doc.getElementById('board-empty').hidden, true);
  for (const panel of Object.keys(PANELS)) {
    openPanels(doc);
    if (row(doc, panel).querySelector('[role="menuitem"]')?.textContent === 'Show') choose(doc, panel, 'Put away');
    else doc.getElementById('panels-open').click();
  }
  const empty = doc.getElementById('board-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.querySelector('.guide').textContent, /Panels menu/);
  assert.equal(empty.querySelector('.terse').textContent, 'Empty');
  openPanels(doc);
  assert.equal(Object.values(states(doc)).every((state) => state === 'Put away'), true);
  choose(doc, 'photo', 'Show here');
  assert.equal(doc.getElementById('board-empty').hidden, true);
});

test('the empty board offers the Panels menu itself', async () => {
  const { doc } = await setup();
  for (const panel of Object.keys(PANELS)) {
    openPanels(doc);
    if (actions(doc, panel)[0] === 'Show') choose(doc, panel, 'Put away');
    else doc.getElementById('panels-open').click();
  }
  const button = doc.getElementById('board-empty-panels');
  assert.equal(button.getAttribute('aria-keyshortcuts'), 'Control+Shift+P');
  button.click();
  assert.ok(doc.querySelector('.panels-menu'), 'the menu opens');
  assert.equal(doc.activeElement, row(doc, 'board').querySelector('[role="menuitem"]'));
});

test('while a panel is dragged an empty region opens up as a drop target and folds away after', async () => {
  const { dom, doc, regionOf } = await setup();
  const board = doc.getElementById('board-panel');
  const bottom = doc.getElementById('region-bottom');
  assert.equal(bottom.classList.contains('empty'), true);
  assert.equal(bottom.querySelector('.region-drop').textContent, 'Drop here: Bottom');
  assert.equal(board.classList.contains('has-bottom'), false);

  const tab = [...doc.querySelectorAll('.region-tab')].find((t) => t.textContent === 'Wiki');
  const start = new dom.window.Event('dragstart', { bubbles: true });
  start.dataTransfer = { setData() {}, effectAllowed: '' };
  tab.dispatchEvent(start);
  assert.equal(board.classList.contains('dragging'), false, 'not inside dragstart itself');
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(board.classList.contains('dragging'), true);
  assert.equal(board.classList.contains('has-bottom'), true);

  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  drop.dataTransfer = { getData: (type) => (type === 'application/x-pcbv-panel' ? 'wiki' : '') };
  bottom.querySelector('.region-body').dispatchEvent(drop);
  assert.equal(tab.isConnected, false, 'the redraw replaced the dragged tab');
  tab.dispatchEvent(new dom.window.Event('dragend', { bubbles: true }));   // as a browser does: it never reaches the document
  assert.equal(regionOf('wiki'), 'bottom');
  assert.equal(board.classList.contains('dragging'), false);
  assert.equal(board.classList.contains('has-bottom'), true, 'the region now holds a panel');
  assert.equal(board.classList.contains('has-left'), true);
});

test('a drag that ends without a drop leaves the empty regions folded away', async () => {
  const { dom, doc } = await setup();
  const board = doc.getElementById('board-panel');
  const tab = [...doc.querySelectorAll('.region-tab')].find((t) => t.textContent === 'Wiki');
  const start = new dom.window.Event('dragstart', { bubbles: true });
  start.dataTransfer = { setData() {}, effectAllowed: '' };
  tab.dispatchEvent(start);
  tab.dispatchEvent(new dom.window.Event('dragend', { bubbles: true }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(board.classList.contains('dragging'), false, 'a drag that ended before the timer does not open them');
  assert.equal(board.classList.contains('has-bottom'), false);
});

test('an action aimed at a put-away panel brings it back instead of running on a hidden panel', async () => {
  const { doc, dock, regionOf } = await setup();
  openPanels(doc);
  choose(doc, 'photo', 'Put away');
  assert.equal(dock.holds('photo'), true);
  assert.equal(dock.isDocked('photo'), false);
  assert.equal(dock.route('photo'), 'here');
  assert.equal(regionOf('photo'), 'center');
});

test('a workspace saved before the Panels menu existed loads with nothing away', async () => {
  const saved = { regions: { left: ['board', 'inspector', 'feed'], center: ['photo'], right: ['playbook', 'wiki', 'console', 'timeline', 'logic', 'terminal', 'assistant'], bottom: [] },
    active: { left: 'board', center: 'photo', right: 'playbook', bottom: null },
    modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' }, detached: [], origins: {} };
  const { doc, dock } = await setup({ loaded: { current: 'Old', saved: { Old: saved } } });
  assert.deepEqual(dock.layout().away, []);
  openPanels(doc);
  assert.equal(Object.values(states(doc)).includes('Put away'), false);
});

test('activeBeside names the panel in front in the region of another panel, else null', async () => {
  const { dock, regionOf } = await setup();
  const region = regionOf('wiki');
  const front = dock.layout().active[region];
  if (front === 'wiki') assert.equal(dock.activeBeside('wiki'), null);
  else assert.equal(dock.activeBeside('wiki'), front);
  dock.show('wiki');
  assert.equal(dock.activeBeside('wiki'), null, 'the Wiki is in front itself');
  const other = dock.layout().regions[region].find((p) => p !== 'wiki');
  dock.show(other);
  assert.equal(dock.activeBeside('wiki'), other);
});

test('activeBeside is null for a panel that is put away or in its own window', async () => {
  const { dock } = await setup();
  dock.lend({ regions: { left: [], center: ['photo'], right: [], bottom: [] }, active: { center: 'photo' }, modes: {}, detached: [], away: ['wiki'], origins: {} });
  assert.equal(dock.activeBeside('wiki'), null);
});

test('while locked, show() leaves a put-away panel away and still brings a docked tab forward', async () => {
  const { doc, dock, regionOf } = await setup();
  openPanels(doc);
  choose(doc, 'timeline', 'Put away');
  assert.deepEqual(dock.layout().away, ['timeline']);
  dock.lock(true);
  const before = JSON.stringify(dock.layout());
  dock.show('timeline');
  assert.equal(JSON.stringify(dock.layout()), before, 'a locked dock does not attach it');
  assert.equal(regionOf('timeline'), null);
  dock.show('wiki');
  assert.equal(doc.getElementById('panel-wiki').hidden, false, 'a panel in the layout still comes forward');
  dock.lock(false);
  dock.show('timeline');
  assert.deepEqual(dock.layout().away, [], 'unlocked, it attaches as before');
  assert.notEqual(regionOf('timeline'), null);
});
