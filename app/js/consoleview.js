// The Console tab: choose a serial port and speed, watch the board talk, send commands.
// Output arrives as text over the board's WebSocket and is drawn through core/terminal.js; the raw
// bytes are captured to the board folder by the service. Input is line by line, plus buttons for
// the keys a console needs. Commands the service flags as destructive need the command typed again.
// Board output is untrusted and is only ever set with textContent.

import { classifyLine, createScreen } from './core/terminal.js';
import { dom } from './dom.js';

export function createConsoleView(doc, handlers) {
  const { $, options } = dom(doc);
  const screen = createScreen();
  let state = null;              // the open session for this board, or null
  let editable = false;
  let latestCapture = null;      // the board's newest console capture, for "Ask about this log" when not connected
  let pendingConfirm = null;     // { line, reason } while a destructive command waits for confirmation
  let generation = 0;
  let boardGeneration = 0;           // bumped by reset() only, so a speed test for the previous board is dropped
  let lastReason = '';
  let follow = true;                 // follow output until the person scrolls up
  let detecting = false;
  let vdev = null;                   // {running, owned} from the service, or null when it cannot be read
  let vdevBusy = false;
  let tutorialMode = false;          // the tutorial lists the virtual board's port only and starts at the speed it asks for
  let wantedBaud = null;             // a speed the tutorial asked for, applied once the list of speeds is there
  let savedBaud = null;              // the speed to put back when the tutorial ends
  const history = [];
  let historyIndex = 0;
  const out = $('serial-output');

  const note = (event) => handlers.noteConsole?.(event);
  const chosenBaud = () => Number($('serial-baud').value) || 0;

  out.addEventListener('scroll', () => { follow = out.scrollTop + out.clientHeight >= out.scrollHeight - 8; });

  async function refreshPorts() {
    try {
      const listed = await handlers.listSerialPorts();
      const { bauds } = listed;
      const ports = tutorialMode ? listed.ports.filter((p) => p.label.startsWith('Virtual board')) : listed.ports;
      const select = $('serial-port');
      const keep = select.value;
      options(select, (ports.length ? ports : [{ path: '', label: tutorialMode ? 'Start the virtual board to get a port' : 'No serial ports found' }]).map((p) => ({
        value: p.path,
        label: p.label,
        title: [p.byPath, p.byId, p.serial && `serial ${p.serial}`].filter(Boolean).join('\n'),
      })));
      if (ports.some((p) => p.path === keep)) select.value = keep;
      const baud = $('serial-baud');
      if (!baud.options.length) {
        options(baud, bauds.map((b) => ({ value: String(b), label: `${b} baud` })));
        baud.value = '115200';
      }
      applyBaud();
      drawControls();
    } catch (error) {
      status(`Could not list ports: ${error.message}`);
    }
    await refreshVdev();
  }

  /** The tutorial's speed, applied once and only while no port is open; the person's own choice is never overridden afterwards. */
  function applyBaud() {
    const baud = $('serial-baud');
    if (wantedBaud === null || state || ![...baud.options].some((o) => o.value === String(wantedBaud))) return;
    baud.value = String(wantedBaud);
    wantedBaud = null;
    note({ kind: 'baud', value: chosenBaud() });
  }

  async function refreshVdev() {
    try { vdev = handlers.vdevStatus ? await handlers.vdevStatus() : null; } catch { vdev = null; }
    note({ kind: 'vdev', running: Boolean(vdev?.running) });
    drawControls();
  }

  /** Starts or stops the virtual board, then lists the ports again; after a start the new port is chosen. */
  async function runVdev(action, selectIt) {
    const hadFocus = ['vdev-start', 'vdev-stop'].includes(doc.activeElement?.id);
    vdevBusy = true;
    lastReason = '';
    drawControls();
    try {
      vdev = await action();
      note({ kind: 'vdev', running: Boolean(vdev?.running) });
      await refreshPorts();
      if (selectIt) {
        const select = $('serial-port');
        const port = [...select.options].find((o) => o.textContent.startsWith('Virtual board'));
        if (port) select.value = port.value;
        drawControls();
      }
    } catch (error) {
      lastReason = error.message;       // shown by drawControls until the next action
      await refreshVdev();
    } finally {
      vdevBusy = false;
      drawControls();
      // The pressed button hides itself; keep keyboard focus on the one that took its place.
      if (hadFocus) [$('vdev-start'), $('vdev-stop')].find((button) => !button.hidden && !$('vdev-bar').hidden)?.focus();
    }
  }
  $('vdev-start').addEventListener('click', () => runVdev(handlers.startVdev, true));
  $('serial-baud').addEventListener('change', () => {
    if (!tutorialMode) savedBaud = null;       // the person chose again after the tutorial ended; nothing is put back over it
    note({ kind: 'baud', value: chosenBaud() });
  });
  $('vdev-stop').addEventListener('click', () => runVdev(handlers.stopVdev, false));

  $('serial-ask').addEventListener('click', () => {
    const capture = state?.captureId ?? latestCapture;
    if (capture) handlers.onAsk?.('What does this boot log tell me?', { capture });
  });

  function status(text) { $('serial-status').textContent = text; }

  function drawControls() {
    const open = Boolean(state);
    const hasPort = Boolean($('serial-port').value);
    $('serial-port').disabled = open || !editable;
    $('serial-baud').disabled = open || !editable;
    $('serial-refresh').disabled = open;
    $('serial-detect').disabled = open || !editable || !hasPort || detecting;
    // Start shows while no virtual board runs; Stop only for one this app started. Neither works during a session.
    $('vdev-bar').hidden = !vdev || (vdev.running && !vdev.owned);
    $('vdev-start').hidden = Boolean(vdev?.running);
    $('vdev-stop').hidden = !vdev?.running;
    $('vdev-start').disabled = $('vdev-stop').disabled = open || !editable || vdevBusy;
    $('serial-connect').textContent = open ? 'Disconnect' : 'Connect';
    $('serial-connect').disabled = !editable || (!open && !hasPort);
    for (const id of ['serial-input', 'serial-send', 'key-enter', 'key-space', 'key-ctrl-c']) $(id).disabled = !open || !editable || Boolean(state?.recordingError);
    $('serial-ask').disabled = !(state?.captureId || latestCapture);
    status(state?.recordingError ?? (open ? `Connected to ${state.label} at ${state.baud} baud. Captured to ${state.path}` : lastReason || 'Not connected.'));
  }

  function drawOutput(firstChanged) {
    const lines = screen.lines();
    const offset = screen.offset();
    // Drop lines that scrolled out of the buffer, then redraw from the first changed line on.
    while (out.firstChild && Number(out.firstChild.dataset.n) < offset) out.firstChild.remove();
    for (const node of [...out.children]) if (Number(node.dataset.n) >= firstChanged) node.remove();
    const fragment = doc.createDocumentFragment();
    for (let n = Math.max(firstChanged, offset); n < offset + lines.length; n++) {
      const text = lines[n - offset];
      const row = doc.createElement('div');
      row.dataset.n = String(n);
      const kind = classifyLine(text);
      if (kind) row.className = `ln-${kind}`;
      row.textContent = text || ' ';
      fragment.append(row);
    }
    out.append(fragment);
    const last = lines.at(-1) ?? '';
    const prev = lines.at(-2) ?? '';
    $('key-space').classList.toggle('urgent', classifyLine(last) === 'autoboot' || classifyLine(prev) === 'autoboot' && last.trim() === '');
    if (follow) out.scrollTop = out.scrollHeight;
  }

  $('serial-refresh').addEventListener('click', refreshPorts);
  $('serial-detect').addEventListener('click', async () => {
    detecting = true;
    drawControls();
    status('The app tests each speed for a few seconds. Power-cycle the board now so it prints its boot messages.');
    const started = boardGeneration;
    const result = await handlers.detectBaud($('serial-port').value);
    if (started !== boardGeneration) return;
    detecting = false;
    drawControls();
    if (!result) return;
    const top = (result.results ?? []).slice(0, 3).map((r) => `${r.baud}: ${Math.round((r.score ?? 0) * 100)}%`).join(', ');
    if (result.best) {
      $('serial-baud').value = String(result.best);
      status(`Best match: ${result.best} baud (readable: ${top}). Press Connect.`);
    } else {
      status(`No clear match (readable: ${top || 'no output'}). Power-cycle the board and try again. If the board prints nothing, check the wiring.`);
    }
  });
  $('serial-connect').addEventListener('click', async () => {
    if (state) { await handlers.closeSerial(); return; }
    await handlers.openSerial($('serial-port').value, Number($('serial-baud').value));
  });

  async function send(line, confirm = false) {
    const sentGeneration = generation;
    const result = await handlers.writeSerial({ line, confirm, sessionId: state?.captureId }, state?.board);
    if (sentGeneration !== generation) return false;
    if (result?.confirm) {
      pendingConfirm = { line, reason: result.message };
      $('confirm-reason').textContent = `${result.message} Board: ${state.board}; port: ${state.port}; baud: ${state.baud}.`;
      $('confirm-command').textContent = line;
      $('confirm-input').value = '';
      $('serial-confirm').hidden = false;
      $('confirm-input').focus();
      return false;
    }
    return Boolean(result?.sent);
  }

  $('serial-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('serial-input');
    const line = input.value;
    if (await send(line)) {
      note({ kind: 'sent', what: 'line' });
      if (line.trim()) { history.push(line); historyIndex = history.length; }
      input.value = '';
    }
  });
  $('serial-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' && historyIndex > 0) { historyIndex -= 1; event.target.value = history[historyIndex]; event.preventDefault(); }
    if (event.key === 'ArrowDown') { historyIndex = Math.min(history.length, historyIndex + 1); event.target.value = history[historyIndex] ?? ''; event.preventDefault(); }
  });
  for (const [id, key] of [['key-enter', 'enter'], ['key-space', 'space'], ['key-ctrl-c', 'ctrl-c']]) {
    $(id).addEventListener('click', () => handlers.writeSerial({ key, sessionId: state?.captureId }, state?.board));
  }
  $('serial-clear').addEventListener('click', () => { screen.clear(); out.replaceChildren(); });

  $('confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingConfirm || $('confirm-input').value !== pendingConfirm.line) {
      $('confirm-error').hidden = false;
      return;
    }
    const { line } = pendingConfirm;
    pendingConfirm = null;
    $('serial-confirm').hidden = true;
    $('confirm-error').hidden = true;
    if (await send(line, true)) $('serial-input').value = '';
  });
  $('confirm-cancel').addEventListener('click', () => {
    pendingConfirm = null;
    $('serial-confirm').hidden = true;
    $('confirm-error').hidden = true;
    $('serial-input').focus();
  });

  return {
    /** A serial message from the board's WebSocket. */
    message(msg) {
      if (msg.op === 'serial') {
        const changed = (msg.state?.captureId ?? null) !== (state?.captureId ?? null);
        if (changed) clearConfirmation();
        state = msg.state ?? null;
        note({ kind: 'session', state });
        lastReason = !state && msg.reason && msg.reason !== 'closed' ? `Disconnected: ${msg.reason}` : '';
        // The backlog is the whole recent output, so a reconnect to the same session starts the screen over too.
        if (state && (changed || msg.backlog)) { screen.clear(); out.replaceChildren(); }
        if (msg.backlog) { note({ kind: 'backlog', text: msg.backlog }); drawOutput(screen.write(msg.backlog)); }
        if (!state && msg.reason && msg.reason !== 'closed') status(`Disconnected: ${msg.reason}`);
        else drawControls();
        if (!state) { restoreBaud(); refreshPorts(); }
      } else if (msg.op === 'serial-data' && state && msg.captureId === state.captureId) {
        note({ kind: 'data', text: msg.text });
        drawOutput(screen.write(msg.text));
      }
    },
    render(isEditable, project) {
      const newest = (project?.captures ?? []).filter((c) => c.kind === 'serial').at(-1)?.id ?? null;
      if (editable !== isEditable || newest !== latestCapture) { editable = isEditable; latestCapture = newest; drawControls(); }
    },
    reset() {
      boardGeneration += 1;
      detecting = false;
      clearConfirmation();
      state = null;
      lastReason = '';
      screen.clear();
      out.replaceChildren();
      drawControls();
    },
    refreshPorts,
    /** The coach's Start the virtual board: the same action as the button in this panel. */
    startVirtualBoard: () => runVdev(handlers.startVdev, true),
    /**
     * The tutorial takes over the port list (the virtual board only) and may ask for a speed; null gives
     * both back. Called when it starts, at each step and when it ends.
     */
    tutorial(setup) {
      const on = setup !== null && setup !== undefined;
      if (on && !tutorialMode && savedBaud === null) savedBaud = $('serial-baud').value || '115200';     // the list of speeds may not be there yet; its default is 115200
      if (on && setup.baud) wantedBaud = setup.baud;
      if (on) applyBaud();
      if (on === tutorialMode) return;
      tutorialMode = on;
      if (!on) {
        wantedBaud = null;
        if (!state) restoreBaud();         // with a session open, the message that it closed does it
      }
      refreshPorts();
    },
  };

  function restoreBaud() {
    if (tutorialMode || savedBaud === null) return;
    if ([...$('serial-baud').options].some((o) => o.value === savedBaud)) $('serial-baud').value = savedBaud;
    savedBaud = null;
  }

  function clearConfirmation() {
    generation += 1;
    pendingConfirm = null;
    $('serial-confirm').hidden = true;
    $('confirm-error').hidden = true;
  }
}
