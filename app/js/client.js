// Live connection to one board on the local service.
//
// Keeps a copy of the project current by applying the service's events (core/apply.js) and sends edits
// as events. Written for the failure cases: the service restarts, the network drops, an event is
// missed or arrives twice. The socket and the timers are injectable so tests can drive all of that.
//
// Protocol: docs/SERVICE.md ("WebSocket").

import { PROTOCOL_VERSION, UNCERTAIN_OPERATION } from './session.js';
import { applyEvent } from './core/apply.js';

const OPEN = 1; // WebSocket.OPEN
const BACKOFF_MS = [250, 500, 1000, 2000, 5000];
// A connection counts as healthy again only after it stayed up this long, so a service that accepts the
// socket and drops it at once keeps backing off.
const STABLE_MS = 60_000;
const RECENT_EVENTS = 64;     // how far back undo can look up the board before an event this window sent
// Close codes the service uses to say "do not retry, something is wrong with this connection".
const REFUSED = {
  4409: 'The client and service protocols do not match. Reload the app.',
  4401: 'The service did not accept the token. Run pcbv open to open the app again.',
  4404: 'There is no board with that name.',
  1008: 'The service refused this connection (host or origin not allowed).',
};
// 4408 alone means the service dropped a window that fell behind, which reconnects. With this reason the
// board itself is too big to send, and retrying would fail the same way.
const SLOW_CLIENT = 4408;
const TOO_LARGE_REASON = 'board-too-large';
const TOO_LARGE_MESSAGE = 'The board is too large to send.';
const NO_RETRY_ERRORS = new Set(['recovery_required', 'board_too_large']);

export class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

export class BoardClient {
  #listeners = new Set();
  #pending = new Map();
  #nextId = 0;
  #attempt = 0;
  #timer = null;
  #forceSnapshot = false;
  #closed = false;
  #socket = null;
  #liveSince = null;
  #recent = new Map();            // seq -> {before, after} for the last RECENT_EVENTS events, for undo
  #waiting = new Map();           // seq -> resolvers of around(seq)

