import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createTerminalView } from '../js/terminalview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('opening the panel does not start a session; the Start button does', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window;
  const sockets = [];
  win.Terminal = class { open() {} onData() {} onResize() {} reset() {} focus() {} write() {} };
  win.WebSocket = class { constructor(url) { sockets.push(url); } send() {} close() {} };
  const view = createTerminalView(win.document, { terminalTarget: () => ({ url: 'ws://x/term', token: 't' }) });
  view.shown();
  view.shown();
  assert.equal(sockets.length, 0);
  assert.equal(win.document.getElementById('terminal-start').hidden, false);
  win.document.getElementById('terminal-start').click();
  assert.deepEqual(sockets, ['ws://x/term']);
  assert.equal(win.document.getElementById('terminal-stop').hidden, false);
});

test('recovery refusal stays visible after the terminal socket closes', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window;
  const sockets = [];
  win.Terminal = class { open() {} onData() {} onResize() {} reset() {} focus() {} write() {} };
  win.WebSocket = class { constructor() { sockets.push(this); } send() {} close() {} };
  createTerminalView(win.document, { terminalTarget: () => ({ url: 'ws://x/term', token: 't' }) });
  win.document.getElementById('terminal-start').click();
  const message = 'Reopen the board before starting a shell';
  sockets[0].onmessage({ data: JSON.stringify({ op: 'error', error: 'recovery_required', message }) });
  sockets[0].onclose({ code: 1011 });
  assert.equal(win.document.getElementById('terminal-status').textContent, message);
  assert.equal(win.document.getElementById('terminal-start').hidden, false);
});

test('a socket from before a board switch cannot touch the new session', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  const sockets = [];
  win.Terminal = class { open() {} onData() {} onResize() {} reset() {} focus() {} write() {} };
  win.WebSocket = class { constructor() { sockets.push(this); } send() {} close() {} };
  const view = createTerminalView(doc, { terminalTarget: () => ({ url: 'ws://x/term', token: 't' }) });
  doc.getElementById('terminal-start').click();
  view.reset();
  assert.equal(doc.getElementById('terminal-start').hidden, false, 'reset ends the session');
  doc.getElementById('terminal-start').click();
  assert.equal(sockets.length, 2);
  sockets[0].onmessage({ data: JSON.stringify({ op: 'error', message: 'old board refused' }) });
  sockets[0].onclose({ code: 1006 });
  assert.equal(doc.getElementById('terminal-stop').hidden, false, 'the new session is still shown as running');
  assert.notEqual(doc.getElementById('terminal-status').textContent, 'old board refused');
  sockets[1].onclose({ code: 1000 });
  assert.equal(doc.getElementById('terminal-start').hidden, false);
});

test('the screen is a short band until a session starts, grows before it is fitted, and folds again on a board switch', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  const tab = doc.getElementById('tab-terminal');
  const log = [];
  win.Terminal = class { loadAddon() {} open() {} onData() {} onResize() {} reset() {} focus() {} write() {} };
  win.FitAddon = { FitAddon: class { fit() { log.push(`fit:${tab.classList.contains('folded') ? 'folded' : 'tall'}`); } } };
  const sockets = [];
  win.WebSocket = class { constructor() { sockets.push(this); } send() {} close() {} };
  const view = createTerminalView(doc, { terminalTarget: () => ({ url: 'ws://x/term', token: 't' }) });
  assert.equal(tab.classList.contains('folded'), true, 'no session yet');
  doc.getElementById('terminal-start').click();
  assert.equal(tab.classList.contains('folded'), false);
  assert.ok(log.length > 0 && log.every((entry) => entry === 'fit:tall'), `fit ran after the screen grew: ${log}`);
  sockets[0].onclose({ code: 1000 });
  assert.equal(tab.classList.contains('folded'), false, 'the text of a finished session stays readable');
  view.reset();
  assert.equal(tab.classList.contains('folded'), true, 'a board switch starts clean');
});

test('a Start that cannot begin leaves the screen folded', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  win.Terminal = class { open() {} onData() {} onResize() {} reset() {} focus() {} write() {} };
  win.WebSocket = class {};
  createTerminalView(doc, { terminalTarget: () => null });
  doc.getElementById('terminal-start').click();
  assert.equal(doc.getElementById('tab-terminal').classList.contains('folded'), true);
  assert.equal(doc.getElementById('terminal-status').textContent, 'Choose a board first.');
});
