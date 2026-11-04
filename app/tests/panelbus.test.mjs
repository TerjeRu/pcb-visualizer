import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACK_TIMEOUT_MS, HELLO_WAIT_MS, MAX_MESSAGE_BYTES, createPanelBus } from '../js/panelbus.js';
import { makeChannelHub as hub, makeTimers as fakeTimers } from './fakes.mjs';

const ORIGIN = 'http://127.0.0.1:8765';
const ids = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })();

function fakeWin({ opener = null } = {}) {
  const listeners = new Set();
  return {
    opener, location: { origin: ORIGIN },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
    dispatch(event) { listeners.forEach((fn) => fn(event)); },
  };
}

function setup({ mainSlug = 'nimbus', panelSlug = 'nimbus', local = ['console'], mainLocal = [], mainGeneration = 5, panelGeneration = 5 } = {}) {
  const connect = hub();
  const log = [];
  const timers = fakeTimers();
  const mainWin = fakeWin();
  const main = createPanelBus({
    channel: connect(), win: mainWin, slug: mainSlug, generation: mainGeneration,
    isLocal: (name) => mainLocal.includes(name), onAction: (...args) => log.push(['main-action', ...args]), timers, uuid: ids,
  });
  const panelChannel = connect();
  const origPost = panelChannel.postMessage.bind(panelChannel);
  panelChannel.postMessage = (data) => { log.push(['posted', data.type]); origPost(data); };
  const panelWin = fakeWin({ opener: { closed: false, postMessage: (data, origin) => log.push(['hello', data, origin]) } });
  const panel = createPanelBus({
    channel: panelChannel, win: panelWin, panel: 'console', slug: panelSlug, generation: panelGeneration,
    isLocal: (name) => local.includes(name),
    onAction: (...args) => log.push(['action', ...args]),
    onBoard: (slug) => log.push(['board', slug]),
    onRetired: () => log.push(['retired']),
    timers, uuid: ids,
  });
  return { main, panel, mainWin, panelWin, log, timers, connect };
}

