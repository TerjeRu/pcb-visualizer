import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createView } from '../js/ui.js';
import { PRESETS } from '../js/core/layout.js';
import { makeChannelHub, makeTimers } from './fakes.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const session = { captureId: 'cap_1', board: 'nimbus', port: '/dev/ttyUSB0', label: 'Virtual board', baud: 115200, path: 'captures/serial/x.log' };
// Every window handle is watched by a one-second interval in the dock; closing them all lets the process end.
const everyHandle = [];
after(() => everyHandle.forEach((handle) => { handle.closed = true; }));
const profile = { base_url: 'http://127.0.0.1:9/v1', model: 'm', price_in: 0, price_out: 0, key_set: true };

/** One app window on a shared channel: the main window, or a panel window when `single` is given. */
async function openWindow(connect, { single = null, layout = null, handle = null, slug = null, generation = 0, opener = null } = {}) {
  // The service's address, as in the app: a blank page's origin is "null", which postMessage cannot target.
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1:8765/' });
  if (opener) Object.defineProperty(dom.window, 'opener', { value: opener, configurable: true });
  const doc = dom.window.document;
  const calls = [];
  const timers = makeTimers();
  const handles = [];
  if (handle) everyHandle.push(...Object.values(handle));
  const handlers = {
    assistantGet: async () => ({ default: 'tutor', keyring: { available: true }, usage: {}, profiles: { tutor: profile, analyst: profile, local: profile } }),
    assistantChat: async (body) => { calls.push(['chat', body]); return { reply: 'ok', model: 'm', profile: 'tutor', tools: [], usage: null, totals: null }; },
    assistantConversation: async () => ({ messages: [] }),
    assistantProposals: async () => ({ proposals: [] }),
    loadWikiIndex: async () => [],
    loadWikiPage: async (name) => { calls.push(['page', name]); return { name, title: name, origin: 'builtin', markdown: `# ${name}` }; },
    onSelectBoard: (next) => calls.push(['select', next]),
    focusWindow: () => calls.push(['focus']),
    loadWorkspaces: async () => (layout ? { current: 'Test', saved: { Test: layout } } : null),
    openPanelWindow: (panel, gen) => {
      const w = { closed: false, focused: 0, close() { this.closed = true; }, focus() { this.focused += 1; } };
      handles.push([panel, gen, w]);
      everyHandle.push(w);
      return w;
    },
    findShellWindow: (panel) => (handle && panel in handle ? handle[panel] : null),
  };
  const view = createView(doc, handlers, timers, { single, channel: connect(), slug, generation });
  view.setAssistant('on');
  doc.getElementById('board-panel').hidden = false;
  view.startLayout();
  await tick();
  const regionOf = (panel) => doc.getElementById(`panel-${panel}`).closest('.region')?.dataset.region ?? null;
  const askAboutLog = () => {
    view.serialMessage({ op: 'serial', state: session });
    doc.getElementById('serial-ask').click();
  };
  return { dom, doc, view, calls, timers, handles, regionOf, askAboutLog };
}

const detachedAssistant = () => ({ ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, right: PRESETS.Learn.regions.right.filter((p) => p !== 'assistant') }, detached: ['assistant'], origins: { assistant: { region: 'right', index: 6 } } });
const chats = (w) => w.calls.filter((c) => c[0] === 'chat');
const noticeShown = (w) => !w.doc.getElementById('delivery-notice').hidden;

test('a docked panel is shown and used directly, with nothing sent to other windows', async () => {
  const connect = makeChannelHub();
  const probe = connect();
  const heard = [];
  probe.onmessage = (event) => heard.push(event.data.type);
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('nimbus');
  main.askAboutLog();
  await tick(); await tick();
  assert.equal(chats(main).length, 1);
  assert.deepEqual(chats(main)[0][1].context, { capture: 'cap_1' });
  assert.equal(main.doc.querySelector('#region-right .region-tab[aria-selected="true"]').textContent, 'Agent');
  assert.deepEqual(heard.filter((type) => type === 'action'), []);
});

