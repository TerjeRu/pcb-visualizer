import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createConsoleView } from '../js/consoleview.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const session = { captureId: 'cap_1', board: 'board-a', port: '/dev/ttyUSB0', label: 'Virtual board', baud: 115200, path: 'captures/serial/x.log' };

function setup({ write } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.document.getElementById('panel-store').hidden = false;   // as after the layout starts
  const doc = dom.window.document;
  doc.getElementById('tab-console').hidden = false;
  const calls = [];
  const view = createConsoleView(doc, {
    listSerialPorts: async () => ({ ports: [{ path: '/dev/ttyUSB0', label: 'CP2102 (ttyUSB0)', byPath: 'pci-0:1', byId: '', serial: '0001' }], bauds: [57600, 115200] }),
    openSerial: async (...a) => { calls.push(['open', ...a]); return true; },
    closeSerial: async () => { calls.push(['close']); },
    detectBaud: async (port) => { calls.push(['detect', port]); return { best: 57600, results: [{ baud: 57600, score: 0.98 }, { baud: 115200, score: 0.2 }] }; },
    writeSerial: async (payload) => { calls.push(['write', payload]); return write ? write(payload) : { sent: payload.line ?? payload.key }; },
  });
  view.render(true);
  return { dom, doc, view, calls };
}

test('ports load, connect sends the choice, and output is drawn with highlights', async () => {
  const { doc, view, calls } = setup();
  await view.refreshPorts();
  assert.equal(doc.getElementById('serial-baud').value, '115200');
  doc.getElementById('serial-connect').click();
  await tick();
  assert.deepEqual(calls[0], ['open', '/dev/ttyUSB0', 115200]);
  view.message({ op: 'serial', state: session, backlog: 'U-Boot 2015.07-ARC (x)\r\n' });
  view.message({ op: 'serial-data', captureId: 'cap_1', text: 'Hit any key to stop autoboot:  3' });
  const rows = [...doc.querySelectorAll('#serial-output div')];
  assert.equal(rows[0].className, 'ln-bootloader');
  assert.equal(rows.at(-1).textContent, 'Hit any key to stop autoboot:  3');
  assert.ok(doc.getElementById('key-space').classList.contains('urgent'));
  assert.match(doc.getElementById('serial-status').textContent, /captures\/serial\/x\.log/);
  view.message({ op: 'serial-data', captureId: 'other', text: 'ignored' });
  assert.equal(doc.querySelectorAll('#serial-output div').length, 2);
});

test('the black screen is a short band until a session starts, stays tall for a finished log, and folds when cleared', () => {
  const { doc, view } = setup();
  const out = doc.getElementById('serial-output');
  assert.equal(out.classList.contains('folded'), true, 'no session, nothing printed');
  view.message({ op: 'serial', state: session, backlog: 'U-Boot 2015.07-ARC (x)\r\n' });
  assert.equal(out.classList.contains('folded'), false, 'a session runs');
  view.message({ op: 'serial', state: null });
  assert.equal(out.classList.contains('folded'), false, 'the log of the finished session stays readable');
  doc.getElementById('serial-clear').click();
  assert.equal(out.classList.contains('folded'), true, 'nothing left to read');
  view.message({ op: 'serial', state: session, backlog: '' });
  assert.equal(out.classList.contains('folded'), false, 'a session runs, even before the first line');
});

test('typed lines and keys are sent, and the input clears after sending', async () => {
  const { doc, view, calls } = setup();
  view.message({ op: 'serial', state: session, backlog: '' });
  const input = doc.getElementById('serial-input');
  input.value = 'printenv';
  doc.getElementById('serial-form').requestSubmit();
  await tick();
  doc.getElementById('key-space').click();
  assert.deepEqual(calls.filter((c) => c[0] === 'write').map((c) => c[1]), [{ line: 'printenv', confirm: false, sessionId: 'cap_1' }, { key: 'space', sessionId: 'cap_1' }]);
  assert.equal(input.value, '');
});

