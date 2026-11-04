import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDesktopShell } from '../js/shell.js';

const ORIGIN = 'http://127.0.0.1:8765';
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeTauri({ existing = [] } = {}) {
  const windows = new Map(existing.map((label) => [label, { label, focused: 0, closed: false, setFocus() { this.focused += 1; return Promise.resolve(); }, close() { this.closed = true; windows.delete(label); } }]));
  class WebviewWindow {
    static async getByLabel(label) { return windows.get(label) ?? null; }
    constructor(label, options) { Object.assign(this, { label, options, focused: 0, closed: false }); windows.set(label, this); }
    setFocus() { this.focused += 1; return Promise.resolve(); }
    close() { this.closed = true; windows.delete(this.label); }
  }
  return { windows, tauri: { webviewWindow: { WebviewWindow } } };
}

function fakeTimers() {
  const live = new Map();
  let next = 0;
  return {
    setInterval(fn) { live.set(++next, fn); return next; },
    clearInterval(handle) { live.delete(handle); },
    async tick() { for (const fn of [...live.values()]) await fn(); },
    count: () => live.size,
  };
}

test('there is no shell in a plain browser', () => {
  assert.equal(createDesktopShell({}, ORIGIN), undefined);
  assert.equal(createDesktopShell(undefined, ORIGIN), undefined);
});

test('a new window gets the panel, board, generation and a one-time code in its address', async () => {
  const { tauri, windows } = fakeTauri();
  const shell = createDesktopShell(tauri, ORIGIN, fakeTimers());
  const handle = shell.openPanel('console', 'live box', async () => 'abc 123', 'Console', 7);
  await handle.ready;
  const win = windows.get('panel-console');
  assert.equal(win.options.url, `${ORIGIN}/?panel=console&board=live%20box&gen=7#code=abc%20123`);
  assert.equal(win.options.title, 'pcbv · Console');
  assert.equal(handle.win, win);
});

test('closing a window that is still being created closes it once it exists', async () => {
  const { tauri, windows } = fakeTauri();
  const shell = createDesktopShell(tauri, ORIGIN, fakeTimers());
  const handle = shell.openPanel('console', 'nimbus', async () => 'code', 'Console');
  handle.close();
  assert.equal(handle.win, null, 'the window does not exist yet');
  await handle.ready;
  await settle();
  assert.equal(handle.win.closed, true);
  assert.equal(windows.has('panel-console'), false);
});

test('asking again for the same panel reuses its window and its single watcher', async () => {
  const { tauri } = fakeTauri();
  const timers = fakeTimers();
  const shell = createDesktopShell(tauri, ORIGIN, timers);
  const first = shell.openPanel('console', 'nimbus', async () => 'code', 'Console');
  await first.ready;
  const second = shell.openPanel('console', 'nimbus', async () => 'code', 'Console');
  await second.ready;
  await settle();
  assert.equal(second, first);
  assert.equal(timers.count(), 1);
  assert.equal(first.win.focused, 1, 'the second request only focused the window');
});

test('opening a panel again right after closing it gets a new window, not the one going away', async () => {
  const { tauri, windows } = fakeTauri();
  const shell = createDesktopShell(tauri, ORIGIN, fakeTimers());
  const first = shell.openPanel('console', 'nimbus', async () => 'code', 'Console');
  await first.ready;
  first.close();
  const second = shell.openPanel('console', 'nimbus', async () => 'code', 'Console');
  assert.notEqual(second, first);
  await second.ready;
  assert.equal(first.win.closed, true);
  assert.notEqual(second.win, first.win);
  assert.equal(second.win.closed, false);
  assert.equal(windows.get('panel-console'), second.win);
});

test('a window counts as closed after it was seen and is gone, and its watcher stops', async () => {
  const { tauri, windows } = fakeTauri();
  const timers = fakeTimers();
  const shell = createDesktopShell(tauri, ORIGIN, timers);
  const handle = shell.openPanel('console', 'nimbus', async () => 'code', 'Console');
  await handle.ready;
  windows.delete('panel-console');
  await timers.tick();
  assert.equal(handle.closed, false, 'never seen yet: it may still be opening');
  windows.set('panel-console', handle.win);
  await timers.tick();
  windows.delete('panel-console');
  await timers.tick();
  assert.equal(handle.closed, true);
  assert.equal(timers.count(), 0);
});

test('a failed one-time code closes the handle instead of leaving a half-open window', async () => {
  const { tauri } = fakeTauri();
  const shell = createDesktopShell(tauri, ORIGIN, fakeTimers());
  const handle = shell.openPanel('console', 'nimbus', async () => { throw new Error('no code'); }, 'Console');
  await handle.ready;
  assert.equal(handle.closed, true);
});

test('after a reload the shell finds the windows that already exist', async () => {
  const { tauri } = fakeTauri({ existing: ['panel-timeline'] });
  const timers = fakeTimers();
  const shell = createDesktopShell(tauri, ORIGIN, timers);
  assert.equal(await shell.find('console'), null);
  const found = await shell.find('timeline');
  await found.ready;
  assert.equal(found.closed, false);
  assert.equal(found.win.label, 'panel-timeline');
  assert.equal(timers.count(), 1);
  assert.equal(await shell.find('timeline'), found, 'the same handle again');
});