test('a panel in another window gets the action once, that window comes forward, and no notice appears', async () => {
  const connect = makeChannelHub();
  const windowHandle = { closed: false, focused: 0, focus() { this.focused += 1; }, close() {} };
  everyHandle.push(windowHandle);
  const panel = await openWindow(connect, { single: 'assistant', slug: 'nimbus', generation: 0 });
  const main = await openWindow(connect, { layout: detachedAssistant(), handle: { assistant: windowHandle }, generation: 10 });
  main.view.boardChanged('nimbus');
  main.askAboutLog();
  await tick(); await tick(); await tick();
  assert.equal(chats(panel).length, 1, 'asked in the window that has the panel');
  assert.deepEqual(chats(panel)[0][1].context, { capture: 'cap_1' });
  assert.equal(chats(main).length, 0, 'not asked in the hidden copy');
  assert.equal(windowHandle.focused, 1);
  assert.equal(panel.calls.filter((c) => c[0] === 'focus').length, 1, 'the receiving window raises itself too');
  assert.equal(noticeShown(main), false);
});

test('a panel that does not answer is reported with Retry and Bring back, and nothing runs by itself', async () => {
  const connect = makeChannelHub();
  const windowHandle = { closed: false, focused: 0, focus() { this.focused += 1; }, close() { this.closed = true; } };
  everyHandle.push(windowHandle);
  const probe = connect();
  const sent = [];
  probe.onmessage = (event) => { if (event.data.type === 'action') sent.push(event.data); };
  const main = await openWindow(connect, { layout: detachedAssistant(), handle: { assistant: windowHandle }, generation: 10 });
  main.view.boardChanged('nimbus');
  main.askAboutLog();
  assert.equal(noticeShown(main), false, 'still waiting');
  main.timers.fire();
  await tick();
  assert.equal(noticeShown(main), true);
  assert.match(main.doc.getElementById('delivery-text').textContent, /panel did not respond/);
  assert.equal(main.doc.getElementById('delivery-retry').hidden, false);
  assert.equal(main.doc.getElementById('delivery-back').hidden, false);
  assert.equal(sent.length, 1, 'one request, not repeated on its own');
  assert.equal(chats(main).length, 0, 'never run in a hidden panel');

  main.doc.getElementById('delivery-retry').click();
  assert.equal(sent.length, 2, 'Retry sends it again');
  assert.notEqual(sent[1].id, sent[0].id);
  main.timers.fire();
  await tick();
  main.doc.getElementById('delivery-back').click();
  assert.equal(noticeShown(main), false);
  assert.equal(windowHandle.closed, true);
  assert.equal(main.regionOf('assistant'), 'right', 'the panel is back in this window');
  assert.equal(chats(main).length, 0, 'bringing it back does not ask the question');
});

test('a late acknowledgement after the notice does not run or clear anything', async () => {
  const connect = makeChannelHub();
  const windowHandle = { closed: false, focus() {}, close() {} };
  const probe = connect();
  let request = null;
  probe.onmessage = (event) => { if (event.data.type === 'action') request = event.data; };
  const main = await openWindow(connect, { layout: detachedAssistant(), handle: { assistant: windowHandle }, generation: 10 });
  main.view.boardChanged('nimbus');
  main.askAboutLog();
  main.timers.fire();
  await tick();
  probe.postMessage({ type: 'ack', id: request.id });
  await tick();
  assert.equal(noticeShown(main), true, 'the notice stays');
  assert.equal(chats(main).length, 0);
});

test('a panel whose window is gone comes back to its place and is used there', async () => {
  const connect = makeChannelHub();
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('nimbus');
  const select = main.doc.getElementById('workspace-select');
  select.value = 'Wall';
  select.dispatchEvent(new main.dom.window.Event('change'));
  assert.equal(main.regionOf('assistant'), null, 'the Wall workspace gave the panel a window');
  const [, , assistantWindow] = main.handles.find(([panel]) => panel === 'assistant');
  assistantWindow.closed = true;
  main.askAboutLog();
  await tick(); await tick();
  assert.notEqual(main.regionOf('assistant'), null);
  assert.equal(chats(main).length, 1);
  assert.equal(noticeShown(main), false);
  for (const [, , w] of main.handles) w.closed = true;
});

test('a panel window sends its question to the window that has the Agent panel', async () => {
  const connect = makeChannelHub();
  const main = await openWindow(connect, { generation: 10 });
  const consoleWindow = await openWindow(connect, { single: 'console', slug: 'nimbus', generation: 0 });
  main.view.boardChanged('nimbus');
  consoleWindow.askAboutLog();
  await tick(); await tick(); await tick();
  assert.equal(chats(main).length, 1);
  assert.deepEqual(chats(main)[0][1].context, { capture: 'cap_1' });
  assert.equal(chats(consoleWindow).length, 0, 'the hidden Agent panel in the Console window stays unused');
  assert.equal(main.calls.filter((c) => c[0] === 'focus').length, 1);
  assert.equal(noticeShown(consoleWindow), false);
});