test('a destructive command needs the exact command typed again', async () => {
  const { doc, view, calls } = setup({ write: (p) => (p.line === 'saveenv' && !p.confirm ? { confirm: true, message: 'saves settings to flash' } : { sent: p.line }) });
  view.message({ op: 'serial', state: session, backlog: '' });
  doc.getElementById('serial-input').value = 'saveenv';
  doc.getElementById('serial-form').requestSubmit();
  await tick();
  assert.equal(doc.getElementById('serial-confirm').hidden, false);
  assert.match(doc.getElementById('confirm-reason').textContent, /saves settings to flash.*board-a.*ttyUSB0.*115200/);
  doc.getElementById('confirm-input').value = 'saveenv ';
  doc.getElementById('confirm-form').requestSubmit();
  await tick();
  assert.equal(doc.getElementById('confirm-error').hidden, false);
  assert.equal(calls.filter((c) => c[0] === 'write').length, 1, 'a near miss sends nothing');
  doc.getElementById('confirm-input').value = 'saveenv';
  doc.getElementById('confirm-form').requestSubmit();
  await tick();
  assert.deepEqual(calls.at(-1), ['write', { line: 'saveenv', confirm: true, sessionId: 'cap_1' }]);
  assert.equal(doc.getElementById('serial-confirm').hidden, true);
});

test('a late confirmation response is discarded after a board reset', async () => {
  let resolveWrite;
  const { doc, view } = setup({ write: () => new Promise((resolve) => { resolveWrite = resolve; }) });
  view.message({ op: 'serial', state: session });
  doc.getElementById('serial-input').value = 'saveenv';
  doc.getElementById('serial-form').requestSubmit();
  view.reset();
  resolveWrite({ confirm: true, message: 'confirmation required' });
  await tick();
  assert.equal(doc.getElementById('serial-confirm').hidden, true);
});

test('a pending confirmation is cleared when the console is replaced', async () => {
  const { doc, view, calls } = setup({ write: () => ({ confirm: true, message: 'confirmation required' }) });
  view.message({ op: 'serial', state: session });
  doc.getElementById('serial-input').value = 'saveenv';
  doc.getElementById('serial-form').requestSubmit();
  await tick();
  assert.equal(doc.getElementById('serial-confirm').hidden, false);
  view.message({ op: 'serial', state: { ...session, captureId: 'cap_2' } });
  assert.equal(doc.getElementById('serial-confirm').hidden, true);
  doc.getElementById('confirm-input').value = 'saveenv';
  doc.getElementById('confirm-form').requestSubmit();
  await tick();
  assert.equal(calls.filter(([name]) => name === 'write').length, 1);
});

test('confirmation is present in both guidance modes', async () => {
  const { doc, view } = setup({ write: () => ({ confirm: true, message: 'confirmation required' }) });
  view.message({ op: 'serial', state: session });
  for (const mode of ['guided', 'expert']) {
    doc.documentElement.dataset.guidance = mode;
    doc.getElementById('serial-input').value = 'saveenv';
    doc.getElementById('serial-form').requestSubmit();
    await tick();
    const dialog = doc.getElementById('serial-confirm');
    assert.equal(dialog.hidden, false);
    assert.equal(dialog.closest('.guide'), null);
    doc.getElementById('confirm-cancel').click();
  }
});

test('controls follow the session and a lost port is reported', async () => {
  const { doc, view } = setup();
  await view.refreshPorts();
  assert.equal(doc.getElementById('serial-input').disabled, true);
  view.message({ op: 'serial', state: session, backlog: '' });
  assert.equal(doc.getElementById('serial-input').disabled, false);
  assert.equal(doc.getElementById('serial-connect').textContent, 'Disconnect');
  view.message({ op: 'serial', state: null, reason: 'port lost: device disconnected' });
  assert.match(doc.getElementById('serial-status').textContent, /port lost/);
});

