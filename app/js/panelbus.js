// Messages between the main window and panel windows (docs/DESKTOP.md, "Panel windows").
//
// An action (ask, open a wiki page, jump to a target) for a panel that lives in another window goes over
// a BroadcastChannel. The channel alone does not say whether anyone is listening, so the receiving window
// answers with an acknowledgement before it runs the action, and the sender waits two seconds for it.
// Windows reject messages for another board and from before the last board change (the generation
// the main window counts up on every switch, which also settles A to B to A). Discovery of browser panel
// windows uses a handshake with the opener, since a channel cannot hand out a window to focus or close.
// A panel window the main window could not find (its opener was closed) would otherwise run actions
// beside the main window's own copy, so the main window tells it the panel is home and it retires. A
// browser panel window whose hello comes after the main window took its panel back is told so directly.
// A panel window that loaded its board asks for the main window's board and counter, so one that was
// reloaded or opened just before a board switch does not keep a counter the main window no longer accepts.

import { PANELS } from './core/layout.js';
import { isBoardSlug } from './session.js';

export const CHANNEL_NAME = 'pcbv-panels';
export const ACTIONS = new Set(['ask', 'wiki', 'jump']);
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const ACK_TIMEOUT_MS = 2000;
// How long after start the main window waits for panel windows to answer its main-start with hello.
export const HELLO_WAIT_MS = 500;
const SEEN_LIMIT = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