test('a left-over window whose panel the main window took back closes, so a question runs only once', async () => {
  const connect = makeChannelHub();
  // Windows from an earlier main tab: the new main window cannot reach them, as when their opener was closed.
  const oldAgent = await openWindow(connect, { single: 'assistant', slug: 'nimbus', generation: 0 });
  let closed = false;
  oldAgent.dom.window.close = () => { closed = true; };
  const consoleWindow = await openWindow(connect, { single: 'console', slug: 'nimbus', generation: 0 });
  const main = await openWindow(connect, { layout: detachedAssistant(), generation: 10 });
  assert.equal(closed, false, 'the main window first waits for a late hello');
  main.timers.fire();
  await tick();
  assert.equal(main.regionOf('assistant'), 'right', 'no window answered, so the Agent panel came home');
  assert.equal(closed, true);
  assert.match(oldAgent.doc.getElementById('message').textContent, /back in the main window/);
  main.view.boardChanged('nimbus');
  consoleWindow.askAboutLog();
  await tick(); await tick(); await tick();
  assert.equal(chats(main).length, 1);
  assert.equal(chats(oldAgent).length, 0, 'the left-over Agent window does not ask a second time');
});

test('a window whose hello comes after the main window took its panel back retires, though its opener is open', async () => {
  const connect = makeChannelHub();
  let main = null;
  let late = [];        // hellos held back until the main window has stopped waiting
  const opener = { closed: false, postMessage: (data, origin) => late.push(() => main.dom.window.dispatchEvent(new main.dom.window.MessageEvent('message', { data, origin, source: oldAgent.dom.window }))) };
  const oldAgent = await openWindow(connect, { single: 'assistant', slug: 'nimbus', generation: 0, opener });
  let closed = false;
  oldAgent.dom.window.close = () => { closed = true; };
  // jsdom leaves a posted message's origin empty; a browser fills in the sender's, which is the same here.
  const win = oldAgent.dom.window;
  win.postMessage = (data, origin) => win.dispatchEvent(new win.MessageEvent('message', { data, origin }));
  const consoleWindow = await openWindow(connect, { single: 'console', slug: 'nimbus', generation: 0 });
  main = await openWindow(connect, { layout: detachedAssistant(), generation: 10 });
  main.timers.fire();
  await tick();
  assert.equal(main.regionOf('assistant'), 'right', 'no hello in time, so the Agent panel came home');
  assert.equal(closed, false, 'its opener is open, so the broadcast alone does not retire it');
  const held = late;
  late = [];
  held.forEach((deliver) => deliver());
  await tick(); await tick();
  assert.equal(closed, true, 'the late hello is answered with a message to that window alone');
  main.view.boardChanged('nimbus');
  consoleWindow.askAboutLog();
  await tick(); await tick(); await tick();
  assert.equal(chats(main).length, 1);
  assert.equal(chats(oldAgent).length, 0, 'the question runs in one window only');
});

test('a reloaded panel window takes the main window counter once its board is loaded', async () => {
  const connect = makeChannelHub();
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('router');
  main.view.boardChanged('nimbus');
  // Opened at 10 and reloaded: its address still says 10, the main window is at 12.
  const consoleWindow = await openWindow(connect, { single: 'console', slug: 'nimbus', generation: 10 });
  consoleWindow.view.boardChanged('nimbus');
  consoleWindow.askAboutLog();
  await tick(); await tick(); await tick();
  assert.equal(chats(main).length, 1, 'the question reached the Agent panel in the main window');
  assert.equal(noticeShown(consoleWindow), false);
});

test('a panel window cannot bring a panel back: the notice offers Retry only', async () => {
  const connect = makeChannelHub();
  const consoleWindow = await openWindow(connect, { single: 'console', slug: 'nimbus', generation: 3 });
  consoleWindow.askAboutLog();
  consoleWindow.timers.fire();
  await tick();
  assert.equal(noticeShown(consoleWindow), true);
  assert.equal(consoleWindow.doc.getElementById('delivery-back').hidden, true);
  assert.equal(consoleWindow.doc.getElementById('delivery-retry').hidden, false);
});