test('board output stays text', () => {
  const { doc, view } = setup();
  view.message({ op: 'serial', state: session, backlog: '<img src=x onerror=alert(1)>\n' });
  assert.equal(doc.querySelectorAll('#serial-output img').length, 0);
  assert.match(doc.getElementById('serial-output').textContent, /<img src=x/);
});

test('detect sets the best speed and says how readable each was', async () => {
  const { doc, view, calls } = setup();
  await view.refreshPorts();
  doc.getElementById('serial-detect').click();
  assert.equal(doc.getElementById('serial-detect').disabled, true, 'disabled while listening');
  await tick();
  assert.deepEqual(calls.at(-1), ['detect', '/dev/ttyUSB0']);
  assert.equal(doc.getElementById('serial-baud').value, '57600');
  assert.match(doc.getElementById('serial-status').textContent, /Best match: 57600 baud \(readable: 57600: 98%, 115200: 20%\)/);
  assert.equal(doc.getElementById('serial-detect').disabled, false);
});

test('Ask about this log sends the open session, or the newest capture when nothing is open', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const asked = [];
  const view = createConsoleView(doc, { listSerialPorts: async () => ({ ports: [], bauds: [] }), onAsk: (...a) => asked.push(a) });
  view.render(true, { captures: [] });
  assert.equal(doc.getElementById('serial-ask').disabled, true, 'nothing to ask about yet');
  view.render(true, { captures: [{ id: 'cap_old', kind: 'serial' }, { id: 'cap_sh', kind: 'shell' }] });
  doc.getElementById('serial-ask').click();
  assert.deepEqual(asked.at(-1), ['What does this boot log tell me?', { capture: 'cap_old' }]);
  view.message({ op: 'serial', state: session });
  doc.getElementById('serial-ask').click();
  assert.deepEqual(asked.at(-1)[1], { capture: 'cap_1' });
});

test('a speed test that finishes after a board switch does not touch the new board', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const view = createConsoleView(doc, {
    listSerialPorts: async () => ({ ports: [{ path: '/dev/ttyUSB0', label: 'CP2102' }], bauds: [57600, 115200] }),
    detectBaud: () => slow,
  });
  view.render(true);
  await view.refreshPorts();
  doc.getElementById('serial-detect').click();
  assert.equal(doc.getElementById('serial-detect').disabled, true);
  view.reset();
  assert.equal(doc.getElementById('serial-detect').disabled, false, 'the new board can test speeds at once');
  release({ best: 57600, results: [{ baud: 57600, score: 1 }] });
  await tick();
  assert.equal(doc.getElementById('serial-baud').value, '115200');
  assert.doesNotMatch(doc.getElementById('serial-status').textContent, /Best match/);
});

function vdevSetup(initial) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const calls = [];
  let status = initial;
  let ports = [{ path: '/dev/ttyUSB0', label: 'CP2102 (ttyUSB0)' }];
  const view = createConsoleView(doc, {
    listSerialPorts: async () => { calls.push('ports'); return { ports, bauds: [115200] }; },
    vdevStatus: async () => { calls.push('status'); return status; },
    startVdev: async () => {
      calls.push('start');
      status = { running: true, owned: true, path: '/run/ttyPCBV0' };
      ports = [...ports, { path: '/run/ttyPCBV0', label: 'Virtual board (pcbv vdev)', virtual: true }];
      return status;
    },
    stopVdev: async () => {
      calls.push('stop');
      status = { running: false, owned: false, path: '/run/ttyPCBV0' };
      ports = ports.filter((p) => !p.virtual);
      return status;
    },
  });
  view.render(true);
  const shown = (id) => !doc.getElementById(id).hidden;
  return { doc, view, calls, shown };
}