  constructor({
    baseUrl, token, slug, actor = 'web',
    WebSocketImpl = globalThis.WebSocket,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    applyTimeoutMs = 10_000,
    now = () => Date.now(),
    random = () => Math.random(),
    onSerial = () => {},
    onSettings = () => {},
  }) {
    Object.assign(this, { baseUrl, token, slug, actor, WebSocketImpl, setTimer, clearTimer, applyTimeoutMs, now, random, onSerial, onSettings });
    this.wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/boards/${encodeURIComponent(slug)}/ws`;
    this.state = { status: 'idle', project: null, seq: 0, error: null, snapshots: 0, save: { pending: 0, at: null, error: null } };
  }

  /** Register a listener called with the new state after every change. Returns an unsubscribe function. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect() {
    if (this.#closed) throw new Error('client is closed');
    this.#open();
  }

  close() {
    this.#closed = true;
    this.#forgetRecent();
    this.#clearTimer();
    this.#rejectAll(new ClientError('closed', 'The connection was closed.'));
    this.#detach()?.close();
    this.#set({ status: 'closed' });
  }

  /**
   * Follow a write for the save state: `pending` counts writes in flight, `at` is when the last one
   * succeeded and `error` why the last one failed, until a later write succeeds. Passes the result on.
   */
  track(promise) {
    const change = (patch) => this.#set({ save: { ...this.state.save, ...patch } });
    change({ pending: this.state.save.pending + 1 });
    return promise.then(
      (value) => { change({ pending: this.state.save.pending - 1, at: this.now(), error: null }); return value; },
      (error) => { change({ pending: this.state.save.pending - 1, error: String(error?.message || error) }); throw error; },
    );
  }

  /** Send an edit. Resolves with {seq} once the service has stored it, rejects with ClientError otherwise. */
  apply(event) {
    return this.track(this.#send(event));
  }

  #send(event) {
    const socket = this.#socket;
    if (this.state.storage?.writable === false) return Promise.reject(new ClientError('recovery_required', 'Reopen the board before writing.'));
    if (this.state.status !== 'live' || !socket || socket.readyState !== OPEN) {
      return Promise.reject(new ClientError('not-connected', 'The app is not connected to the service.'));
    }
    const id = `c${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      // After a timeout the outcome is unknown: the edit may still arrive through the event stream.
      const timer = this.setTimer(() => {
        this.#pending.delete(id);
        this.#resync('uncertain operation');
        reject(new ClientError('timeout', UNCERTAIN_OPERATION));
      }, this.applyTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ op: 'apply', id, event }));
    });
  }

  refresh() { this.#resync('refreshing board state'); }

  /**
   * The board just before and just after the stored event `seq`, once this copy has it: {before, after}.
   * Null when a snapshot replaced the copy first, the client closed, or the event is too old.
   */
  around(seq) {
    if (this.#recent.has(seq)) return Promise.resolve(this.#recent.get(seq));
    if (this.#closed || seq <= this.state.seq) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiting.set(seq, [...(this.#waiting.get(seq) ?? []), resolve]));
  }

  #forgetRecent() {
    this.#recent.clear();
    for (const resolvers of this.#waiting.values()) for (const resolve of resolvers) resolve(null);
    this.#waiting.clear();
  }

  #open() {
    const resume = Boolean(this.state.project) && !this.#forceSnapshot;
    this.#set({ status: this.state.project ? 'reconnecting' : 'connecting' });
    let socket;
    try {
      socket = new this.WebSocketImpl(this.wsUrl);
    } catch (error) {
      this.#set({ status: 'rejected', error: { code: 'bad-url', message: String(error.message || error) } });
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      const hello = { op: 'auth', protocol: PROTOCOL_VERSION, token: this.token, actor: this.actor };
      if (resume) hello.sinceSeq = this.state.seq;
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (message) => {
      if (this.#socket !== socket) return;
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        this.#resync('unreadable message');
        return;
      }
      this.#handle(data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#rejectAll(new ClientError('disconnected', UNCERTAIN_OPERATION));
      if (this.#closed) return;
      if (this.state.status === 'rejected' && NO_RETRY_ERRORS.has(this.state.error?.code)) return;
      if (event.code === SLOW_CLIENT && event.reason === TOO_LARGE_REASON) {
        this.#set({ status: 'rejected', error: { code: 'board_too_large', message: TOO_LARGE_MESSAGE } });
        return;
      }
      if (REFUSED[event.code]) {
        this.#set({ status: 'rejected', error: { code: event.code, message: REFUSED[event.code] } });
        return;
      }
      this.#set({ status: 'reconnecting' });
      this.#reopenLater();
    };
    socket.onerror = () => {}; // a close event always follows
  }

  #detach() {
    const socket = this.#socket;
    this.#socket = null;
    return socket;
  }

  #clearTimer() {
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = null;
  }

  /** Reopen after an exponential delay with jitter; the same schedule serves drops and resyncs. */
  #reopenLater() {
    if (this.#liveSince !== null && this.now() - this.#liveSince >= STABLE_MS) this.#attempt = 0;
    this.#liveSince = null;
    this.#clearTimer();
    const base = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
    this.#attempt += 1;
    this.#timer = this.setTimer(() => { this.#timer = null; this.#open(); }, Math.round(base * (0.5 + 0.5 * this.random())));
  }

  /** Throw the local copy's trust away and start over from a full snapshot. */
  #resync(reason) {
    this.#forceSnapshot = true;
    this.#rejectAll(new ClientError('disconnected', UNCERTAIN_OPERATION));
    this.#detach()?.close();
    this.#set({ status: 'reconnecting', error: { code: 'resync', message: `Resynchronising: ${reason}` } });
    this.#reopenLater();
  }

  #handle(message) {
    switch (message?.op) {
      case 'snapshot':
        this.#forceSnapshot = false;
        this.#liveSince ??= this.now();
        this.#forgetRecent();
        this.#set({ status: 'live', project: message.project, seq: message.seq, storage: message.storage ?? { writable: true, warnings: [] }, error: null, snapshots: this.state.snapshots + 1 });
        break;
      case 'ready':
        if (!this.state.project || message.seq < this.state.seq) {
          this.#resync('the service is behind this copy');
          break;
        }
        this.#liveSince ??= this.now();
        this.#set({ status: 'live', error: null, storage: message.storage ?? this.state.storage });
        break;
      case 'event':
        if (message.storage) this.#set({ storage: message.storage });
        this.#onEvent(message.event);
        break;
      case 'storage':
        this.#set({ storage: message.storage });
        break;
      case 'ack':
        if (message.storage) this.#set({ storage: message.storage });
        this.#settle(message.id, (p) => p.resolve({ seq: message.seq }));
        break;
      case 'error':
        if (message.id === undefined && message.code === 'recovery_required') {
          this.#set({ status: 'rejected', error: { code: message.code, message: message.message }, storage: { writable: false, warnings: [] } });
        }
        if (message.id === undefined && message.code === 'board_too_large') {
          this.#set({ status: 'rejected', error: { code: message.code, message: message.message || TOO_LARGE_MESSAGE } });
        }
        if (message.storage) this.#set({ storage: message.storage });
        this.#settle(message.id, (p) => p.reject(new ClientError(message.code, message.message)));
        break;
      case 'serial':
      case 'serial-data':
        this.onSerial(message);   // console output is not project state; the console view handles it
        break;
      case 'settings':
        this.onSettings(message.settings);   // app settings changed in another window
        break;
      default:
        break; // pong and anything newer than this client
    }
  }

  #onEvent(event) {
    if (!this.state.project) return;
    if (!event || !Number.isInteger(event.seq)) {
      this.#resync('malformed event');
      return;
    }
    if (event.seq <= this.state.seq) return; // already applied, for example replayed after a resume
    if (event.seq !== this.state.seq + 1) {
      this.#resync(`missed events (expected ${this.state.seq + 1}, got ${event.seq})`);
      return;
    }
    let project;
    try {
      project = applyEvent(this.state.project, event);
    } catch (error) {
      this.#resync(String(error.message || error));
      return;
    }
    const before = this.state.project;
    this.#set({ project, seq: event.seq });
    this.#recent.set(event.seq, { before, after: project });
    if (this.#recent.size > RECENT_EVENTS) this.#recent.delete(this.#recent.keys().next().value);
    for (const resolve of this.#waiting.get(event.seq) ?? []) resolve({ before, after: project });
    this.#waiting.delete(event.seq);
  }

  #settle(id, action) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.clearTimer(pending.timer);
    action(pending);
  }

  #rejectAll(error) {
    for (const id of [...this.#pending.keys()]) this.#settle(id, (p) => p.reject(error));
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.#listeners) listener(this.state);
  }
}