test('wiki links in the main window reach a Wiki that lives in its own window', async () => {
  const connect = makeChannelHub();
  const layout = { ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, right: PRESETS.Learn.regions.right.filter((p) => p !== 'wiki') }, detached: ['wiki'], origins: { wiki: { region: 'right', index: 1 } } };
  const wikiWindow = await openWindow(connect, { single: 'wiki', slug: 'nimbus', generation: 0 });
  const main = await openWindow(connect, { layout, handle: { wiki: { closed: false, focus() {}, close() {} } }, generation: 10 });
  main.view.boardChanged('nimbus');
  main.doc.querySelector('#panel-console .explainer a[data-wiki="uart"]').click();
  await tick(); await tick(); await tick();
  assert.deepEqual(wikiWindow.calls.filter((c) => c[0] === 'page'), [['page', 'uart']]);
  assert.deepEqual(main.calls.filter((c) => c[0] === 'page'), []);
});

test('messages for another board, or with unusable content, run nothing', async () => {
  const connect = makeChannelHub();
  const sender = connect();
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('nimbus');
  const post = (extra) => sender.postMessage({ type: 'action', id: crypto.randomUUID(), panel: 'assistant', slug: 'nimbus', generation: 11, action: 'ask', payload: { text: 'hello' }, ...extra });
  post({ slug: 'router' });
  post({ generation: 10 });
  post({ payload: { text: 'x'.repeat(8001) } });
  post({ payload: { text: 42 } });
  post({ action: 'jump', panel: 'photo', payload: { target: 'not an object' } });
  post({ action: 'wiki', panel: 'wiki', payload: { name: '../secrets' } });
  await tick(); await tick();
  assert.equal(chats(main).length, 0);
  assert.equal(main.calls.filter((c) => c[0] === 'page').length, 0);
  post({});
  await tick(); await tick();
  assert.equal(chats(main).length, 1, 'the same message for the right board and generation does run');
});

test('a jump from another window shows the target panel', async () => {
  const connect = makeChannelHub();
  const sender = connect();
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('nimbus');
  sender.postMessage({ type: 'action', id: crypto.randomUUID(), panel: 'logic', slug: 'nimbus', generation: 11, action: 'jump', payload: { target: { kind: 'logic', id: 'cap_1' } } });
  assert.equal(main.doc.querySelector('#region-right .region-tab[aria-selected="true"]').textContent, 'Logic');
});

test('panel windows follow the main window to another board; the board picker is not theirs', async () => {
  const connect = makeChannelHub();
  const consoleWindow = await openWindow(connect, { single: 'console', slug: 'nimbus', generation: 0 });
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('nimbus');
  main.view.boardChanged('router');
  assert.deepEqual(consoleWindow.calls.filter((c) => c[0] === 'select'), [['select', 'router']]);
  assert.equal(main.calls.filter((c) => c[0] === 'select').length, 0, 'the main window follows nobody');
  consoleWindow.view.boardChanged('router');
  assert.ok(consoleWindow.doc.getElementById('board-field'));
});

test('the main window counts every board change, and a window opened later starts from the count', async () => {
  const connect = makeChannelHub();
  const probe = connect();
  const generations = [];
  probe.onmessage = (event) => { if (event.data.type === 'board') generations.push(event.data.generation); };
  const main = await openWindow(connect, { generation: 10 });
  main.view.boardChanged('nimbus');
  main.view.boardChanged('router');
  main.view.boardChanged('nimbus');
  assert.deepEqual(generations, [11, 12, 13]);
  assert.equal(main.handles.length, 0);
  const select = main.doc.getElementById('workspace-select');
  select.value = 'Console';
  select.dispatchEvent(new main.dom.window.Event('change'));
  assert.equal(main.handles[0][1], 13, 'the new window is told the current count');
  main.handles[0][2].closed = true;
});

test('without a channel the notice says so instead of failing silently', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const handle = { closed: false, focus() {}, close() {} };
  everyHandle.push(handle);
  const view = createView(doc, {
    loadWorkspaces: async () => ({ current: 'Test', saved: { Test: detachedAssistant() } }),
    findShellWindow: () => handle,
  }, makeTimers(), {});
  view.setAssistant('on');
  doc.getElementById('board-panel').hidden = false;
  view.startLayout();
  await tick();
  view.serialMessage({ op: 'serial', state: session });
  doc.getElementById('serial-ask').click();
  await tick();
  assert.equal(doc.getElementById('delivery-notice').hidden, false);
  assert.match(doc.getElementById('delivery-text').textContent, /cannot pass requests between windows/);
});