test('the virtual board buttons follow its state: Start when none runs, Stop only for one the app started', async () => {
  const idle = vdevSetup({ running: false, owned: false });
  await idle.view.refreshPorts();
  assert.deepEqual([idle.shown('vdev-bar'), idle.shown('vdev-start'), idle.shown('vdev-stop')], [true, true, false]);

  const mine = vdevSetup({ running: true, owned: true });
  await mine.view.refreshPorts();
  assert.deepEqual([mine.shown('vdev-bar'), mine.shown('vdev-start'), mine.shown('vdev-stop')], [true, false, true]);

  const foreign = vdevSetup({ running: true, owned: false });
  await foreign.view.refreshPorts();
  assert.equal(foreign.shown('vdev-bar'), false, 'a board started in a terminal cannot be stopped from here');
});

test('Start lists the ports again and selects the virtual board; Stop removes it from the list', async () => {
  const t = vdevSetup({ running: false, owned: false });
  await t.view.refreshPorts();
  t.doc.getElementById('vdev-start').click();
  await tick(); await tick();
  assert.equal(t.doc.getElementById('serial-port').value, '/run/ttyPCBV0');
  assert.deepEqual([t.shown('vdev-start'), t.shown('vdev-stop')], [false, true]);
  assert.ok(t.calls.indexOf('start') < t.calls.lastIndexOf('ports'), 'ports were listed again after the start');
  t.doc.getElementById('vdev-stop').click();
  await tick(); await tick();
  assert.deepEqual([...t.doc.getElementById('serial-port').options].map((o) => o.value), ['/dev/ttyUSB0']);
  assert.deepEqual([t.shown('vdev-start'), t.shown('vdev-stop')], [true, false]);
});

test('keyboard focus moves to the button that replaces the one pressed', async () => {
  const t = vdevSetup({ running: false, owned: false });
  t.doc.getElementById('board-panel').hidden = false;    // jsdom focuses nothing inside a hidden element
  await t.view.refreshPorts();
  t.doc.getElementById('vdev-start').focus();
  t.doc.getElementById('vdev-start').click();
  await tick(); await tick();
  assert.equal(t.doc.activeElement.id, 'vdev-stop');
  t.doc.getElementById('vdev-stop').click();
  await tick(); await tick();
  assert.equal(t.doc.activeElement.id, 'vdev-start');
});

test('the virtual board buttons are disabled while a serial session is open, and a failed start says why', async () => {
  const t = vdevSetup({ running: false, owned: false });
  await t.view.refreshPorts();
  t.view.message({ op: 'serial', state: session, backlog: '' });
  assert.equal(t.doc.getElementById('vdev-start').disabled, true);
  t.view.message({ op: 'serial', state: null, reason: 'closed' });
  await tick(); await tick();
  assert.equal(t.doc.getElementById('vdev-start').disabled, false);

  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const view = createConsoleView(doc, {
    listSerialPorts: async () => ({ ports: [], bauds: [115200] }),
    vdevStatus: async () => ({ running: false, owned: false }),
    startVdev: async () => { throw new Error('pcbv: [Errno 17] File exists'); },
  });
  view.render(true);
  await view.refreshPorts();
  doc.getElementById('vdev-start').click();
  await tick(); await tick();
  assert.match(doc.getElementById('serial-status').textContent, /File exists/);
  assert.equal(doc.getElementById('vdev-start').disabled, false);
});

test('without a service answer the virtual board bar stays hidden', async () => {
  const { doc, view } = setup();
  await view.refreshPorts();
  assert.equal(doc.getElementById('vdev-bar').hidden, true);
});

