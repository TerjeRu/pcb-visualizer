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
