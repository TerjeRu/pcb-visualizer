import { PROTOCOL_VERSION } from './session.js';
import { readTokens } from './tokens.js';
import { dom } from './dom.js';

// The Terminal panel: xterm.js connected to a shell the service runs in the board folder. Every
// session is captured to captures/shell/ and appears in the Timeline. xterm.js is vendored in
// app/vendor/xterm (the CSP allows only same-origin scripts) and loaded as the globals Terminal and
// FitAddon; without them (tests, a broken copy) the panel says so instead of failing.

export function createTerminalView(doc, handlers) {
  const { $ } = dom(doc);
  const win = doc.defaultView;
  let term = null;
  let fit = null;
  let socket = null;
  let refused = false;
  let observer = null;

  function status(text) { $('terminal-status').textContent = text; }

  function setRunning(running) {
    $('terminal-start').hidden = running;
    $('terminal-stop').hidden = !running;
  }

  function screenTheme() {
    const t = readTokens(win, $('terminal-screen'), ['--scr-bg', '--scr-fg', '--scr-hi', '--scr-dim']);
    return { background: t['--scr-bg'], foreground: t['--scr-fg'], cursor: t['--scr-hi'], selectionBackground: t['--scr-dim'] };
  }

  function ensureTerminal() {
    if (term) return true;
    if (!win?.Terminal) {
      status('The terminal component did not load (app/vendor/xterm).');
      return false;
    }
    term = new win.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "Noto Sans Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: screenTheme(),
    });
    if (win.FitAddon?.FitAddon) {
      fit = new win.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open($('terminal-screen'));
    term.onData((data) => { if (socket?.readyState === 1) socket.send(JSON.stringify({ op: 'input', data })); });
    term.onResize(({ cols, rows }) => { if (socket?.readyState === 1) socket.send(JSON.stringify({ op: 'resize', cols, rows })); });
    if (win.ResizeObserver) {
      observer = new win.ResizeObserver(() => { try { fit?.fit(); } catch { /* not laid out */ } });
      observer.observe($('terminal-screen'));
    }
    return true;
  }

  function start() {
    if (socket || !ensureTerminal()) return;
    const target = handlers.terminalTarget?.();
    if (!target) { status('Choose a board first.'); return; }
    try { fit?.fit(); } catch { /* not laid out yet */ }
    term.reset();
    refused = false;
    const mine = new win.WebSocket(target.url);
    socket = mine;
    status('The app starts a shell in the board folder…');
    setRunning(true);
    mine.onopen = () => mine.send(JSON.stringify({ op: 'auth', protocol: PROTOCOL_VERSION, token: target.token, cols: term.cols, rows: term.rows }));
    mine.onmessage = (message) => {
      if (socket !== mine) return;
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (data.op === 'error') { refused = true; status(data.message); }
      else if (data.op === 'started') status(`The app saves the session to ${data.capture.path}. It appears in the Timeline.`);
      else if (data.op === 'output') term.write(data.data);
      else if (data.op === 'exit') status(`The shell ended (exit code ${data.code}). The session is saved.`);
    };
    mine.onclose = (event) => {
      if (socket !== mine) return;
      socket = null;
      setRunning(false);
      if (refused) return;
      if (event.code === 4409) status('The client and service protocols do not match. Reload the app.');
      else if (event.code === 4401) status('The service refused the token. Run pcbv open again.');
      else if (event.code === 1000) { if (!/ended/.test($('terminal-status').textContent)) status('Session ended. It is saved and appears in the Timeline.'); }
      else status('The terminal connection closed. The session up to here is saved.');
    };
    term.focus();
  }

  function stop() {
    socket?.close(1000);
  }

  $('terminal-start').addEventListener('click', start);
  $('terminal-stop').addEventListener('click', stop);
  setRunning(false);

  return {
    /** Called when the panel comes into view. A session starts only from the Start button, since each one is recorded. */
    shown() {
      try { fit?.fit(); } catch { /* not laid out */ }
    },
    /** Board switched or signed out: end the session. Whatever the old socket still reports is ignored. */
    reset() {
      const old = socket;
      socket = null;
      old?.close(1000);
      setRunning(false);
      term?.reset();
      status('No session. Start one to get a shell in the board folder.');
    },
  };
}