// The tutorial's hold on the Console (21c).
function tutorialConsole({ bauds = [9600, 57600, 115200], notes = [] } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const state = { status: { running: false, owned: false }, ports: [{ path: '/dev/ttyUSB0', label: 'CP2102 (ttyUSB0)' }] };
  const view = createConsoleView(doc, {
    listSerialPorts: async () => ({ ports: state.ports, bauds }),
    vdevStatus: async () => state.status,
    startVdev: async () => {
      state.status = { running: true, owned: true };
      state.ports = [...state.ports, { path: '/run/ttyPCBV0', label: 'Virtual board (pcbv vdev)', virtual: true }];
      return state.status;
    },
    openSerial: async () => true,
    writeSerial: async () => ({ sent: 'x' }),
    noteConsole: (event) => notes.push(event),
  });
  view.render(true);
  const ports = () => [...doc.getElementById('serial-port').options].map((o) => o.value);
  return { doc, view, notes, state, ports, baud: () => doc.getElementById('serial-baud').value };
}

test('in the tutorial the port list shows the virtual board only, and a start from the coach selects it', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  assert.deepEqual(t.ports(), ['/dev/ttyUSB0']);
  t.view.tutorial({});
  await tick(); await tick();
  assert.deepEqual(t.ports(), [''], 'no virtual board yet: nothing to choose');
  assert.match(t.doc.getElementById('serial-port').options[0].textContent, /Start the virtual board/);
  t.view.startVirtualBoard();
  await tick(); await tick(); await tick();
  assert.deepEqual(t.ports(), ['/run/ttyPCBV0']);
  assert.equal(t.doc.getElementById('serial-port').value, '/run/ttyPCBV0');
  t.view.tutorial(null);
  await tick(); await tick();
  assert.deepEqual(t.ports(), ['/dev/ttyUSB0', '/run/ttyPCBV0'], 'every port is back when it ends');
});

test('the tutorial\'s speed is applied once; the person\'s own choice stays', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  assert.equal(t.baud(), '115200');
  t.view.tutorial({ baud: 9600 });
  assert.equal(t.baud(), '9600');
  t.doc.getElementById('serial-baud').value = '57600';
  await t.view.refreshPorts();
  assert.equal(t.baud(), '57600', 'listing the ports again does not put 9600 back');
  t.view.tutorial({ baud: 115200 });
  assert.equal(t.baud(), '115200');
  t.view.tutorial({});
  assert.equal(t.baud(), '115200', 'a step with no wish leaves it');
  t.view.tutorial(null);
  assert.equal(t.baud(), '115200', 'back to what it was before the tutorial');
});

test('a speed asked for before the list of speeds exists is applied when it arrives, and never while a port is open', async () => {
  const early = tutorialConsole();
  early.view.tutorial({ baud: 9600 });
  assert.equal(early.baud(), '');
  await early.view.refreshPorts();
  assert.equal(early.baud(), '9600');

  const open = tutorialConsole();
  await open.view.refreshPorts();
  open.view.message({ op: 'serial', state: { captureId: 'c', board: 'b', port: 'p', label: 'x', baud: 115200, path: 'p' }, backlog: '' });
  open.view.tutorial({ baud: 9600 });
  assert.equal(open.baud(), '115200');
});

test('the tutorial restores the speed the person had before it', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  t.doc.getElementById('serial-baud').value = '57600';
  t.view.tutorial({ baud: 9600 });
  assert.equal(t.baud(), '9600');
  t.view.tutorial(null);
  assert.equal(t.baud(), '57600');
});