const askers = ['pin-ask', 'photo-ask', 'serial-ask', 'logic-ask'];
const marked = (doc) => [...doc.querySelectorAll('[data-ai]')];

test('a fresh window starts with the assistant off: Ask buttons and the Agent panel are marked and out of every region', async () => {
  const w = await openWindow(makeChannelHub());
  w.view.setAssistant('off');
  assert.equal(w.doc.documentElement.dataset.assistant, 'off');
  const ids = marked(w.doc).map((n) => n.id);
  for (const id of [...askers, 'panel-assistant']) assert.ok(ids.includes(id), `${id} has data-ai`);
  assert.equal(w.regionOf('assistant'), null, 'the Agent panel is in no region');
  assert.equal(w.doc.getElementById('panel-assistant').closest('#panel-store') !== null, true, 'it waits in the store');
  assert.equal(w.doc.querySelector('.region-tab[id="region-tab-assistant"]'), null, 'no tab');
  assert.ok(![...w.doc.querySelectorAll('.region-tab')].some((t) => t.textContent === 'Agent'));
  w.view.setAssistant('on');
  assert.equal(w.doc.documentElement.dataset.assistant, 'on');
  assert.equal(w.regionOf('assistant'), 'right', 'turning it on brings the panel back without a reload');
});

test('the Ask button a playbook step draws is marked data-ai too', async () => {
  const w = await openWindow(makeChannelHub());
  const playbook = { id: 'pb', title: 'T', steps: [{ id: 's1', title: 'One', guide: 'g', checks: [] }] };
  w.view.setPlaybooks([playbook], []);
  w.view.showBoardPanel();
  w.view.render({ status: 'live', project: { meta: { name: 'B' }, assets: [], markers: [], schematics: [], components: [], playbooks: [] }, feed: [], error: null });
  const ask = w.doc.querySelector('.ask-assistant');
  assert.ok(ask, 'the step shows an Ask button');
  assert.equal(ask.hasAttribute('data-ai'), true);
});

test('a question sent to the Agent panel while the assistant is off runs nothing', async () => {
  const w = await openWindow(makeChannelHub());
  w.view.setAssistant('off');
  w.view.serialMessage({ op: 'serial', state: session });
  w.doc.getElementById('serial-ask').click();
  await tick(); await tick();
  assert.equal(chats(w).length, 0);
});

test('turning the assistant off closes the Agent window and takes the panel out of the layout', async () => {
  const connect = makeChannelHub();
  const windowHandle = { closed: false, focused: 0, focus() {}, close() { this.closed = true; } };
  everyHandle.push(windowHandle);
  const main = await openWindow(connect, { layout: detachedAssistant(), handle: { assistant: windowHandle }, generation: 10 });
  const agentRow = () => {
    main.doc.getElementById('panels-open').click();
    const found = main.doc.querySelector('.panels-row[data-panel="assistant"]');
    main.doc.getElementById('panels-open').click();
    return found;
  };
  assert.equal(agentRow().querySelector('.panels-state').textContent, 'Own window');
  main.view.setAssistant('off');
  assert.equal(windowHandle.closed, true, 'its window is closed');
  assert.equal(agentRow(), null, 'the Agent panel is not listed while the assistant is off');
  assert.equal(main.regionOf('assistant'), null);
  main.view.setAssistant('on');
  assert.equal(main.regionOf('assistant'), 'right');
});

test('a window that holds only the Agent panel closes itself when the assistant is turned off', async () => {
  const panel = await openWindow(makeChannelHub(), { single: 'assistant', slug: 'nimbus' });
  let closed = 0;
  panel.dom.window.close = () => { closed += 1; };
  panel.view.setAssistant('off');
  assert.equal(closed, 1);
  assert.match(panel.doc.getElementById('message').textContent, /assistant was turned off/);
});

test('a fresh window starts with git off: no Commits chip, no commit text; setGit brings them back and takes them away', async () => {
  const w = await openWindow(makeChannelHub());
  const chips = () => [...w.doc.querySelectorAll('#timeline-filters .chip')].map((chip) => chip.dataset.kind);
  assert.equal(w.doc.documentElement.dataset.git, 'off');
  assert.ok(!chips().includes('commit'));
  w.view.setGit('on');
  assert.equal(w.doc.documentElement.dataset.git, 'on');
  assert.ok(chips().includes('commit'));
  w.view.setGit('off');
  assert.ok(!chips().includes('commit'));
});