/** Encoded size, or Infinity for a value that cannot be encoded at all. */
function encodedSize(value) {
  try { return encoder.encode(JSON.stringify(value)).length; } catch { return Infinity; }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * `panel` is the panel a panel window shows, or null for the main window. `isLocal(panel)` says whether
 * this window can run an action for that panel; `onAction(panel, action, payload)` runs it; `onBoard(slug)`
 * tells a panel window which board the main window moved to.
 */
export function createPanelBus({
  channel, win, panel = null, slug = null, generation = 0, isLocal, onAction, onBoard, onRetired, onHello,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) },
  uuid = () => globalThis.crypto.randomUUID(),
}) {
  const pending = new Map();         // id -> { resolve, timer }
  const seen = new Set();            // last SEEN_LIMIT ids, oldest first
  const peers = new Map();           // panel -> window that said hello (main window only)
  const waiting = new Map();         // panel -> resolvers of findPeer calls waiting for its hello
  const main = panel === null;
  let helloTimer = null;             // set while hellos to main-start may still be on their way
  let retired = false;               // panel window whose panel the main window took back; it takes no more work

  const post = (message) => { try { channel?.postMessage(message); return true; } catch { return false; } };

  function greet() {
    if (main || !win?.opener) return;
    try { win.opener.postMessage({ type: 'pcbv:panel-hello', panel, slug }, win.location.origin); } catch { /* no opener to tell */ }
  }

  function remember(id) {
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
  }

  function adoptBoard(data) {
    if (main || !isBoardSlug(data.slug) || !Number.isSafeInteger(data.generation) || data.generation < generation) return;
    generation = data.generation;
    if (data.slug === slug) return;
    slug = data.slug;
    onBoard?.(slug);
  }

  function receiveAction(data) {
    if (!UUID.test(data.id) || !(data.panel in PANELS) || !ACTIONS.has(data.action) || !isObject(data.payload)) return;
    if (data.slug !== slug || !Number.isSafeInteger(data.generation)) return;
    if (main ? data.generation !== generation : data.generation < generation) return;
    if (!main) generation = data.generation;
    if (retired || !isLocal(data.panel)) return;
    const duplicate = seen.has(data.id);
    remember(data.id);
    post({ type: 'ack', id: data.id });
    if (!duplicate) onAction(data.panel, data.action, data.payload);
  }

  function receive(data) {
    if (!isObject(data) || encodedSize(data) > MAX_MESSAGE_BYTES) return;
    if (data.type === 'ack') {
      const entry = typeof data.id === 'string' ? pending.get(data.id) : null;
      if (!entry) return;              // late: the sender already gave up and nothing may run because of it
      pending.delete(data.id);
      timers.clear(entry.timer);
      entry.resolve({ ok: true });
    } else if (data.type === 'board') adoptBoard(data);
    else if (data.type === 'action') receiveAction(data);
    else if (data.type === 'main-start') greet();
    else if (data.type === 'board-request') { if (main && isBoardSlug(slug)) post({ type: 'board', slug, generation }); }
    // Only a window whose opener is gone retires: one whose opener is still open is found by it, and the
    // message then came from another main tab, which must not close this one.
    else if (data.type === 'home' && !main && data.panel === panel && (!win?.opener || win.opener.closed)) retire();
  }

  function retire() {
    if (retired) return;
    retired = true;
    onRetired?.();
  }

  function onWindowMessage(event) {
    const data = event.data;
    if (event.origin !== win.location.origin || !isObject(data)) return;
    // Sent to this window alone by the main window that opened it, so no other tab can retire it this way.
    if (!main) { if (data.type === 'pcbv:panel-home' && data.panel === panel) retire(); return; }
    if (data.type !== 'pcbv:panel-hello' || !(data.panel in PANELS) || !event.source || event.source === win) return;
    peers.set(data.panel, event.source);
    for (const resolve of waiting.get(data.panel) ?? []) resolve(event.source);
    waiting.delete(data.panel);
    onHello?.(data.panel);
  }

  function stopWaiting() {
    timers.clear(helloTimer);
    helloTimer = null;
    for (const resolvers of waiting.values()) for (const resolve of resolvers) resolve(null);
    waiting.clear();
  }

  if (channel) channel.onmessage = (event) => receive(event.data);
  win?.addEventListener('message', onWindowMessage);
  if (main) {
    if (post({ type: 'main-start' }) && channel) helloTimer = timers.set(stopWaiting, HELLO_WAIT_MS);
  } else greet();

  return {
    generation: () => generation,
    slug: () => slug,

    /** Main window: a board was chosen. Panel windows are told to follow. */
    announceBoard(next) {
      generation += 1;
      slug = next;
      post({ type: 'board', slug, generation });
    },

    /** Main window: a panel came back here without its window answering; that window must stop taking work. */
    panelHome(name) {
      if (!main || !(name in PANELS)) return;
      post({ type: 'home', panel: name });
      this.sendHome(name);
    },

    /** Main window: tell the one window that said hello for this panel that the panel is shown here now. */
    sendHome(name) {
      const handle = main ? this.peer(name) : null;
      if (!handle) return;
      peers.delete(name);
      try { handle.postMessage({ type: 'pcbv:panel-home', panel: name }, win.location.origin); } catch { /* it closed meanwhile */ }
    },

    /** Panel window: the board this window shows was set from its own URL or from a message. It asks for the main window's board and counter. */
    followBoard(next) {
      slug = next;
      if (!main) post({ type: 'board-request' });
    },

    /** Resolves {ok: true} once the window that has the panel acknowledged, else {ok: false, reason}. */
    send(target, action, payload) {
      if (!channel) return Promise.resolve({ ok: false, reason: 'unavailable' });
      if (!(target in PANELS) || !ACTIONS.has(action) || !isBoardSlug(slug)) return Promise.resolve({ ok: false, reason: 'invalid' });
      const message = { type: 'action', id: uuid(), panel: target, slug, generation, action, payload };
      if (encodedSize(message) > MAX_MESSAGE_BYTES) return Promise.resolve({ ok: false, reason: 'too-large' });
      return new Promise((resolve) => {
        const timer = timers.set(() => { pending.delete(message.id); resolve({ ok: false, reason: 'timeout' }); }, ACK_TIMEOUT_MS);
        pending.set(message.id, { resolve, timer });
        if (!post(message)) {
          pending.delete(message.id);
          timers.clear(timer);
          resolve({ ok: false, reason: 'unavailable' });
        }
      });
    },

    /** The window of a browser panel that said hello and is still open. */
    peer(name) {
      const handle = peers.get(name);
      if (handle && !handle.closed) return handle;
      peers.delete(name);
      return null;
    },

    /** Like peer, but while hellos may still arrive after start, waits for this panel's until the deadline. */
    findPeer(name) {
      const found = this.peer(name);
      if (found || helloTimer === null) return Promise.resolve(found);
      return new Promise((resolve) => waiting.set(name, [...(waiting.get(name) ?? []), resolve]));
    },

    close() {
      stopWaiting();
      if (channel) channel.onmessage = null;
      win?.removeEventListener('message', onWindowMessage);
      for (const { timer } of pending.values()) timers.clear(timer);
      pending.clear();
      channel?.close?.();
    },
  };
}