test('the Console reports the session, the board\'s text, the speed, what was sent and the virtual board', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  assert.deepEqual(t.notes.filter((n) => n.kind === 'vdev').at(-1), { kind: 'vdev', running: false });
  t.doc.getElementById('serial-baud').value = '57600';
  t.doc.getElementById('serial-baud').dispatchEvent(new t.doc.defaultView.Event('change'));
  assert.deepEqual(t.notes.at(-1), { kind: 'baud', value: 57600 });
  t.view.message({ op: 'serial', state: session, backlog: 'U-Boot' });
  t.view.message({ op: 'serial-data', captureId: 'cap_1', text: ' 2015' });
  t.view.message({ op: 'serial-data', captureId: 'other', text: 'not mine' });
  assert.deepEqual(t.notes.filter((n) => ['session', 'backlog', 'data'].includes(n.kind)), [
    { kind: 'session', state: session }, { kind: 'backlog', text: 'U-Boot' }, { kind: 'data', text: ' 2015' },
  ]);
  t.doc.getElementById('serial-input').value = 'printenv';
  t.doc.getElementById('serial-form').requestSubmit();
  await tick();
  assert.deepEqual(t.notes.at(-1), { kind: 'sent', what: 'line' });
  t.view.message({ op: 'serial', state: null, reason: 'closed' });
  assert.deepEqual(t.notes.filter((n) => n.kind === 'session').at(-1), { kind: 'session', state: null });
  t.view.startVirtualBoard();
  await tick(); await tick(); await tick();
  assert.deepEqual(t.notes.filter((n) => n.kind === 'vdev').at(-1), { kind: 'vdev', running: true });
});

test('a reconnect sends the backlog again and the screen shows it once', () => {
  const { doc, view } = setup();
  const rows = () => [...doc.querySelectorAll('#serial-output div')].map((r) => r.textContent.trim()).filter(Boolean);
  view.message({ op: 'serial', state: session, backlog: 'one\r\ntwo\r\n' });
  view.message({ op: 'serial', state: session, backlog: 'one\r\ntwo\r\n' });
  assert.deepEqual(rows(), ['one', 'two']);
  view.message({ op: 'serial-data', captureId: 'cap_1', text: 'three\r\n' });
  assert.deepEqual(rows(), ['one', 'two', 'three']);
});

test('when detect is refused the status line no longer says it is listening', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  doc.getElementById('panel-store').hidden = false;
  const view = createConsoleView(doc, {
    listSerialPorts: async () => ({ ports: [{ path: '/dev/ttyUSB0', label: 'CP2102 (ttyUSB0)' }], bauds: [57600, 115200] }),
    detectBaud: async () => null,
  });
  view.render(true);
  await view.refreshPorts();
  doc.getElementById('serial-detect').click();
  await tick();
  assert.doesNotMatch(doc.getElementById('serial-status').textContent, /tests each speed/);
  assert.equal(doc.getElementById('serial-detect').disabled, false);
});

const closedMessage = { op: 'serial', state: null, reason: 'closed' };
const openSession = { captureId: 'c', board: 'b', port: 'p', label: 'x', baud: 115200, path: 'p' };

test('leaving the tutorial with a session open puts the earlier speed back when the session closes', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  t.doc.getElementById('serial-baud').value = '57600';
  t.view.tutorial({});
  t.view.tutorial({ baud: 115200 });
  t.view.message({ op: 'serial', state: openSession, backlog: '' });
  t.view.tutorial(null);
  t.view.message(closedMessage);
  await tick();
  assert.equal(t.baud(), '57600');
});

test('a speed the person chooses between leaving and the close message stays', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  t.doc.getElementById('serial-baud').value = '57600';
  t.view.tutorial({ baud: 115200 });
  t.view.message({ op: 'serial', state: openSession, backlog: '' });
  t.view.tutorial(null);
  const select = t.doc.getElementById('serial-baud');
  select.value = '9600';
  select.dispatchEvent(new t.doc.defaultView.Event('change'));
  t.view.message(closedMessage);
  await tick();
  assert.equal(t.baud(), '9600');
});

test('a tutorial that starts again before the close message keeps the speed from before the first one', async () => {
  const t = tutorialConsole();
  await t.view.refreshPorts();
  t.doc.getElementById('serial-baud').value = '57600';
  t.view.tutorial({ baud: 115200 });
  t.view.message({ op: 'serial', state: openSession, backlog: '' });
  t.view.tutorial(null);
  t.view.tutorial({});
  t.view.message(closedMessage);
  await tick();
  assert.equal(t.baud(), '115200', 'the tutorial is running, so its speed stays');
  t.view.tutorial(null);
  assert.equal(t.baud(), '57600');
});