test('an action reaches the window that has the panel once, and the sender hears back', async () => {
  const { main, log } = setup();
  const result = await main.send('console', 'ask', { text: 'What is this?', context: { capture: 'cap_1' } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(log.filter((e) => e[0] === 'action'), [['action', 'console', 'ask', { text: 'What is this?', context: { capture: 'cap_1' } }]]);
});

test('a panel window the main window took its panel back from retires and runs nothing more', async () => {
  const { main, panelWin, timers, log } = setup();
  panelWin.opener.closed = true;
  main.panelHome('wiki');
  assert.equal(log.some((e) => e[0] === 'retired'), false, 'another panel coming home leaves this window alone');
  main.panelHome('console');
  main.panelHome('console');
  assert.deepEqual(log.filter((e) => e[0] === 'retired'), [['retired']]);
  const result = main.send('console', 'ask', { text: 'x' });
  timers.fire();
  assert.equal((await result).reason, 'timeout');
  assert.equal(log.some((e) => e[0] === 'action'), false, 'no second copy of the question runs');
});

test('a second main tab cannot retire a panel window whose own opener is still open', async () => {
  const { log, connect } = setup();
  const secondTab = createPanelBus({ channel: connect(), win: fakeWin(), slug: 'nimbus', generation: 9, isLocal: () => false, onAction() {} });
  secondTab.panelHome('console');
  assert.equal(log.some((e) => e[0] === 'retired'), false);
});

test('the receiver acknowledges before it runs the action', async () => {
  const { main, log } = setup();
  await main.send('console', 'wiki', { name: 'uart' });
  const kinds = log.filter((e) => e[0] === 'posted' || e[0] === 'action').map((e) => e[0] === 'posted' ? e[1] : 'run');
  assert.deepEqual(kinds, ['ack', 'run']);
});

test('the sender waits two seconds, then reports that nobody answered', async () => {
  const { main, timers } = setup({ local: [] });
  timers.fire();                     // the wait for hellos after start
  const result = main.send('console', 'ask', { text: 'x' });
  assert.deepEqual(timers.delays(), [ACK_TIMEOUT_MS]);
  timers.fire();
  assert.deepEqual(await result, { ok: false, reason: 'timeout' });
});

test('a message for another board is ignored', async () => {
  const { main, timers, log } = setup({ panelSlug: 'router' });
  const result = main.send('console', 'ask', { text: 'x' });
  timers.fire();
  assert.equal((await result).reason, 'timeout');
  assert.equal(log.some((e) => e[0] === 'action'), false);
});

test('panel windows follow the main window to a new board, and stale actions are rejected, even A to B to A', async () => {
  const { main, panel, log, connect } = setup();
  const staleGeneration = main.generation();
  main.announceBoard('router');
  main.announceBoard('nimbus');
  assert.deepEqual(log.filter((e) => e[0] === 'board'), [['board', 'router'], ['board', 'nimbus']]);
  assert.equal(panel.generation(), main.generation());
  assert.equal(panel.slug(), 'nimbus');
  assert.deepEqual(await main.send('console', 'ask', { text: 'current' }), { ok: true });
  connect().postMessage({ type: 'action', id: ids(), panel: 'console', slug: 'nimbus', generation: staleGeneration, action: 'ask', payload: { text: 'old' } });
  assert.deepEqual(log.filter((e) => e[0] === 'action').map((e) => e[3].text), ['current'], 'the board name matches again, the generation does not');
});

test('a board message from before the last one is not followed', () => {
  const { main, panel, log, connect } = setup();
  main.announceBoard('router');
  connect().postMessage({ type: 'board', slug: 'nimbus', generation: main.generation() - 1 });
  connect().postMessage({ type: 'board', slug: '../etc', generation: main.generation() + 1 });
  assert.equal(panel.slug(), 'router');
  assert.deepEqual(log.filter((e) => e[0] === 'board'), [['board', 'router']]);
});

test('the main window accepts a message only from its own generation', () => {
  const { log, connect } = setup({ mainLocal: ['photo'] });
  const sender = connect();
  const message = (generation) => ({ type: 'action', id: ids(), panel: 'photo', slug: 'nimbus', generation, action: 'jump', payload: { target: { kind: 'asset', id: 'img_1' } } });
  sender.postMessage(message(4));
  sender.postMessage(message(6));
  assert.equal(log.filter((e) => e[0] === 'main-action').length, 0, 'older and newer generations are both refused');
  sender.postMessage(message(5));
  assert.equal(log.filter((e) => e[0] === 'main-action').length, 1);
});

test('a repeated message is acknowledged again but runs once', () => {
  const { log, connect } = setup();
  const sender = connect();
  const acks = [];
  sender.onmessage = (event) => { if (event.data.type === 'ack') acks.push(event.data.id); };
  const message = { type: 'action', id: ids(), panel: 'console', slug: 'nimbus', generation: 5, action: 'jump', payload: { target: { kind: 'logic', id: 'cap_1' } } };
  sender.postMessage(message);
  sender.postMessage(message);
  assert.equal(log.filter((e) => e[0] === 'action').length, 1);
  assert.deepEqual(acks, [message.id, message.id]);
});

test('only the last 256 ids are remembered', () => {
  const connect = hub();
  const sender = connect();
  const ran = [];
  createPanelBus({ channel: connect(), win: fakeWin(), panel: 'console', slug: 'nimbus', generation: 1, isLocal: () => true, onAction: (...a) => ran.push(a), timers: fakeTimers(), uuid: ids });
  const make = (id) => ({ type: 'action', id, panel: 'console', slug: 'nimbus', generation: 1, action: 'wiki', payload: { name: 'uart' } });
  const first = ids();
  sender.postMessage(make(first));
  for (let i = 0; i < 255; i += 1) sender.postMessage(make(ids()));
  sender.postMessage(make(first));
  assert.equal(ran.length, 256, 'still remembered after 255 others');
  sender.postMessage(make(ids()));
  sender.postMessage(make(first));
  assert.equal(ran.length, 258, 'forgotten after more than 256 others');
});

test('oversized messages are refused by the sender and by the receiver', async () => {
  const { main, log, connect } = setup();
  const big = { text: 'x'.repeat(MAX_MESSAGE_BYTES) };
  assert.deepEqual(await main.send('console', 'ask', big), { ok: false, reason: 'too-large' });
  const sender = connect();
  sender.postMessage({ type: 'action', id: ids(), panel: 'console', slug: 'nimbus', generation: 5, action: 'ask', payload: big });
  assert.equal(log.some((e) => e[0] === 'action'), false);
  const near = { text: 'x'.repeat(MAX_MESSAGE_BYTES - 400) };
  assert.deepEqual(await main.send('console', 'ask', near), { ok: true }, 'just under the cap still goes through');
});

test('a late acknowledgement runs nothing and resolves nothing twice', async () => {
  const { main, timers, connect } = setup({ local: [] });
  const sender = connect();
  const sent = [];
  sender.onmessage = (event) => sent.push(event.data);
  const result = main.send('console', 'ask', { text: 'x' });
  timers.fire();
  assert.equal((await result).reason, 'timeout');
  const late = sent.find((m) => m.type === 'action');
  sender.postMessage({ type: 'ack', id: late.id });
  assert.equal((await result).reason, 'timeout', 'the outcome stays a timeout');
});

test('unknown actions, panels and payloads are ignored by the receiver', () => {
  const { log, connect } = setup();
  const sender = connect();
  const base = { type: 'action', slug: 'nimbus', generation: 5, panel: 'console', action: 'ask', payload: { text: 'x' } };
  for (const bad of [
    { ...base, id: ids(), action: 'delete' }, { ...base, id: ids(), panel: 'nope' }, { ...base, id: ids(), payload: 'text' },
    { ...base, id: ids(), payload: [1] }, { ...base, id: 'not-a-uuid' }, { ...base, id: ids(), generation: 'five' }, null, 'junk',
  ]) sender.postMessage(bad);
  assert.equal(log.some((e) => e[0] === 'action'), false);
});

test('without a channel nothing is sent and the caller is told', async () => {
  const bus = createPanelBus({ channel: null, win: fakeWin(), slug: 'nimbus', generation: 1, isLocal: () => false, onAction() {}, uuid: ids });
  assert.deepEqual(await bus.send('console', 'ask', { text: 'x' }), { ok: false, reason: 'unavailable' });
});

test('requests for unknown panels, unknown actions or no board are refused before sending', async () => {
  const { main } = setup();
  assert.equal((await main.send('nope', 'ask', {})).reason, 'invalid');
  assert.equal((await main.send('console', 'delete', {})).reason, 'invalid');
  const noBoard = setup({ mainSlug: null });
  assert.equal((await noBoard.main.send('console', 'ask', {})).reason, 'invalid');
});

test('a panel window greets its opener at start and whenever a main window starts', () => {
  const { log, connect } = setup();
  assert.equal(log.filter((e) => e[0] === 'hello').length, 1);
  assert.deepEqual(log.find((e) => e[0] === 'hello').slice(1), [{ type: 'pcbv:panel-hello', panel: 'console', slug: 'nimbus' }, ORIGIN]);
  createPanelBus({ channel: connect(), win: fakeWin(), slug: 'nimbus', generation: 9, isLocal: () => false, onAction() {} });
  assert.equal(log.filter((e) => e[0] === 'hello').length, 2, 'a fresh main window asks the panels to introduce themselves');
});

test('the main window remembers the windows that said hello, from its own origin only', () => {
  const { main, mainWin } = setup();
  const popup = { closed: false };
  mainWin.dispatch({ origin: 'http://evil.example', source: popup, data: { type: 'pcbv:panel-hello', panel: 'console' } });
  assert.equal(main.peer('console'), null);
  mainWin.dispatch({ origin: ORIGIN, source: popup, data: { type: 'pcbv:panel-hello', panel: 'console' } });
  assert.equal(main.peer('console'), popup);
  mainWin.dispatch({ origin: ORIGIN, source: popup, data: { type: 'pcbv:panel-hello', panel: 'not-a-panel' } });
  assert.equal(main.peer('not-a-panel'), null);
  popup.closed = true;
  assert.equal(main.peer('console'), null, 'a closed window is forgotten');
});

test('right after start the main window waits for a late hello instead of giving the window up', async () => {
  const { main, mainWin, timers } = setup();
  assert.deepEqual(timers.delays(), [HELLO_WAIT_MS]);
  const popup = { closed: false };
  const finding = main.findPeer('console');
  const missing = main.findPeer('wiki');
  mainWin.dispatch({ origin: ORIGIN, source: popup, data: { type: 'pcbv:panel-hello', panel: 'console' } });
  assert.equal(await finding, popup);
  timers.fire();
  assert.equal(await missing, null, 'a window that never answers is given up at the deadline');
  assert.equal(await main.findPeer('logic'), null, 'after the deadline nothing waits');
});

test('a panel window that loaded its board takes the main window counter, so a reloaded window is heard again', async () => {
  // Opened at generation 5; the main window switched boards since and is at 9. A reload put the window back at 5.
  const { main, panel, timers, log } = setup({ mainLocal: ['photo'], mainGeneration: 9, panelGeneration: 5 });
  const jump = { target: { kind: 'asset', id: 'img_1' } };
  const before = panel.send('photo', 'jump', jump);
  timers.fire();
  assert.equal((await before).reason, 'timeout', 'without asking, the old counter is refused');
  panel.followBoard('nimbus');
  assert.equal(panel.generation(), 9);
  assert.equal(main.generation(), 9, 'answering does not count a board change');
  assert.deepEqual(await panel.send('photo', 'jump', jump), { ok: true });
  assert.equal(log.filter((e) => e[0] === 'main-action').length, 1);
});

test('a panel window that loaded another board than the main window shows moves to the main window board', () => {
  const { panel, log } = setup({ panelSlug: 'router' });
  panel.followBoard('router');
  assert.deepEqual(log.filter((e) => e[0] === 'board'), [['board', 'nimbus']]);
  assert.equal(panel.slug(), 'nimbus');
});

/** A main window and a browser pop-up that can post to each other directly, as an opener and its window can. */
function directPair({ onHello } = {}) {
  const connect = hub();
  const log = [];
  const timers = fakeTimers();
  const mainWin = fakeWin();
  const panelWin = fakeWin({ opener: { closed: false, postMessage: (data, origin) => mainWin.dispatch({ origin, source: popup, data }) } });
  const popup = { closed: false, postMessage: (data, origin) => panelWin.dispatch({ origin, source: mainWin, data }) };
  const main = createPanelBus({
    channel: connect(), win: mainWin, slug: 'nimbus', generation: 5, isLocal: () => false, onAction() {},
    onHello: (name) => { log.push(['hello', name]); onHello?.(main, name); }, timers, uuid: ids,
  });
  timers.fire();          // the start-up wait for hellos is over
  const panel = createPanelBus({
    channel: connect(), win: panelWin, panel: 'console', slug: 'nimbus', generation: 5,
    isLocal: (name) => name === 'console', onAction: (...args) => log.push(['action', ...args]),
    onRetired: () => log.push(['retired']), timers, uuid: ids,
  });
  return { main, panel, mainWin, panelWin, popup, log, timers };
}

test('a hello that comes after the main window took the panel back makes that window retire, even with its opener open', async () => {
  const { main, log, timers } = directPair({ onHello: (bus, name) => bus.sendHome(name) });
  assert.deepEqual(log, [['hello', 'console'], ['retired']]);
  assert.equal(main.peer('console'), null, 'the retired window is not kept as the panel window');
  const result = main.send('console', 'ask', { text: 'x' });
  timers.fire();
  assert.equal((await result).reason, 'timeout');
  assert.equal(log.some((e) => e[0] === 'action'), false, 'the question runs in no second window');
});

test('panelHome also tells a window that said hello directly', () => {
  const { main, log } = directPair();
  assert.equal(log.some((e) => e[0] === 'retired'), false, 'a hello alone retires nothing');
  main.panelHome('console');
  assert.deepEqual(log.filter((e) => e[0] === 'retired'), [['retired']]);
  main.sendHome('console');
  main.sendHome('wiki');
  assert.equal(log.filter((e) => e[0] === 'retired').length, 1, 'without a window that said hello, nothing is sent');
});

test('a panel window retires directly only for its own panel and from its own origin', () => {
  const { panelWin, mainWin, log } = directPair();
  panelWin.dispatch({ origin: 'http://evil.example', source: mainWin, data: { type: 'pcbv:panel-home', panel: 'console' } });
  panelWin.dispatch({ origin: ORIGIN, source: mainWin, data: { type: 'pcbv:panel-home', panel: 'wiki' } });
  assert.equal(log.some((e) => e[0] === 'retired'), false);
});
